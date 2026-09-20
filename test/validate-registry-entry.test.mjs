import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChangedPaths, pullRequestContext } from '../scripts/validate-registry.mjs';

// The CLI entry decouples the policy-only transition from finalization-only
// facts: it fetches the actor's permission but never the publisher head's
// parent commit or check runs.
test('policy-only pull requests fetch maintainer permission without parent-commit or check-run coupling', async () => {
  assert.equal(classifyChangedPaths(['index.json']), 'maintainer-policy');
  assert.equal(classifyChangedPaths(['index.json', 'descriptors/a.b/1.0.0.json']), 'maintainer-finalization');
  assert.equal(classifyChangedPaths(['submissions/p/a.b/1.0.0.json']), 'publisher-submission');
  assert.equal(classifyChangedPaths(['README.md', 'index.json']), 'maintainer-finalization');

  process.env.GITHUB_TOKEN = 'token';
  process.env.GITHUB_REPOSITORY = 'nimiplatform/nimi-app-registry';
  process.env.GITHUB_ACTOR = 'registry-maintainer';
  process.env.GITHUB_ACTOR_ID = '9876';
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const requests = [];
  const gitCalls = [];
  const deps = {
    readJson: async () => ({ number: 7, sender: { login: 'registry-maintainer', id: 9876 }, pull_request: { base: { sha: base }, head: { sha: head, repo: { owner: { login: 'nimiplatform' } } } } }),
    gitOutput: (_root, args) => { gitCalls.push(args[0]); return args[0] === 'diff' ? 'index.json\n' : `${head} ${base}`; },
    githubJson: async (url) => { requests.push(url); return url.includes('/permission') ? { permission: 'maintain' } : { check_runs: [] }; },
  };
  const context = await pullRequestContext({ gitRoot: '.', base, head, event: 'event.json' }, deps);
  assert.equal(context.finalizerPermission, 'maintain');
  assert.equal(context.candidateCheckPassed, false);
  assert.deepEqual(gitCalls, ['diff'], 'no rev-list on a policy-only change');
  assert.deepEqual(requests.map((url) => url.replace('https://api.github.com/repos/nimiplatform/nimi-app-registry', '')), ['/collaborators/registry-maintainer/permission']);

  deps.gitOutput = (_root, args) => { gitCalls.push(args[0]); return args[0] === 'diff' ? 'index.json\ndescriptors/a.b/1.0.0.json\n' : `${head} ${base}`; };
  requests.length = 0;
  gitCalls.length = 0;
  const finalization = await pullRequestContext({ gitRoot: '.', base, head, event: 'event.json' }, deps);
  assert.equal(finalization.finalizerPermission, 'maintain');
  assert.deepEqual(gitCalls, ['diff', 'rev-list'], 'finalization keeps the parent-commit check');
  assert.equal(requests.length, 2, 'finalization also reads the publisher-head check runs');
});
