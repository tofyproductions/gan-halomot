import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Typography, Box, Chip, Alert, ToggleButton, ToggleButtonGroup, CircularProgress,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { COLOR } from '../../theme/tokens';

/**
 * One employee, several months, one sheet.
 *
 * The monthly report answers "what did she do in May". This answers "what did
 * she do between April and August" — the question asked when a payslip is
 * being checked against a period, when a תלוש is disputed, or when the
 * accountant wants a year on one page.
 *
 * Every figure comes from the server's hours-range endpoint, which is the
 * monthly report run once per month. Nothing is recomputed here: a summary
 * that disagreed with the month it summarises would be worse than none.
 */

const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

function monthLabel(ym) {
  const [y, m] = String(ym || '').split('-').map(Number);
  if (!y || !m) return ym || '';
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Five months back, which is the span the request that built this asked for. */
function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 4);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const num = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(Number(n) * 100) / 100));
const money = (n) => (n === null || n === undefined || Number(n) === 0 ? '' : `${Math.round(Number(n))} ₪`);

/**
 * The three sheets this exports, as column lists.
 *
 * `basic` is what somebody checking a payslip needs. `full` adds the
 * shortfall/extra hours the payroll screen derives. `money` adds their shekel
 * effect — separated because an hours report handed to an employee, a
 * ministry, or a manager who has no business seeing pay is a different
 * document from the one the accountant works off.
 */
const COLUMN_SETS = {
  basic: { label: 'בסיסי', hint: 'שעות, ימי עבודה, מחלה, חופשה, היעדרות וסגירות גן' },
  full: { label: 'מלא — בלי שכר', hint: 'מוסיף חגים בתשלום ושעות חוסר/תוספת' },
  money: { label: 'מלא — כולל שכר', hint: 'מוסיף ניכוי ותוספת בשקלים' },
};

function columnsFor(set) {
  const base = [
    { key: 'month', label: 'חודש', get: (r) => monthLabel(r.month), total: () => 'סה״כ' },
    { key: 'total_hours', label: 'שעות', get: (r) => num(r.total_hours), bold: true },
    { key: 'days_worked', label: 'ימי עבודה', get: (r) => num(r.days_worked) },
    { key: 'sick_days', label: 'מחלה', get: (r) => num(r.sick_days) || '—' },
    { key: 'vacation_days', label: 'חופשה', get: (r) => num(r.vacation_days) || '—' },
    { key: 'absence_days', label: 'היעדרות', get: (r) => num(r.absence_days) || '—' },
    // Two different questions, and they do not agree: `closure_days` is how
    // many days the gan was shut (counted off the report's own rows), while
    // `holiday_pay_days` is how many days a חג was PAID for. Estar's May is
    // two closure days and zero paid ones. Showing one under a name that
    // sounds like the other is how a number gets quoted at a person wrongly.
    { key: 'closure_days', label: 'סגירת גן', get: (r) => num(r.closure_days) || '—' },
    // Free text on the payroll screen — a number OR a note. Never summed.
    { key: 'miluim', label: 'מילואים', get: (r) => (r.miluim === '' || r.miluim == null ? '—' : String(r.miluim)), noTotal: true },
    { key: 'incomplete_days', label: 'ימים עם חסר', get: (r) => num(r.incomplete_days) || '—' },
  ];
  if (set === 'basic') return base;
  const withHours = [
    ...base,
    { key: 'holiday_pay_days', label: 'חגים בתשלום', get: (r) => num(r.holiday_pay_days) || '—' },
    { key: 'deduct_hours', label: 'שעות חוסר', get: (r) => num(r.deduct_hours) || '—' },
    { key: 'extra_hours', label: 'שעות תוספת', get: (r) => num(r.extra_hours) || '—' },
  ];
  if (set === 'full') return withHours;
  return [
    ...withHours,
    { key: 'deduction', label: 'ניכוי', get: (r) => money(r.deduction) || '—', money: true },
    { key: 'extra_pay', label: 'תוספת', get: (r) => money(r.extra_pay) || '—', money: true },
  ];
}

