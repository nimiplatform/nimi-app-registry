import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';
import path from 'node:path';
import { loadValidators, readOptionalJsonAt } from './registry-validation.mjs';
import { admittedClient } from './hosted-products.mjs';
import { validateRemoteClientFacts, expectedSourceRevision } from './remote-client-validation.mjs';

const { values } = parseArgs({ options: {
  product: { type: 'string' }, candidate: { type: 'string' }, review: { type: 'string' }, base: { type: 'string' },
} });
if (!values.product || !values.candidate || !values.review)
  throw Error('Pass --product, --candidate and an explicit maintainer --review JSON file.');
if (values.base !== undefined && !/^[0-9a-f]{40}$/.test(values.base))
  throw Error('Pass the full Registry PR base commit SHA to --base.');

const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const optional = async (file) => read(file).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const product = await read(values.product), candidate = await read(values.candidate), decision = await read(values.review);
if (decision.decision !== 'approved' || Object.hasOwn(candidate.source, 'review') || Object.hasOwn(candidate.release, 'review'))
  throw Error('Expected a publisher candidate and separate explicit maintainer decision.');
const checks = await loadValidators();
if (!checks.product(product)) throw Error('Invalid product record');
const directory = 'products/' + product.app_id;
if (path.resolve(values.product) !== path.resolve(directory, 'product.json'))
  throw Error('Use the product in this Registry checkout.');

const release = { ...candidate.release, review: decision };
if (!checks.webRelease(release) || release.app_id !== product.app_id || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(release.client_id))
  throw Error('Invalid release or maintainer review: ' + JSON.stringify(checks.webRelease.errors));
const source = { ...candidate.source, review: decision };
if (source.kind !== 'hosted-web' || source.client_id !== release.client_id || source.stable_version !== release.version ||
    source.source_revision !== release.source_revision || !equal(source.app_access, release.app_access) ||
    !equal(source.capability_contract_refs, release.capability_contract_refs))
  throw Error('Candidate source and release do not agree.');

const target = directory + '/web/releases/' + release.version + '.json';
const sourceFile = directory + '/sources/' + release.client_id + '.json';
const currentRelease = await optional(target), currentSource = await optional(sourceFile);
const baseline = (file, current) => values.base ? readOptionalJsonAt(process.cwd(), values.base, file) : current;
const priorRelease = baseline(target, currentRelease), previous = baseline(sourceFile, currentSource);
if (priorRelease && !equal(priorRelease, release))
  throw Error('This version already has different content or review.');
if (previous && previous.source_revision === source.source_revision && previous.status === source.status)
  source.review = previous.review;
const effective = admittedClient(product, source);
if (!checks.remote(effective)) throw Error('Invalid hosted Web source');
validateRemoteClientFacts({ schema_version: 1, clients: { [release.client_id]: effective } });
if (source.source_revision !== expectedSourceRevision(previous && admittedClient(product, previous), effective))
  throw Error('Incorrect source revision.');

if (values.base) {
  // The publisher head may contain the draft, or the exact final result on a retry.
  if ((!equal(currentRelease, candidate.release) && !equal(currentRelease, release)) ||
      (!equal(currentSource, candidate.source) && !equal(currentSource, source)))
    throw Error('The PR files differ from the reviewed candidate. Check the publisher head and PR base.');
}
async function save(file, record, current) {
  if (equal(current, record)) return;
  await mkdir(path.dirname(file), { recursive: true });
  const data = JSON.stringify(record, null, 2) + '\n';
  if (current === null) return writeFile(file, data, { flag: 'wx' });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, data, { flag: 'wx' });
  await rename(tmp, file);
}
await save(target, release, currentRelease);
await save(sourceFile, source, currentSource);
console.log('Run pnpm run project:sources and pnpm check, then commit and push the finalization to this PR. GitHub validates the actual actor.');
