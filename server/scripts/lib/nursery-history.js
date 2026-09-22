/**
 * Reading the old board's export — the Apps Script sheet, before any database.
 *
 * The תינוקייה ran for years on a Google Sheet driven by an Apps Script. One
 * tab held today, one tab held every past day as a JSON blob, and two more
 * held the lists the staff picked from. This module turns that export into
 * the shapes `DailyLog` and `DailyMenu` already use, and does nothing else —
 * no database, no network, no process exit. The importer that writes is a
 * separate file, and this one is what the tests can reach.
 *
 * There are two exports, one per branch, and they are NOT the same format —
 * nor is either of them one format. Kaplan opened in January 2026 and its
 * first three days were archived by an older version of the script: a bare
 * array of children instead of an object, an Excel serial in the date column
 * instead of a string, no accessId on the children, a twelve-hour clock, and
 * three rows whose date is the literal string "Unknown Date". From 17 January
 * it writes what Moshe Dayan writes throughout.
 *
 * So nothing below treats either file as the reference. Every shape either one
 * produces is a shape this module reads, and anything it does not recognise
 * throws by name rather than returning an empty day — see `historyChildren`,
 * which is where that lesson cost the most.
 *
 * Two more things are not obvious and both have already cost an afternoon, so
 * they are handled here rather than at each call site.
 *
 * 1. Times are day fractions. The "סדר יום" tab is the live board, written by
 *    the sheet itself, so a lying-down time arrives as 0.28125 — three-
 *    quarters of a seventh of a day, i.e. 06:45 — and a portion arrives as
 *    0.75 meaning 75%. The same column holds both a fraction and a sentence
 *    ("בקבוק תמל 180"), because a parent typed one and a picker wrote the
 *    other.
 *
 * 2. The same field has two names. The sheet's headers spell it תמ״ל with the
 *    Hebrew gershayim (U+05F4); the JSON in the history tab spells it תמ"ל
 *    with an ASCII quote, because Apps Script serialised it. The headers also
 *    carry a newline — "שנת בוקר \nשעת השכבה" — that the JSON does not. Three
 *    of the eighteen fields differ this way, so comparing the strings as they
 *    arrive silently loses a fifth of the board.
 *
 * Everything below normalises before it compares, and the normalisation is one
 * function so the next reader of this data cannot get a different answer.
 */

const XLSX = require('xlsx');

// --- Trap 2: one spelling ------------------------------------------------

/**
 * A field name, in the one spelling this module compares against.
 *
 * Hebrew punctuation is folded to ASCII, curly quotes with it, and every run
 * of whitespace — including the newlines the sheet headers carry — becomes a
 * single space. Applied to FIELD NAMES only: dish names legitimately contain
 * a geresh (קוטג׳, מג׳דרה) and folding it there would invent dishes the gan
 * never served.
 */
function normalizeFieldName(raw) {
  return String(raw ?? '')
    .replace(/״/g, '"')
    .replace(/׳/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Trap 1: a number is not a number ------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A cell holding a clock time, as HH:MM — or '' when it holds nothing usable.
 *
 * A number below 1 is a fraction of a day and is converted. A number at or
 * above 1 is not a time at all (it is millilitres that landed in the wrong
 * column) and is refused rather than turned into 1970. A string is accepted
 * only if it already reads as a time, so a broken picker writes nothing
 * rather than something a parent's report will later print.
 */
function cellToTime(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 1) return '';
    const minutes = Math.round(value * 1440) % 1440;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  const s = String(value).trim();
  if (TIME_RE.test(s)) return s;

  // Kaplan's first day holds "11:00:00 AM" — a 12-hour clock with seconds,
  // which is what a spreadsheet cell formatted as a time renders to when it is
  // read as text. Two values, both on 13/01/2026, and both are perfectly
  // readable; refusing them would be refusing a nap because of its notation.
  const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM)?$/i.exec(s);
  if (!m) return '';
  let hour = Number(m[1]);
  const meridiem = (m[3] || '').toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (hour > 23) return '';
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

/**
 * A cell holding how much was eaten, as the board shows it.
 *
 * A number at or below 1 is a proportion and becomes "75%" — the sheet stored
 * 0.75 and rendered 75%, and `DEFAULT_OPTIONS.meal_amounts` is already the
 * rendered form, so carrying the fraction through would mean every reader
 * re-deciding how to display it. Anything larger is millilitres or a count and
 * is kept as written; so is a sentence, because "בקבוק תמל 180" is what the
 * parent typed and there is nothing better to store.
 */
function cellToPortion(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (value <= 1) return `${Math.round(value * 100)}%`;
    return String(value);
  }
  return String(value).trim();
}

