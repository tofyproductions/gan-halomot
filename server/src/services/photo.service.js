const sharp = require('sharp');
const storage = require('./storage.service');

/**
 * Turning what a phone produces into what a gallery can serve.
 *
 * A modern phone photograph is three to five megabytes, several thousand
 * pixels wide, and often HEIC — which Safari renders and nothing else does.
 * Stored as-is, a class gallery of twenty would be eighty megabytes down a
 * parent's mobile connection to fill a screen 400 pixels across.
 *
 * So every upload becomes two JPEGs: one sized for looking at, one for the
 * grid. The original is deliberately NOT kept. It is the only decision here
 * that cannot be undone later, and it is the right one — the gan wants
 * photographs of children, not archival masters, and keeping both would be ten
 * times the storage for a fidelity nobody will ever open.
 *
 * 1600px still prints a decent 15x20 photo gift, which is what these are for.
 */

const FULL_MAX = 1600;
const THUMB_MAX = 400;
const FULL_QUALITY = 82;
const THUMB_QUALITY = 70;

/** What a browser is allowed to hand us, whatever it claims in the filename. */
const ACCEPTED_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function isAcceptable(file) {
  return Boolean(file && ACCEPTED_MIME.test(file.mimetype || '') && file.size <= MAX_UPLOAD_BYTES);
}

/**
 * Resize, strip and re-encode.
 *
 * `rotate()` with no argument applies the EXIF orientation and then drops it —
 * without it, a photo taken in portrait arrives sideways in every browser that
 * ignores the tag. Metadata goes with it, which matters more than it sounds:
 * a phone photograph carries GPS coordinates, and these are photographs of
 * children at an address the gan does not publish.
 */
async function renderVariants(buffer) {
  const base = sharp(buffer, { failOn: 'none' }).rotate();
  const meta = await base.metadata();

  const full = await base
    .clone()
    .resize({ width: FULL_MAX, height: FULL_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: FULL_QUALITY, mozjpeg: true })
    .toBuffer();

  const thumb = await base
    .clone()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();

  // Orientation swaps the reported dimensions for a rotated photo, and the
  // gallery uses them to reserve space before the image loads.
  const rotated = (meta.orientation || 1) >= 5;
  return {
    full,
    thumb,
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
  };
}

/**
 * Process one upload and put both sizes in storage.
 *
 * Returns what the Photo row needs. Throws on anything sharp cannot read —
 * a corrupt file, or a PDF renamed to .jpg — rather than storing a broken
 * object that a gallery will later fail to display with no explanation.
 */
async function storeUpload({ buffer, prefix }) {
  const { full, thumb, width, height } = await renderVariants(buffer);

  const key = storage.makeKey(prefix, 'jpg');
  const thumbKey = key.replace(/\.jpg$/, '_t.jpg');

  await storage.putObject({ key, body: full, contentType: 'image/jpeg' });
  await storage.putObject({ key: thumbKey, body: thumb, contentType: 'image/jpeg' });

  return { key, thumb_key: thumbKey, width: width || 0, height: height || 0, bytes: full.length };
}

/**
 * Attach signed links to rows on their way out.
 *
 * Done in one place because it is the step that must never be forgotten: a row
 * without links is a broken image, and a row whose links were stored rather
 * than minted is a photograph reachable after the permission expired.
 */
async function withUrls(rows) {
  return Promise.all(rows.map(async (r) => ({
    ...r,
    url: await storage.signedReadUrl(r.key),
    thumb_url: r.thumb_key ? await storage.signedReadUrl(r.thumb_key) : await storage.signedReadUrl(r.key),
  })));
}

module.exports = {
  isAcceptable, renderVariants, storeUpload, withUrls,
  MAX_UPLOAD_BYTES, FULL_MAX, THUMB_MAX,
};
