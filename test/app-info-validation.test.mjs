import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PNG } from 'pngjs';
import { validatePublishedAppInfo } from '../scripts/app-info-validation.mjs';

function fixture() {
  const declaration = { app_id: 'publisher.example-app', version: '1.2.3', display_name: 'Example', app_access: [], capability_contract_refs: [], required_standardized_feature_refs: [], storage_policy: { kind: 'nimi-mediated-default', os_storage_disclosure: null } };
  const info = { ...declaration, format: 'nimi.app-info/v1', target_id: 'macos-aarch64', summary: 'An example application.', icon: { media_type: 'image/png', data_base64: PNG.sync.write({ width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4, 255) }).toString('base64') }, readme_markdown: 'Use the App.', release_notes_markdown: 'Initial release.', license: { identifier: 'MIT', text: 'MIT license text' }, author: '', homepage_url: '', support_url: '' };
  const raw = Buffer.from(JSON.stringify(info));
  const candidate = { ...declaration, source: { license: { spdx_expression: 'MIT' } } };
  const target = { target_id: 'macos-aarch64', app_info: { size: raw.length, sha256: createHash('sha256').update(raw).digest('hex') } };
  return { info, raw, candidate, target };
}

test('information asset preserves the reviewed identity, declarations and resource bytes', () => {
  const { raw, candidate, target } = fixture();
  assert.equal(validatePublishedAppInfo(raw, candidate, target).display_name, 'Example');
  assert.throws(() => validatePublishedAppInfo(Buffer.concat([raw, Buffer.from(' ')]), candidate, target), /asset bytes/u);
  candidate.display_name = 'Another App';
  assert.throws(() => validatePublishedAppInfo(raw, candidate, target), /display_name/u);
});

test('review rejects incomplete or invisible artwork and missing documentation even with matching asset digests', () => {
  for (const change of [
    (info) => { info.summary = ''; },
    (info) => { info.readme_markdown = ''; },
    (info) => { info.icon.data_base64 = Buffer.from('invalid PNG').toString('base64'); },
    (info) => { info.icon.data_base64 = PNG.sync.write({ width: 128, height: 128, data: Buffer.alloc(128 * 128 * 4) }).toString('base64'); },
  ]) {
    const { info, candidate, target } = fixture();
    change(info);
    const raw = Buffer.from(JSON.stringify(info));
    target.app_info = { size: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
    assert.throws(() => validatePublishedAppInfo(raw, candidate, target), /App info/u);
  }
});
