const { JWT } = require('google-auth-library');
const env = require('../config/env');
const { CERT_TYPES, COURSE_TYPES } = require('./compliance');

/**
 * Reading the gan's certificates out of Drive, where they already live.
 *
 * THIS SERVICE NEVER WRITES A ROW. It walks the folders, reads the file NAMES,
 * and returns PROPOSALS — "this looks like הרצליה's תברואן from July 2026" —
 * which a person then confirms or corrects on screen. Nothing is imported on a
 * guess, because the guesses are made from filenames typed by hand over four
 * years and one of them will be wrong in a way that matters: a certificate
 * filed under the wrong branch is a branch that looks covered and is not.
 *
 * The one thing that genuinely cannot be guessed is the branch. The Drive is
 * organised by מעון — הרצליה, יפו, כפר סבא — and the gan has FOUR branches,
 * with כפר סבא split into קפלן and משה דיין. A folder named "כפר סבא" is two
 * possible answers and the file name does not say which, so those proposals
 * come back with `branch_id: null` and `needs_branch: true` and the screen asks.
 *
 * Files are linked, not copied. BranchCertification.external_url exists for
 * exactly this — the back-catalogue stays where the office already keeps it,
 * and the requirement is that every certificate opens in one click, not that
 * every certificate moves house.
 */

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function credentials() {
  const raw = env.GOOGLE_SHEETS_CREDENTIALS || process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Is the Drive side configured at all? The screen asks before offering a scan. */
function isConfigured() {
  const c = credentials();
  return Boolean(c && c.client_email && c.private_key);
}

/** The service account's address, so the screen can tell somebody what to share with. */
function serviceAccountEmail() {
  return credentials()?.client_email || '';
}

let cachedToken = null;
let cachedUntil = 0;

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const c = credentials();
  if (!c) throw Object.assign(new Error('גישת גוגל אינה מוגדרת במערכת'), { status: 503 });
  const client = new JWT({ email: c.client_email, key: c.private_key, scopes: SCOPES });
  const { token } = await client.getAccessToken();
  cachedToken = token;
  // Google's tokens last an hour; drop ours early so a request never carries
  // one that expires mid-flight.
  cachedUntil = Date.now() + 45 * 60 * 1000;
  return token;
}

async function driveGet(path) {
  const token = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body?.error?.message || `Drive ${r.status}`;
    // The two failures a person can actually fix, said in those terms.
    if (/has not been used in project|is disabled/.test(msg)) {
      throw Object.assign(new Error('Drive API אינו מופעל בפרויקט של חשבון השירות.'), { status: 503 });
    }
    if (r.status === 404) {
      throw Object.assign(new Error('התיקייה לא נמצאה, או שאינה משותפת עם חשבון השירות.'), { status: 404 });
    }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return body;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** One folder's children, every page of them. */
async function listChildren(folderId) {
  let out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)');
    const r = await driveGet(`files?q=${q}&fields=${fields}&pageSize=200`
      + '&supportsAllDrives=true&includeItemsFromAllDrives=true'
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''));
    out = out.concat(r.files || []);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Every file under a folder, each carrying the names of the folders above it.
 *
 * The path matters as much as the name: "סניף כפר סבא" inside "בדיקות תקופתיות
 * של מתקני הגז" is a gas inspection, and the file itself never says so.
 *
 * Depth is capped. A shared Drive can contain a cycle of shortcuts, and a walk
 * without a limit on one of those does not come back.
 */
async function walk(folderId, { maxDepth = 4 } = {}) {
  const out = [];
  const seen = new Set();
  const visit = async (id, trail, depth) => {
    if (depth > maxDepth || seen.has(id)) return;
    seen.add(id);
    for (const f of await listChildren(id)) {
      if (f.mimeType === FOLDER_MIME) {
        await visit(f.id, [...trail, f.name], depth + 1);
      } else {
        out.push({ ...f, trail });
      }
    }
  };
  await visit(folderId, [], 0);
  return out;
}

// ---------------------------------------------------------------- classifying

