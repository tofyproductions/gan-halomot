/**
 * A month's work plan, on one A4 landscape page, readable.
 *
 * Printing the live screen does not do this. The editor is a stack of MUI
 * cards full of text fields — it prints the app's header, the buttons, the
 * shadows, a text field's box around every idea, and it runs to four pages
 * that nobody can pin up. So this builds a standalone document and prints
 * THAT, which is what the rest of the system already does for the hours
 * report and the attendance monitor.
 *
 * Height is the whole design constraint, and the previous sheet spent it on
 * chrome: every week paid for its own banner row and its own two-line
 * day-header row — ten overhead rows on a five-week month, a third of the
 * page — and a week the gan was closed for still cost a full block. The type
 * shrank to 5.6pt to pay for that, which is a footnote, not a wall sheet.
 *
 * This layout is ONE calendar grid. The day header is paid for once. A week's
 * number, topic and dates live in a band down the right edge, one slim date
 * strip per week carries the dates, the holidays and the short days, the
 * Shabbat parents stand under קבלת שבת, and a week the gan is closed for is a
 * single line. A שונות
 * row with nothing in it that week is not printed at all, and one with
 * something in it is kept short. What all of that buys is type: the same
 * month prints about 45% larger, and never below 8pt.
 */
import { COLOR } from '../../theme/tokens';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const MONTH_NAMES = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * A colour per row, the same ones the bank and the editor use.
 *
 * On paper this is not decoration. The sheet is read by somebody looking for
 * one thing — "what is the story today" — and a coloured band is findable
 * where a row label is not. Each row also gets a solid stripe of its `ink`
 * beside the label, so the bands still read on a black-and-white printer.
 */
const ROW_TINT = {
  meeting: COLOR.gantt.row.meeting,
  activity: COLOR.gantt.row.activity,
  creation: COLOR.gantt.row.creation,
  story: COLOR.gantt.row.story,
  misc: COLOR.gantt.row.misc,
};
const tintOf = (key) => ROW_TINT[key]
  || { bg: COLOR.background.default, label: COLOR.background.sunken, ink: COLOR.text.primary };

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const holidayYmd = (v) => new Date(v).toISOString().slice(0, 10);
const dm = (d) => `${d.getDate()}.${d.getMonth() + 1}`;

/**
 * The plan as a standalone printable document.
 *
 * Mirrors the editor's own day arithmetic deliberately rather than sharing it:
 * a print sheet that disagrees with the screen about which box is Tuesday is
 * worse than no print sheet, so the rules are written out here in full and the
 * weekday test covers the shape both of them read.
 */
