import { isDeepStrictEqual } from 'node:util';
import {
  requestJson,
  downloadExact,
  readNimiAppArchive,
  releaseAsset,
  verifyBuildProvenance,
  verifyTagRules,
} from './github-candidate-validation.mjs';

export function verifyHostedBundle(bytes, product, source, release) {
  const entries = readNimiAppArchive(bytes, 'hosted Web release');
  for (const [name, entry] of entries) {
    if (
      entry.mode !== 0o644 ||
      /[\u0000-\u001f\u007f?#]/u.test(name) ||
      /^(?:_headers|_redirects|_routes\.json|_worker\.js|wrangler\.[^/]+|functions|api|\.well-known)(?:\/|$)/iu.test(
        name,
      )
    )
      throw new Error('Invalid hosted static file: ' + name);
    const prefix = '_releases/' + release.version + '/';
    if ((name.startsWith('_releases/') || /\.(?:[cm]?js|css|wasm)$/iu.test(name)) && !name.startsWith(prefix))
      throw new Error('Executable assets must belong to the reviewed release: ' + name);
  }
  const info = entries.get('nimi-web-bundle.json')?.bytes;
  const html = entries.get('index.html')?.bytes.toString('utf8');
  if (!info || info.length > 128 * 1024 || !html) throw new Error('Missing Web manifest or HTML entry');
  const expected = {
    format: 'nimi.web-bundle/v1',
    app_id: product.app_id,
    slug: product.slug,
    version: release.version,
    client_id: release.client_id,
    origin: source.origin,
    redirect_uri: source.redirect_uri,
    official_web_url: 'https://nimi.ai',
    realm_environment_id: 'production',
    entry: 'index.html',
    app_access: release.app_access,
    capability_contract_refs: release.capability_contract_refs,
  };
  if (!isDeepStrictEqual(JSON.parse(info), expected))
    throw new Error('Static bundle declaration differs from reviewed candidate');
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu)) {
    if (!match[1].startsWith('/_releases/' + release.version + '/') || !entries.has(match[1].slice(1)))
      throw new Error('Invalid HTML script entry: ' + match[1]);
  }
  return entries;
}

export async function verifyRepository(product, token) {
  const parts = new URL(product.repository).pathname.slice(1);
  const repo = await requestJson('https://api.github.com/repos/' + parts, token, 'hosted Web repository');
  if (
    repo.private !== false ||
    repo.id !== product.repository_id ||
    repo.owner?.id !== product.owner_id ||
    repo.owner.login.toLowerCase() !== product.publisher.toLowerCase() ||
    repo.full_name.toLowerCase() !== parts.toLowerCase()
  )
    throw new Error('Web publisher repository identity mismatch');
  return repo.full_name;
}

export async function verifyHostedReview(review, token) {
  for (const product of review.owners) await verifyRepository(product, token);
  for (const { product, source, release } of review.releases) {
    const repo = await verifyRepository(product, token);
    const [owner, name] = repo.split('/');
    const api = 'https://api.github.com/repos/' + repo;
    const tag = 'web-v' + release.version;
    await verifyTagRules(owner, name, tag, token);
    const tagged = await requestJson(api + '/commits/' + encodeURIComponent(tag), token, 'Web tag commit');
    const record = await requestJson(api + '/releases/tags/' + encodeURIComponent(tag), token, 'Web release');
    if (
      tagged.sha !== release.commit_sha ||
      record.tag_name !== tag ||
      record.id !== release.release_id ||
      record.draft !== false ||
      record.immutable !== true ||
      record.prerelease !== false
    )
      throw new Error('Incorrect or mutable hosted Web release');
    const assetName = 'nimi-web-' + release.version + '.zip';
    const url = product.repository + '/releases/download/' + tag + '/' + assetName;
    releaseAsset(record, { ...release, asset_name: assetName, asset_url: url }, 'Web bundle');
    const bytes = await downloadExact(url, release.size, release.sha256, 'Web bundle');
    verifyHostedBundle(bytes, product, source, release);
    const proofs = await requestJson(
      api + '/attestations/sha256:' + release.sha256,
      token,
      'Web build provenance',
    );
    await verifyBuildProvenance(
      bytes,
      { source: { repository: product.repository }, release: { tag, commit_sha: release.commit_sha } },
      { target_id: 'web' },
      proofs,
      token,
      'nimi-web-release.yml',
    );
  }
}
