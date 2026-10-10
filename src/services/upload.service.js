'use strict';

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const env = require('../config/env');
const { HttpsError } = require('../utils/errors');

/**
 * Cloudflare R2 uploads, taken server-side.
 *
 * The browser POSTs the compressed image to us as a RAW body and this server
 * forwards it to R2. That keeps the bucket free of any CORS policy: CORS is a
 * browser rule, and once the request to R2 originates here no Origin is sent.
 * The route is fenced in: signed-in only (staff for anything but avatars),
 * image content types only, a hard size cap, and magic-byte sniffing.
 */

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Generous for a resized photo, tight enough that nobody parks a video in the
// bucket. Keep in step with the express.raw({ limit }) on the route.
const MAX_BYTES = 8 * 1024 * 1024;

// Everything this service can touch lives under one of these, so a crafted key
// can never reach another part of the bucket. `trips/` is the staff library
// (public pages); `avatars/<uid>/` is a member's own picture, scoped by the
// server from the verified token, never by anything the browser sends.
const TRIP_PREFIX = 'trips/';
const AVATAR_PREFIX = 'avatars/';
const KEY_PREFIXES = [TRIP_PREFIX, AVATAR_PREFIX];

const REQUIRED_SETTINGS = {
  R2_ACCOUNT_ID: 'accountId',
  R2_ACCESS_KEY_ID: 'accessKeyId',
  R2_SECRET_ACCESS_KEY: 'secretAccessKey',
  R2_BUCKET: 'bucket',
  R2_PUBLIC_BASE_URL: 'publicBaseUrl',
};

const required = (name) => {
  const value = env.r2[REQUIRED_SETTINGS[name]];
  if (!value) {
    throw new HttpsError(
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

const publicUrlFor = (key) => `${required('R2_PUBLIC_BASE_URL').replace(/\/+$/, '')}/${key}`;

const safeFolder = (value) =>
  String(value || 'misc').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'misc';

/** Magic-number check for the three formats we accept. */
const sniffImageType = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

/** Build a unique object key; avatars go under the caller's own uid. */
const buildKey = ({ avatar, actorUid, folder, extension }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  return avatar
    ? `${AVATAR_PREFIX}${actorUid}/${stamp}`
    : `${TRIP_PREFIX}${safeFolder(folder)}/${stamp}`;
};

const putImage = async ({ key, body, contentType }) => {
  await getClient().send(new PutObjectCommand({
    Bucket: required('R2_BUCKET'),
    Key: key,
    Body: body,
    ContentType: contentType,
    // Long cache: object keys are unique per upload, so this can never go stale.
    CacheControl: 'public, max-age=31536000, immutable',
  }));
};

/**
 * Normalise a `key` or public URL into a bucket key, or throw if it is not
 * one of ours. Also reports whether it is an avatar and which uid owns it.
 */
const parseKey = (input) => {
  let key = String(input || '').trim();
  // Accept the public URL too, since that is what the trip record stores.
  const base = env.r2.publicBaseUrl.replace(/\/+$/, '');
  if (base && key.startsWith(base)) key = key.slice(base.length + 1);

  // Refuse anything outside our own prefixes, and anything with traversal in it.
  if (!KEY_PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) {
    throw new HttpsError('invalid-argument', 'That is not an uploaded FOLK image.');
  }
  const isAvatar = key.startsWith(AVATAR_PREFIX);
  return { key, isAvatar, ownerUid: isAvatar ? key.split('/')[1] : null };
};

const deleteObject = (key) =>
  getClient().send(new DeleteObjectCommand({ Bucket: required('R2_BUCKET'), Key: key }));

/** Which R2 settings are absent (names only; whitespace counts as missing). */
const getUploadConfig = () => {
  const missing = Object.keys(REQUIRED_SETTINGS)
    .filter((name) => !String(env.r2[REQUIRED_SETTINGS[name]] || '').trim());
  return {
    configured: missing.length === 0,
    missing,
    maxBytes: MAX_BYTES,
    allowedTypes: Object.keys(ALLOWED_TYPES),
  };
};

module.exports = {
  ALLOWED_TYPES, MAX_BYTES, safeFolder, sniffImageType, buildKey, putImage,
  publicUrlFor, parseKey, deleteObject, getUploadConfig,
};
