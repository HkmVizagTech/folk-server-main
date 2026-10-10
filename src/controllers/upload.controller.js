'use strict';

const { validateAdminOrHead, validateAuth } = require('../middlewares/auth');
const uploads = require('../services/upload.service');
const { errorBody } = require('../utils/errors');
const log = require('../utils/logger').create('r2');

const badRequest = (res, message) => res.status(400).json(errorBody(message, 'INVALID_ARGUMENT'));

/**
 * POST /uploadImage?folder=covers   (raw body, mounted behind express.raw())
 *   Content-Type: image/jpeg|png|webp
 *   Authorization: Bearer <firebase id token>
 * Express handler, NOT onCall: the body is binary. ?folder=avatar is the one
 * folder any signed-in member may write to (their own avatar); the rest is staff.
 */
exports.uploadImage = async (req, res) => {
  try {
    const context = req.authContext || { auth: null };
    const folder = req.query && req.query.folder;
    const wantsAvatar = uploads.safeFolder(folder) === 'avatar';
    // validateAuth hands back a bare uid, validateAdminOrHead a profile object.
    const actorUid = wantsAvatar
      ? await validateAuth(context)
      : (await validateAdminOrHead(context)).uid;

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extension = uploads.ALLOWED_TYPES[contentType];
    if (!extension) return badRequest(res, 'Only JPEG, PNG and WebP images can be uploaded.');

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return badRequest(res, 'No image data was received.');
    if (body.length > uploads.MAX_BYTES) {
      return res.status(413).json(errorBody(
        `Image is too large (max ${Math.round(uploads.MAX_BYTES / (1024 * 1024))} MB).`,
        'INVALID_ARGUMENT'
      ));
    }

    // Don't trust the declared content type alone: check the actual magic bytes.
    if (uploads.sniffImageType(body) !== contentType) {
      return badRequest(res, 'That file does not look like a real image.');
    }

    const key = uploads.buildKey({ avatar: wantsAvatar, actorUid, folder, extension });
    await uploads.putImage({ key, body, contentType });

    log.info(`uploaded key=${key} by=${actorUid} bytes=${body.length}`);
    return res.status(200).json({ publicUrl: uploads.publicUrlFor(key), key, bytes: body.length });
  } catch (error) {
    const code = error && error.code;
    const status =
      code === 'unauthenticated' ? 401 :
      code === 'permission-denied' ? 403 :
      code === 'failed-precondition' ? 503 : 500;
    log.error('upload failed:', error && error.message);
    return res.status(status).json(
      errorBody((error && error.message) || 'Upload failed', String(code || 'INTERNAL').toUpperCase())
    );
  }
};

/** POST /deleteUpload { key | url }: remove an image so orphans don't pile up. */
exports.deleteUpload = async (data, context) => {
  const uid = await validateAuth(context);
  const { key, isAvatar, ownerUid } = uploads.parseKey(data && (data.key || data.url));

  // A member may delete their own old avatar; everything else is staff.
  if (!isAvatar || ownerUid !== uid) await validateAdminOrHead(context);

  await uploads.deleteObject(key);
  return { deleted: true, key };
};

/** POST /uploadConfig: lets the UI tell whether uploads will work before a file is picked. */
exports.uploadConfig = async (_data, context) => {
  // Any signed-in member can ask (the Profile page needs it for the avatar picker).
  await validateAuth(context);
  return uploads.getUploadConfig();
};
