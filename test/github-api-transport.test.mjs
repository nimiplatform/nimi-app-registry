import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import test from 'node:test';
import { requestJson } from '../scripts/github-candidate-validation.mjs';

const url = 'https://api.github.com/repos/publisher/example-app/contents/LICENSE?ref=abcdef';

test('metadata uses a fixed GitHub GET through gh without extracting a credential', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('metadata must not fall back to anonymous fetch'));
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    calls.push({ command, args });
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'GET',
      '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28',
      '/repos/publisher/example-app/contents/LICENSE?ref=abcdef']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GH_DEBUG, '');
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    return '{"type":"file"}';
  });
  assert.deepEqual(await requestJson(url, '', 'source license'), { type: 'file' });
  assert.equal(calls.length, 1);
});

test('explicit tokens retain the authenticated fetch route and HTTP error semantics', async (t) => {
  t.mock.method(childProcess, 'execFileSync', () => assert.fail('an explicit token does not need gh metadata requests'));
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return new Response('{"type":"file"}', { status });
  });
  assert.deepEqual(await requestJson(url, 'fixture-token', 'source license'), { type: 'file' });
  status = 403;
  await assert.rejects(requestJson(url, 'fixture-token', 'source license'), /source license failed with HTTP 403/u);
});

test('unsupported API origins and URL credentials are refused before either transport', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected fetch'));
  t.mock.method(childProcess, 'execFileSync', () => assert.fail('unexpected gh command'));
  for (const target of ['http://api.github.com/repos/p/r', 'https://api.github.com:444/repos/p/r',
    'https://api.github.com.evil.example/repos/p/r', 'https://secret@api.github.com/repos/p/r',
    'https://api.github.com/repos/p/r#fragment', 'https://api.github.com/graphql',
    'https://api.github.com//evil.example/repos/p/r', 'not-a-url']) {
    for (const token of ['', 'fixture-token']) {
      await assert.rejects(requestJson(target, token, 'metadata'), /must use a supported GitHub API URL/u);
    }
  }
});

test('gh failures remain actionable without exposing child diagnostics or falling back', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('failed gh must not fall back'));
  t.mock.method(childProcess, 'execFileSync', () => {
    throw Object.assign(new Error('SENSITIVE-command'), {
      status: 1, stderr: 'Authorization: SENSITIVE-credential\ngh: Forbidden (HTTP 403)', stdout: 'SENSITIVE-response',
    });
  });
  await assert.rejects(requestJson(url, '', 'metadata'), (error) => {
    assert.match(error.message, /metadata failed via gh api \(HTTP 403\)/u);
    assert.match(error.message, /gh auth status --hostname github.com/u);
    assert.doesNotMatch(error.message, /SENSITIVE/u);
    return true;
  });
});

test('a missing gh binary or malformed JSON is an explicit failure', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected fallback'));
  let missing = true;
  t.mock.method(childProcess, 'execFileSync', () => {
    if (missing) throw Object.assign(new Error('SENSITIVE-command'), { code: 'ENOENT' });
    return 'SENSITIVE-non-JSON-response';
  });
  await assert.rejects(requestJson(url, '', 'metadata'), /requires the GitHub CLI/u);
  missing = false;
  await assert.rejects(requestJson(url, '', 'metadata'), (error) => {
    assert.match(error.message, /returned invalid JSON from gh api/u);
    assert.doesNotMatch(error.message, /SENSITIVE/u);
    return true;
  });
});
