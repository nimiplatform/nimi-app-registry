// @nimi-authority: rule.nimi.platform.app-ecosystem.p-napp-042a
// @nimi-authority: rule.nimi.platform.app-ecosystem.p-napp-042b
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

export const STOREFRONT_CATEGORIES = Object.freeze([
  'companions-worlds',
  'lifestyle',
  'writing-notes',
  'design-diagrams',
  'audio-music',
  'video-media',
  'research-learning',
  'productivity-automation',
  'developer-tools',
]);

export const STOREFRONT_IMAGE_MAX_BYTES = 512 * 1024;
export const STOREFRONT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const STOREFRONT_COVER_BOUNDS = Object.freeze({ minW: 800, maxW: 2560, minH: 450, maxH: 1600 });
export const STOREFRONT_GALLERY_BOUNDS = Object.freeze({ minW: 640, maxW: 2560, minH: 360, maxH: 1600 });
export const STOREFRONT_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
export const STOREFRONT_GALLERY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const STOREFRONT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function storefrontMediaExtension(mediaType) {
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/png') return 'png';
  throw new Error(`Unsupported storefront image media type: ${mediaType}`);
}

function assertText(value, field, max, multiline = false) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.includes('\0')
    || (multiline ? Buffer.byteLength(value) : [...value].length) > max
    || (!multiline && (value !== value.trim() || /[\r\n]/u.test(value)))
  ) {
    throw new Error(`App info storefront ${field} is invalid`);
  }
}

function assertLocale(value, field) {
  if (typeof value !== 'string' || value.length > 16 || !STOREFRONT_LOCALE_PATTERN.test(value)) {
    throw new Error(`App info storefront ${field} is not a valid locale`);
  }
}

function assertImageRef(ref, bounds, field) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`App info storefront ${field} must be an object`);
  for (const key of Object.keys(ref)) {
    if (!['media_type', 'width', 'height', 'size', 'sha256'].includes(key)) {
      throw new Error(`App info storefront ${field} contains unsupported field ${key}`);
    }
  }
  if (!['image/webp', 'image/png'].includes(ref.media_type)) throw new Error(`App info storefront ${field} media_type is unsupported`);
  if (
    !Number.isInteger(ref.width) || !Number.isInteger(ref.height)
    || ref.width < bounds.minW || ref.width > bounds.maxW || ref.height < bounds.minH || ref.height > bounds.maxH
  ) {
    throw new Error(`App info storefront ${field} dimensions are out of bounds`);
  }
  if (!Number.isInteger(ref.size) || ref.size <= 0 || ref.size > STOREFRONT_IMAGE_MAX_BYTES || !STOREFRONT_SHA256_PATTERN.test(ref.sha256)) {
    throw new Error(`App info storefront ${field} size or sha256 is invalid`);
  }
}

