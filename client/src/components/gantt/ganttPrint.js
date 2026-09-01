/**
 * A month's work plan, on one page, to go on the wall.
 *
 * Printing the live screen does not do this. The editor is a stack of MUI
 * cards full of text fields — it prints the app's header, the buttons, the
 * shadows, a text field's box around every idea, and it runs to four pages
 * that nobody can pin up. What the gan wants is the thing they used to print
 * out of Excel: one sheet, the whole month, readable across a room.
 *
 * So this builds a standalone document and prints THAT, which is what the rest
 * of the system already does for the hours report and the attendance monitor.
 *
 * Fitting a month on one A4 landscape page is the whole design constraint.
 * A month is four, five or six weeks and each week is six columns by however
 * many rows the gan uses, so the type scale is chosen from the actual shape of
 * this month rather than fixed — six weeks of six rows gets smaller type than
 * four weeks of four, because the alternative is a second page.
 */

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

/**
 * A colour per row, the same ones the bank and the editor use.
 *
 * On a wall this is not decoration. The sheet is read from two metres away by
 * somebody looking for one thing — "what is the story today" — and a coloured
 * band is findable at that distance where a row label is not.
 */
const ROW_TINT = {
  meeting: { bg: '#eaf2fd', label: '#dbeafe', ink: '#1e40af' },
  activity: { bg: '#eafaf0', label: '#dcfce7', ink: '#166534' },
  creation: { bg: '#fdeef5', label: '#fce7f3', ink: '#9d174d' },
  story: { bg: '#fdfae6', label: '#fef9c3', ink: '#854d0e' },
  misc: { bg: '#f2effc', label: '#ede9fe', ink: '#5b21b6' },
};
const tintOf = (key) => ROW_TINT[key] || { bg: '#f8fafc', label: '#f1f5f9', ink: '#334155' };
const MONTH_NAMES = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const holidayYmd = (v) => new Date(v).toISOString().slice(0, 10);

/**
 * How small everything has to be for this month to fit.
 *
 * The page is 210mm tall less margins, the document header takes about 11mm,
 * and every week costs a banner, a day-header row and one row per gantt row.
 * Rather than guess, the budget is divided by what this month actually needs
 * and the result is clamped to something still readable across a room.
 */
/**
 * `weekWeights` — one entry per week, in "row units" (banner + day-header +
 * however many content rows that week actually prints). A week the gan is
 * closed for entirely collapses on the page to a single banner cell (see
 * weekHtml's `collapsed` handling) — sizing every week as if it still needed
 * the full row count wastes exactly the space that week gave back, and the
 * type stays smaller than the page has room for. A five-week month with one
 * closed week (יום כיפור, סוכות, a whole חופשת קיץ week) is a real, common
 * case — not sizing for it is why those months print at a noticeably smaller
 * scale than a five-week month with no closures at all, despite the sheet
 * having genuinely more blank room.
 */
function scaleFor(weekWeights, pages = 1) {
  // Two pages buys human-sized type for a full five-week month; one page is
  // what you ask for when the sheet has to be sent as a single picture. The
  // caller decides, because it is a trade nobody can make on their behalf: a
  // month that fits one page at 11pt and one that only fits at 5pt look the
  // same from here.
  const availableMm = (198 - 11) * pages;
  const totalWeight = weekWeights.reduce((a, w) => a + w, 0) || 1;
  const rowMm = availableMm / totalWeight;
  const cell = Math.max(8, Math.min(12, rowMm * 1.05));
  return {
    cell: cell.toFixed(2),
    head: Math.max(9, Math.min(13.5, cell * 1.15)).toFixed(2),
    small: Math.max(6.5, cell - 1.5).toFixed(2),
  };
}

/** Every in-month day of `week` is closed (holiday, not merely a short day) —
 * matches the `collapsed` test weekHtml uses to draw it as one banner cell. */
