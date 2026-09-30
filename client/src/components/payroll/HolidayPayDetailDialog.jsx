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
  // The server pays the manual figure when one is entered, otherwise the auto
  // one (payrollMonth.controller holidayPayEffective). Showing the bare manual
  // field here read "₪0" for someone the table was in fact paying.
  const savedManual = Number(row.manual?.holiday_pay) || 0;
  const effective = savedManual > 0 ? savedManual : (Number(auto.total_pay) || 0);
  const calc = auto.calc || {};
  const byVacationDay = calc.basis === 'vacation_day';

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
          {!isHourly && auto.teken_carved && (
            <Alert severity="success" icon={false} sx={{ borderRadius: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
                עובדת תקן — דמי חגים משולמים מתוך השלמת השכר (קוד 44)
              </Typography>
              <Typography variant="body2">
                כל חג בחוק שנופל ביום התחייבות שלה ולא עבדה בו, לפי השעות של אותו יום × ערך שעה רגילה.
                הסכום הכולל לא משתנה — הכסף עובר מהשלמת השכר, שלא מזכה בתנאים סוציאליים, לשורה שכן.
                בלי תנאי ותק.
              </Typography>
              {auto.eligible.length > 0 && (
                <Box component="ul" sx={{ m: 0, mt: 1, pr: 2.5 }}>
                  {auto.eligible.map((d) => (
                    <li key={d.date}><Typography variant="body2">{d.name} ({d.date.slice(8, 10)}.{d.date.slice(5, 7)}) — ₪{Number(d.amount).toLocaleString('he-IL')}</Typography></li>
                  ))}
                </Box>
              )}
              {Number(auto.teken_unfunded) > 0 && (
                <Typography variant="body2" sx={{ mt: 1, color: 'warning.dark' }}>
                  ₪{Number(auto.teken_unfunded).toLocaleString('he-IL')} משווי החגים לא נכנסו — השלמת השכר קטנה מהם.
                </Typography>
              )}
            </Alert>
          )}
          {!isHourly && !auto.teken_carved && (
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              אין לעובדת התחייבות שעות במערכת, ולכן אי אפשר לתמחר את ימי החג שלה — החגים נשארו בתוך השכר הגלובלי.
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
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.soft', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">ימים זכאים</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{auto.total_days}</Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.soft', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">סכום אוטומטי</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{auto.total_pay} ₪</Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'primary.soft', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">סכום סופי בטבלה</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{effective} ₪</Typography>
                <Typography variant="caption" color="text.secondary">
                  {savedManual > 0 ? 'סכום ידני' : 'לפי החישוב האוטומטי'}
                </Typography>
              </Box>
            </Stack>
          )}

          {isHourly && savedManual > 0 && Number(auto.total_pay) > 0 && Math.abs(savedManual - Number(auto.total_pay)) >= 0.01 && (
            <Alert severity="warning" sx={{ borderRadius: 2 }}>
              בטבלה שמור סכום ידני ({savedManual} ₪) השונה מהחישוב האוטומטי ({auto.total_pay} ₪).
              הסכום הידני הוא שנשלח לרו״ח. אם הוא נשמר לפני שחישוב דמי החגים עודכן — לחצו "החל אוטומטי".
            </Alert>
          )}

          {isHourly && auto.calc && auto.total_days > 0 && (
            <Alert severity="success" icon={false} sx={{ borderRadius: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>איך חושב הסכום?</Typography>
              <Box component="pre" sx={{ fontFamily: 'inherit', m: 0, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
                {byVacationDay
                  ? `יום חג = יום חופשה (אותו חישוב בדיוק)
יום מלא (ממוצע ${calc.months} חודשים): ${calc.full_day} ₪
מקדם היקף משרה: ${calc.coefficient}
תעריף יומי = ${calc.full_day} × ${calc.coefficient} = ${calc.daily_rate} ₪
סה״כ = ${calc.daily_rate} ₪ × ${auto.total_days} ימי חג זכאי = ${auto.total_pay} ₪`
                  : `תעריף שעתי: ${calc.hourly_rate} ₪/שעה
ממוצע שעות יומי (${
  calc.avg_daily_hours_source === '3-months' ? 'ממוצע 3 חודשים אחרונים'
    : calc.avg_daily_hours_source === 'this-month' ? 'מהחתמות החודש'
    : 'ברירת מחדל'
}): ${calc.avg_daily_hours}h
תעריף יומי = ${calc.hourly_rate} × ${calc.avg_daily_hours} = ${calc.daily_rate} ₪
סה״כ = ${calc.daily_rate} ₪ × ${auto.total_days} ימי חג זכאי = ${auto.total_pay} ₪`}
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {byVacationDay
                  ? 'יום מלא = (שכר יסוד + חופשה + מחלה + מילואים + חגים) ÷ ימים לתלוש, על פני עד 12 החודשים הקודמים. מקדם = ממוצע שעות משולמות בחודש ÷ 182, עד 1.'
                  : 'אין עדיין היסטוריית שכר לעובד/ת — לפי תעריף שעה × ממוצע שעות יומי (3 חודשים; בלי היסטוריה — החודש הנוכחי; בלי החתמות — 8 שעות).'}
              </Typography>
            </Alert>
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

          {/* Hand entry is for hourly staff only. A תקן employee's holidays are
              carved out of her completion; an amount typed here would be paid
              ON TOP, a second time (and the server ignores it for her). */}
          {isHourly && (<>
          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>סכום בטבלת השכר</Typography>
          {auto.blocking_reason && (
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              העובד לא זכאי אוטומטית — אבל ניתן לתת לו דמי חגים ידנית בכל זאת.
              הזן סכום בשדה למטה ולחץ "שמור".
            </Alert>
          )}
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
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
            {Number(manual) > 0 && (
              <Button
                variant="outlined" color="error"
                onClick={() => setManual(0)}
              >
                אפס
              </Button>
            )}
          </Stack>
          </>)}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{isHourly ? 'ביטול' : 'סגור'}</Button>
        {isHourly && <Button variant="contained" onClick={save}>שמור</Button>}
      </DialogActions>
    </Dialog>
  );
}
