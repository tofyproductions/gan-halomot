import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Typography, Box, Chip, Alert,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import WarningIcon from '@mui/icons-material/Warning';
import { toast } from 'react-toastify';
import api from '../../api/client';

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
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={!report || report.days.length === 0}>
              ייצא CSV
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