/**
 * What kind of paper is this?
 *
 * Longest, most specific phrases first: "בודק בטיחות" must not be eaten by a
 * rule for "בטיחות", and "התנהלות בטוחה" is a staff course and not a safety
 * inspection at all. Order here IS the logic.
 */
const CERT_RULES = [
  [/דוח\s*התאמת\s*תשתית|התאמת\s*תשתית/, 'infrastructure'],
  [/בדיק(ה|ות)\s*תקופתי(ת|ות).*גז|מתקני\s*הגז|\bגז\b/, 'gas_inspection'],
  [/תזונאי(ת|ה)/, 'nutritionist'],
  [/תברואן/, 'sanitarian'],
  [/בודק\s*בטיחות/, 'safety_inspector'],
  [/גילוי\s*אש|גלוי\s*אש/, 'fire_detection'],
  [/חשמלאי|חשמל/, 'electrician'],
  [/אגרונום|עצים/, 'agronomist'],
  [/מרשם\s*פלילי/, 'criminal_registry'],
  [/בדיקת\s*מתקנים|מתקני\s*משחק/, 'equipment_inspection'],
  [/רישיון\s*הפעלה|רשיון\s*הפעלה/, 'operating_license'],
  [/ביקורת|מבדק\s*משרד/, 'inspection'],
];

