'use strict';

const otpService = require('../services/otp.service');
const { signInWithPhone } = require('../services/phoneAuth.service');
const { normalizePhone, isValidIndianPhone } = require('../utils/phone');
const env = require('../config/env');

// POST /sendOtp  { phone }
exports.sendOtp = async (data) => {
  const phone = normalizePhone(data && data.phone);
  if (!isValidIndianPhone(phone)) {
    throw new Error('Please enter a valid Indian mobile number (e.g. +91 9876543210).');
  }

  const code = otpService.generateOTP();
  const issued = await otpService.issueOTP(phone, code);
  if (!issued.ok) throw new Error(issued.reason);

  const delivered = await otpService.sendOTPviaWhatsApp(phone, code);

  // If a Flaxxa key is configured, a failed delivery must surface as an error
  // so nobody is told "OTP sent" when nothing arrived. Gating on the key (not
  // NODE_ENV) means this holds on any deployment, however NODE_ENV is set.
  if (otpService.isConfigured() && !delivered) {
    await otpService.clearOTP(phone);
    throw new Error('Could not send the OTP right now. Please try again in a moment.');
  }

  const result = { sent: delivered, ttlSeconds: otpService.OTP_TTL_MS / 1000 };
  // Only hand the code back when running locally with no WhatsApp provider.
  if (env.isDevelopment && !otpService.isConfigured()) result.devCode = code;
  return result;
};

// POST /verifyOtp  { phone, otp }
exports.verifyOtp = async (data) => {
  const phone = normalizePhone(data && data.phone);
  const otp = data && data.otp;
  if (!isValidIndianPhone(phone) || !String(otp || '').trim()) {
    throw new Error('Phone number and OTP are required.');
  }

  const { ok, reason } = await otpService.verifyOTP(phone, otp);
  if (!ok) throw new Error(reason);

  return signInWithPhone(phone);
};
