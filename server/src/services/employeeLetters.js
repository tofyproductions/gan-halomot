/**
 * Employee letters — the fixed-wording HR documents a branch manager issues:
 * a hearing invitation, the hearing protocol, a dismissal letter and an
 * employment confirmation.
 *
 * Every one of them is the same frame with a handful of moving parts (name,
 * ת"ז, dates, seniority, notice days), which is exactly the work the branch
 * managers were doing by hand in Word — copying last year's file, overwriting
 * the name, and occasionally leaving the previous employee's ת"ז in place.
 * The wording here is transcribed from the office's own documents; only the
 * blanks are filled.
 *
 * The rendered HTML is stored with the issued letter, so what was sent stays
 * readable exactly as it was even if these templates change later.
 */

const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HEB_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const IL_TZ = 'Asia/Jerusalem';

/** 06.08.24 — the format the office's own letters use. */
function shortDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: IL_TZ, day: '2-digit', month: '2-digit', year: '2-digit',
  }).formatToParts(dt);
  const g = (t) => p.find(x => x.type === t)?.value || '';
  return `${g('day')}.${g('month')}.${g('year')}`;
}

/** 06.08.2026 — for the contract/confirmation body, where the century matters. */
function longDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IL_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(dt).replace(/\//g, '.');
}

const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayName(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const en = new Intl.DateTimeFormat('en-US', { timeZone: IL_TZ, weekday: 'short' }).format(dt);
  const idx = EN_WEEKDAYS.indexOf(en);
  return idx === -1 ? '' : HEB_WEEKDAYS[idx];
}

