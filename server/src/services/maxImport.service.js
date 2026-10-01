/**
 * Max "פירוט חיובים" xlsx → the gan's card accounts.
 * Ported from tofy-friends maxImport.service; reads with `xlsx` (already a
 * server dependency) instead of hand-parsing the zip.
 *
 * Traps pinned by scripts/max-import.test.js:
 *  - SIGN. Max prints a purchase positive; money out is negative here.
 *    Backwards it does not fail — it turns every expense into income.
 *  - CARD FILTER. One Max login covers 2319 (טופי), 7996 and 8093 (גן).
 *  - The PDF is refused: it drops "תאריך חיוב", which links a charge to
 *    the bank's monthly card payment.
 *  - Columns by Hebrew header NAME — Max is free to add one.
 */
const XLSX = require('xlsx');
const { Setting } = require('../models');
const { ingest } = require('./financeIngest.service');

const DEFAULT_CARDS = ['7996', '8093'];

const HEADERS = {
  date: 'תאריך עסקה',
  merchant: 'שם בית העסק',
  category: 'קטגוריה',
  card: 'ספרות אחרונות',
  amount: 'סכום חיוב',
  chargeDate: 'תאריך חיוב',
  note: 'הערות',
};

async function allowedCards() {
  const s = await Setting.findOne({ key: 'max_import_cards' }).lean();
  const raw = Array.isArray(s?.value) ? s.value.join(',') : String(s?.value || '');
  const list = raw.split(',').map(x => x.replace(/\D/g, '').slice(-4)).filter(Boolean);
  return list.length ? list : DEFAULT_CARDS;
}

function toIsoDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const day = Number(m[1]); const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseMaxExport(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('לא התקבל קובץ');
  if (buffer.slice(0, 4).toString('latin1') === '%PDF') {
    throw new Error('זה קובץ PDF. צריך את קובץ האקסל מאתר Max (פירוט חיובים ← ייצא לאקסל) — ב-PDF חסר "תאריך חיוב".');
  }
  // xlsx is a zip: it starts with "PK".
  if (buffer.slice(0, 2).toString('latin1') !== 'PK') throw new Error('הקובץ אינו קובץ אקסל תקין (xlsx)');

  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
  catch { throw new Error('הקובץ אינו קובץ אקסל תקין (xlsx)'); }

  const rows = [];
  const cardsSeen = {};
  let sawHeader = false;

  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    const headerAt = grid.findIndex(r => r.some(c => String(c).trim() === HEADERS.date));
    if (headerAt === -1) continue;
    sawHeader = true;
    const header = grid[headerAt].map(h => String(h).trim());
    const at = (needle) => header.findIndex(h => h.includes(needle));
    const col = Object.fromEntries(Object.entries(HEADERS).map(([k, v]) => [k, at(v)]));
    if (col.date === -1 || col.amount === -1 || col.card === -1) {
      throw new Error('המבנה של הקובץ לא מוכר — חסרות עמודות תאריך עסקה / סכום חיוב / ספרות הכרטיס');
    }
    for (const r of grid.slice(headerAt + 1)) {
      const date = toIsoDate(r[col.date]);
      if (!date) continue;
      const card = String(r[col.card] ?? '').replace(/\D/g, '').slice(-4);
      if (!card) continue;
      const amount = typeof r[col.amount] === 'number' ? r[col.amount] : Number(String(r[col.amount] ?? '').replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(amount) || amount === 0) continue;
      cardsSeen[card] = (cardsSeen[card] || 0) + 1;
      rows.push({
        date,
        chargeDate: col.chargeDate === -1 ? null : toIsoDate(r[col.chargeDate]),
        merchant: String(r[col.merchant] ?? '').trim() || 'ללא תיאור',
        category: col.category === -1 ? null : (String(r[col.category] ?? '').trim() || null),
        card,
        amount,
        note: col.note === -1 ? null : (String(r[col.note] ?? '').trim() || null),
      });
    }
  }
  if (!sawHeader) throw new Error('לא נמצאה בקובץ טבלת עסקאות של Max (כותרת "תאריך עסקה")');
  return { rows, cardsSeen };
}

function toIngestAccounts(rows, cards) {
  const byCard = new Map();
  for (const r of rows) {
    if (!cards.includes(r.card)) continue;
    const list = byCard.get(r.card) || [];
    // An installment purchase repeats in every monthly export with the ORIGINAL
    // date, merchant and per-installment amount; only the note differs. The
    // installment number must therefore be part of the identity (bank_ref feeds
    // the hash) or month 2 overwrites month 1.
    const inst = /תשלום\s*(\d+)\s*מתוך\s*(\d+)/.exec(r.note || '');
    list.push({
      date: r.date,
      processed_date: r.chargeDate || r.date,
      amount: -r.amount,
      currency: 'ILS',
      description: r.merchant,
      original_description: r.note ? `${r.merchant} · ${r.note}` : r.merchant,
      provider_category: r.category,
      status: 'completed',
      bank_ref: inst ? `inst:${inst[1]}/${inst[2]}` : null,
    });
    byCard.set(r.card, list);
  }
  return [...byCard.entries()].map(([card, transactions]) => ({
    external_id: `max:••••${card}`,
    institution: 'max',
    label: `Max ••••${card}`,
    account_number: `••••${card}`,
    type: 'card',
    currency: 'ILS',
    balance: null,
    transactions,
  }));
}

async function importMaxExport(buffer) {
  const parsed = parseMaxExport(buffer);
  const cards = await allowedCards();
  const accounts = toIngestAccounts(parsed.rows, cards);
  const result = accounts.length
    ? await ingest(accounts, { agentVersion: 'max-file-import', source: 'max_xlsx' })
    : { accounts_seen: 0, inserted: 0, updated: 0, pending_replaced: 0, skipped: 0, card_settlements: 0 };
  const seen = Object.keys(parsed.cardsSeen);
  return {
    ...result,
    rows_in_file: parsed.rows.length,
    cards_seen: parsed.cardsSeen,
    cards_imported: seen.filter(c => cards.includes(c)),
    cards_skipped: seen.filter(c => !cards.includes(c)),
  };
}

module.exports = { DEFAULT_CARDS, allowedCards, parseMaxExport, toIngestAccounts, importMaxExport, toIsoDate };
