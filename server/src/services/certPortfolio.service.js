const { PDFDocument } = require('pdf-lib');
const {
  BranchCertification, Branch, Employee, EmployeeCourse,
} = require('../models');
const {
  CERT_TYPES, COURSE_TYPES, REQUIRED_CERT_TYPES, REQUIRED_COURSE_TYPES,
  statusOf,
} = require('./compliance');
const { htmlToPdf, tryGc } = require('./htmlPdf');
const certGaps = require('./certGaps.service');
const driveCerts = require('./driveCerts.service');

/**
 * תיק אישורים — one file to hand an inspector.
 *
 * NOT an index of links. An index is a thing you read at a desk with the
 * internet working, and that is not where this is opened: it is opened in a
 * מעון, by somebody standing up, with an inspector waiting. So the actual
 * certificates are BOUND IN — the branch's papers first in the order the
 * licence asks for them, then the staff's.
 *
 * THE STAFF'S CERTIFICATES ARE PART OF THE FOLDER. עזרה ראשונה, התנהלות
 * בטוחה, the consent forms and the caregiving courses are asked for by name at
 * an inspection, and they live on the עובדת rather than on the branch — which
 * is a fact about this system's tables and not about the folder. A portfolio
 * that stops at the branch's own papers is half a folder, and the half that is
 * missing is the half about people.
 *
 * The cover page is the part that is worth as much as the certificates: what
 * the branch holds, what it does not, and which papers are present but carry
 * no expiry date. That last line is the one the office cannot otherwise see,
 * and it is printed whether or not anybody wants to read it — a portfolio that
 * only shows the good news is a portfolio that gets handed over with a hole
 * in it.
 *
 * MEMORY IS THE CONSTRAINT, not elegance. This runs on a 256MB heap that also
 * launches Chromium for the cover, so files are fetched and merged ONE AT A
 * TIME, over-large ones are skipped by name rather than loaded, and the gc is
 * poked between documents. A portfolio missing one 40MB scan is a usable file;
 * a dead process is not.
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ilDate = (d) => (d
  ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d))
  : '—');

const STATUS_WORD = {
  ok: 'בתוקף', expiring: 'פג בקרוב', expired: 'פג תוקף', no_expiry: 'בלי תאריך',
};

/** What goes in, gathered before a single byte is fetched. */
async function collect({ branchId }) {
  const branch = await Branch.findById(branchId).select('name').lean();
  if (!branch) throw Object.assign(new Error('סניף לא נמצא'), { status: 404 });

  const certs = await BranchCertification.find({ branch_id: branchId, is_archived: false })
    .select('-file_data').lean();

  const employees = await Employee.find({ branch_id: branchId, is_active: true })
    .select('full_name israeli_id').sort({ full_name: 1 }).lean();
  const courses = employees.length
    ? await EmployeeCourse.find({
      employee_id: { $in: employees.map(e => e._id) }, is_archived: false,
    }).select('-file_data').lean()
    : [];

  const [gap] = await certGaps.gaps({ branchIds: [branchId] });
  return { branch, certs, employees, courses, gap };
}

/** Of several rows of one type, the one that decides standing. Permanent wins. */
function decisive(rows) {
  if (rows.length === 0) return null;
  const permanent = rows.find(r => !r.expires_at);
  if (permanent) return permanent;
  return rows.slice().sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0];
}