/** A cell as plain text. Numbers stringified, nothing else touched. */
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/**
 * What the family has to bring tomorrow, as a list.
 *
 * The sheet joined them with a comma and the staff typed the separator by
 * hand, so both "טיטולים, מגבונים" and "טיטולים ,מגבונים" occur. Split on the
 * comma, trim, drop the empties — never on the space, because "משחת החתלה" is
 * one item.
 */
function splitMissing(value) {
  return cellToText(value)
    .split(/\s*[,|]\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** An Excel date serial as YYYY-MM-DD. The 1900 epoch, offset by the leap bug. */
function excelSerialToDateKey(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return '';
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * An Israeli mobile as it is dialled, from any of the four ways it arrives.
 *
 * The two exports disagree, and one of them disagrees with itself:
 *   "0528810181"    Kaplan's roster — a string, leading zero intact
 *   523221102       Moshe Dayan's roster — a number, leading zero gone
 *   "972546390903"  Kaplan's history — E.164 without the plus
 *   null            a child with no phone, which is allowed
 *
 * All four become the same 10 digits. The country code is stripped rather than
 * kept because everything else in this database is dialled locally, and two
 * spellings of one number is how a duplicate parent gets created.
 */
function normalizePhone(value) {
  let digits = cellToText(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) digits = digits.slice(3);
  if (digits.length === 9 && digits[0] !== '0') digits = `0${digits}`;
  return digits;
}

/**
 * The archive stamp, as a comparable number.
 *
 * "DD/MM/YYYY | HH:MM" in almost every row, and an Excel serial with a
 * fraction of a day — 46035.18352839121 — in four of Kaplan's. Returning 0 for
 * the serials, as this did, would have made them lose every tie-break they
 * were in and never say why.
 */
function parseTimestamp(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 0 ? Math.round((raw - 25569) * 86400 * 1000) : 0;
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s*\|\s*(\d{2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return 0;
  const [, dd, mm, yyyy, hh, mi] = m;
  return Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi);
}

/**
 * YYYY-MM-DD, or ''. The same guard the board's own query string gets.
 *
 * An Excel date serial counts as a date — three of Kaplan's history rows are
 * stored that way. A bare number that is not a plausible date does not, and
 * neither does the literal "Unknown Date" that three more rows hold: the
 * caller reports those, and a guess would put a day of a gan in 1970.
 */
function normalizeDateKey(raw) {
  if (typeof raw === 'number') {
    // 40000 ≈ 2009, 60000 ≈ 2064. Outside that it is not a day at this gan.
    return raw >= 40000 && raw <= 60000 ? excelSerialToDateKey(Math.floor(raw)) : '';
  }
  const s = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * The children in one archived day, whichever shape the day is in.
 *
 * The Apps Script changed what it wrote and the change is inside a single
 * file, not between the two branches. Kaplan's first three days — 13 to 15
 * January 2026, while the branch was being set up — archive a BARE ARRAY of
 * children. From 17 January on it archives `{children, menu, validators,
 * error, debugInfo, branch}`, which is what Moshe Dayan has throughout. Two
 * intermediate shapes exist in between.
 *
 * Reading `.children` off an array yields undefined, and `undefined || []` is
 * an empty day that no counter complains about. That is 23 of Kaplan's 301
 * rows and 205 child-days disappearing without a single error — so an
 * unrecognised shape throws here rather than returning nothing.
 */
function historyChildren(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.children)) return payload.children;
    throw new Error(`שורש JSON לא מוכר: אובייקט עם המפתחות ${Object.keys(payload).join(', ') || '(ריק)'}`);
  }
  throw new Error(`שורש JSON לא מוכר: ${typeof payload}`);
}

/** The day's menu, which the early bare-array rows simply do not have. */
function historyMenu(payload) {
  return (!Array.isArray(payload) && payload && typeof payload === 'object' && payload.menu) || null;
}

// --- The mapping itself ---------------------------------------------------

/**
 * Every field the old board kept, and where it lives now.
 *
 * Keyed by the NORMALISED source name, so both spellings of תמ״ל land on the
 * same entry. `kind` decides how the cell is read — which matters for the
 * "סדר יום" tab, where the values are still raw numbers.
 *
 * `נוכחות` is mapped and never written: the column exists in the old board and
 * is empty in all 4,807 child-days of the export. Mapping it anyway keeps the
 * report honest — "present in the source, always blank" is a different fact
 * from "we never looked at it".
 */
const FIELD_MAP = {
  'נוכחות': { path: 'attendance', kind: 'attendance' },
  'התעורר בבית': { path: 'home.wake_time', kind: 'time' },
  'אכל בבית - שעה': { path: 'home.meal_time', kind: 'time' },
  'אכל בבית - כמות': { path: 'home.meal_amount', kind: 'portion' },
  'הערת הורים': { path: 'home.parent_note', kind: 'text' },
  'ארוחת בוקר': { path: 'meals.breakfast.amount', kind: 'portion' },
  'תמ"ל בוקר': { path: 'meals.breakfast.formula', kind: 'text' },
  'ארוחת צהריים': { path: 'meals.lunch.amount', kind: 'portion' },
  'תמ"ל צהריים': { path: 'meals.lunch.formula', kind: 'text' },
  'ארוחת 4': { path: 'meals.snack.amount', kind: 'portion' },
  'תמ"ל 4': { path: 'meals.snack.formula', kind: 'text' },
  'שנת בוקר שעת השכבה': { path: 'sleep.morning.start', kind: 'time' },
  'שנת בוקר שעת השכמה': { path: 'sleep.morning.end', kind: 'time' },
  'שנת צהריים שעת השכבה': { path: 'sleep.noon.start', kind: 'time' },
  'שנת צהריים שעת השכמה': { path: 'sleep.noon.end', kind: 'time' },
  'יציאות': { path: 'diapers', kind: 'text' },
  'מה חסר': { path: 'missing', kind: 'list' },
  'הערות': { path: 'staff_note', kind: 'text' },
};

/** The enum `DailyLog.attendance` accepts. Anything else is not attendance. */
const ATTENDANCE = ['', 'הגיע', 'חסר'];

function readCell(kind, value) {
  switch (kind) {
    case 'time': return cellToTime(value);
    case 'portion': return cellToPortion(value);
    case 'list': return splitMissing(value);
    case 'attendance': {
      const s = cellToText(value);
      return ATTENDANCE.includes(s) ? s : null;
    }
    default: return cellToText(value);
  }
}

/** True when a converted value carries nothing worth writing. */
function isBlank(value) {
  return value === '' || value === null || value === undefined
    || (Array.isArray(value) && value.length === 0);
}

/**
 * One child's day, as a `$set` for `DailyLog`.
 *
 * Only fields that actually hold something: an import must never blank out a
 * field, because the same document may already have been written by a member
 * of staff and the old sheet's silence is not a correction.
 *
 * Returns the set alongside what it could not use, so the dry run can say
 * which fields were dropped and why rather than quietly losing them.
 */
function dailyLogSet(data) {
  const set = {};
  const unmapped = [];
  const rejected = [];

  for (const [rawKey, rawValue] of Object.entries(data || {})) {
    const key = normalizeFieldName(rawKey);
    const field = FIELD_MAP[key];
    if (!field) {
      if (!isBlank(cellToText(rawValue))) unmapped.push({ field: key, value: cellToText(rawValue) });
      continue;
    }
    const value = readCell(field.kind, rawValue);
    // A cell that held something and converted to nothing is a value this
    // import is losing, and it has to say so. Only the fields with a format —
    // times and attendance — can fail this way; text keeps whatever it got.
    if (value === null || (isBlank(value) && !isBlank(cellToText(rawValue)) && field.kind !== 'text')) {
      rejected.push({ field: key, path: field.path, value: cellToText(rawValue) });
      continue;
    }
    if (isBlank(value)) continue;
    set[field.path] = value;
  }

  return { set, unmapped, rejected };
}

// --- The menu -------------------------------------------------------------

/**
 * The old menu keys, and the ones the board reads.
 *
 * The sheet keyed a menu line "בוקר - חלבון"; `DailyMenu.selections` keys it
 * "breakfast.חלבון", because the meal is structural — the child card lays out
 * three of them and the code branches on which — while the category is the
 * kitchen's own word and stays in Hebrew.
 */
const MEAL_KEYS = { 'בוקר': 'breakfast', 'צהריים': 'lunch', '4': 'snack' };

function menuKey(rawKey) {
  const parts = normalizeFieldName(rawKey).split(' - ');
  if (parts.length !== 2) return null;
  const meal = MEAL_KEYS[parts[0].trim()];
  return meal ? `${meal}.${parts[1].trim()}` : null;
}

/**
 * A day's menu, as `DailyMenu.selections`.
 *
 * The sheet joined several dishes with a pipe into one cell, which meant every
 * reader had to know how to split them and one of them always didn't. Always
 * an array here, even for one dish.
 *
 * Dishes are NOT filtered against the menu's option lists. Ten of them —
 * פתיתים, טופו, חזה עוף among others — were served for months and never added
 * to `DEFAULT_MENU`, and dropping them would rewrite what the kitchen cooked.
 * They are reported instead, so the list can be extended deliberately.
 */
function menuSelections(selected, known = null) {
  const selections = {};
  const unknownKeys = [];
  const unknownDishes = [];

  for (const [rawKey, rawValue] of Object.entries(selected || {})) {
    const key = menuKey(rawKey);
    const dishes = cellToText(rawValue).split('|').map(s => s.trim()).filter(Boolean);
    if (!key) {
      if (dishes.length) unknownKeys.push(normalizeFieldName(rawKey));
      continue;
    }
    if (dishes.length === 0) continue;
    if (known) {
      for (const dish of dishes) {
        if (!known.has(`${key}|${dish}`)) unknownDishes.push({ key, dish });
      }
    }
    selections[key] = dishes;
  }

  return { selections, unknownKeys, unknownDishes };
}

/** `{ breakfast: { categories: { חלבון: [...] } } }` as a "meal.category|dish" set. */
function knownDishSet(menu) {
  const set = new Set();
  for (const [mealKey, meal] of Object.entries(menu || {})) {
    for (const [category, dishes] of Object.entries(meal?.categories || {})) {
      for (const dish of dishes || []) set.add(`${mealKey}.${category}|${dish}`);
    }
  }
  return set;
}

// --- Choosing between snapshots of the same day ---------------------------

/**
 * How much of a day a snapshot actually holds.
 *
 * The archive job ran more than once on three of the 240 days, and on one of
 * them — 2026-01-17 — the LATER run holds an empty board: it fired after the
 * nightly reset had already wiped the sheet. Taking the later timestamp there
 * would import a blank day over nineteen children's records and call it an
 * import.
 *
 * So the richest snapshot wins and the timestamp only breaks ties. Counted in
 * filled fields rather than in children with anything at all, because a day
 * where one child has a full row and a day where nine have a single tap are
 * not equally worth keeping.
 */
function snapshotScore(payload) {
  let filled = 0;
  let children = [];
  try { children = historyChildren(payload); } catch { return 0; }
  for (const child of children) {
    for (const value of Object.values(child?.data || {})) {
      if (!isBlank(cellToText(value))) filled += 1;
    }
  }
  for (const value of Object.values(historyMenu(payload)?.selected || {})) {
    if (!isBlank(cellToText(value))) filled += 1;
  }
  return filled;
}

/**
 * Which of a day's snapshots to import.
 *
 * 'richest' is the default and is the safe one — see `snapshotScore`. 'latest'
 * exists because it is what the sheet itself would have said, and being able
 * to reproduce that answer is how we can show the difference rather than
 * assert it.
 */
function chooseSnapshot(snapshots, mode = 'richest') {
  if (!snapshots || snapshots.length === 0) return null;
  const scored = snapshots.map(s => ({ ...s, score: snapshotScore(s.payload), at: parseTimestamp(s.timestamp) }));
  const best = scored.slice().sort((a, b) => {
    if (mode === 'latest') return b.at - a.at || b.score - a.score;
    return b.score - a.score || b.at - a.at;
  })[0];
  return { chosen: best, all: scored };
}

// --- Reading the workbook -------------------------------------------------

const SHEET = {
  children: 'ילדים',
  history: 'היסטוריה',
  today: 'סדר יום',
  options: 'הגדרות',
  menu: 'תפריט',
};

function rowsOf(workbook, name) {
  const ws = workbook.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

function isEmptyRow(row) {
  return !row || row.every(c => c === null || c === undefined || c === '');
}

/** The roster tab: who the board knew, and the token their parent used. */
function parseChildren(workbook) {
  const rows = rowsOf(workbook, SHEET.children);
  const headerIndex = rows.findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'שם מלא'));
  if (headerIndex < 0) return [];
  const header = (rows[headerIndex] || []).map(normalizeFieldName);
  const col = (name) => header.indexOf(name);
  const out = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (isEmptyRow(row)) continue;
    const name = cellToText(row[col('שם מלא')]);
    if (!name) continue;
    out.push({
      name,
      birth_date: excelSerialToDateKey(row[col('תאריך לידה')]),
      access_id: cellToText(row[col('AccessID')]),
      phone: normalizePhone(row[col('מספר פלאפון')]),
    });
  }
  return out;
}

