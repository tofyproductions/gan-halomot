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

  // Cloudflare R2
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_BUCKET: process.env.R2_BUCKET || 'gan-halomot-files',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,

  // Google Sheets (migration only)
  GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
};

module.exports = env;