/** Staff papers, which belong on the עובדת and not on the branch. */
const COURSE_RULES = [
  [/עזרה\s*ראשונה|מד["׳']?א/, 'first_aid'],
  [/התנהלות\s*בטוחה/, 'safe_conduct'],
  [/מטפלות\s*מתקדמ/, 'advanced_caregiver'],
  [/קורס\s*מטפלות|הכשרה\s*מקצועית|תעודת\s*לימודים/, 'caregiver'],
];

/**
 * Which branch, from the words the office uses for them.
 *
 * `null` with `ambiguous` set is a real answer and the important one: כפר סבא
 * names two branches in this system, and a file under that folder cannot be
 * placed without being asked about.
 */
const BRANCH_RULES = [
  [/קפלן/, 'קפלן'],
  [/משה\s*דיין|אמונה/, 'משה דיין'],
  [/הרצלי+ה|הרצוג/, 'הרצליה'],
  [/יפו|תל\s*אביב|אייזיק\s*חריף/, 'תל אביב'],
  [/כפר\s*סבא/, null],   // two branches wear this name
];

/**
 * A date out of the way people write them on these files:
 *   "מבדק בתאריך 13/03/26"   "אישור תברואן 7.26"   "09/02/26"
 *
 * Two digits of year are read as 20xx. These documents are all from this
 * century and a 26 that means 1926 is not a case worth handling.
 */
function parseDate(text) {
  const t = String(text || '');
  let m = t.match(/(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    y = Number(y); if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, Number(mo) - 1, Number(d)));
    if (!Number.isNaN(dt.getTime()) && Number(mo) >= 1 && Number(mo) <= 12) {
      return { date: dt, precision: 'day' };
    }
  }
  // "7.26" / "6.26" — a month and a year, which is how the office dates a
  // תברואן. Taken as the FIRST of that month: the document is from then, and
  // inventing a day would be inventing precision.
  m = t.match(/(?:^|[^\d.])(\d{1,2})[.](\d{2})(?!\d)/);
  if (m) {
    const mo = Number(m[1]);
    const y = 2000 + Number(m[2]);
    if (mo >= 1 && mo <= 12) return { date: new Date(Date.UTC(y, mo - 1, 1)), precision: 'month' };
  }
  return null;
}

function matchFirst(rules, text) {
  for (const [re, value] of rules) if (re.test(text)) return { hit: true, value };
  return { hit: false, value: null };
}

/**
 * One file → one proposal.
 *
 * `confidence` is honest rather than flattering: 'high' only when the type came
 * off the file's own name AND the branch is unambiguous. Everything else is
 * something a person has to look at, and the screen sorts by it.
 */
function classify(file) {
  const name = String(file.name || '');
  const trail = (file.trail || []).join(' / ');
  const haystack = `${trail} / ${name}`;

  const course = matchFirst(COURSE_RULES, haystack);
  const cert = matchFirst(CERT_RULES, haystack);

  const typeFromName = matchFirst(CERT_RULES, name).hit || matchFirst(COURSE_RULES, name).hit;

  // The branch: the file's own name first, then the folders above it.
  let branchWord = null;
  let ambiguous = false;
  for (const source of [name, trail]) {
    const r = matchFirst(BRANCH_RULES, source);
    if (r.hit) {
      if (r.value === null) ambiguous = true;
      else { branchWord = r.value; ambiguous = false; }
      break;
    }
  }

  const when = parseDate(name) || parseDate(trail);

  const kind = course.hit ? 'course' : (cert.hit ? 'cert' : null);
  const type = course.hit ? course.value : cert.value;

  let confidence = 'low';
  if (type && typeFromName && branchWord) confidence = 'high';
  else if (type) confidence = 'medium';

  return {
    drive_id: file.id,
    file_name: name,
    folder_path: trail,
    url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    size: Number(file.size) || 0,
    modified_at: file.modifiedTime || null,
    kind,                                   // 'cert' | 'course' | null
    type,                                   // a CERT_TYPES / COURSE_TYPES key
    type_label: kind === 'course' ? (COURSE_TYPES[type] || '') : (CERT_TYPES[type] || ''),
    branch_word: branchWord,                // 'הרצליה' | 'קפלן' | …
    needs_branch: ambiguous || !branchWord,
    issued_at: when ? when.date.toISOString().slice(0, 10) : null,
    date_precision: when ? when.precision : null,
    confidence,
  };
}

/**
 * Scan the given folders and return proposals.
 *
 * Duplicates are collapsed by file name: the same certificate sits in both the
 * licence folder and the "הכנות להגשה" folder, and the office should be shown
 * one row with both places on it rather than two rows to approve separately.
 */
async function scan(folderIds, { maxDepth = 4 } = {}) {
  const ids = (Array.isArray(folderIds) ? folderIds : [folderIds]).filter(Boolean);
  const files = [];
  for (const id of ids) files.push(...await walk(id, { maxDepth }));

  const byName = new Map();
  for (const f of files) {
    const p = classify(f);
    const key = p.file_name.trim();
    if (byName.has(key)) {
      byName.get(key).also_at.push(p.folder_path);
      continue;
    }
    byName.set(key, { ...p, also_at: [] });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return [...byName.values()].sort((a, b) =>
    (order[a.confidence] - order[b.confidence])
    || String(a.branch_word).localeCompare(String(b.branch_word), 'he')
    || a.file_name.localeCompare(b.file_name, 'he'));
}

/** The file id inside a Drive link, or null if this is not one. */
function fileIdFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/)
    || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
    || s.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/**
 * The bytes of one Drive file, for binding into the portfolio.
 *
 * Capped, and the cap is the point: this runs on a box with a 256MB heap that
 * also launches Chromium to render the cover page. One 60MB scan pulled into
 * memory beside that is not a slow portfolio, it is a dead process — and the
 * certificate it was for is the least important page in the file.
 *
 * A Google Doc has no bytes to download (it is not a file, it is a document),
 * so those are reported as unsupported rather than fetched into nothing.
 */
async function fetchFileBytes(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const id = fileIdFromUrl(url);
  if (!id) return { error: 'not_a_drive_link' };

  const meta = await driveGet(`files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`);
  if (String(meta.mimeType || '').startsWith('application/vnd.google-apps')) {
    return { error: 'google_doc', name: meta.name, mimeType: meta.mimeType };
  }
  const size = Number(meta.size) || 0;
  if (size > maxBytes) return { error: 'too_large', name: meta.name, size };

  const token = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { error: `http_${r.status}`, name: meta.name };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) return { error: 'too_large', name: meta.name, size: buf.length };
  return { bytes: buf, name: meta.name, mimeType: meta.mimeType };
}

module.exports = {
  isConfigured, serviceAccountEmail, scan, walk, classify, parseDate,
  fileIdFromUrl, fetchFileBytes,
  CERT_RULES, COURSE_RULES, BRANCH_RULES,
};
