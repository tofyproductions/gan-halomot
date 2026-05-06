import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Typography, Box, Chip, Alert,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import WarningIcon from '@mui/icons-material/Warning';
import { toast } from 'react-toastify';
import api from '../../api/client';

const HEBREW_DAY_NAMES = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
function dayOfWeekHebrew(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return 'יום ' + HEBREW_DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Split a day's total hours into regular / 125% / 150% buckets. */
function splitDailyHours(totalHours) {
  const t = Number(totalHours) || 0;
  const regular = Math.min(t, 8);
  const ot125 = Math.max(0, Math.min(t, 10) - 8);
  const ot150 = Math.max(0, t - 10);
  return { regular, ot125, ot150 };
}
function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ''); }

/**
 * Show the monthly punch breakdown for a single employee. Each day row lists
 * the first-in / last-out, total hours, and a warning icon if the punches
 * don't pair cleanly (odd count → missing punch).
 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDate(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const [y, m, d] = yyyyMmDd.split('-');
  // Hebrew DD/MM
  return `${d}/${m}/${y}`;
}

export default function HoursReportDialog({ open, employee, onClose }) {
  const [month, setMonth] = useState(currentYearMonth());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchReport = useCallback(() => {
    if (!employee) return;
    setLoading(true);
    const id = employee._id || employee.id;
    api.get(`/payroll/employees/${id}/hours-report`, { params: { month } })
      .then(res => setReport(res.data))
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת דוח שעות');
      })
      .finally(() => setLoading(false));
  }, [employee, month]);

  useEffect(() => { if (open) fetchReport(); }, [open, fetchReport]);

  const exportCSV = () => {
    if (!report) return;
    const header = ['תאריך', 'כניסה', 'יציאה', 'שעות', 'הערה'];
    const rows = report.days.map(d => [
      formatDate(d.date),
      d.first_in || '',
      d.last_out || '',
      d.total_hours || 0,
      d.incomplete ? 'חסרה החתמה' : '',
    ]);
    rows.push(['', '', 'סה״כ', report.totals.total_hours, `${report.totals.days_worked} ימים`]);
    const csv = '\uFEFF' + [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-${report.employee.full_name}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    if (!report) return;
    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const [yy, mm] = month.split('-');
    const monthLabel = `${mm}/${yy}`;
    let totals = { regular: 0, ot125: 0, ot150: 0, total: 0, missing: 0, days: 0 };
    const tbodyHtml = report.days.map(d => {
      const { regular, ot125, ot150 } = splitDailyHours(d.total_hours);
      const required = 8;
      const missing = Math.max(0, required - d.total_hours);
      totals.regular += regular;
      totals.ot125 += ot125;
      totals.ot150 += ot150;
      totals.total += Number(d.total_hours) || 0;
      totals.missing += missing;
      totals.days += 1;
      const dayName = dayOfWeekHebrew(d.date);
      const noteParts = [];
      if (d.incomplete) noteParts.push('חסרה החתמה');
      if (d.cross_branch_names?.length) noteParts.push('בסניף ' + d.cross_branch_names.join('+'));
      const note = noteParts.join(' • ');
      return `
        <tr ${d.incomplete ? 'class="incomplete"' : ''}>
          <td class="date">${formatDate(d.date)} ${dayName}</td>
          <td>${d.first_in || '—'}</td>
          <td>${d.last_out || (d.incomplete ? '⚠' : '—')}</td>
          <td class="num">${fmt(d.total_hours || 0)}</td>
          <td class="num">${fmt(regular)}</td>
          <td class="num ${ot125 > 0 ? 'ot' : 'mute'}">${ot125 > 0 ? fmt(ot125) : '—'}</td>
          <td class="num ${ot150 > 0 ? 'ot2' : 'mute'}">${ot150 > 0 ? fmt(ot150) : '—'}</td>
          <td class="num ${missing > 0 ? 'miss' : 'mute'}">${missing > 0 ? fmt(missing) : '—'}</td>
          <td class="note">${note}</td>
        </tr>`;
    }).join('');
    const avgHours = totals.days ? (totals.total / totals.days) : 0;

    const html = `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<title>${`hours-${report.employee.full_name}-${month}`}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: Arial, "Segoe UI", "Helvetica Neue", sans-serif; color: #111; margin: 0; padding: 0; background: #fff; }
  .doc-head { border: 1.5px solid #111; padding: 8px 12px; margin-bottom: 8px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 10pt; }
  .doc-head .row { display: flex; gap: 6px; }
  .doc-head .row .lbl { font-weight: 700; }
  .doc-head .title-row { grid-column: 1/3; display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 2px; }
  .doc-head .title-row .title { font-size: 14pt; font-weight: 800; }
  table.daily { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.daily thead th { background: #f3f4f6 !important; border: 1px solid #999; padding: 4px 6px; font-weight: 800; font-size: 8.5pt; text-align: center; }
  table.daily tbody td { border: 1px solid #ccc; padding: 3px 6px; text-align: center; }
  table.daily tbody td.date { text-align: right; font-weight: 700; white-space: nowrap; }
  table.daily tbody td.num { font-variant-numeric: tabular-nums; }
  table.daily tbody td.note { font-size: 8pt; color: #555; text-align: right; }
  table.daily tbody tr.incomplete td { background: #fffbeb !important; }
  table.daily tbody tr.incomplete td.note { color: #92400e; font-weight: 700; }
  table.daily td.ot { color: #92400e; font-weight: 700; }
  table.daily td.ot2 { color: #b91c1c; font-weight: 700; }
  table.daily td.miss { color: #b91c1c; }
  table.daily td.mute { color: #d1d5db; }
  table.daily tbody tr { page-break-inside: avoid; }
  table.daily tfoot td { border: 1.5px solid #111; padding: 4px 6px; background: #e5e7eb !important; font-weight: 800; text-align: center; }
  table.daily tfoot td.label { text-align: right; }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 12px; }
  .summary-grid .box { border: 1px solid #999; padding: 0; font-size: 9pt; }
  .summary-grid .box .box-title { font-weight: 800; padding: 4px 10px; text-align: center; background: #f3f4f6 !important; border-bottom: 1px solid #999; }
  .summary-grid .box .row { display: flex; justify-content: space-between; padding: 2px 10px; }
  .summary-grid .box .row .v { font-weight: 700; font-variant-numeric: tabular-nums; }
  .signatures { margin-top: 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 32px; font-size: 9pt; }
  .signatures .sig { border-top: 1px solid #111; padding-top: 4px; text-align: center; color: #555; }
  .toolbar { position: fixed; top: 8px; left: 8px; background: #fbbf24; color: #111; padding: 8px 14px; border-radius: 6px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.2); border: none; font-size: 14px; z-index: 9999; }
  @media print { .no-print { display: none !important; } }
</style>
</head>
<body>
<button class="toolbar no-print" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
<div class="doc-head">
  <div class="title-row">
    <div class="title">דוח שעות חודשי</div>
    <div>תאריך הפקה: ${todayStr}</div>
  </div>
  <div class="row"><div class="lbl">שם החברה:</div><div>גן החלומות</div></div>
  <div class="row"><div class="lbl">חודש:</div><div>${monthLabel}</div></div>
  <div class="row"><div class="lbl">שם העובד:</div><div>${report.employee.full_name}</div></div>
  <div class="row"><div class="lbl">ת״ז:</div><div dir="ltr">${report.employee.israeli_id || '—'}</div></div>
  <div class="row"><div class="lbl">סניף:</div><div>${report.employee.branch_name || '—'}</div></div>
  <div class="row"><div class="lbl">תפקיד:</div><div>${report.employee.position || '—'}</div></div>
</div>
<table class="daily">
  <thead>
    <tr>
      <th>תאריך</th>
      <th>שעת כניסה</th>
      <th>שעת יציאה</th>
      <th>סה״כ שעות</th>
      <th>שעות רגילות</th>
      <th>125% (יומי)</th>
      <th>150% (יומי)</th>
      <th>שעות חסר</th>
      <th>הערות</th>
    </tr>
  </thead>
  <tbody>${tbodyHtml || `<tr><td colspan="9" style="padding:16px;text-align:center;color:#888">אין נתוני החתמה לחודש זה</td></tr>`}</tbody>
  <tfoot>
    <tr>
      <td class="label" colspan="3">סה״כ</td>
      <td>${fmt(totals.total)}</td>
      <td>${fmt(totals.regular)}</td>
      <td>${fmt(totals.ot125)}</td>
      <td>${fmt(totals.ot150)}</td>
      <td>${fmt(totals.missing)}</td>
      <td></td>
    </tr>
  </tfoot>
</table>
<div class="summary-grid">
  <div class="box">
    <div class="box-title">כללי</div>
    <div class="row"><span>ימי עבודה</span><span class="v">${totals.days}</span></div>
    <div class="row"><span>סה״כ שעות</span><span class="v">${fmt(totals.total)}</span></div>
    <div class="row"><span>שעות רגילות</span><span class="v">${fmt(totals.regular)}</span></div>
    <div class="row"><span>125% (יומי)</span><span class="v">${fmt(totals.ot125)}</span></div>
    <div class="row"><span>150% (יומי)</span><span class="v">${fmt(totals.ot150)}</span></div>
  </div>
  <div class="box">
    <div class="box-title">סטטיסטיקה</div>
    <div class="row"><span>ממוצע שעות יומי</span><span class="v">${fmt(avgHours)}</span></div>
    <div class="row"><span>שעות חסר</span><span class="v">${fmt(totals.missing)}</span></div>
    <div class="row"><span>ימים עם חסר החתמה</span><span class="v">${report.totals.incomplete_days || 0}</span></div>
  </div>
  <div class="box">
    <div class="box-title">הערות</div>
    <div style="padding:6px 10px;font-size:8pt;color:#555;line-height:1.4">
      ${report.totals.incomplete_days > 0 ? '⚠ יש ' + report.totals.incomplete_days + ' ימים עם החתמה לא תקינה (חסרה כניסה או יציאה).<br>' : ''}
      חישוב 125%/150% הוא לפי כמות השעות ביום (8&ndash;10h ≡ 125%, מעל 10h ≡ 150%).
    </div>
  </div>
</div>
<div class="signatures">
  <div class="sig">חתימת העובד</div>
  <div class="sig">חתימת המנהל</div>
</div>
</body>
</html>`;
    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) { toast.error('הדפדפן חסם את חלון ההדפסה — אפשר חלונות קופצים ונסה שוב'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch (e) {} }, 400);
  };

  if (!employee) return null;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        דוח שעות — {employee.full_name}
        {employee.israeli_id && <Chip label={employee.israeli_id} size="small" dir="ltr" sx={{ ml: 1, fontFamily: 'monospace' }} />}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <TextField
              label="חודש"
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              size="small"
              sx={{ width: 180 }}
              InputLabelProps={{ shrink: true }}
            />
            {report && (
              <Box sx={{ flex: 1, textAlign: 'center' }}>
                <Typography variant="h6" sx={{ fontWeight: 800, color: 'primary.main' }}>
                  {report.totals.total_hours} שעות
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {report.totals.days_worked} ימי עבודה
                  {report.totals.incomplete_days > 0 && ` • ${report.totals.incomplete_days} ימים עם חסר`}
                </Typography>
              </Box>
            )}
            <Button size="small" variant="contained" color="primary" startIcon={<PictureAsPdfIcon />} onClick={exportPDF} disabled={!report || report.days.length === 0}>
              ייצא PDF
            </Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={!report || report.days.length === 0}>
              CSV
            </Button>
          </Stack>

          {!employee.israeli_id && (
            <Alert severity="warning">
              אין תעודת זהות על העובד הזה — החתמות לא יקושרו אליו באופן אוטומטי. עדכן את ה-ת״ז בטופס העריכה.
            </Alert>
          )}

          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="center">כניסה ראשונה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="center">יציאה אחרונה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="center">שעות</TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="center">סשנים</TableCell>
                  <TableCell sx={{ fontWeight: 700 }} align="center">סטטוס</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 3 }}>טוען…</TableCell></TableRow>}
                {!loading && report && report.days.length === 0 && (
                  <TableRow><TableCell colSpan={6} align="center" sx={{ py: 3 }}>אין נתוני החתמה לחודש זה</TableCell></TableRow>
                )}
                {!loading && report && report.days.map(d => (
                  <TableRow key={d.date} hover sx={d.cross_branch_names?.length > 0 ? { bgcolor: '#faf5ff' } : undefined}>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {formatDate(d.date)}
                      {d.cross_branch_names?.length > 0 && (
                        <Chip
                          label={`עבד/ה ב${d.cross_branch_names.join(' + ')}`}
                          size="small"
                          sx={{ ml: 0.5, height: 18, fontSize: '0.65rem', bgcolor: '#a855f7', color: 'white', fontWeight: 700 }}
                        />
                      )}
                    </TableCell>
                    <TableCell align="center" dir="ltr">{d.first_in || '—'}</TableCell>
                    <TableCell align="center" dir="ltr">{d.last_out || (d.incomplete ? '⚠︎' : '—')}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>{d.total_hours}h</TableCell>
                    <TableCell align="center">{d.sessions.length}</TableCell>
                    <TableCell align="center">
                      {d.incomplete ? (
                        <Chip icon={<WarningIcon />} label="חסרה החתמה" size="small" color="warning" />
                      ) : (
                        <Chip label="תקין" size="small" variant="outlined" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
