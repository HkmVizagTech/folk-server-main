const functions = require('firebase-functions');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { validateAdminOrHead, validateAuth } = require('../middlewares/auth');

/**
 * Cloudflare R2 uploads, taken server-side.
 *
 * The browser POSTs the compressed image to us as a RAW body and this server
 * forwards it to R2. That deliberately keeps the bucket free of any CORS
 * policy: CORS is a browser rule, and once the request to R2 originates here
 * instead of from a page, no browser is involved and no Origin is sent.
 *
 * The trade-off is that image bytes now travel through this service, so the
 * route is fenced in: staff only, image content types only, a hard size cap,
 * and the body is read as a Buffer (never parsed as JSON, which is capped far
 * lower and would mangle binary anyway).
 */

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Generous for a resized photo (the client compresses well below this), tight
// enough that nobody parks a video in the bucket. Keep in step with the
// express.raw({ limit }) on the route in server.js.
const MAX_BYTES = 8 * 1024 * 1024;

// Everything this route can touch lives under one of these, so a crafted key
// can never reach another part of the bucket.
//
// Two prefixes, two audiences. `trips/` is the staff library: covers, galleries
// and location photos that appear on public pages, so only staff may add to it.
// `avatars/` is a member's own profile picture - a devotee has to be able to
// upload one or the avatar never works for anyone but an admin - and it is
// scoped to `avatars/<their uid>/` by the server, never by anything the browser
// sends, so one member can't write into another's folder.
const TRIP_PREFIX = 'trips/';
const AVATAR_PREFIX = 'avatars/';
const KEY_PREFIXES = [TRIP_PREFIX, AVATAR_PREFIX];

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
    // REQUIRED FOR R2. From @aws-sdk/client-s3 v3.729.0 the SDK attaches a
    // CRC32 checksum to PutObject by default, and R2 answers
    // "Header 'x-amz-checksum-crc32' ... not implemented". 'WHEN_REQUIRED'
    // stops the SDK volunteering one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return cachedClient;
};

const publicUrlFor = (key) => {
  const base = required('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
  return `${base}/${key}`;
};

const safeFolder = (value) =>
  String(value || 'misc').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'misc';

/**
 * Express route handler (NOT an onCall handler - the body is binary, so it
 * can't go through the JSON wrapper). Mounted in server.js behind
 * express.raw(), which leaves req.body as a Buffer.
 *
 * POST /uploadImage?folder=covers
 *   Content-Type: image/jpeg
 *   Authorization: Bearer <firebase id token>
 *   body: the raw image bytes
 */
exports.uploadImage = async (req, res) => {
  try {
    // createFirebaseContext in server.js has already verified the bearer token
    // onto req.authContext. ?folder=avatar is the one folder any signed-in
    // member may write to (their own avatar); everything else is staff.
    const context = req.authContext || { auth: null };
    const wantsAvatar = safeFolder(req.query && req.query.folder) === 'avatar';
    // validateAuth hands back a bare uid, validateAdminOrHead a profile object.
    const actorUid = wantsAvatar
      ? await validateAuth(context)
      : (await validateAdminOrHead(context)).uid;

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extension = ALLOWED_TYPES[contentType];
    if (!extension) {
      return res.status(400).json({
        error: { message: 'Only JPEG, PNG and WebP images can be uploaded.', status: 'INVALID_ARGUMENT' },
      });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({
        error: { message: 'No image data was received.', status: 'INVALID_ARGUMENT' },
      });
    }
    if (body.length > MAX_BYTES) {
      return res.status(413).json({
        error: {
          message: `Image is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`,
          status: 'INVALID_ARGUMENT',
        },
      });
    }

    // Don't trust the declared content type alone - check the actual magic
    // bytes, so a .exe renamed to image/jpeg doesn't land in the bucket.
    const sniffed = sniffImageType(body);
    if (!sniffed || sniffed !== contentType) {
      return res.status(400).json({
        error: {
          message: 'That file does not look like a real image.',
          status: 'INVALID_ARGUMENT',
        },
      });
    }

    const stamp = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const key = wantsAvatar
      // The uid comes from the verified token, never from the request, so the
      // folder a member writes into is not something they can choose.
      ? `${AVATAR_PREFIX}${actorUid}/${stamp}`
      : `${TRIP_PREFIX}${safeFolder(req.query && req.query.folder)}/${stamp}`;

    await getClient().send(new PutObjectCommand({
      Bucket: required('R2_BUCKET'),
      Key: key,
      Body: body,
      ContentType: contentType,
      // Long cache: object keys are unique per upload, so a changed image is
      // always a new URL and this can never go stale.
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    console.log(`[r2] uploaded key=${key} by=${actorUid} bytes=${body.length}`);
    return res.status(200).json({ publicUrl: publicUrlFor(key), key, bytes: body.length });
  } catch (error) {
    const code = error && error.code;
    const status =
      code === 'unauthenticated' ? 401 :
      code === 'permission-denied' ? 403 :
      code === 'failed-precondition' ? 503 : 500;
    console.error('[r2] upload failed:', error && error.message);
    return res.status(status).json({
      error: { message: (error && error.message) || 'Upload failed', status: String(code || 'INTERNAL').toUpperCase() },
    });
  }
};

/** Magic-number check for the three formats we accept. */
function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}

/**
 * Remove an image staff deleted from a trip, so orphans don't pile up.
 * Stays an onCall handler - its payload is small JSON.
 * data: { key } or { url }
 */
exports.deleteUpload = async (data, context) => {
  const uid = await validateAuth(context);

  let key = String((data && (data.key || data.url)) || '').trim();

  // Accept the public URL too, since that is what the trip record stores.
  const base = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base && key.startsWith(base)) key = key.slice(base.length + 1);

  // Refuse anything outside our own prefixes, and anything with traversal in it.
  if (!KEY_PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) {
    throw new functions.https.HttpsError('invalid-argument', 'That is not an uploaded FOLK image.');
  }

  // A member may delete their own old avatar (replacing a picture should not
  // leave the previous one in the bucket forever); everything else is staff.
  if (key.startsWith(AVATAR_PREFIX)) {
    if (key.split('/')[1] !== uid) await validateAdminOrHead(context);
  } else {
    await validateAdminOrHead(context);
  }

  await getClient().send(new DeleteObjectCommand({
    Bucket: required('R2_BUCKET'),
    Key: key,
  }));

  return { deleted: true, key };
};

/**
 * Lets the admin UI tell staff whether uploads will work before they pick a
 * file, instead of failing once they've chosen one.
 */
exports.uploadConfig = async (_data, context) => {
  // Any signed-in member can ask: the Profile page needs the same answer before
  // it offers an avatar picker. Only variable NAMES are ever returned.
  await validateAuth(context);

  // Report WHICH settings are absent, not just that something is. Variable
  // NAMES are safe to return (values never are), and "R2_PUBLIC_BASE_URL is
  // missing" is the difference between a fix and a guessing game. A value of
  // whitespace counts as missing - that's a real way to mis-paste into a
  // dashboard and it otherwise looks set.
  const REQUIRED = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ];
  const missing = REQUIRED.filter((name) => !String(process.env[name] || '').trim());

  return {
    configured: missing.length === 0,
    missing,
    maxBytes: MAX_BYTES,
    allowedTypes: Object.keys(ALLOWED_TYPES),
  };
};
