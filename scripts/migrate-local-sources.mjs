import { readFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadValidators } from './registry-validation.mjs';
import { projectionPath, projectSources } from './hosted-products.mjs';
import { validateRemoteClientFacts } from './remote-client-validation.mjs';

const [from, to] = process.argv.slice(2);
if (!from || !to || process.argv.length !== 4)
  throw Error('Pass the existing local remote-clients.json and a new empty local checkout directory.');
const target = path.resolve(to);
await mkdir(target, { recursive: true });
if ((await readdir(target)).length) throw Error('Local migration requires an empty output directory.');
const legacy = JSON.parse(await readFile(from, 'utf8')),
  validators = await loadValidators();
if (
  legacy.schema_version !== 1 ||
  !legacy.clients ||
  Array.isArray(legacy.clients) ||
  typeof legacy.clients !== 'object'
)
  throw Error('Expected reviewed local sources.');
validateRemoteClientFacts(legacy, { localDevelopment: true });
const projections = new Map(),
  origins = new Map();
for (const [id, source] of Object.entries(legacy.clients)) {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(id) || id.length > 120 || !validators.remote(source))
    throw Error('Invalid local source: ' + id);
  projections.set(projectionPath('clients', id), { client_id: id, source });
  if (source.kind === 'web') {
    const previous = origins.get(source.origin);
    if (previous && previous.appId !== source.app_id)
      throw Error('Different products share a local Web origin');
    origins.set(source.origin, {
      appId: source.app_id,
      active: source.status === 'active' || Boolean(previous?.active),
    });
  }
}
for (const [origin, { active }] of origins)
  projections.set(projectionPath('origins', origin), { origin, active });
await projectSources(target, projections, true);
console.log(
  'Migrated ' +
    Object.keys(legacy.clients).length +
    ' local sources. Set RUNTIME_CLIENT_REGISTRY_PATH to ' +
    target,
);
