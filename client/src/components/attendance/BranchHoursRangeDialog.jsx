import { useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Typography, Box, Alert, ToggleButton, ToggleButtonGroup, LinearProgress,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { COLOR } from '../../theme/tokens';

/**
 * A whole gan, several months, one sheet.
 *
 * FETCHED ONE MONTH AT A TIME, on purpose. The server computes an entire
 * branch per month, which for five months of twenty-eight employees is over a
 * minute — past the client's 30-second timeout and long enough that a single
 * request would look like a hang. A month per request keeps every call short,
 * shows real progress, and puts the first month on screen while the rest are
 * still being counted.
 */

const MONTH_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-').map(Number);
  return (y && m) ? `${MONTH_NAMES[m - 1]} ${y}` : (ym || '');
};
const shortMonth = (ym) => {
  const [y, m] = String(ym || '').split('-').map(Number);
  return (y && m) ? `${MONTH_NAMES[m - 1].slice(0, 3)}׳${String(y).slice(2)}` : ym;
};
const currentYearMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthsBack = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const num = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(Number(n) * 100) / 100));
const money = (n) => (!Number(n) ? '' : `${Math.round(Number(n))} ₪`);

/** The months from→to inclusive. Empty when the range makes no sense. */
function spanOf(from, to) {
  const p = (ym) => { const [y, m] = String(ym || '').split('-').map(Number); return (y && m >= 1 && m <= 12) ? y * 12 + (m - 1) : null; };
  const a = p(from), b = p(to);
  if (a === null || b === null || b < a) return [];
  const out = [];
  for (let i = a; i <= b; i++) out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  return out;
}

/** The per-employee summary columns, beside the month-by-month hours. */
const SUMMARY = [
  { key: 'total_hours', label: 'סה״כ שעות', bold: true },
  { key: 'days_worked', label: 'ימי עבודה' },
  { key: 'sick_days', label: 'מחלה' },
  { key: 'vacation_days', label: 'חופשה' },
  { key: 'absence_days', label: 'היעדרות' },
  { key: 'closure_days', label: 'סגירת גן' },
  { key: 'incomplete_days', label: 'ימים עם חסר' },
];
const SUMMARY_PAY = [
  { key: 'deduct_hours', label: 'שעות חוסר' },
  { key: 'extra_hours', label: 'שעות תוספת' },
  { key: 'deduction', label: 'ניכוי', money: true },
  { key: 'extra_pay', label: 'תוספת', money: true },
];