/**
 * The roster tab, WITH the grid row each child sits on.
 *
 * `parseChildren` above answers "who was in this sheet", which is all the
 * history importer needs — it pairs on `accessId` carried in the JSON. The
 * live `סדר יום` tab carries no id at all, so pairing there is by position,
 * and position is exactly what `parseChildren` throws away when it skips a
 * blank row.
 *
 * Same parsing, one more field, and the two do not share an implementation
 * on purpose: the importer's behaviour is covered by four suites and must not
 * move because the sync needed something else.
 *
 * `row` is the zero-based index into the grid as read, so it can be turned
 * back into an A1 range without counting anything again.
 */
function parseChildRows(rows) {
  const headerIndex = (rows || []).findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'שם מלא'));
  if (headerIndex < 0) return [];
  const header = (rows[headerIndex] || []).map(normalizeFieldName);
  const col = (name) => header.indexOf(name);
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (isEmptyRow(row)) continue;
    const name = cellToText(row[col('שם מלא')]);
    if (!name) continue;
    out.push({
      row: i,
      name,
      birth_date: excelSerialToDateKey(row[col('תאריך לידה')]),
      access_id: cellToText(row[col('AccessID')]),
      phone: normalizePhone(row[col('מספר פלאפון')]),
    });
  }
  return out;
}

