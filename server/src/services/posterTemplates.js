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

/* ------------------------------------------------------------------ *
 * כרטיס יום הולדת
 * ------------------------------------------------------------------ */

/**
 * A4 portrait at 150dpi. htmlToPng renders at deviceScaleFactor 2, so what
 * comes out is 2480×3508 — A4 at 300dpi, which is what a print shop asks for
 * and what the gan's own printer wants. A card sized in `mm` would be the
 * tidier markup and would also be the wrong number of pixels: this path is a
 * screenshot, not a print job, and nothing here honours a page size.
 */
const CARD_W = 1240;
const CARD_H = 1754;

/**
 * The gan's palette rather than the poster templates' — those two are pink
 * and teal, which is the equipment list, not the brand. These four are the
 * application's own (client/src/theme/parentTheme.js), so a card printed off
 * the system and the portal a parent opens look like the same gan.
 */
const CARD_CSS = `
  :root{
    --ink:#2B2119; --brand:#B4540A; --brand-soft:#F2A03D;
    --paper:#FAF6F0; --light:#FFF1DC;
    --font-head:'Fredoka','Rubik','Heebo','Arial',sans-serif;
    --font-body:'Rubik','Heebo','Arial',sans-serif;
  }
  /* JPEG has no transparency: whatever is behind the card IS in the file. */
  body{background:#fff;margin:0}
  /* Centred rather than top-aligned: the greeting is four short lines, and
     stacked from the top they leave a third of the page empty under them —
     which reads as a card that failed to finish rather than one with air. */
  .card{width:${CARD_W}px;height:${CARD_H}px;position:relative;overflow:hidden;
        background:
          radial-gradient(900px 420px at 50% -120px, #FFF1DC 0%, rgba(255,241,220,0) 72%),
          linear-gradient(180deg,#FFFDF9 0%,var(--paper) 100%);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:84px 84px 132px}
  /* The rainbow is the logo's own, so the frame belongs to the gan rather
     than being a generic border. */
  .card::before{content:'';position:absolute;inset:0;
        border:18px solid transparent;
        border-image:linear-gradient(135deg,#e8443b,#f5871f,#f0a500,#2bb673,#2e7dd7,#8e44ad) 1}
  /* Drawn, not typed. See CARD_DECO. */
  .deco{position:absolute;z-index:1;line-height:0}
  .deco svg{display:block}
  .deco.a{top:64px;inset-inline-start:66px;transform:rotate(-9deg)}
  .deco.b{top:62px;inset-inline-end:66px;transform:rotate(7deg)}
  .deco.c{bottom:62px;inset-inline-start:70px;transform:rotate(6deg)}
  .deco.d{bottom:64px;inset-inline-end:70px;transform:rotate(-7deg)}
  /* Confetti: a dozen small shapes in the logo's colours, scattered down both
     margins so the page has life without anything competing with the name. */
  .confetti{position:absolute;z-index:0;border-radius:3px;opacity:.55}
  .logo{position:relative;z-index:3;margin-bottom:10px}
  .logo img{height:300px;width:auto}
  .kicker{position:relative;z-index:3;font-family:var(--font-head);font-weight:700;
          font-size:62px;color:var(--brand);letter-spacing:.5px;margin:0}
  .rule{position:relative;z-index:3;width:300px;height:12px;border-radius:12px;margin:30px 0 14px;
        background:linear-gradient(90deg,#e8443b,#f5871f,#2bb673,#2e7dd7,#8e44ad)}
  /* The biggest thing on the page on purpose — this is a card for one child,
     and the child reads their own name before anything else. The size comes
     in as a variable because a long name at a fixed size runs off the paper
     (see nameFontSize). */
  .name{position:relative;z-index:3;font-family:var(--font-head);font-weight:700;
        font-size:var(--name-size,104px);line-height:1.1;color:var(--ink);
        margin:14px 0 0;text-align:center;white-space:nowrap}
  /* Blank card: a line to write the name on, sitting INSIDE the greeting line
     where the name would have been — "______ היקר שלנו", the way the card the
     office has always handed out is written. On its own row it reads as a
     rule above a heading rather than as a space to fill in. */
  .name .blank{display:inline-block;width:420px;vertical-align:baseline;
               border-bottom:7px dashed var(--brand-soft)}
  /* The lines are broken by hand below, so nothing here may re-break them:
     a wrapped line leaves one word stranded and the blessing reads as a
     typing mistake. */
  .body{position:relative;z-index:3;font-family:var(--font-body);font-weight:500;
        font-size:46px;line-height:1.66;color:var(--ink);text-align:center;
        margin:48px 0 0;white-space:nowrap}
  .foot{position:absolute;z-index:3;bottom:76px;inset-inline:0;text-align:center;
         font-family:var(--font-head);font-weight:700;font-size:44px;color:var(--brand)}
`;

