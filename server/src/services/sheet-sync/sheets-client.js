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

// --- Writing, and the two tabs the sync actually reads -------------------
//
// Writes are `values.batchUpdate` on explicit single-cell ranges, never an
// append and never a row operation. The old board reads its own live tab
// positionally, so a row inserted or deleted here would move every child
// below it on THEIR screen too.
const { SHEET } = require('../../../scripts/lib/nursery-history');

/** Zero-based row/col to an A1 range, quoting the tab name for the Hebrew. */
function a1(tab, row, col) {
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `'${tab.replace(/'/g, "''")}'!${letters}${row + 1}`;
}

function auth() {
  return clientFor(credentialsFromEnv());
}

async function readGrids(sheetId) {
  const a = auth();
  const [children, today, history] = await Promise.all([
    readTab(a, sheetId, SHEET.children),
    readTab(a, sheetId, SHEET.today),
    readTab(a, sheetId, SHEET.history),
  ]);
  return { children, today, history };
}

/**
 * Set cells. `updates` is [{ tab, row, col, value }], zero-based.
 *
 * RAW, not USER_ENTERED: a value we computed must land as itself. Letting
 * Sheets re-interpret it would turn "06:15" back into a serial under one
 * locale and a string under another, and the board would render whichever it
 * got.
 */
async function writeCells(sheetId, updates) {
  if (!updates || updates.length === 0) return { written: 0 };
  const a = auth();
  const data = updates.map(u => ({ range: a1(u.tab, u.row, u.col), values: [[u.value]] }));
  await a.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    method: 'POST',
    data: { valueInputOption: 'RAW', data },
  });
  return { written: updates.length };
}

module.exports = { SCOPES, credentialsFromEnv, clientFor, tabNames, readTab, readGrids, writeCells, a1 };
