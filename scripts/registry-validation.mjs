import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import parseSpdxExpression from 'spdx-expression-parse';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submissionPathPattern = /^submissions\/([^/]+)\/([^/]+)\/([^/]+)\.json$/u;
const descriptorPathPattern = /^descriptors\/([^/]+)\/([^/]+)\.json$/u;
const maintainerPermissions = new Set(['admin', 'maintain']);

export class RegistryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryValidationError';
  }
}

function fail(message) {
  throw new RegistryValidationError(message);
}

function toPosix(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function schemaError(label, errors) {
  const detail = (errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
  fail(`${label} does not match its closed schema: ${detail || 'unknown schema error'}`);
}

async function readJsonFile(filePath, label = filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a direct regular file`);
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function listJsonFiles(root, relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const found = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`${toPosix(path.relative(root, absolute))} must not be a symbolic link`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        found.push(toPosix(path.relative(root, absolute)));
      } else {
        fail(`${toPosix(path.relative(root, absolute))} is not an admitted Registry JSON file`);
      }
    }
  }
  await visit(absoluteDir);
  return found;
}

async function loadValidators(schemaRoot = path.join(moduleRoot, 'schema')) {
  const common = await readJsonFile(path.join(schemaRoot, 'common.schema.json'));
  const submission = await readJsonFile(path.join(schemaRoot, 'submission.schema.json'));
  const descriptor = await readJsonFile(path.join(schemaRoot, 'approved-descriptor.schema.json'));
  const index = await readJsonFile(path.join(schemaRoot, 'index.schema.json'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(common);
  return Object.freeze({
    submission: ajv.compile(submission),
    descriptor: ajv.compile(descriptor),
    index: ajv.compile(index),
  });
}

function validateWith(validator, value, label) {
  if (!validator(value)) schemaError(label, validator.errors);
}

function githubRepositoryParts(repository) {
  const parsed = new URL(repository);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname !== 'github.com' || segments.length !== 2) fail(`source.repository is not an exact GitHub repository: ${repository}`);
  return { owner: segments[0], repo: segments[1] };
}

function validateTaggedReleaseAsset(candidate, asset, label) {
  let parsed;
  try {
    parsed = new URL(asset.asset_url);
  } catch {
    fail(`${label} asset_url is invalid`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || asset.asset_url.includes('\\')) {
    fail(`${label} does not use an exact tagged GitHub Release locator`);
  }
  const rawSegments = parsed.pathname.split('/');
  if (rawSegments.length !== 7 || rawSegments[0] !== '') fail(`${label} does not identify one exact Release asset`);
  let segments;
  try {
    segments = rawSegments.slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    fail(`${label} contains invalid path encoding`);
  }
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
    fail(`${label} contains a non-canonical path segment`);
  }
  const source = new URL(candidate.source.repository);
  const sourceSegments = source.pathname.split('/').filter(Boolean);
  const expected = [sourceSegments[0], sourceSegments[1], 'releases', 'download', candidate.release.tag, asset.asset_name];
  if (!segments.every((segment, index) => segment === expected[index])) {
    fail(`${label} does not identify the exact tagged GitHub Release asset`);
  }
}

function validateCandidateFacts(candidate, label) {
  try {
    parseSpdxExpression(candidate.source.license.spdx_expression);
  } catch (error) {
    fail(`${label} license SPDX expression is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { owner } = githubRepositoryParts(candidate.source.repository);
  if (owner.toLowerCase() !== candidate.publisher.github_namespace.toLowerCase()) {
    fail(`${label} source repository is not owned by publisher.github_namespace`);
  }
  if (candidate.release.tag !== `v${candidate.version}`) fail(`${label} release.tag must equal v<version>`);
  validateTaggedReleaseAsset(candidate, candidate.aggregate, `${label} aggregate`);
  const targetIds = new Set();
  const assetIds = new Set([candidate.aggregate.asset_id]);
  const assetNames = new Set([candidate.aggregate.asset_name]);
  for (const target of candidate.targets) {
    if (targetIds.has(target.target_id)) fail(`${label} contains duplicate target_id ${target.target_id}`);
    if (assetIds.has(target.asset_id)) fail(`${label} contains duplicate asset_id ${target.asset_id}`);
    if (assetNames.has(target.asset_name)) fail(`${label} contains duplicate asset_name ${target.asset_name}`);
    targetIds.add(target.target_id);
    assetIds.add(target.asset_id);
    assetNames.add(target.asset_name);
    validateTaggedReleaseAsset(candidate, target, `${label} target ${target.target_id}`);
    if (!target.runtime_entry.startsWith('payload/')) fail(`${label} target ${target.target_id} runtime_entry must stay inside payload/`);
  }
  const licensePaths = candidate.source.license.files.map((entry) => entry.path);
  if (new Set(licensePaths).size !== licensePaths.length) fail(`${label} contains duplicate license file paths`);
}

function expectedSubmissionPath(candidate) {
  return `submissions/${candidate.publisher.github_namespace}/${candidate.app_id}/${candidate.version}.json`;
}

function expectedDescriptorPath(candidate) {
  return `descriptors/${candidate.app_id}/${candidate.version}.json`;
}

function expectedDescriptorId(candidate) {
  return `${candidate.app_id}@${candidate.version}`;
}

function validateSubmissionLocation(submission, submissionPath, label) {
  const match = submissionPathPattern.exec(submissionPath);
  if (!match) fail(`${label} path is not canonical: ${submissionPath}`);
  const expected = expectedSubmissionPath(submission.candidate);
  if (submissionPath !== expected) fail(`${label} path must be ${expected}`);
}

function validateDescriptorLocation(descriptor, descriptorPath, label) {
  const match = descriptorPathPattern.exec(descriptorPath);
  if (!match) fail(`${label} path is not canonical: ${descriptorPath}`);
  const expectedPath = expectedDescriptorPath(descriptor.candidate);
  const expectedId = expectedDescriptorId(descriptor.candidate);
  if (descriptorPath !== expectedPath) fail(`${label} path must be ${expectedPath}`);
  if (descriptor.descriptor_id !== expectedId) fail(`${label} descriptor_id must be ${expectedId}`);
}

export async function validateRegistryTree(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const validators = await loadValidators(path.resolve(options.schemaRoot || path.join(resolvedRoot, 'schema')));
  const indexPath = path.join(resolvedRoot, 'index.json');
  const index = await readJsonFile(indexPath, 'index.json');
  validateWith(validators.index, index, 'index.json');

  const submissionPaths = await listJsonFiles(resolvedRoot, 'submissions');
  if (!options.allowSubmissions && submissionPaths.length !== 0) fail('Registry main must not retain publisher submission files');
  for (const submissionPath of submissionPaths) {
    const submission = await readJsonFile(path.join(resolvedRoot, submissionPath), submissionPath);
    validateWith(validators.submission, submission, submissionPath);
    validateCandidateFacts(submission.candidate, submissionPath);
    validateSubmissionLocation(submission, submissionPath, submissionPath);
  }

  const descriptors = new Map();
  for (const descriptorPath of await listJsonFiles(resolvedRoot, 'descriptors')) {
    const descriptor = await readJsonFile(path.join(resolvedRoot, descriptorPath), descriptorPath);
    validateWith(validators.descriptor, descriptor, descriptorPath);
    validateCandidateFacts(descriptor.candidate, descriptorPath);
    validateDescriptorLocation(descriptor, descriptorPath, descriptorPath);
    if (descriptors.has(descriptor.descriptor_id)) fail(`duplicate descriptor_id ${descriptor.descriptor_id}`);
    descriptors.set(descriptor.descriptor_id, { descriptor, descriptorPath });
  }

  for (const [appId, row] of Object.entries(index.apps)) {
    for (const [targetId, pointer] of Object.entries(row.latest_admitted_release_by_target)) {
      const resolved = descriptors.get(pointer.descriptor_id);
      if (!resolved) fail(`index pointer ${appId}/${targetId} references a missing descriptor_id`);
      if (resolved.descriptorPath !== pointer.path) fail(`index pointer ${appId}/${targetId} path disagrees with descriptor_id`);
      if (resolved.descriptor.candidate.app_id !== appId) fail(`index pointer ${appId}/${targetId} crosses App identity`);
      if (resolved.descriptor.candidate.display_name !== row.display_name) fail(`index display_name for ${appId} disagrees with its descriptor`);
      if (!resolved.descriptor.candidate.targets.some((target) => target.target_id === targetId)) {
        fail(`index pointer ${appId}/${targetId} references a descriptor without that target`);
      }
    }
  }

  return Object.freeze({ descriptors: descriptors.size, submissions: submissionPaths.length, apps: Object.keys(index.apps).length });
}

function gitOutput(gitRoot, args) {
  try {
    return execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8', windowsHide: true }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${error?.stderr?.toString().trim() || error?.message || String(error)}`);
  }
}

function gitChanges(gitRoot, from, to) {
  const output = gitOutput(gitRoot, ['diff', '--name-status', '--find-renames=100%', `${from}..${to}`, '--']);
  if (!output) return [];
  return output.split(/\r?\n/u).map((line) => {
    const fields = line.split('\t');
    const status = fields[0];
    if (!/^[AMD]$/u.test(status) || fields.length !== 2) fail(`unsupported Registry path transition: ${line}`);
    return Object.freeze({ status, path: toPosix(fields[1]) });
  });
}

function exactChanges(actual, expected, label) {
  const left = [...actual].sort((a, b) => `${a.status}:${a.path}`.localeCompare(`${b.status}:${b.path}`, 'en'));
  const right = [...expected].sort((a, b) => `${a.status}:${a.path}`.localeCompare(`${b.status}:${b.path}`, 'en'));
  if (!isDeepStrictEqual(left, right)) {
    fail(`${label} changed unexpected paths: ${JSON.stringify(left)}`);
  }
}

function readJsonAt(gitRoot, revision, relativePath, label) {
  const source = gitOutput(gitRoot, ['show', `${revision}:${relativePath}`]);
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${label} is not valid JSON at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireContextValue(value, label) {
  if (value === undefined || value === null || value === '') fail(`${label} is required for pull-request validation`);
  return value;
}

export async function validatePullRequestTransition(options) {
  const root = path.resolve(options.root);
  const gitRoot = path.resolve(options.gitRoot || root);
  const baseSha = requireContextValue(options.baseSha, 'baseSha');
  const headSha = requireContextValue(options.headSha, 'headSha');
  const context = options.context || {};
  const validators = await loadValidators(path.resolve(options.schemaRoot || path.join(moduleRoot, 'schema')));
  const changes = gitChanges(gitRoot, baseSha, headSha);
  const descriptorAdds = changes.filter((change) => change.status === 'A' && descriptorPathPattern.test(change.path));
  const touchesAdmission = changes.some((change) => change.path === 'index.json' || change.path.startsWith('descriptors/'));

  if (!touchesAdmission) {
    if (changes.length !== 1 || changes[0].status !== 'A' || !submissionPathPattern.test(changes[0].path)) {
      fail('publisher candidate PR must add exactly one submission file and no other path');
    }
    const submissionPath = changes[0].path;
    const submission = readJsonAt(gitRoot, headSha, submissionPath, submissionPath);
    validateWith(validators.submission, submission, submissionPath);
    validateCandidateFacts(submission.candidate, submissionPath);
    validateSubmissionLocation(submission, submissionPath, submissionPath);
    const headOwner = requireContextValue(context.headOwner, 'publisher PR head owner');
    if (headOwner.toLowerCase() !== submission.candidate.publisher.github_namespace.toLowerCase()) {
      fail('publisher submission must originate from a fork owned by publisher.github_namespace');
    }
    return Object.freeze({ mode: 'publisher-submission', submissionPath });
  }

  if (descriptorAdds.length !== 1) fail('maintainer finalization must add exactly one approved descriptor');
  const descriptorPath = descriptorAdds[0].path;
  exactChanges(changes, [
    { status: 'A', path: descriptorPath },
    { status: 'M', path: 'index.json' },
  ], 'final pull-request projection');

  const parentLine = gitOutput(gitRoot, ['rev-list', '--parents', '-n', '1', headSha]).split(/\s+/u);
  if (parentLine.length !== 2) fail('maintainer finalization commit must have exactly one parent');
  const publisherHeadSha = parentLine[1];
  const descriptor = readJsonAt(gitRoot, headSha, descriptorPath, descriptorPath);
  validateWith(validators.descriptor, descriptor, descriptorPath);
  validateCandidateFacts(descriptor.candidate, descriptorPath);
  validateDescriptorLocation(descriptor, descriptorPath, descriptorPath);
  if (descriptor.publisher_submission.head_sha !== publisherHeadSha) {
    fail('descriptor publisher_submission.head_sha must equal the finalization commit parent');
  }

  const submissionPath = descriptor.publisher_submission.path;
  exactChanges(gitChanges(gitRoot, baseSha, publisherHeadSha), [
    { status: 'A', path: submissionPath },
  ], 'checked publisher candidate');
  exactChanges(gitChanges(gitRoot, publisherHeadSha, headSha), [
    { status: 'D', path: submissionPath },
    { status: 'A', path: descriptorPath },
    { status: 'M', path: 'index.json' },
  ], 'maintainer finalization commit');

  const submission = readJsonAt(gitRoot, publisherHeadSha, submissionPath, submissionPath);
  validateWith(validators.submission, submission, submissionPath);
  validateCandidateFacts(submission.candidate, submissionPath);
  validateSubmissionLocation(submission, submissionPath, submissionPath);
  if (!isDeepStrictEqual(submission.candidate, descriptor.candidate)) {
    fail('approved descriptor candidate must exactly equal the checked publisher submission candidate');
  }

  const pullNumber = Number(requireContextValue(context.pullNumber, 'pull request number'));
  const actorId = Number(requireContextValue(context.actorId, 'finalizer actor id'));
  const actorLogin = requireContextValue(context.actorLogin, 'finalizer actor login');
  if (descriptor.publisher_submission.pull_number !== pullNumber) fail('descriptor pull_number does not match the current pull request');
  if (!maintainerPermissions.has(context.finalizerPermission)) fail('finalization actor is not a current Registry maintainer');
  if (descriptor.admission.review.adjudicator_login !== actorLogin) fail('descriptor adjudicator_login does not match the GitHub event actor');
  if (descriptor.admission.review.adjudicator_actor_id !== actorId) fail('descriptor adjudicator_actor_id does not match the GitHub event actor id');
  if (context.candidateCheckPassed !== true) fail('checked publisher head does not have a successful base-owned validate-registry result');

  await validateRegistryTree(root, { schemaRoot: options.schemaRoot, allowSubmissions: false });
  return Object.freeze({ mode: 'maintainer-finalization', descriptorPath, submissionPath, publisherHeadSha });
}
