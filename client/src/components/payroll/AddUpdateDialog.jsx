import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  TextField, MenuItem, Alert, Tabs, Tab, InputAdornment, Chip, Box, Divider,
  Table, TableHead, TableBody, TableRow, TableCell, CircularProgress, Tooltip, IconButton,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { BusyButton, UploadingBar } from '../shared/UploadControls';
import { ADJUSTMENT_TYPES } from './adjustmentTypes';

const fmtDate = (ymd) => { try { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; } catch { return ymd; } };

/** Whole days between two YYYY-MM-DD dates, inclusive. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(+a) || Number.isNaN(+b) || b < a) return null;
  return Math.round((b - a) / 86400000) + 1;
}

const ABSENCE_CATEGORIES = [
  { value: 'unpaid', label: 'ללא תשלום (מנוכה)' },
  { value: 'other', label: 'אחר (מנוכה)' },
  { value: 'sick', label: 'מחלה (בתשלום)' },
  { value: 'vacation', label: 'חופשה (בתשלום)' },
  { value: 'reserve', label: 'מילואים (בתשלום)' },
];

/* ------------------------------------------------------------- leave forms */

/**
 * ימי מחלה / ימי חופשה — filed as an EmployeeRequest, not as a number in the
 * salary table.
 *
 * The request already carries the dates, the certificate and an approval chain
 * that ends at the accountant and applies itself to payroll on approval.
 * Writing a day COUNT into the table instead would skip all of it and throw
 * away the dates the count came from.
 */
function LeaveForm({ kind, employee, onDone, canDecide }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const isSick = kind === 'sick';
  const days = daysBetween(from, to || from);

  const submit = () => {
    if (!from) return toast.error('יש להזין תאריך התחלה');
    setSaving(true);
    const send = (medical) => api.post('/employee-requests/admin', {
      employee_id: employee.employee_id,
      type: kind,
      from_date: from,
      to_date: to || from,
      reason: reason || null,
      ...(medical || {}),
    })
      .then(() => {
        toast.success(canDecide ? 'נרשם ואושר' : 'נשלח לאישור הנהלת החשבונות');
        onDone();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));

    if (!file) return send();
    const reader = new FileReader();
    reader.onerror = () => { setSaving(false); toast.error('קריאת הקובץ נכשלה'); };
    reader.onload = () => send({
      medical_file_data: String(reader.result).split(',')[1],
      medical_file_name: file.name,
    });
    reader.readAsDataURL(file);
  };

  return (
    <Stack spacing={2}>
      <Alert severity="info" icon={false}>
        {isSick
          ? 'העלאת אישור המחלה והתאריכים במקום העובד/ת. האישור מצורף לבקשה ועובר להנהלת החשבונות.'
          : 'תאריכי החופשה של העובד/ת. סיבה אינה חובה.'}
      </Alert>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          type="date" size="small" label="תאריך התחלה" value={from} fullWidth
          onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }}
        />
        <TextField
          type="date" size="small" label="תאריך סיום" value={to} fullWidth
          onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }}
          helperText="ריק = יום אחד"
        />
      </Stack>
      {days > 0 && <Typography variant="caption" color="text.secondary">{days} ימים</Typography>}

      {isSick && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={saving}>
            {file ? 'החלף אישור' : 'צרף אישור מחלה'}
            <input
              type="file" hidden accept="application/pdf,image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 8 * 1024 * 1024) return toast.error('הקובץ גדול מדי (מקסימום 8MB)');
                setFile(f);
              }}
            />
          </Button>
          {file && <Chip size="small" label={file.name} onDelete={() => setFile(null)} />}
        </Stack>
      )}

      <TextField
        size="small" label={isSick ? 'הערה (אופציונלי)' : 'סיבה (אופציונלי)'} value={reason}
        onChange={e => setReason(e.target.value)} fullWidth multiline minRows={2}
      />
      <UploadingBar show={saving} />
      <BusyButton variant="contained" startIcon={<AddIcon />} loading={saving} loadingText="שולח…"
        onClick={submit} disabled={!from}>
        {canDecide ? 'רשום' : 'שלח לאישור'}
      </BusyButton>
    </Stack>
  );
}

