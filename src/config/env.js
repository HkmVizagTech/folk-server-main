'use strict';

/**
 * The ONE place that reads process.env. Everything else imports this frozen
 * object. Values are read once at load; nothing here throws for a missing
 * credential (the server must still boot for /health), but `warnings` lists
 * what is missing so bootstrap can log it.
 */
const raw = process.env;
const str = (name, fallback = '') => (raw[name] !== undefined && raw[name] !== '' ? raw[name] : fallback);

const MIN_SETUP_CODE_LENGTH = 12;

const parsePort = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

const nodeEnv = str('NODE_ENV');
const port = parsePort(str('PORT', '8080'));

const allowedOrigins = str('ALLOWED_ORIGINS')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const setupCode = str('ADMIN_SETUP_CODE').trim();

const env = {
  nodeEnv,
  // Must be explicitly 'development'; an unset NODE_ENV on a real deployment
  // must never leak OTP codes.
  isDevelopment: nodeEnv === 'development',
  port: port || 8080,
  allowedOrigins,

  database: {
    url: str('DATABASE_URL'),
    backend: str('DATA_BACKEND'),
    // Postgres whenever DATABASE_URL is set, unless DATA_BACKEND=firestore.
    usePostgres: !!str('DATABASE_URL') && str('DATA_BACKEND') !== 'firestore',
    // Connections the server may hold open to Postgres.
    poolMax: Math.max(1, parseInt(str('PG_POOL_MAX', '10'), 10) || 10),
    // Apply pending schema migrations (src/db/migrations) at startup. Set to
    // 'false' to run them yourself with `npm run migrate`.
    autoMigrate: str('DB_AUTO_MIGRATE', 'true').toLowerCase() !== 'false',
  },

  firebase: {
    serviceAccountKey: str('SERVICE_ACCOUNT_KEY'),
    credentialsPath: str('GOOGLE_APPLICATION_CREDENTIALS'),
    defaultCredentialsPath: '/etc/secrets/serviceAccountKey.json',
    projectId: str('GCLOUD_PROJECT') || null,
  },

  admin: {
    username: str('ADMIN_USERNAME', 'admin'),
    email: str('ADMIN_EMAIL', 'admin@folkvizag.app').trim().toLowerCase(),
    name: str('ADMIN_NAME', 'Site Administrator'),
    password: str('ADMIN_PASSWORD'),
    // Site owner's Firebase UID (an identity, not a secret); trimmed because a
    // stray space in a pasted env var breaks the strict comparison.
    rootUid: str('ROOT_ADMIN_UID', 'wRbvUaFiBOYeXEEtF8OuXnzGWXs2').trim(),
    // Codes shorter than 12 characters are ignored so a weak value can't be brute-forced.
    setupCode: setupCode.length >= MIN_SETUP_CODE_LENGTH ? setupCode : '',
  },

  razorpay: {
    keyId: str('RAZORPAY_KEY_ID'),
    keySecret: str('RAZORPAY_KEY_SECRET'),
    webhookSecret: str('RAZORPAY_WEBHOOK_SECRET'),
  },

  // Flaxxa WAPI (WhatsApp OTP login). WAPI_TOKEN is canonical; FLAXXA_API_KEY is a fallback.
  wapi: {
    token: str('WAPI_TOKEN') || str('FLAXXA_API_KEY'),
    baseUrl: str('WAPI_BASE', 'https://wapi.flaxxa.com/api/v1/sendtemplatemessage'),
    otpTemplate: str('WAPI_OTP_TEMPLATE_NAME') || str('FLAXXA_OTP_TEMPLATE') || 'otp',
    templateLang: str('WAPI_TEMPLATE_LANG', 'en'),
  },

  gupshup: {
    apiKey: str('GUPSHUP_API_KEY'),
    source: str('GUPSHUP_SOURCE'),
    appName: str('GUPSHUP_APP_NAME'),
    accommodationTemplateId: str('GUPSHUP_TEMPLATE_ACCOMMODATION_ID', 'accommodation_status_updated'),
  },

  // Cloudflare R2. Values are kept raw: "missing" checks differ (whitespace-only
  // counts as missing for /uploadConfig), see upload.service.
  r2: {
    accountId: str('R2_ACCOUNT_ID'),
    accessKeyId: str('R2_ACCESS_KEY_ID'),
    secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
    bucket: str('R2_BUCKET'),
    publicBaseUrl: str('R2_PUBLIC_BASE_URL'),
  },
};

const warnings = [];
if (!port) warnings.push(`PORT "${raw.PORT}" is not a valid port; using 8080.`);
if (allowedOrigins.length === 0) {
  warnings.push('ALLOWED_ORIGINS is not set; the API accepts browser requests from any origin.');
}
env.warnings = warnings;

const freezeDeep = (obj) => {
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') freezeDeep(v); });
  return Object.freeze(obj);
};

module.exports = freezeDeep(env);
