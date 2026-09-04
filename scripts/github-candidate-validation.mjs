import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { RegistryValidationError } from './registry-validation.mjs';

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

async function requestJson(url, token, label) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) fail(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function downloadExact(url, expectedSize, expectedSha256, label) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) fail(`${label} download failed with HTTP ${response.status}`);
  const chunks = [];
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > expectedSize) fail(`${label} exceeded its declared size`);
    hash.update(bytes);
    chunks.push(bytes);
  }
  if (size !== expectedSize) fail(`${label} size mismatch`);
  if (hash.digest('hex') !== expectedSha256) fail(`${label} SHA-256 mismatch`);
  return Buffer.concat(chunks, size);
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

function readNimiAppArchive(bytes, label) {
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
    const mode = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0o777;
    if (method !== 0 || extraLength !== 0 || commentLength !== 0) fail(`${label} uses an unsupported ZIP entry encoding`);
    if (mode !== 0o644 && mode !== 0o755) fail(`${label} uses an unsupported ZIP entry mode`);
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

function expectedArchiveNativeTrust(target) {
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

function validateNimiAppArchive(bytes, candidate, target, sourceLicenseDigests) {
  const label = `${target.target_id} nimiapp`;
  const entries = readNimiAppArchive(bytes, label);
  for (const required of ['LICENSE', 'manifest.json', 'nimi.app.yaml', target.runtime_entry]) {
    if (!entries.has(required)) fail(`${label} is missing ${required}`);
  }
  if (entries.get(target.runtime_entry).mode !== 0o755) fail(`${label} runtime_entry is not executable`);
  const manifest = parseJsonEntry(entries, 'manifest.json', label);
  const expectedManifest = {
    format: 'nimi.app-package/v1',
    app_id: candidate.app_id,
    version: candidate.version,
    target_id: target.target_id,
    os: target.os,
    arch: target.arch,
    runtime_entry: target.runtime_entry,
    native_trust: expectedArchiveNativeTrust(target),
    execution_profile: { requested_execution_level: 'asInvoker', ui_access: false },
  };
  if (!sameValue(manifest, expectedManifest)) fail(`${label} manifest does not match the descriptor target`);

  let declaration;
  try {
    declaration = parseYaml(entries.get('nimi.app.yaml').bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} nimi.app.yaml is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!declaration || declaration.app_id !== candidate.app_id || declaration.version !== candidate.version) {
    fail(`${label} nimi.app.yaml identity does not match the candidate`);
  }
  if (!sameValue(declaration.app_access || [], candidate.app_access)) fail(`${label} App Access declaration does not match the candidate`);
  const archivedLicenseSha = createHash('sha256').update(entries.get('LICENSE').bytes).digest('hex');
  if (!sourceLicenseDigests.has(archivedLicenseSha)) fail(`${label} LICENSE does not match a reviewed source license file`);
}

async function verifyTagRules(owner, repo, tag, token) {
  const summaries = await requestJson(`https://api.github.com/repos/${owner}/${repo}/rulesets?includes_parents=true`, token, 'publisher tag rulesets');
  for (const summary of summaries) {
    if (summary.target !== 'tag' || summary.enforcement !== 'active') continue;
    const ruleset = await requestJson(`https://api.github.com/repos/${owner}/${repo}/rulesets/${summary.id}`, token, `publisher tag ruleset ${summary.id}`);
    const includes = ruleset.conditions?.ref_name?.include || [];
    const excludes = ruleset.conditions?.ref_name?.exclude || [];
    const included = includes.includes(`refs/tags/${tag}`) || includes.includes('refs/tags/v*');
    const excluded = excludes.includes(`refs/tags/${tag}`) || excludes.includes('refs/tags/v*');
    const types = new Set((ruleset.rules || []).map((rule) => rule.type));
    if (included && !excluded && types.has('update') && types.has('deletion')) {
      return `https://api.github.com/repos/${owner}/${repo}/rulesets/${summary.id}`;
    }
  }
  fail(`publisher tag ${tag} is not protected against update and deletion`);
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

function releaseAsset(release, expected, label) {
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

function validateAggregate(bytes, candidate) {
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
      runtime_entry: target.runtime_entry,
      native_trust: expectedArchiveNativeTrust(target),
      execution_profile: { requested_execution_level: 'asInvoker', ui_access: false },
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

  for (const target of candidate.targets) {
    releaseAsset(release, target, target.target_id);
    const bytes = await downloadExact(target.asset_url, target.size, target.sha256, target.target_id);
    validateNimiAppArchive(bytes, candidate, target, sourceLicenseDigests);
    const attestationRef = `https://api.github.com/repos/${owner}/${repo}/attestations/sha256:${target.sha256}`;
    if (!sameValue(target.provenance_attestation_refs, [attestationRef])) {
      fail(`${target.target_id} provenance_attestation_refs must bind the exact GitHub digest lookup`);
    }
    const attestations = await requestJson(
      attestationRef,
      token,
      `${target.target_id} provenance attestations`,
    );
    if (!Array.isArray(attestations.attestations) || attestations.attestations.length === 0) {
      fail(`${target.target_id} has no GitHub build provenance attestation`);
    }
  }

  return Object.freeze({ repository: `${owner}/${repo}`, releaseId: release.id, targets: candidate.targets.length });
}