/**
 * The history tab: every past day, grouped by date.
 *
 * A row whose JSON will not parse is reported rather than thrown on — one
 * corrupt night must not cost the other 239.
 */
function parseHistory(workbook) {
  const rows = rowsOf(workbook, SHEET.history);
  const headerIndex = rows.findIndex(r => normalizeFieldName((r || [])[0]) === 'Date');
  const body = rows.slice(headerIndex < 0 ? 0 : headerIndex + 1);

  const byDate = new Map();
  const broken = [];
  for (const [i, row] of body.entries()) {
    if (isEmptyRow(row)) continue;
    const date = normalizeDateKey(row[0]);
    if (!date) {
      // Three of Kaplan's rows hold the literal string "Unknown Date" — the
      // Apps Script's own failure, written into the archive. Reported with the
      // value, because a day that cannot be dated cannot be imported and
      // somebody has to be told which one.
      broken.push({ row: i, reason: 'תאריך לא תקין', raw: cellToText(row[0]) });
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(String(row[1]));
    } catch (e) {
      broken.push({ row: i, date, reason: `JSON לא תקין: ${e.message}` });
      continue;
    }
    // The shape is checked here, once, so a row in a shape nobody has seen is
    // a reported row rather than a day that quietly holds no children.
    try {
      historyChildren(payload);
    } catch (e) {
      broken.push({ row: i, date, reason: e.message });
      continue;
    }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ date, timestamp: row[2], payload });
  }
  return { byDate, broken };
}

