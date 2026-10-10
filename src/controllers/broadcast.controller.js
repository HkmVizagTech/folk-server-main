'use strict';

const { validateAdminOrHead } = require('../middlewares/auth');
const { isConfigured } = require('../services/notification.service');
const broadcasts = require('../services/broadcast.service');
const { HttpsError } = require('../utils/errors');
const { asObject } = require('../utils/ids');

const bad = (msg) => new HttpsError('invalid-argument', msg);

/**
 * POST /broadcast { audience: { type: 'mine' | 'all' | 'stage', stage? }, templateId, params[] }
 * Sends an approved WhatsApp template (Gupshup) to a group of members. A FOLK
 * guide can only reach the members assigned to them.
 */
exports.broadcast = async (data, context) => {
  const user = await validateAdminOrHead(context);
  data = asObject(data);

  if (!isConfigured()) {
    throw new HttpsError('failed-precondition',
      'WhatsApp sending is not set up on the server yet (GUPSHUP_API_KEY, GUPSHUP_SOURCE, GUPSHUP_APP_NAME).');
  }

  const templateId = typeof data.templateId === 'string' ? data.templateId.trim() : '';
  if (!/^[\w.-]{1,100}$/.test(templateId)) throw bad('Enter a valid template ID.');

  const params = Array.isArray(data.params) ? data.params : [];
  if (params.length > 10 || params.some((p) => typeof p !== 'string' || p.length > 200)) {
    throw bad('Up to 10 template values, each at most 200 characters.');
  }

  const type = data.audience && data.audience.type;
  const stage = data.audience && data.audience.stage;
  if (!['mine', 'all', 'stage'].includes(type)) throw bad('Choose who to send to.');
  if (type === 'stage' && !broadcasts.STAGES.includes(stage)) throw bad('Choose a valid stage.');
  if (type !== 'mine' && user.role !== 'admin') {
    throw new HttpsError('permission-denied', 'FOLK guides can only message their own members.');
  }

  const recipients = await broadcasts.resolveRecipients(user, type, stage);
  if (recipients.length === 0) throw bad('Nobody in this group has a valid mobile number.');
  if (recipients.length > broadcasts.MAX_RECIPIENTS) {
    throw bad(`That's ${recipients.length} people; one broadcast can reach at most ${broadcasts.MAX_RECIPIENTS}. Narrow the group.`);
  }

  const { sent, failed } = await broadcasts.sendAll(recipients, templateId, params);
  await broadcasts.recordBroadcast(user, { type, stage }, templateId, params, recipients.length, sent, failed);

  return { total: recipients.length, sent, failed };
};

/**
 * POST /backfillPhoneIndex (admin only)
 * Writes users/{uid}.phoneNormalized for every profile, so phone login can
 * find accounts with an indexed query instead of scanning the collection.
 */
exports.backfillPhoneIndex = async (data, context) => {
  const user = await validateAdminOrHead(context);
  if (user.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only.');
  return broadcasts.runPhoneBackfill();
};
