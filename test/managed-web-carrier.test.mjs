import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { stringify as stringifyYaml } from 'yaml';

import {
  RegistryValidationError,
  compareSemVer,
  validatePublisherSubmission,
  validatePullRequestTransition,
} from '../scripts/registry-validation.mjs';
import {
  validateAggregate,
  validateNimiAppArchive,
} from '../scripts/github-candidate-validation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(projectRoot, 'schema');

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

function buildZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8');
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    const mode = entry.mode ?? 0o644;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((mode & 0o170000) === 0o120000 ? mode : 0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseSafetyProfile(overrides = {}) {
  return {
    ai: {
      direct_interaction: false,
      interaction_notice: 'not-applicable',
      outputs: [],
      risk_features: [],
      subject_notice: 'not-applicable',
    },
    content_descriptors: [],
    data_practices: {
      commercial_features: [],
      publisher_direct_external_network: false,
      sensitive_data_categories: [],
      telemetry: [],
      third_party_account: 'none',
      user_content_sharing: 'none',
    },
    high_impact_decision_uses: [],
    intended_audience: 'general',
    ...overrides,
  };
}

function makeNativeCandidate(version, targets = ['windows-x86_64', 'macos-aarch64'], safetyOverrides = {}) {
  const tag = `v${version}`;
  const repo = 'https://github.com/publisher/shijing-demo';
  const targetList = targets.map((targetId, index) => {
    const isWin = targetId === 'windows-x86_64';
    const digest = `${isWin ? 'd' : 'f'}`.repeat(64);
    return {
      target_id: targetId,
      os: isWin ? 'windows' : 'macos',
      arch: isWin ? 'x86_64' : 'arm64',
      asset_id: 700 + index * 10,
      asset_name: `nimi.shijing-demo-${version}-${targetId}.nimiapp`,
      asset_url: `${repo}/releases/download/${tag}/nimi.shijing-demo-${version}-${targetId}.nimiapp`,
      size: 2048,
      sha256: digest,
      app_info: {
        asset_id: 701 + index * 10,
        asset_name: `nimi.shijing-demo-${version}-${targetId}.app-info.json`,
        asset_url: `${repo}/releases/download/${tag}/nimi.shijing-demo-${version}-${targetId}.app-info.json`,
        size: 1024,
        sha256: 'e'.repeat(64),
      },
      runtime_entry: isWin ? 'payload/shijing.exe' : 'payload/shijing.app/Contents/MacOS/shijing',
      provenance_attestation_refs: [`https://api.github.com/repos/publisher/shijing-demo/attestations/sha256:${digest}`],
      execution_profile_ref: isWin ? 'windows-user-mode-as-invoker-v1' : 'macos-user-mode-same-session-v1',
      native_trust: isWin
        ? {
          signing_subject: null,
          observed_subject: null,
          entitlements_ref: null,
          windows_code_signing: 'unsigned',
          macos_notarization: 'not-applicable',
          macos_developer_id_subject: null,
        }
        : {
          signing_subject: null,
          observed_subject: null,
          entitlements_ref: null,
          windows_code_signing: 'not-applicable',
          macos_notarization: 'absent',
          macos_developer_id_subject: null,
        },
    };
  });
  return {
    app_id: 'nimi.shijing-demo',
    display_name: 'Shijing Demo',
    version,
    publisher: {
      github_namespace: 'publisher',
      namespace_kind: 'organization',
      assurance: 'pseudonymous',
      verified_domain_ref: null,
      kyc_ref: null,
    },
    source: {
      repository: repo,
      license: {
        spdx_expression: 'MIT',
        files: [{ path: 'LICENSE', sha256: 'a'.repeat(64) }],
      },
    },
    release: {
      tag,
      tag_protection_ref: 'https://api.github.com/repos/publisher/shijing-demo/rulesets/100',
      commit_sha: 'b'.repeat(40),
      release_id: 123,
      release_url: `${repo}/releases/tag/${tag}`,
      release_notes_url: `${repo}/releases/tag/${tag}`,
      immutable: true,
      prerelease: false,
    },
    aggregate: {
      asset_id: 456,
      asset_name: `nimi.shijing-demo-${version}.candidate.json`,
      asset_url: `${repo}/releases/download/${tag}/nimi.shijing-demo-${version}.candidate.json`,
      size: 1000,
      sha256: 'c'.repeat(64),
    },
    package: {
      kind: 'nimiapp',
      runtime_kind: 'native',
      registration_mode: 'app-managed',
      sandbox_ref: 'ordinary-user-process-no-sandbox',
    },
    app_access: ['runtime.consume'],
    capability_contract_refs: ['text.generate'],
    required_standardized_feature_refs: [],
    storage_policy: {
      kind: 'nimi-mediated-default',
      os_storage_disclosure: null,
    },
    update_channel: 'stable',
    rollback_marker: 'previous-admitted-release',
    support: {
      diagnostics_bundle_fields: ['app_version'],
      redaction_rules: ['credentials'],
      issue_categories: ['startup'],
      escalation_url: `${repo}/issues`,
      kill_switch_visibility: 'visible',
      recovery_instructions: 'Restart the App from Nimi Home.',
    },
    safety_profile: baseSafetyProfile(safetyOverrides),
    targets: targetList,
  };
}

function makeManagedWebCandidate(version, safetyOverrides = {}) {
  const tag = `v${version}`;
  const repo = 'https://github.com/publisher/shijing-demo';
  const digest = '9'.repeat(64);
  return {
    ...makeNativeCandidate(version, [], safetyOverrides),
    package: {
      kind: 'nimiapp',
      runtime_kind: 'managed-web',
      registration_mode: 'app-managed',
      sandbox_ref: 'nimi-managed-web-v1',
    },
    targets: [{
      target_id: 'desktop-universal',
      os: 'any',
      arch: 'any',
      asset_id: 800,
      asset_name: `nimi.shijing-demo-${version}-desktop-universal.nimiapp`,
      asset_url: `${repo}/releases/download/${tag}/nimi.shijing-demo-${version}-desktop-universal.nimiapp`,
      size: 4096,
      sha256: digest,
      app_info: {
        asset_id: 801,
        asset_name: `nimi.shijing-demo-${version}-desktop-universal.app-info.json`,
        asset_url: `${repo}/releases/download/${tag}/nimi.shijing-demo-${version}-desktop-universal.app-info.json`,
        size: 1024,
        sha256: '8'.repeat(64),
      },
      runtime_entry: 'payload/index.html',
      provenance_attestation_refs: [`https://api.github.com/repos/publisher/shijing-demo/attestations/sha256:${digest}`],
      execution_profile_ref: 'nimi-managed-web-v1',
      native_trust: {
        signing_subject: null,
        observed_subject: null,
        entitlements_ref: null,
        windows_code_signing: 'not-applicable',
        macos_notarization: 'not-applicable',
        macos_developer_id_subject: null,
      },
    }],
  };
}

function makeDescriptor(candidate, submissionPath, headSha, pullNumber = 12) {
  return {
    schema_version: 1,
    descriptor_id: `${candidate.app_id}@${candidate.version}`,
    publisher_submission: {
      pull_number: pullNumber,
      path: submissionPath,
      head_sha: headSha,
    },
    admission: {
      ordinary_release_proof: true,
      trust_tier: 'first-party',
      build_assurance: 'developer-attested',
      dependency_assurance: {
        lockfile_reviewed: true,
        sbom_ref: null,
      },
      review: {
        decision: 'approved',
        adjudicator_login: 'maintainer',
        adjudicator_actor_id: 42,
        reason_code: 'admitted-carrier-release',
        decided_at: '2026-11-21T00:00:00Z',
      },
    },
    candidate,
  };
}

function writeJson(root, relativePath, value) {
  const absolute = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function initRegistryRepo(initialCandidate, initialTargetMap) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nimi-reg-managed-web-'));
  cpSync(schemaRoot, path.join(root, 'schema'), { recursive: true });
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@nimi.ai');
  git(root, 'config', 'user.name', 'Test Maintainer');

  const descPath = `descriptors/${initialCandidate.app_id}/${initialCandidate.version}.json`;
  const desc = makeDescriptor(
    initialCandidate,
    `submissions/publisher/${initialCandidate.app_id}/${initialCandidate.version}.json`,
    '1'.repeat(40),
    1,
  );
  writeJson(root, descPath, desc);
  writeJson(root, `products/${initialCandidate.app_id}/product.json`, {
    app_id: initialCandidate.app_id,
    slug: 'shijing-demo',
    display_name: initialCandidate.display_name,
    repository: initialCandidate.source.repository,
    publisher: initialCandidate.publisher.github_namespace,
    repository_id: 101,
    owner_id: 11,
    summary: { en: 'Shijing Demo', zh: '时镜演示' },
    visibility: 'public',
    origin: 'nimi-official',
    license: 'MIT',
    kill_switch: { active: false, reason: null, revision: 0 },
  });
  writeJson(root, 'index.json', {
    schema_version: 1,
    apps: {
      [initialCandidate.app_id]: {
        display_name: initialCandidate.display_name,
        visibility: 'public',
        admission_status: 'approved',
        origin: 'nimi-official',
        kill_switch: { active: false, reason: null, revision: 0 },
        latest_admitted_release_by_target: initialTargetMap(desc.descriptor_id, descPath),
      },
    },
  });
  const baseSha = commit(root, 'initial registry state');
  return { root, baseSha };
}

test('three-branch schema admits managed-web candidates and rejects invalid carrier combinations', async () => {
  const valid = makeManagedWebCandidate('0.1.12');
  await validatePublisherSubmission({ schema_version: 1, candidate: valid }, { schemaRoot });

  // managed-web cannot use app-owned-os-storage
  const badStorage = makeManagedWebCandidate('0.1.12');
  badStorage.storage_policy = {
    kind: 'app-owned-os-storage',
    os_storage_disclosure: [{ path_pattern: '~/foo', purpose: 'cache', expected_size_band: '<10MiB' }],
  };
  await assert.rejects(() => validatePublisherSubmission({ schema_version: 1, candidate: badStorage }, { schemaRoot }), RegistryValidationError);

  // managed-web cannot carry native target
  const badTarget = makeManagedWebCandidate('0.1.12');
  badTarget.targets = makeNativeCandidate('0.1.12', ['windows-x86_64']).targets;
  await assert.rejects(() => validatePublisherSubmission({ schema_version: 1, candidate: badTarget }, { schemaRoot }), RegistryValidationError);

  // native cannot carry desktop-universal target
  const badNative = makeNativeCandidate('0.1.12', ['windows-x86_64']);
  badNative.targets = makeManagedWebCandidate('0.1.12').targets;
  await assert.rejects(() => validatePublisherSubmission({ schema_version: 1, candidate: badNative }, { schemaRoot }), RegistryValidationError);

  // managed-web os=any target requires null signing subjects & nimi-managed-web-v1
  const badTrust = makeManagedWebCandidate('0.1.12');
  badTrust.targets[0].native_trust.windows_code_signing = 'unsigned';
  await assert.rejects(() => validatePublisherSubmission({ schema_version: 1, candidate: badTrust }, { schemaRoot }), RegistryValidationError);
});

test('validateNimiAppArchive and validateAggregate enforce managed-web 0o644 entry, desktop.window, Windows path/case-folding, and 64 MiB limit', () => {
  const candidate = makeManagedWebCandidate('0.1.12');
  const licenseText = 'MIT License\n';
  candidate.source.license.files = [{ path: 'LICENSE', sha256: sha256(Buffer.from(licenseText)) }];

  const iconBytes = PNG.sync.write({ width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4, 255) });
  const appInfoObj = {
    format: 'nimi.app-info/v1',
    app_id: candidate.app_id,
    version: candidate.version,
    target_id: 'desktop-universal',
    display_name: candidate.display_name,
    summary: 'Managed-web test app',
    icon: { media_type: 'image/png', data_base64: iconBytes.toString('base64') },
    readme_markdown: '# Shijing Demo\nRun it.\n',
    release_notes_markdown: 'v0.1.12',
    license: { identifier: 'MIT', text: licenseText },
    app_access: candidate.app_access,
    capability_contract_refs: candidate.capability_contract_refs,
    required_standardized_feature_refs: candidate.required_standardized_feature_refs,
    storage_policy: candidate.storage_policy,
    author: 'Nimi',
    homepage_url: '',
    support_url: '',
    safety_profile: candidate.safety_profile,
  };
  const infoBytes = Buffer.from(`${JSON.stringify(appInfoObj)}\n`);
  candidate.targets[0].app_info.size = infoBytes.length;
  candidate.targets[0].app_info.sha256 = sha256(infoBytes);

  const buildArchive = ({ indexMode = 0o644, desktop = { window: { width: 1320, height: 900, min_width: 390, min_height: 620, title_bar_style: 'hidden' } }, extraEntries = [] } = {}) => {
    const manifestJson = JSON.stringify({
      format: 'nimi.app-package/v2',
      app_id: candidate.app_id,
      version: candidate.version,
      target_id: 'desktop-universal',
      os: 'any',
      arch: 'any',
      runtime_entry: 'payload/index.html',
      native_trust: { posture: 'nimi-managed-carrier', certificate_subject: null },
      execution_profile: { launch_mode: 'nimi-managed-web-v1' },
    });
    const declarationYaml = stringifyYaml({
      app_id: candidate.app_id,
      display_name: candidate.display_name,
      version: candidate.version,
      app_access: candidate.app_access,
      capability_contract_refs: candidate.capability_contract_refs,
      required_standardized_feature_refs: candidate.required_standardized_feature_refs,
      storage_policy: candidate.storage_policy,
      safety_profile: candidate.safety_profile,
      ...(desktop !== undefined ? { desktop } : {}),
    });
    return buildZip([
      { name: 'LICENSE', bytes: Buffer.from(licenseText), mode: 0o644 },
      { name: 'manifest.json', bytes: Buffer.from(manifestJson), mode: 0o644 },
      { name: 'nimi.app.yaml', bytes: Buffer.from(declarationYaml), mode: 0o644 },
      { name: 'app-info.json', bytes: infoBytes, mode: 0o644 },
      { name: 'payload/index.html', bytes: Buffer.from('<!doctype html><html></html>'), mode: indexMode },
      ...extraEntries,
    ]);
  };

  const validZip = buildArchive();
  candidate.targets[0].size = validZip.length;
  candidate.targets[0].sha256 = sha256(validZip);
  candidate.targets[0].provenance_attestation_refs = [`https://api.github.com/repos/publisher/shijing-demo/attestations/sha256:${candidate.targets[0].sha256}`];

  const licenseDigests = new Set([sha256(Buffer.from(licenseText))]);
  validateNimiAppArchive(validZip, candidate, candidate.targets[0], licenseDigests, infoBytes);

  const aggregateBytes = Buffer.from(JSON.stringify({
    format: 'nimi.app-release-candidate/v1',
    app_id: candidate.app_id,
    version: candidate.version,
    targets: [{
      format: 'nimi.app-target-candidate/v1',
      app_id: candidate.app_id,
      version: candidate.version,
      target_id: 'desktop-universal',
      os: 'any',
      arch: 'any',
      asset_name: candidate.targets[0].asset_name,
      size: candidate.targets[0].size,
      sha256: candidate.targets[0].sha256,
      app_info: {
        asset_name: candidate.targets[0].app_info.asset_name,
        size: candidate.targets[0].app_info.size,
        sha256: candidate.targets[0].app_info.sha256,
      },
      runtime_entry: 'payload/index.html',
      native_trust: { posture: 'nimi-managed-carrier', certificate_subject: null },
      execution_profile: { launch_mode: 'nimi-managed-web-v1' },
    }],
  }));
  validateAggregate(aggregateBytes, candidate);

  // Reject 0o755 runtime_entry
  assert.throws(() => validateNimiAppArchive(buildArchive({ indexMode: 0o755 }), candidate, candidate.targets[0], licenseDigests, infoBytes), /0644/u);
  // Reject invalid desktop.window
  assert.throws(() => validateNimiAppArchive(buildArchive({ desktop: { window: { width: 500, min_width: 600 } } }), candidate, candidate.targets[0], licenseDigests, infoBytes), /min dimensions/u);
  // Reject Windows reserved segment
  assert.throws(() => validateNimiAppArchive(buildArchive({ extraEntries: [{ name: 'payload/CON.js', bytes: Buffer.from('x'), mode: 0o644 }] }), candidate, candidate.targets[0], licenseDigests, infoBytes), /invalid Windows segment/u);
  // Reject case-folding collision
  assert.throws(() => validateNimiAppArchive(buildArchive({
    extraEntries: [
      { name: 'payload/App.js', bytes: Buffer.from('a'), mode: 0o644 },
      { name: 'payload/app.js', bytes: Buffer.from('b'), mode: 0o644 },
    ],
  }), candidate, candidate.targets[0], licenseDigests, infoBytes), /collision/u);
});