/* ----------------------------- decorations -----------------------------
 *
 * DRAWN, NOT TYPED — and that is the whole point of this block.
 *
 * The card used emoji (🎈🎂🎁⭐) and they looked right on every machine this
 * was written on. On Render they came out as four empty squares: that
 * Chromium is @sparticuz's Linux build and the image has no colour-emoji
 * font, so the glyphs have nothing to render with and fall back to tofu. The
 * failure is invisible locally and lands on a card a parent is holding.
 *
 * Inline SVG depends on no font at all. It also prints: a browser may be told
 * to drop background graphics, and these are foreground elements of the image
 * the server already flattened.
 */

/** The logo's own colours — the decorations belong to this gan, not to a theme. */
const CARD_COLORS = ['#e8443b', '#f5871f', '#f0a500', '#2bb673', '#2e7dd7', '#8e44ad'];

const BALLOON = `
<svg width="118" height="214" viewBox="0 0 118 214" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="59" cy="54" rx="44" ry="52" fill="#e8443b"/>
  <ellipse cx="44" cy="38" rx="13" ry="18" fill="#fff" opacity=".35"/>
  <path d="M59 104 l-9 14 h18 z" fill="#c23a32"/>
  <path d="M59 118 C 44 142, 76 160, 59 184 C 50 196, 62 204, 59 212"
        stroke="#B4540A" stroke-width="4" stroke-linecap="round" fill="none"/>
</svg>`;

const CAKE = `
<svg width="132" height="140" viewBox="0 0 132 140" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="74" width="100" height="52" rx="12" fill="#f5871f"/>
  <path d="M16 78 q14 16 28 0 q14 16 28 0 q14 16 28 0 q8 9 16 2 v-14 H16z" fill="#FFF1DC"/>
  <rect x="60" y="34" width="12" height="36" rx="5" fill="#2e7dd7"/>
  <ellipse cx="66" cy="26" rx="9" ry="13" fill="#f0a500"/>
  <circle cx="42" cy="104" r="6" fill="#FFF1DC"/>
  <circle cx="66" cy="112" r="6" fill="#FFF1DC"/>
  <circle cx="90" cy="102" r="6" fill="#FFF1DC"/>
</svg>`;

const GIFT = `
<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="14" y="48" width="100" height="68" rx="10" fill="#2bb673"/>
  <rect x="8" y="34" width="112" height="26" rx="9" fill="#17a05f"/>
  <rect x="55" y="34" width="18" height="82" fill="#f0a500"/>
  <path d="M64 34 C 44 34, 36 10, 54 12 C 66 13, 64 28, 64 34z" fill="#f0a500"/>
  <path d="M64 34 C 84 34, 92 10, 74 12 C 62 13, 64 28, 64 34z" fill="#f0a500"/>
</svg>`;

const STAR = `
<svg width="124" height="120" viewBox="0 0 124 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M62 6 l17 35 38 6 -28 27 7 39 -34 -19 -34 19 7 -39 -28 -27 38 -6z"
        fill="#f0a500" stroke="#e09000" stroke-width="3" stroke-linejoin="round"/>
</svg>`;

/** A small rainbow for the signature, where the 🌈 used to be. */
const MINI_RAINBOW = `
<svg width="52" height="30" viewBox="0 0 52 30" fill="none" xmlns="http://www.w3.org/2000/svg"
     style="vertical-align:-4px;margin-inline-end:10px">
  ${CARD_COLORS.slice(0, 5).map((c, i) => {
    const r = 23 - i * 4.4;
    return `<path d="M${26 - r} 28 a${r} ${r} 0 0 1 ${r * 2} 0" stroke="${c}" stroke-width="4" fill="none"/>`;
  }).join('')}
</svg>`;

/**
 * Twelve confetti shapes down the two margins.
 *
 * Fixed positions rather than random ones: a template that renders
 * differently every call cannot be tested, and two children in the same room
 * comparing cards would find them subtly different for no reason.
 */
