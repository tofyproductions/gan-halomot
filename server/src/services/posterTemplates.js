/**
 * HTML builders for the two parent-facing posters — the vacation calendar and
 * the equipment list — rendered to PNG via services/htmlPdf.js#htmlToPng.
 *
 * Entirely self-contained markup on purpose: htmlToPng runs Chromium with its
 * network cut (every request but the document itself is aborted), so there is
 * no web font, no external image — the logo is a data: URI (letterhead.js)
 * and the fonts fall back to whatever sans-serif Chromium has locally, same
 * as the gantt image already relies on.
 */

const letterhead = require('./letterhead');

const HEB_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// The same 12-color rotation the original static calendar used — a stable
// default for any entry the office hasn't picked a color for yet.
const DEFAULT_PALETTE = [
  '#e8443b', '#f5871f', '#f0a500', '#2bb673', '#17a2b8',
  '#2e7dd7', '#5b57c9', '#8e44ad', '#e84393', '#ff6f91', '#00a8cc', '#06d6a0',
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function weekdayOf(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'YYYY-MM-DD' → 'D.M.YY' */
function fmtDMY(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return `${d}.${m}.${String(y).slice(-2)}`;
}

function dateLabel(start, end) {
  return start === end ? fmtDMY(start) : `${fmtDMY(start)} – ${fmtDMY(end)}`;
}

function daysLabel(start, end) {
  const a = HEB_WEEKDAYS[weekdayOf(start)];
  const b = HEB_WEEKDAYS[weekdayOf(end)];
  return start === end ? a : `${a}–${b}`;
}

const BASE_HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:'Rubik','Heebo','Arial',sans-serif;color:#243244}
</style>
`;

const VACATION_CSS = `
  :root{
    --paper:#fffdf6; --ink:#1f2937; --muted:#6b7280;
    --title:#ef476f; --subtitle:#118ab2; --year:#8a7f6a;
    --card:#ffffff; --radius:26px; --row-radius:15px;
    --shadow:0 14px 40px rgba(60,90,150,.18); --row-shadow:0 3px 12px rgba(0,0,0,.06);
    --font-head:'Fredoka','Rubik','Heebo','Arial',sans-serif;
    --font-body:'Rubik','Heebo','Arial',sans-serif;
  }
  body{background:#eef1f6;display:flex;justify-content:center;padding:24px}
  .poster{width:794px;background:var(--paper);border-radius:var(--radius);
          padding:40px 36px 30px;position:relative;overflow:hidden;box-shadow:var(--shadow)}
  .deco{position:absolute;font-size:46px;opacity:.5;z-index:1;line-height:1}
  .deco.a{top:22px;inset-inline-start:28px}
  .deco.b{top:210px;inset-inline-end:20px}
  .deco.c{bottom:120px;inset-inline-start:18px}
  .deco.d{bottom:26px;inset-inline-end:30px}
  .head{text-align:center;position:relative;z-index:3;margin-bottom:22px}
  .head img{height:110px;width:auto;margin-bottom:8px}
  .head h1{font-family:var(--font-head);font-weight:700;color:var(--title);font-size:52px;margin:0;line-height:1.05}
  .head h2{font-family:var(--font-head);font-weight:600;color:var(--subtitle);font-size:30px;margin:2px 0 0}
  .head .year{font-size:18px;font-weight:600;color:var(--year);margin-top:6px}
  .list{display:flex;flex-direction:column;gap:11px;position:relative;z-index:3}
  .row{display:flex;align-items:center;gap:14px;background:var(--card);
       border-inline-start:9px solid var(--c);border-radius:var(--row-radius);
       padding:12px 18px;box-shadow:var(--row-shadow)}
  .row .emoji{font-size:26px;width:34px;text-align:center;flex:none}
  .row .mid{flex:1;min-width:0}
  .row .name{font-weight:800;font-size:20px;line-height:1.15}
  .row .sub{font-size:14px;color:var(--muted);margin-top:2px}
  .row .ret{font-size:13.5px;font-weight:800;color:var(--c);margin-top:3px}
  .row .badge{font-weight:800;font-size:16px;color:#fff;background:var(--c);
              border-radius:12px;padding:8px 14px;white-space:nowrap;flex:none}
  .foot{text-align:center;font-size:14px;font-weight:600;color:var(--muted);opacity:.85;margin-top:18px;position:relative;z-index:3}
`;

const SUPPLY_CSS = `
  :root{
    --paper:#fffdf6; --ink:#243244; --muted:#6b7280;
    --title:#ef476f; --subtitle:#118ab2; --year:#8a7f6a;
    --radius:30px; --row-radius:18px;
    --shadow:0 18px 46px rgba(60,90,150,.20); --row-shadow:0 4px 14px rgba(60,90,150,.08);
    --font-head:'Fredoka','Rubik','Heebo','Arial',sans-serif;
    --font-body:'Rubik','Heebo','Arial',sans-serif;
  }
  body{background:#e9edf4;display:flex;justify-content:center;padding:24px}
  .poster{width:820px;border-radius:var(--radius);position:relative;overflow:hidden;
          padding:38px 40px 30px;box-shadow:var(--shadow);
          background:
            radial-gradient(1200px 300px at 50% -140px, #fff6ef 0%, rgba(255,246,239,0) 70%),
            linear-gradient(180deg,#fffdf6 0%,#fff8ee 100%);
          border:1px solid #f2e7d6}
  .deco{position:absolute;font-size:40px;opacity:.45;z-index:1;line-height:1}
  .deco.a{top:20px;inset-inline-start:26px;transform:rotate(-12deg)}
  .deco.b{top:220px;inset-inline-end:16px}
  .deco.c{bottom:120px;inset-inline-start:14px}
  .deco.d{bottom:22px;inset-inline-end:26px;transform:rotate(10deg)}
  .head{text-align:center;position:relative;z-index:3;margin-bottom:22px}
  .head img{height:132px;width:auto;margin-bottom:6px}
  .head h1{font-family:var(--font-head);font-weight:700;color:var(--title);font-size:56px;margin:0;line-height:1.02}
  .head h2{font-family:var(--font-head);font-weight:600;color:var(--subtitle);font-size:30px;margin:1px 0 0}
  .head .lead{font-size:17px;font-weight:600;color:var(--year);margin-top:8px}
  .head .rule{width:130px;height:6px;border-radius:6px;margin:12px auto 0;
              background:linear-gradient(90deg,#e8443b,#f5871f,#2bb673,#2e7dd7,#8e44ad)}
  .list{display:flex;flex-direction:column;gap:10px;position:relative;z-index:3}
  .row{display:flex;align-items:center;gap:14px;border-radius:var(--row-radius);
       padding:12px 16px 12px 14px;box-shadow:var(--row-shadow);
       border-inline-start:10px solid var(--c);background:#fff}
  .row .emoji{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;
              font-size:24px;flex:none;background:#fff}
  .row .mid{flex:1;min-width:0}
  .row .name{font-weight:800;font-size:20px;line-height:1.2;color:var(--ink)}
  .row .note{font-size:13.5px;font-weight:800;color:var(--c);margin-top:3px}
  .row .check{width:28px;height:28px;border-radius:9px;border:3px solid var(--c);flex:none;background:#fff}
  .callout{position:relative;z-index:3;margin-top:22px;text-align:center;
           background:#fff4d1;border:2px dashed #eaa300;border-radius:18px;
           padding:13px 16px;font-family:var(--font-head);font-weight:700;font-size:20px;color:#8a5a00}
  .foot{text-align:center;font-size:15px;font-weight:700;color:var(--subtitle);margin-top:14px;position:relative;z-index:3}
`;

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {string} opts.schoolYear
 * @param {string} opts.footer
 * @param {Array}  opts.entries — vacationCalendar.readCalendar() rows
 *   ({name,start,end,hebrew,note,return_note,emoji,color})
 */
function buildVacationPosterHtml({ title, subtitle, schoolYear, footer, entries }) {
  const logo = letterhead.headerHtml();
  const rows = (entries || []).map((e, i) => {
    const color = e.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
    const sub = [daysLabel(e.start, e.end), e.hebrew, e.note].filter(Boolean).map(esc).join('  ·  ');
    return `
      <div class="row" style="--c:${esc(color)}">
        <div class="emoji">${esc(e.emoji || '')}</div>
        <div class="mid">
          <div class="name">${esc(e.name)}</div>
          ${sub ? `<div class="sub">${sub}</div>` : ''}
          ${e.return_note ? `<div class="ret">${esc(e.return_note)}</div>` : ''}
        </div>
        <div class="badge">${esc(dateLabel(e.start, e.end))}</div>
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="he" dir="rtl"><head>${BASE_HEAD}<style>${VACATION_CSS}</style></head>
<body>
  <div class="poster">
    <span class="deco a">☀️</span><span class="deco b">🍉</span>
    <span class="deco c">🍦</span><span class="deco d">🌈</span>
    <header class="head">
      ${logo}
      <h1>${esc(title)}</h1>
      <h2>${esc(subtitle)}</h2>
      <div class="year">${esc(schoolYear)}</div>
    </header>
    <main class="list">${rows}</main>
    <footer class="foot">${esc(footer)}</footer>
  </div>
</body></html>`;
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {string} opts.lead
 * @param {string} opts.callout
 * @param {string} opts.footer
 * @param {Array}  opts.items — [{name,note,emoji,color}]
 */
function buildSupplyListPosterHtml({ title, subtitle, lead, callout, footer, items }) {
  const logo = letterhead.headerHtml();
  const rows = (items || []).map((it, i) => {
    const color = it.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
    return `
      <div class="row" style="--c:${esc(color)}">
        <div class="emoji">${esc(it.emoji || '')}</div>
        <div class="mid">
          <div class="name">${esc(it.name)}</div>
          ${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}
        </div>
        <div class="check"></div>
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="he" dir="rtl"><head>${BASE_HEAD}<style>${SUPPLY_CSS}</style></head>
<body>
  <div class="poster">
    <span class="deco a">🎒</span><span class="deco b">✏️</span>
    <span class="deco c">🧸</span><span class="deco d">⭐</span>
    <header class="head">
      ${logo}
      <h1>${esc(title)}</h1>
      <h2>${esc(subtitle)}</h2>
      ${lead ? `<div class="lead">${esc(lead)}</div>` : ''}
      <div class="rule"></div>
    </header>
    <main class="list">${rows}</main>
    ${callout ? `<div class="callout">⭐&nbsp;&nbsp;${esc(callout)}&nbsp;&nbsp;⭐</div>` : ''}
    <footer class="foot">${esc(footer)}</footer>
  </div>
</body></html>`;
}

module.exports = { buildVacationPosterHtml, buildSupplyListPosterHtml, DEFAULT_PALETTE };
