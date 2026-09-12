const axios = require('axios');

const TEMPLATE_API_URL = 'https://api.gupshup.io/wa/api/v1/template/msg';
const TEXT_API_URL = 'https://api.gupshup.io/sm/api/v1/msg';

const getConfig = () => ({
  apiKey: process.env.GUPSHUP_API_KEY,
  source: process.env.GUPSHUP_SOURCE,
  appName: process.env.GUPSHUP_APP_NAME,
});

const isConfigured = () => {
  const { apiKey, source, appName } = getConfig();
  return Boolean(apiKey && source && appName);
};

const normalizePhone = (phone) => {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (p.length === 10) p = `91${p}`;
  return p;
};

const sendTemplateMessage = async (phone, templateId, params = []) => {
  if (!isConfigured()) {
    console.warn('[GUPSHUP] Not configured; skipping template message.', { phone: normalizePhone(phone), templateId, params });
    return false;
  }
  if (!templateId) {
    console.warn('[GUPSHUP] No templateId provided; skipping.', { phone: normalizePhone(phone) });
    return false;
  }

  const { apiKey, source, appName } = getConfig();
  const body = new URLSearchParams();
  body.append('channel', 'whatsapp');
  body.append('source', source);
  body.append('destination', normalizePhone(phone));
  body.append('src.name', appName);
  body.append('template', JSON.stringify({ id: templateId, params }));

  try {
    const res = await axios.post(TEMPLATE_API_URL, body.toString(), {
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    console.log(`[GUPSHUP] Template "${templateId}" sent to ${normalizePhone(phone)}:`, res.data);
    return true;
  } catch (error) {
    console.error('[GUPSHUP] Template send failed:', error.response?.data || error.message);
    return false;
  }
};

const sendWhatsAppMessage = async (phone, message) => {
  if (!isConfigured()) {
    console.warn('[GUPSHUP] Not configured; skipping text message.', { phone: normalizePhone(phone), message });
    return false;
  }

  const { apiKey, source, appName } = getConfig();
  const body = new URLSearchParams();
  body.append('channel', 'whatsapp');
  body.append('source', source);
  body.append('destination', normalizePhone(phone));
  body.append('src.name', appName);
  body.append('message', JSON.stringify({ type: 'text', text: message }));

  try {
    const res = await axios.post(TEXT_API_URL, body.toString(), {
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    console.log(`[GUPSHUP] Text sent to ${normalizePhone(phone)}:`, res.data);
    return true;
  } catch (error) {
    console.error('[GUPSHUP] Text send failed:', error.response?.data || error.message);
    return false;
  }
};

module.exports = {
  sendWhatsAppMessage,
  sendTemplateMessage,
  isConfigured,
};