function coverHtml({ branch, certs, employees, courses, gap }) {
  const now = new Date();
  const docs = bindOrder({ certs, employees, courses });

  const certRows = REQUIRED_CERT_TYPES.map((type) => {
    const mine = certs.filter(c => c.cert_type === type);
    const best = decisive(mine);
    const status = best ? statusOf(best.expires_at, now) : 'missing';
    return { type, label: CERT_TYPES[type], best, status };
  });
  // Anything held that is not on the required list still belongs in the file.
  const extras = certs
    .filter(c => !REQUIRED_CERT_TYPES.includes(c.cert_type))
    .map(c => ({
      type: c.cert_type,
      label: c.cert_type === 'other' ? (c.label || 'אחר') : CERT_TYPES[c.cert_type],
      best: c,
      status: statusOf(c.expires_at, now),
    }));

  const staff = REQUIRED_COURSE_TYPES.map((type) => {
    let held = 0;
    const short = [];
    for (const e of employees) {
      const mine = courses.filter(c => String(c.employee_id) === String(e._id) && c.course_type === type);
      const best = decisive(mine);
      const s = best ? statusOf(best.expires_at, now) : 'missing';
      if (best && s !== 'expired') held++;
      else short.push(`${e.full_name}${best ? ' (פג)' : ''}`);
    }
    return { type, label: COURSE_TYPES[type], held, total: employees.length, short };
  });

  const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  const statusCell = (s) => {
    const colour = { ok: '#15803d', expiring: '#b45309', expired: '#b91c1c', no_expiry: '#b45309', missing: '#b91c1c' }[s] || '#374151';
    const word = s === 'missing' ? 'לא הועלה' : (STATUS_WORD[s] || s);
    return `<span style="color:${colour};font-weight:700">${word}</span>`;
  };

  return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: "Arial Hebrew", Arial, sans-serif; color:#111827; font-size: 10.5pt; }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  h2 { font-size: 12.5pt; margin: 16pt 0 6pt; border-bottom: 1.5pt solid #B4540A; padding-bottom: 3pt; }
  .sub { color:#6b7280; font-size: 9.5pt; margin: 0 0 10pt; }
  table { width:100%; border-collapse: collapse; margin-bottom: 8pt; }
  th, td { border: 0.6pt solid #d1d5db; padding: 4pt 6pt; text-align: right; vertical-align: top; }
  th { background:#f3f4f6; font-size: 9.5pt; }
  .note { background:#fef3c7; border-inline-start: 3pt solid #b45309; padding: 7pt 9pt; margin: 8pt 0; }
  .bad  { background:#fee2e2; border-inline-start: 3pt solid #b91c1c; padding: 7pt 9pt; margin: 8pt 0; }
  .ltr { direction: ltr; unicode-bidi: isolate; }
</style>
<body>
  <h1>תיק אישורי מעון — ${esc(branch.name)}</h1>
  <p class="sub">הופק ${ilDate(now)} · עמותת גן החלומות (ע"ר) 580757805</p>

  ${gap && gap.total_gaps > 0 ? `<div class="bad">
    <b>חסרים בתיק: ${gap.total_gaps} מתוך ${gap.required_count} הנדרשים.</b>
    ${gap.missing.length ? `<div>לא הועלו: ${esc(gap.missing.map(t => CERT_TYPES[t]).join(', '))}</div>` : ''}
    ${gap.expired.length ? `<div>פגי תוקף: ${esc(gap.expired.map(t => CERT_TYPES[t]).join(', '))}</div>` : ''}
    ${gap.no_expiry.length ? `<div>בלי תאריך תפוגה: ${esc(gap.no_expiry.map(t => CERT_TYPES[t]).join(', '))}</div>` : ''}
  </div>` : `<div class="note" style="background:#dcfce7;border-color:#15803d">
    כל ${gap ? gap.required_count : REQUIRED_CERT_TYPES.length} האישורים הנדרשים קיימים ובתוקף.
  </div>`}

  <h2>אישורי המעון</h2>
  <table>
    <tr><th style="width:34%">האישור</th><th>הוצא</th><th>בתוקף עד</th><th>מצב</th><th>מצורף</th></tr>
    ${certRows.map(r => row([
      esc(r.label),
      r.best ? ilDate(r.best.issued_at) : '—',
      r.best ? ilDate(r.best.expires_at) : '—',
      statusCell(r.status),
      r.best ? (r.best.external_url || r.best.file_name ? 'כן' : 'לא') : '—',
    ])).join('')}
    ${extras.map(r => row([
      `${esc(r.label)} <span style="color:#6b7280">(נוסף)</span>`,
      ilDate(r.best.issued_at), ilDate(r.best.expires_at), statusCell(r.status),
      r.best.external_url || r.best.file_name ? 'כן' : 'לא',
    ])).join('')}
  </table>

  <h2>תעודות הצוות — ${employees.length} עובדות</h2>
  <table>
    <tr><th style="width:34%">התעודה</th><th>מחזיקות</th><th>מי חסרה</th></tr>
    ${staff.map(s => row([
      esc(s.label),
      `${s.held} / ${s.total}`,
      s.short.length ? esc(s.short.join(', ')) : '<span style="color:#15803d">הכול תקין</span>',
    ])).join('')}
  </table>
  <p class="sub">
    "מחזיקות" = תעודה קיימת ובתוקף. פג תוקף נספר כחסר ומסומן בסוגריים ליד השם.
  </p>

  ${docs.length ? `<h2>תוכן התיק — ${docs.length} מסמכים</h2>
  <p class="sub">המסמכים מצורפים אחרי הדף הזה, בסדר הזה.</p>
  <table>
    <tr><th style="width:8%">#</th><th>המסמך</th><th style="width:26%">חלק</th></tr>
    ${docs.map((d, i) => row([String(i + 1), esc(d.label), esc(d.section)])).join('')}
  </table>` : `<div class="note">אין מסמכים מצורפים — לאף אישור בתיק לא צורף קובץ או קישור.</div>`}
</body></html>`;
}

/**
 * Everything that gets bound in, in the order it is bound.
 *
 * The branch's own papers first, in the order the licence asks for them, then
 * anything extra it holds, then the staff's — grouped by certificate and
 * alphabetical inside it, because an inspector asks "who has עזרה ראשונה" and
 * not "what does רונית have".
 *
 * Only rows with something behind them. A course recorded with no file is real
 * and belongs in the coverage table on the cover; it has no page to bind.
 */
function bindOrder({ certs, employees, courses }) {
  const byId = new Map(employees.map(e => [String(e._id), e]));
  const hasFile = (r) => Boolean(r.file_data || r.external_url);

  const branchDocs = [
    ...REQUIRED_CERT_TYPES.flatMap(t => certs.filter(c => c.cert_type === t)),
    ...certs.filter(c => !REQUIRED_CERT_TYPES.includes(c.cert_type)),
  ].filter(hasFile).map(row => ({
    row,
    section: 'אישורי המעון',
    label: row.cert_type === 'other' ? (row.label || 'אחר') : (CERT_TYPES[row.cert_type] || row.cert_type),
  }));

  const COURSE_ORDER = [...REQUIRED_COURSE_TYPES, 'caregiver', 'advanced_caregiver', 'other'];
  const staffDocs = [];
  for (const type of COURSE_ORDER) {
    const rows = courses
      .filter(c => c.course_type === type && hasFile(c))
      .sort((a, b) => String(byId.get(String(a.employee_id))?.full_name || '')
        .localeCompare(String(byId.get(String(b.employee_id))?.full_name || ''), 'he'));
    for (const row of rows) {
      staffDocs.push({
        row,
        section: 'תעודות הצוות',
        label: `${COURSE_TYPES[type] || type} — ${byId.get(String(row.employee_id))?.full_name || 'עובדת'}`,
      });
    }
  }
  return [...branchDocs, ...staffDocs];
}

/** The bytes behind one certificate row — from the database, or from Drive. */
async function bytesOf(row, budget) {
  if (row.file_data) {
    const buf = Buffer.from(row.file_data, 'base64');
    if (buf.length > MAX_FILE_BYTES) return { error: 'too_large', size: buf.length };
    return { bytes: buf, mimeType: row.file_mimetype || 'application/pdf' };
  }
  if (row.external_url && driveCerts.isConfigured()) {
    if (budget.used > MAX_TOTAL_BYTES) return { error: 'budget' };
    try {
      return await driveCerts.fetchFileBytes(row.external_url, { maxBytes: MAX_FILE_BYTES });
    } catch (err) {
      return { error: err.message };
    }
  }
  return { error: 'no_file' };
}

/**
 * Bind one document into the portfolio.
 *
 * A PDF is copied page by page. A JPEG or PNG becomes a page of its own, fitted
 * to A4 — a photographed certificate is how half of these arrive and leaving it
 * out would mean the file an inspector is handed is missing the paper they
 * asked about. Anything else is skipped and REPORTED, never dropped quietly.
 */
async function append(out, { bytes, mimeType }) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('pdf') || bytes.slice(0, 4).toString() === '%PDF') {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));
    return src.getPageCount();
  }
  if (/jpe?g|png/.test(type)) {
    const img = type.includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const A4 = [595.28, 841.89];
    const page = out.addPage(A4);
    const scale = Math.min((A4[0] - 40) / img.width, (A4[1] - 40) / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
    return 1;
  }
  throw new Error(`unsupported:${type || 'unknown'}`);
}

/**
 * Build it. Returns { pdf, skipped } — `skipped` is as much the product as the
 * file is, because a portfolio quietly missing two certificates is worse than
 * one that says which two.
 */
async function build({ branchId }) {
  const data = await collect({ branchId });

  const out = await PDFDocument.create();
  out.setTitle(`תיק אישורי מעון — ${data.branch.name}`);

  const cover = await htmlToPdf(coverHtml(data));
  const coverDoc = await PDFDocument.load(cover);
  (await out.copyPages(coverDoc, coverDoc.getPageIndices())).forEach(p => out.addPage(p));
  tryGc();

  const ordered = bindOrder(data);

  const skipped = [];
  const budget = { used: 0 };
  for (const { row, label } of ordered) {
    const got = await bytesOf(row, budget);
    if (got.error || !got.bytes) {
      skipped.push({ label, reason: got.error || 'no_file' });
      continue;
    }
    budget.used += got.bytes.length;
    try {
      await append(out, got);
    } catch (err) {
      skipped.push({ label, reason: err.message });
    }
    tryGc();
  }

  const pdf = Buffer.from(await out.save());
  return { pdf, skipped, branch: data.branch };
}

module.exports = { build, coverHtml, collect };
