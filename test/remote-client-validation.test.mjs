import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validatePullRequestTransition, validateRegistryTree } from '../scripts/registry-validation.mjs';
import { validateRemoteClientFacts, validateRemoteClientTransition } from '../scripts/remote-client-validation.mjs';
import { classifyChangedPaths } from '../scripts/validate-registry.mjs';

const schemaRoot = fileURLToPath(new URL('../schema/', import.meta.url));
const context = { finalizerPermission: 'maintain', actorLogin: 'reviewer', actorId: 42 };
const empty = () => ({ schema_version: 1, clients: {} });
const registration = () => ({
  app_id: 'publisher.editor', display_name: 'Editor', publisher: 'publisher',
  kind: 'web', origin: 'https://editor.example', redirect_uri: 'https://editor.example/nimi/callback',
  source_revision: 1, role: 'app', app_access: ['runtime.consume'],
  capability_contract_refs: ['text.generate'], status: 'active',
  review: { decision: 'approved', adjudicator_login: 'reviewer', adjudicator_actor_id: 42,
    reason_code: 'reviewed-source', decided_at: '2026-11-07T00:00:00Z' },
});
function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nimi-remote-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = value => writeFileSync(path.join(root, 'remote-clients.json'), JSON.stringify(value));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schema_version: 1, apps: {} }));
  write(empty());
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const commit = () => { git('add', '.'); git('-c', 'core.hooksPath=', 'commit', '-qm', 'test'); return git('rev-parse', 'HEAD'); };
  return { root, write, commit };
}

test('remote admission uses the same Registry review actor and cannot be smuggled into another transition', async t => {
  const { root, write, commit } = setup(t);
  const baseSha = commit();
  write({ schema_version: 1, clients: { 'publisher.editor.web': registration() } });
  const headSha = commit();
  const options = { root, gitRoot: root, schemaRoot, baseSha, headSha, context };
  assert.deepEqual(await validatePullRequestTransition(options), { mode: 'remote-client-review', clients: ['publisher.editor.web'] });
  await assert.rejects(validatePullRequestTransition({ ...options, context: { ...context, finalizerPermission: 'write' } }), /maintainer/);
  await assert.rejects(validatePullRequestTransition({ ...options, context: { ...context, actorId: 99 } }), /actual maintainer/);
  writeFileSync(path.join(root, 'unrelated.txt'), 'cannot mix');
  await assert.rejects(validatePullRequestTransition({ ...options, headSha: commit() }), /remote source registration review/);
  assert.equal(classifyChangedPaths(['remote-clients.json']), 'remote-client-review');
});

test('exact website origin, callback and App access declaration are validated by the tree reader', async t => {
  const { root, write } = setup(t);
  const valid = { schema_version: 1, clients: { 'publisher.editor.web': registration() } };
  write(valid); await validateRegistryTree(root, { schemaRoot });
  valid.clients['publisher.editor.web'].app_access.push('future.domain');
  write(valid); await validateRegistryTree(root, { schemaRoot }); // Runtime owns activation of supported domains.
  for (const patch of [
    { origin: 'https://editor.example/' }, { origin: 'http://editor.example' },
    { redirect_uri: 'https://other.example/nimi/callback' },
    { redirect_uri: 'https://user:pass@editor.example/nimi/callback' },
    { redirect_uri: 'https://editor.example/nimi/callback?next=other' },
    { redirect_uri: 'https://editor.example/nimi/callback#token' },
    { kind: 'native' }, { arbitrary_permission: true },
  ]) {
    write({ schema_version: 1, clients: { 'publisher.editor.web': { ...registration(), ...patch } } });
    await assert.rejects(validateRegistryTree(root, { schemaRoot }));
  }
});