/**
 * The live board tab, read but never imported.
 *
 * It is the one place the day fractions actually appear, so it is parsed —
 * that is what proves the converters work on real cells — but it identifies
 * its children by row position only: no name, no token, and two blank rows in
 * the middle of a roster of sixteen. Guessing which row is whose child is not
 * an import, and today's board will be written by the staff tomorrow anyway.
 */
function parseToday(workbook) {
  const rows = rowsOf(workbook, SHEET.today);
  const headerIndex = rows.findIndex(r => (r || []).some(c => normalizeFieldName(c) === 'התעורר בבית'));
  if (headerIndex < 0) return { header: [], rows: [] };
  const header = (rows[headerIndex] || []).map(normalizeFieldName).filter(Boolean);
  const out = [];
  for (const [i, row] of rows.slice(headerIndex + 1).entries()) {
    if (isEmptyRow(row)) continue;
    const data = {};
    header.forEach((name, c) => { data[name] = row[c]; });
    out.push({ row: headerIndex + 1 + i, ...dailyLogSet(data) });
  }
  return { header, rows: out };
}

/** The lists tab, as the board's option lists. */
function parseOptions(workbook) {
  const rows = rowsOf(workbook, SHEET.options);
  if (rows.length === 0) return {};
  const header = (rows[0] || []).map(normalizeFieldName);
  const columns = {};
  header.forEach((name, c) => {
    if (!name) return;
    const values = [];
    for (const row of rows.slice(1)) {
      const raw = row?.[c];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = typeof raw === 'number' && raw <= 1 ? `${Math.round(raw * 100)}%` : cellToText(raw);
      if (value && !values.includes(value)) values.push(value);
    }
    // Two columns are both headed תמ״ל — the bottle sizes and the what-to-bring
    // entry. Merged rather than one silently replacing the other.
    columns[name] = (columns[name] || []).concat(values.filter(v => !(columns[name] || []).includes(v)));
  });
  return columns;
}

