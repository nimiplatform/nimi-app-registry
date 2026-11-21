import { isDeepStrictEqual as equal } from 'node:util';
import { admittedClient } from './hosted-products.mjs';
import { validateRemoteClientTransition } from './remote-client-validation.mjs';

const zeroPolicy = { active: false, revision: 0, reason: null };
const omit = (record, keys) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

// @nimi-authority: rule.nimi.platform.app-ecosystem.hosted-web-publication
export function validateHostedTransition(changes, state, context, before, after) {
  if (
    !['admin', 'maintain'].includes(context.finalizerPermission) ||
    !context.actorLogin ||
    !Number.isSafeInteger(context.actorId) ||
    /\[bot\]$/i.test(context.actorLogin)
  ) {
    throw new Error('Hosted admission requires a current human Registry maintainer.');
  }
  const releases = [],
    owners = [],
    policies = new Set(),
    attributions = new Set(),
    identities = new Set();
  const baseIndex = before('index.json');
  let otherChanges = false;
  for (const change of changes) {
    const name = change.path;
    if (name.startsWith('projections/realm/') || name === 'index.json') continue;
    const match =
      /^products\/([^/]+)\/(product\.json|sources\/([^/]+)\.json|web\/releases\/([^/]+)\.json)$/.exec(name);
    if (!match || change.status === 'D')
      throw new Error('Cannot delete or mix unrelated files into a product review: ' + name);
    const [, appId, file, client, version] = match;
    const entry = state.products.get(appId);
    if (!entry) throw new Error('Missing reviewed product: ' + appId);
    identities.add(appId);
    if (file === 'product.json') {
      const previous = change.status === 'M' ? before(name) : null;
      if (previous) {
        for (const key of ['app_id', 'slug', 'publisher', 'repository', 'repository_id', 'owner_id'])
          if (previous[key] !== entry.product[key])
            throw new Error('Published product ownership and slug cannot be reassigned.');
        if (baseIndex?.apps?.[appId] && !equal(previous.summary, entry.product.summary)) {
          throw new Error('Products with admitted native releases cannot edit product.json summary independently; publish a reviewed release.');
        }
        if (!equal(previous.kill_switch, entry.product.kill_switch)) {
          if (
            !equal(omit(previous, ['kill_switch']), omit(entry.product, ['kill_switch'])) ||
            entry.product.kill_switch.revision !== previous.kill_switch.revision + 1
          )
            throw new Error('Product policy requires an independent incremented revision.');
          policies.add(appId);
        } else if (
          (!equal(previous.origin, entry.product.origin) || !equal(previous.upstream, entry.product.upstream)) &&
          equal(omit(previous, ['origin', 'upstream']), omit(entry.product, ['origin', 'upstream']))
        ) {
          attributions.add(appId);
        } else otherChanges = true;
      } else {
        if (!equal(entry.product.kill_switch, zeroPolicy))
          throw new Error('New products start with neutral policy.');
        owners.push(entry.product);
        otherChanges = true;
      }
    } else if (client) {
      otherChanges = true;
      const record = entry.sources.get(client);
      const previous = change.status === 'M' ? before(name) : null;
      const current = admittedClient(entry.product, record);
      if (previous && previous.kind !== record.kind) throw new Error('Source carrier cannot be reassigned.');
      const priorSource = previous && admittedClient(entry.product, previous);
      if (!priorSource || !equal(priorSource, current))
        validateRemoteClientTransition(
          { clients: previous ? { [client]: priorSource } : {} },
          { clients: { [client]: current } },
          context,
        );
    } else {
      otherChanges = true;
      if (change.status !== 'A') throw new Error('Approved Web versions are immutable.');
      const release = entry.releases.get(version);
      if (
        entry.hosted?.stable_version !== version ||
        release.review.adjudicator_login !== context.actorLogin ||
        release.review.adjudicator_actor_id !== context.actorId
      )
        throw new Error('Web admission must select the exact release and identify its reviewer.');
      releases.push({ product: entry.product, release, source: admittedClient(entry.product, entry.hosted) });
    }
  }
  const hasPolicies = policies.size > 0;
  const hasAttributions = attributions.size > 0;
  const activeModes = Number(hasPolicies) + Number(hasAttributions) + Number(otherChanges);
  if (!identities.size || activeModes !== 1 || (otherChanges && identities.size !== 1))
    throw new Error('Review one product, only explicit product policy changes, or only product origin/upstream attribution projections.');
  if (changes.some((c) => c.path === 'index.json')) {
    const prior = before('index.json');
    if (hasPolicies) {
      for (const id of policies)
        if (prior.apps[id]) prior.apps[id].kill_switch = state.products.get(id).product.kill_switch;
    } else if (hasAttributions) {
      for (const id of attributions) {
        if (!prior.apps[id]) continue;
        const prod = state.products.get(id).product;
        if (prod.origin === undefined) delete prior.apps[id].origin;
        else prior.apps[id].origin = prod.origin;
        if (prod.upstream === undefined) delete prior.apps[id].upstream;
        else prior.apps[id].upstream = prod.upstream;
      }
    }
    if (!equal(prior, after('index.json')))
      throw new Error('Only matching native product policy or attribution projections may change in this review.');
  }
  if (hasAttributions) {
    return { mode: 'attribution-projection', owners: [], releases: [], attributed: [...attributions].sort() };
  }
  return { mode: 'hosted-review', owners, releases };
}