export function validateAppInfoStorefront(storefront) {
  if (!storefront || typeof storefront !== 'object' || Array.isArray(storefront)) throw new Error('App info storefront must be an object');
  for (const key of Object.keys(storefront)) {
    if (!['category', 'default_locale', 'locales', 'media'].includes(key)) {
      throw new Error(`App info storefront contains unsupported field ${key}`);
    }
  }
  if (!STOREFRONT_CATEGORIES.includes(storefront.category)) throw new Error(`App info storefront category is unsupported: ${storefront.category}`);
  assertLocale(storefront.default_locale, 'default_locale');
  const defaultLocale = storefront.default_locale;

  if (storefront.locales !== undefined) {
    if (!storefront.locales || typeof storefront.locales !== 'object' || Array.isArray(storefront.locales)) {
      throw new Error('App info storefront.locales must be an object');
    }
    const entries = Object.entries(storefront.locales);
    if (entries.length > 16) throw new Error('App info storefront.locales exceeds 16 entries');
    for (const [locale, entry] of entries) {
      assertLocale(locale, 'locales key');
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`App info storefront.locales.${locale} must be an object`);
      for (const key of Object.keys(entry)) {
        if (!['display_name', 'summary', 'tags', 'highlights', 'introduction_markdown'].includes(key)) {
          throw new Error(`App info storefront.locales.${locale} contains unsupported field ${key}`);
        }
      }
      if (locale === defaultLocale) {
        if (entry.display_name !== undefined || entry.summary !== undefined || entry.introduction_markdown !== undefined) {
          throw new Error(`App info storefront.locales.${locale} must not duplicate default top-level fields`);
        }
      } else {
        if (entry.display_name !== undefined) assertText(entry.display_name, `locales.${locale}.display_name`, 120);
        if (entry.summary !== undefined) assertText(entry.summary, `locales.${locale}.summary`, 280);
        if (entry.introduction_markdown !== undefined) assertText(entry.introduction_markdown, `locales.${locale}.introduction_markdown`, 96 * 1024, true);
      }
      if (entry.tags !== undefined) {
        if (!Array.isArray(entry.tags) || entry.tags.length > 5 || new Set(entry.tags).size !== entry.tags.length) {
          throw new Error(`App info storefront.locales.${locale}.tags is invalid`);
        }
        for (const tag of entry.tags) assertText(tag, `locales.${locale}.tags`, 32);
      }
      if (entry.highlights !== undefined) {
        if (!Array.isArray(entry.highlights) || entry.highlights.length > 4) {
          throw new Error(`App info storefront.locales.${locale}.highlights is invalid`);
        }
        for (const item of entry.highlights) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`App info storefront.locales.${locale}.highlights item must be an object`);
          for (const key of Object.keys(item)) {
            if (!['title', 'description'].includes(key)) throw new Error(`App info storefront highlight contains unsupported field ${key}`);
          }
          assertText(item.title, `locales.${locale}.highlights.title`, 60);
          assertText(item.description, `locales.${locale}.highlights.description`, 200);
        }
      }
    }
  }

  if (storefront.media !== undefined) {
    const media = storefront.media;
    if (!media || typeof media !== 'object' || Array.isArray(media)) throw new Error('App info storefront.media must be an object');
    for (const key of Object.keys(media)) {
      if (!['cover', 'gallery'].includes(key)) throw new Error(`App info storefront.media contains unsupported field ${key}`);
    }
    if (media.cover === undefined && (!Array.isArray(media.gallery) || media.gallery.length === 0)) {
      throw new Error('App info storefront.media must declare cover or gallery');
    }
    if (media.cover !== undefined) {
      if (!media.cover || typeof media.cover !== 'object' || Array.isArray(media.cover)) throw new Error('App info storefront.media.cover must be an object');
      for (const key of Object.keys(media.cover)) {
        if (!['default', 'locales'].includes(key)) throw new Error(`App info storefront.media.cover contains unsupported field ${key}`);
      }
      assertImageRef(media.cover.default, STOREFRONT_COVER_BOUNDS, 'media.cover.default');
      if (media.cover.locales !== undefined) {
        if (!media.cover.locales || typeof media.cover.locales !== 'object' || Array.isArray(media.cover.locales)) {
          throw new Error('App info storefront.media.cover.locales must be an object');
        }
        const entries = Object.entries(media.cover.locales);
        if (entries.length > 15) throw new Error('App info storefront.media.cover.locales exceeds 15 entries');
        for (const [locale, ref] of entries) {
          assertLocale(locale, 'media.cover.locales key');
          if (locale === defaultLocale) throw new Error('App info storefront.media.cover.locales must not duplicate default_locale');
          assertImageRef(ref, STOREFRONT_COVER_BOUNDS, `media.cover.locales.${locale}`);
        }
      }
    }
    if (media.gallery !== undefined) {
      if (!Array.isArray(media.gallery) || media.gallery.length > 6) throw new Error('App info storefront.media.gallery exceeds 6 items');
      const seenIds = new Set();
      for (const item of media.gallery) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('App info storefront.media.gallery item must be an object');
        for (const key of Object.keys(item)) {
          if (!['id', 'kind', 'default', 'locales', 'caption'].includes(key)) {
            throw new Error(`App info storefront.media.gallery item contains unsupported field ${key}`);
          }
        }
        if (typeof item.id !== 'string' || !STOREFRONT_GALLERY_ID_PATTERN.test(item.id) || seenIds.has(item.id)) {
          throw new Error(`App info storefront.media.gallery id is invalid or duplicated: ${item.id}`);
        }
        seenIds.add(item.id);
        if (item.kind !== 'image') throw new Error(`App info storefront.media.gallery.${item.id} kind must be image`);
        assertImageRef(item.default, STOREFRONT_GALLERY_BOUNDS, `media.gallery.${item.id}.default`);
        if (item.locales !== undefined) {
          if (!item.locales || typeof item.locales !== 'object' || Array.isArray(item.locales)) {
            throw new Error(`App info storefront.media.gallery.${item.id}.locales must be an object`);
          }
          const entries = Object.entries(item.locales);
          if (entries.length > 15) throw new Error(`App info storefront.media.gallery.${item.id}.locales exceeds 15 entries`);
          for (const [locale, ref] of entries) {
            assertLocale(locale, `media.gallery.${item.id}.locales key`);
            if (locale === defaultLocale) throw new Error(`App info storefront.media.gallery.${item.id}.locales must not duplicate default_locale`);
            assertImageRef(ref, STOREFRONT_GALLERY_BOUNDS, `media.gallery.${item.id}.locales.${locale}`);
          }
        }
        if (item.caption !== undefined) {
          if (!item.caption || typeof item.caption !== 'object' || Array.isArray(item.caption)) {
            throw new Error(`App info storefront.media.gallery.${item.id}.caption must be an object`);
          }
          const entries = Object.entries(item.caption);
          if (entries.length > 16) throw new Error(`App info storefront.media.gallery.${item.id}.caption exceeds 16 entries`);
          for (const [locale, captionText] of entries) {
            assertLocale(locale, `media.gallery.${item.id}.caption key`);
            assertText(captionText, `media.gallery.${item.id}.caption.${locale}`, 200);
          }
        }
      }
    }
  }
}