/** The menu tab, as `{ meal: { label, categories } }`. */
function parseMenu(workbook) {
  const rows = rowsOf(workbook, SHEET.menu);
  const titleIndex = rows.findIndex(r => (r || []).some(c => /תפריט תזונתי/.test(String(c || ''))));
  if (titleIndex < 0 || !rows[titleIndex + 1]) return {};

  // The meal titles sit on one row, merged across their categories, and the
  // third of them is mislabelled "צהריים" in the sheet. Position decides which
  // meal a column belongs to, not the title: the categories underneath —
  // כריך, פרי — are the four o'clock's and nothing else's.
  const titles = rows[titleIndex];
  const categories = rows[titleIndex + 1] || [];
  const order = ['breakfast', 'lunch', 'snack'];
  const labels = { breakfast: 'ארוחת בוקר', lunch: 'ארוחת צהריים', snack: 'ארוחת 4' };

  const starts = [];
  titles.forEach((c, i) => { if (/תפריט תזונתי/.test(String(c || ''))) starts.push(i); });

  const menu = {};
  starts.forEach((start, m) => {
    const mealKey = order[m];
    if (!mealKey) return;
    const end = starts[m + 1] ?? categories.length;
    const cats = {};
    for (let c = start; c < end; c++) {
      const category = cellToText(categories[c]);
      if (!category) continue;
      const dishes = [];
      for (const row of rows.slice(titleIndex + 2)) {
        const dish = cellToText(row?.[c]);
        if (dish && !dishes.includes(dish)) dishes.push(dish);
      }
      if (dishes.length) cats[category] = dishes;
    }
    if (Object.keys(cats).length) menu[mealKey] = { label: labels[mealKey], categories: cats };
  });
  return menu;
}

/** The whole export, parsed. No database, no side effects. */
function readWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  return {
    sheets: workbook.SheetNames,
    children: parseChildren(workbook),
    history: parseHistory(workbook),
    today: parseToday(workbook),
    options: parseOptions(workbook),
    menu: parseMenu(workbook),
  };
}

module.exports = {
  normalizeFieldName, cellToTime, cellToPortion, cellToText, splitMissing,
  excelSerialToDateKey, normalizePhone, parseTimestamp, normalizeDateKey,
  historyChildren, historyMenu,
  FIELD_MAP, dailyLogSet,
  menuKey, menuSelections, knownDishSet,
  snapshotScore, chooseSnapshot,
  readWorkbook, parseChildren, parseChildRows, parseHistory, parseToday, parseOptions, parseMenu,
  SHEET, TIME_RE,
};
