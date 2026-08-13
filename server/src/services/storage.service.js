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
 * So photographs go to object storage — Cloudflare R2, which speaks the S3
 * protocol — and the database keeps only the key.
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

function isConfigured() {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
  );
}

/**
 * Built once, on first use. R2 presents itself as S3 in one region ('auto'),
 * addressed by account id.
 */
function getClient() {
  if (!isConfigured()) {
    throw new Error('אחסון התמונות אינו מוגדר (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)');
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
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
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic'];

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
    Bucket: env.R2_BUCKET,
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
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn: ttlSeconds }
  );
}

async function deleteObject(key) {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

module.exports = {
  isConfigured, makeKey, putObject, signedReadUrl, deleteObject, READ_URL_TTL_S,
};
