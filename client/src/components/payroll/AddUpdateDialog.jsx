import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  TextField, MenuItem, Alert, Tabs, Tab, InputAdornment, Chip, Box, Divider,
  Table, TableHead, TableBody, TableRow, TableCell, CircularProgress, Tooltip, IconButton,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
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
      case 'number_note': {
        const n = Number(amount);
        if (!amount || Number.isNaN(n)) { toast.error('יש להזין סכום'); return undefined; }
        return n;
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
      note: input === 'number_note' ? note : '',
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

      {input === 'number_note' && (
        <>
          <TextField
            type="number" size="small" label={def?.label} value={amount} fullWidth
            onChange={e => setAmount(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
            helperText="שדה מספרי שנכנס ישירות לחישוב — הסבר חופשי בשדה שמתחת"
          />
          <TextField size="small" label="הערה (אופציונלי)" value={note} fullWidth
            onChange={e => setNote(e.target.value)} multiline minRows={2} />
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

  useEffect(() => { if (open) setMode('adjustment'); }, [open]);
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
          {leaveKinds && null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
