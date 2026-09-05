import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RegistryValidationError,
  validatePullRequestTransition,
  validateRegistryTree,
} from '../scripts/registry-validation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(projectRoot, 'schema');

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

function candidate() {
  return {
    app_id: 'publisher.example-app',
    display_name: 'Example App',
    version: '1.2.3',
    publisher: {
      github_namespace: 'publisher',
      namespace_kind: 'organization',
      assurance: 'pseudonymous',
      verified_domain_ref: null,
      kyc_ref: null,
    },
    source: {
      repository: 'https://github.com/publisher/example-app',
      license: {
        spdx_expression: 'MIT',
        files: [{ path: 'LICENSE', sha256: 'a'.repeat(64) }],
      },
    },
    release: {
      tag: 'v1.2.3',
      tag_protection_ref: 'https://api.github.com/repos/publisher/example-app/rulesets/100',
      commit_sha: 'b'.repeat(40),
      release_id: 123,
      release_url: 'https://github.com/publisher/example-app/releases/tag/v1.2.3',
      release_notes_url: 'https://github.com/publisher/example-app/releases/tag/v1.2.3',
      immutable: true,
      prerelease: false,
    },
    aggregate: {
      asset_id: 456,
      asset_name: 'publisher.example-app-1.2.3.candidate.json',
      asset_url: 'https://github.com/publisher/example-app/releases/download/v1.2.3/publisher.example-app-1.2.3.candidate.json',
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
      escalation_url: 'https://github.com/publisher/example-app/issues',
      kill_switch_visibility: 'visible',
      recovery_instructions: 'Restart the App from Nimi Desktop.',
    },
    targets: [{
      target_id: 'windows-x86_64',
      os: 'windows',
      arch: 'x86_64',
      asset_id: 789,
      asset_name: 'publisher.example-app-1.2.3-windows-x86_64.nimiapp',
      asset_url: 'https://github.com/publisher/example-app/releases/download/v1.2.3/publisher.example-app-1.2.3-windows-x86_64.nimiapp',
      size: 2000,
      sha256: 'd'.repeat(64),
      runtime_entry: 'payload/example-app.exe',
      provenance_attestation_refs: [`https://api.github.com/repos/publisher/example-app/attestations/sha256:${'d'.repeat(64)}`],
      execution_profile_ref: 'windows-user-mode-as-invoker-v1',
      native_trust: {
        signing_subject: null,
        observed_subject: null,
        entitlements_ref: null,
        windows_code_signing: 'unsigned',
        macos_notarization: 'not-applicable',
        macos_developer_id_subject: null,
      },
    }],
  };
}

function descriptor(candidateValue, publisherHeadSha, overrides = {}) {
  return {
    schema_version: 1,
    descriptor_id: `${candidateValue.app_id}@${candidateValue.version}`,
    publisher_submission: {
      pull_number: 42,
      path: `submissions/${candidateValue.publisher.github_namespace}/${candidateValue.app_id}/${candidateValue.version}.json`,
      head_sha: publisherHeadSha,
    },
    admission: {
      ordinary_release_proof: true,
      trust_tier: 'community',
      build_assurance: 'developer-attested',
      dependency_assurance: {
        lockfile_reviewed: true,
        sbom_ref: null,
      },
      review: {
        decision: 'approved',
        adjudicator_login: 'registry-maintainer',
        adjudicator_actor_id: 9876,
        reason_code: 'approved-initial',
        decided_at: '2026-09-04T00:00:00Z',
      },
    },
    candidate: candidateValue,
    ...overrides,
  };
}

function indexFor(descriptorValue) {
  const { candidate: candidateValue } = descriptorValue;
  const descriptorPath = `descriptors/${candidateValue.app_id}/${candidateValue.version}.json`;
  return {
    schema_version: 1,
    apps: {
      [candidateValue.app_id]: {
        display_name: candidateValue.display_name,
        visibility: 'public',
        admission_status: 'approved',
        kill_switch: { active: false, reason: null, revision: 0 },
        latest_admitted_release_by_target: {
          'windows-x86_64': {
            descriptor_id: descriptorValue.descriptor_id,
            path: descriptorPath,
          },
        },
      },
    },
  };
}

