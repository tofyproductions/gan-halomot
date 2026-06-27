import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip,
  MenuItem, FormControlLabel, Checkbox,
} from '@mui/material';
import HealingIcon from '@mui/icons-material/Healing';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import BoltIcon from '@mui/icons-material/Bolt';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

function mimeFromName(name = '') {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
const ils = (n) => `₪${Math.round((Number(n) || 0)).toLocaleString('he-IL')}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- Sick-pay preview, mirrored client-side from server/src/services/sickPay.js
// so the dialog updates live as the accountant toggles "pay from day 1" or
// changes the policy/daily value, without waiting for a table refetch.
function paidDaysForSpell(workDays, fullFromDay1) {
  const n = Math.max(0, Math.round(Number(workDays) || 0));
  if (n <= 0) return 0;
  if (fullFromDay1) return n;
  let paid = 0;
  for (let i = 1; i <= n; i++) paid += (i === 1 ? 0 : (i <= 3 ? 0.5 : 1)); // day1 0%, 2-3 50%, 4+ 100%
  return paid;
}
function monthsElapsed(asOf, target) {
  if (!asOf || !target) return 0;
  const [ay, am] = String(asOf).split('-').map(Number);
  const [ty, tm] = String(target).split('-').map(Number);
  if (!ay || !am || !ty || !tm) return 0;
  const d = (ty - ay) * 12 + (tm - am);
  return d < 0 ? 0 : d;
}
// certs: [{ id, from_date, to_date, days, pay_from_first_day }]
function computePreview(certs, { dailyValue, balanceAvailable, policyFull }) {
  let rem = balanceAvailable == null ? Infinity : Number(balanceAvailable);
  const sorted = [...certs].sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)));
  const rows = sorted.map(c => {
    const days = Math.max(0, Math.round(Number(c.days) || 0));
    const full = !!c.pay_from_first_day || policyFull;
    const covered = Math.max(0, Math.min(days, rem));
    rem -= covered;
    const paid = paidDaysForSpell(covered, full);
    return {
      ...c, work_days: days, covered_days: covered, uncovered_days: days - covered,
      paid_days: round2(paid), paid_amount: round2(paid * dailyValue), full,
    };
  });
  const totalPaidDays = round2(rows.reduce((s, r) => s + r.paid_days, 0));
  return { rows, totalPaidDays, totalAmount: round2(totalPaidDays * dailyValue) };
}

/**
 * Sick-day management + statutory sick pay (חוק דמי מחלה) for one employee in a
 * month. The accountant:
 *   - sees approved sick periods with day count, certificate, AND the computed
 *     paid days + ₪ per certificate (each certificate is its own spell — no
 *     continuity — so two certs in a month never merge into one paid period);
 *   - toggles "שלם מהיום הראשון" per certificate (skips the day-1=0/2-3=50% law);
 *   - sets the employee's sick-pay policy, opening balance, and ₪-per-day value;
 *   - approves/rejects pending sick reports the employee filed (with their cert);
 *   - records a new sick period by date range + uploads the certificate.
 */
export default function SickDetailDialog({ open, row, month, onClose, onSaved }) {
  const confirm = useConfirm();
  const [approved, setApproved] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ from_date: '', to_date: '', reason: '', pay_from_first_day: false });
  const [file, setFile] = useState(null); // { name, data }
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null); // when set, the form edits this request
  const [manualDays, setManualDays] = useState(''); // direct edit of manual.sick_days (legacy/orphan values)
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null); // { detected, suggested_work_days }

  // Sick-pay settings, seeded from the row's server-computed sick_info and
  // editable here. Used for the live preview; "שמור הגדרות" persists to the employee.
  const si = row?.sick_info || {};
  const [policy, setPolicy] = useState('statutory');
  const [dailyOverride, setDailyOverride] = useState('');
  const [openDays, setOpenDays] = useState('');
  const [openMonth, setOpenMonth] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const load = () => {
    if (!row) return;
    setLoading(true);
    Promise.all([
      api.get('/employee-requests/sick-for-month', { params: { employee_id: row.employee_id, month } }),
      api.get('/employee-requests/pending-for-employee', { params: { employee_id: row.employee_id, type: 'sick' } }),
    ])
      .then(([a, p]) => {
        setApproved(a.data.requests || []);
        setPending(p.data.requests || []);
        if (a.data.sick_days !== undefined) setManualDays(String(Number(a.data.sick_days) || 0));
      })
      .catch(() => { setApproved([]); setPending([]); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !row) return;
    setDraft({ from_date: '', to_date: '', reason: '', pay_from_first_day: false });
    setFile(null);
    setEditingId(null);
    setManualDays(String(Number(row.manual?.sick_days) || 0));
    const info = row.sick_info || {};
    setPolicy(info.policy || 'statutory');
    setDailyOverride(info.daily_value_override != null ? String(info.daily_value_override) : '');
    setOpenDays(info.balance_opening?.days != null ? String(info.balance_opening.days) : '');
    setOpenMonth(info.balance_opening?.as_of_month || '');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row, month]);

  if (!row) return null;

  // Effective preview inputs (local settings override the server values so the
  // accountant sees the effect before saving).
  const autoDaily = Number(si.daily_value) || 0;
  const effDailyValue = dailyOverride !== '' ? (Number(dailyOverride) || 0) : autoDaily;
  const usedBefore = Number(si.used_before_month) || 0;
  const effAccrued = Math.min(90, (Number(openDays) || 0) + 1.5 * monthsElapsed(openMonth, month));
  const effAvailable = openMonth ? Math.max(0, round2(effAccrued - usedBefore)) : null; // null = no cap set
  const preview = computePreview(approved, {
    dailyValue: effDailyValue,
    balanceAvailable: effAvailable,
    policyFull: policy === 'full',
  });
  const previewById = new Map(preview.rows.map(r => [String(r.id), r]));

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setScanResult(null);
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, data: reader.result.split(',')[1] });
    reader.readAsDataURL(f);
  };

  // Send the uploaded certificate to Claude vision; pre-fill the date range and
  // surface the detected day count for the accountant to confirm (not applied).
  const scanFile = () => {
    if (!file?.data) return toast.error('העלה אישור קודם');
    setScanning(true);
    api.post('/employee-requests/scan-medical', {
      file_data: file.data, file_name: file.name, employee_id: row.employee_id,
    })
      .then(res => {
        const { detected, suggested_work_days } = res.data;
        setScanResult({ detected, suggested_work_days });
        if (detected?.from_date) {
          setDraft(d => ({ ...d, from_date: detected.from_date, to_date: detected.to_date || detected.from_date }));
        }
        if (detected?.is_sick_note === false) toast.warn('המסמך אינו נראה כאישור מחלה');
        else toast.success('הסריקה הושלמה — בדוק/י את התאריכים');
      })
      .catch(err => {
        const code = err.response?.status;
        if (code === 501) toast.error('סריקת AI אינה מוגדרת במערכת (חסר מפתח API)');
        else toast.error(err.response?.data?.error || 'שגיאה בסריקה');
      })
      .finally(() => setScanning(false));
  };

  const viewCert = async (id) => {
    try {
      const res = await api.get(`/employee-requests/${id}/medical-file`);
      const { data, name } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimeFromName(name)));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const resetForm = () => { setDraft({ from_date: '', to_date: '', reason: '', pay_from_first_day: false }); setFile(null); setEditingId(null); setScanResult(null); };

  const addSick = () => {
    if (!draft.from_date) return toast.error('בחר תאריך התחלה');
    setSaving(true);
    const payload = {
      from_date: draft.from_date,
      to_date: draft.to_date || draft.from_date,
      reason: draft.reason || null,
      pay_from_first_day: !!draft.pay_from_first_day,
      medical_file_data: file?.data || null,
      medical_file_name: file?.name || null,
    };
    const req = editingId
      ? api.put(`/employee-requests/${editingId}/admin`, payload)
      : api.post('/employee-requests/admin', { employee_id: row.employee_id, type: 'sick', ...payload });
    req
      .then(() => {
        toast.success(editingId ? 'המחלה עודכנה' : 'מחלה נרשמה וחושבה לפי ימי העבודה');
        resetForm();
        onSaved && onSaved();
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setDraft({ from_date: r.from_date, to_date: r.to_date || r.from_date, reason: r.reason || '', pay_from_first_day: !!r.pay_from_first_day });
    setFile(null);
  };

  // Toggle the per-certificate "pay from first day" flag (overrides the law for
  // that one spell). Updates the request, refreshes the table + this dialog.
  const toggleFirstDay = (r) => {
    api.put(`/employee-requests/${r.id}/admin`, { pay_from_first_day: !r.pay_from_first_day })
      .then(() => { onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const deleteSick = async (r) => {
    if (!(await confirm({ title: 'מחיקת מחלה', message: `למחוק את המחלה ${r.from_date}–${r.to_date || r.from_date}? ימי המחלה יקוזזו.`, danger: true }))) return;
    api.delete(`/employee-requests/${r.id}`)
      .then(() => { toast.success('המחלה נמחקה'); if (editingId === r.id) resetForm(); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Direct edit of the month's sick-day count — for legacy/orphan values that
  // have no underlying request record (e.g. imported or manually set).
  const saveManualDays = (value) => {
    const n = Math.max(0, Number(value) || 0);
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { sick_days: n } }, { params: { month } })
      .then(() => { toast.success('ימי המחלה עודכנו'); setManualDays(String(n)); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Recompute the month's sick-day count from the approved requests (fixes a
  // count that drifted from the actual records).
  const syncFromRequests = () => {
    api.post('/employee-requests/sync-sick', { employee_id: row.employee_id, month })
      .then(() => { toast.success('סונכרן לפי הבקשות'); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Persist the sick-pay policy / opening balance / daily-value override to the
  // employee, then refresh the table so the salary recomputes.
  const saveSettings = () => {
    setSavingSettings(true);
    api.put(`/payroll/employees/${row.employee_id}`, {
      sick_pay_policy: policy,
      sick_daily_value_override: dailyOverride === '' ? null : Number(dailyOverride),
      sick_balance_opening: {
        days: Number(openDays) || 0,
        as_of_month: openMonth || null,
      },
    })
      .then(() => { toast.success('הגדרות המחלה נשמרו'); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSavingSettings(false));
  };

  const decide = (id, status) => {
    api.put(`/employee-requests/${id}/status`, { status })
      .then(() => {
        toast.success(status === 'approved' ? 'אושר' : 'נדחה');
        onSaved && onSaved();
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const totalApprovedDays = approved.reduce((s, r) => s + (Number(r.days) || 0), 0);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HealingIcon color="error" />
        ימי מחלה — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {/* Summary: days, paid days, ₪ pay */}
          <Stack direction="row" spacing={1.5}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'error.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ימי מחלה החודש</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{Number(manualDays) || 0}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'info.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ימים בתשלום</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{preview.totalPaidDays}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">דמי מחלה</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, color: 'success.dark' }}>{ils(preview.totalAmount)}</Typography>
            </Box>
          </Stack>

          {/* Balance line */}
          <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ fontSize: 13 }}>
              <span>יתרת מחלה זמינה: <b>{openMonth ? round2(effAvailable) : '—'}</b> ימים</span>
              <span>נצברו (תקרה 90): <b>{round2(effAccrued)}</b></span>
              <span>נוצלו עד החודש: <b>{round2(usedBefore)}</b></span>
              <span>ערך יום: <b>{ils(effDailyValue)}</b></span>
            </Stack>
            {preview.rows.some(r => r.uncovered_days > 0) && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                ⚠ חלק מהימים חורגים מהיתרה ולא שולמו.
              </Typography>
            )}
          </Alert>

          {/* Sick-pay settings */}
          <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הגדרות דמי מחלה</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
              <TextField
                select size="small" label="מדיניות" value={policy}
                onChange={e => setPolicy(e.target.value)} sx={{ width: 200 }}
              >
                <MenuItem value="statutory">חוק (יום 1 ללא, 2-3 ב-50%, 4+ במלא)</MenuItem>
                <MenuItem value="full">מלא מהיום הראשון</MenuItem>
              </TextField>
              <TextField
                size="small" type="number" label="ערך יום (₪) — אופציונלי"
                value={dailyOverride} onChange={e => setDailyOverride(e.target.value)}
                placeholder={String(autoDaily)} inputProps={{ min: 0, step: 1 }} sx={{ width: 180 }}
              />
              <TextField
                size="small" type="number" label="יתרת פתיחה (ימים)"
                value={openDays} onChange={e => setOpenDays(e.target.value)}
                inputProps={{ min: 0, step: 0.5 }} sx={{ width: 150 }}
              />
              <TextField
                size="small" type="month" label="נכון לחודש" InputLabelProps={{ shrink: true }}
                value={openMonth} onChange={e => setOpenMonth(e.target.value)} sx={{ width: 150 }}
              />
              <Button variant="contained" size="small" onClick={saveSettings} disabled={savingSettings}>
                שמור הגדרות
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              ערך יום ריק → מחושב אוטומטית משכר העובד. יתרת פתיחה נצברת 1.5 ימים לכל חודש שאחרי "נכון לחודש".
            </Typography>
          </Box>

          {(Number(manualDays) || 0) !== totalApprovedDays && (
            <Alert
              severity="warning"
              action={<Button color="inherit" size="small" onClick={syncFromRequests}>סנכרן ל-{totalApprovedDays}</Button>}
            >
              מספר ימי המחלה ({Number(manualDays) || 0}) אינו תואם לסך הבקשות המאושרות ({totalApprovedDays}).
            </Alert>
          )}

          {/* Direct edit of the month's sick-day count (handles legacy/orphan
              values with no request behind them). */}
          <Box sx={{ p: 1.5, border: '1px dashed', borderColor: 'divider', borderRadius: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>עריכת מספר ימי המחלה בחודש:</Typography>
              <TextField
                type="number" size="small" value={manualDays}
                onChange={e => setManualDays(e.target.value)}
                inputProps={{ min: 0, step: 0.5 }} sx={{ width: 100 }}
              />
              <Button variant="contained" size="small" onClick={() => saveManualDays(manualDays)}>שמור</Button>
              <Button variant="outlined" color="error" size="small" onClick={() => saveManualDays(0)}>אפס</Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              שינוי ישיר של מספר הימים החודש (גם אם אין רשומת מחלה מצורפת). לרישום מתועד עם תאריכים ואישור — השתמש בטופס למטה.
            </Typography>
          </Box>

          {loading && <Box sx={{ textAlign: 'center', py: 1 }}><CircularProgress size={24} /></Box>}

          {pending.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                ממתין לאישור (העובד דיווח)
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>מתאריך</TableCell>
                    <TableCell>עד תאריך</TableCell>
                    <TableCell>אישור</TableCell>
                    <TableCell align="center">פעולות</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pending.map(r => (
                    <TableRow key={r.id}>
                      <TableCell>{r.from_date}</TableCell>
                      <TableCell>{r.to_date}</TableCell>
                      <TableCell>
                        {r.has_file ? (
                          <Tooltip title="צפה באישור">
                            <IconButton size="small" onClick={() => viewCert(r.id)}><VisibilityIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        ) : <Chip size="small" label="ללא אישור" color="warning" variant="outlined" />}
                      </TableCell>
                      <TableCell align="center">
                        <Tooltip title="אשר"><IconButton size="small" color="success" onClick={() => decide(r.id, 'approved')}><CheckIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="דחה"><IconButton size="small" color="error" onClick={() => decide(r.id, 'rejected')}><CloseIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="מחק"><IconButton size="small" onClick={() => deleteSick(r)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>מחלות מאושרות החודש</Typography>
          <Typography variant="caption" color="text.secondary">
            כל אישור מחושב בנפרד (אין רצף) — יום 1 ללא תשלום, ימים 2-3 ב-50%, יום 4+ במלא. "מהיום ה-1" משלם הכל במלא.
          </Typography>
          {approved.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין מחלות מאושרות החודש.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מתאריך</TableCell>
                  <TableCell>עד תאריך</TableCell>
                  <TableCell align="center">ימים</TableCell>
                  <TableCell align="center">בתשלום</TableCell>
                  <TableCell align="center">₪</TableCell>
                  <TableCell align="center">מהיום ה-1</TableCell>
                  <TableCell align="center">אישור</TableCell>
                  <TableCell align="center">פעולות</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {approved.map(r => {
                  const pv = previewById.get(String(r.id)) || {};
                  const full = !!r.pay_from_first_day || policy === 'full';
                  return (
                    <TableRow key={r.id} sx={editingId === r.id ? { bgcolor: 'primary.50' } : undefined}>
                      <TableCell>{r.from_date}</TableCell>
                      <TableCell>{r.to_date}</TableCell>
                      <TableCell align="center"><Chip label={r.days} size="small" color="error" /></TableCell>
                      <TableCell align="center">{pv.paid_days != null ? pv.paid_days : '—'}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700, color: 'success.dark' }}>
                        {pv.paid_amount != null ? ils(pv.paid_amount) : '—'}
                      </TableCell>
                      <TableCell align="center">
                        <Tooltip title={policy === 'full' ? 'העובד במדיניות "מלא" — כל הימים משולמים' : (r.pay_from_first_day ? 'מבוטל — חזרה לחישוב לפי חוק' : 'שלם מהיום הראשון')}>
                          <span>
                            <Chip
                              size="small" icon={<BoltIcon />} label={full ? 'מלא' : 'חוק'}
                              color={full ? 'success' : 'default'}
                              variant={full ? 'filled' : 'outlined'}
                              onClick={() => toggleFirstDay(r)}
                              disabled={policy === 'full'}
                              sx={{ cursor: policy === 'full' ? 'default' : 'pointer' }}
                            />
                          </span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="center">
                        {r.has_file ? (
                          <Tooltip title="צפה באישור">
                            <IconButton size="small" color="primary" onClick={() => viewCert(r.id)}><VisibilityIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        ) : <Chip size="small" label="ללא אישור" color="warning" variant="outlined" />}
                      </TableCell>
                      <TableCell align="center">
                        <Tooltip title="ערוך">
                          <IconButton size="small" onClick={() => startEdit(r)}><EditIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title="מחק">
                          <IconButton size="small" color="error" onClick={() => deleteSick(r)}><DeleteIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <Divider />
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {editingId ? 'עריכת מחלה' : 'רישום מחלה חדשה'}
            </Typography>
            {editingId && <Chip size="small" label="עורך — שמירה תעדכן את הרישום" color="primary" variant="outlined" onDelete={resetForm} />}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            הזן טווח תאריכים — המערכת תספור רק ימי עבודה (לא שבת ולא היום החופשי של העובד).
            {editingId && ' אם לא תעלה אישור חדש — האישור הקיים יישמר.'}
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField size="small" type="date" label="מתאריך" InputLabelProps={{ shrink: true }}
              value={draft.from_date} onChange={e => setDraft({ ...draft, from_date: e.target.value })} sx={{ width: 160 }} />
            <TextField size="small" type="date" label="עד תאריך" InputLabelProps={{ shrink: true }}
              value={draft.to_date} onChange={e => setDraft({ ...draft, to_date: e.target.value })} sx={{ width: 160 }} />
            <TextField size="small" label="הערה (אופציונלי)"
              value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} sx={{ flex: 1, minWidth: 140 }} />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} size="small">
              {file ? 'החלף אישור' : 'העלה אישור מחלה'}
              <input type="file" hidden accept="image/*,application/pdf" onChange={onPickFile} />
            </Button>
            {file && <Chip label={file.name} size="small" onDelete={() => { setFile(null); setScanResult(null); }} />}
            {file && (
              <Button
                variant="outlined" color="secondary" size="small"
                startIcon={scanning ? <CircularProgress size={14} /> : <AutoAwesomeIcon />}
                onClick={scanFile} disabled={scanning}
              >
                סרוק אישור (AI)
              </Button>
            )}
            {!file && <Typography variant="caption" color="warning.main">מומלץ לצרף אישור</Typography>}
            <FormControlLabel
              sx={{ ml: 'auto' }}
              control={<Checkbox size="small" checked={!!draft.pay_from_first_day} onChange={e => setDraft({ ...draft, pay_from_first_day: e.target.checked })} />}
              label={<Typography variant="body2">שלם מהיום הראשון</Typography>}
            />
          </Stack>
          {scanResult?.detected && (
            <Alert severity={scanResult.detected.is_sick_note === false ? 'warning' : 'info'} sx={{ py: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                תוצאת סריקה (לאישורך):
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 0.5, fontSize: 13 }}>
                <span>תאריכים: <b>{scanResult.detected.from_date || '—'}</b> → <b>{scanResult.detected.to_date || '—'}</b></span>
                {scanResult.suggested_work_days != null && <span>ימי עבודה: <b>{scanResult.suggested_work_days}</b></span>}
                {scanResult.detected.total_days != null && <span>ימים באישור: <b>{scanResult.detected.total_days}</b></span>}
                {scanResult.detected.employee_name && <span>שם: <b>{scanResult.detected.employee_name}</b></span>}
                <Chip size="small" label={`ביטחון: ${scanResult.detected.confidence || '—'}`}
                  color={scanResult.detected.confidence === 'high' ? 'success' : scanResult.detected.confidence === 'low' ? 'error' : 'default'} />
              </Stack>
              {scanResult.detected.notes && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {scanResult.detected.notes}
                </Typography>
              )}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {editingId && <Button onClick={resetForm}>בטל עריכה</Button>}
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" color="error" onClick={addSick} disabled={saving || !draft.from_date}>
          {editingId ? 'עדכן מחלה' : 'רשום מחלה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
