/**
 * The Google Sheets API, and nothing about the gan.
 *
 * Lives in src/ rather than beside the probe script because src/ never
 * imports scripts/ anywhere in this repository, and the sync service needs
 * these same three functions. Task 4 adds the writing half here.
 */
const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function credentialsFromEnv() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_SHEETS_CREDENTIALS is not set');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('GOOGLE_SHEETS_CREDENTIALS is not valid JSON'); }
  if (!parsed.client_email || !parsed.private_key) throw new Error('GOOGLE_SHEETS_CREDENTIALS has no client_email/private_key');
  return parsed;
}

function clientFor(credentials) {
  return new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: SCOPES });
}

/** Every tab name in the spreadsheet. */
async function tabNames(auth, sheetId) {
  const res = await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
  });
  return (res.data.sheets || []).map(s => s.properties.title);
}

/**
 * One tab as a grid of raw cell values.
 *
 * UNFORMATTED_VALUE is deliberate: it gives times as day fractions and
 * portions as fractions, which is exactly what `cellToTime` and
 * `cellToPortion` in nursery-history.js already expect. Asking for
 * FORMATTED_VALUE would hand back locale-rendered strings and move the
 * parsing problem somewhere with no tests.
 */
async function readTab(auth, sheetId, title) {
  const range = encodeURIComponent(String(title));
  const res = await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
      + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER',
  });
  return res.data.values || [];
}

module.exports = { SCOPES, credentialsFromEnv, clientFor, tabNames, readTab };