function repository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nimi-registry-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Registry Test');
  git(root, 'config', 'user.email', 'registry-test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  writeJson(root, 'index.json', { schema_version: 2, apps: {} });
  const baseSha = commit(root, 'registry base');
  return { root, baseSha };
}

function addPublisherSubmission(root, candidateValue = candidate()) {
  const submissionPath = `submissions/${candidateValue.publisher.github_namespace}/${candidateValue.app_id}/${candidateValue.version}.json`;
  writeJson(root, submissionPath, { schema_version: 1, candidate: candidateValue });
  const publisherHeadSha = commit(root, 'publisher submission');
  return { candidateValue, submissionPath, publisherHeadSha };
}

function addFinalization(root, submission, descriptorOverrides = {}) {
  const descriptorValue = descriptor(submission.candidateValue, submission.publisherHeadSha, descriptorOverrides);
  const descriptorPath = `descriptors/${submission.candidateValue.app_id}/${submission.candidateValue.version}.json`;
  rmSync(path.join(root, ...submission.submissionPath.split('/')));
  writeJson(root, descriptorPath, descriptorValue);
  writeJson(root, 'index.json', indexFor(descriptorValue));
  const headSha = commit(root, 'maintainer finalization');
  return { descriptorPath, descriptorValue, headSha };
}

test('empty Registry tree is valid and contains no admission truth', async () => {
  const result = await validateRegistryTree(projectRoot, { schemaRoot });
  assert.deepEqual(result, { descriptors: 0, submissions: 0, apps: 0 });
});

test('approved target cannot carry Runtime-owned provenance revision', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nimi-registry-provenance-owner-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidateValue = candidate();
  candidateValue.targets[0].provenance_revision = candidateValue.release.commit_sha;
  const descriptorValue = descriptor(candidateValue, 'e'.repeat(40));
  writeJson(root, `descriptors/${candidateValue.app_id}/${candidateValue.version}.json`, descriptorValue);
  writeJson(root, 'index.json', indexFor(descriptorValue));
  await assert.rejects(
    validateRegistryTree(root, { schemaRoot }),
    /does not match its closed schema/u,
  );
});

test('Release asset locator cannot escape its exact tag or add path segments', async (t) => {
  for (const relativeAsset of [
    '../v9.9.9/evil.nimiapp',
    'nested/evil.nimiapp',
    '%2e%2e/v9.9.9/evil.nimiapp',
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nimi-registry-asset-locator-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const candidateValue = candidate();
    candidateValue.targets[0].asset_name = 'evil.nimiapp';
    candidateValue.targets[0].asset_url = `${candidateValue.source.repository}/releases/download/${candidateValue.release.tag}/${relativeAsset}`;
    const descriptorValue = descriptor(candidateValue, 'e'.repeat(40));
    writeJson(root, `descriptors/${candidateValue.app_id}/${candidateValue.version}.json`, descriptorValue);
    writeJson(root, 'index.json', indexFor(descriptorValue));
    await assert.rejects(
      validateRegistryTree(root, { schemaRoot }),
      /exact tagged GitHub Release|exact Release asset|non-canonical path/u,
    );
  }
});

test('publisher PR adds one submission from its own fork namespace', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const result = await validatePullRequestTransition({
    root,
    gitRoot: root,
    schemaRoot,
    baseSha,
    headSha: submission.publisherHeadSha,
    context: { headOwner: 'publisher' },
  });
  assert.deepEqual(result, { mode: 'publisher-submission', submissionPath: submission.submissionPath });
});

test('publisher PR cannot add approval or index truth', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  writeJson(root, 'index.json', { schema_version: 1, apps: {} });
  const headSha = commit(root, 'publisher tries index mutation');
  await assert.rejects(
    validatePullRequestTransition({ root, gitRoot: root, schemaRoot, baseSha, headSha, context: { headOwner: 'publisher' } }),
    RegistryValidationError,
  );
  assert.notEqual(headSha, submission.publisherHeadSha);
});

test('publisher submission schema has no review or approval field', async (t) => {
  const { root, baseSha } = repository(t);
  const candidateValue = candidate();
  const submissionPath = `submissions/publisher/${candidateValue.app_id}/${candidateValue.version}.json`;
  writeJson(root, submissionPath, {
    schema_version: 1,
    candidate: candidateValue,
    review: { decision: 'approved' },
  });
  const headSha = commit(root, 'publisher-authored approval');
  await assert.rejects(
    validatePullRequestTransition({ root, gitRoot: root, schemaRoot, baseSha, headSha, context: { headOwner: 'publisher' } }),
    /does not match its closed schema/u,
  );
});