const CONFETTI = [
  [112, 300, 18, 10, -20], [96, 520, 12, 12, 0], [140, 760, 20, 9, 35],
  [104, 1020, 14, 14, 15], [128, 1270, 18, 10, -30], [92, 1480, 12, 12, 10],
  [1112, 330, 18, 10, 25], [1130, 560, 12, 12, 0], [1086, 800, 20, 9, -25],
  [1124, 1060, 14, 14, -15], [1096, 1300, 18, 10, 30], [1134, 1500, 12, 12, 8],
].map(([x, y, w, h, rot], i) => {
  const c = CARD_COLORS[i % CARD_COLORS.length];
  const round = h === w ? 'border-radius:50%;' : '';
  return `<span class="confetti" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;`
       + `background:${c};${round}transform:rotate(${rot}deg)"></span>`;
}).join('');

const CARD_DECO = `
  <span class="deco a">${CAKE}</span>
  <span class="deco b">${BALLOON}</span>
  <span class="deco c">${GIFT}</span>
  <span class="deco d">${STAR}</span>
  ${CONFETTI}`;

/**
 * The greeting, in the child's gender when the gan knows it.
 *
 * The text the office asked for is written to a boy — היקר, שתצעד, שתבקש —
 * and handing a girl a card addressed to a boy is worse than any amount of
 * tidy code. Child.gender is blank for most children (it is filled in one tap
 * at a time, from the שבת rotation picker), so the masculine wording stays
 * the default: it is the text as given, and it is what a blank card has to
 * say anyway.
 */
function birthdayGreeting(gender) {
  const girl = gender === 'girl';
  return {
    dear: girl ? 'היקרה שלנו' : 'היקר שלנו',
    // Broken by hand, and short enough that the widest line fits the card:
    // the CSS forbids re-wrapping, so a line that does not fit would be a
    // line that runs off the paper.
    lines: [
      'היום יש לך יום הולדת וזה יום כה מיוחד.',
      'רצינו לאחל לך הרבה מהכל ובעיקר',
      'שמחה ואושר, בריאות והרבה חברים.',
      girl ? 'שתצעדי תמיד בדרך הטובה' : 'שתצעד תמיד בדרך הטובה',
      girl ? 'ושכל מה שתבקשי יתממש ובמהרה.' : 'ושכל מה שתבקש יתממש ובמהרה.',
    ],
  };
}

/**
 * A size at which the name still fits across the card.
 *
 * The line must not wrap — "שירה לוי היקרה" on one line and "שלנו" on the
 * next is not a card anybody hands to a parent — so the type shrinks instead.
 * The steps are measured against the usable width (the card less its padding)
 * at the heading font's roughly 0.52em average advance in Hebrew; they are
 * deliberately conservative, because a name two sizes too small still reads
 * and a name one pixel too wide is cut off.
 */
function nameFontSize(line) {
  const n = String(line || '').length;
  if (n <= 16) return 104;
  if (n <= 20) return 92;
  if (n <= 25) return 78;
  if (n <= 32) return 64;
  return 54;
}

/**
 * @param {Object} opts
 * @param {string} [opts.name]   the child's name; empty = a line to fill in
 * @param {string} [opts.gender] 'boy' | 'girl' | '' — inflects the greeting
 * @param {string} [opts.footer]
 */
function buildBirthdayCardHtml({ name = '', gender = '', footer = 'באהבה, צוות גן החלומות' } = {}) {
  const logo = letterhead.logoDataUrl();
  const g = birthdayGreeting(gender);
  const trimmed = String(name || '').trim();
  // The blank rule is 420px wide; counted as the characters it stands in for
  // so an empty card is sized by the same rule as a named one.
  const line = trimmed ? `${trimmed} ${g.dear}` : `${'_'.repeat(8)} ${g.dear}`;
  const size = nameFontSize(line);

  const nameBlock = trimmed
    ? `<div class="name">${esc(line)}</div>`
    : `<div class="name"><span class="blank"></span> ${esc(g.dear)}</div>`;

  return `<!doctype html>
<html lang="he" dir="rtl"><head>${BASE_HEAD}<style>${CARD_CSS}</style>
<style>:root{--name-size:${size}px}</style></head>
<body>
  <div class="card">
    ${CARD_DECO}
    ${logo ? `<div class="logo"><img src="${logo}" alt="גן החלומות"/></div>` : ''}
    <h1 class="kicker">מזל טוב!</h1>
    <div class="rule"></div>
    ${nameBlock}
    <div class="body">${g.lines.map(l => esc(l)).join('<br>')}</div>
    <div class="foot">${MINI_RAINBOW}${esc(footer)}</div>
  </div>
</body></html>`;
}

module.exports = {
  buildVacationPosterHtml,
  buildSupplyListPosterHtml,
  buildBirthdayCardHtml,
  CARD_W,
  DEFAULT_PALETTE,
};
