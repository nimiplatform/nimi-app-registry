import { isDeepStrictEqual } from 'node:util';

const sourceFields = ['kind', 'origin', 'redirect_uri', 'role', 'app_access', 'capability_contract_refs', 'android'];

// @nimi-authority: rule.nimi.platform.remote-clients.web-registration
// @nimi-authority: rule.nimi.platform.remote-clients.android-registration
export function validateRemoteClientFacts(document, { localDevelopment = false } = {}) {
  for (const [id, client] of Object.entries(document.clients)) {
    const origin = new URL(client.origin);
    const callback = new URL(client.redirect_uri);
    if (client.kind === 'android-dev-scheme') {
      if (!localDevelopment) throw new Error(`${id}: development source is forbidden in the public Registry`);
      if (client.role !== 'app' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+:$/.test(callback.protocol)
        || client.origin !== callback.protocol + '/' || callback.host || callback.username || callback.password
        || !callback.pathname.startsWith('/') || callback.pathname.startsWith('//')
        || callback.href !== callback.protocol + callback.pathname
        || callback.href !== client.redirect_uri || callback.search || callback.hash) {
        throw new Error(`${id}: development source requires an ordinary App and exact private-use callback`);
      }
      continue;
    }
    if (origin.protocol !== 'https:' || origin.origin !== client.origin || origin.username || origin.password
      || callback.protocol !== 'https:' || callback.origin !== client.origin || callback.href !== client.redirect_uri
      || callback.username || callback.password || callback.search || callback.hash) {
      throw new Error(`${id}: origin and callback must be canonical same-origin HTTPS URLs`);
    }
  }
}

// @nimi-authority: rule.nimi.platform.remote-clients.review-and-role
export function validateRemoteClientTransition(before, after, context) {
  if (!['admin', 'maintain'].includes(context.finalizerPermission)) throw new Error('remote source change requires a current Registry maintainer');
  const changed = [];
  for (const id of Object.keys(before.clients)) {
    if (!Object.hasOwn(after.clients, id)) throw new Error(`${id}: pause a remote source instead of deleting its identity`);
  }
  for (const [id, next] of Object.entries(after.clients)) {
    const previous = before.clients[id];
    if (isDeepStrictEqual(previous, next)) continue;
    if (previous && (previous.app_id !== next.app_id || previous.publisher !== next.publisher)) {
      throw new Error(`${id}: client identity cannot be reassigned to another App or publisher`);
    }
    const sourceChanged = previous && sourceFields.some(field => !isDeepStrictEqual(previous[field], next[field]));
    const expected = previous ? previous.source_revision + (sourceChanged ? 1 : 0) : 1;
    if (next.source_revision !== expected) throw new Error(`${id}: source revision must be ${expected}`);
    if (next.review.adjudicator_login !== context.actorLogin || next.review.adjudicator_actor_id !== Number(context.actorId)) {
      throw new Error(`${id}: review must identify the actual maintainer actor`);
    }
    changed.push(id);
  }
  if (changed.length === 0) throw new Error('remote source change must change a registration');
  return changed;
}
