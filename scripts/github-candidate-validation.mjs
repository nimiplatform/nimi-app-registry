import { validatePublishedAppInfo } from './app-info-validation.mjs';
import { validateStorefrontMediaArchiveEntries } from './storefront-media-validation.mjs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, parseDocument as parseYamlDocument, isMap, isScalar } from 'yaml';
import { RegistryValidationError } from './registry-validation.mjs';
import { SYMBOLIC_LINK_MODE, validatePayloadLinks } from './payload-links.mjs';

function fail(message) {
  throw new RegistryValidationError(message);
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right);
}

function repositoryParts(repository) {
  const parsed = new URL(repository);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname !== 'github.com' || parts.length !== 2) fail(`unsupported source repository: ${repository}`);
  return { owner: parts[0], repo: parts[1] };
}

export async function requestJson(url, token, label) {
  let endpoint;
  try { endpoint = new URL(url); }
  catch { fail(`${label} must use a supported GitHub API URL`); }
  if (endpoint.origin !== 'https://api.github.com' || endpoint.username || endpoint.password || endpoint.hash
    || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/|$)/u.test(endpoint.pathname)) {
    fail(`${label} must use a supported GitHub API URL`);
  }
  if (!token) {
    let output;
    try {
      // gh owns its existing login. Never extract a credential to call fetch.
      output = childProcess.execFileSync('gh', [
        'api', '--hostname', 'github.com', '--method', 'GET',
        '--header', 'Accept: application/vnd.github+json',
        '--header', 'X-GitHub-Api-Version: 2022-11-28',
        `${endpoint.pathname}${endpoint.search}`,
      ], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
      });
    } catch (error) {
      if (error.code === 'ENOENT') fail(`${label} requires the GitHub CLI (gh) when no explicit token is supplied`);
      // Child output may contain response bodies or credential diagnostics.
      // Report only a bounded HTTP status/exit code, never the raw output.
      const httpStatus = /\(HTTP ([1-5][0-9]{2})\)/u.exec(error.stderr?.toString() || '')?.[1];
      const detail = httpStatus ? `HTTP ${httpStatus}` : Number.isInteger(error.status) ? `exit ${error.status}` : 'process error';
      fail(`${label} failed via gh api (${detail}); check gh auth status --hostname github.com and repository access`);
    }
    try { return JSON.parse(output); }
    catch { fail(`${label} returned invalid JSON from gh api`); }
  }
  const response = await fetch(url, {
    method: 'GET', redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) fail(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

const DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
class TransientDownloadError extends Error {}

async function readDownloadBytes(response, expectedSize, label) {
  if (!response.body) fail(`${label} download has no body`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > expectedSize) fail(`${label} exceeded its declared size`);
    chunks.push(bytes);
  }
  if (size !== expectedSize) fail(`${label} size mismatch`);
  return Buffer.concat(chunks, size);
}

function verifyDownloadDigest(bytes, expectedSha256, label) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024 * 1024) {
    hash.update(bytes.subarray(offset, offset + 64 * 1024 * 1024));
  }
  if (hash.digest('hex') !== expectedSha256) fail(`${label} SHA-256 mismatch`);
  return bytes;
}

