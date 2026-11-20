import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidators, validatePullRequestTransition } from '../scripts/registry-validation.mjs';
import { readProducts, projectSources, projectionPath } from '../scripts/hosted-products.mjs';

const schemaRoot = fileURLToPath(new URL('../schema/', import.meta.url));
const context = { finalizerPermission: 'maintain', actorLogin: 'reviewer', actorId: 12 };
const review = {
  decision: 'approved',
  adjudicator_login: 'reviewer',
  adjudicator_actor_id: 12,
  reason_code: 'verified-web',
  decided_at: '2026-11-19T10:00:00Z',
};
test('the same PR can admit a typed hosted source and its first version; later releases, rollback and suspension stay distinct', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nimi-hosted-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const write = async (file, v) => {
    const out = path.join(root, file);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(v));
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'candidate');
    return git('rev-parse', 'HEAD');
  };
  const check = (baseSha, headSha, extra = {}) =>
    validatePullRequestTransition({
      root,
      gitRoot: root,
      schemaRoot,
      baseSha,
      headSha,
      context: { ...context, ...extra },
    });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await write('index.json', { schema_version: 1, apps: {} });
  const initial = commit();
  const product = {
    app_id: '3d.studio',
    slug: 'studio',
    display_name: 'Studio',
    publisher: 'publisher',
    owner_id: 1,
    repository_id: 5,
    repository: 'https://github.com/publisher/studio',
    summary: { en: 'Editor', zh: '编辑器' },
    visibility: 'public',
    license: 'MIT',
    kill_switch: { active: false, reason: null, revision: 0 },
  };
  const id = 'publisher.studio.web',
    stem = 'products/3d.studio/';
  let source = {
    client_id: id,
    kind: 'hosted-web',
    source_revision: 1,
    status: 'active',
    app_access: ['runtime.consume'],
    capability_contract_refs: ['text.generate'],
    stable_version: '1.0.0',
    review,
  };
  const release = (v) => ({
    app_id: product.app_id,
    client_id: id,
    version: v,
    source_revision: 1,
    commit_sha: 'b'.repeat(40),
    release_id: 10,
    asset_id: 20,
    size: 5000,
    sha256: 'a'.repeat(64),
    app_access: source.app_access,
    capability_contract_refs: source.capability_contract_refs,
    review,
  });
  const validators = await loadValidators(schemaRoot);
  const project = async () => {
    const data = await readProducts(root, validators);
    await projectSources(root, data.projections, true);
    return data;
  };
  await write(stem + 'product.json', product);
  await write(stem + 'sources/' + id + '.json', source);
  await assert.rejects(project(), /Incompatible approved Web target/);
  await write(stem + 'web/releases/1.0.0.json', release('1.0.0'));
  await project();
  const first = commit();
  assert.equal((await check(initial, first)).releases.length, 1);
  await assert.rejects(check(initial, first, { actorId: 17 }), /reviewer|maintainer/);
  await assert.rejects(check(initial, first, { finalizerPermission: 'write' }), /maintainer/);
  source = { ...source, stable_version: '1.0.1' };
  await write(stem + 'sources/' + id + '.json', source);
  await write(stem + 'web/releases/1.0.1.json', release('1.0.1'));
  await project();
  const second = commit();
  assert.equal((await check(first, second)).releases.length, 1);
  source = { ...source, stable_version: '1.0.0' };
  await write(stem + 'sources/' + id + '.json', source);
  const rollback = commit();
  assert.equal((await check(second, rollback)).releases.length, 0);
  product.kill_switch = {
    active: true,
    revision: 1,
    reason: 'Block version 1.0.1: declared and actual content differ.',
  };
  await write(stem + 'product.json', product);
  const data = await project();
  assert.equal(data.projections.get(projectionPath('clients', id)).source.status, 'paused');
  const paused = commit();
  assert.equal((await check(rollback, paused)).mode, 'hosted-review');
  await write(stem + 'web/releases/1.0.0.json', { ...release('1.0.0'), size: 6000 });
  await assert.rejects(check(paused, commit()), /immutable/);
  await write(stem + 'product.json', { ...product, slug: 'different' });
  await project();
  await assert.rejects(check(paused, commit()), /reassigned/);
});