/**
 * ימי היעדרות — the days the month could not explain.
 *
 * The manager says what each one was; the accountant decides whether it costs
 * anything. Each side writes its own flag, so approving here never sets the
 * accounting approval and never reduces pay on its own.
 */
function AbsenceForm({ employee, month, onDone, canDecide }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});   // { [date]: {category, note, manager_approved} }
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/payroll-month/my-updates/absences', {
      params: { month, employee_id: employee.employee_id },
    })
      .then((res) => {
        setData(res.data);
        setDraft(Object.fromEntries((res.data.absences || []).map(a => [a.date, {
          category: a.category, note: a.note, manager_approved: a.manager_approved,
        }])));
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת ההיעדרויות'))
      .finally(() => setLoading(false));
  }, [employee.employee_id, month]);

  const save = () => {
    const entries = (data?.absences || []).map(a => ({
      date: a.date,
      category: draft[a.date]?.category ?? a.category,
      note: draft[a.date]?.note ?? a.note,
      manager_approved: draft[a.date]?.manager_approved ?? a.manager_approved,
    }));
    if (entries.length === 0) return;
    setSaving(true);
    api.patch(`/payroll-month/${employee.employee_id}`, { month, absence_entries: entries })
      .then(() => { toast.success(canDecide ? 'נשמר' : 'נשמר — ממתין לאישור הנהלת החשבונות'); onDone(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  if (loading) return <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>;

  const absences = data?.absences || [];
  const partial = data?.partial || [];

  return (
    <Stack spacing={2}>
      <Alert severity="info" icon={false}>
        סמן/י מה הייתה כל היעדרות. האישור שלך אינו מנכה שכר — הנהלת החשבונות מאשרת בשלב השני.
      </Alert>

      {absences.length === 0 ? (
        <Alert severity="success">אין ימי היעדרות לחודש זה.</Alert>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סיבה</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>הערה</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">אישור מנהל/ת</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">הנה״ח</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {absences.map((a) => {
              const d = draft[a.date] || {};
              return (
                <TableRow key={a.date}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(a.date)}</TableCell>
                  <TableCell>
                    <TextField
                      select size="small" value={d.category ?? a.category} sx={{ minWidth: 150 }}
                      onChange={e => setDraft(s => ({ ...s, [a.date]: { ...d, category: e.target.value } }))}
                    >
                      {ABSENCE_CATEGORIES.map(c => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small" value={d.note ?? a.note} placeholder="פירוט"
                      onChange={e => setDraft(s => ({ ...s, [a.date]: { ...d, note: e.target.value } }))}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <Tooltip title={(d.manager_approved ?? a.manager_approved) ? 'מאושר' : 'לא מאושר'}>
                      <IconButton
                        color={(d.manager_approved ?? a.manager_approved) ? 'success' : 'default'}
                        onClick={() => setDraft(s => ({
                          ...s, [a.date]: { ...d, manager_approved: !(d.manager_approved ?? a.manager_approved) },
                        }))}
                      >
                        {(d.manager_approved ?? a.manager_approved) ? <CheckCircleIcon /> : <RadioButtonUncheckedIcon />}
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="center">
                    <Chip size="small" color={a.accounting_approved ? 'success' : 'warning'} variant="outlined"
                      label={a.accounting_approved ? 'אושר' : 'ממתין'} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {partial.length > 0 && (
        <>
          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>היעדרויות שעתיות</Typography>
          <Typography variant="caption" color="text.secondary">
            ימים שבהם העובד/ת הגיע/ה אך סיים/ה מוקדם. לצפייה בלבד — ההכרעה עליהן היא של הנהלת החשבונות.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">מחויב</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">בפועל</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">חוסר</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {partial.map(p => (
                <TableRow key={p.date}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(p.date)}</TableCell>
                  <TableCell align="center">{p.committed_hours ?? '—'}</TableCell>
                  <TableCell align="center">{p.worked_hours ?? '—'}</TableCell>
                  <TableCell align="center" sx={{ color: 'error.main', fontWeight: 700 }}>{p.shortfall_hours ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" color={p.excused ? 'success' : 'default'} variant="outlined"
                      label={p.excused ? `מוצדק${p.reason ? ` — ${p.reason}` : ''}` : 'לא הוכרע'} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      <UploadingBar show={saving} />
      {absences.length > 0 && (
        <BusyButton variant="contained" loading={saving} loadingText="שומר…" onClick={save}>
          שמור
        </BusyButton>
      )}
    </Stack>
  );
}


/**
 * החתמות — the employee's clock days for the month, problems first.
 *
 * This is what "תיקון דיווח שעות" became. Typing a number of hours into a form
 * hid the missing punch rather than correcting it, and handed the accountant a
 * figure with nothing behind it. Here the manager sees the day that is actually
 * broken; the correction goes in as a punch and reaches the accountant as a
 * pending clock issue, like every other punch correction.
 */
function PunchesForm({ employee, month, initial, onCounts }) {
  const [data, setData] = useState(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [fix, setFix] = useState(null);       // the day being completed / added
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // one punch whose time is being changed
  const [editTime, setEditTime] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/payroll-month/my-updates/punches', {
      params: { month, employee_id: employee.employee_id },
    })
      .then((res) => { setData(res.data); onCounts?.(res.data.problem_count || 0); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת ההחתמות'))
      .finally(() => setLoading(false));
  };

  // The shell already fetched this to colour the tab; don't fetch it twice.
  useEffect(() => { if (!initial) load(); }, [employee.employee_id, month, initial]);

  /**
   * Change one punch's time.
   *
   * The server parks a manager's change on a punch that already counts and
   * leaves the salary alone until the accountant decides. That is the whole
   * reason this asks for a reason: the accountant is being shown a time she
   * cannot check against anything, and "the clock in the גן was an hour fast"
   * is the difference between approving it and ringing the branch.
   */
  const submitEdit = () => {
    if (!editTime) return toast.error('יש להזין שעה');
    setSaving(true);
    api.patch(`/payroll/punches/${editing.punch.id}`, {
      timestamp: `${editing.date}T${editTime}:00`,
      manual_note: editing.note || '',
    })
      .then((res) => {
        toast.success(res.data?.pending
          ? 'השינוי נשלח לאישור הנהלת החשבונות — השעות לא ישתנו עד שיאושר'
          : 'השעה עודכנה');
        setEditing(null); setEditTime(''); load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const removePunch = (day, punch) => {
    // eslint-disable-next-line no-alert, no-restricted-globals
    if (!confirm(`למחוק את ההחתמה ${punch.time} בתאריך ${fmtDate(day.date)}?`)) return;
    api.delete(`/payroll/punches/${punch.id}`)
      .then(() => { toast.success('ההחתמה נמחקה'); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const submitFix = () => {
    if (!inTime && !outTime) return toast.error('יש להזין לפחות שעה אחת');
    setSaving(true);
    api.post('/payroll/manual-punches', {
      employee_id: employee.employee_id,
      branch_id: data?.home_branch_id,
      date: fix.date,
      in_time: inTime || undefined,
      out_time: outTime || undefined,
    })
      .then(() => { toast.success('הדיווח נשלח לאישור הנהלת החשבונות'); setFix(null); setInTime(''); setOutTime(''); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  if (loading) return <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>;

  const days = data?.days || [];
  const problems = days.filter(d => d.has_problem);

  return (
    <Stack spacing={2}>
      {problems.length === 0
        ? <Alert severity="success">אין בעיות בהחתמות לחודש זה.</Alert>
        : (
          <Alert severity="error">
            {problems.length} ימים עם בעיה בהחתמה. תיקון נרשם כהחתמה חדשה ועובר לאישור הנהלת החשבונות.
          </Alert>
        )}

      {/* A day with no punches at all does not appear in the table — there is
          nothing to list. So adding one starts here rather than from a row. */}
      <Stack direction="row" alignItems="center">
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<AddIcon />}
          onClick={() => { setFix({ date: '', isNew: true }); setInTime(''); setOutTime(''); }}>
          הוספת יום שלא הוחתם
        </Button>
      </Stack>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>החתמות</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="center">פעולה</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {days.map(d => (
            <TableRow key={d.date} sx={d.has_problem ? { bgcolor: '#fef2f2' } : undefined}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(d.date)}</TableCell>
              <TableCell sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{d.branch || '—'}</TableCell>
              <TableCell>
                {/* Each punch on its own, because a time cannot be changed
                    without saying which of the day's records it is. */}
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                  {(d.punches || []).map(pn => (
                    <Chip
                      key={pn.id}
                      size="small"
                      variant={pn.counts ? 'filled' : 'outlined'}
                      color={pn.pending_time ? 'info' : (pn.counts ? 'default' : 'warning')}
                      label={pn.pending_time ? `${pn.time} ← ${pn.pending_time}` : pn.time}
                      onClick={() => { setEditing({ date: d.date, punch: pn, note: '' }); setEditTime(pn.time); }}
                      onDelete={() => removePunch(d, pn)}
                      deleteIcon={<DeleteOutlineIcon />}
                      icon={<EditIcon sx={{ fontSize: 14 }} />}
                      sx={{ cursor: 'pointer' }}
                    />
                  ))}
                  {!(d.punches || []).length && <Typography variant="caption" color="text.disabled">—</Typography>}
                </Stack>
              </TableCell>
              <TableCell>
                {d.incomplete && <Chip size="small" color="error" label="החתמה חסרה" />}
                {d.too_many && <Chip size="small" color="warning" label={`${d.times.length} החתמות`} />}
                {d.pending_approval && (
                  <Chip size="small" variant="outlined" color="info"
                    label={d.approval_stage === 'accountant' ? 'ממתין להנה״ח' : 'ממתין למנהל/ת'} sx={{ ml: 0.5 }} />
                )}
                {!d.has_problem && !d.pending_approval && <Typography variant="caption" color="text.disabled">תקין</Typography>}
              </TableCell>
              <TableCell align="center">
                {d.incomplete && !d.pending_approval ? (
                  <Button size="small" variant="outlined"
                    onClick={() => { setFix(d); setInTime(d.in_time || ''); setOutTime(''); }}>
                    השלם
                  </Button>
                ) : (
                  <Tooltip title="הוספת החתמה ליום הזה">
                    <IconButton size="small"
                      onClick={() => { setFix(d); setInTime(''); setOutTime(''); }}>
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </TableCell>
            </TableRow>
          ))}
          {days.length === 0 && (
            <TableRow><TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
              אין החתמות לחודש זה
            </TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={!!fix} onClose={() => setFix(null)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {fix?.isNew ? 'הוספת יום' : `החתמה — ${fix ? fmtDate(fix.date) : ''}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              הדיווח נרשם כהחתמה ידנית ועובר לאישור הנהלת החשבונות — הוא אינו משנה שעות בעצמו.
            </Typography>
            {fix?.isNew && (
              <TextField type="date" size="small" label="תאריך" value={fix.date}
                onChange={e => setFix(f => ({ ...f, date: e.target.value }))}
                InputLabelProps={{ shrink: true }}
                inputProps={{ min: `${month}-01`, max: `${month}-31` }}
                helperText="בתוך החודש המוצג בלבד"
                fullWidth />
            )}
            <TextField type="time" size="small" label="שעת כניסה" value={inTime}
              onChange={e => setInTime(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField type="time" size="small" label="שעת יציאה" value={outTime}
              onChange={e => setOutTime(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            <UploadingBar show={saving} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFix(null)} disabled={saving}>ביטול</Button>
          <BusyButton variant="contained" loading={saving} loadingText="שולח…"
            disabled={!fix?.date} onClick={submitFix}>שלח</BusyButton>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          שינוי שעה — {editing ? fmtDate(editing.date) : ''}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {editing?.punch?.counts && (
              <Alert severity="warning">
                ההחתמה הזו כבר נספרת בשכר. השינוי יישלח לאישור הנהלת החשבונות והשעות
                יישארו כפי שהן עד שיאושר.
              </Alert>
            )}
            {editing?.punch?.pending_time && (
              <Alert severity="info">
                כבר נשלח שינוי ל־{editing.punch.pending_time} וממתין לאישור. שליחה נוספת תחליף אותו.
              </Alert>
            )}
            <TextField type="time" size="small" label="שעה" value={editTime}
              onChange={e => setEditTime(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField size="small" label="סיבה" value={editing?.note || ''}
              onChange={e => setEditing(v => ({ ...v, note: e.target.value }))}
              placeholder="למשל: השעון בגן הקדים בשעה"
              helperText="הנהלת החשבונות רואה רק את השעה — הסיבה היא מה שמאפשר לאשר בלי טלפון"
              fullWidth />
            <UploadingBar show={saving} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)} disabled={saving}>ביטול</Button>
          <BusyButton variant="contained" loading={saving} loadingText="שולח…" onClick={submitEdit}>שמירה</BusyButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/* ------------------------------------------------------------- field forms */

/** number_or_text fields arrive as { kind, amount, text }. */
function fieldValueText(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') {
    if (v.kind === 'text' && v.text) return v.text;
    if (v.amount !== null && v.amount !== undefined && v.amount !== '') {
      return v.text ? `${v.amount} — ${v.text}` : String(v.amount);
    }
    return '—';
  }
  return String(v);
}

function FieldForm({ employee, month, fields, onDone, canDecide }) {
  const [field, setField] = useState(fields?.[0]?.field || 'gift_card');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const def = (fields || []).find(f => f.field === field);
  const input = def?.input || 'text';

  useEffect(() => { setAmount(''); setText(''); setFrom(''); setTo(''); setNote(''); }, [field]);

  const buildValue = () => {
    switch (input) {
      case 'amount_reason': {
        const n = Number(amount);
        if (!n || Number.isNaN(n)) { toast.error('יש להזין סכום'); return undefined; }
        if (!text.trim()) { toast.error('יש להזין סיבה'); return undefined; }
        return { kind: 'number', amount: n, text: text.trim() };
      }
      case 'date_range': {
        // Either end alone is valid: a manager may know only that someone left
        // for reserve duty, or only that they came back after a long stretch.
        if (!from && !to) { toast.error('יש להזין לפחות תאריך אחד'); return undefined; }
        const days = daysBetween(from, to);
        const parts = [];
        if (from) parts.push(`יציאה ${fmtDate(from)}`);
        if (to) parts.push(`חזרה ${fmtDate(to)}`);
        if (note.trim()) parts.push(note.trim());
        return { kind: days ? 'number' : 'text', amount: days ?? null, text: parts.join(' · ') };
      }
      default: {
        if (!text.trim()) { toast.error('יש להזין טקסט'); return undefined; }
        return def?.kind === 'text' ? text.trim() : { kind: 'text', amount: null, text: text.trim() };
      }
    }
  };

  const submit = () => {
    const requested = buildValue();
    if (requested === undefined) return;
    setSaving(true);
    api.post('/payroll-month/change-requests', {
      month,
      note: '',
      changes: [{
        employee_id: employee.employee_id,
        field,
        field_label: def?.label || field,
        current_value: employee.field_values?.[field] ?? null,
        requested_value: requested,
      }],
    })
      .then(() => { toast.success(canDecide ? 'נרשמה בקשת שינוי' : 'נשלח לאישור הנהלת החשבונות'); onDone(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  return (
    <Stack spacing={2}>
      <TextField select size="small" label="שדה" value={field} fullWidth
        onChange={e => setField(e.target.value)}>
        {(fields || []).map(f => <MenuItem key={f.field} value={f.field}>{f.label}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color="text.secondary">
        ערך נוכחי: <b>{fieldValueText(employee.field_values?.[field])}</b>
      </Typography>

      {input === 'amount_reason' && (
        <>
          <TextField
            type="number" size="small" label="סכום" value={amount} fullWidth
            onChange={e => setAmount(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
          />
          <TextField size="small" label="סיבה" value={text} fullWidth required
            onChange={e => setText(e.target.value)} multiline minRows={2}
            placeholder="למשל: הוקרה על ליווי קייטנה" />
        </>
      )}

      {input === 'date_range' && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="date" size="small" label="תאריך יציאה" value={from} fullWidth
              onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
            <TextField type="date" size="small" label="תאריך חזרה" value={to} fullWidth
              onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            אפשר להזין רק תאריך יציאה (עדיין בשירות), רק תאריך חזרה (חזר/ה אחרי תקופה ארוכה), או את שניהם.
            {daysBetween(from, to) ? ` — ${daysBetween(from, to)} ימים` : ''}
          </Typography>
          <TextField size="small" label="הערה (אופציונלי)" value={note} fullWidth
            onChange={e => setNote(e.target.value)} />
        </>
      )}

      {input === 'text' && (
        <TextField size="small" label={def?.label} value={text} fullWidth multiline minRows={2}
          onChange={e => setText(e.target.value)} />
      )}

      <UploadingBar show={saving} />
      <BusyButton variant="contained" startIcon={<AddIcon />} loading={saving} loadingText="שולח…" onClick={submit}>
        {canDecide ? 'רשום' : 'שלח לאישור'}
      </BusyButton>
    </Stack>
  );
}

/* -------------------------------------------------------- adjustment form */

function AdjustmentForm({ employee, month, onDone, canDecide }) {
  const [draft, setDraft] = useState({ type: 'money_add', amount: '', hours: '', reason: '' });
  const [saving, setSaving] = useState(false);

  const currentType = ADJUSTMENT_TYPES.find(t => t.value === draft.type);
  const usesAmount = currentType?.field === 'amount';

  const submit = () => {
    const value = usesAmount ? Number(draft.amount) : Number(draft.hours);
    if (!value || Number.isNaN(value)) return toast.error('יש להזין ערך מספרי');
    setSaving(true);
    api.post('/payroll-month/adjustments', {
      employee_id: employee.employee_id,
      month,
      type: draft.type,
      amount: usesAmount ? Math.abs(value) * (currentType.positive === false ? -1 : 1) : 0,
      hours: !usesAmount ? Math.abs(value) * (currentType.positive === false ? -1 : 1) : 0,
      reason: draft.reason,
    })
      .then((res) => { toast.success(res.data?.pending ? 'נשלח לאישור הנהלת החשבונות' : 'העדכון נוסף'); onDone(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  return (
    <Stack spacing={2}>
      <TextField select size="small" label="סוג עדכון" value={draft.type} fullWidth
        onChange={e => setDraft({ ...draft, type: e.target.value })}>
        {ADJUSTMENT_TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
      </TextField>
      {usesAmount ? (
        <TextField
          type="number" size="small" label="סכום" value={draft.amount} fullWidth
          onChange={e => setDraft({ ...draft, amount: e.target.value })}
          InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
          helperText={currentType.positive === false ? 'הסכום ינוכה מהשכר' : currentType.positive === true ? 'הסכום יתווסף לשכר' : 'חיובי = תוספת, שלילי = ניכוי'}
        />
      ) : (
        <TextField
          type="number" size="small" label="שעות" value={draft.hours} fullWidth
          onChange={e => setDraft({ ...draft, hours: e.target.value })}
          InputProps={{ endAdornment: <InputAdornment position="end">שעות</InputAdornment> }}
        />
      )}
      <TextField size="small" label="סיבה / הערה" value={draft.reason} fullWidth multiline minRows={2}
        onChange={e => setDraft({ ...draft, reason: e.target.value })}
        placeholder="למשל: בונוס הובלת קבוצה / קניות חומרי יצירה / שעות שלא נחתמו" />
      <UploadingBar show={saving} />
      <BusyButton variant="contained" startIcon={<AddIcon />} loading={saving} loadingText="שולח…" onClick={submit}>
        {canDecide ? 'הוסף' : 'שלח לאישור'}
      </BusyButton>
    </Stack>
  );
}

/* -------------------------------------------------------------------- shell */

/**
 * Everything a manager can file about one employee for one month, split by
 * what the thing actually is rather than by which table it happens to land in.
 */
export default function AddUpdateDialog({
  open, employee, month, onClose, onSaved, canDecide, requestableFields, leaveKinds,
}) {
  const [mode, setMode] = useState('adjustment');
  // Set by the punches panel once it knows. The tab has to be able to shout
  // before anyone opens it — a missing punch is not something to go looking for.
  const [punchProblems, setPunchProblems] = useState(0);
  const [punchData, setPunchData] = useState(null);

  useEffect(() => {
    if (!open || !employee) { setPunchData(null); setPunchProblems(0); return; }
    setMode('adjustment');
    setPunchData(null);
    setPunchProblems(0);
    // Fetched with the dialog rather than with the tab: a missing punch has to
    // announce itself, not wait to be found.
    api.get('/payroll-month/my-updates/punches', {
      params: { month, employee_id: employee.employee_id },
    })
      .then((res) => { setPunchData(res.data); setPunchProblems(res.data.problem_count || 0); })
      .catch(() => { /* the tab still opens and reports its own failure */ });
  }, [open, employee, month]);
  if (!employee) return null;

  const done = () => { onSaved(); onClose(); };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        עדכון שכר — {employee.full_name}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
          {employee.branch_name} • חודש {month}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!canDecide && (
            <Alert severity="warning" icon={false}>
              אפשר להוסיף כל עדכון. הוא יירשם על שמך כ״ממתין לאישור״ ולא ישפיע על השכר עד שהנהלת החשבונות תאשר.
            </Alert>
          )}

          <Tabs value={mode} onChange={(_, v) => setMode(v)} variant="scrollable" scrollButtons="auto">
            <Tab value="adjustment" label="תוספת / ניכוי / שעות" />
            <Tab value="field" label="שדות בטבלת השכר" />
            <Tab value="sick" label="ימי מחלה" />
            <Tab value="vacation" label="ימי חופשה" />
            <Tab value="absence" label="ימי היעדרות" />
            <Tab
              value="punches"
              label={punchProblems > 0 ? `החתמות (${punchProblems})` : 'החתמות'}
              sx={punchProblems > 0 ? { color: 'error.main', fontWeight: 800 } : undefined}
            />
          </Tabs>

          {mode === 'adjustment' && (
            <AdjustmentForm employee={employee} month={month} onDone={done} canDecide={canDecide} />
          )}
          {mode === 'field' && (
            <FieldForm employee={employee} month={month} fields={requestableFields}
              onDone={done} canDecide={canDecide} />
          )}
          {(mode === 'sick' || mode === 'vacation') && (
            <LeaveForm kind={mode} employee={employee} onDone={done} canDecide={canDecide} />
          )}
          {mode === 'absence' && (
            <AbsenceForm employee={employee} month={month} onDone={done} canDecide={canDecide} />
          )}
          {mode === 'punches' && (
            <PunchesForm employee={employee} month={month} initial={punchData} onCounts={setPunchProblems} />
          )}
          {leaveKinds && null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
