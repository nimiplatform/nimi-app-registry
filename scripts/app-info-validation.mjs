import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PNG } from 'pngjs';

// Implements the Platform P-NAPP-042 publisher information contract.
export function validatePublishedAppInfo(raw, candidate, target) {
  const fail = (field) => { throw new Error(`App info ${field} is invalid or differs from the reviewed candidate`); };
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 1048576 || raw.length !== target.app_info.size || createHash('sha256').update(raw).digest('hex') !== target.app_info.sha256) fail('asset bytes');
  const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  const allowed = ['format', 'app_id', 'version', 'target_id', 'display_name', 'summary', 'icon', 'readme_markdown', 'release_notes_markdown', 'license', 'app_access', 'capability_contract_refs', 'required_standardized_feature_refs', 'storage_policy', 'author', 'homepage_url', 'support_url'];
  if (Object.keys(info).some((key) => !allowed.includes(key)) || info.format !== 'nimi.app-info/v1' || info.target_id !== target.target_id) fail('format or target');
  for (const field of ['app_id', 'version', 'display_name', 'app_access', 'capability_contract_refs', 'required_standardized_feature_refs', 'storage_policy']) {
    if (!isDeepStrictEqual(info[field], candidate[field])) fail(field);
  }
  const text = (value, field, max, document = false) => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || (document ? Buffer.byteLength(value) : [...value].length) > max || (!document && (value !== value.trim() || /[\r\n]/u.test(value)))) fail(field);
  };
  text(info.display_name, 'display_name', 120);
  text(info.summary, 'summary', 280);
  text(info.readme_markdown, 'readme', 96 * 1024, true);
  text(info.release_notes_markdown, 'release_notes', 32 * 1024, true);
  text(info.license?.text, 'license text', 128 * 1024, true);
  if (info.license.identifier !== candidate.source.license.spdx_expression) fail('license identifier');
  if (info.author) text(info.author, 'author', 200);
  for (const field of ['homepage_url', 'support_url']) {
    if (!info[field]) continue;
    text(info[field], field, 2048);
    const url = new URL(info[field]);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail(field);
  }
  if (info.icon?.media_type !== 'image/png' || typeof info.icon.data_base64 !== 'string') fail('icon');
  const icon = Buffer.from(info.icon.data_base64, 'base64');
  if (icon.length < 33 || icon.length > 512 * 1024 || icon.toString('base64') !== info.icon.data_base64 || icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('icon encoding');
  if (icon.readUInt32BE(8) !== 13 || icon.toString('ascii', 12, 16) !== 'IHDR') fail('icon header');
  const width = icon.readUInt32BE(16);
  if (width < 128 || width > 1024 || icon.readUInt32BE(20) !== width) fail('icon size');
  let ended = false;
  for (let offset = 8; offset + 12 <= icon.length;) {
    const size = icon.readUInt32BE(offset);
    const type = icon.toString('ascii', offset + 4, offset + 8);
    if (size + 12 > icon.length - offset || type === 'acTL') fail('static icon');
    offset += size + 12;
    if (type === 'IEND') { ended = size === 0 && offset === icon.length; break; }
  }
  if (!ended) fail('complete icon');
  const decoded = PNG.sync.read(icon, { checkCRC: true });
  if (!decoded.data.some((value, index) => index % 4 === 3 && value !== 0)) fail('visible icon');
  return info;
}