test('LIFE-3: cross-carrier hard cutover replaces pointers only on strictly higher SemVer, preserves safety_profile diff baseline, and reports dropped platforms on reverse cutover', async () => {
  assert.equal(compareSemVer('0.1.12', '0.1.11'), 1);
  assert.equal(compareSemVer('0.1.11', '0.1.11'), 0);
  assert.equal(compareSemVer('0.1.12-rc.1', '0.1.12'), -1);

  // 1) Forward hard cutover: native 0.1.11 (win + mac) -> managed-web 0.1.12 (desktop-universal)
  const initialNative = makeNativeCandidate('0.1.11', ['windows-x86_64', 'macos-aarch64'], { intended_audience: 'general' });
  const { root, baseSha } = initRegistryRepo(initialNative, (descId, descPath) => ({
    'windows-x86_64': { descriptor_id: descId, path: descPath },
    'macos-aarch64': { descriptor_id: descId, path: descPath },
  }));
  try {
    const nextManaged = makeManagedWebCandidate('0.1.12', { intended_audience: 'teen' });
    const subPath = `submissions/publisher/${nextManaged.app_id}/${nextManaged.version}.json`;
    writeJson(root, subPath, { schema_version: 1, candidate: nextManaged });
    const pubSha = commit(root, 'publisher submission 0.1.12');

    // Publisher PR declarationReview must diff against 0.1.11 (deduplicated), NOT null!
    const pubReview = await validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot: path.join(root, 'schema'),
      baseSha,
      headSha: pubSha,
      context: { headOwner: 'publisher' },
    });
    assert.equal(pubReview.mode, 'publisher-submission');
    assert.equal(pubReview.declaration.baselines.length, 1);
    assert.equal(pubReview.declaration.baselines[0].previousDescriptorId, 'nimi.shijing-demo@0.1.11');
    assert.ok(pubReview.declaration.baselines[0].changes.length > 0, 'must report safety_profile diff relative to 0.1.11');

    // Maintainer finalization replacing both native pointers with desktop-universal succeeds
    rmSync(path.join(root, subPath));
    const descPath = `descriptors/${nextManaged.app_id}/${nextManaged.version}.json`;
    const desc = makeDescriptor(nextManaged, subPath, pubSha, 22);
    writeJson(root, descPath, desc);
    writeJson(root, 'index.json', {
      schema_version: 1,
      apps: {
        [nextManaged.app_id]: {
          display_name: nextManaged.display_name,
          visibility: 'public',
          admission_status: 'approved',
          origin: 'nimi-official',
          kill_switch: { active: false, reason: null, revision: 0 },
          latest_admitted_release_by_target: {
            'desktop-universal': { descriptor_id: desc.descriptor_id, path: descPath },
          },
        },
      },
    });
    const finalSha = commit(root, 'finalize 0.1.12 managed-web cutover');
    const finalized = await validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot: path.join(root, 'schema'),
      baseSha,
      headSha: finalSha,
      context: {
        pullNumber: 22,
        actorLogin: 'maintainer',
        actorId: 42,
        finalizerPermission: 'maintain',
        candidateCheckPassed: true,
      },
    });
    assert.equal(finalized.mode, 'maintainer-finalization');
    assert.deepEqual(finalized.carrierTransition, {
      fromRuntimeKinds: ['native'],
      toRuntimeKind: 'managed-web',
      replacedTargets: ['macos-aarch64', 'windows-x86_64'],
      droppedPlatforms: [],
    });
    assert.equal(finalized.declaration.baselines[0].previousDescriptorId, 'nimi.shijing-demo@0.1.11');

    // 2) Reverse cutover: managed-web 0.1.12 -> single-platform native 0.2.0 (windows-x86_64 only) reports droppedPlatforms: ['macos']
    const reverseNative = makeNativeCandidate('0.2.0', ['windows-x86_64'], { intended_audience: 'teen' });
    const revSubPath = `submissions/publisher/${reverseNative.app_id}/${reverseNative.version}.json`;
    writeJson(root, revSubPath, { schema_version: 1, candidate: reverseNative });
    const revPubSha = commit(root, 'publisher submission 0.2.0 reverse native');
    rmSync(path.join(root, revSubPath));
    const revDescPath = `descriptors/${reverseNative.app_id}/${reverseNative.version}.json`;
    const revDesc = makeDescriptor(reverseNative, revSubPath, revPubSha, 23);
    writeJson(root, revDescPath, revDesc);
    writeJson(root, 'index.json', {
      schema_version: 1,
      apps: {
        [reverseNative.app_id]: {
          display_name: reverseNative.display_name,
          visibility: 'public',
          admission_status: 'approved',
          origin: 'nimi-official',
          kill_switch: { active: false, reason: null, revision: 0 },
          latest_admitted_release_by_target: {
            'windows-x86_64': { descriptor_id: revDesc.descriptor_id, path: revDescPath },
          },
        },
      },
    });
    const revFinalSha = commit(root, 'finalize 0.2.0 reverse native');
    const reversed = await validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot: path.join(root, 'schema'),
      baseSha: finalSha,
      headSha: revFinalSha,
      context: {
        pullNumber: 23,
        actorLogin: 'maintainer',
        actorId: 42,
        finalizerPermission: 'maintain',
        candidateCheckPassed: true,
      },
    });
    assert.deepEqual(reversed.carrierTransition, {
      fromRuntimeKinds: ['managed-web'],
      toRuntimeKind: 'native',
      replacedTargets: ['desktop-universal'],
      droppedPlatforms: ['macos'],
    });
    assert.equal(reversed.declaration.baselines[0].previousDescriptorId, 'nimi.shijing-demo@0.1.12');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 3) Negative guardrails: same-carrier native cannot drop macos-aarch64; cross-carrier cannot use equal/lower SemVer
  const nativeBase = makeNativeCandidate('1.0.0', ['windows-x86_64', 'macos-aarch64']);
  const guardRepo = initRegistryRepo(nativeBase, (descId, descPath) => ({
    'windows-x86_64': { descriptor_id: descId, path: descPath },
    'macos-aarch64': { descriptor_id: descId, path: descPath },
  }));
  try {
    // Attempt same-carrier native 1.0.1 dropping macos-aarch64 -> MUST FAIL
    const dropMac = makeNativeCandidate('1.0.1', ['windows-x86_64']);
    const dropSub = `submissions/publisher/${dropMac.app_id}/${dropMac.version}.json`;
    writeJson(guardRepo.root, dropSub, { schema_version: 1, candidate: dropMac });
    const dropPubSha = commit(guardRepo.root, 'submit 1.0.1');
    rmSync(path.join(guardRepo.root, dropSub));
    const dropDescPath = `descriptors/${dropMac.app_id}/${dropMac.version}.json`;
    const dropDesc = makeDescriptor(dropMac, dropSub, dropPubSha, 30);
    writeJson(guardRepo.root, dropDescPath, dropDesc);
    writeJson(guardRepo.root, 'index.json', {
      schema_version: 1,
      apps: {
        [dropMac.app_id]: {
          display_name: dropMac.display_name,
          visibility: 'public',
          admission_status: 'approved',
          origin: 'nimi-official',
          kill_switch: { active: false, reason: null, revision: 0 },
          latest_admitted_release_by_target: {
            'windows-x86_64': { descriptor_id: dropDesc.descriptor_id, path: dropDescPath },
          },
        },
      },
    });
    const dropFinalSha = commit(guardRepo.root, 'try dropping macos in same-carrier native');
    await assert.rejects(() => validatePullRequestTransition({
      root: guardRepo.root,
      gitRoot: guardRepo.root,
      schemaRoot: path.join(guardRepo.root, 'schema'),
      baseSha: guardRepo.baseSha,
      headSha: dropFinalSha,
      context: { pullNumber: 30, actorLogin: 'maintainer', actorId: 42, finalizerPermission: 'maintain', candidateCheckPassed: true },
    }), /without a carrier transition/u);

    // Reset and attempt cross-carrier downgrade 0.9.9 -> MUST FAIL
    git(guardRepo.root, 'reset', '--hard', guardRepo.baseSha);
    const downgrade = makeManagedWebCandidate('0.9.9');
    const dgSub = `submissions/publisher/${downgrade.app_id}/${downgrade.version}.json`;
    writeJson(guardRepo.root, dgSub, { schema_version: 1, candidate: downgrade });
    const dgPubSha = commit(guardRepo.root, 'submit 0.9.9');
    rmSync(path.join(guardRepo.root, dgSub));
    const dgDescPath = `descriptors/${downgrade.app_id}/${downgrade.version}.json`;
    const dgDesc = makeDescriptor(downgrade, dgSub, dgPubSha, 31);
    writeJson(guardRepo.root, dgDescPath, dgDesc);
    writeJson(guardRepo.root, 'index.json', {
      schema_version: 1,
      apps: {
        [downgrade.app_id]: {
          display_name: downgrade.display_name,
          visibility: 'public',
          admission_status: 'approved',
          origin: 'nimi-official',
          kill_switch: { active: false, reason: null, revision: 0 },
          latest_admitted_release_by_target: {
            'desktop-universal': { descriptor_id: dgDesc.descriptor_id, path: dgDescPath },
          },
        },
      },
    });
    const dgFinalSha = commit(guardRepo.root, 'try cross-carrier downgrade');
    await assert.rejects(() => validatePullRequestTransition({
      root: guardRepo.root,
      gitRoot: guardRepo.root,
      schemaRoot: path.join(guardRepo.root, 'schema'),
      baseSha: guardRepo.baseSha,
      headSha: dgFinalSha,
      context: { pullNumber: 31, actorLogin: 'maintainer', actorId: 42, finalizerPermission: 'maintain', candidateCheckPassed: true },
    }), /must raise version above replaced/u);
  } finally {
    rmSync(guardRepo.root, { recursive: true, force: true });
  }
});

