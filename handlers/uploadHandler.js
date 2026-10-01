const functions = require('firebase-functions');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { validateAdminOrHead } = require('../middlewares/auth');

/**
 * Cloudflare R2 uploads, via short-lived presigned PUT URLs.
 *
 * WHY PRESIGNED AND NOT AN UPLOAD ROUTE: the browser sends the image bytes
 * straight to R2 and this server never sees them. That keeps `express.json`'s
 * body limit irrelevant to images (the old inline-base64 approach blew
 * straight through it), keeps Railway's bandwidth out of the picture, and
 * means a big photo can't tie up a request worker.
 *
 * The URL we hand out is deliberately narrow: it is good for ONE key, ONE
 * content type, ONE content length, for a few minutes, and it is only ever
 * issued to a signed-in admin/folks_head. A leaked URL therefore lets someone
 * write exactly the one object we already agreed to, and nothing else.
 */

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Generous for a resized photo (the client compresses well below this), tight
// enough that nobody parks a video in the bucket.
const MAX_BYTES = 8 * 1024 * 1024;

// Everything this route can touch lives under here, so a crafted `key` can
// never reach another part of the bucket.
const KEY_PREFIX = 'trips/';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Image uploads are not configured: ${name} is missing on the server.`
    );
  }
  return value;
};

let cachedClient = null;
const getClient = () => {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    },
  });
  return cachedClient;
};

const publicUrlFor = (key) => {
  const base = required('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
  return `${base}/${key}`;
};

/**
 * Staff asks for permission to upload one image; we hand back a URL to PUT it
 * to and the public URL it will live at afterwards.
 *
 * data: { contentType, contentLength, folder? }
 */
exports.getUploadUrl = async (data, context) => {
  const staff = await validateAdminOrHead(context);

  const { contentType, contentLength, folder } = data || {};

  const extension = ALLOWED_TYPES[contentType];
  if (!extension) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Only JPEG, PNG and WebP images can be uploaded.'
    );
  }

  const size = Number(contentLength);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Image must be between 1 byte and ${Math.round(MAX_BYTES / (1024 * 1024))} MB.`
    );
  }

  // `folder` is a convenience for grouping (e.g. 'covers', 'locations'), never
  // a path: strip anything that isn't a plain word so it can't escape the
  // prefix with ../ or a leading slash.
  const safeFolder = String(folder || 'misc').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'misc';
  const key = `${KEY_PREFIX}${safeFolder}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;

  // Signing ContentType AND ContentLength binds the upload to exactly what was
  // declared - the browser sets both from the Blob it sends, so a mismatch is
  // rejected by R2 rather than quietly storing something else.
  const command = new PutObjectCommand({
    Bucket: required('R2_BUCKET'),
    Key: key,
    ContentType: contentType,
    ContentLength: size,
  });

  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 300 });

  console.log(`[r2] presigned upload key=${key} by=${staff.uid} bytes=${size}`);

  return { uploadUrl, publicUrl: publicUrlFor(key), key, expiresIn: 300 };
};

/**
 * Remove an image that staff deleted from a trip, so orphans don't pile up.
 * data: { key }  (or a full public URL, which we reduce back to a key)
 */
exports.deleteUpload = async (data, context) => {
  await validateAdminOrHead(context);

  let key = String((data && (data.key || data.url)) || '').trim();

  // Accept the public URL too, since that is what the trip record stores.
  const base = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base && key.startsWith(base)) key = key.slice(base.length + 1);

  // Refuse anything outside our own prefix, and anything with traversal in it.
  if (!key.startsWith(KEY_PREFIX) || key.includes('..')) {
    throw new functions.https.HttpsError('invalid-argument', 'That is not an uploaded trip image.');
  }

  await getClient().send(new DeleteObjectCommand({
    Bucket: required('R2_BUCKET'),
    Key: key,
  }));

  return { deleted: true, key };
};

/**
 * Lets the admin UI tell staff whether uploads will work before they pick a
 * file, instead of failing at save time.
 */
exports.uploadConfig = async (_data, context) => {
  await validateAdminOrHead(context);
  const configured = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_BASE_URL
  );
  return { configured, maxBytes: MAX_BYTES, allowedTypes: Object.keys(ALLOWED_TYPES) };
};
