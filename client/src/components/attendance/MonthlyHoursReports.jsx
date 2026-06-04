import { useEffect, useState, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, CircularProgress, Table, TableHead, TableBody, TableRow, TableCell, Divider,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import { toast } from 'react-toastify';
import api from '../../api/client';

const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function dowHe(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return DOW[new Date(y, m - 1, d).getDay()];
}
function fmtDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
function splitHours(t) {
  const total = Number(t) || 0;
  const regular = Math.min(total, 8);
  const ot125 = Math.max(0, Math.min(total, 10) - 8);
  const ot150 = Math.max(0, total - 10);
  return { regular, ot125, ot150 };
}
const f1 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL');

/**
 * Monthly hours reports for all employees in scope — grouped by branch with a
 * per-branch summary, and a one-click combined print/save of every report.
 */
export default function MonthlyHoursReports({ open, onClose, month, branch, branchName }) {
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/payroll/hours-report-bulk', { params: { month, branch: branch || 'all' } })
      .then(res => setReports(res.data.reports || []))
      .catch(() => { setReports([]); toast.error('שגיאה בטעינת הדוחות'); })
      .finally(() => setLoading(false));
  }, [open, month, branch]);

  // Group by home branch; per-branch totals.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of reports) {
      const name = r.employee.branch_name || '—';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(r);
    }
    const arr = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
    for (const [, list] of arr) list.sort((a, b) => a.employee.full_name.localeCompare(b.employee.full_name, 'he'));
    return arr.map(([name, list]) => ({
      name, list,
      totals: {
        employees: list.length,
        hours: list.reduce((s, r) => s + (r.totals.total_hours || 0), 0),
        days: list.reduce((s, r) => s + (r.totals.days_worked || 0), 0),
        incomplete: list.reduce((s, r) => s + (r.totals.incomplete_days || 0), 0),
      },
    }));
  }, [reports]);

  // Build one printable document with every employee's detailed report,
  // grouped by branch. Opens a window → browser print → Save as PDF.
  const printAll = () => {
    const empReport = (r) => {
      let tReg = 0, tOt125 = 0, tOt150 = 0;
      const rows = r.days.map(d => {
        const { regular, ot125, ot150 } = splitHours(d.total_hours);
        tReg += regular; tOt125 += ot125; tOt150 += ot150;
        return `<tr${d.incomplete ? ' class="warn"' : ''}>
          <td class="r">${fmtDate(d.date)} ${dowHe(d.date)}</td>
          <td>${d.branch_label || '—'}</td>
          <td>${d.first_in || '—'}</td>
          <td>${d.last_out || (d.incomplete ? '⚠' : '—')}</td>
          <td class="n">${f1(d.total_hours)}</td>
          <td class="n">${f1(regular)}</td>
          <td class="n">${ot125 > 0 ? f1(ot125) : '—'}</td>
          <td class="n">${ot150 > 0 ? f1(ot150) : '—'}</td>
        </tr>`;
      }).join('');
      return `<div class="emp">
        <div class="emp-head">
          <b>${r.employee.full_name}</b>${r.employee.israeli_id ? ` · ת״ז ${r.employee.israeli_id}` : ''}
          <span class="muted"> · ${r.employee.branch_name}</span>
          <span class="sum">סה״כ ${f1(r.totals.total_hours)} שעות · ${r.totals.days_worked} ימים${r.totals.incomplete_days ? ` · ${r.totals.incomplete_days} ימים חסרים` : ''}</span>
        </div>
        <table>
          <thead><tr><th>תאריך</th><th>סניף</th><th>כניסה</th><th>יציאה</th><th>שעות</th><th>רגיל</th><th>125%</th><th>150%</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center">אין החתמות</td></tr>'}</tbody>
          <tfoot><tr><td colspan="4">סה״כ</td><td class="n">${f1(r.totals.total_hours)}</td><td class="n">${f1(tReg)}</td><td class="n">${f1(tOt125)}</td><td class="n">${f1(tOt150)}</td></tr></tfoot>
        </table>
      </div>`;
    };
    const body = groups.map(g => `
      <div class="branch">
        <h2>🏠 ${g.name} <span class="muted">— ${g.totals.employees} עובדים · ${f1(g.totals.hours)} שעות · ${g.totals.days} ימים</span></h2>
        ${g.list.map(empReport).join('')}
      </div>`).join('');
    const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>דוחות שעות ${month}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: Arial, "Segoe UI", sans-serif; color:#111; margin:0; padding:14px; }
  h1 { font-size: 18px; text-align:center; margin:0 0 10px; }
  h2 { font-size: 14px; background:#fde9c8; padding:6px 8px; border-radius:4px; margin:16px 0 8px; page-break-after: avoid; }
  .muted { color:#777; font-weight:400; font-size:11px; }
  .emp { page-break-inside: avoid; margin-bottom:10px; }
  .emp-head { font-size:12px; border-bottom:1px solid #ccc; padding:3px 2px; }
  .emp-head .sum { float:left; color:#1d4ed8; font-weight:700; }
  table { width:100%; border-collapse:collapse; font-size:10.5px; margin-top:3px; }
  th { background:#f3f4f6; border:1px solid #bbb; padding:3px 4px; }
  td { border:1px solid #ccc; padding:2px 4px; text-align:center; }
  td.r { text-align:right; font-weight:600; white-space:nowrap; }
  td.n { font-variant-numeric: tabular-nums; }
  tr.warn td { background:#fffbeb; }
  tfoot td { font-weight:800; background:#f9fafb; }
  @media print { .toolbar { display:none !important; } body { padding:0; } }
  .toolbar { position:fixed; top:8px; left:8px; background:#fbbf24; border:none; padding:8px 14px; border-radius:6px; font-weight:700; cursor:pointer; z-index:9999; box-shadow:0 2px 6px rgba(0,0,0,.2); }
</style></head><body>
  <button class="toolbar" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
  <h1>דוחות שעות — ${branchName || 'כל הסניפים'} · ${month}</h1>
  ${body || '<p style="text-align:center;color:#777">אין נתונים</p>'}
</body></html>`;
    const win = window.open('', '_blank', 'width=1000,height=900');
    if (!win) { toast.error('הדפדפן חסם את החלון — אפשר חלונות קופצים ונסה שוב'); return; }
    win.document.open(); win.document.write(html); win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch (e) { /* manual */ } }, 500);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth dir="rtl">
      <DialogTitle sx={{ fontWeight: 800 }}>דוחות שעות חודשיים — {month}</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
        ) : groups.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>אין נתונים לחודש זה.</Typography>
        ) : (
          <Stack spacing={2}>
            {groups.map(g => (
              <Box key={g.name}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Typography sx={{ fontWeight: 800 }}>🏠 {g.name}</Typography>
                  <Chip size="small" label={`${g.totals.employees} עובדים`} />
                  <Chip size="small" color="primary" variant="outlined" label={`${f1(g.totals.hours)} שעות`} />
                  {g.totals.incomplete > 0 && <Chip size="small" color="warning" variant="outlined" label={`${g.totals.incomplete} ימים חסרים`} />}
                </Stack>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>עובד</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700 }}>שעות</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700 }}>ימים</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700 }}>חסרים</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {g.list.map(r => (
                      <TableRow key={r.employee.id} hover>
                        <TableCell>{r.employee.full_name}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>{f1(r.totals.total_hours)}h</TableCell>
                        <TableCell align="center">{r.totals.days_worked}</TableCell>
                        <TableCell align="center">{r.totals.incomplete_days || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Divider sx={{ mt: 1 }} />
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={printAll} disabled={loading || groups.length === 0}>
          הדפס / שמור הכל
        </Button>
      </DialogActions>
    </Dialog>
  );
}
