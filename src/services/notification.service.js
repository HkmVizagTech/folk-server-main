'use strict';

const axios = require('axios');
const env = require('../config/env');
const { normalizePhone } = require('../utils/phone');
const log = require('../utils/logger').create('gupshup');

// Gupshup WhatsApp. Business-initiated messages must use an approved template.
const TEMPLATE_API_URL = 'https://api.gupshup.io/wa/api/v1/template/msg';
const TEXT_API_URL = 'https://api.gupshup.io/sm/api/v1/msg';

const { apiKey, source, appName } = env.gupshup;

const isConfigured = () => Boolean(apiKey && source && appName);

// Shared POST: both endpoints take the same form-encoded envelope.
const post = async (url, destination, field, value) => {
  const body = new URLSearchParams();
  body.append('channel', 'whatsapp');
  body.append('source', source);
  body.append('destination', destination);
  body.append('src.name', appName);
  body.append(field, JSON.stringify(value));
  return axios.post(url, body.toString(), {
    headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
};

const sendTemplateMessage = async (phone, templateId, params = []) => {
  const destination = normalizePhone(phone);
  if (!isConfigured()) {
    log.warn('Not configured; skipping template message.', { phone: destination, templateId, params });
    return false;
  }
  if (!templateId) {
    log.warn('No templateId provided; skipping.', { phone: destination });
    return false;
  }

  try {
    const res = await post(TEMPLATE_API_URL, destination, 'template', { id: templateId, params });
    log.info(`Template "${templateId}" sent to ${destination}:`, res.data);
    return true;
  } catch (error) {
    log.error('Template send failed:', error.response?.data || error.message);
    return false;
  }
};

const sendWhatsAppMessage = async (phone, message) => {
  const destination = normalizePhone(phone);
  if (!isConfigured()) {
    log.warn('Not configured; skipping text message.', { phone: destination, message });
    return false;
  }

  try {
    const res = await post(TEXT_API_URL, destination, 'message', { type: 'text', text: message });
    log.info(`Text sent to ${destination}:`, res.data);
    return true;
  } catch (error) {
    log.error('Text send failed:', error.response?.data || error.message);
    return false;
  }
};

module.exports = { sendWhatsAppMessage, sendTemplateMessage, isConfigured };