export function inspectStaticStorefrontImage(bytes, bounds, label = 'storefront image') {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > STOREFRONT_IMAGE_MAX_BYTES) {
    throw new Error(`${label} must be a nonempty static WebP or PNG of at most ${STOREFRONT_IMAGE_MAX_BYTES} bytes`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) throw new Error(`${label} PNG chunk is truncated`);
      if (type === 'acTL') throw new Error(`${label} animated PNG (APNG) is not allowed`);
      if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error(`${label} PNG header is invalid`);
      if (type === 'IHDR') {
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
      }
      offset += length + 12;
      if (type === 'IEND') {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) throw new Error(`${label} PNG is truncated or has trailing bytes`);
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) throw new Error(`${label} PNG dimensions are inconsistent`);
    if (width < bounds.minW || width > bounds.maxW || height < bounds.minH || height > bounds.maxH) {
      throw new Error(`${label} dimensions ${width}x${height} are outside allowed bounds`);
    }
    return { media_type: 'image/png', width, height, size: bytes.length, sha256 };
  }

  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const riffSize = bytes.readUInt32LE(4);
    if (riffSize + 8 !== bytes.length) throw new Error(`${label} WebP RIFF size does not match file length`);
    let offset = 12;
    let width = 0;
    let height = 0;
    let hasBitstream = false;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error(`${label} WebP chunk header is truncated`);
      const type = bytes.toString('ascii', offset, offset + 4);
      const chunkSize = bytes.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      const paddedEnd = dataStart + chunkSize + (chunkSize & 1);
      if (paddedEnd > bytes.length) throw new Error(`${label} WebP chunk ${type} is truncated`);
      if (type === 'ANIM' || type === 'ANMF') throw new Error(`${label} animated WebP is not allowed`);
      if (type === 'VP8X') {
        if (chunkSize !== 10) throw new Error(`${label} WebP VP8X chunk is invalid`);
        if ((bytes[dataStart] & 0x02) !== 0) throw new Error(`${label} animated WebP (VP8X animation flag) is not allowed`);
        width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
        height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
      } else if (type === 'VP8 ') {
        if (chunkSize < 10 || (bytes[dataStart] & 0x01) !== 0 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
          throw new Error(`${label} WebP VP8 keyframe header is invalid`);
        }
        if (width === 0 && height === 0) {
          width = bytes.readUInt16LE(dataStart + 6) & 0x3fff;
          height = bytes.readUInt16LE(dataStart + 8) & 0x3fff;
        }
        hasBitstream = true;
      } else if (type === 'VP8L') {
        if (chunkSize < 5 || bytes[dataStart] !== 0x2f) throw new Error(`${label} WebP VP8L header is invalid`);
        const bits = bytes.readUInt32LE(dataStart + 1);
        if (width === 0 && height === 0) {
          width = (bits & 0x3fff) + 1;
          height = ((bits >>> 14) & 0x3fff) + 1;
        }
        hasBitstream = true;
      }
      offset = paddedEnd;
    }
    if (!hasBitstream || width <= 0 || height <= 0) throw new Error(`${label} WebP is missing image bitstream or dimensions`);
    if (width < bounds.minW || width > bounds.maxW || height < bounds.minH || height > bounds.maxH) {
      throw new Error(`${label} dimensions ${width}x${height} are outside allowed bounds`);
    }
    return { media_type: 'image/webp', width, height, size: bytes.length, sha256 };
  }

  throw new Error(`${label} must be a static WebP or PNG image`);
}