test('Registry enforces strict SemVer, Unicode full case folding, integer YAML window bounds, and full target mounting on reverse switch', async () => {
  // 1. Strict SemVer rejects leading-zero numeric prerelease identifiers
  const leadingZero = makeManagedWebCandidate('0.1.12-01');
  await assert.rejects(() => validatePublisherSubmission({ schema_version: 1, candidate: leadingZero }, { schemaRoot }), RegistryValidationError);

  // 2. Unicode full case folding (Straße vs STRAẞE) and YAML float (1280.0) rejected
  const candidate = makeManagedWebCandidate('0.1.12');
  const licenseText = 'MIT License\n';
  candidate.source.license.files = [{ path: 'LICENSE', sha256: sha256(Buffer.from(licenseText)) }];
  const iconBytes = PNG.sync.write({ width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4, 255) });
  const appInfoObj = {
    format: 'nimi.app-info/v1',
    app_id: candidate.app_id,
    version: candidate.version,
    target_id: 'desktop-universal',
    display_name: candidate.display_name,
    summary: 'Managed-web test app',
    icon: { media_type: 'image/png', data_base64: iconBytes.toString('base64') },
    readme_markdown: '# Shijing Demo\nRun it.\n',
    release_notes_markdown: 'v0.1.12',
    license: { identifier: 'MIT', text: licenseText },
    app_access: candidate.app_access,
    capability_contract_refs: candidate.capability_contract_refs,
    required_standardized_feature_refs: candidate.required_standardized_feature_refs,
    storage_policy: candidate.storage_policy,
    author: 'Nimi',
    homepage_url: '',
    support_url: '',
    safety_profile: candidate.safety_profile,
  };
  const infoBytes = Buffer.from(`${JSON.stringify(appInfoObj)}\n`);
  candidate.targets[0].app_info.size = infoBytes.length;
  candidate.targets[0].app_info.sha256 = sha256(infoBytes);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    format: 'nimi.app-package/v2',
    app_id: candidate.app_id,
    version: candidate.version,
    target_id: 'desktop-universal',
    os: 'any',
    arch: 'any',
    runtime_entry: 'payload/index.html',
    native_trust: { posture: 'nimi-managed-carrier', certificate_subject: null },
    execution_profile: { launch_mode: 'nimi-managed-web-v1' },
  })}\n`);
  const baseDeclYaml = [
    `app_id: ${candidate.app_id}`,
    `display_name: ${candidate.display_name}`,
    `version: ${candidate.version}`,
    'app_access:',
    '  - runtime.consume',
    'capability_contract_refs:',
    '  - text.generate',
    'required_standardized_feature_refs: []',
    'storage_policy:',
    '  kind: nimi-mediated-default',
    '  os_storage_disclosure: null',
    'safety_profile:',
    '  intended_audience: general',
    '  content_descriptors: []',
    '  ai:',
    '    direct_interaction: true',
    '    interaction_notice: absent',
    '    risk_features: []',
    '    subject_notice: not-applicable',
    '    outputs: []',
    '  data_practices:',
    '    publisher_direct_external_network: false',
    '    telemetry: []',
    '    third_party_account: none',
    '    user_content_sharing: none',
    '    commercial_features: []',
    '    sensitive_data_categories: []',
    '  high_impact_decision_uses: []',
  ].join('\n');

  const strasseZip = buildZip([
    { name: 'LICENSE', bytes: Buffer.from(licenseText), mode: 0o644 },
    { name: 'app-info.json', bytes: infoBytes, mode: 0o644 },
    { name: 'manifest.json', bytes: manifestBytes, mode: 0o644 },
    { name: 'nimi.app.yaml', bytes: Buffer.from(`${baseDeclYaml}\n`), mode: 0o644 },
    { name: 'payload/STRAẞE.txt', bytes: Buffer.from('a'), mode: 0o644 },
    { name: 'payload/Straße.txt', bytes: Buffer.from('b'), mode: 0o644 },
    { name: 'payload/index.html', bytes: Buffer.from('<!doctype html>'), mode: 0o644 },
  ]);
  assert.throws(
    () => validateNimiAppArchive(strasseZip, candidate, candidate.targets[0], new Set([sha256(Buffer.from(licenseText))]), infoBytes),
    /path collision/u,
  );

  const floatWindowZip = buildZip([
    { name: 'LICENSE', bytes: Buffer.from(licenseText), mode: 0o644 },
    { name: 'app-info.json', bytes: infoBytes, mode: 0o644 },
    { name: 'manifest.json', bytes: manifestBytes, mode: 0o644 },
    { name: 'nimi.app.yaml', bytes: Buffer.from(`${baseDeclYaml}\ndesktop:\n  window:\n    width: 1280.0\n`), mode: 0o644 },
    { name: 'payload/index.html', bytes: Buffer.from('<!doctype html>'), mode: 0o644 },
  ]);
  assert.throws(
    () => validateNimiAppArchive(floatWindowZip, candidate, candidate.targets[0], new Set([sha256(Buffer.from(licenseText))]), infoBytes),
    /base-10 YAML integer/u,
  );

  // 3. Reverse switch omitting one declared candidate target in index.json MUST FAIL
  const revRepo = initRegistryRepo(makeManagedWebCandidate('1.0.0'), (descId, descPath) => ({
    'desktop-universal': { descriptor_id: descId, path: descPath },
  }));
  try {
    const dualNative = makeNativeCandidate('2.0.0', ['windows-x86_64', 'macos-aarch64']);
    const subPath = `submissions/publisher/${dualNative.app_id}/${dualNative.version}.json`;
    writeJson(revRepo.root, subPath, { schema_version: 1, candidate: dualNative });
    const pubSha = commit(revRepo.root, 'submit dual native 2.0.0');
    rmSync(path.join(revRepo.root, subPath));
    const descPath = `descriptors/${dualNative.app_id}/${dualNative.version}.json`;
    const desc = makeDescriptor(dualNative, subPath, pubSha, 40);
    writeJson(revRepo.root, descPath, desc);
    writeJson(revRepo.root, 'index.json', {
      schema_version: 1,
      apps: {
        [dualNative.app_id]: {
          display_name: dualNative.display_name,
          visibility: 'public',
          admission_status: 'approved',
          origin: 'nimi-official',
          kill_switch: { active: false, reason: null, revision: 0 },
          latest_admitted_release_by_target: {
            // Deliberately omits macos-aarch64
            'windows-x86_64': { descriptor_id: desc.descriptor_id, path: descPath },
          },
        },
      },
    });
    const finalSha = commit(revRepo.root, 'omit macos pointer on dual-target reverse switch');
    await assert.rejects(() => validatePullRequestTransition({
      root: revRepo.root,
      gitRoot: revRepo.root,
      schemaRoot: path.join(revRepo.root, 'schema'),
      baseSha: revRepo.baseSha,
      headSha: finalSha,
      context: { pullNumber: 40, actorLogin: 'maintainer', actorId: 42, finalizerPermission: 'maintain', candidateCheckPassed: true },
    }), /missing for admitted candidate target/u);
  } finally {
    rmSync(revRepo.root, { recursive: true, force: true });
  }
});