export function buildGanttPrintHtml({
  weeks = [], rows = [], holidays = [], month, year,
  classroomName = '', branchName = '', status = 'draft',
  // 'print' → A4 landscape, fitted to `pages` sheets.
  // 'image' → one continuous picture for WhatsApp. No paper, so no page to fit
  //   into and nothing to shrink: the canvas grows to the month instead, and
  //   the type is set once at a size that survives a phone screen.
  mode = 'print',
  pages = 1,
}) {
  const image = mode === 'image';

  const isHoliday = (d) => holidays.find(h => (
    ymd(d) >= holidayYmd(h.start_date) && ymd(d) <= holidayYmd(h.end_date)
  ));
  const isClosed = (d) => {
    const h = isHoliday(d);
    return h && h.kind !== 'short_day' ? h : null;
  };
  const inMonth = (d) => d.getMonth() === month - 1 && d.getFullYear() === year;

  const weekHtml = (week) => {
    // day_index is counted from start_date, which is the week's Sunday.
    const offset = new Date(week.start_date).getDay();
    const sunday = new Date(week.start_date);
    sunday.setDate(sunday.getDate() - offset);
    const dateOf = (di) => { const d = new Date(sunday); d.setDate(d.getDate() + di); return d; };
    const cellAt = (rowKey, di) => (week.cells || [])
      .find(c => c.row_key === rowKey && c.day_index === di - offset);
    const contentAt = (rowKey, di) => String(cellAt(rowKey, di)?.content || '').trim();
    const spanAt = (rowKey, di, field) => {
      const n = Number(cellAt(rowKey, di)?.[field]);
      return Number.isFinite(n) && n > 1 ? n : 1;
    };

    /**
     * A box the gananet merged across days or rows is one box.
     *
     * The editor stores a merge as col_span/row_span on the top-right cell and
     * BLANKS the cells it swallowed. Every span paints its whole rectangle
     * here, rather than each axis being tested on its own: a 2×3 merge
     * starting at Monday covers Tuesday two rows down, but nothing in
     * Tuesday's column carries a rowspan — the cell that does is in Monday's.
     */
    const covered = new Set();
    rows.forEach((r, rowIdx) => {
      for (let di = 0; di < 6; di += 1) {
        const cs = spanAt(r.key, di, 'col_span');
        const rs = spanAt(r.key, di, 'row_span');
        if (cs === 1 && rs === 1) continue;
        for (let rr = rowIdx; rr < Math.min(rowIdx + rs, rows.length); rr += 1) {
          for (let dd = di; dd < Math.min(di + cs, 6); dd += 1) {
            if (rr === rowIdx && dd === di) continue;   // the box itself
            covered.add(`${rr}|${dd}`);
          }
        }
      }
    });

    const days = [0, 1, 2, 3, 4, 5].map((di) => {
      const d = dateOf(di);
      return { di, d, hol: isHoliday(d), shut: isClosed(d), own: inMonth(d) };
    });
    const own = days.filter(x => x.own);
    const range = own.length ? `${dm(own[0].d)} – ${dm(own[own.length - 1].d)}` : '';

    // The week's band: number, topic, dates. One cell down the right edge.
    const band = (span) => `<td class="wk" rowspan="${span}">
      <div class="wn">שבוע ${week.week_number}</div>
      <div class="wt">${esc(week.topic || '')}</div>
      <div class="wr">${esc(range)}</div>
    </td>`;

    // A week the gan is closed for every day of: one line, and the page gets
    // the rest of the block back. A closed day that already has work written
    // in it must stay visible, so that week is not collapsed.
    const hasWork = (di) => rows.some(r => contentAt(r.key, di));
    if (own.length && own.every(x => x.shut && !hasWork(x.di))) {
      const h = own[0].shut;
      return `<tr class="closedwk">${band(1)}<td class="rl"></td>
        <td class="shutwk" colspan="6">${esc(h.emoji || '')} ${esc(h.name)} — הגן סגור · ${esc(range)}</td></tr>`;
    }

    // A שונות row with nothing in it this week is not printed. One with
    // something in it is printed short — it holds a note, not a plan.
    const printed = rows.filter(r => r.key !== 'misc' || days.some(x => contentAt(r.key, x.di)));
    const nRows = printed.length;

    // The date strip: the date under each day, and what the day is.
    const strip = days.map(({ di, d, hol, shut, own: isOwn }) => {
      const cls = ['ds', shut ? 'shut' : hol ? 'short' : '', isOwn ? '' : 'borrowed'].filter(Boolean).join(' ');
      const note = hol
        ? `<span class="hn">${esc(hol.emoji || '')} ${esc(hol.name)}${!shut && hol.end_time ? ` · עד ${esc(hol.end_time)}` : ''}</span>`
        : '';
      return `<td class="${cls}"><b>${dm(d)}</b>${note}</td>`;
    }).join('');

    // A closed column collapses to one cell — unless work is already written
    // in it, which must stay visible.
    const collapsed = new Set(days.filter(x => x.shut && !hasWork(x.di)).map(x => x.di));

    const body = printed.map((row, printedIdx) => {
      const rowIdx = rows.indexOf(row);
      const t = tintOf(row.key);
      const tds = days.map(({ di, shut, own: isOwn }) => {
        // Swallowed by a merge that starts above or to the right of here.
        if (!collapsed.has(di) && covered.has(`${rowIdx}|${di}`)) return '';

        if (collapsed.has(di)) {
          if (printedIdx > 0) return '';
          return `<td class="closedcol" rowspan="${nRows}">
            <div class="ce">${esc(shut.emoji || '')}</div>
            <div class="cn">${esc(shut.name)}</div>
            <div class="cnote">הגן סגור</div>
          </td>`;
        }

        // A closed day that has work in some row keeps every cell of its
        // column amber and named. This comes BEFORE the Friday special: a
        // closed Friday must not print "קבלת שבת" as if the gan were open.
        if (shut) {
          return `<td class="c shutc">${esc(contentAt(row.key, di)) || esc(shut.name)}</td>`;
        }
        if (di === 5 && row.key === 'meeting') {
          // The Shabbat parents, each on a line of their own under קבלת שבת.
          // The names are written as "אבא של נועה" already; a label on top of
          // that would read "אבא של שבת אבא של נועה". Only a bare name gets one.
          const who = (name, label) => (/^(אבא|אמא|הורים?)(\s|$)/.test(name) ? esc(name) : `${label} ${esc(name)}`);
          const f = String(week.friday_parent_father || '').trim();
          const m = String(week.friday_parent_mother || '').trim();
          const parents = [f && who(f, 'אבא של שבת:'), m && who(m, 'אמא של שבת:')]
            .filter(Boolean).map(x => `<div class="fp">${x}</div>`).join('');
          return `<td class="c fri strong">קבלת שבת${parents}</td>`;
        }

        const cell = cellAt(row.key, di);
        // A merge is clamped to what is actually on this sheet: a row deleted
        // after the merge was made would leave a rowspan reaching past the
        // last row, and an overrunning rowspan pulls the whole table apart.
        const cs = Math.min(spanAt(row.key, di, 'col_span'), 6 - di);
        const rs = Math.min(spanAt(row.key, di, 'row_span'), nRows - printedIdx);
        const span = `${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}`;
        const cls = ['c', di === 5 ? 'fri' : '', isOwn ? '' : 'borrowed', cs > 1 || rs > 1 ? 'merged' : '']
          .filter(Boolean).join(' ');
        // A colour the gananet set by hand on that one box wins over the row's.
        const bg = cell?.color || t.bg;
        return `<td class="${cls}"${span} style="background:${esc(bg)} !important">${esc(contentAt(row.key, di))}</td>`;
      }).join('');

      const rl = `<th class="rl${row.key === 'misc' ? ' min' : ''}" style="background:${t.label} !important;color:${t.ink};border-right-color:${t.ink}">${esc(row.label)}</th>`;
      return `<tr>${rl}${tds}</tr>`;
    }).join('');

    return `<tr class="strip">${band(nRows + 1)}<th class="rl corner"></th>${strip}</tr>${body}`;
  };

  const statusLabel = status === 'approved' ? 'מאושר' : status === 'pending' ? 'ממתין לאישור' : 'טיוטה';
  const G = COLOR.gantt;
  const legend = rows.map(r => `<span><i style="background:${tintOf(r.key).label}"></i>${esc(r.label)}</span>`).join('')
    + `<span><i style="background:${G.cell.holiday}"></i>חג / יום קצר</span>`
    + `<span><i style="background:${G.cell.friday}"></i>שישי</span>`;

  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<title>תוכנית עבודה - ${esc(classroomName)} - ${MONTH_NAMES[month]} ${year}</title>
<style>
  /* Landscape, because six day-columns across a portrait page leaves a column
     the width of a thumb. */
  @page { size: A4 landscape; margin: 7mm; }
  ${image ? `
  /* The picture is not a page. Nothing here is measured against paper: the
     sheet is as tall as the month needs, the type is fixed, and WhatsApp's
     viewer does the scrolling that a printer cannot. */
  @page { size: auto; margin: 0; }
  body.img { width: 1400px !important; padding: 22px 26px !important; }
  body.img td.c { padding: 12px 8px !important; line-height: 1.3; }
  body.img .head { margin-bottom: 14px; }
  ` : ''}
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html { background: ${COLOR.divider}; }
  /*
   * The body is exactly the printable width of the page, always. Without this
   * the sheet is laid out at the WINDOW's width and then scaled by the browser
   * to fit the paper, so the fit script below would be measuring a different
   * document from the one that prints.
   */
  body { width: 283mm; margin: 0 auto; background: #fff; padding: 0;
         box-shadow: 0 0 0 1px ${COLOR.dividerStrong}, 0 6px 24px rgba(15,23,42,.12); }
  @media print { html { background: #fff; } body { box-shadow: none; margin: 0; } }
  :root { --k: 1; --pad: 0mm; --cell: 10pt; --head: 10.5pt; --small: 8pt; }
  body { font-family: "Assistant", Arial, "Arial Hebrew", sans-serif; color: ${COLOR.text.primary}; }

  .head { display: flex; align-items: baseline; justify-content: space-between;
          margin: 0 0 2mm; padding-bottom: 1.2mm; border-bottom: 0.6mm solid ${G.header}; }
  .head .t { font-size: calc(var(--head) * var(--k) * 1.9); font-weight: 800; color: ${G.header}; }
  .head .t small { font-weight: 600; font-size: 70%; color: ${COLOR.text.secondary}; margin-right: 3mm; }
  .head .s { font-size: calc(var(--head) * var(--k) * 1.05); color: ${COLOR.text.secondary}; font-weight: 700; }
  .head .s .st { display: inline-block; border: 0.3mm solid ${COLOR.text.secondary}; border-radius: 1mm;
                 padding: 0 1.5mm; margin-right: 2mm; font-size: 85%; }

  /* A real grid. Thin rules, no gaps, no rounded tiles: on a black-and-white
     or a weak printer the tints go and the rules are what is left. */
  table.g { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.g th, table.g td { border: 0.25mm solid #b9b2a9; vertical-align: middle; }
  col.cwk { width: 26mm; } col.crl { width: 17mm; }

  /* One day header for the whole month. */
  thead th.d { background: ${G.header} !important; color: ${G.headerOn};
               font-size: calc(var(--head) * var(--k) * 1.15); font-weight: 800; padding: 1mm; text-align: center; }
  thead th.d.fri { background: ${G.day.friday.bg} !important; }
  thead th.blank { background: #fff !important; border: none; }

  /* The week's band. */
  td.wk { background: ${G.header} !important; color: ${G.headerOn}; text-align: center; padding: 1mm 1.5mm; }
  td.wk .wn { font-size: calc(var(--small) * var(--k)); opacity: .8; font-weight: 700; }
  td.wk .wt { font-size: calc(var(--head) * var(--k) * 1.1); font-weight: 800; line-height: 1.15; margin: 0.6mm 0; }
  td.wk .wr { font-size: calc(var(--small) * var(--k)); opacity: .85; }

  /* The date strip. */
  tr.strip td.ds { background: ${COLOR.background.sunken} !important; text-align: center; padding: 0.3mm 1mm;
                   font-size: calc(var(--small) * var(--k)); line-height: 1.2; color: ${COLOR.text.primary}; }
  tr.strip td.ds .hn { display: block; font-weight: 800; color: ${G.note.on}; }
  tr.strip td.ds.short { background: ${G.cell.holiday} !important; }
  tr.strip td.ds.shut { background: ${G.day.closed.bg} !important; color: ${G.day.closed.on}; }
  tr.strip td.ds.shut .hn { color: ${G.day.closed.on}; }
  tr.strip td.ds.borrowed:not(.shut):not(.short) { color: ${COLOR.text.disabled}; }
  tr.strip th.corner { background: ${COLOR.background.sunken} !important; }

  th.rl { font-weight: 800; text-align: center; font-size: calc(var(--head) * var(--k)); padding: 0.5mm;
          line-height: 1.1; border-right-width: 1.2mm !important; border-right-style: solid !important; }
  td.c { padding: calc(0.9mm + var(--pad)) 1.2mm; text-align: center; font-size: calc(var(--cell) * var(--k));
         line-height: 1.22; font-weight: 600; overflow-wrap: anywhere; }
  /* A day borrowed from the month next door is written in like any other, just
     quieter, so a reader knows which month they are in. */
  td.c.borrowed { color: ${COLOR.text.disabled}; }
  /* A merged box carries the week's one big idea across several days. It gets
     the weight to match, or a wide box of ordinary text just looks like a cell
     somebody forgot to fill in. */
  td.c.merged { font-weight: 800; font-size: calc(var(--cell) * var(--k) * 1.2); }
  td.c.strong { font-weight: 800; color: ${G.span.on}; font-size: calc(var(--head) * var(--k) * 1.1);
                background: ${G.cell.friday} !important; }
  td.c.strong .fp { font-size: calc(var(--cell) * var(--k) * 0.95); font-weight: 700; line-height: 1.3; margin-top: 0.4mm; }
  td.c.shutc { background: ${G.cell.holiday} !important; color: ${G.note.on}; font-weight: 700; }
  td.closedcol { background: ${G.cell.holiday} !important; text-align: center; }
  td.closedcol .ce { font-size: calc(var(--head) * var(--k) * 1.6); line-height: 1.2; }
  td.closedcol .cn { font-size: calc(var(--head) * var(--k) * 1.3); font-weight: 800; color: ${G.note.on}; line-height: 1.2; }
  td.closedcol .cnote { font-size: calc(var(--small) * var(--k)); color: ${G.note.on}; font-weight: 700; }
  tr.closedwk td.shutwk { background: ${G.cell.holiday} !important; text-align: center; font-weight: 800;
                          color: ${G.note.on}; font-size: calc(var(--head) * var(--k) * 1.2); padding: 1.5mm; }
  tr.closedwk td.rl { background: ${COLOR.background.sunken} !important; }

  /* שונות is a note, not a plan: it is printed short. */
  th.rl.min { font-size: calc(var(--head) * var(--k) * 0.9); padding: 0.2mm; }
  th.rl.min ~ td.c { padding: calc(0.3mm + var(--pad) * 0.4) 1mm; font-size: calc(var(--cell) * var(--k) * 0.9); line-height: 1.15; }

  /* The last lever before giving up: take the air out rather than the type. */
  body.tight td.c { padding: calc(0.4mm + var(--pad)) 0.8mm; line-height: 1.1; }
  body.tight th.rl { padding: 0.3mm; }
  body.tight td.wk { padding: 0.5mm 1mm; }

  .foot { margin-top: 1.5mm; font-size: calc(var(--small) * var(--k)); color: ${COLOR.text.disabled};
          display: flex; justify-content: space-between; align-items: center; }
  .foot .legend span { display: inline-block; margin-left: 3mm; }
  .foot .legend i { display: inline-block; width: 3mm; height: 3mm; vertical-align: middle; margin-left: 1mm;
                    border: 0.2mm solid #b9b2a9; }

  .bar { position: fixed; top: 8px; left: 8px; display: flex; gap: 6px; align-items: center; z-index: 9999; }
  .toolbar { background: ${COLOR.primary.light}; color: #111; padding: 8px 14px; border-radius: 6px;
             font-weight: 700; cursor: pointer; border: none; font-size: 14px; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .toolbar.alt { background: #25D366; color: #fff; }
  .toolbar.ghost { background: #fff; color: ${COLOR.text.primary}; border: 1px solid ${COLOR.dividerStrong}; }
  @media print { .bar { display: none !important; } }
</style>
</head>
<body${image ? ' class="img"' : ''}>
  ${image ? '' : `<div class="bar">
    <button class="toolbar" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
    <button class="toolbar ghost" onclick="window.__ganttPages()">${pages === 1 ? 'כתב גדול · 2 עמודים' : 'לדחוס לעמוד אחד'}</button>
    <button class="toolbar alt" onclick="window.__ganttImage()">📷 תמונה לוואטסאפ</button>
  </div>`}
  <div class="head">
    <div class="t">תוכנית עבודה <small>${MONTH_NAMES[month]} ${year}</small></div>
    <div class="s">${esc(classroomName)}${branchName ? ` · ${esc(branchName)}` : ''}<span class="st">${statusLabel}</span></div>
  </div>
  <table class="g">
    <colgroup><col class="cwk"><col class="crl">${'<col>'.repeat(6)}</colgroup>
    <thead><tr><th class="blank" colspan="2"></th>${DAY_NAMES.map((n, i) => `<th class="d${i === 5 ? ' fri' : ''}">יום ${esc(n)}</th>`).join('')}</tr></thead>
    <tbody>${weeks.map(weekHtml).join('')}</tbody>
  </table>
  <div class="foot">
    <div class="legend">${legend}</div>
    <div>גן החלומות · הופק ${new Date().toLocaleDateString('he-IL')}</div>
  </div>
<script>
  /**
   * Fit the month to the page, then spend what is left on readability.
   *
   * The type scale cannot be estimated from the shape of the month alone —
   * the text decides. So the page measures itself and steps down until the
   * whole month is on the sheet the reader asked for. The first floor is 0.8
   * (8pt in a cell): below that the air is taken out of the cells before the
   * type is touched again, and the hard floor is 0.7. Then, if there is room,
   * it grows the type back up, and whatever is still left becomes row height.
   */
  (function fit() {
    if (${image ? 'true' : 'false'}) { document.body.classList.add('img'); return; }

    var MM = 96 / 25.4;
    var oneP = (210 - 14) * MM;    // A4 landscape less the 7mm @page margins
    var BUDGET = ${Math.max(1, Math.min(2, Number(pages) || 1))};
    var pageH = oneP * BUDGET;
    var root = document.documentElement;
    var body = document.body;
    var over = function () { return body.scrollHeight > pageH; };
    var set = function (name, v) { root.style.setProperty(name, v); void body.offsetHeight; };

    var k = 1;
    for (var i = 0; i < 40 && over() && k > 0.8; i += 1) { k -= 0.02; set('--k', k.toFixed(2)); }
    if (over()) { body.classList.add('tight'); void body.offsetHeight; }
    for (var i2 = 0; i2 < 40 && over() && k > 0.7; i2 += 1) { k -= 0.02; set('--k', k.toFixed(2)); }

    if (!over() && !body.classList.contains('tight')) {
      for (var j = 0; j < 40 && k < 1.6; j += 1) {
        k += 0.03;
        set('--k', k.toFixed(2));
        if (over()) { k -= 0.03; set('--k', k.toFixed(2)); break; }
      }
    }

    for (var p = 0; p < 90 && !over(); p += 1) {
      set('--pad', ((p + 1) * 0.2).toFixed(2) + 'mm');
      if (over()) { set('--pad', (p * 0.2).toFixed(2) + 'mm'); break; }
    }

    body.dataset.fitK = k.toFixed(2);
    body.dataset.fitPad = root.style.getPropertyValue('--pad') || '0mm';
    body.dataset.fitTight = body.classList.contains('tight') ? '1' : '0';
    body.dataset.fitPages = (body.scrollHeight / pageH).toFixed(2);
  }());
</script>
</body>
</html>`;
}

/**
 * The month as one picture, for sending to the parents' WhatsApp group.
 *
 * Rendered on the server rather than in the browser: Chromium is already there
 * for contracts and payslips, and the alternative is a DOM-to-canvas library on
 * the critical path of every page load for a button most people press once a
 * month. The document is the same one the print window shows, in image mode.
 *
 * Returns a Blob. The caller decides what to do with it, because the two
 * answers are different: a phone can hand the file straight to WhatsApp, and a
 * desktop cannot and has to save it first.
 */
export async function renderGanttImage(opts, api) {
  const html = buildGanttPrintHtml({ ...opts, mode: 'image' });
  const res = await api.post('/gantt/image', { html }, { responseType: 'blob', timeout: 120000 });
  return res.data;
}

/**
 * Hand the picture to whatever can send it.
 *
 * On a phone the Web Share sheet passes the actual FILE to WhatsApp, which is
 * the whole point — the manager picks the parents' group and sends. Desktop
 * browsers cannot share files, so there it saves the image and opens WhatsApp
 * Web with the caption ready; the picture is then dragged into the chat. Saying
 * which of the two just happened matters: a download that appears with no
 * explanation looks like the share failed.
 */
export async function shareGanttImage(blob, { fileName, caption }) {
  const file = new File([blob], fileName, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });
      return 'shared';
    } catch (e) {
      // The user closing the share sheet is not a failure to report.
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

/**
 * Open the printable plan in its own window.
 *
 * The window's buttons call back into this tab: it holds the gantt data, the
 * authenticated API client and the toast, none of which exist in a document
 * created by document.write.
 */
export function printGantt(opts, { onImage } = {}) {
  let pages = 1;
  const win = window.open('', '_blank', 'width=1200,height=850');
  if (!win) return false;

  const draw = () => {
    win.document.open();
    win.document.write(buildGanttPrintHtml({ ...opts, mode: 'print', pages }));
    win.document.close();
    // document.write replaces the document, so the handlers are re-attached
    // every time rather than once.
    win.__ganttPages = () => { pages = pages === 1 ? 2 : 1; draw(); };
    win.__ganttImage = () => onImage && onImage();
  };

  draw();
  return true;
}