test('claimed signer cannot be normalized to unsigned native posture', async (t) => {
  const { root, baseSha } = repository(t);
  const candidateValue = candidate();
  candidateValue.targets[0].native_trust.signing_subject = 'publisher';
  candidateValue.targets[0].native_trust.observed_subject = 'CN=Unexpected Signer';
  const submission = addPublisherSubmission(root, candidateValue);
  await assert.rejects(
    validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot,
      baseSha,
      headSha: submission.publisherHeadSha,
      context: { headOwner: 'publisher' },
    }),
    /does not match its closed schema/u,
  );
});

test('maintainer finalization is one exact parent-bound descriptor and index transition', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const finalization = addFinalization(root, submission);
  const result = await validatePullRequestTransition({
    root,
    gitRoot: root,
    schemaRoot,
    baseSha,
    headSha: finalization.headSha,
    context: {
      pullNumber: 42,
      actorLogin: 'registry-maintainer',
      actorId: 9876,
      finalizerPermission: 'maintain',
      candidateCheckPassed: true,
    },
  });
  assert.equal(result.mode, 'maintainer-finalization');
  assert.equal(result.publisherHeadSha, submission.publisherHeadSha);
  assert.equal(result.descriptorPath, finalization.descriptorPath);
});

test('publisher finalizer without maintainer permission fails closed', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const finalization = addFinalization(root, submission);
  await assert.rejects(
    validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot,
      baseSha,
      headSha: finalization.headSha,
      context: {
        pullNumber: 42,
        actorLogin: 'publisher',
        actorId: 111,
        finalizerPermission: 'write',
        candidateCheckPassed: true,
      },
    }),
    /not a current Registry maintainer/u,
  );
});

test('a current Registry maintainer may finalize its own publisher PR', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const descriptorValue = descriptor(submission.candidateValue, submission.publisherHeadSha);
  descriptorValue.admission.review.adjudicator_login = 'publisher';
  descriptorValue.admission.review.adjudicator_actor_id = 111;
  const descriptorPath = `descriptors/${submission.candidateValue.app_id}/${submission.candidateValue.version}.json`;
  rmSync(path.join(root, ...submission.submissionPath.split('/')));
  writeJson(root, descriptorPath, descriptorValue);
  writeJson(root, 'index.json', indexFor(descriptorValue));
  const headSha = commit(root, 'publisher self-approval');
  const result = await validatePullRequestTransition({
    root,
    gitRoot: root,
    schemaRoot,
    baseSha,
    headSha,
    context: {
      pullNumber: 42,
      actorLogin: 'publisher',
      actorId: 111,
      finalizerPermission: 'admin',
      candidateCheckPassed: true,
    },
  });
  assert.equal(result.mode, 'maintainer-finalization');
  assert.equal(result.publisherHeadSha, submission.publisherHeadSha);
});

test('maintainer finalization remains bound to the exact GitHub event actor', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const finalization = addFinalization(root, submission);
  await assert.rejects(
    validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot,
      baseSha,
      headSha: finalization.headSha,
      context: {
        pullNumber: 42,
        actorLogin: 'different-maintainer',
        actorId: 1234,
        finalizerPermission: 'maintain',
        candidateCheckPassed: true,
      },
    }),
    /adjudicator_login does not match the GitHub event actor/u,
  );
});

test('an existing approved descriptor cannot be modified in a later PR', async (t) => {
  const { root, baseSha } = repository(t);
  const submission = addPublisherSubmission(root);
  const finalization = addFinalization(root, submission);
  const mutated = structuredClone(finalization.descriptorValue);
  mutated.candidate.display_name = 'Changed App';
  writeJson(root, finalization.descriptorPath, mutated);
  const mutatedHead = commit(root, 'mutate approved descriptor');
  await assert.rejects(
    validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot,
      baseSha: finalization.headSha,
      headSha: mutatedHead,
      context: { headOwner: 'publisher' },
    }),
    /must add exactly one approved descriptor/u,
  );
  assert.notEqual(baseSha, finalization.headSha);
});
