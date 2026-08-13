require('dotenv').config();

const env = {
  PORT: parseInt(process.env.PORT, 10) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Email
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  // Optional override of the From address. Without a verified domain Resend
  // forces "onboarding@resend.dev"; once you verify a domain set this to
  // 'גן החלומות <orders@yourdomain.com>'.
  RESEND_FROM: process.env.RESEND_FROM,
  // Google Apps Script web-app URL — relays mail through the user's Gmail
  // account so we don't need a verified domain. Optional shared secret.
  GAS_EMAIL_URL: process.env.GAS_EMAIL_URL,
  GAS_EMAIL_SECRET: process.env.GAS_EMAIL_SECRET,

  // Cloudflare R2

  // Boot the API without the scheduled jobs. For running against the (single,
  // production) database from a laptop without syncing sheets, queueing work
  // to the Pi agents or paying for an AI scan. Never set in production.
  DISABLE_JOBS: process.env.DISABLE_JOBS === '1',

  // SMS — one-time codes for parent account activation and password reset.
  // SMS_USER is the phone number the SMS4Free account was registered with,
  // SMS_SENDER the name a parent sees as the sender. Absent these, every send
  // throws rather than silently doing nothing (services/sms.service.js).
  SMS_PROVIDER: process.env.SMS_PROVIDER || 'sms4free',
  SMS_KEY: process.env.SMS_KEY,
  SMS_USER: process.env.SMS_USER,
  SMS_PASS: process.env.SMS_PASS,
  SMS_SENDER: process.env.SMS_SENDER,

  // Google Sheets (migration only)
  GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
};

module.exports = env;
