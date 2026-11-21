import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import {
  inspectStaticStorefrontImage,
  STOREFRONT_COVER_BOUNDS,
  validateAppInfoStorefront,
  validateStorefrontMediaArchiveEntries,
} from '../scripts/storefront-media-validation.mjs';
import { validateHostedTransition } from '../scripts/hosted-review.mjs';
import { loadValidators, validatePullRequestTransition } from '../scripts/registry-validation.mjs';
import { classifyChangedPaths, validatePullRequestCli } from '../scripts/validate-registry.mjs';

function makePng(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 20;
    png.data[i + 1] = 160;
    png.data[i + 2] = 180;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function makeVp8LWebp(width, height) {
  const payload = Buffer.alloc(6);
  payload[0] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(bits >>> 0, 1);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8L', 0, 'ascii');
  chunkHeader.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, payload]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test('storefront validation verifies bijection between media manifest and archive entries', () => {
  const coverBytes = makeVp8LWebp(1280, 720);
  const shotBytes = makePng(1280, 720);
  const coverRef = inspectStaticStorefrontImage(coverBytes, STOREFRONT_COVER_BOUNDS, 'cover');
  const shotRef = inspectStaticStorefrontImage(shotBytes, STOREFRONT_COVER_BOUNDS, 'shot');

  const storefront = {
    category: 'companions-worlds',
    default_locale: 'zh',
    locales: {
      zh: { tags: ['节律'], highlights: [{ title: '排盘', description: '确定性计算。' }] },
      en: { display_name: 'ShiJing', summary: 'Personal rhythm.', introduction_markdown: '# ShiJing' },
    },
    media: {
      cover: { default: coverRef },
      gallery: [{ id: 'day-lens', kind: 'image', default: shotRef, caption: { zh: '日镜', en: 'Day Lens' } }],
    },
  };
  validateAppInfoStorefront(storefront);

  const entries = new Map([
    [`${coverRef.sha256}.webp`, { bytes: coverBytes, mode: 0o644 }],
    [`${shotRef.sha256}.png`, { bytes: shotBytes, mode: 0o644 }],
  ]);
  assert.equal(validateStorefrontMediaArchiveEntries(entries, storefront.media), 2);

  entries.set(`${createHash('sha256').update('extra').digest('hex')}.png`, { bytes: shotBytes, mode: 0o644 });
  assert.throws(() => validateStorefrontMediaArchiveEntries(entries, storefront.media), /file count/);
});

test('product and index schemas require origin and enforce origin and upstream pairing', async () => {
  const validators = await loadValidators();
  const baseProduct = {
    app_id: 'nimi.shijing',
    slug: 'shijing',
    display_name: '时镜',
    publisher: 'nimiplatform',
    repository: 'https://github.com/nimiplatform/nimiapp-shijing',
    owner_id: 1,
    repository_id: 2,
    license: 'MIT',
    summary: { en: 'Rhythm', zh: '节律' },
    visibility: 'public',
    kill_switch: { active: false, reason: null, revision: 0 },
  };
  assert.equal(validators.product(baseProduct), false);
  assert.equal(validators.product({ ...baseProduct, origin: 'nimi-official' }), true);
  assert.equal(validators.product({ ...baseProduct, origin: 'open-source-adapted' }), false);
  assert.equal(
    validators.product({
      ...baseProduct,
      origin: 'open-source-adapted',
      upstream: { name: 'Upstream', url: 'https://github.com/org/repo' },
    }),
    true,
  );
  assert.equal(
    validators.product({
      ...baseProduct,
      origin: 'nimi-official',
      upstream: { name: 'Upstream', url: 'https://github.com/org/repo' },
    }),
    false,
  );
});

test('hosted review supports controlled multi-product origin projection and blocks native product summary edits', () => {
  const prodBase = {
    app_id: 'nimi.shijing',
    slug: 'shijing',
    display_name: '时镜',
    publisher: 'nimiplatform',
    repository: 'https://github.com/nimiplatform/nimiapp-shijing',
    owner_id: 1,
    repository_id: 2,
    license: 'MIT',
    summary: { en: 'Rhythm', zh: '节律' },
    visibility: 'public',
    kill_switch: { active: false, reason: null, revision: 0 },
  };
  const prodNext = { ...prodBase, origin: 'nimi-official' };
  const idxBase = {
    schema_version: 1,
    apps: {
      'nimi.shijing': {
        display_name: '时镜',
        visibility: 'public',
        admission_status: 'approved',
        kill_switch: { active: false, reason: null, revision: 0 },
        latest_admitted_release_by_target: {
          'windows-x86_64': { descriptor_id: 'nimi.shijing@0.1.10', path: 'descriptors/nimi.shijing/0.1.10.json' },
        },
      },
    },
  };
  const idxNext = structuredClone(idxBase);
  idxNext.apps['nimi.shijing'].origin = 'nimi-official';
  const context = { finalizerPermission: 'maintain', actorLogin: 'alice', actorId: 7 };
  const state = { products: new Map([['nimi.shijing', { product: prodNext, sources: new Map(), releases: new Map() }]]) };

  const result = validateHostedTransition(
    [{ status: 'M', path: 'products/nimi.shijing/product.json' }, { status: 'M', path: 'index.json' }],
    state,
    context,
    (name) => (name === 'index.json' ? structuredClone(idxBase) : structuredClone(prodBase)),
    (name) => (name === 'index.json' ? structuredClone(idxNext) : structuredClone(prodNext)),
  );
  assert.equal(result.mode, 'attribution-projection');
  assert.deepEqual(result.attributed, ['nimi.shijing']);

  // Independent summary edit on a product with an admitted native release must fail closed.
  const summaryEdited = { ...prodBase, summary: { en: 'Tampered', zh: '篡改' } };
  const badState = { products: new Map([['nimi.shijing', { product: summaryEdited, sources: new Map(), releases: new Map() }]]) };
  assert.throws(
    () => validateHostedTransition(
      [{ status: 'M', path: 'products/nimi.shijing/product.json' }],
      badState,
      context,
      (name) => (name === 'index.json' ? structuredClone(idxBase) : structuredClone(prodBase)),
      (name) => (name === 'index.json' ? structuredClone(idxBase) : structuredClone(summaryEdited)),
    ),
    /cannot edit product\.json summary independently/,
  );
});

test('validatePullRequestCli dispatches attribution-projection without reading a candidate or hitting GitHub Releases', async (t) => {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'nimi-reg-attr-cli-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  const schemaSrc = path.resolve(import.meta.dirname, '..', 'schema');
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const writeJson = async (rel, data) => {
    const file = path.join(repoDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  };

  git('init', '-qb', 'main');
  git('config', 'user.name', 'Maintainer');
  git('config', 'user.email', 'maintainer@nimi.ai');
  await cp(schemaSrc, path.join(repoDir, 'schema'), { recursive: true });

  const prodBase = {
    app_id: 'nimi.shijing',
    slug: 'shijing',
    display_name: '时镜',
    publisher: 'nimiplatform',
    repository: 'https://github.com/nimiplatform/nimiapp-shijing',
    owner_id: 1,
    repository_id: 2,
    license: 'MIT',
    summary: { en: 'Rhythm', zh: '节律' },
    visibility: 'public',
    origin: 'community',
    kill_switch: { active: false, reason: null, revision: 0 },
  };
  await writeJson('products/nimi.shijing/product.json', prodBase);
  await writeJson('index.json', {
    schema_version: 1,
    apps: {},
  });
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');

  await writeJson('products/nimi.shijing/product.json', { ...prodBase, origin: 'nimi-official' });
  git('add', '.');
  git('commit', '-qm', 'backfill origin');
  const headSha = git('rev-parse', 'HEAD');

  assert.equal(classifyChangedPaths(['products/nimi.shijing/product.json', 'index.json']), 'hosted-review');

  const cliResult = await validatePullRequestCli(
    { root: repoDir, gitRoot: repoDir, schemaRoot: path.join(repoDir, 'schema'), base: baseSha, head: headSha },
    {
      pullRequestContext: async () => ({
        pullNumber: 1,
        headOwner: 'nimiplatform',
        actorLogin: 'alice',
        actorId: 7,
        finalizerPermission: 'maintain',
        candidateCheckPassed: false,
        token: '',
      }),
      validatePullRequestTransition,
      validatePublishedGitHubCandidate: async () => {
        throw new Error('attribution-projection must never fetch a publisher Release candidate');
      },
    },
  );
  assert.equal(cliResult.ok, true);
  assert.equal(cliResult.mode, 'attribution-projection');
  assert.equal(cliResult.external, null);
  assert.deepEqual(cliResult.transition.attributed, ['nimi.shijing']);
});

test('storefront validation admits lifestyle category and enforces shared static image vectors', () => {
  const coverBytes = makeVp8LWebp(1280, 720);
  const coverRef = inspectStaticStorefrontImage(coverBytes, STOREFRONT_COVER_BOUNDS, 'cover');
  validateAppInfoStorefront({
    category: 'lifestyle',
    default_locale: 'zh',
    media: { cover: { default: coverRef } },
  });

  // Animated WebP (VP8X with animation flag 0x02) must be rejected.
  const vp8xPayload = Buffer.alloc(10);
  vp8xPayload[0] = 0x02;
  vp8xPayload[4] = (1280 - 1) & 0xff;
  vp8xPayload[5] = ((1280 - 1) >> 8) & 0xff;
  vp8xPayload[7] = (720 - 1) & 0xff;
  vp8xPayload[8] = ((720 - 1) >> 8) & 0xff;
  const vp8xHeader = Buffer.alloc(8);
  vp8xHeader.write('VP8X', 0, 'ascii');
  vp8xHeader.writeUInt32LE(10, 4);
  const animBody = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8xHeader, vp8xPayload]);
  const animRiff = Buffer.alloc(8);
  animRiff.write('RIFF', 0, 'ascii');
  animRiff.writeUInt32LE(animBody.length, 4);
  assert.throws(
    () => inspectStaticStorefrontImage(Buffer.concat([animRiff, animBody]), STOREFRONT_COVER_BOUNDS, 'anim-webp'),
    /animated WebP/i,
  );

  // Oversized image (> 512 KiB) must be rejected.
  assert.throws(
    () => inspectStaticStorefrontImage(Buffer.alloc(512 * 1024 + 1, 0x41), STOREFRONT_COVER_BOUNDS, 'oversized'),
    /at most 524288 bytes/i,
  );
});