async function retryDownload(operation, signal, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (signal.aborted || !(error instanceof TransientDownloadError || error instanceof TypeError
        || ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
      if (attempt === 2) fail(`${label} transfer interrupted after 3 attempts`);
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function fetchDownload(url, headers, signal, label) {
  const response = await fetch(url, {
    redirect: 'follow', headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
  });
  if ([408, 500, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    throw new TransientDownloadError(`${label} transient HTTP ${response.status}`);
  }
  return response;
}

export async function downloadExact(url, expectedSize, expectedSha256, label) {
  const controller = new AbortController();
  const { signal } = controller;
  try {
    if (expectedSize <= DOWNLOAD_RANGE_BYTES) {
      const bytes = await retryDownload(async () => {
        const response = await fetchDownload(url, undefined, signal, label);
        if (!response.ok) { await response.body?.cancel(); fail(`${label} download failed with HTTP ${response.status}`); }
        return readDownloadBytes(response, expectedSize, label);
      }, signal, label);
      return verifyDownloadDigest(bytes, expectedSha256, label);
    }

    const range = async (start, end) => retryDownload(async () => {
      const response = await fetchDownload(url, {
        Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity',
      }, signal, label);
      // Servers may ignore Range. Consume that first complete response using
      // the same full size/digest checks instead of requesting it again.
      if (start === 0 && response.status === 200) {
        return { complete: true, bytes: await readDownloadBytes(response, expectedSize, label) };
      }
      if (response.status !== 206) {
        await response.body?.cancel();
        fail(`${label} range download failed with HTTP ${response.status}`);
      }
      if (response.headers.get('content-range') !== `bytes ${start}-${end}/${expectedSize}`) {
        await response.body?.cancel();
        fail(`${label} range identity mismatch`);
      }
      return { complete: false, bytes: await readDownloadBytes(response, end - start + 1, label) };
    }, signal, label);

    const first = await range(0, DOWNLOAD_RANGE_BYTES - 1);
    if (first.complete) return verifyDownloadDigest(first.bytes, expectedSha256, label);
    const bytes = Buffer.allocUnsafe(expectedSize);
    first.bytes.copy(bytes);
    let next = DOWNLOAD_RANGE_BYTES;
    const worker = async () => {
      while (next < expectedSize) {
        const start = next;
        next += DOWNLOAD_RANGE_BYTES;
        const part = await range(start, Math.min(next, expectedSize) - 1);
        part.bytes.copy(bytes, start);
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    return verifyDownloadDigest(bytes, expectedSha256, label);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function canonicalEntryName(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\\') || value.startsWith('/')) {
    fail(`archive entry is not a canonical relative path: ${String(value)}`);
  }
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) fail(`archive entry is not canonical: ${value}`);
  return value;
}

export function readNimiAppArchive(bytes, label) {
  if (bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) fail(`${label} has no canonical ZIP end record`);
  const endOffset = bytes.length - 22;
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset || count !== bytes.readUInt16LE(endOffset + 8)) fail(`${label} ZIP directory is invalid`);
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) fail(`${label} ZIP central entry is invalid`);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const unixMode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const fileType = unixMode & 0o170000;
    const specialBits = unixMode & 0o7000;
    let mode;
    if (unixMode === SYMBOLIC_LINK_MODE) {
      mode = SYMBOLIC_LINK_MODE;
    } else if ((fileType === 0o100000 || fileType === 0) && specialBits === 0) {
      mode = unixMode & 0o777;
    } else {
      fail(`${label} uses an unsupported ZIP entry mode`);
    }
    if (method !== 0 || extraLength !== 0 || commentLength !== 0) fail(`${label} uses an unsupported ZIP entry encoding`);
    if (mode !== 0o644 && mode !== 0o755 && mode !== SYMBOLIC_LINK_MODE) fail(`${label} uses an unsupported ZIP entry mode`);
    const name = canonicalEntryName(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    if (entries.has(name) || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail(`${label} has an invalid or duplicate ZIP entry`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name || localExtraLength !== 0 || bytes.readUInt16LE(localOffset + 8) !== 0) fail(`${label} ZIP local entry is invalid`);
    const dataOffset = localOffset + 30 + localNameLength;
    const payload = bytes.subarray(dataOffset, dataOffset + size);
    if (payload.length !== size || crc32(payload) !== expectedCrc) fail(`${label} ZIP entry digest mismatch: ${name}`);
    entries.set(name, Object.freeze({ bytes: Buffer.from(payload), mode }));
    cursor += 46 + nameLength;
  }
  if (cursor !== centralOffset + centralSize) fail(`${label} ZIP directory size is invalid`);
  const names = [...entries.keys()];
  if (names.some((name, index) => index > 0 && names[index - 1] >= name)) fail(`${label} ZIP entries are not canonical`);
  return entries;
}

function parseJsonEntry(entries, name, label) {
  const entry = entries.get(name);
  if (!entry) fail(`${label} is missing ${name}`);
  try {
    return JSON.parse(entry.bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} ${name} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const MANAGED_WEB_EXECUTION_PROFILE_REF = 'nimi-managed-web-v1';
const MANAGED_WEB_RUNTIME_ENTRY = 'payload/index.html';
const MANAGED_WEB_MAX_RELEASE_BYTES = 64 * 1024 * 1024;
const MANAGED_WEB_MAX_RELEASE_ENTRIES = 10_000;
const WINDOWS_RESERVED_BASES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$']);
const DESKTOP_WINDOW_BOUNDS = Object.freeze({
  width: [400, 2560],
  height: [360, 1600],
  min_width: [320, 1280],
  min_height: [320, 960],
});
const DESKTOP_WINDOW_DEFAULTS = Object.freeze({
  width: 1280,
  height: 840,
  min_width: 480,
  min_height: 420,
});

function validWindowsSegment(segment) {
  if (/[<>:"|?*]/u.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) return false;
  const base = segment.split('.', 1)[0].replace(/ +$/u, '').toUpperCase();
  if (WINDOWS_RESERVED_BASES.has(base)) return false;
  if (/^(?:COM|LPT)(?:[1-9]|¹|²|³)$/u.test(base)) return false;
  return true;
}

function unicodeCaseFold(input) {
  let out = '';
  for (const ch of input.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0131) out += '\u0131';
    else if (cp === 0x1e9e) out += 'ss';
    else if (cp >= 0x13f8 && cp <= 0x13fd) out += String.fromCodePoint(cp - 8);
    else if (cp >= 0xab70 && cp <= 0xabbf) out += String.fromCodePoint(cp - 0x97d0);
    else out += ch.toUpperCase().toLowerCase();
  }
  return out;
}

function targetPathCollisionKey(name, targetOS) {
  const normalized = name.normalize('NFC');
  if (targetOS === 'windows' || targetOS === 'any') {
    return unicodeCaseFold(normalized);
  }
  return normalized;
}

function validateCrossPlatformArchiveEntries(entries, targetOS, label) {
  const roles = new Map();
  for (const name of entries.keys()) {
    const segments = name.split('/');
    for (const segment of segments) {
      for (const ch of segment) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) fail(`${label} archive path contains control character: ${name}`);
      }
      if ((targetOS === 'windows' || targetOS === 'any') && !validWindowsSegment(segment)) {
        fail(`${label} archive path uses invalid Windows segment: ${name}`);
      }
    }
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join('/');
      const key = targetPathCollisionKey(prefix, targetOS);
      const isFile = index === segments.length - 1;
      const previous = roles.get(key);
      if (previous) {
        if (previous.spelling !== prefix || previous.file || isFile) {
          fail(`${label} archive path collision on ${targetOS}: ${previous.spelling} and ${prefix}`);
        }
      } else {
        roles.set(key, { spelling: prefix, file: isFile });
      }
    }
  }
}

function assertDesktopWindowYamlIntegerNodes(yamlText, label) {
  const doc = parseYamlDocument(yamlText, { keepSourceTokens: true });
  if (!isMap(doc.contents)) return;
  const desktopNode = doc.contents.get('desktop', true);
  if (!isMap(desktopNode)) return;
  const windowNode = desktopNode.get('window', true);
  if (!isMap(windowNode)) return;
  for (const pair of windowNode.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : '';
    if (!['width', 'height', 'min_width', 'min_height'].includes(key)) continue;
    if (!isScalar(pair.value) || typeof pair.value.value !== 'number') {
      fail(`${label} desktop.window.${key} must be an integer`);
    }
    const rawSource = typeof pair.value.srcToken?.source === 'string' ? pair.value.srcToken.source.trim() : String(pair.value.value);
    if (!/^[0-9]+$/u.test(rawSource)) {
      fail(`${label} desktop.window.${key} must be a base-10 YAML integer`);
    }
  }
}

function validateDeclarationDesktop(desktop, label, yamlText = null) {
  if (desktop === undefined) return;
  if (yamlText !== null) assertDesktopWindowYamlIntegerNodes(yamlText, label);
  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) {
    fail(`${label} desktop declaration must be a mapping`);
  }
  for (const key of Object.keys(desktop)) {
    if (key !== 'window') fail(`${label} desktop declaration contains unsupported field: ${key}`);
  }
  if (desktop.window === undefined) return;
  const win = desktop.window;
  if (!win || typeof win !== 'object' || Array.isArray(win)) {
    fail(`${label} desktop.window must be a mapping`);
  }
  const allowed = new Set(['width', 'height', 'min_width', 'min_height', 'title_bar_style']);
  for (const key of Object.keys(win)) {
    if (!allowed.has(key)) fail(`${label} desktop.window contains unsupported field: ${key}`);
    const value = win[key];
    if (key === 'title_bar_style') {
      if (value !== 'native' && value !== 'hidden') fail(`${label} desktop.window.title_bar_style must be native or hidden`);
      continue;
    }
    const [min, max] = DESKTOP_WINDOW_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      fail(`${label} desktop.window.${key} is outside ${min}..${max}`);
    }
  }
  const width = win.width ?? DESKTOP_WINDOW_DEFAULTS.width;
  const height = win.height ?? DESKTOP_WINDOW_DEFAULTS.height;
  const minWidth = win.min_width ?? DESKTOP_WINDOW_DEFAULTS.min_width;
  const minHeight = win.min_height ?? DESKTOP_WINDOW_DEFAULTS.min_height;
  if (minWidth > width || minHeight > height) {
    fail(`${label} desktop.window min dimensions exceed window dimensions`);
  }
}

function expectedArchiveExecutionProfile(target) {
  if (target.os === 'any') return { launch_mode: MANAGED_WEB_EXECUTION_PROFILE_REF };
  if (target.os === 'macos') return { launch_mode: 'current-user' };
  return { requested_execution_level: 'asInvoker', ui_access: false };
}

function expectedArchiveNativeTrust(target) {
  if (target.os === 'any') {
    if (
      target.target_id !== 'desktop-universal'
      || target.arch !== 'any'
      || target.execution_profile_ref !== MANAGED_WEB_EXECUTION_PROFILE_REF
      || target.native_trust?.signing_subject !== null
      || target.native_trust?.observed_subject !== null
      || target.native_trust?.entitlements_ref !== null
      || target.native_trust?.windows_code_signing !== 'not-applicable'
      || target.native_trust?.macos_notarization !== 'not-applicable'
      || target.native_trust?.macos_developer_id_subject !== null
    ) {
      fail('managed-web target trust or execution profile is inconsistent');
    }
    return {
      posture: 'nimi-managed-carrier',
      certificate_subject: null,
    };
  }
  if (target.os === 'macos') {
    if (target.execution_profile_ref !== 'macos-user-mode-same-session-v1') fail('macOS target has an unsupported execution profile');
    const signed = target.native_trust.signing_subject === 'publisher';
    if (signed && target.native_trust.observed_subject !== target.native_trust.macos_developer_id_subject) fail('macOS publisher identity is contradictory');
    return {
      posture: signed ? 'observed-valid-native-signature' : 'production-unsigned',
      macos_developer_id: signed ? 'valid' : 'absent',
      macos_notarization: target.native_trust.macos_notarization,
      certificate_subject: target.native_trust.macos_developer_id_subject,
    };
  }
  if (target.os !== 'windows') fail(`Registry native archive verification is not yet implemented for ${target.os}`);
  if (target.native_trust.windows_code_signing === 'unsigned') {
    return {
      posture: 'production-unsigned',
      windows_authenticode: 'unsigned',
      certificate_subject: null,
    };
  }
  return {
    posture: 'observed-valid-native-signature',
    windows_authenticode: 'valid',
    certificate_subject: target.native_trust.observed_subject,
  };
}

export function validateNimiAppArchive(bytes, candidate, target, sourceLicenseDigests, infoBytes) {
  const label = `${target.target_id} nimiapp`;
  const entries = readNimiAppArchive(bytes, label);
  validatePayloadLinks(entries, target.os);
  validateCrossPlatformArchiveEntries(entries, target.os, label);
  for (const required of ['LICENSE', 'manifest.json', 'nimi.app.yaml', 'app-info.json']) {
    if (!entries.has(required)) fail(`${label} is missing ${required}`);
    if (entries.get(required).mode !== 0o644) fail(`${label} control file ${required} must have mode 0644`);
  }
  if (!entries.has(target.runtime_entry)) fail(`${label} is missing ${target.runtime_entry}`);
  const isManagedWeb = target.os === 'any';
  if (isManagedWeb) {
    if (candidate.package?.runtime_kind !== 'managed-web') fail(`${label} managed-web archive requires package.runtime_kind=managed-web`);
    if (candidate.storage_policy?.kind !== 'nimi-mediated-default') fail(`${label} managed-web archive requires nimi-mediated-default storage`);
    if (target.runtime_entry !== MANAGED_WEB_RUNTIME_ENTRY) fail(`${label} managed-web runtime_entry must be ${MANAGED_WEB_RUNTIME_ENTRY}`);
    if (entries.get(target.runtime_entry).mode !== 0o644) fail(`${label} managed-web runtime_entry must have mode 0644`);
    if (entries.size > MANAGED_WEB_MAX_RELEASE_ENTRIES) fail(`${label} exceeds ${MANAGED_WEB_MAX_RELEASE_ENTRIES} entries`);
    let totalUncompressed = 0;
    for (const entry of entries.values()) totalUncompressed += entry.bytes.length;
    if (totalUncompressed > MANAGED_WEB_MAX_RELEASE_BYTES) fail(`${label} exceeds ${MANAGED_WEB_MAX_RELEASE_BYTES} bytes uncompressed`);
  } else {
    if (candidate.package?.runtime_kind !== 'native') fail(`${label} native archive requires package.runtime_kind=native`);
    if (entries.get(target.runtime_entry).mode !== 0o755) fail(`${label} runtime_entry is not executable`);
  }
  const manifest = parseJsonEntry(entries, 'manifest.json', label);
  const expectedManifest = {
    format: 'nimi.app-package/v2',
    app_id: candidate.app_id,
    version: candidate.version,
    target_id: target.target_id,
    os: target.os,
    arch: target.arch,
    runtime_entry: target.runtime_entry,
    native_trust: expectedArchiveNativeTrust(target),
    execution_profile: expectedArchiveExecutionProfile(target),
  };
  if (!sameValue(manifest, expectedManifest)) fail(`${label} manifest does not match the descriptor target`);

  const declarationYamlText = entries.get('nimi.app.yaml').bytes.toString('utf8');
  let declaration;
  try {
    declaration = parseYaml(declarationYamlText);
  } catch (error) {
    fail(`${label} nimi.app.yaml is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!declaration || declaration.app_id !== candidate.app_id || declaration.version !== candidate.version) {
    fail(`${label} nimi.app.yaml identity does not match the candidate`);
  }
  validateDeclarationDesktop(declaration.desktop, `${label} nimi.app.yaml`, declarationYamlText);
  if (!sameValue(declaration.app_access || [], candidate.app_access)) fail(`${label} App Access declaration does not match the candidate`);
  if (!Buffer.isBuffer(infoBytes) || !entries.get('app-info.json').bytes.equals(infoBytes)) fail(`${label} App info sidecar differs from archive`);
  const info = validatePublishedAppInfo(infoBytes, candidate, target);
  if (entries.get('LICENSE').bytes.toString('utf8') !== info.license.text) fail(`${label} App info license differs from LICENSE`);
  for (const field of ['display_name', 'capability_contract_refs', 'required_standardized_feature_refs', 'storage_policy', 'safety_profile']) {
    if (!sameValue(declaration[field], info[field])) fail(`${label} App info differs from declaration ${field}`);
  }
  const archivedLicenseSha = createHash('sha256').update(entries.get('LICENSE').bytes).digest('hex');
  if (!sourceLicenseDigests.has(archivedLicenseSha)) fail(`${label} LICENSE does not match a reviewed source license file`);
  return info;
}

// @nimi-authority: rule.nimi.platform.app-ecosystem.p-dev-004
function tagPatternMatches(pattern, tag) {
  if (pattern === '~ALL') return true;
  if (typeof pattern !== 'string' || !pattern.startsWith('refs/tags/') || /[{}()]|\[\[:/u.test(pattern)) {
    fail(`unsupported GitHub tag ruleset pattern: ${String(pattern)}`);
  }
  // GitHub uses Ruby fnmatch with FNM_PATHNAME. These version tags contain no
  // slashes or leading dots, so match only the final tag component; a leading
  // **/ can consume zero directories. Preserve fnmatch backslash escapes.
  let suffix = pattern.slice('refs/tags/'.length);
  while (suffix.startsWith('**/')) suffix = suffix.slice(3);
  const literal = (value) => value.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  let expression = '^';
  for (let index = 0; index < suffix.length; index += 1) {
    const char = suffix[index];
    if (char === '\\') {
      if (++index === suffix.length) fail(`unsupported GitHub tag ruleset pattern: ${pattern}`);
      expression += literal(suffix[index]);
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else if (char === '[') {
      let cursor = index + 1;
      const negated = suffix[cursor] === '!' || suffix[cursor] === '^';
      if (negated) cursor += 1;
      let members = '';
      if (suffix[cursor] === ']') { members += '\\]'; cursor += 1; }
      for (; cursor < suffix.length && suffix[cursor] !== ']'; cursor += 1) {
        const member = suffix[cursor];
        if (member === '\\') {
          if (++cursor === suffix.length) fail(`unsupported GitHub tag ruleset pattern: ${pattern}`);
          const escaped = suffix[cursor];
          members += ['\\', ']', '[', '^', '-'].includes(escaped) ? `\\${escaped}` : escaped;
        } else members += member === '^' || member === '[' ? `\\${member}` : member;
      }
      if (!members || suffix[cursor] !== ']') fail(`unsupported GitHub tag ruleset pattern: ${pattern}`);
      expression += `[${negated ? '^' : ''}${members}]`;
      index = cursor;
    } else expression += literal(char);
  }
  try { return new RegExp(`${expression}$`, 'u').test(tag); }
  catch { fail(`unsupported GitHub tag ruleset pattern: ${pattern}`); }
}

export async function verifyTagRules(owner, repo, tag, token) {
  const summaries = await requestJson(`https://api.github.com/repos/${owner}/${repo}/rulesets?includes_parents=true`, token, 'publisher tag rulesets');
  for (const summary of summaries) {
    if (summary.target !== 'tag' || summary.enforcement !== 'active') continue;
    const ruleset = await requestJson(`https://api.github.com/repos/${owner}/${repo}/rulesets/${summary.id}`, token, `publisher tag ruleset ${summary.id}`);
    const includes = ruleset.conditions?.ref_name?.include || [];
    const excludes = ruleset.conditions?.ref_name?.exclude || [];
    const included = includes.map((pattern) => tagPatternMatches(pattern, tag)).some(Boolean);
    const excluded = excludes.map((pattern) => tagPatternMatches(pattern, tag)).some(Boolean);
    const types = new Set((ruleset.rules || []).map((rule) => rule.type));
    if (included && !excluded && types.has('update') && types.has('deletion')) {
      return `https://api.github.com/repos/${owner}/${repo}/rulesets/${summary.id}`;
    }
  }
  fail(`publisher tag ${tag} is not protected against update and deletion`);
}

export async function verifyBuildProvenance(bytes, candidate, target, attestations, token, workflowName = 'nimi-app-release.yml') {
  if (!Array.isArray(attestations.attestations) || attestations.attestations.length === 0) {
    fail(`${target.target_id} has no GitHub build provenance attestation`);
  }
  const bundles = attestations.attestations.map((attestation) => {
    if (!attestation.bundle || typeof attestation.bundle !== 'object') fail(`${target.target_id} has an invalid attestation bundle`);
    return JSON.stringify(attestation.bundle);
  });
  const { owner, repo } = repositoryParts(candidate.source.repository);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'nimi-registry-provenance-'));
  try {
    const artifactPath = path.join(temporaryRoot, 'artifact.nimiapp');
    const bundlePath = path.join(temporaryRoot, 'attestations.jsonl');
    await writeFile(artifactPath, bytes);
    await writeFile(bundlePath, `${bundles.join('\n')}\n`);
    let result;
    try {
      result = JSON.parse(childProcess.execFileSync('gh', [
        'attestation', 'verify', artifactPath,
        '--bundle', bundlePath,
        '--hostname', 'github.com',
        '--repo', `${owner}/${repo}`,
        '--predicate-type', 'https://slsa.dev/provenance/v1',
        '--source-ref', `refs/tags/${candidate.release.tag}`,
        '--source-digest', candidate.release.commit_sha,
        '--signer-digest', candidate.release.commit_sha,
        '--cert-identity', `${candidate.source.repository}/.github/workflows/${workflowName}@refs/tags/${candidate.release.tag}`,
        '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
        '--format', 'json',
      ], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', ...(token ? { GH_TOKEN: token } : {}) },
      }));
    } catch (error) {
      fail(`${target.target_id} build provenance verification failed: ${error.stderr?.toString().trim() || error.message}`);
    }
    // Predicate fields are publisher-controlled. The verified certificate's
    // trigger comes from GitHub OIDC and distinguishes tag pushes from dispatch.
    if (!Array.isArray(result) || !result.some((entry) => entry.verificationResult?.signature?.certificate?.buildTrigger === 'push')) {
      fail(`${target.target_id} build provenance is not from a tag-triggered GitHub Actions run`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyLicenseFiles(owner, repo, candidate, token) {
  const digests = new Set();
  for (const licenseFile of candidate.source.license.files) {
    const encodedPath = licenseFile.path.split('/').map(encodeURIComponent).join('/');
    const content = await requestJson(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${candidate.release.commit_sha}`,
      token,
      `source license ${licenseFile.path}`,
    );
    if (content.type !== 'file' || content.encoding !== 'base64' || typeof content.content !== 'string') {
      fail(`source license ${licenseFile.path} is not an inline regular GitHub file`);
    }
    const bytes = Buffer.from(content.content.replaceAll('\n', ''), 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== licenseFile.sha256) fail(`source license ${licenseFile.path} SHA-256 mismatch`);
    digests.add(digest);
  }
  return digests;
}

export function releaseAsset(release, expected, label) {
  const asset = (release.assets || []).find((candidate) => candidate.id === expected.asset_id);
  if (!asset) fail(`${label} asset_id is absent from the immutable Release`);
  if (
    asset.name !== expected.asset_name
    || asset.browser_download_url !== expected.asset_url
    || asset.size !== expected.size
    || asset.digest !== `sha256:${expected.sha256}`
  ) {
    fail(`${label} Release asset facts do not match the candidate`);
  }
  return asset;
}

export function validateAggregate(bytes, candidate) {
  let aggregate;
  try {
    aggregate = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`aggregate asset is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !aggregate
    || aggregate.format !== 'nimi.app-release-candidate/v1'
    || aggregate.app_id !== candidate.app_id
    || aggregate.version !== candidate.version
    || !Array.isArray(aggregate.targets)
    || aggregate.targets.length !== candidate.targets.length
  ) {
    fail('aggregate asset identity does not match the candidate');
  }
  const expectedStorefrontMedia = candidate.storefront_media === undefined
    ? undefined
    : {
      asset_name: candidate.storefront_media.asset_name,
      size: candidate.storefront_media.size,
      sha256: candidate.storefront_media.sha256,
    };
  if (!sameValue(aggregate.storefront_media, expectedStorefrontMedia)) {
    fail('aggregate storefront_media does not match the candidate');
  }
  for (const target of candidate.targets) {
    const aggregateTarget = aggregate.targets.find((item) => item.target_id === target.target_id);
    const expected = {
      format: 'nimi.app-target-candidate/v1',
      app_id: candidate.app_id,
      version: candidate.version,
      target_id: target.target_id,
      os: target.os,
      arch: target.arch,
      asset_name: target.asset_name,
      size: target.size,
      sha256: target.sha256,
      app_info: { asset_name: target.app_info.asset_name, size: target.app_info.size, sha256: target.app_info.sha256 },
      runtime_entry: target.runtime_entry,
      native_trust: expectedArchiveNativeTrust(target),
      execution_profile: expectedArchiveExecutionProfile(target),
    };
    if (!sameValue(aggregateTarget, expected)) fail(`aggregate target ${target.target_id} does not match the candidate`);
  }
}

export async function validatePublishedGitHubCandidate(candidate, options = {}) {
  const token = options.token || '';
  const { owner, repo } = repositoryParts(candidate.source.repository);
  const repository = await requestJson(`https://api.github.com/repos/${owner}/${repo}`, token, 'publisher repository');
  if (repository.visibility !== 'public' || repository.private !== false) fail('publisher source repository is not public');

  const tagRef = await requestJson(`https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(candidate.release.tag)}`, token, 'publisher tag ref');
  if (tagRef.object?.type !== 'tag') fail('publisher version tag is not annotated');
  const tagObject = await requestJson(`https://api.github.com/repos/${owner}/${repo}/git/tags/${tagRef.object.sha}`, token, 'publisher annotated tag');
  if (tagObject.tag !== candidate.release.tag || tagObject.object?.type !== 'commit' || tagObject.object.sha !== candidate.release.commit_sha) {
    fail('publisher annotated tag does not resolve to release.commit_sha');
  }
  const tagProtectionRef = await verifyTagRules(owner, repo, candidate.release.tag, token);
  if (candidate.release.tag_protection_ref !== tagProtectionRef) fail('tag_protection_ref does not identify the active protecting ruleset');

  const release = await requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(candidate.release.tag)}`, token, 'publisher immutable Release');
  if (
    release.id !== candidate.release.release_id
    || release.html_url !== candidate.release.release_url
    || release.draft !== false
    || release.immutable !== true
    || release.prerelease !== false
  ) {
    fail('publisher GitHub Release identity or immutability does not match the candidate');
  }

  const sourceLicenseDigests = await verifyLicenseFiles(owner, repo, candidate, token);
  releaseAsset(release, candidate.aggregate, 'aggregate');
  const aggregateBytes = await downloadExact(candidate.aggregate.asset_url, candidate.aggregate.size, candidate.aggregate.sha256, 'aggregate');
  validateAggregate(aggregateBytes, candidate);

  const parsedInfos = [];
  for (const target of candidate.targets) {
    releaseAsset(release, target, target.target_id);
    const bytes = await downloadExact(target.asset_url, target.size, target.sha256, target.target_id);
    releaseAsset(release, target.app_info, `${target.target_id} App info`);
    const infoBytes = await downloadExact(target.app_info.asset_url, target.app_info.size, target.app_info.sha256, `${target.target_id} App info`);
    const info = validateNimiAppArchive(bytes, candidate, target, sourceLicenseDigests, infoBytes);
    parsedInfos.push({ targetId: target.target_id, info });
    const attestationRef = `https://api.github.com/repos/${owner}/${repo}/attestations/sha256:${target.sha256}`;
    if (!sameValue(target.provenance_attestation_refs, [attestationRef])) {
      fail(`${target.target_id} provenance_attestation_refs must bind the exact GitHub digest lookup`);
    }
    const attestations = await requestJson(
      attestationRef,
      token,
      `${target.target_id} provenance attestations`,
    );
    await verifyBuildProvenance(bytes, candidate, target, attestations, token);
  }

  const firstInfo = parsedInfos[0].info;
  for (const entry of parsedInfos.slice(1)) {
    for (const sharedField of ['display_name', 'summary', 'icon', 'readme_markdown', 'release_notes_markdown', 'safety_profile', 'storefront']) {
      if (!sameValue(entry.info[sharedField], firstInfo[sharedField])) {
        fail(`App info ${sharedField} for ${entry.targetId} differs from ${parsedInfos[0].targetId}; one release shares one presentation`);
      }
    }
  }
  const hasDeclaredMedia = Boolean(firstInfo.storefront?.media);
  const hasMediaArchive = candidate.storefront_media !== undefined;
  if (hasDeclaredMedia !== hasMediaArchive) {
    fail('storefront.media manifest in app-info.json and candidate.storefront_media archive must both be present or both be absent');
  }
  let storefrontImageCount = 0;
  if (hasMediaArchive) {
    releaseAsset(release, candidate.storefront_media, 'storefront_media');
    const mediaZipBytes = await downloadExact(
      candidate.storefront_media.asset_url,
      candidate.storefront_media.size,
      candidate.storefront_media.sha256,
      'storefront_media',
    );
    const mediaEntries = readNimiAppArchive(mediaZipBytes, 'storefront_media');
    storefrontImageCount = validateStorefrontMediaArchiveEntries(mediaEntries, firstInfo.storefront.media);
  }

  const storefrontReview = firstInfo.storefront
    ? Object.freeze({
      category: firstInfo.storefront.category,
      defaultLocale: firstInfo.storefront.default_locale,
      locales: Object.fromEntries(
        Object.entries(firstInfo.storefront.locales || {}).map(([locale, entry]) => [
          locale,
          Object.freeze({
            displayName: entry.display_name ?? null,
            summary: entry.summary ?? null,
            tags: entry.tags || [],
            highlights: (entry.highlights || []).map((h) => h.title),
            hasLocalizedIntroduction: Boolean(entry.introduction_markdown),
          }),
        ]),
      ),
      mediaImageCount: storefrontImageCount,
    })
    : null;

  return Object.freeze({
    repository: `${owner}/${repo}`,
    releaseId: release.id,
    releaseUrl: release.html_url,
    displayName: firstInfo.display_name,
    summary: firstInfo.summary,
    targets: candidate.targets.length,
    storefrontReview,
  });
}
