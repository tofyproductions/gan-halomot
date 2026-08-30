const letterhead = require('./letterhead');

/**
 * מסמכים להורים — the confirmations a family asks the office for.
 *
 * Same shape as services/employeeLetters.js and for the same reason: the
 * office never types the child's identity — the system already knows it — and
 * the wording is fixed so every אישור that leaves the gan says the same thing.
 * The manager supplies only what the system cannot know: what the paper is
 * for, and any sentence she wants to add.
 *
 * Two letters:
 *   attendance_confirmation — אישור שהות בגן, לכל מאן דבעי (מס הכנסה, מעסיק,
 *                             ביטוח לאומי). Optionally states the amounts paid.
 *   camp_confirmation       — אישור השתתפות בקייטנת אוגוסט, with the amount.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escLines = (s) => esc(s).replace(/\r?\n/g, '<br/>');

const shortDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');
const nis = (n) => (n || n === 0 ? `${Number(n).toLocaleString('he-IL')} ₪` : '');

const PAGE_CSS = `
  @page { size: A4; margin: 18mm 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Arial Hebrew', Arial, sans-serif;
    direction: rtl; text-align: right; color: #111;
    font-size: 13.5pt; line-height: 1.8; margin: 0;
  }
  .bsd { text-align: center; font-size: 11pt; margin-bottom: 14pt; }
  .meta { margin-bottom: 16pt; }
  .subject { font-weight: 700; text-decoration: underline; margin: 16pt 0 12pt; }
  p { margin: 0 0 10pt; }
  .details { margin: 8pt 0; }
  .details td { padding: 3pt 4pt; vertical-align: top; }
  .details td.label { font-weight: 600; white-space: nowrap; width: 140pt; }
  .sign { margin-top: 42pt; text-align: left; }
  .sign .name { font-weight: 700; }
  .footer-note { font-size: 10pt; color: #555; margin-top: 26pt; border-top: 1px solid #ddd; padding-top: 6pt; }
`;

/* Preview at true A4 width, scaled to the frame — copied from the employee
 * letters so the preview and the PDF agree. */
const PREVIEW_CSS = `
  @media screen {
    html { background:#e5e7eb; margin:0; padding:10px 0; }
    body {
      width:210mm; min-height:297mm; margin:0 auto; background:#fff;
      padding:18mm 18mm 16mm;
      box-shadow:0 1px 10px rgba(0,0,0,.18);
      transform-origin: top center;
    }
  }
`;
const PREVIEW_JS = `
  (function () {
    var b = document.body;
    function fit() {
      b.style.transform = 'none';
      var w = document.documentElement.clientWidth - 20;
      var s = Math.min(1, w / b.offsetWidth);
      b.style.transform = 'scale(' + s + ')';
      document.documentElement.style.height = (b.offsetHeight * s + 24) + 'px';
    }
    fit();
    window.addEventListener('resize', fit);
  })();
`;

