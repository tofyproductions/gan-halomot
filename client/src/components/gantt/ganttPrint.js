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
function scaleFor(weekCount, rowCount) {
  const availableMm = 198 - 11;
  const perWeekMm = availableMm / Math.max(weekCount, 1);
  // A week costs its banner and its day-header row on top of the gantt rows;
  // together those are worth about three rows of height.
  const rowMm = perWeekMm / (rowCount + 3);
  const cell = Math.max(4.6, Math.min(7.5, rowMm * 1.05));
  return {
    cell: cell.toFixed(2),
    head: Math.max(5.2, Math.min(8.5, cell * 1.15)).toFixed(2),
    small: Math.max(4.0, cell - 0.9).toFixed(2),
  };
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
}) {
  const size = scaleFor(weeks.length, rows.length || 5);

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
        if (collapsed.has(di)) {
          if (rowIdx > 0) return '';
          const shut = isClosed(dateOf(di));
          return `<td class="closed" rowspan="${rows.length}">
            <div class="cname">${esc(shut.emoji || '')}${esc(shut.name)}</div>
            <div class="cnote">הגן סגור</div>
          </td>`;
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
        const cls = ['c', borrowedCols.has(di) ? 'borrowed' : '', isFri ? 'fri' : ''].filter(Boolean).join(' ');
        const tint = cell?.color ? ` style="background:${esc(cell.color)} !important"` : '';
        return `<td class="${cls}"${tint}>${esc(contentAt(row.key, di))}</td>`;
      }).join('');

      return `<tr><th class="rl">${esc(row.label)}</th>${tds}</tr>`;
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
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html, body { background: #fff; margin: 0; padding: 0; }
  :root { --k: 1; --cell: ${size.cell}pt; --head: ${size.head}pt; --small: ${size.small}pt; }
  body { font-family: "Assistant", Arial, "Arial Hebrew", sans-serif; color: #0f172a; }

  .head { display: flex; align-items: baseline; justify-content: space-between;
          border-bottom: 1.5pt solid #1e3a5f; padding-bottom: 2mm; margin-bottom: 2mm; }
  .head .t { font-size: 13pt; font-weight: 800; }
  .head .s { font-size: 8pt; color: #475569; }

  table.wk { width: 100%; border-collapse: collapse; table-layout: fixed;
             margin-bottom: 1.6mm; page-break-inside: avoid; }
  table.wk th, table.wk td { border: 0.5pt solid #94a3b8; }

  tr.banner th { background: #1e3a5f !important; color: #fff; padding: 0.6mm 1.5mm; }
  tr.banner .wn { font-size: calc(var(--head) * var(--k)); font-weight: 800; width: 16mm; text-align: center; }
  tr.banner .topic { text-align: center; position: relative; }
  tr.banner .tp { font-size: calc(var(--head) * var(--k)); font-weight: 800; }
  tr.banner .rg { font-size: calc(var(--small) * var(--k)); opacity: 0.8; margin-right: 3mm; }

  th.d { background: #eef2f7 !important; padding: 0.5mm; text-align: center; line-height: 1.1; }
  th.d .dn { font-size: calc(var(--head) * var(--k)); font-weight: 800; }
  th.d .dd { font-size: calc(var(--small) * var(--k)); color: #475569; }
  th.d .hol { font-size: calc(var(--small) * var(--k)); color: #92400e; font-weight: 700; }
  th.d.shut { background: #fde68a !important; }
  th.d.short { background: #fef3c7 !important; }
  th.d.borrowed { background: #f1f5f9 !important; color: #94a3b8; }
  th.d.borrowed .dn, th.d.borrowed .dd { color: #94a3b8; }

  th.rl { background: #f1f5f9 !important; width: 16mm; text-align: center;
          font-size: calc(var(--head) * var(--k)); font-weight: 800; padding: 0.4mm; line-height: 1.1; }
  th.corner { background: #eef2f7 !important; }

  td.c { padding: 0.7mm 0.8mm; text-align: center; vertical-align: middle;
         font-size: calc(var(--cell) * var(--k)); line-height: 1.15;
         overflow-wrap: anywhere; }
  td.borrowed { background: #f8fafc !important; }
  td.fri { background: #f5f3ff !important; }
  td.strong { font-weight: 800; color: #5b21b6; text-align: center; font-size: calc(var(--head) * var(--k)); }
  td.fri .fp { font-size: calc(var(--small) * var(--k)); text-align: right; color: #5b21b6; line-height: 1.25; }

  td.closed { background: #fef3c7 !important; text-align: center; vertical-align: middle; }
  td.closed .cname { font-size: calc(var(--head) * var(--k)); font-weight: 800; color: #92400e; }
  td.closed .cnote { font-size: calc(var(--small) * var(--k)); color: #b45309; }

  /* The last lever before giving up: take the air out rather than the type.
     Padding and leading are worth a few percent and cost less readability
     than another step down in font size. */
  body.tight table.wk { margin-bottom: 0.7mm; }
  body.tight td.c { padding: 0.35mm 0.5mm; line-height: 1.08; }
  body.tight th.rl, body.tight th.d { padding: 0.25mm; }
  body.tight tr.banner th { padding: 0.3mm 1.5mm; }

  .foot { margin-top: 1.5mm; font-size: 6pt; color: #94a3b8; text-align: left; }

  .toolbar { position: fixed; top: 8px; left: 8px; background: #f59e0b; color: #111;
             padding: 8px 14px; border-radius: 6px; font-weight: 700; cursor: pointer;
             border: none; font-size: 14px; z-index: 9999; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  @media print { .toolbar { display: none !important; } }
</style>
</head>
<body>
  <button class="toolbar" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
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
    var MM = 96 / 25.4;
    var pageH = (210 - 12) * MM;   // A4 landscape less the 6mm @page margins
    var k = 1;
    var root = document.documentElement;
    for (var i = 0; i < 24 && document.body.scrollHeight > pageH && k > 0.62; i += 1) {
      k -= 0.03;
      root.style.setProperty('--k', k.toFixed(2));
      // Row height follows the type, so the tables re-flow on their own.
      void document.body.offsetHeight;
    }
    // Still over at the floor: squeeze the padding, which buys a few percent
    // without making a single word smaller.
    if (document.body.scrollHeight > pageH) {
      document.body.classList.add('tight');
      void document.body.offsetHeight;
    }
    document.body.dataset.fitK = k.toFixed(2);
    document.body.dataset.fitTight = document.body.classList.contains('tight') ? '1' : '0';
    document.body.dataset.fitPages = (document.body.scrollHeight / pageH).toFixed(2);
  }());
</script>
</body>
</html>`;
}

/** Open the printable plan in its own window. */
export function printGantt(opts) {
  const win = window.open('', '_blank', 'width=1200,height=850');
  if (!win) return false;
  win.document.write(buildGanttPrintHtml(opts));
  win.document.close();
  return true;
}