test('source changes require a new revision while pause, resume and display changes preserve it', () => {
  const before = { schema_version: 1, clients: { 'publisher.editor.web': registration() } };
  for (const status of ['paused', 'active']) {
    const after = structuredClone(before); after.clients['publisher.editor.web'].status = status;
    after.clients['publisher.editor.web'].display_name = 'Editor renamed';
    assert.deepEqual(validateRemoteClientTransition(before, after, context), ['publisher.editor.web']);
  }
  const changed = structuredClone(before);
  changed.clients['publisher.editor.web'].app_access.push('integration.consume');
  assert.throws(() => validateRemoteClientTransition(before, changed, context), /revision must be 2/);
  changed.clients['publisher.editor.web'].source_revision = 2;
  assert.equal(validateRemoteClientTransition(before, changed, context).length, 1);
  changed.clients['publisher.editor.web'].app_id = 'publisher.another';
  assert.throws(() => validateRemoteClientTransition(before, changed, context), /reassigned/);
  assert.throws(() => validateRemoteClientTransition(before, empty(), context), /pause/);
});


test('Android App Link metadata requires the signed package and advances the existing source revision', async t => {
  const { root, write } = setup(t);
  const android = { ...registration(), kind: 'android-app-link', android: {
    package_name: 'ai.nimi.editor', certificate_sha256: Array(32).fill('A1').join(':'),
  } };
  const before = { schema_version: 1, clients: { 'publisher.editor.android': android } };
  write(before); await validateRegistryTree(root, { schemaRoot });
  for (const patch of [
    { android: undefined }, { android: { ...android.android, package_name: 'invalid' } },
    { android: { ...android.android, certificate_sha256: 'not-a-certificate' } },
    { kind: 'web' }, { redirect_uri: 'nimi-editor://callback' },
  ]) {
    write({ schema_version: 1, clients: { 'publisher.editor.android': { ...android, ...patch } } });
    await assert.rejects(validateRegistryTree(root, { schemaRoot }));
  }
  const next = structuredClone(before);
  next.clients['publisher.editor.android'].android.certificate_sha256 = Array(32).fill('B2').join(':');
  assert.throws(() => validateRemoteClientTransition(before, next, context), /revision must be 2/);
  next.clients['publisher.editor.android'].source_revision = 2;
  assert.deepEqual(validateRemoteClientTransition(before, next, context), ['publisher.editor.android']);
});

test('development private-use sources are accepted only for local use', async t => {
  const { root, write, commit } = setup(t);
  const baseSha = commit();
  const dev = { ...registration(), kind: 'android-dev-scheme', origin: 'ai.nimi.editor.dev:/', redirect_uri: 'ai.nimi.editor.dev:/oauth/callback',
    android: { package_name: 'ai.nimi.editor.dev', certificate_sha256: Array(32).fill('A1').join(':') } };
  const document = { schema_version: 1, clients: { 'publisher.editor.android.dev': dev } };
  validateRemoteClientFacts(document, { localDevelopment: true });
  write(document);
  const headSha = commit();
  await assert.rejects(validateRegistryTree(root, { schemaRoot }), /forbidden in the public Registry/u);
  await assert.rejects(validatePullRequestTransition({ root, gitRoot: root, schemaRoot, baseSha, headSha, context }), /forbidden in the public Registry/u);
  for (const patch of [{ role: 'official_manager' }, { origin: 'ai.nimi.other:/' },
    { redirect_uri: 'ai.nimi.other:/oauth/callback' }, { redirect_uri: 'ai.nimi.editor.dev://host/oauth/callback' },
    { redirect_uri: 'ai.nimi.editor.dev:/oauth/callback?any=true' }, { redirect_uri: 'ai.nimi.editor.dev:/oauth/callback?' }, { redirect_uri: 'ai.nimi.editor.dev:/oauth/callback#' }, { origin: 'myapp:/', redirect_uri: 'myapp:/callback' }]) {
    assert.throws(() => validateRemoteClientFacts({ ...document, clients: { 'publisher.editor.android.dev': { ...dev, ...patch } } }, { localDevelopment: true }));
  }
});