function page(title, inner, { preview = false } = {}) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"/>
<title>${esc(title)}</title><style>${PAGE_CSS}${letterhead.CSS}${preview ? PREVIEW_CSS : ''}</style></head>
<body>${letterhead.SLOT}${inner}</body>${preview ? `<script>${PREVIEW_JS}</script>` : ''}</html>`;
}

const signature = (ctx) => `
  <div class="sign">
    בכבוד רב,<br/>
    <span class="name">${esc(ctx.issuer_name)}</span>${ctx.issuer_title ? `<br/>${esc(ctx.issuer_title)}` : ''}<br/>
    ${esc(ctx.org_name)}
  </div>`;

const head = (ctx) => `
  <div class="bsd">בס"ד</div>
  <div class="meta">
    תאריך: ${esc(ctx.letter_date)}<br/>
    לכבוד: לכל מאן דבעי
  </div>`;

/** The identity block both letters open with. */
const childDetails = (ctx) => `
  <table class="details">
    <tr><td class="label">שם הילד/ה:</td><td>${esc(ctx.child_name)}</td></tr>
    ${ctx.child_id ? `<tr><td class="label">ת.ז:</td><td>${esc(ctx.child_id)}</td></tr>` : ''}
    ${ctx.birth_date ? `<tr><td class="label">תאריך לידה:</td><td>${esc(ctx.birth_date)}</td></tr>` : ''}
    <tr><td class="label">שם ההורה:</td><td>${esc(ctx.parent_name)}${ctx.parent_id ? ` (ת.ז ${esc(ctx.parent_id)})` : ''}</td></tr>
  </table>`;

/** The legal footer: which עמותה this paper speaks for. */
const orgLine = (ctx) => {
  const amuta = ctx.amuta_name
    ? `${ctx.amuta_name}${ctx.amuta_number ? ` (ע"ר ${ctx.amuta_number})` : ''}`
    : ctx.org_name;
  return `${amuta}${ctx.branch_address ? `, ${ctx.branch_address}` : ''}`;
};

/** אישור שהות בגן. */
function attendanceConfirmation(ctx, opts) {
  const period = ctx.start_date
    ? `החל מ-${esc(ctx.start_date)}${ctx.end_date ? ` ועד ${esc(ctx.end_date)}` : ' ועד היום'}`
    : '';
  const inner = `
  ${head(ctx)}
  <div class="subject">הנדון: אישור שהות בגן — שנת הלימודים ${esc(ctx.academic_year)}</div>
  ${childDetails(ctx)}
  <p>
    הרינו לאשר בזאת כי הילד/ה שפרטיו/ה מעלה שוהה במעון
    "${esc(ctx.branch_name)}" המופעל על ידי ${esc(orgLine(ctx))},
    בשנת הלימודים ${esc(ctx.academic_year)}${period ? `, ${period}` : ''}.
  </p>
  ${ctx.include_amounts ? `
  <p>
    ${ctx.monthly_fee ? `שכר הלימוד החודשי עומד על ${esc(nis(ctx.monthly_fee))}.` : ''}
    ${ctx.total_paid ? ` סך התשלומים ששולמו בשנת לימודים זו: ${esc(nis(ctx.total_paid))}.` : ''}
  </p>` : ''}
  ${ctx.purpose ? `<p>אישור זה ניתן לבקשת ההורה לצורך ${esc(ctx.purpose)}.</p>` : ''}
  ${ctx.extra ? `<p>${escLines(ctx.extra)}</p>` : ''}
  ${signature(ctx)}
  <div class="footer-note">אישור זה הופק ממערכת הרישום של הגן ואינו מהווה קבלה לצורכי מס אלא אם צוין אחרת.</div>`;
  return page(`${ctx.child_name} - אישור שהות בגן - ${ctx.academic_year}`, inner, opts);
}

/** אישור השתתפות בקייטנת אוגוסט. */
function campConfirmation(ctx, opts) {
  const inner = `
  ${head(ctx)}
  <div class="subject">הנדון: אישור השתתפות בקייטנת אוגוסט ${esc(ctx.camp_year)}</div>
  ${childDetails(ctx)}
  <p>
    הרינו לאשר בזאת כי הילד/ה שפרטיו/ה מעלה השתתף/ה בקייטנת חודש אוגוסט ${esc(ctx.camp_year)}
    שהתקיימה במעון "${esc(ctx.branch_name)}" המופעל על ידי ${esc(orgLine(ctx))}${ctx.camp_dates ? `, בתאריכים ${esc(ctx.camp_dates)}` : ''}.
  </p>
  ${ctx.include_amounts && ctx.camp_paid ? `
  <p>עלות הקייטנה ששולמה: ${esc(nis(ctx.camp_paid))}.</p>` : ''}
  ${ctx.purpose ? `<p>אישור זה ניתן לבקשת ההורה לצורך ${esc(ctx.purpose)}.</p>` : ''}
  ${ctx.extra ? `<p>${escLines(ctx.extra)}</p>` : ''}
  ${signature(ctx)}
  <div class="footer-note">אישור זה הופק ממערכת הרישום של הגן ואינו מהווה קבלה לצורכי מס אלא אם צוין אחרת.</div>`;
  return page(`${ctx.child_name} - אישור קייטנת אוגוסט ${ctx.camp_year}`, inner, opts);
}

const RENDERERS = {
  attendance_confirmation: attendanceConfirmation,
  camp_confirmation: campConfirmation,
};

const LETTER_LABELS = {
  attendance_confirmation: 'אישור שהות בגן',
  camp_confirmation: 'אישור קייטנת אוגוסט',
};

/**
 * The merge context for one child — everything the system already knows,
 * before the office's own edits are layered on top.
 */
function buildContext({ child, registration, branch, amuta, issuer, payments = {}, overrides = {} } = {}) {
  const now = new Date();
  const academicYear = child?.academic_year || registration?.academic_year || '';
  // The camp is the August that ends the academic year: "2026-2027" → 2027.
  const campYear = (String(academicYear).match(/(\d{4})\s*$/) || [])[1]
    || (String(academicYear).match(/^(\d{4})/) || [])[1] || '';

  const base = {
    child_name: child?.child_name || registration?.child_name || '',
    child_id: child?.child_id_number || '',
    birth_date: shortDate(child?.birth_date || registration?.child_birth_date),
    parent_name: child?.parent_name || registration?.parent_name || '',
    parent_id: child?.parent_id_number || registration?.parent_id_number || '',

    branch_name: branch?.name || '',
    branch_address: branch?.address || '',
    amuta_name: amuta?.name || '',
    amuta_number: amuta?.tax_id || '',

    academic_year: academicYear,
    camp_year: campYear,
    camp_dates: campYear ? `1.8.${campYear} - 31.8.${campYear}` : '',
    start_date: shortDate(registration?.start_date),
    end_date: registration?.end_date ? shortDate(registration.end_date) : '',

    letter_date: shortDate(now),
    include_amounts: false,
    monthly_fee: registration?.monthly_fee || null,
    total_paid: payments.total_paid ?? null,
    camp_paid: payments.camp_paid ?? null,
    purpose: '',
    extra: '',

    issuer_name: issuer?.full_name || '',
    issuer_title: issuer?.role === 'branch_manager' ? 'מנהל/ת המעון'
      : issuer?.role === 'accountant' ? 'הנהלת חשבונות' : 'הנהלה',
    org_name: 'גן החלומות',
  };

  const ctx = { ...base, ...overrides };
  if (overrides.letter_date_iso) ctx.letter_date = shortDate(overrides.letter_date_iso);
  return ctx;
}

function renderLetter(type, ctx, opts = {}) {
  const fn = RENDERERS[type];
  if (!fn) throw new Error(`unknown parent letter type: ${type}`);
  return fn(ctx, opts);
}

module.exports = {
  buildContext, renderLetter,
  LETTER_TYPES: Object.keys(RENDERERS), LETTER_LABELS,
};
