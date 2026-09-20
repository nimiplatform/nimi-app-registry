import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import test from 'node:test';
import { PNG } from 'pngjs';
import { prepareSubmission } from '../scripts/prepare-submission.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function archive(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries).sort(([a], [b]) => a < b ? -1 : 1)) {
    const bytes = Buffer.from(content), filename = Buffer.from(name);
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(((0o100000 | (name.startsWith('payload/') ? 0o755 : 0o644)) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(directory, filename); offset += local.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

const SAFETY_PROFILE = {
  ai: { direct_interaction: true, interaction_notice: 'absent', outputs: [{ export_visible_marking: 'absent', exposure: 'exportable', in_product_notice: 'absent', machine_readable_marking: 'absent', modality: 'text', publication_control: 'not-applicable' }], risk_features: [], subject_notice: 'not-applicable' },
  content_descriptors: [],
  data_practices: { commercial_features: [], publisher_direct_external_network: false, sensitive_data_categories: [], telemetry: [], third_party_account: 'none', user_content_sharing: 'none' },
  high_impact_decision_uses: [],
  intended_audience: 'general',
};

function fixture(t, change = () => {}, options = {}) {
  const repository = 'https://github.com/publisher/example-app', tag = 'v1.2.3';
  const api = 'https://api.github.com/repos/publisher/example-app';
  const license = 'MIT fixture license';
  const declaration = { app_id: 'publisher.example-app', display_name: 'Example', version: '1.2.3', app_access: [], capability_contract_refs: [], required_standardized_feature_refs: [], storage_policy: { kind: 'nimi-mediated-default', os_storage_disclosure: null }, ...(options.safetyProfile ? { safety_profile: options.safetyProfile } : {}) };
  const info = { ...declaration, format: 'nimi.app-info/v1', target_id: 'windows-x86_64', summary: 'A test App.', icon: { media_type: 'image/png', data_base64: PNG.sync.write({ width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4, 255) }).toString('base64') }, readme_markdown: 'Use the App.', release_notes_markdown: 'Initial release.', license: { identifier: 'MIT', text: license } };
  const nativeTrust = { posture: 'production-unsigned', windows_authenticode: 'unsigned', certificate_subject: null };
  const execution = { requested_execution_level: 'asInvoker', ui_access: false };
  const manifest = { format: 'nimi.app-package/v2', app_id: declaration.app_id, version: declaration.version, target_id: info.target_id, os: 'windows', arch: 'x86_64', runtime_entry: 'payload/example.exe', native_trust: nativeTrust, execution_profile: execution };
  const infoBytes = Buffer.from(JSON.stringify(info));
  // Synthetic archive tests the Registry's data contract, not native execution.
  const packageBytes = archive({ 'LICENSE': license, 'manifest.json': JSON.stringify(manifest), 'nimi.app.yaml': JSON.stringify(declaration), 'app-info.json': infoBytes, 'payload/example.exe': 'unit-test payload; never executed' });
  const prefix = `${declaration.app_id}-${declaration.version}`;
  const aggregate = { format: 'nimi.app-release-candidate/v1', app_id: declaration.app_id, version: declaration.version, targets: [{ format: 'nimi.app-target-candidate/v1', app_id: declaration.app_id, version: declaration.version, target_id: info.target_id, os: 'windows', arch: 'x86_64', asset_name: `${prefix}-${info.target_id}.nimiapp`, size: packageBytes.length, sha256: digest(packageBytes), app_info: { asset_name: `${prefix}-${info.target_id}.app-info.json`, size: infoBytes.length, sha256: digest(infoBytes) }, runtime_entry: manifest.runtime_entry, native_trust: nativeTrust, execution_profile: execution }] };
  change(aggregate);
  const aggregateBytes = Buffer.from(JSON.stringify(aggregate));
  const assetData = [[`${prefix}.candidate.json`, aggregateBytes], [aggregate.targets[0].asset_name, packageBytes], [aggregate.targets[0].app_info.asset_name, infoBytes]];
  const assets = assetData.map(([name, bytes], index) => ({ id: index + 10, name, size: bytes.length, digest: `sha256:${digest(bytes)}`, browser_download_url: `${repository}/releases/download/${tag}/${name}` }));
  const release = { id: 42, tag_name: tag, html_url: `${repository}/releases/tag/${tag}`, draft: false, prerelease: false, immutable: true, assets };
  const responses = new Map([
    [api, { visibility: 'public', private: false }],
    [`${api}/git/ref/tags/${tag}`, { object: { type: 'tag', sha: 'a'.repeat(40) } }],
    [`${api}/git/tags/${'a'.repeat(40)}`, { tag, object: { type: 'commit', sha: 'b'.repeat(40) } }],
    [`${api}/rulesets?includes_parents=true`, [{ id: 100, target: 'tag', enforcement: 'active' }]],
    [`${api}/rulesets/100`, { conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'update' }, { type: 'deletion' }] }],
    [`${api}/releases/tags/${tag}`, release],
    [`${api}/contents/LICENSE?ref=${'b'.repeat(40)}`, { type: 'file', encoding: 'base64', content: Buffer.from(license).toString('base64') }],
    [`${api}/attestations/sha256:${digest(packageBytes)}`, { attestations: [{ bundle: { mediaType: 'unit-test-bundle', dsseEnvelope: {} } }] }],
    ...assets.map((asset, index) => [asset.browser_download_url, assetData[index][1]]),
  ]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url); assert.ok(responses.has(url), `unexpected request ${url}`);
    const value = responses.get(url); return new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  });
  const commands = [];
  const verification = { result: [{ verificationResult: { signature: { certificate: { buildTrigger: 'push' } } } }] };
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    commands.push({ command, args, token: options.env.GH_TOKEN });
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.deepEqual(readFileSync(args[2]), packageBytes, 'verifier receives the exact downloaded package');
    const bundlePath = args[args.indexOf('--bundle') + 1];
    assert.deepEqual(readFileSync(bundlePath, 'utf8').trim().split('\n').map(JSON.parse), responses.get(`${api}/attestations/sha256:${digest(packageBytes)}`).attestations.map((entry) => entry.bundle));
    if (verification.error) throw verification.error;
    return JSON.stringify(verification.result);
  });
  const input = { publisher: { github_namespace: 'publisher', namespace_kind: 'organization', assurance: 'pseudonymous', verified_domain_ref: null, kyc_ref: null }, license_files: ['LICENSE'], package: { kind: 'nimiapp', runtime_kind: 'native', registration_mode: 'app-managed', sandbox_ref: 'ordinary-user-process-no-sandbox' }, support: { diagnostics_bundle_fields: ['app_version'], redaction_rules: ['credentials'], issue_categories: ['startup'], escalation_url: `${repository}/issues`, kill_switch_visibility: 'visible', recovery_instructions: 'Restart the App from Nimi.' }, update_channel: 'stable', rollback_marker: 'none' };
  return { repository, tag, input, release, calls, commands, verification, responses, assets, api, license };
}