/** Whole months between two dates (partial month not counted). */
function monthsBetween(from, to) {
  if (!from) return 0;
  const a = new Date(from);
  const b = to ? new Date(to) : new Date();
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * Statutory notice period — חוק הודעה מוקדמת לפיטורים ולהתפטרות, תשס"א-2001.
 *
 * The law has TWO ladders and picks between them by how the employee is paid,
 * which is why this takes salary_type rather than just seniority:
 *
 *   עובד במשכורת (global/monthly, §3):
 *     months 1-6   → 1 day per month worked
 *     months 7-12  → 6 days + 2.5 days for each month worked beyond the sixth
 *     from year 2  → 30 days
 *
 *   עובד בשכר (hourly, §4):
 *     year 1  → 1 day per month worked
 *     year 2  → 14 days + 1 day per 2 months worked in that year
 *     year 3  → 21 days + 1 day per 2 months worked in that year
 *     year 4+ → 30 days
 *
 * Returns whole days (rounded down — the 2.5-day step can land on a half) plus
 * the reasoning, so the letter can state why it is that number and a manager
 * who disagrees can see what the calculation assumed.
 */
function noticePeriod(startDate, { salaryType = 'hourly', asOf = null } = {}) {
  const months = monthsBetween(startDate, asOf);
  if (!startDate) {
    return { days: 0, months: 0, basis: 'לא הוזן תאריך תחילת העסקה', law: '' };
  }
  const monthly = salaryType === 'global';
  const law = monthly
    ? 'חוק הודעה מוקדמת לפיטורים ולהתפטרות, תשס"א-2001, סעיף 3 (עובד במשכורת)'
    : 'חוק הודעה מוקדמת לפיטורים ולהתפטרות, תשס"א-2001, סעיף 4 (עובד בשכר)';

  let days;
  let basis;
  if (monthly) {
    if (months < 6) { days = months; basis = `${months} חודשי ותק — יום לכל חודש`; }
    else if (months < 12) {
      days = Math.floor(6 + 2.5 * (months - 6));
      basis = `${months} חודשי ותק — 6 ימים ועוד 2.5 ימים לכל חודש מעבר לששה`;
    } else { days = 30; basis = 'מעל שנה — 30 ימים'; }
  } else {
    const years = Math.floor(months / 12);
    const inYear = months % 12;
    if (years < 1) { days = months; basis = `${months} חודשי ותק — יום לכל חודש`; }
    else if (years === 1) {
      days = 14 + Math.floor(inYear / 2);
      basis = `שנה ו-${inYear} חודשי ותק — 14 ימים ועוד יום לכל חודשיים בשנה השנייה`;
    } else if (years === 2) {
      days = 21 + Math.floor(inYear / 2);
      basis = `שנתיים ו-${inYear} חודשי ותק — 21 ימים ועוד יום לכל חודשיים בשנה השלישית`;
    } else { days = 30; basis = `${years} שנות ותק — 30 ימים`; }
  }
  return { days, months, basis, law };
}

/** Human seniority — "שנתיים ו-3 חודשים". */
function seniorityText(startDate, asOf = null) {
  const m = monthsBetween(startDate, asOf);
  const y = Math.floor(m / 12);
  const rm = m % 12;
  const yPart = y === 0 ? '' : y === 1 ? 'שנה' : y === 2 ? 'שנתיים' : `${y} שנים`;
  const mPart = rm === 0 ? '' : rm === 1 ? 'חודש' : `${rm} חודשים`;
  if (!yPart && !mPart) return 'פחות מחודש';
  if (yPart && mPart) return `${yPart} ו-${mPart}`;
  return yPart || mPart;
}

/** Gendered address. Hebrew letters here are written to a female employee by
 *  default (the office's templates are), with a masculine variant available. */
const G = (female, f, m) => (female ? f : m);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Free text typed by a manager: keep her line breaks, escape everything else. */
const escLines = (s) => esc(s).replace(/\r?\n/g, '<br/>');

const PAGE_CSS = `
  @page { size: A4; margin: 18mm 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Arial Hebrew', Arial, sans-serif;
    direction: rtl; text-align: right; color: #111;
    font-size: 13.5pt; line-height: 1.7; margin: 0;
  }
  .bsd { text-align: center; font-size: 11pt; margin-bottom: 14pt; }
  .meta { margin-bottom: 16pt; }
  .subject { font-weight: 700; text-decoration: underline; margin: 16pt 0 12pt; }
  ol.body { padding-inline-start: 20pt; margin: 0; }
  ol.body > li { margin-bottom: 9pt; }
  .reasons { margin: 6pt 24pt 0 0; }
  .sign { margin-top: 42pt; text-align: left; }
  .sign .name { font-weight: 700; }
  .field { border-bottom: 1px solid #444; display: inline-block; min-width: 190pt; padding: 0 4pt; }
  table.protocol { width: 100%; border-collapse: collapse; margin-top: 8pt; }
  table.protocol td { padding: 5pt 4pt; vertical-align: top; }
  table.protocol td.label { width: 165pt; font-weight: 600; white-space: nowrap; }
  .box { border: 1px solid #444; min-height: 90pt; padding: 8pt; margin-top: 4pt; white-space: pre-wrap; }
  .note { font-size: 10.5pt; margin-top: 20pt; }
  .footer-note { font-size: 10pt; color: #555; margin-top: 26pt; border-top: 1px solid #ddd; padding-top: 6pt; }
`;

/**
 * On paper the letter is an A4 page. In the preview frame it was being laid out
 * to whatever width the frame happened to be, so 13.5pt type and 18mm margins
 * came out looking oversized and the lines broke in the wrong places — the
 * preview disagreed with the PDF, which defeats its purpose.
 *
 * `preview` renders the same markup at true A4 width on a grey desk and scales
 * the whole page down to fit the frame, so what you see is the printed page.
 */
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
// Fit-to-width without guessing the frame size server-side.
const PREVIEW_JS = `
  (function () {
    var b = document.body;
    function fit() {
      b.style.transform = 'none';
      var w = document.documentElement.clientWidth - 20;
      var s = Math.min(1, w / b.offsetWidth);
      b.style.transform = 'scale(' + s + ')';
      // A scaled element keeps its original height in flow — reclaim the gap.
      document.documentElement.style.height = (b.offsetHeight * s + 24) + 'px';
    }
    fit();
    window.addEventListener('resize', fit);
  })();
`;

function page(title, inner, { preview = false } = {}) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"/>
<title>${esc(title)}</title><style>${PAGE_CSS}${preview ? PREVIEW_CSS : ''}</style></head>
<body>${inner}</body>${preview ? `<script>${PREVIEW_JS}</script>` : ''}</html>`;
}

const signature = (ctx) => `
  <div class="sign">
    בכבוד רב,<br/>
    <span class="name">${esc(ctx.issuer_name)}</span>${ctx.issuer_title ? `<br/>${esc(ctx.issuer_title)}` : ''}<br/>
    ${esc(ctx.org_name)}
  </div>`;

const addressee = (ctx) => `
  <div class="meta">
    תאריך: ${esc(ctx.letter_date)}<br/>
    לכבוד:<br/>
    ${esc(ctx.honorific ? `${ctx.honorific} ${ctx.employee_name}` : ctx.employee_name)}<br/>
    ${ctx.israeli_id ? `ת.ז ${esc(ctx.israeli_id)}` : ''}
  </div>`;

/** מכתב זימון לשימוע. */
function hearingInvite(ctx, opts) {
  const f = ctx.female;
  const inner = `
  <div class="bsd">בס"ד</div>
  ${addressee(ctx)}
  <div class="subject">הנדון: זימון לשימוע.</div>
  <ol class="body">
    <li>${G(f, 'הנך מוזמנת בזאת לשימוע בעניינך במהלכו תידון אפשרות סיום העסקתך',
             'הנך מוזמן בזאת לשימוע בעניינך במהלכו תידון אפשרות סיום העסקתך')} ב${esc(ctx.workplace_word)}.</li>
    <li>הסיבות ${G(f, 'בעטיין', 'בעטיים')} נשקלת אפשרות סיום העסקתך ב${esc(ctx.workplace_word)} הינן:
      <div class="reasons">${escLines(ctx.reasons)}</div>
    </li>
    <li>השימוע ייערך ביום: ${esc(ctx.hearing_weekday)} - ${esc(ctx.hearing_date)} בשעה: ${esc(ctx.hearing_time)}
        ${esc(ctx.hearing_place)} בפני ${esc(ctx.hearing_before)}.</li>
    <li>במהלך ישיבת השימוע ${G(f, 'תהיי רשאית', 'תהיה רשאי')} להעלות את מכלול טענותיך והשגותיך.
        השימוע יתנהל בפתיחות ובתום לב, ואנו נשקול את טענותיך.</li>
    <li>לאחר קיום ישיבת השימוע תתקבל החלטה בדבר המשך או סיום העסקתך ב${esc(ctx.workplace_word)}
        והודעה על כך תימסר לך בכתב.</li>
    <li>${G(f, 'הנך רשאית', 'הנך רשאי')} להביא ${G(f, 'עמך', 'עמך')} להליך השימוע ידיד, בן משפחה או עו"ד,
        כפי ${G(f, 'שתמצאי', 'שתמצא')} לנכון.</li>
  </ol>
  ${signature(ctx)}`;
  return page(`זימון לשימוע — ${ctx.employee_name}`, inner, opts);
}

/** מכתב פיטורין. */
function termination(ctx, opts) {
  const f = ctx.female;
  const noticeLine = ctx.immediate
    ? `<li>${G(f, 'העסקתך מסתיימת לאלתר', 'העסקתך מסתיימת לאלתר')}.</li>`
    : `<li>העסקתך תסתיים ביום ${esc(ctx.end_date)}, בתום תקופת הודעה מוקדמת בת
        ${esc(String(ctx.notice_days))} ימים, בהתאם ל${esc(ctx.notice_law)}.</li>`;
  const inner = `
  <div class="bsd">בס"ד</div>
  ${addressee(ctx)}
  <div class="subject">הנדון: הודעה על סיום העסקה.</div>
  <ol class="body">
    ${String(ctx.reasons || '').trim() ? `<li>${escLines(ctx.reasons)}</li>` : ''}
    ${noticeLine}
    ${ctx.extra ? `<li>${escLines(ctx.extra)}</li>` : ''}
    <li>גמר החשבון, לרבות פדיון ימי חופשה ויתר הזכויות המגיעות לך על פי דין,
        ${G(f, 'יועבר אלייך', 'יועבר אליך')} במסגרת המשכורת האחרונה.</li>
  </ol>
  <p>אנו מאחלים ל${esc(ctx.first_name)} הצלחה רבה בהמשך הדרך.</p>
  ${signature(ctx)}`;
  return page(`מכתב סיום העסקה — ${ctx.employee_name}`, inner, opts);
}

/** פרוטוקול ישיבת שימוע — filled in during/after the meeting. */
function hearingProtocol(ctx, opts) {
  const row = (label, value) => `<tr><td class="label">${label}</td><td>${esc(value) || '<span class="field"></span>'}</td></tr>`;
  const attendees = (ctx.attendees && ctx.attendees.length ? ctx.attendees : [{}, {}, {}])
    .map(a => `<tr><td class="label">שם: ${esc(a.name) || '<span class="field"></span>'}</td>
                   <td>תפקיד: ${esc(a.role) || '<span class="field"></span>'}</td></tr>`).join('');
  const inner = `
  <h2 style="text-align:center;margin:0 0 16pt">פרוטוקול ישיבת שימוע</h2>
  <table class="protocol">
    ${row('שם העובד/ת:', ctx.employee_name)}
    ${row('מספר ת.ז:', ctx.israeli_id)}
    ${row('תפקיד בחברה:', ctx.position)}
    ${row('תאריך תחילת העסקה:', ctx.start_date)}
    ${row('ישיבת השימוע נערכה ביום:', ctx.hearing_date)}
    ${row('בשעה:', ctx.hearing_time)}
  </table>
  <p style="margin:14pt 0 2pt;font-weight:600">נוכחים במעמד השימוע:</p>
  <table class="protocol">${attendees}</table>
  <p style="margin:16pt 0 2pt;font-weight:600">נימוקי המעסיק לקיום השימוע</p>
  <div class="box">${escLines(ctx.employer_reasons)}</div>
  <p style="margin:16pt 0 2pt;font-weight:600">טענות העובד/ת:</p>
  <div class="box">${escLines(ctx.employee_claims)}</div>
  <table class="protocol" style="margin-top:22pt">
    ${row('חתימת עורך השימוע:', '')}
    ${row('שם עורך השימוע:', ctx.issuer_name)}
    ${row('תפקיד בחברה:', ctx.issuer_title)}
  </table>
  <div class="note">*העתק מפרוטוקול זה יימסר לידי העובד/ת</div>`;
  return page(`פרוטוקול שימוע — ${ctx.employee_name}`, inner, opts);
}

/** אישור העסקה / מכתב סיום העסקה "לכל מען דבעי". */
function employmentConfirmation(ctx, opts) {
  const f = ctx.female;
  const period = ctx.end_date
    ? `בין התאריך ${esc(ctx.start_date)} ועד לתאריך ${esc(ctx.end_date)}`
    : `החל מתאריך ${esc(ctx.start_date)} ועד היום`;
  const inner = `
  <div class="meta">
    תאריך: ${esc(ctx.letter_date)}<br/><br/>
    לכבוד:<br/>כל מען דבעי
  </div>
  <div class="subject">הנדון: ${esc(ctx.end_date ? 'סיום העסקה' : 'אישור העסקה')}</div>
  <p>
    הריני לאשר כי ${esc(ctx.honorific || G(f, 'גב׳', 'מר'))} ${esc(ctx.employee_name)},
    ת.ז ${esc(ctx.israeli_id)}, ${G(f, 'הועסקה', 'הועסק')} ${ctx.end_date ? '' : '<b>ומועסקת</b> '}אצלנו
    ${period}, בהיקף ${esc(ctx.scope_text)}${ctx.position ? `, בתפקיד ${esc(ctx.position)}` : ''}.
  </p>
  ${ctx.extra ? `<p>${escLines(ctx.extra)}</p>` : ''}
  ${signature(ctx)}`;
  return page(`אישור העסקה — ${ctx.employee_name}`, inner, opts);
}

const RENDERERS = {
  hearing_invite: hearingInvite,
  termination,
  hearing_protocol: hearingProtocol,
  employment_confirmation: employmentConfirmation,
};

const LETTER_LABELS = {
  hearing_invite: 'זימון לשימוע',
  termination: 'מכתב סיום העסקה',
  hearing_protocol: 'פרוטוקול שימוע',
  employment_confirmation: 'אישור העסקה (לכל מען דבעי)',
};

/**
 * The merge context for one employee — everything the system already knows,
 * before the manager's own edits are layered on top.
 */
function buildContext(employee, { branch, issuer, overrides = {} } = {}) {
  const now = new Date();
  const salaryType = employee.salary_type === 'global' ? 'global' : 'hourly';
  const notice = noticePeriod(employee.start_date, { salaryType });
  // The employee card is the source of truth; an unset gender keeps the
  // feminine default the office's own templates are written in.
  const female = overrides.female !== undefined
    ? !!overrides.female
    : (employee.gender ? employee.gender === 'female' : true);
  const firstName = String(employee.full_name || '').trim().split(/\s+/)[0] || '';

  const base = {
    // identity
    employee_name: employee.full_name || '',
    first_name: firstName,
    israeli_id: employee.israeli_id || '',
    position: employee.position || '',
    branch_name: branch?.name || '',
    female,
    honorific: female ? 'גב׳' : 'מר',

    // dates
    letter_date: shortDate(now),
    start_date: longDate(employee.start_date),
    end_date: employee.end_date ? longDate(employee.end_date) : '',
    seniority: seniorityText(employee.start_date),

    // notice period
    notice_days: notice.days,
    notice_basis: notice.basis,
    notice_law: notice.law,
    salary_type: salaryType,

    // hearing (blank until the manager sets them)
    hearing_date: '',
    hearing_weekday: '',
    hearing_time: '',
    hearing_place: 'במשרדי המעון',
    hearing_before: branch?.name ? `מנהל/ת המעון` : 'מנהל/ת המעון',
    reasons: '',
    employer_reasons: '',
    employee_claims: '',
    attendees: [],
    immediate: false,
    extra: '',
    scope_text: salaryType === 'global' ? 'משרה מלאה' : 'משרה חלקית',
    workplace_word: 'מעון',

    // issuer
    issuer_name: issuer?.full_name || '',
    issuer_title: issuer?.role === 'branch_manager' ? 'מנהל/ת המעון'
      : issuer?.role === 'accountant' ? 'הנהלת חשבונות' : 'הנהלה',
    org_name: 'גן החלומות ע.ר',
  };

  const ctx = { ...base, ...overrides };
  // A hearing date implies its weekday — never make someone type both and risk
  // "יום שני, 30.10.24" landing on a Wednesday, as the Word copies sometimes did.
  if (overrides.hearing_date_iso) {
    ctx.hearing_date = shortDate(overrides.hearing_date_iso);
    ctx.hearing_weekday = weekdayName(overrides.hearing_date_iso);
  }
  if (overrides.end_date_iso) ctx.end_date = longDate(overrides.end_date_iso);
  if (overrides.letter_date_iso) ctx.letter_date = shortDate(overrides.letter_date_iso);
  return ctx;
}

function renderLetter(type, ctx, opts = {}) {
  const fn = RENDERERS[type];
  if (!fn) throw new Error(`unknown letter type: ${type}`);
  return fn(ctx, opts);
}

module.exports = {
  buildContext, renderLetter, noticePeriod, seniorityText, monthsBetween,
  shortDate, longDate, weekdayName,
  LETTER_TYPES: Object.keys(RENDERERS), LETTER_LABELS,
};
