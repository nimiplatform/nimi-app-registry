import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistryValidationError, validatePublisherSubmission, validateTaggedReleaseAsset } from './registry-validation.mjs';
import { downloadExact, requestJson, validateAggregate, validatePublishedGitHubCandidate, verifyTagRules } from './github-candidate-validation.mjs';
import { validatePublishedAppInfo } from './app-info-validation.mjs';

const fail = (message) => { throw new RegistryValidationError(message); };

function releaseAsset(release, name, repository, tag) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) fail(`Release must contain exactly one asset named ${name}`);
  const asset = matches[0];
  const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(asset.digest)?.[1];
  if (!sha256 || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    fail(`Release asset facts are incomplete or inconsistent: ${name}`);
  }
  const selected = { asset_id: asset.id, asset_name: name, asset_url: asset.browser_download_url, size: asset.size, sha256 };
  validateTaggedReleaseAsset({ source: { repository }, release: { tag } }, selected, name);
  return selected;
}

function nativeTarget(source, asset, appInfo, apiRoot) {
  const facts = source.native_trust;
  if (!facts || !['production-unsigned', 'observed-valid-native-signature'].includes(facts.posture)) fail(`${source.target_id} native trust is not a production observation`);
  const signed = facts.posture === 'observed-valid-native-signature';
  const common = { signing_subject: signed ? 'publisher' : null, observed_subject: facts.certificate_subject, entitlements_ref: null };
  let nativeTrust;
  if (source.os === 'windows') {
    if (facts.windows_authenticode !== (signed ? 'valid' : 'unsigned')) fail(`${source.target_id} native trust is contradictory`);
    nativeTrust = { ...common, windows_code_signing: signed ? 'signed' : 'unsigned', macos_notarization: 'not-applicable', macos_developer_id_subject: null };
  } else if (source.os === 'macos') {
    if (facts.macos_developer_id !== (signed ? 'valid' : 'absent')) fail(`${source.target_id} native trust is contradictory`);
    nativeTrust = { ...common, windows_code_signing: 'not-applicable', macos_notarization: facts.macos_notarization, macos_developer_id_subject: facts.certificate_subject };
  } else fail(`Unsupported target OS: ${source.os}`);
  return {
    target_id: source.target_id, os: source.os, arch: source.arch, ...asset,
    app_info: appInfo, runtime_entry: source.runtime_entry,
    provenance_attestation_refs: [`${apiRoot}/attestations/sha256:${asset.sha256}`],
    execution_profile_ref: source.os === 'windows' ? 'windows-user-mode-as-invoker-v1' : 'macos-user-mode-same-session-v1',
    native_trust: nativeTrust,
  };
}