export default function HoursRangeDialog({ open, employee, onClose }) {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(currentYearMonth());
  const [columnSet, setColumnSet] = useState('full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchRange = useCallback(() => {
    if (!employee || !from || !to) return;
    setLoading(true);
    setError('');
    const id = employee._id || employee.id;
    api.get(`/payroll/employees/${id}/hours-range`, { params: { from, to } })
      .then(res => setData(res.data))
      .catch(err => {
        setData(null);
        const msg = err?.response?.data?.error || 'שגיאה בטעינת הדוח';
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [employee, from, to]);

  useEffect(() => { if (open) fetchRange(); }, [open, fetchRange]);

  const columns = columnsFor(columnSet);

  /** The totals row. `miluim` is text and is never added up. */
  const totalCell = (col) => {
    if (col.key === 'month') return `סה״כ ${data.totals.months} חודשים`;
    if (col.noTotal) return '—';
    const v = data.totals[col.key];
    if (v === null || v === undefined) return '—';
    return col.money ? (money(v) || '—') : (num(v) || '—');
  };

  const exportCSV = () => {
    if (!data) return;
    const rows = data.months.map(r => columns.map(c => c.get(r)));
    rows.push(columns.map(c => totalCell(c)));
    const csv = '﻿' + [columns.map(c => c.label), ...rows]
      .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-range-${data.employee.full_name}-${data.from}_${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    if (!data) return;
    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    const body = data.months.map(r => `<tr>${columns
      .map(c => `<td class="${c.key === 'month' ? 'mon' : 'num'}${c.bold ? ' strong' : ''}">${esc(c.get(r))}</td>`)
      .join('')}</tr>`).join('');
    const foot = `<tr>${columns
      .map(c => `<td class="${c.key === 'month' ? 'mon' : 'num'}">${esc(totalCell(c))}</td>`)
      .join('')}</tr>`;

    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>ריכוז שעות — ${esc(data.employee.full_name)}</title>
<style>
  /* The print sheet's palette comes from theme/tokens, interpolated in — not
     written as literals here. A printed page is still the system's page, and
     scripts/design-hex-budget.test.js counts a hand-written colour in this
     file exactly as it counts one in a component, which is the right call:
     the last print stylesheet that spelled its own greys is why every screen
     used to read as a stock admin template. */
  :root {
    --ink: ${COLOR.text.primary};
    --paper: ${COLOR.background.paper};
    --line: ${COLOR.dividerStrong};
    --hair: ${COLOR.divider};
    --band: ${COLOR.background.sunken};
  }
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: Arial, "Segoe UI", sans-serif; color: var(--ink); margin: 0; padding: 0; background: var(--paper); }
  .head { border: 1.5px solid var(--ink); padding: 10px 14px; margin-bottom: 10px; }
  .title-row { display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid var(--hair); padding-bottom: 6px; margin-bottom: 6px; }
  .title { font-size: 16pt; font-weight: 800; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 3px 18px; font-size: 10pt; }
  .meta .lbl { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  thead th { background: var(--band) !important; border: 1px solid var(--line); padding: 5px 4px;
    font-weight: 700; font-size: 8.5pt; text-align: center; }
  tbody td { border: 1px solid var(--hair); padding: 4px; text-align: center; font-variant-numeric: tabular-nums; }
  tbody td.mon { text-align: right; font-weight: 600; white-space: nowrap; }
  tbody td.strong { font-weight: 800; }
  tbody tr:last-child td { border-top: 2px solid var(--line); background: var(--band) !important; font-weight: 800; }
  .foot { margin-top: 10px; font-size: 8pt; opacity: 0.7; }
  .toolbar { margin: 10px 0; padding: 8px 14px; font-size: 11pt; cursor: pointer;
    border: 1px solid var(--line); border-radius: 6px; background: var(--band); }
  @media print { .no-print { display: none !important; } }
</style></head><body>
<button class="toolbar no-print" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
<div class="head">
  <div class="title-row">
    <div class="title">ריכוז שעות — ${esc(data.employee.full_name)}</div>
    <div>${esc(monthLabel(data.from))} – ${esc(monthLabel(data.to))}</div>
  </div>
  <div class="meta">
    <div><span class="lbl">ת״ז:</span> ${esc(data.employee.israeli_id || '—')}</div>
    <div><span class="lbl">סניף:</span> ${esc(data.employee.branch_name || '—')}</div>
    <div><span class="lbl">תפקיד:</span> ${esc(data.employee.position || '—')}</div>
    <div><span class="lbl">חודשים בדוח:</span> ${data.totals.months}</div>
    <div><span class="lbl">סה״כ שעות:</span> ${num(data.totals.total_hours)}</div>
    <div><span class="lbl">הופק בתאריך:</span> ${todayStr}</div>
  </div>
</div>
<table>
  <thead><tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${body}${foot}</tbody>
</table>
<div class="foot">
  הדוח מרכז את דוחות השעות החודשיים כפי שהם במערכת. מילואים מוצג כפי שהוזן ואינו מסוכם.
  ${columnSet === 'money' ? 'הדוח כולל נתוני שכר.' : 'הדוח אינו כולל נתוני שכר.'}
</div>
</body></html>`;

    const win = window.open('', '_blank', 'width=1200,height=900');
    if (!win) { toast.error('החלון נחסם — יש לאפשר חלונות קופצים'); return; }
    win.document.write(html);
    win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* the user can print from the button */ } }, 400);
  };

  if (!employee) return null;
  const empty = !!data && data.months.length === 0;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        ריכוז שעות לפי חודשים — {employee.full_name}
        {employee.israeli_id && (
          <Chip label={employee.israeli_id} size="small" dir="ltr" sx={{ ml: 1, fontFamily: 'monospace' }} />
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              label="מחודש" type="month" value={from} size="small" sx={{ width: 170 }}
              onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }}
            />
            <TextField
              label="עד חודש" type="month" value={to} size="small" sx={{ width: 170 }}
              onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }}
            />
            {data && !loading && (
              <Box sx={{ flex: 1, textAlign: 'center', minWidth: 160 }}>
                <Typography variant="h6" sx={{ fontWeight: 800, color: 'primary.main' }}>
                  {num(data.totals.total_hours)} שעות
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {data.totals.months} חודשים • {num(data.totals.days_worked)} ימי עבודה
                </Typography>
              </Box>
            )}
            {loading && <CircularProgress size={22} />}
            <Button
              size="small" variant="contained" startIcon={<PictureAsPdfIcon />}
              onClick={exportPDF} disabled={!data || empty || loading}
            >
              ייצא PDF
            </Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={!data || empty || loading}>
              CSV
            </Button>
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>מה בדוח:</Typography>
            <ToggleButtonGroup
              size="small" exclusive value={columnSet}
              onChange={(_, v) => v && setColumnSet(v)}
            >
              {Object.entries(COLUMN_SETS).map(([key, { label }]) => (
                <ToggleButton key={key} value={key} sx={{ px: 1.5 }}>{label}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {COLUMN_SETS[columnSet].hint}
            </Typography>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}
          {empty && <Alert severity="info">אין נתונים בטווח שנבחר.</Alert>}

          {data && !empty && (
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: '55vh' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {columns.map(c => (
                      <TableCell key={c.key} align={c.key === 'month' ? 'right' : 'center'} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {c.label}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.months.map(r => (
                    <TableRow key={r.month} hover>
                      {columns.map(c => (
                        <TableCell
                          key={c.key}
                          align={c.key === 'month' ? 'right' : 'center'}
                          sx={{ fontWeight: c.key === 'month' || c.bold ? 700 : 400, whiteSpace: 'nowrap' }}
                        >
                          {c.get(r)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  <TableRow sx={{ '& td': { fontWeight: 800, borderTop: '2px solid', borderColor: 'divider' } }}>
                    {columns.map(c => (
                      <TableCell key={c.key} align={c.key === 'month' ? 'right' : 'center'} sx={{ whiteSpace: 'nowrap' }}>
                        {totalCell(c)}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
