'use strict';

const { db } = require('../config/firebase');
const { createContext } = require('../middlewares/auth');
const { sendTemplateMessage } = require('../services/notification.service');
const database = require('../services/database.service');
const env = require('../config/env');
const { errorBody } = require('../utils/errors');
const log = require('../utils/logger').create('notify');

// ANY /ping
exports.ping = (req, res) => {
  res.json({ result: { success: true, message: 'pong' } });
};

// GET /health (platform health check)
exports.health = (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    db: env.database.usePostgres ? 'postgres' : 'firestore',
    dbError: database.getError() ? true : undefined,
  });
};

// GET /
exports.root = (req, res) => {
  res.send('Folkvizag Backend is running!');
};

/**
 * POST /notify { phone, templateId, params[] }  (admin only)
 * Sends one WhatsApp template message. Plain Express handler: its error
 * bodies carry only `message` (no `status`), as the original did.
 */
exports.notify = async (req, res) => {
  try {
    const context = await createContext(req);
    if (!context.auth) {
      return res.status(401).json(errorBody('Unauthenticated'));
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json(errorBody('Admins only'));
    }

    const { phone, templateId, params } = req.body || {};
    if (!phone) {
      return res.status(400).json(errorBody('phone is required'));
    }

    const success = await sendTemplateMessage(phone, templateId, params || []);
    return res.status(200).json({ result: { success } });
  } catch (error) {
    log.error('Notify error:', error);
    return res.status(500).json(errorBody(error.message || 'Internal Server Error'));
  }
};
