const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../config/env');

/**
 * Where files live, now that some of them are photographs.
 *
 * Everything this system stores today is base64 inside a MongoDB document —
 * contracts, ID copies, payment proofs. That works for a PDF and falls over
 * for photographs: a document is capped at 16MB, base64 inflates by a third,
 * and 220 children with a year of photos is roughly 180GB. Held that way it
 * would be a database that cannot be backed up and a gallery that loads
 * through it.
 *
 * So photographs go to object storage and the database keeps only the key.
 * Which storage is configuration: Supabase, Cloudflare R2 and S3 all speak the
 * same protocol, so the gan can use the Supabase it already pays for rather
 * than open a second account.
 *
 * The bucket is PRIVATE. Nothing here ever returns a public URL: reads are
 * short-lived signed links, minted per request for a parent the server has
 * already checked. A public bucket would mean a photograph of somebody's child
 * reachable forever by anyone who ever saw the address, which is exactly the
 * failure this application spends its effort preventing everywhere else.
 */

const READ_URL_TTL_S = 60 * 30; // long enough to scroll a gallery, short
                                // enough that a copied link dies the same hour

let client = null;

/**
 * Where the bucket actually is.
 *
 * Deliberately not tied to one vendor. Cloudflare R2 and Supabase Storage both
 * speak the S3 protocol, and so does S3 itself — which means the choice is an
 * endpoint and a pair of keys, not a rewrite. The gan already pays for
 * Supabase; being able to use that instead of opening a second account is
 * worth the one function this costs.
 *
 * R2 gets a shortcut because its endpoint is derivable from an account id, and
 * that is the only vendor-specific line in this file.
 */
function endpointConfig() {
  if (env.STORAGE_ENDPOINT) {
    return { endpoint: env.STORAGE_ENDPOINT, region: env.STORAGE_REGION || 'auto' };
  }
  if (env.R2_ACCOUNT_ID) {
    return { endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: 'auto' };
  }
  return null;
}

const accessKey = () => env.STORAGE_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
const secretKey = () => env.STORAGE_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
const bucketName = () => env.STORAGE_BUCKET || env.R2_BUCKET;

function isConfigured() {
  return Boolean(endpointConfig() && accessKey() && secretKey() && bucketName());
}

/** Built once, on first use. */
function getClient() {
  if (!isConfigured()) {
    throw new Error('אחסון התמונות אינו מוגדר (STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY / STORAGE_BUCKET)');
  }
  if (!client) {
    const { endpoint, region } = endpointConfig();
    client = new S3Client({
      region,
      endpoint,
      // Supabase and R2 both address buckets by path rather than by
      // subdomain; the SDK defaults to the subdomain form and would sign a
      // request for a host that does not exist.
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey(), secretAccessKey: secretKey() },
    });
  }
  return client;
}

/**
 * A storage key that leaks nothing.
 *
 * Not the original filename: phones name photos after the date and the place,
 * and a key is a string that ends up in logs and in signed URLs. The prefix
 * groups a branch's objects together for anyone ever reading the bucket by
 * hand; the random part is what makes it unguessable.
 */
// Photographs were the first thing to live here, but not the last: a signed
// contract is a scan, and a scan from a phone is routinely larger than the
// 16MB a MongoDB document can hold. 'pdf' is on the list for that.
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'];

function makeKey(prefix, ext = 'jpg') {
  // An allowlist, not a scrub. Stripping the punctuation out of
  // `jpg"; rm -rf /` leaves `jpgrm`, which is harmless and also not a file
  // type — the key would name something nothing can open.
  const cleanedExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase();
  const safeExt = ALLOWED_EXT.includes(cleanedExt) ? cleanedExt : 'jpg';

  // Dots go before anything else: the slash has to survive (the prefix is a
  // path) and `..` is the only reason a caller would want one. Then empty
  // segments collapse, so `../../etc` cannot come out as `//etc` still
  // pointing above where it was meant to be.
  const safePrefix = String(prefix)
    .replace(/[^a-zA-Z0-9/_-]/g, '')
    .split('/')
    .filter(Boolean)
    .join('/')
    .slice(0, 80)
    .replace(/\/+$/, '');

  const base = safePrefix || 'misc';
  return `${base}/${crypto.randomBytes(16).toString('hex')}.${safeExt}`;
}

async function putObject({ key, body, contentType }) {
  await getClient().send(new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

/**
 * A link the browser can follow, valid for half an hour.
 *
 * Minted per request rather than stored: the permission it represents is the
 * caller's, checked a moment ago, and a URL saved next to the record would
 * outlive the reason it was issued.
 */
function signedReadUrl(key, ttlSeconds = READ_URL_TTL_S) {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    { expiresIn: ttlSeconds }
  );
}

async function deleteObject(key) {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

module.exports = {
  isConfigured, makeKey, putObject, signedReadUrl, deleteObject, READ_URL_TTL_S,
};
