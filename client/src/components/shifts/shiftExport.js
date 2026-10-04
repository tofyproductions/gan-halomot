import { toast } from 'react-toastify';
import { HEB_DAYS, fmtDate } from './shiftRows';

/**
 * The rota on paper (PDF) and as an image (PNG) for the staff WhatsApp group.
 *
 * PDF goes through a print window with @page CSS, not html2pdf: html2pdf
 * produced empty PDFs on macOS Safari/Chrome for the punch grid (see
 * AttendanceMonitor.jsx exportPDF). Ratio warnings and "new class" flags are
 * the manager's, not the staff's, and are not drawn.
 */
const ROWS_PER_PAGE = 8;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function pagesOf(rows, perPage = ROWS_PER_PAGE) {
  const out = [];
  for (let i = 0; i < rows.length; i += perPage) out.push(rows.slice(i, i + perPage));
  return out.length ? out : [[]];
}

function tableHtml({ branchName, dates, pageRows, switched, closedDates, pageNo, pageCount }) {
  const head = dates.map((d, i) => `<th>${HEB_DAYS[i]}<br><span class="d">${fmtDate(d)}</span></th>`).join('');
  const body = pageRows.map(r => `<tr><th class="row">${esc(r.label)}</th>${dates.map(d => {
    if (closedDates.has(d)) return '<td class="closed">סגור</td>';
    return `<td>${(r.cells[d] || []).map(e => `<div class="e${switched.has(`${e.employee_id}|${e.date}`) ? ' sw' : ''}">${esc(e.employee_name)}<span dir="ltr">${esc(e.start_hhmm)}–${esc(e.end_hhmm)}</span></div>`).join('')}</td>`;
  }).join('')}</tr>`).join('');
  return `<section class="page"><h1>סידור עבודה — ${esc(branchName)}</h1>
    <div class="sub">שבוע ${fmtDate(dates[0])}–${fmtDate(dates[dates.length - 1])}${pageCount > 1 ? ` · עמוד ${pageNo}/${pageCount}` : ''}</div>
    <table><thead><tr><th class="row">כיתה</th>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="legend"><span class="sw-box"></span> מעבר כיתה באמצע היום</div></section>`;
}

const STYLE = `
  @page { size: A4 landscape; margin: 8mm; }
  .shift-export, .shift-export * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .shift-export { font-family: "Assistant", Arial, sans-serif; direction: rtl; color: #111; background: #fff; }
  .shift-export .page { width: 277mm; padding: 2mm; page-break-after: always; background: #fff; }
  .shift-export .page:last-of-type { page-break-after: auto; }
  .shift-export h1 { font-size: 16pt; margin: 0 0 1mm; } .shift-export .sub { font-size: 9pt; color: #555; margin-bottom: 3mm; }
  .shift-export table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5pt; }
  .shift-export tr { break-inside: avoid; page-break-inside: avoid; }
  .shift-export th, .shift-export td { border: 1px solid #999; padding: 1.5mm; vertical-align: top; }
  .shift-export thead th { background: #eee; } .shift-export th.row { width: 28mm; background: #f6f6f6; text-align: right; }
  .shift-export .d { font-weight: 400; color: #555; } .shift-export td.closed { background: #ddd; color: #666; text-align: center; }
  .shift-export .e { margin-bottom: 1mm; font-weight: 600; } .shift-export .e span { display: block; font-weight: 400; font-size: 7.5pt; color: #444; }
  .shift-export .e.sw { background: #dbeafe; border-radius: 1mm; padding: 0.5mm 1mm; }
  .shift-export .legend { font-size: 7.5pt; color: #555; margin-top: 2mm; } .shift-export .sw-box { display: inline-block; width: 8px; height: 8px; background: #dbeafe; border: 1px solid #93c5fd; }
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
