/**
 * Read-only: can we reach the sheet, and does it look like the spec says.
 *
 * Writes nothing, ever — there is no --write and no code path that could
 * acquire one. It exists to be run before anything is built on top of it,
 * and again whenever the sheet surprises us.
 *
 *   node scripts/sheet-sync-probe.js --sheet <id>
 */
const {
  credentialsFromEnv, clientFor, tabNames, readTab,
} = require('../src/services/sheet-sync/sheets-client');
const { SHEET } = require('./lib/nursery-history');

async function probe({ sheetId, credentials }) {
  const auth = clientFor(credentials);
  const tabs = await tabNames(auth, sheetId);
  const children = await readTab(auth, sheetId, SHEET.children);
  const today = await readTab(auth, sheetId, SHEET.today);
  const history = await readTab(auth, sheetId, SHEET.history);
  const dates = history.slice(1).map(r => String(r[0] || ''));
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return {
    tabs,
    rows: { children: children.length, today: today.length, history: history.length },
    todayHasCurrentDate: dates.includes(todayKey),
    sample: { childrenHead: children.slice(0, 3), todayHead: today.slice(0, 3) },
  };
}

module.exports = { probe };

if (require.main === module) {
  const i = process.argv.indexOf('--sheet');
  const sheetId = i > -1 ? process.argv[i + 1] : null;
  if (!sheetId) { console.error('usage: node scripts/sheet-sync-probe.js --sheet <id>'); process.exit(1); }
  probe({ sheetId, credentials: credentialsFromEnv() })
    .then(r => { console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error('probe failed:', e.message); process.exit(1); });
}
