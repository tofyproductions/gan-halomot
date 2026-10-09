import { toast } from 'react-toastify';
import { HEB_DAYS, fmtDate, employeeHue } from './shiftRows';

/**
 * The rota on paper (PDF) and as an image (PNG) for the staff WhatsApp group.
 *
 * PDF goes through a print window with @page CSS, not html2pdf: html2pdf
 * produced empty PDFs on macOS Safari/Chrome for the punch grid (see
 * AttendanceMonitor.jsx exportPDF). Ratio warnings and "new class" flags are
 * the manager's, not the staff's, and are not drawn.
 *
 * Every employee wears one color — the same hue the board gives her on
 * screen (employeeHue) — so a week reads by color before it reads by name,
 * and the legend at the bottom is the key.
 */
const ROWS_PER_PAGE = 8;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The screen's hue, pinned to print-friendly lightness: pale fill, readable
// dark text of the same family, a border that survives WhatsApp compression.
const empColors = (id) => {
  const h = employeeHue(id);
  return { bg: `hsl(${h},72%,93%)`, border: `hsl(${h},48%,60%)`, text: `hsl(${h},75%,24%)` };
};

/**
 * The week, said like a person says it — "12–17 באוקטובר 2026" — for the
 * badge nobody should have to squint at. A week straddling two months names
 * both.
 */
