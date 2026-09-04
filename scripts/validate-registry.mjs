import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePublishedGitHubCandidate } from './github-candidate-validation.mjs';
import {
  RegistryValidationError,
  validatePullRequestTransition,
  validateRegistryTree,
} from './registry-validation.mjs';

function parseArgs(argv) {
  const options = {};
  const valueOptions = new Map([
    ['--root', 'root'],
    ['--git-root', 'gitRoot'],
    ['--schema-root', 'schemaRoot'],
    ['--base', 'base'],
    ['--head', 'head'],
    ['--event', 'event'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--all' || token === '--pr') {
      if (options.mode) throw new Error('select exactly one validation mode');
      options.mode = token.slice(2);
      continue;
    }
    if (!valueOptions.has(token)) throw new Error(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[valueOptions.get(token)] = value;
    index += 1;
  }
  if (!options.mode) throw new Error('use --all or --pr');
  return options;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new RegistryValidationError(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gitOutput(gitRoot, args) {
  return execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8', windowsHide: true }).trim();
}

async function githubJson(url, token, label) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new RegistryValidationError(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

function pullEventContext(event, baseSha, headSha) {
  if (!event?.pull_request || event.pull_request.base?.sha !== baseSha || event.pull_request.head?.sha !== headSha) {
    throw new RegistryValidationError('GitHub pull_request event does not match the exact base/head under validation');
  }
  const actorLogin = process.env.GITHUB_ACTOR || '';
  const actorId = Number(process.env.GITHUB_ACTOR_ID || 0);
  if (event.sender?.login !== actorLogin || event.sender?.id !== actorId) {
    throw new RegistryValidationError('GitHub event sender does not match GITHUB_ACTOR/GITHUB_ACTOR_ID');
  }
  return {
    pullNumber: event.number,
    headOwner: event.pull_request.head?.repo?.owner?.login,
    publisherPrAuthor: event.pull_request.user?.login,
    actorLogin,
    actorId,
  };
}

async function pullRequestContext(options) {
  const token = process.env.GITHUB_TOKEN || '';
  const repository = process.env.GITHUB_REPOSITORY || '';
  if (!token || !/^[^/]+\/[^/]+$/u.test(repository)) throw new RegistryValidationError('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const eventPath = path.resolve(options.event || process.env.GITHUB_EVENT_PATH || '');
  const event = await readJson(eventPath, 'GitHub event');
  const context = pullEventContext(event, options.base, options.head);
  const changedPaths = gitOutput(options.gitRoot, ['diff', '--name-only', `${options.base}..${options.head}`, '--']).split(/\r?\n/u).filter(Boolean);
  const finalization = changedPaths.some((entry) => entry === 'index.json' || entry.startsWith('descriptors/'));
  if (!finalization) return { ...context, finalizerPermission: '', candidateCheckPassed: false, token };

  const permission = await githubJson(
    `https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(context.actorLogin)}/permission`,
    token,
    'Registry collaborator permission',
  );
  const parentLine = gitOutput(options.gitRoot, ['rev-list', '--parents', '-n', '1', options.head]).split(/\s+/u);
  if (parentLine.length !== 2) throw new RegistryValidationError('finalization commit must have one parent');
  const checkRuns = await githubJson(
    `https://api.github.com/repos/${repository}/commits/${parentLine[1]}/check-runs?per_page=100`,
    token,
    'publisher-head check runs',
  );
  const candidateCheckPassed = (checkRuns.check_runs || []).some((check) => (
    check.name === 'validate-registry'
    && check.status === 'completed'
    && check.conclusion === 'success'
    && check.app?.slug === 'github-actions'
  ));
  return { ...context, finalizerPermission: permission.permission, candidateCheckPassed, token };
}

async function candidateFromTransition(root, transition) {
  const relativePath = transition.mode === 'publisher-submission' ? transition.submissionPath : transition.descriptorPath;
  const value = await readJson(path.join(root, relativePath), relativePath);
  return value.candidate;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const root = path.resolve(parsed.root || process.cwd());
  const schemaRoot = path.resolve(parsed.schemaRoot || path.join(root, 'schema'));
  if (parsed.mode === 'all') {
    const summary = await validateRegistryTree(root, { schemaRoot });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'all', ...summary })}\n`);
    return;
  }

  const gitRoot = path.resolve(parsed.gitRoot || root);
  const base = parsed.base || process.env.REGISTRY_BASE_SHA || '';
  const head = parsed.head || process.env.REGISTRY_HEAD_SHA || '';
  const context = await pullRequestContext({ ...parsed, root, gitRoot, base, head });
  const transition = await validatePullRequestTransition({
    root,
    gitRoot,
    schemaRoot,
    baseSha: base,
    headSha: head,
    context,
  });
  const candidate = await candidateFromTransition(root, transition);
  const external = await validatePublishedGitHubCandidate(candidate, { token: context.token });
  process.stdout.write(`${JSON.stringify({ ok: true, mode: transition.mode, transition, external })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