export function validateStorefrontMediaArchiveEntries(entries, media) {
  const expected = new Map();
  const register = (ref, bounds, label) => {
    const filename = `${ref.sha256}.${storefrontMediaExtension(ref.media_type)}`;
    const prior = expected.get(filename);
    if (prior) {
      if (prior.ref.width !== ref.width || prior.ref.height !== ref.height || prior.ref.size !== ref.size || prior.ref.media_type !== ref.media_type) {
        throw new Error(`Storefront media manifest disagrees on ${filename}`);
      }
      // Tighten bounds to the intersection so a shared image referenced as both cover and gallery satisfies both.
      prior.bounds = {
        minW: Math.max(prior.bounds.minW, bounds.minW),
        maxW: Math.min(prior.bounds.maxW, bounds.maxW),
        minH: Math.max(prior.bounds.minH, bounds.minH),
        maxH: Math.min(prior.bounds.maxH, bounds.maxH),
      };
      return;
    }
    expected.set(filename, { ref, bounds, label });
  };
  if (media?.cover) {
    register(media.cover.default, STOREFRONT_COVER_BOUNDS, 'cover.default');
    for (const [locale, ref] of Object.entries(media.cover.locales || {})) {
      register(ref, STOREFRONT_COVER_BOUNDS, `cover.locales.${locale}`);
    }
  }
  for (const item of media?.gallery || []) {
    register(item.default, STOREFRONT_GALLERY_BOUNDS, `gallery.${item.id}.default`);
    for (const [locale, ref] of Object.entries(item.locales || {})) {
      register(ref, STOREFRONT_GALLERY_BOUNDS, `gallery.${item.id}.locales.${locale}`);
    }
  }

  if (entries.size !== expected.size) {
    throw new Error(`Storefront media archive file count (${entries.size}) does not match declared image manifest (${expected.size})`);
  }
  for (const [name, entry] of entries) {
    if (entry.mode !== 0o644) throw new Error(`Storefront media entry ${name} must be a regular 0644 file`);
    const spec = expected.get(name);
    if (!spec) throw new Error(`Storefront media archive contains undeclared orphan file: ${name}`);
    const inspected = inspectStaticStorefrontImage(entry.bytes, spec.bounds, `storefront media ${spec.label} (${name})`);
    if (
      inspected.media_type !== spec.ref.media_type
      || inspected.width !== spec.ref.width
      || inspected.height !== spec.ref.height
      || inspected.size !== spec.ref.size
      || inspected.sha256 !== spec.ref.sha256
    ) {
      throw new Error(`Storefront media entry ${name} does not match declared ImageRef`);
    }
  }
  return expected.size;
}
