import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateRemoteClientFacts } from './remote-client-validation.mjs';

const reserved = new Set([
  'www',
  'api',
  'docs',
  'send',
  'avatar',
  'admin',
  'auth',
  'login',
  'account',
  'realm',
  'registry',
  'status',
]);
const productId = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const clientId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u;

export function projectionPath(kind, key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return 'projections/realm/' + kind + '/' + hash.slice(0, 2) + '/' + hash + '.json';
}

async function children(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Expected Registry directory: ' + directory);
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function jsonFile(directory, name) {
  const file = path.join(directory, name);
  const st = await lstat(file);
  if (!st.isFile() || st.size > 512 * 1024) throw new Error('Invalid product data file: ' + file);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function records(directory) {
  const result = new Map();
  for (const entry of await children(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json'))
      throw new Error('Unexpected product entry: ' + entry.name);
    result.set(entry.name.slice(0, -5), await jsonFile(directory, entry.name));
  }
  return result;
}

function validate(check, value, label) {
  if (!check(value)) throw new Error(label + ': ' + JSON.stringify(check.errors));
}

export function admittedClient(product, record) {
  const { client_id: id, stable_version: stable, ...fields } = record;
  let source = fields;
  if (fields.kind === 'hosted-web') {
    const allowed = ['kind', 'source_revision', 'app_access', 'capability_contract_refs', 'status', 'review'];
    if (
      !Object.hasOwn(record, 'stable_version') ||
      (stable !== null && typeof stable !== 'string') ||
      Object.keys(fields).some((key) => !allowed.includes(key))
    )
      throw new Error('Invalid hosted Web source: ' + id);
    const origin = 'https://' + product.slug + '.nimi.xyz';
    source = { ...fields, kind: 'web', role: 'app', origin, redirect_uri: origin + '/' };
  } else if (
    Object.hasOwn(record, 'stable_version') ||
    ['app_id', 'publisher', 'display_name'].some((key) => Object.hasOwn(fields, key))
  ) {
    throw new Error('Source must reference its product identity: ' + id);
  }
  return {
    ...source,
    app_id: product.app_id,
    display_name: product.display_name,
    publisher: product.publisher,
  };
}

// @nimi-authority: rule.nimi.platform.app-ecosystem.hosted-web-publication
export async function readProducts(root, validators, { localDevelopment = false } = {}) {
  const products = new Map(),
    clients = new Map(),
    projections = new Map(),
    origins = new Map(),
    slugs = new Set();
  for (const entry of await children(path.join(root, 'products'))) {
    if (!entry.isDirectory() || !productId.test(entry.name))
      throw new Error('Invalid product directory: ' + entry.name);
    const directory = path.join(root, 'products', entry.name);
    const members = await children(directory);
    if (
      members.some((e) =>
        e.name === 'product.json' ? !e.isFile() : !['sources', 'web'].includes(e.name) || !e.isDirectory(),
      )
    )
      throw new Error('Unexpected product file: ' + entry.name);
    if ((await children(path.join(directory, 'web'))).some((e) => e.name !== 'releases' || !e.isDirectory()))
      throw new Error('Invalid Web releases directory');
    const product = await jsonFile(directory, 'product.json');
    validate(validators.product, product, entry.name);
    if (product.app_id !== entry.name || slugs.has(product.slug) || reserved.has(product.slug))
      throw new Error('Invalid or occupied product slug: ' + product.slug);
    if (new URL(product.repository).pathname.split('/')[1].toLowerCase() !== product.publisher.toLowerCase())
      throw new Error('Repository publisher mismatch: ' + entry.name);
    slugs.add(product.slug);
    const sources = await records(path.join(directory, 'sources'));
    const releases = await records(path.join(directory, 'web/releases'));
    const hosted = [...sources.values()].filter((source) => source.kind === 'hosted-web');
    if (hosted.length > 1) throw new Error('Multiple production Web sources for ' + entry.name);
    for (const [version, release] of releases) {
      validate(validators.webRelease, release, entry.name + '/' + version);
      if (
        release.app_id !== entry.name ||
        release.version !== version ||
        release.client_id !== hosted[0]?.client_id
      )
        throw new Error('Web release identity mismatch: ' + version);
    }
    for (const [id, record] of sources) {
      if (!clientId.test(id) || id.length > 120 || id !== record.client_id || clients.has(id))
        throw new Error('Invalid or duplicate source: ' + id);
      const source = admittedClient(product, record);
      const single = { schema_version: 1, clients: { [id]: source } };
      validate(validators.remote, source, id);
      validateRemoteClientFacts(single, { localDevelopment });
      if (
        source.kind === 'web' &&
        new URL(source.origin).hostname.endsWith('.nimi.xyz') &&
        record.kind !== 'hosted-web'
      )
        throw new Error('Hosted namespace requires a hosted Web source.');
      if (record.kind === 'hosted-web') {
        const target = releases.get(record.stable_version);
        if (
          !target ||
          target.source_revision !== record.source_revision ||
          !isDeepStrictEqual(target.app_access, source.app_access) ||
          !isDeepStrictEqual(target.capability_contract_refs, source.capability_contract_refs)
        )
          throw new Error('Incompatible approved Web target: ' + id);
      }
      const effective = { ...source, status: product.kill_switch.active ? 'paused' : source.status };
      clients.set(id, { product, record, source });
      projections.set(projectionPath('clients', id), { client_id: id, source: effective });
      if (source.kind === 'web') {
        const previous = origins.get(source.origin);
        if (previous && previous.appId !== product.app_id)
          throw new Error('Web origin assigned to multiple products: ' + source.origin);
        origins.set(source.origin, {
          appId: product.app_id,
          active: effective.status === 'active' || Boolean(previous?.active),
        });
      }
    }
    products.set(entry.name, { product, sources, releases, hosted: hosted[0] });
  }
  for (const [origin, value] of origins)
    projections.set(projectionPath('origins', origin), { origin, active: value.active });
  return { products, clients, projections };
}

async function existingProjectionPaths(root, relative = 'projections/realm') {
  const result = [];
  for (const e of await children(path.join(root, relative))) {
    const next = relative + '/' + e.name;
    if (e.isDirectory()) result.push(...(await existingProjectionPaths(root, next)));
    else if (e.isFile()) result.push(next);
    else throw new Error('Invalid projection entry: ' + next);
  }
  return result;
}

export async function projectSources(root, expected, write = false) {
  const top = await lstat(path.join(root, 'projections')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (top && !top.isDirectory()) throw new Error('Expected a regular projections directory');
  const existing = await existingProjectionPaths(root);
  for (const [name, record] of expected) {
    const target = path.join(root, name);
    if (write) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(record, null, 2) + '\n');
    } else if (!isDeepStrictEqual(await jsonFile(root, name), record))
      throw new Error('Incorrect source projection: ' + name);
  }
  for (const name of existing) {
    if (expected.has(name)) continue;
    if (!write || !/^projections\/realm\/(clients|origins)\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/.test(name))
      throw new Error('Obsolete or unexpected projection: ' + name);
    await unlink(path.join(root, name));
  }
}