test('preparation derives immutable facts and runs the existing complete candidate verifier', async (t) => {
  const f = fixture(t);
  const submission = await prepareSubmission(f);
  assert.deepEqual(Object.keys(submission), ['schema_version', 'candidate']);
  assert.equal(submission.candidate.release.commit_sha, 'b'.repeat(40));
  assert.equal(submission.candidate.targets[0].asset_id, f.assets[1].id);
  assert.equal(submission.candidate.source.license.files[0].sha256, digest(f.license));
  assert.equal(submission.candidate.targets[0].native_trust.windows_code_signing, 'unsigned');
  assert.ok(f.calls.includes(f.assets[1].browser_download_url), 'existing verifier reads actual archive bytes');
  assert.ok(f.calls.some((url) => url.includes('/attestations/sha256:')));
  assert.equal('admission' in submission, false);
  const [{ args }] = f.commands;
  for (const [flag, value] of Object.entries({
    '--hostname': 'github.com', '--repo': 'publisher/example-app',
    '--predicate-type': 'https://slsa.dev/provenance/v1', '--source-ref': `refs/tags/${f.tag}`,
    '--source-digest': 'b'.repeat(40), '--signer-digest': 'b'.repeat(40),
    '--cert-identity': `${f.repository}/.github/workflows/nimi-app-release.yml@refs/tags/${f.tag}`,
    '--cert-oidc-issuer': 'https://token.actions.githubusercontent.com', '--format': 'json',
  })) assert.equal(args[args.indexOf(flag) + 1], value, flag);
  assert.equal(existsSync(args[2]), false, 'temporary artifact is removed after verification');
});

