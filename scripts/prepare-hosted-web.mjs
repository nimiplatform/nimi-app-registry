import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requestJson, downloadExact, readNimiAppArchive } from './github-candidate-validation.mjs';
import { verifyRepository, verifyHostedBundle } from './hosted-release-verification.mjs';

const { values } = parseArgs({ options: { product: { type: 'string' }, version: { type: 'string' } } });
if (!values.product || !values.version || !/^[A-Za-z0-9.+-]+$/u.test(values.version))
  throw Error('Use --product product.json --version <Web version>');
const filename = path.resolve(values.product);
const product = JSON.parse(await readFile(filename, 'utf8'));
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
const repository = await verifyRepository(product, token);
const api = 'https://api.github.com/repos/' + repository;
const tag = 'web-v' + values.version;
const record = await requestJson(api + '/releases/tags/' + encodeURIComponent(tag), token, 'Web release');
if (record.draft || !record.immutable || record.prerelease || record.tag_name !== tag)
  throw Error('Expected an immutable public Web release.');
const name = 'nimi-web-' + values.version + '.zip';
const asset = record.assets.find((a) => a.name === name);
const url = product.repository + '/releases/download/' + tag + '/' + name;
if (
  !asset ||
  asset.browser_download_url !== url ||
  !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
  asset.size > 268435456
)
  throw Error('Web release asset mismatch.');
const bytes = await downloadExact(url, asset.size, asset.digest.slice(7), 'Web release');
const entries = readNimiAppArchive(bytes, 'Web bundle');
const info = JSON.parse(entries.get('nimi-web-bundle.json')?.bytes.toString('utf8') ?? 'null');
if (!info || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(info.client_id) || info.client_id.length > 120)
  throw Error('Invalid client in the Web bundle.');
const clientPath = path.join(path.dirname(filename), 'sources', info.client_id + '.json');
const previous = await readFile(clientPath, 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
if (previous && previous.kind !== 'hosted-web') throw Error('Client already belongs to another source.');
const declarationChanged =
  previous &&
  (JSON.stringify(previous.app_access) !== JSON.stringify(info.app_access) ||
    JSON.stringify(previous.capability_contract_refs) !== JSON.stringify(info.capability_contract_refs));
const source = {
  client_id: info.client_id,
  kind: 'hosted-web',
  source_revision: previous ? previous.source_revision + Number(declarationChanged) : 1,
  status: previous?.status ?? 'active',
  app_access: info.app_access,
  capability_contract_refs: info.capability_contract_refs,
  stable_version: values.version,
};
const commit = await requestJson(api + '/commits/' + encodeURIComponent(tag), token, 'Web source commit');
const release = {
  app_id: product.app_id,
  client_id: source.client_id,
  version: values.version,
  source_revision: source.source_revision,
  commit_sha: commit.sha,
  release_id: record.id,
  asset_id: asset.id,
  size: asset.size,
  sha256: asset.digest.slice(7),
  app_access: source.app_access,
  capability_contract_refs: source.capability_contract_refs,
};
const origin = 'https://' + product.slug + '.nimi.xyz';
verifyHostedBundle(bytes, product, { origin, redirect_uri: origin + '/' }, release);
console.log(JSON.stringify({ source, release }, null, 2));