const hebRange = (dates) => {
  const a = new Date(`${dates[0]}T12:00`);
  const b = new Date(`${dates[dates.length - 1]}T12:00`);
  const month = (d) => d.toLocaleDateString('he-IL', { month: 'long' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ב${month(b)} ${b.getFullYear()}`
    : `${a.getDate()} ב${month(a)} – ${b.getDate()} ב${month(b)} ${b.getFullYear()}`;
};

export function pagesOf(rows, perPage = ROWS_PER_PAGE) {
  const out = [];
  for (let i = 0; i < rows.length; i += perPage) out.push(rows.slice(i, i + perPage));
  return out.length ? out : [[]];
}

function tableHtml({ branchName, dates, pageRows, switched, closedDates, pageNo, pageCount }) {
  const head = dates.map((d, i) => `<th>${HEB_DAYS[i]}<br><span class="d">${fmtDate(d)}</span></th>`).join('');
  const body = pageRows.map(r => `<tr><th class="row">${esc(r.label)}</th>${dates.map(d => {
    if (closedDates.has(d)) return '<td class="closed">סגור</td>';
    return `<td>${(r.cells[d] || []).map(e => {
      const c = empColors(e.employee_id);
      const sw = switched.has(`${e.employee_id}|${e.date}`);
      return `<div class="e${sw ? ' sw' : ''}" style="background:${c.bg};border-color:${c.border};color:${c.text}">${sw ? '<span class="swm">⇄</span> ' : ''}${esc(e.employee_name)}<span dir="ltr">${esc(e.start_hhmm)}–${esc(e.end_hhmm)}</span></div>`;
    }).join('')}</td>`;
  }).join('')}</tr>`).join('');

  // The page's people, each in her color — the key to the board above.
  const seen = new Map();
  for (const r of pageRows) for (const d of dates) for (const e of (r.cells[d] || [])) {
    if (!seen.has(String(e.employee_id))) seen.set(String(e.employee_id), e.employee_name);
  }
  const key = [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'he'))
    .map(([id, name]) => {
      const c = empColors(id);
      return `<span class="lg" style="background:${c.bg};border-color:${c.border};color:${c.text}">${esc(name)}</span>`;
    }).join('');

  return `<section class="page">
    <header class="hd">
      <div><h1>סידור עבודה — ${esc(branchName)}</h1>
      <div class="sub">ימים ראשון–שישי · ${fmtDate(dates[0])}–${fmtDate(dates[dates.length - 1])}${pageCount > 1 ? ` · עמוד ${pageNo}/${pageCount}` : ''}</div></div>
      <div class="wk"><div class="wk-l">שבוע</div><div class="wk-d">${hebRange(dates)}</div></div>
    </header>
    <table><thead><tr><th class="row">כיתה</th>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="legend">${key}${key ? '<span class="sep"></span>' : ''}<span class="swkey"><span class="swm">⇄</span> מעבר כיתה באמצע היום</span></div></section>`;
}

const STYLE = `
  @page { size: A4 landscape; margin: 8mm; }
  .shift-export, .shift-export * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .shift-export { font-family: "Assistant", Arial, sans-serif; direction: rtl; color: #0f172a; background: #fff; }
  .shift-export .page { width: 277mm; padding: 3mm; page-break-after: always; background: #fff; }
  .shift-export .page:last-of-type { page-break-after: auto; }
  .shift-export .hd { border-bottom: 1mm solid #1e293b; padding-bottom: 2mm; margin-bottom: 3mm;
    display: flex; justify-content: space-between; align-items: center; gap: 4mm; }
  .shift-export h1 { font-size: 15pt; margin: 0; letter-spacing: 0.2px; }
  .shift-export .sub { font-size: 9.5pt; color: #64748b; margin-top: 0.5mm; }
  .shift-export .wk { background: #1e293b; color: #fff; border-radius: 2mm; padding: 1.5mm 5mm; text-align: center; flex-shrink: 0; }
  .shift-export .wk-l { font-size: 8pt; color: #cbd5e1; letter-spacing: 1px; }
  .shift-export .wk-d { font-size: 13.5pt; font-weight: 800; white-space: nowrap; }
  .shift-export table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5pt; }
  .shift-export tr { break-inside: avoid; page-break-inside: avoid; }
  .shift-export thead th { background: #1e293b; color: #fff; border: 1px solid #1e293b; padding: 1.8mm 1mm; font-size: 9pt; }
  .shift-export thead .d { font-weight: 400; color: #cbd5e1; font-size: 7.5pt; }
  .shift-export thead th.row { background: #1e293b; }
  .shift-export th, .shift-export td { border: 1px solid #e2e8f0; padding: 1.2mm; vertical-align: top; }
  .shift-export tbody th.row { width: 30mm; background: #f1f5f9; text-align: right; font-size: 9pt; color: #0f172a; }
  .shift-export td.closed { color: #94a3b8; text-align: center; font-weight: 600; vertical-align: middle;
    background: repeating-linear-gradient(45deg, #f8fafc, #f8fafc 4px, #eef2f6 4px, #eef2f6 8px); }
  .shift-export .e { border: 1px solid; border-radius: 1.5mm; padding: 1mm 0.8mm; margin-bottom: 1mm; text-align: center; font-weight: 700; font-size: 8pt; line-height: 1.25; }
  .shift-export .e:last-child { margin-bottom: 0; }
  .shift-export .e span[dir] { display: block; font-weight: 500; font-size: 7.5pt; opacity: 0.85; }
  .shift-export .e.sw { border-style: dashed; border-width: 1.5px; }
  .shift-export .swm { font-weight: 800; }
  .shift-export .legend { margin-top: 2.5mm; font-size: 7.5pt; color: #475569; line-height: 2; }
  .shift-export .lg { display: inline-block; border: 1px solid; border-radius: 1mm; padding: 0.3mm 1.5mm; margin-inline-end: 1.2mm; font-weight: 600; }
  .shift-export .sep { display: inline-block; width: 4mm; }
  .shift-export .swkey { white-space: nowrap; }
`;

export function exportHtml({ branchName, dates, rows, switched, closedDates }) {
  const pages = pagesOf(rows);
  return pages.map((pageRows, i) => tableHtml({ branchName, dates, pageRows, switched, closedDates, pageNo: i + 1, pageCount: pages.length })).join('');
}

export function exportPdf(args) {
  const win = window.open('', '_blank', 'width=1200,height=850');
  if (!win) { alert('הדפדפן חסם את החלון — אפשרו חלונות קופצים לאתר'); return; }
  win.document.write(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>סידור עבודה</title><style>${STYLE} body { margin: 0; }</style></head><body><div class="shift-export">${exportHtml(args)}</div><script>window.onload=()=>{window.print();}</script></body></html>`);
  win.document.close();
}

export async function exportPng(args) {
  const { default: html2canvas } = await import('html2canvas');
  // Off-screen on an OUTER wrapper with a forced white background — the
  // blank-page trap documented in utils/contractPdf.js.
  const wrap = document.createElement('div');
  wrap.className = 'shift-export';
  wrap.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff;';
  wrap.innerHTML = `<style>${STYLE}</style>${exportHtml(args)}`;
  document.body.appendChild(wrap);
  try {
    const pages = [...wrap.querySelectorAll('.page')];
    for (let i = 0; i < pages.length; i += 1) {
      const canvas = await html2canvas(pages[i], { scale: 2, backgroundColor: '#ffffff' });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `סידור-${args.branchName}-${args.dates[0]}${pages.length > 1 ? `-${i + 1}` : ''}.png`;
      a.click();
    }
  } catch (err) {
    console.error(err);
    toast.error('ייצוא התמונה נכשל');
  } finally {
    wrap.remove();
  }
}