test('caller-supplied release or approval facts are rejected before network use', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => prepareSubmission({ ...f, input: { ...f.input, release: { release_id: 999 } } }), /facts cannot be supplied/);
  assert.equal(f.calls.length, 0);
});

test('mutable Releases and changed asset digests do not produce a submission', async (t) => {
  const f = fixture(t);
  f.release.immutable = false;
  await assert.rejects(() => prepareSubmission(f), /final, immutable/);
  f.release.immutable = true;
  f.assets[0].digest = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(() => prepareSubmission(f), /SHA-256 mismatch/);
});

test('contradictory native facts cannot be downgraded to unsigned during preparation', async (t) => {
  const f = fixture(t, (aggregate) => { aggregate.targets[0].native_trust.windows_authenticode = 'invalid'; });
  await assert.rejects(() => prepareSubmission(f), /native trust is contradictory/);
});

test('tag rules use wildcard inclusions and exclusions for the exact version tag', async (t) => {
  const f = fixture(t);
  const rules = f.responses.get(`${f.api}/rulesets/100`);
  rules.conditions.ref_name.include = ['refs/tags/v[12].?.*'];
  rules.conditions.ref_name.exclude = ['refs/tags/v2.*'];
  await prepareSubmission(f);
  rules.conditions.ref_name.exclude = ['refs/tags/v1.*'];
  await assert.rejects(() => prepareSubmission(f), /not protected against update and deletion/);
  rules.conditions.ref_name.exclude = ['refs/tags/v[!2].?.*'];
  await assert.rejects(() => prepareSubmission(f), /not protected against update and deletion/);
  rules.conditions.ref_name.exclude = ['refs/tags/v\\1.*'];
  await assert.rejects(() => prepareSubmission(f), /not protected against update and deletion/);
});

test('uninterpretable tag exclusions fail closed', async (t) => {
  const f = fixture(t);
  f.responses.get(`${f.api}/rulesets/100`).conditions.ref_name.exclude = ['refs/tags/v@(1|2).*'];
  await assert.rejects(() => prepareSubmission(f), /unsupported GitHub tag ruleset pattern/);
});

test('gh provenance verification failure is propagated without retaining temporary files', async (t) => {
  const f = fixture(t);
  f.verification.error = Object.assign(new Error('gh exited with status 1'), { stderr: 'no matching SLSA provenance from the expected source' });
  await assert.rejects(() => prepareSubmission({ ...f, token: 'fixture-token' }), /build provenance verification failed: no matching SLSA provenance/);
  assert.equal(f.commands[0].token, 'fixture-token');
  assert.equal(existsSync(f.commands[0].args[2]), false);
});

test('a claimed push predicate cannot substitute for the verified certificate trigger', async (t) => {
  const f = fixture(t);
  f.verification.result = [{ verificationResult: {
    signature: { certificate: { buildTrigger: 'workflow_dispatch' } },
    statement: { predicate: { buildDefinition: { internalParameters: { github: { event_name: 'push' } } } } },
  } }];
  await assert.rejects(() => prepareSubmission(f), /not from a tag-triggered GitHub Actions run/);
});

test('the declaration enters the candidate only from the immutable information asset and is required once policy enables it', async (t) => {
  const undeclared = fixture(t);
  const optional = { safetyProfileRequiredForNewAdmission: false };
  const required = { safetyProfileRequiredForNewAdmission: true };
  assert.equal('safety_profile' in (await prepareSubmission({ ...undeclared, policy: optional })).candidate, false);
  await assert.rejects(() => prepareSubmission({ ...undeclared, policy: required }), /publisher candidate is missing safety_profile: new public admission requires the complete publisher safety declaration/u);
  const declared = fixture(t, () => {}, { safetyProfile: SAFETY_PROFILE });
  const submission = await prepareSubmission({ ...declared, policy: required });
  assert.deepEqual(submission.candidate.safety_profile, SAFETY_PROFILE);
  await assert.rejects(() => prepareSubmission({ ...declared, policy: required, input: { ...declared.input, safety_profile: SAFETY_PROFILE } }), /facts cannot be supplied/u);
});
