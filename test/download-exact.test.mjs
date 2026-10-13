import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { downloadExact } from '../scripts/github-candidate-validation.mjs';

const partSize = 8 * 1024 * 1024;
const artifact = Buffer.alloc(20 * 1024 * 1024, 0x5a);
for (let offset = 0; offset < artifact.length; offset += 1024) artifact.writeUInt32LE(offset, offset);
const digest = createHash('sha256').update(artifact).digest('hex');

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/artifact`;
}

function bounds(request) {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range || '');
  assert.ok(match, 'large transfers request explicit byte ranges');
  assert.deepEqual(new Set(request.headers['accept-encoding'].split(',').map((value) => value.trim())), new Set(['identity']));
  return match.slice(1).map(Number);
}

function rangeHeaders(start, end) {
  return { 'Content-Range': `bytes ${start}-${end}/${artifact.length}`, 'Content-Length': end - start + 1 };
}

test('real HTTP ranges retain ordering and retry only the interrupted part', async (t) => {
  const calls = new Map();
  const completed = [];
  const url = await fixture(t, (request, response) => {
    const [start, end] = bounds(request);
    calls.set(start, (calls.get(start) || 0) + 1);
    response.writeHead(206, rangeHeaders(start, end));
    if (start === partSize && calls.get(start) === 1) {
      response.flushHeaders();
      response.write(artifact.subarray(start, start + 1024));
      setImmediate(() => response.destroy());
      return;
    }
    setTimeout(() => {
      completed.push(start);
      response.end(artifact.subarray(start, end + 1));
    }, start === partSize ? 30 : 0);
  });
  assert.deepEqual(await downloadExact(url, artifact.length, digest, 'artifact'), artifact);
  assert.equal(calls.get(0), 1);
  assert.equal(calls.get(partSize), 2);
  assert.equal(calls.get(partSize * 2), 1);
  assert.deepEqual(completed, [0, partSize * 2, partSize]);
});

test('a server ignoring Range supplies one complete response with full digest verification', async (t) => {
  let calls = 0;
  const url = await fixture(t, (_request, response) => {
    calls += 1;
    response.writeHead(200, { 'Content-Length': artifact.length });
    response.end(artifact);
  });
  assert.deepEqual(await downloadExact(url, artifact.length, digest, 'artifact'), artifact);
  assert.equal(calls, 1);
});

test('wrong range identity is rejected without retries or partial success', async (t) => {
  let calls = 0;
  const url = await fixture(t, (request, response) => {
    calls += 1;
    const [start, end] = bounds(request);
    response.writeHead(206, { ...rangeHeaders(start, end), 'Content-Range': `bytes ${start + 1}-${end}/${artifact.length}` });
    response.end(artifact.subarray(start, end + 1));
  });
  await assert.rejects(downloadExact(url, artifact.length, digest, 'artifact'), /range identity mismatch/u);
  assert.equal(calls, 1);
});

test('a short completed range body is rejected without retries', async (t) => {
  let calls = 0;
  const url = await fixture(t, (request, response) => {
    calls += 1;
    const [start, end] = bounds(request);
    response.writeHead(206, { ...rangeHeaders(start, end), 'Content-Length': end - start });
    response.end(artifact.subarray(start, end));
  });
  await assert.rejects(downloadExact(url, artifact.length, digest, 'artifact'), /size mismatch/u);
  assert.equal(calls, 1);
});

test('valid range sizes never substitute for the complete published SHA-256', async (t) => {
  const url = await fixture(t, (request, response) => {
    const [start, end] = bounds(request);
    const bytes = Buffer.from(artifact.subarray(start, end + 1));
    bytes[0] ^= 1;
    response.writeHead(206, rangeHeaders(start, end));
    response.end(bytes);
  });
  await assert.rejects(downloadExact(url, artifact.length, digest, 'artifact'), /SHA-256 mismatch/u);
});

test('transient HTTP failures have a bounded retry count', async (t) => {
  let calls = 0;
  const url = await fixture(t, (_request, response) => {
    calls += 1;
    response.writeHead(503);
    response.end();
  });
  await assert.rejects(downloadExact(url, artifact.length, digest, 'artifact'), /interrupted after 3 attempts/u);
  assert.equal(calls, 3);
});

test('small metadata remains one request and permanent HTTP errors are not retried', async (t) => {
  let calls = 0;
  const bytes = Buffer.from('{"schema_version":1}');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const url = await fixture(t, (request, response) => {
    calls += 1;
    assert.equal(request.headers.range, undefined);
    response.writeHead(calls === 1 ? 200 : 404);
    response.end(calls === 1 ? bytes : undefined);
  });
  assert.deepEqual(await downloadExact(url, bytes.length, hash, 'metadata'), bytes);
  await assert.rejects(downloadExact(url, bytes.length, hash, 'metadata'), /HTTP 404/u);
  assert.equal(calls, 2);
});
