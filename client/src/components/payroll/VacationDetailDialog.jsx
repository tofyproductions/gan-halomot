import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell, Switch, FormControlLabel, Checkbox,
} from '@mui/material';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { useAuth } from '../../hooks/useAuth';

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
  const confirm = useConfirm();
  const { isAdmin, isAccountant } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [manualDays, setManualDays] = useState(0);
  const [addingDays, setAddingDays] = useState('');
  const [payConfirmed, setPayConfirmed] = useState(false);
  // Partial accounting approval — pay beyond the balance up to N days.
  // approvedLimit is the SAVED value; limitInput is what's being typed.
  const [approvedLimit, setApprovedLimit] = useState(null);
  const [limitInput, setLimitInput] = useState('');
  // Per-day payment approval: the EXCLUSION list (unchecked days). Empty =
  // everything approved, which is the default behavior.
  const [unapprovedDates, setUnapprovedDates] = useState([]);

  useEffect(() => {
    if (!open || !row) return;
    setManualDays(Number(row.manual.vacation_days) || 0);
    setPayConfirmed(!!row.manual.vacation_pay_confirmed);
    const lim = Number(row.manual.vacation_pay_approved_days);
    setApprovedLimit(Number.isFinite(lim) && lim > 0 ? lim : null);
    setLimitInput(Number.isFinite(lim) && lim > 0 ? String(lim) : '');
    setUnapprovedDates(Array.isArray(row.manual.vacation_unapproved_dates) ? row.manual.vacation_unapproved_dates : []);
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
  // Outside August the calendar-suggested days already flow into pay
  // automatically (see payrollMonth.controller.js — vacationAutoGated is
  // August-only), even before manual.vacation_days is set by hand. Reading
  // the raw manual value here showed "0 ימים" and a wrong "נשאר" even while
  // the employee was actually being paid for them — vacation_eff_days is the
  // server's own effective figure, the same one the main table cell uses.
  const usedDays = row.vacation_eff_days != null ? Number(row.vacation_eff_days) : (Number(manualDays) || 0);
  const remaining = balance != null ? Math.round((balance - usedDays) * 100) / 100 : null;
  const pendingApply = !!row.vacation_days_auto?.pending_manual_apply;
  // usedDays is now the CREDITED figure — capped at the balance for an
  // hourly employee unless the "אישור הנה״ח" switch below lifted it.
  // daysAsked is what was actually recorded/requested, before that cap.
  const daysAsked = row.vacation_days_requested != null ? Number(row.vacation_days_requested) : usedDays;
  const isGlobal = row.salary_type === 'global';
  const balanceCapped = !isGlobal && daysAsked > usedDays;

  const saveManualDays = (next) => {
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { vacation_days: next } }, { params: { month } })
      .then(() => { onSaved && onSaved(); toast.success('עודכן'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const saveUnapprovedDates = (dates) => {
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { vacation_unapproved_dates: dates } }, { params: { month } })
      .then(() => {
        setUnapprovedDates(dates);
        onSaved && onSaved();
        toast.success(dates.length ? 'עודכן — ימים שלא אושרו לא ישולמו' : 'כל הימים אושרו לתשלום');
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const saveApprovedLimit = (next) => {
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { vacation_pay_approved_days: next } }, { params: { month } })
      .then(() => {
        setApprovedLimit(next);
        setLimitInput(next ? String(next) : '');
        onSaved && onSaved();
        toast.success(next ? `אושר תשלום עד ${next} ימים מעבר ליתרה` : 'המגבלה בוטלה — חזרה להערה הקבועה');
      })
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
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'primary.soft', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">יתרה מתלוש</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{balance ?? '—'}</Typography>
              {balanceDate && (
                <Typography variant="caption" color="text.disabled">
                  עודכן: {new Date(balanceDate).toLocaleDateString('he-IL')}
                </Typography>
              )}
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.soft', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ניצול חודשי</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{usedDays}</Typography>
              {balanceCapped && (
                <Typography variant="caption" color="warning.dark" sx={{ display: 'block' }}>
                  מתוך {daysAsked} שהתבקשו
                </Typography>
              )}
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.soft', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">נשאר</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{remaining ?? '—'}</Typography>
            </Box>
          </Stack>

          {balance == null && (
            <Alert severity="info">
              עדיין לא נטען תלוש לעובד זה לחודש זה — היתרה תתעדכן אוטומטית לאחר ביקורת תלושים הבאה.
            </Alert>
          )}
          {balanceCapped && (
            <Alert severity="warning">
              נרשמו/התבקשו {daysAsked} ימי חופשה, אך רק {usedDays} מכוסים ביתרה הקיימת — {Math.round((daysAsked - usedDays) * 100) / 100} ימים ללא ניצול/תשלום. לאשר בכל זאת: המתג "אישור הנה״ח" למטה, או אישור חלקי עד מגבלת ימים.
            </Alert>
          )}
          {remaining != null && remaining < 0 && (
            <Alert severity="warning">חרגתם מהיתרה הקיימת ({Math.abs(remaining)} ימים).</Alert>
          )}

          {(row.vacation_days_auto?.total_days > 0 || (row.vacation_days_auto?.off_day_details || []).length > 0) && (
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
                    <TableCell align="center">יום עבודה?</TableCell>
                    <TableCell align="center">ערך</TableCell>
                    {!isGlobal && <TableCell align="center">מאושר לתשלום?</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...(row.vacation_days_auto.details || []).map(d => ({ ...d, is_work_day: true })),
                    ...(row.vacation_days_auto.off_day_details || [])]
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((d, i) => (
                    <TableRow key={i} sx={d.is_work_day ? undefined : { opacity: 0.55 }}>
                      <TableCell>{d.date}</TableCell>
                      <TableCell>{d.name}</TableCell>
                      <TableCell align="center">
                        {d.is_work_day
                          ? <Chip size="small" label="יום עבודה" color="success" variant="outlined" />
                          : <Chip size="small" label="יום חופשי שלה" variant="outlined" />}
                      </TableCell>
                      <TableCell align="center">
                        {d.is_work_day
                          ? <Chip size="small" label={d.value === 0.5 ? '½' : d.value} color="primary" />
                          : <Chip size="small" label="—" />}
                      </TableCell>
                      {!isGlobal && (
                        <TableCell align="center">
                          {d.is_work_day ? (
                            <Checkbox
                              size="small"
                              checked={!unapprovedDates.includes(d.date)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? unapprovedDates.filter(x => x !== d.date)
                                  : [...unapprovedDates, d.date];
                                saveUnapprovedDates(next);
                              }}
                            />
                          ) : '—'}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!isGlobal && unapprovedDates.length > 0 && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Alert severity="warning" sx={{ flex: 1, borderRadius: 2, py: 0 }}>
                    {unapprovedDates.length} ימים לא מאושרים לתשלום — לא ישולמו ולא יירדו מהיתרה.
                  </Alert>
                  <Button variant="outlined" size="small" onClick={() => saveUnapprovedDates([])}>
                    אשר את כולם לתשלום
                  </Button>
                </Stack>
              )}
              {(row.vacation_days_auto.off_day_details || []).length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  ימים שנופלים על היום החופשי של העובדת אינם נספרים, אינם משולמים ואינם יורדים מהיתרה — גם לא באישור הנה״ח.
                </Typography>
              )}
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  סה״כ ימי חופשה מלוח (ימי עבודה בלבד): {row.vacation_days_auto.total_days}
                </Typography>
                <Stack direction="row" spacing={1}>
                  {Number(manualDays) > 0 && (
                    <Button
                      variant="outlined" color="error" size="small"
                      onClick={async () => {
                        if (!(await confirm({ title: 'איפוס ימי חופש', message: 'לאפס את ימי החופש בטבלת השכר לאפס?', danger: true }))) return;
                        setManualDays(0);
                        saveManualDays(0);
                      }}
                    >
                      בטל / אפס
                    </Button>
                  )}
                  {pendingApply ? (
                    <Button variant="contained" size="small" onClick={() => {
                      setManualDays(row.vacation_days_auto.total_days);
                      saveManualDays(row.vacation_days_auto.total_days);
                    }}>
                      החל לטבלת השכר
                    </Button>
                  ) : ((!manualDays || Number(manualDays) === 0) && (
                    // Outside August this already pays automatically (see
                    // usedDays above) — no click needed. Said here so it
                    // doesn't read as "nothing is happening".
                    <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                      מיושם אוטומטית בחישוב השכר — אין צורך בפעולה
                    </Typography>
                  ))}
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

          {(usedDays > 0 || (row.vacation_days_auto?.total_days || 0) > 0) && (
            <>
              <Divider />
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>תשלום ימי החופשה</Typography>
              {row.salary_type === 'global' ? (
                <Alert severity="info" sx={{ borderRadius: 2 }}>
                  עובד/ת בשכר גלובלי — ימי החופשה יורדים מהיתרה אך אינם מוסיפים תשלום; אין צורך באישור תשלום.
                </Alert>
              ) : (
              <Alert severity={(payConfirmed || approvedLimit > 0) ? 'success' : 'warning'} sx={{ borderRadius: 2 }}>
                {payConfirmed
                  ? 'הנהלת חשבונות אישרה לשלם את ימי החופשה גם ללא יתרת ימים לניצול — כך יופיע בכרטיס לרו״ח.'
                  : approvedLimit > 0
                    ? `הנהלת חשבונות אישרה לשלם עד ${approvedLimit} ימי חופשה גם מעבר ליתרה — מעבר למגבלה לא ישולם, וכך יופיע בכרטיס לרו״ח.`
                    : 'ברירת מחדל: בכרטיס לרו״ח מופיעה הערה קבועה — לשלם רק אם נותרו לעובד/ת ימי חופשה לניצול בתלוש.'}
              </Alert>
              )}
              {row.salary_type !== 'global' && (isAdmin || isAccountant) && (
                <FormControlLabel
                  control={<Switch checked={payConfirmed} onChange={async (e) => {
                    const v = e.target.checked;
                    if (v && !(await confirm({
                      title: 'תשלום חופשה ללא יתרה',
                      message: 'לאשר תשלום ימי החופשה גם אם לא נותרו לעובד/ת ימים לניצול? האישור יופיע בכרטיס לרו״ח.',
                      confirm_label: 'אשר תשלום',
                    }))) return;
                    setPayConfirmed(v);
                    api.patch(`/payroll-month/${row.employee_id}`, { manual: { vacation_pay_confirmed: v } }, { params: { month } })
                      .then(() => { onSaved && onSaved(); toast.success(v ? 'אושר תשלום גם ללא יתרה' : 'האישור בוטל — חזרה להערה הקבועה'); })
                      .catch(err => { setPayConfirmed(!v); toast.error(err.response?.data?.error || 'שגיאה'); });
                  }} />}
                  label={<Typography variant="body2" sx={{ fontWeight: 600 }}>אישור הנה״ח: שלם גם ללא יתרת ימים</Typography>}
                />
              )}
              {row.salary_type !== 'global' && (isAdmin || isAccountant) && (
                <>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      size="small"
                      type="number"
                      label="או אישור חלקי — עד כמה ימים"
                      value={limitInput}
                      onChange={e => setLimitInput(e.target.value)}
                      disabled={payConfirmed}
                      inputProps={{ step: 0.5, min: 0.5 }}
                      sx={{ width: 200 }}
                    />
                    <Button
                      variant="outlined" size="small"
                      disabled={payConfirmed || !limitInput || Number(limitInput) <= 0 || Number(limitInput) === Number(approvedLimit)}
                      onClick={async () => {
                        const n = Number(limitInput);
                        if (!(await confirm({
                          title: 'אישור תשלום חלקי מעבר ליתרה',
                          message: `לאשר תשלום של עד ${n} ימי חופשה גם אם היתרה לא מכסה אותם? מעבר למגבלה לא ישולם. האישור יופיע בכרטיס לרו״ח.`,
                          confirm_label: 'אשר מגבלה',
                        }))) return;
                        saveApprovedLimit(n);
                      }}
                    >
                      אשר מגבלה
                    </Button>
                    {approvedLimit > 0 && (
                      <Button variant="outlined" color="error" size="small" disabled={payConfirmed} onClick={() => saveApprovedLimit(null)}>
                        בטל מגבלה
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    המגבלה קובעת כמה ימים ישולמו לכל היותר מעבר ליתרה. היא לא מפחיתה ימים שהיתרה כבר מכסה, ולא פעילה כשהמתג "שלם גם ללא יתרת ימים" דולק.
                  </Typography>
                </>
              )}
            </>
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