export default function BranchHoursRangeDialog({ open, onClose, branch, branchName }) {
  const [from, setFrom] = useState(monthsBack(4));
  const [to, setTo] = useState(currentYearMonth());
  const [withPay, setWithPay] = useState('no');
  const [data, setData] = useState(null);
  const [months, setMonths] = useState([]);
  const [progress, setProgress] = useState(null);   // {done, total}
  const [error, setError] = useState('');

  const allBranches = !branch || branch === 'all';

  const run = useCallback(async () => {
    const span = spanOf(from, to);
    if (!span.length) { setError('טווח לא תקין — חודש הסיום חייב להיות אחרי חודש ההתחלה.'); return; }
    if (span.length > 12) { setError('עד 12 חודשים בבת אחת.'); return; }
    setError(''); setData(null); setMonths(span);
    setProgress({ done: 0, total: span.length });

    const byEmp = new Map();
    let header = null;
    try {
      for (const m of span) {
        const res = await api.get('/payroll/hours-range-bulk', {
          params: { branch, from: m, to: m },
          // One month of one gan still reads every punch in it; 30s is the
          // app-wide default and is not enough for a big month.
          timeout: 90000,
        });
        header = res.data;
        for (const e of res.data.employees) {
          if (!byEmp.has(e.employee_id)) {
            byEmp.set(e.employee_id, { employee_id: e.employee_id, full_name: e.full_name, israeli_id: e.israeli_id, months: {}, totals: {} });
          }
          const row = byEmp.get(e.employee_id);
          row.months[m] = e.months[m] || null;
          for (const [k, v] of Object.entries(e.totals || {})) {
            row.totals[k] = Math.round(((row.totals[k] || 0) + (Number(v) || 0)) * 100) / 100;
          }
        }
        setProgress({ done: span.indexOf(m) + 1, total: span.length });
        // Show what has arrived rather than a spinner over an empty table.
        setData({ branch: header.branch, employees: [...byEmp.values()] });
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'שגיאה בטעינת הדוח');
    } finally {
      setProgress(null);
    }
  }, [branch, from, to]);

  const cols = withPay === 'yes' ? [...SUMMARY, ...SUMMARY_PAY] : SUMMARY;
  const rows = data?.employees || [];
  const grand = {};
  rows.forEach(r => cols.forEach(c => { grand[c.key] = Math.round(((grand[c.key] || 0) + (Number(r.totals[c.key]) || 0)) * 100) / 100; }));
  const monthTotal = (m) => Math.round(rows.reduce((t, r) => t + (r.months[m]?.total_hours || 0), 0) * 100) / 100;

  const cell = (c, v) => (c.money ? (money(v) || '—') : (num(v) || '—'));

  const exportCSV = () => {
    if (!rows.length) return;
    const head = ['שם', 'ת.ז', ...months.map(monthLabel), ...cols.map(c => c.label)];
    const body = rows.map(r => [
      r.full_name, r.israeli_id,
      ...months.map(m => (r.months[m] ? num(r.months[m].total_hours) : '')),
      ...cols.map(c => cell(c, r.totals[c.key])),
    ]);
    body.push(['סה״כ הסניף', '', ...months.map(m => num(monthTotal(m))), ...cols.map(c => cell(c, grand[c.key]))]);
    const csv = '﻿' + [head, ...body].map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-range-${data.branch?.name || 'branch'}-${months[0]}_${months[months.length - 1]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    if (!rows.length) return;
    const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
    const head = `<tr><th>שם</th>${months.map(m => `<th>${esc(shortMonth(m))}</th>`).join('')}${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const body = rows.map(r => `<tr><td class="nm">${esc(r.full_name)}</td>${
      months.map(m => `<td>${r.months[m] ? esc(num(r.months[m].total_hours)) : '—'}</td>`).join('')}${
      cols.map(c => `<td${c.bold ? ' class="strong"' : ''}>${esc(cell(c, r.totals[c.key]))}</td>`).join('')}</tr>`).join('');
    const foot = `<tr><td class="nm">סה״כ הסניף</td>${months.map(m => `<td>${esc(num(monthTotal(m)))}</td>`).join('')}${cols.map(c => `<td>${esc(cell(c, grand[c.key]))}</td>`).join('')}</tr>`;

    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>ריכוז שעות — ${esc(data.branch?.name || '')}</title>
<style>
  /* Colours from theme/tokens, interpolated in — see the note in
     HoursRangeDialog: a printed page is still the system's page, and
     hand-written hexes here are counted by the design ratchet. */
  :root {
    --ink: ${COLOR.text.primary}; --paper: ${COLOR.background.paper};
    --line: ${COLOR.dividerStrong}; --hair: ${COLOR.divider}; --band: ${COLOR.background.sunken};
  }
  @page { size: A4 landscape; margin: 7mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: Arial, "Segoe UI", sans-serif; color: var(--ink); margin: 0; background: var(--paper); }
  .head { border: 1.5px solid var(--ink); padding: 8px 12px; margin-bottom: 8px; }
  .title-row { display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid var(--hair); padding-bottom: 5px; margin-bottom: 5px; }
  .title { font-size: 15pt; font-weight: 800; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px 16px; font-size: 9.5pt; }
  .meta .lbl { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  th { background: var(--band) !important; border: 1px solid var(--line); padding: 4px 3px; font-size: 7.5pt; font-weight: 700; }
  td { border: 1px solid var(--hair); padding: 3px; text-align: center; font-variant-numeric: tabular-nums; }
  td.nm { text-align: right; font-weight: 600; white-space: nowrap; }
  td.strong { font-weight: 800; }
  tbody tr:last-child td { border-top: 2px solid var(--line); background: var(--band) !important; font-weight: 800; }
  tr { page-break-inside: avoid; }
  .foot { margin-top: 8px; font-size: 7.5pt; opacity: 0.7; }
  .toolbar { margin: 10px 0; padding: 8px 14px; font-size: 11pt; cursor: pointer;
    border: 1px solid var(--line); border-radius: 6px; background: var(--band); }
  @media print { .no-print { display: none !important; } }
</style></head><body>
<button class="toolbar no-print" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
<div class="head">
  <div class="title-row">
    <div class="title">ריכוז שעות — ${esc(data.branch?.name || '')}</div>
    <div>${esc(monthLabel(months[0]))} – ${esc(monthLabel(months[months.length-1]))}</div>
  </div>
  <div class="meta">
    <div><span class="lbl">עובדות בדוח:</span> ${rows.length}</div>
    <div><span class="lbl">סה״כ שעות:</span> ${num(grand.total_hours)}</div>
    <div><span class="lbl">הופק בתאריך:</span> ${todayStr}</div>
  </div>
</div>
<table><thead>${head}</thead><tbody>${body}${foot}</tbody></table>
<div class="foot">העמודות שלפי חודש הן שעות עבודה. מילואים אינו מסוכם ואינו מוצג כאן — הוא בדוח של העובדת עצמה.
${withPay === 'yes' ? 'הדוח כולל נתוני שכר.' : 'הדוח אינו כולל נתוני שכר.'}</div>
</body></html>`;
    const win = window.open('', '_blank', 'width=1250,height=900');
    if (!win) { toast.error('החלון נחסם — יש לאפשר חלונות קופצים'); return; }
    win.document.write(html); win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* the button is there */ } }, 400);
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="xl" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        ריכוז שעות לפי חודשים — {allBranches ? 'כל הסניפים' : branchName}
      </DialogTitle>
      <DialogContent>
        {allBranches ? (
          <Alert severity="info" sx={{ mt: 1 }}>
            יש לבחור סניף מסוים במסך מאחור. ריכוז לכל הרשת בבת אחת מחשב כל סניף מחדש לכל חודש והוא כבד מדי.
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <TextField label="מחודש" type="month" size="small" sx={{ width: 165 }}
                value={from} onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
              <TextField label="עד חודש" type="month" size="small" sx={{ width: 165 }}
                value={to} onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
              <Button variant="contained" onClick={run} disabled={!!progress}>
                {progress ? 'מחשב…' : 'הפק דוח'}
              </Button>
              <ToggleButtonGroup size="small" exclusive value={withPay} onChange={(_, v) => v && setWithPay(v)}>
                <ToggleButton value="no">בלי שכר</ToggleButton>
                <ToggleButton value="yes">כולל שכר</ToggleButton>
              </ToggleButtonGroup>
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="contained" startIcon={<PictureAsPdfIcon />}
                onClick={exportPDF} disabled={!rows.length || !!progress}>ייצא PDF</Button>
              <Button size="small" startIcon={<DownloadIcon />}
                onClick={exportCSV} disabled={!rows.length || !!progress}>CSV</Button>
            </Stack>

            {progress && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  מחשב חודש {progress.done} מתוך {progress.total} — כל חודש מחשב את הסניף כולו, זה לוקח זמן
                </Typography>
                <LinearProgress variant="determinate" value={(progress.done / progress.total) * 100} />
              </Box>
            )}

            {error && <Alert severity="error">{error}</Alert>}
            {!rows.length && !progress && !error && (
              <Alert severity="info">בחר טווח חודשים ולחץ "הפק דוח".</Alert>
            )}

            {!!rows.length && (
              <>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {rows.length} עובדות · {num(grand.total_hours)} שעות · {num(grand.days_worked)} ימי עבודה
                </Typography>
                <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: '60vh' }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700, position: 'sticky', insetInlineStart: 0, zIndex: 3, bgcolor: 'background.paper', minWidth: 150 }}>
                          שם
                        </TableCell>
                        {months.map(m => (
                          <TableCell key={m} align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{shortMonth(m)}</TableCell>
                        ))}
                        {cols.map(c => (
                          <TableCell key={c.key} align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap', bgcolor: 'background.default' }}>
                            {c.label}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map(r => (
                        <TableRow key={r.employee_id} hover>
                          <TableCell sx={{ fontWeight: 600, position: 'sticky', insetInlineStart: 0, zIndex: 1, bgcolor: 'background.paper', whiteSpace: 'nowrap' }}>
                            {r.full_name}
                          </TableCell>
                          {months.map(m => (
                            <TableCell key={m} align="center">{r.months[m] ? num(r.months[m].total_hours) : '—'}</TableCell>
                          ))}
                          {cols.map(c => (
                            <TableCell key={c.key} align="center" sx={{ fontWeight: c.bold ? 700 : 400, bgcolor: 'background.default' }}>
                              {cell(c, r.totals[c.key])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                      <TableRow sx={{ '& td': { fontWeight: 800, borderTop: '2px solid', borderColor: 'divider' } }}>
                        <TableCell sx={{ position: 'sticky', insetInlineStart: 0, zIndex: 1, bgcolor: 'background.paper' }}>
                          סה״כ הסניף
                        </TableCell>
                        {months.map(m => <TableCell key={m} align="center">{num(monthTotal(m))}</TableCell>)}
                        {cols.map(c => <TableCell key={c.key} align="center">{cell(c, grand[c.key])}</TableCell>)}
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}
