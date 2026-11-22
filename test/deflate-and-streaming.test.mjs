import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  downloadExactToFile,
  readNimiAppArchive,
  readNimiAppArchiveFromFile,
} from '../scripts/github-candidate-validation.mjs';
import { SYMBOLIC_LINK_MODE, validatePayloadLinks } from '../scripts/payload-links.mjs';

function buildRawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const rawName = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const localName = e.localName ?? rawName;
    const method = e.method ?? 0;
    const localMethod = e.localMethod ?? method;
    const flags = e.flags ?? 0x0800;
    const localFlags = e.localFlags ?? flags;
    const payload = e.compressed;
    const uncomp = e.uncompressedSize ?? payload.length;
    const expectedCrc = e.crc ?? 0;
    const extAttrs = e.externalAttrs ?? 0x81A40000;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(localFlags, 6);
    lh.writeUInt16LE(localMethod, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x0021, 12);
    lh.writeUInt32LE(expectedCrc >>> 0, 14);
    lh.writeUInt32LE(payload.length >>> 0, 18);
    lh.writeUInt32LE(uncomp >>> 0, 22);
    lh.writeUInt16LE(localName.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, localName, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(expectedCrc >>> 0, 16);
    ch.writeUInt32LE(payload.length >>> 0, 20);
    ch.writeUInt32LE(uncomp >>> 0, 24);
    ch.writeUInt16LE(rawName.length, 28);
    ch.writeUInt32LE(extAttrs >>> 0, 38);
    ch.writeUInt32LE(offset >>> 0, 42);
    centrals.push(ch, rawName);
    offset += lh.length + localName.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('Registry sync and streaming readers accept valid Deflate + 0 B Store and reject BFINAL smuggling, overflow, and dirty attributes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nimi-reg-l2-'));
  try {
    const plain64k = Buffer.alloc(64 * 1024, 0x42);
    const comp64k = deflateRawSync(plain64k, { level: 6 });
    const valid = buildRawZip([
      { name: 'payload/__init__.py', method: 0, crc: 0, uncompressedSize: 0, compressed: Buffer.alloc(0) },
      { name: 'payload/exact-64k.txt', method: 8, crc: crc32(plain64k), uncompressedSize: plain64k.length, compressed: comp64k },
    ]);
    const decodedSync = readNimiAppArchive(valid, 'valid');
    assert.deepEqual(decodedSync.get('payload/__init__.py').bytes, Buffer.alloc(0));
    assert.deepEqual(decodedSync.get('payload/exact-64k.txt').bytes, plain64k);

    const validPath = path.join(dir, 'valid.nimiapp');
    writeFileSync(validPath, valid);
    const decodedStream = await readNimiAppArchiveFromFile(validPath, 'valid', {
      retainPredicate: (name) => name === 'payload/__init__.py',
    });
    assert.deepEqual(decodedStream.get('payload/__init__.py').bytes, Buffer.alloc(0));
    assert.equal(decodedStream.get('payload/exact-64k.txt').bytes, null);
    assert.equal(decodedStream.get('payload/exact-64k.txt').size, plain64k.length);

    // BFINAL smuggling rejected on both sync & streaming
    const smuggled = buildRawZip([{
      name: 'payload/smuggle.txt',
      method: 8,
      crc: crc32(plain64k),
      uncompressedSize: plain64k.length,
      compressed: Buffer.concat([comp64k, Buffer.from([0x99])]),
    }]);
    assert.throws(() => readNimiAppArchive(smuggled, 'smuggled'), /trailing bytes|length/u);
    const smuggledPath = path.join(dir, 'smuggled.nimiapp');
    writeFileSync(smuggledPath, smuggled);
    await assert.rejects(() => readNimiAppArchiveFromFile(smuggledPath, 'smuggled'), /trailing bytes|length/u);

    // Streaming overflow guard (lied uncompressedSize << actual inflated size)
    const bomb = buildRawZip([{
      name: 'payload/bomb.txt',
      method: 8,
      crc: crc32(plain64k),
      uncompressedSize: comp64k.length + 10,
      compressed: comp64k,
    }]);
    const bombPath = path.join(dir, 'bomb.nimiapp');
    writeFileSync(bombPath, bomb);
    await assert.rejects(() => readNimiAppArchiveFromFile(bombPath, 'bomb'), /overflow/u);

    // Dirty externalAttrs rejected
    const dirtyAttr = buildRawZip([{
      name: 'payload/a.txt',
      method: 0,
      crc: crc32(Buffer.from('ok')),
      uncompressedSize: 2,
      compressed: Buffer.from('ok'),
      externalAttrs: 0x81A40001,
    }]);
    assert.throws(() => readNimiAppArchive(dirtyAttr, 'dirty'), /unsupported ZIP entry mode/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadExactToFile supports 206 parallel ranges, first-range 200 fallback, and rejects subsequent 200', async (t) => {
  const payload = Buffer.alloc(18 * 1024 * 1024, 0x33);
  for (let i = 0; i < payload.length; i += 4096) payload.writeUInt32LE(i, i);
  const sha = createHash('sha256').update(payload).digest('hex');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nimi-reg-dl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let mode = '206';
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range || '');
    if (mode === 'first-200') {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (mode === 'later-200' && start > 0) {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(payload.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/pkg.nimiapp`;

  // 1. Parallel 206
  const out206 = path.join(dir, '206.nimiapp');
  await downloadExactToFile(url, payload.length, sha, out206, 'pkg');
  assert.equal(Buffer.compare(readFileSync(out206), payload), 0);

  // 2. First-range 200 fallback
  mode = 'first-200';
  const out200 = path.join(dir, '200.nimiapp');
  await downloadExactToFile(url, payload.length, sha, out200, 'pkg');
  assert.equal(Buffer.compare(readFileSync(out200), payload), 0);

  // 3. Subsequent-range 200 rejected cleanly
  mode = 'later-200';
  const outBad = path.join(dir, 'bad.nimiapp');
  await assert.rejects(() => downloadExactToFile(url, payload.length, sha, outBad, 'pkg'), /HTTP 200/u);
});

test('Registry macOS symlink validation blocks component escape and >32 hops', () => {
  const escape = new Map([
    ['payload/a/b/c', { mode: SYMBOLIC_LINK_MODE, bytes: Buffer.from('..') }],
    ['payload/a/b/escape', { mode: SYMBOLIC_LINK_MODE, bytes: Buffer.from('c/../../manifest.json') }],
    ['payload/a/file.txt', { mode: 0o644, bytes: Buffer.from('ok') }],
    ['manifest.json', { mode: 0o644, bytes: Buffer.from('{}') }],
  ]);
  assert.throws(() => validatePayloadLinks(escape, 'macos'), /escapes/u);

  const deepChain = new Map([['payload/dir/target', { mode: 0o644, bytes: Buffer.from('ok') }]]);
  for (let i = 0; i < 33; i += 1) {
    deepChain.set(`payload/dir/l${i}`, {
      mode: SYMBOLIC_LINK_MODE,
      bytes: Buffer.from(i < 32 ? `l${i + 1}` : 'target'),
    });
  }
  assert.throws(() => validatePayloadLinks(deepChain, 'macos'), /Excessive/u);
});
