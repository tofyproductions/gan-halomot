import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell,
} from '@mui/material';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Shows the vacation balance for an employee in a given month:
 *   - balance from the latest parsed payslip
 *   - approved EmployeeRequest items that landed in this month
 *   - manual `manual.vacation_days` value (the manager can edit)
 *
 * The manager can also issue an ad-hoc vacation day from here without
 * waiting for the employee to file a request.
 */
export default function VacationDetailDialog({ open, row, month, onClose, onSaved }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [manualDays, setManualDays] = useState(0);
  const [addingDays, setAddingDays] = useState('');

  useEffect(() => {
    if (!open || !row) return;
    setManualDays(Number(row.manual.vacation_days) || 0);
    setLoading(true);
    api.get('/employee-requests/vacation-for-month', { params: { employee_id: row.employee_id, month } })
      .then(res => setRequests(res.data.requests || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  }, [open, row, month]);

  if (!row) return null;

  const balance = row.vacation_info?.balance_from_payslip;
  const balanceDate = row.vacation_info?.balance_recorded_at;
  const requestedDays = requests.reduce((s, r) => s + (Number(r.days) || 0), 0);
  const usedDays = Number(manualDays) || 0;
  const remaining = balance != null ? Math.round((balance - usedDays) * 100) / 100 : null;

  const saveManualDays = (next) => {
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { vacation_days: next } }, { params: { month } })
      .then(() => { onSaved && onSaved(); toast.success('עודכן'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const addManualDays = () => {
    const n = Number(addingDays);
    if (!Number.isFinite(n) || n === 0) return;
    const next = (Number(manualDays) || 0) + n;
    setManualDays(next);
    setAddingDays('');
    saveManualDays(next);
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <BeachAccessIcon color="primary" />
        ימי חופשה — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'primary.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">יתרה מתלוש</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{balance ?? '—'}</Typography>
              {balanceDate && (
                <Typography variant="caption" color="text.disabled">
                  עודכן: {new Date(balanceDate).toLocaleDateString('he-IL')}
                </Typography>
              )}
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ניצול חודשי</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{usedDays}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">נשאר</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{remaining ?? '—'}</Typography>
            </Box>
          </Stack>

          {balance == null && (
            <Alert severity="info">
              עדיין לא נטען תלוש לעובד זה לחודש זה — היתרה תתעדכן אוטומטית לאחר ביקורת תלושים הבאה.
            </Alert>
          )}
          {remaining != null && remaining < 0 && (
            <Alert severity="warning">חרגתם מהיתרה הקיימת ({Math.abs(remaining)} ימים).</Alert>
          )}

          {row.vacation_days_auto?.total_days > 0 && (
            <>
              <Divider />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                ימי חופשה מלוח חופשות הגן
              </Typography>
              <Alert severity="info" sx={{ borderRadius: 2 }}>
                {row.salary_type === 'global'
                  ? 'עובד גלובלי: ימי חופשה אלו יורדים מהיתרה אך אין תשלום נוסף — השכר כבר מכסה אותם.'
                  : 'עובד שעתי: רשאי לחתום על ימים אלו כחופשה ולקבל תשלום עבורם בתלוש (מנוצל מהיתרה).'}
              </Alert>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>תאריך</TableCell>
                    <TableCell>חופשה/חג</TableCell>
                    <TableCell align="center">ערך</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {row.vacation_days_auto.details.map((d, i) => (
                    <TableRow key={i}>
                      <TableCell>{d.date}</TableCell>
                      <TableCell>{d.name}</TableCell>
                      <TableCell align="center">
                        <Chip size="small" label={d.value === 0.5 ? '½' : d.value} color="primary" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  סה״כ ימי חופשה מלוח: {row.vacation_days_auto.total_days}
                </Typography>
                <Stack direction="row" spacing={1}>
                  {Number(manualDays) > 0 && (
                    <Button
                      variant="outlined" color="error" size="small"
                      onClick={() => {
                        if (!confirm('לאפס את ימי החופש בטבלת השכר לאפס?')) return;
                        setManualDays(0);
                        saveManualDays(0);
                      }}
                    >
                      בטל / אפס
                    </Button>
                  )}
                  {(!manualDays || Number(manualDays) === 0) && (
                    <Button variant="contained" size="small" onClick={() => {
                      setManualDays(row.vacation_days_auto.total_days);
                      saveManualDays(row.vacation_days_auto.total_days);
                    }}>
                      החל לטבלת השכר
                    </Button>
                  )}
                </Stack>
              </Stack>
            </>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            בקשות חופש מאושרות החודש
          </Typography>
          {loading ? (
            <Box sx={{ textAlign: 'center', py: 2 }}><CircularProgress size={24} /></Box>
          ) : requests.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין בקשות חופש מאושרות החודש.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מתאריך</TableCell>
                  <TableCell>עד תאריך</TableCell>
                  <TableCell align="center">ימים</TableCell>
                  <TableCell>סיבה</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {requests.map(r => (
                  <TableRow key={r.id}>
                    <TableCell>{r.from_date}</TableCell>
                    <TableCell>{r.to_date}</TableCell>
                    <TableCell align="center"><Chip label={r.days} size="small" color="primary" /></TableCell>
                    <TableCell>{r.reason || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {requestedDays !== usedDays && requests.length > 0 && (
            <Alert severity="info">
              סך הבקשות: {requestedDays} ימים. ניצול חודשי בטבלת השכר: {usedDays}. ההפרש נובע מעדכון ידני.
            </Alert>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוצא לחופש ידנית</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              type="number"
              label="מספר ימים"
              value={addingDays}
              onChange={e => setAddingDays(e.target.value)}
              inputProps={{ step: 0.5, min: 0.5 }}
              sx={{ width: 140 }}
            />
            <Button variant="contained" onClick={addManualDays} disabled={!addingDays}>
              הוסף לטבלת השכר
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            הוספה ידנית מעדכנת את עמודת ימי החופש בטבלת השכר. ניתן גם לערוך את הערך ישירות בתא.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
