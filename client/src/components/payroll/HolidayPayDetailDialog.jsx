import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, Table, TableHead, TableBody,
  TableRow, TableCell,
} from '@mui/material';
import CelebrationIcon from '@mui/icons-material/Celebration';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Shows the breakdown of "דמי חגים" for an employee:
 *   - which Israeli holidays fall in this month
 *   - whether the employee is eligible per Histadrut rules
 *     (hourly, ≥ 3 months tenure, not Saturday, not their off-day, worked
 *     guard days). Each ineligible holiday shows the reason.
 *
 * The manager can override the auto value with a manual amount.
 */
export default function HolidayPayDetailDialog({ open, row, month, onClose, onSaved }) {
  const auto = row?.holiday_pay_auto || { total_days: 0, total_pay: 0, eligible: [], ineligible: [] };
  const [manual, setManual] = useState(0);

  useEffect(() => {
    if (!open || !row) return;
    setManual(Number(row.manual.holiday_pay) || 0);
  }, [open, row]);

  if (!row) return null;
  const isHourly = row.salary_type === 'hourly';

  const save = () => {
    const n = Number(manual);
    if (Number.isNaN(n)) return toast.error('סכום לא תקין');
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { holiday_pay: n } }, { params: { month } })
      .then(() => { onSaved && onSaved(); toast.success('נשמר'); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const useAuto = () => {
    setManual(auto.total_pay);
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { holiday_pay: auto.total_pay } }, { params: { month } })
      .then(() => { onSaved && onSaved(); toast.success('הוחל החישוב האוטומטי'); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <CelebrationIcon color="warning" />
        דמי חגים — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!isHourly && (
            <Alert severity="info">
              עובד גלובלי — לא זכאי לדמי חגים בנפרד (החגים מכוסים כבר ע"י השכר הגלובלי).
            </Alert>
          )}
          {isHourly && auto.blocking_reason && (
            <Alert severity="warning">
              <strong>לא זכאי לדמי חגים החודש:</strong> {auto.blocking_reason}
            </Alert>
          )}
          {isHourly && !auto.blocking_reason && auto.total_days === 0 && auto.ineligible.length === 0 && (
            <Alert severity="info">אין חגים החודש.</Alert>
          )}

          {isHourly && (
            <Stack direction="row" spacing={2}>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">ימים זכאים</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{auto.total_days}</Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.50', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">סכום אוטומטי</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{auto.total_pay} ₪</Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'primary.50', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">סכום סופי בטבלה</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{manual} ₪</Typography>
              </Box>
            </Stack>
          )}

          {isHourly && (auto.eligible.length > 0 || auto.ineligible.length > 0) && (
            <>
              <Divider />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>פירוט חגים החודש</Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>חג</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">סכום</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {auto.eligible.map(e => (
                    <TableRow key={e.date}>
                      <TableCell>{e.date}</TableCell>
                      <TableCell>{e.name}</TableCell>
                      <TableCell>
                        <Chip icon={<CheckCircleIcon />} label="זכאי" size="small" color="success" />
                      </TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700 }}>{e.amount} ₪</TableCell>
                    </TableRow>
                  ))}
                  {auto.ineligible.map(e => (
                    <TableRow key={e.date}>
                      <TableCell>{e.date}</TableCell>
                      <TableCell>{e.name}</TableCell>
                      <TableCell>
                        <Stack direction="column" spacing={0.3}>
                          <Chip icon={<HighlightOffIcon />} label="לא זכאי" size="small" color="default" />
                          {e.reasons.map((r, i) => (
                            <Typography key={i} variant="caption" color="text.secondary">• {r}</Typography>
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell align="center">—</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>סכום בטבלת השכר</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small"
              type="number"
              label="סכום בש״ח"
              value={manual}
              onChange={e => setManual(e.target.value)}
              sx={{ width: 160 }}
            />
            {isHourly && auto.total_pay > 0 && (
              <Button variant="outlined" onClick={useAuto}>
                החל אוטומטי ({auto.total_pay} ₪)
              </Button>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}