// Publisher input only. Registry maintainers still own the human admission step.
// @nimi-authority: rule.nimi.platform.app-ecosystem.p-dev-004
export async function prepareSubmission({ repository, tag, input, token = '' }) {
  const repoMatch = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/u.exec(repository || '');
  if (!repoMatch || !/^v[0-9][0-9A-Za-z.+-]*$/u.test(tag || '')) fail('Use an exact GitHub repository URL and version tag');
  const keys = ['publisher', 'license_files', 'package', 'support', 'update_channel', 'rollback_marker'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) {
    fail(`Input must contain only ${keys.join(', ')}; release, target and approval facts cannot be supplied`);
  }
  if (!Array.isArray(input.license_files) || !input.license_files.length || input.license_files.length > 20 || new Set(input.license_files).size !== input.license_files.length) fail('license_files must list the exact source license paths');
  const [, owner, repo] = repoMatch;
  const apiRoot = `https://api.github.com/repos/${owner}/${repo}`;
  const metadata = await requestJson(apiRoot, token, 'publisher repository');
  if (metadata.visibility !== 'public' || metadata.private !== false) fail('Publisher repository must be public');
  const ref = await requestJson(`${apiRoot}/git/ref/tags/${encodeURIComponent(tag)}`, token, 'publisher tag');
  if (ref.object?.type !== 'tag') fail('Publisher version tag must be annotated');
  const annotated = await requestJson(`${apiRoot}/git/tags/${ref.object.sha}`, token, 'annotated tag');
  if (annotated.tag !== tag || annotated.object?.type !== 'commit' || !/^[a-f0-9]{40}$/u.test(annotated.object.sha)) fail('Annotated tag must resolve to one commit');
  const commit = annotated.object.sha;
  const tagProtection = await verifyTagRules(owner, repo, tag, token);
  const release = await requestJson(`${apiRoot}/releases/tags/${encodeURIComponent(tag)}`, token, 'publisher Release');
  if (release.draft !== false || release.immutable !== true || release.prerelease !== false || release.tag_name !== tag || decodeURIComponent(release.html_url) !== `${repository}/releases/tag/${tag}` || !Array.isArray(release.assets)) {
    fail('Publisher Release must be final, immutable and bound to the exact version tag');
  }
  const candidates = release.assets.filter((asset) => asset.name.endsWith('.candidate.json'));
  if (candidates.length !== 1) fail('Release must contain exactly one aggregate candidate asset');
  const aggregateAsset = releaseAsset(release, candidates[0].name, repository, tag);
  const aggregateBytes = await downloadExact(aggregateAsset.asset_url, aggregateAsset.size, aggregateAsset.sha256, 'aggregate');
  const aggregate = JSON.parse(aggregateBytes.toString('utf8'));
  if (aggregate.format !== 'nimi.app-release-candidate/v1' || tag !== `v${aggregate.version}` || !Array.isArray(aggregate.targets) || !aggregate.targets.length || aggregate.targets.length > 20) fail('Aggregate identity or target set is invalid');
  const information = [];
  const targets = [];
  for (const source of aggregate.targets) {
    const asset = releaseAsset(release, source.asset_name, repository, tag);
    const appInfo = releaseAsset(release, source.app_info?.asset_name, repository, tag);
    if (appInfo.size > 1048576) fail('App information exceeds its schema size limit');
    const bytes = await downloadExact(appInfo.asset_url, appInfo.size, appInfo.sha256, 'App information');
    information.push({ bytes, info: JSON.parse(bytes.toString('utf8')) });
    targets.push(nativeTarget(source, asset, appInfo, apiRoot));
  }
  const firstInfo = information[0].info;
  const licenses = [];
  for (const file of input.license_files) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9._@+/-]+$/u.test(file) || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) fail('License paths must be repository-relative files');
    const contents = await requestJson(`${apiRoot}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`, token, `source license ${file}`);
    if (contents.type !== 'file' || contents.encoding !== 'base64' || typeof contents.content !== 'string') fail(`Source license must be a direct regular file: ${file}`);
    const bytes = Buffer.from(contents.content.replaceAll('\n', ''), 'base64');
    licenses.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const candidate = {
    app_id: aggregate.app_id, display_name: firstInfo.display_name, version: aggregate.version,
    publisher: input.publisher,
    source: { repository, license: { spdx_expression: firstInfo.license?.identifier, files: licenses } },
    release: { tag, tag_protection_ref: tagProtection, commit_sha: commit, release_id: release.id, release_url: release.html_url, release_notes_url: release.html_url, immutable: true, prerelease: false },
    aggregate: aggregateAsset, package: input.package,
    app_access: firstInfo.app_access, capability_contract_refs: firstInfo.capability_contract_refs,
    required_standardized_feature_refs: firstInfo.required_standardized_feature_refs,
    storage_policy: firstInfo.storage_policy, update_channel: input.update_channel,
    rollback_marker: input.rollback_marker, support: input.support, targets,
  };
  const submission = { schema_version: 1, candidate };
  await validatePublisherSubmission(submission);
  validateAggregate(aggregateBytes, candidate);
  for (const [index, target] of targets.entries()) validatePublishedAppInfo(information[index].bytes, candidate, target);
  // Reuse the owner verifier for exact source licenses, package bytes and provenance.
  await validatePublishedGitHubCandidate(candidate, { token });
  return submission;
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    if (!['repository', 'tag', 'input', 'out'].includes(key) || !argv[index].startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(options, key)) fail('Use --repository <url> --tag <tag> --input <json-path> --out <json-path>');
    options[key] = argv[index + 1];
  }
  if (Object.keys(options).length !== 4) fail('Use --repository <url> --tag <tag> --input <json-path> --out <json-path>');
  const output = path.resolve(options.out);
  if (path.basename(output).toLowerCase() === 'index.json' || output.split(path.sep).some((part) => part.toLowerCase() === 'descriptors')) fail('Preparation writes publisher candidates only; choose a local file or submissions path');
  const input = JSON.parse(await readFile(options.input, 'utf8'));
  const submission = await prepareSubmission({ ...options, input, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '' });
  const content = `${JSON.stringify(submission, null, 2)}\n`;
  await mkdir(path.dirname(output), { recursive: true });
  try { await writeFile(output, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readFile(output, 'utf8') !== content) throw error;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, output, appId: submission.candidate.app_id, version: submission.candidate.version })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`Registry preparation failed: ${error.message}\n`); process.exitCode = 1; });
}