function isWeekWhollyClosed(week, isClosed, inMonth) {
  const offset = new Date(week.start_date).getDay();
  const sunday = new Date(week.start_date);
  sunday.setDate(sunday.getDate() - offset);
  let hasOwnDay = false;
  for (let di = 0; di < 6; di += 1) {
    const d = new Date(sunday);
    d.setDate(d.getDate() + di);
    if (!inMonth(d)) continue; // a day borrowed from another month doesn't count
    hasOwnDay = true;
    if (!isClosed(d)) return false;
  }
  return hasOwnDay;
}

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

  const rowCount = rows.length || 5;
  // A week costs its banner and its day-header row on top of the gantt rows;
  // together those are worth about three rows of height. A wholly-closed week
  // collapses to that overhead plus its one banner cell (see weekHtml).
  const weekWeights = weeks.map(w => (
    isWeekWhollyClosed(w, isClosed, inMonth) ? 4 : rowCount + 3
  ));
  const size = image
    ? { cell: '15', head: '17', small: '12.5' }
    : scaleFor(weekWeights, pages);

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
     * A box the gananet merged across days or rows is one box, and it printed
     * as six.
     *
     * The editor stores a merge as col_span/row_span on the top-right cell and
     * BLANKS the cells it swallowed. The print builder knew nothing about
     * either, so it drew every one of them: the merged text appeared in a
     * single narrow box and the rest of the span came out empty. A week whose
     * first row reads הסתגלות across all five days printed the word once, under
     * Tuesday, and four blanks — which reads as a plan nobody finished writing.
     *
     * Every span paints its whole rectangle, rather than each axis being tested
     * on its own. Checking "is a colspan reaching me along my row, or a rowspan
     * reaching me down my column" misses the corner: a 2×3 merge starting at
     * Monday covers Tuesday two rows down, but nothing in Tuesday's column
     * carries a rowspan — the cell that does is in Monday's. That box printed
     * anyway and pushed the rest of the row sideways by one day.
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
    const coveredAt = (rowKey, di) => covered.has(`${rows.findIndex(r => r.key === rowKey)}|${di}`);

    const closedCols = new Set();
    const borrowedCols = new Set();
    for (let di = 0; di < 6; di += 1) {
      const d = dateOf(di);
      if (!inMonth(d)) borrowedCols.add(di);
      if (isClosed(d)) closedCols.add(di);
    }
    // A closed column collapses to one cell — unless work is already written
    // in it, which must stay visible.
    const collapsed = new Set([...closedCols].filter(di => (
      !rows.some(r => contentAt(r.key, di))
    )));

    const head = DAY_NAMES.map((name, di) => {
      const d = dateOf(di);
      const hol = isHoliday(d);
      const shut = isClosed(d);
      const cls = ['d', shut ? 'shut' : hol ? 'short' : '', borrowedCols.has(di) ? 'borrowed' : '']
        .filter(Boolean).join(' ');
      return `<th class="${cls}">
        <div class="dn">${esc(name)}</div>
        <div class="dd">${d.getDate()}.${d.getMonth() + 1}</div>
        ${hol ? `<div class="hol">${esc(hol.emoji || '')}${esc(hol.name)}${!shut && hol.end_time ? ` · עד ${esc(hol.end_time)}` : ''}</div>` : ''}
      </th>`;
    }).join('');

    const body = rows.map((row, rowIdx) => {
      const tds = DAY_NAMES.map((_, di) => {
        // Swallowed by a merge that starts above or to the right of here.
        if (!collapsed.has(di) && coveredAt(row.key, di)) return '';

        if (collapsed.has(di)) {
          if (rowIdx > 0) return '';
          const shut = isClosed(dateOf(di));
          return `<td class="closed" rowspan="${rows.length}">
            <div class="cname">${esc(shut.emoji || '')}${esc(shut.name)}</div>
            <div class="cnote">הגן סגור</div>
          </td>`;
        }

        // A closed day that already has work in some row keeps every cell of
        // its column amber and named — the same as the screen. This check
        // comes BEFORE the Friday specials: a closed Friday must not print
        // "קבלת שבת" as if the gan were open.
        if (closedCols.has(di)) {
          const shut = isClosed(dateOf(di));
          const content = contentAt(row.key, di);
          return `<td class="c shutc">${esc(content) || `${esc(shut.emoji || '')}${esc(shut.name)}`}</td>`;
        }

        const isFri = di === 5;
        if (isFri && row.key === 'meeting') {
          return '<td class="fri strong">קבלת שבת</td>';
        }
        if (isFri && row.key === 'activity') {
          const f = String(week.friday_parent_father || '').trim();
          const m = String(week.friday_parent_mother || '').trim();
          return `<td class="fri">
            <div class="fp"><b>אבא של שבת:</b> ${esc(f) || '&nbsp;'}</div>
            <div class="fp"><b>אמא של שבת:</b> ${esc(m) || '&nbsp;'}</div>
          </td>`;
        }

        const cell = cellAt(row.key, di);
        const cls = ['c', borrowedCols.has(di) ? 'borrowed' : ''].filter(Boolean).join(' ');
        // A colour the gananet set by hand on that one box wins over the row's.
        const bg = cell?.color || tintOf(row.key).bg;

        // A merge is clamped to what is actually on this sheet. The editor
        // cannot produce a span past the week's six days, but a row that was
        // deleted after the merge was made would leave one reaching past the
        // last row — and a rowspan that overruns its table pulls the whole
        // sheet's layout apart rather than failing where it was written.
        const cs = Math.min(spanAt(row.key, di, 'col_span'), 6 - di);
        const rs = Math.min(spanAt(row.key, di, 'row_span'), rows.length - rowIdx);
        const span = `${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}`;
        const merged = cs > 1 || rs > 1 ? ' merged' : '';
        return `<td class="${cls}${merged}"${span} style="background:${esc(bg)} !important">${esc(contentAt(row.key, di))}</td>`;
      }).join('');

      const t = tintOf(row.key);
      return `<tr><th class="rl" style="background:${t.label} !important;color:${t.ink}">${esc(row.label)}</th>${tds}</tr>`;
    }).join('');

    const own = [0, 1, 2, 3, 4, 5].map(dateOf).filter(inMonth);
    const range = own.length
      ? `${own[0].toLocaleDateString('he-IL')} – ${own[own.length - 1].toLocaleDateString('he-IL')}`
      : '';

    return `<table class="wk">
      <thead>
        <tr class="banner">
          <th class="wn">שבוע ${week.week_number}</th>
          <th class="topic" colspan="6">
            <span class="tp">${esc(week.topic || '')}</span>
            <span class="rg">${esc(range)}</span>
          </th>
        </tr>
        <tr><th class="rl corner"></th>${head}</tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
  };

  const statusLabel = status === 'approved' ? 'מאושר' : status === 'pending' ? 'ממתין לאישור' : 'טיוטה';

  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<title>תוכנית עבודה - ${esc(classroomName)} - ${MONTH_NAMES[month]} ${year}</title>
<style>
  /* Landscape, because six day-columns across a portrait page leaves a column
     the width of a thumb and the plan is read from across the room. */
  @page { size: A4 landscape; margin: 6mm; }
  ${image ? `
  /* The picture is not a page. Nothing here is measured against paper: the
     sheet is as tall as the month needs, the type is fixed, and WhatsApp's
     viewer does the scrolling that a printer cannot. */
  @page { size: auto; margin: 0; }
  body.img { width: 1400px !important; padding: 22px 26px !important; }
  body.img table.wk { margin-bottom: 14px; border-spacing: 3px; }
  body.img td.c { padding: 12px 8px !important; line-height: 1.3; }
  body.img .head { margin-bottom: 14px; }
  ` : ''}
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html { background: #e2e8f0; }
  /*
   * The body is exactly the printable width of the page, always.
   *
   * Without this the sheet is laid out at the WINDOW's width and then scaled by
   * the browser to fit the paper — so on a wide monitor the whole document is
   * shrunk by a third and the "full page" it measured itself into prints as
   * half a page of content and a lot of white. Which is exactly what happened.
   *
   * Pinning the width to the page makes the screen layout and the print layout
   * the same layout, so the fit script below is measuring the thing that will
   * actually be printed.
   */
  body { width: 285mm; margin: 0 auto; background: #fff; padding: 0;
         box-shadow: 0 0 0 1px #cbd5e1, 0 6px 24px rgba(15,23,42,.12); }
  @media print { html { background: #fff; } body { box-shadow: none; margin: 0; } }
  :root { --k: 1; --pad: 0mm; --cell: ${size.cell}pt; --head: ${size.head}pt; --small: ${size.small}pt; }
  body { font-family: "Assistant", Arial, "Arial Hebrew", sans-serif; color: #0f172a; }
  /* A4 landscape less the 6mm @page margins, stated once and used by the
     fit script below so the two cannot drift apart. */

  .head { display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 2mm; }
  .head .t { font-size: calc(var(--head) * var(--k) * 1.9); font-weight: 800; color: #1e3a5f; }
  .head .s { font-size: calc(var(--head) * var(--k)); color: #64748b; font-weight: 700; }

  /* Cells sit in their own rounded tiles with white between them, the way the
     screen shows them. On paper it also stops five weeks of grid from reading
     as one undifferentiated mesh from across a room. */
  table.wk { width: 100%; border-collapse: separate; border-spacing: 0.5mm;
             table-layout: fixed; margin-bottom: 1.4mm; page-break-inside: avoid; }
  table.wk th, table.wk td { border: none; border-radius: 1.6mm; }

  tr.banner th { background: #1e3a5f !important; color: #fff; padding: 0.9mm 2mm; }
  tr.banner .wn { font-size: calc(var(--head) * var(--k)); font-weight: 800;
                  width: 20mm; text-align: center; }
  tr.banner .topic { text-align: center; }
  tr.banner .tp { font-size: calc(var(--head) * var(--k) * 1.25); font-weight: 800; }
  tr.banner .rg { font-size: calc(var(--small) * var(--k)); opacity: 0.75; margin-right: 4mm; }

  th.d { background: #f1f5f9 !important; padding: calc(0.4mm + var(--pad) * 0.4) 0.5mm;
         text-align: center; line-height: 1.15; }
  th.d .dn { font-size: calc(var(--head) * var(--k)); font-weight: 800; color: #334155; }
  th.d .dd { font-size: calc(var(--small) * var(--k)); color: #64748b; font-weight: 700; }
  th.d .hol { font-size: calc(var(--small) * var(--k)); color: #92400e; font-weight: 800; }
  th.d.shut { background: #fde68a !important; }
  th.d.short { background: #fef3c7 !important; }
  /* Only a PLAIN borrowed day fades — a borrowed day that is also a closure
     keeps its amber. The unqualified rule used to win the cascade and the
     end of סוכות printed as two ordinary white columns. */
  th.d.borrowed:not(.shut):not(.short) { background: #f8fafc !important; }
  th.d.borrowed:not(.shut):not(.short) .dn,
  th.d.borrowed:not(.shut):not(.short) .dd { color: #a8b4c2; }

  th.rl { width: 20mm; text-align: center; font-weight: 800; line-height: 1.15;
          font-size: calc(var(--head) * var(--k)); padding: 0.5mm; }
  th.corner { background: #fff !important; }

  td.c { padding: calc(0.8mm + var(--pad)) 1mm; text-align: center; vertical-align: middle;
         font-size: calc(var(--cell) * var(--k)); line-height: 1.22; font-weight: 600;
         color: #1e293b; overflow-wrap: anywhere; }
  /* A day borrowed from the month next door is written in like any other, just
     quieter, so a parent reading the sheet knows which month they are in. */
  td.c.borrowed { opacity: 0.72; }
  td.fri { background: #f5f3ff !important; }
  td.strong { font-weight: 800; color: #5b21b6; text-align: center;
              font-size: calc(var(--head) * var(--k) * 1.1); }
  td.fri .fp { font-size: calc(var(--small) * var(--k)); text-align: right;
               color: #5b21b6; line-height: 1.35; font-weight: 700; }

  /* A closed column that still has work in it: every cell amber, like the screen. */
  td.c.shutc { background: #fde68a !important; color: #92400e; font-weight: 700; }
  td.closed { background: #fef3c7 !important; text-align: center; vertical-align: middle; }
  td.closed .cname { font-size: calc(var(--head) * var(--k) * 1.3); font-weight: 800; color: #92400e; }
  td.closed .cnote { font-size: calc(var(--small) * var(--k)); color: #b45309; font-weight: 700; }

  /* The last lever before giving up: take the air out rather than the type.
     Padding and leading are worth a few percent and cost less readability
     than another step down in font size. */
  body.tight table.wk { margin-bottom: 0.7mm; border-spacing: 0.35mm; }
  body.tight td.c { padding: calc(0.35mm + var(--pad)) 0.6mm; line-height: 1.1; }
  body.tight th.rl, body.tight th.d { padding: 0.25mm; }
  body.tight tr.banner th { padding: 0.4mm 1.5mm; }

  /* A merged box carries the week's one big idea — הסתגלות, a trip, a holiday
     theme — across several days. It gets the weight to match, or a wide box of
     ordinary text just looks like a cell somebody forgot to fill in. */
  td.c.merged { font-size: calc(var(--cell) * var(--k) * 1.25); font-weight: 800; }

  .foot { margin-top: 1.5mm; font-size: calc(var(--small) * var(--k)); color: #b6c1cc; text-align: left; }

  .bar { position: fixed; top: 8px; left: 8px; display: flex; gap: 6px; align-items: center;
         z-index: 9999; }
  .toolbar { background: #f59e0b; color: #111;
             padding: 8px 14px; border-radius: 6px; font-weight: 700; cursor: pointer;
             border: none; font-size: 14px; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .toolbar.alt { background: #25D366; color: #fff; }
  .toolbar.ghost { background: #fff; color: #334155; border: 1px solid #cbd5e1; }
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
    <div class="t">תוכנית עבודה · ${MONTH_NAMES[month]} ${year}</div>
    <div class="s">${esc(classroomName)}${branchName ? ` · ${esc(branchName)}` : ''} · ${statusLabel}</div>
  </div>
  ${weeks.map(weekHtml).join('')}
  <div class="foot">גן החלומות · הופק ${new Date().toLocaleDateString('he-IL')}</div>
<script>
  /**
   * Shrink until it fits, then stop.
   *
   * The type scale can be estimated from the shape of the month — how many
   * weeks, how many rows — but not from the amount of TEXT, and the text is
   * what decides. "הכירות עם הצוות והחברים" wraps to three lines where "גואש"
   * takes one, and a month where every box is full runs a page and a bit while
   * the same month half-written fits easily.
   *
   * So the page measures itself and steps down until the whole month is on one
   * sheet. The floor is 0.62 — below that it stops being readable across a
   * room, which is the entire point of printing it — and if a month is so full
   * that even that overflows, it is allowed to run to a second page rather
   * than shrink into something nobody can use.
   */
  (function fit() {
    // In image mode there is no page, so there is nothing to fit into and
    // nothing to shrink. Returning here is the whole difference: every loop
    // below exists to trade type size against a sheet of paper.
    if (${image ? 'true' : 'false'}) { document.body.classList.add('img'); return; }

    var MM = 96 / 25.4;
    var oneP = (210 - 12) * MM;    // A4 landscape less the 6mm @page margins
    var BUDGET = ${Math.max(1, Math.min(2, Number(pages) || 1))};
    var pageH = oneP * BUDGET;
    var root = document.documentElement;
    var body = document.body;
    // The body is the page: its width is pinned to the printable width, so its
    // scroll height is the number of pages this will take.
    var over = function () { return body.scrollHeight > pageH; };
    var set = function (name, v) { root.style.setProperty(name, v); void body.offsetHeight; };

    var k = 1;

    /*
     * Shrink into the budget the reader chose, and do not quietly overrun it.
     *
     * This used to try one page, and on failing widen its OWN budget to two —
     * which is how a sheet asked for as one page came out as three. Two, from
     * the growth loop below filling the doubled budget; three, because a week
     * never splits across a break, so a document 2.1 pages tall lands on a
     * third sheet with most of the second left white.
     *
     * The floor is much lower for a one-page request than it used to be: a
     * person asking for one page has said which side of the trade they want,
     * and answering with two is not honouring it. If the type ends up small,
     * the toolbar's other button is the honest way out — a picture has no page
     * to be small on.
     */
    var floor = BUDGET === 1 ? 0.55 : 0.85;
    for (var i = 0; i < 40 && over() && k > floor; i += 1) {
      k -= 0.03;
      set('--k', k.toFixed(2));
    }

    // Still over at the floor: take the air out rather than the type.
    if (over()) { body.classList.add('tight'); void body.offsetHeight; }

    // And UP, while it still fits. A month that fits at full size used to stop
    // there and leave the bottom half of the page white — which on a wall is
    // just a smaller sheet with a margin, and the whole ask was a full page
    // readable from across the room.
    if (!over() && !body.classList.contains('tight')) {
      for (var j = 0; j < 40 && k < 2.4; j += 1) {
        k += 0.04;
        set('--k', k.toFixed(2));
        if (over()) { k -= 0.04; set('--k', k.toFixed(2)); break; }
      }
    }

    // Whatever vertical space is left over becomes row height rather than more
    // type. Past a point bigger letters stop helping and taller rows — more
    // white around each idea — are what makes it readable on a wall.
    // The cap is generous on purpose: a sparse month, or a dense one that had
    // to shrink, can have a lot of page left and the padding is what spends it.
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
