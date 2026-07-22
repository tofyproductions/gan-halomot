import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip, Checkbox,
  Autocomplete, Tabs, Tab, Paper, Switch, FormControlLabel,
} from '@mui/material';
import ScheduleIcon from '@mui/icons-material/Schedule';
import DeleteIcon from '@mui/icons-material/Delete';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';

const WEEKDAYS = [
  { value: 0, label: 'ראשון' },
  { value: 1, label: 'שני' },
  { value: 2, label: 'שלישי' },
  { value: 3, label: 'רביעי' },
  { value: 4, label: 'חמישי' },
  { value: 5, label: 'שישי' },
  { value: 6, label: 'שבת' },
];
const dayLabel = (w) => WEEKDAYS.find(d => d.value === w)?.label || '';

const hoursOf = (a, b) => {
  if (!a || !b) return 0;
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.max(0, ((bh * 60 + bm) - (ah * 60 + am)) / 60);
};

/**
 * שעות קבועות — employees paid on a standing weekly schedule instead of
 * clocking in.
 *
 * Tab 1 assigns one weekly pattern to any number of employees at once. Tab 2
 * lists who is on a fixed schedule and lets a single arbitrary day be changed
 * (different hours) or cancelled (didn't work) — the exception always beats the
 * weekly pattern. Days are generated up to today only, never in advance.
 */
export default function FixedSchedulesDialog({ open, onClose, onChanged }) {
  const confirm = useConfirm();
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [employees, setEmployees] = useState([]);

  // Tab 1 — assign
  const [selected, setSelected] = useState([]);
  const [days, setDays] = useState([]); // [{weekday, in, out}]
  const [startDate, setStartDate] = useState('');
  const [note, setNote] = useState('');

  // Tab 2 — exceptions
  const [exFor, setExFor] = useState(null); // employee row
  const [exDraft, setExDraft] = useState({ date: '', off: false, in: '', out: '', note: '' });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll/fixed-schedules')
      .then(r => setEmployees(r.data.employees || []))
      .catch(() => setEmployees([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected([]); setDays([]); setStartDate(''); setNote(''); setExFor(null);
    load();
  }, [open, load]);

  const onFixed = employees.filter(e => e.fixed_schedule);
  const candidates = employees;

  const toggleDay = (weekday) => {
    setDays(prev => prev.some(d => d.weekday === weekday)
      ? prev.filter(d => d.weekday !== weekday)
      : [...prev, { weekday, in: '08:00', out: '16:00' }].sort((a, b) => a.weekday - b.weekday));
  };
  const setDayTime = (weekday, field, value) =>
    setDays(prev => prev.map(d => (d.weekday === weekday ? { ...d, [field]: value } : d)));

  // Prefill the weekly pattern from an employee who already has one, so an
  // existing arrangement can be copied to others instead of retyped.
  const copyFrom = (emp) => {
    if (!emp?.fixed_schedule) return;
    setDays(emp.fixed_schedule.days.map(d => ({ weekday: d.weekday, in: d.in, out: d.out })));
    setStartDate(emp.fixed_schedule.start_date || '');
    setNote(emp.fixed_schedule.note || '');
    setTab(0);
    toast.info(`השעות של ${emp.full_name} הועתקו לטופס`);
  };

  const weeklyHours = days.reduce((s, d) => s + hoursOf(d.in, d.out), 0);

  const save = () => {
    if (selected.length === 0) return toast.error('בחר/י עובדים');
    if (days.length === 0) return toast.error('הגדר/י לפחות יום אחד');
    for (const d of days) {
      if (!d.in || !d.out) return toast.error(`חסרות שעות ביום ${dayLabel(d.weekday)}`);
      if (d.out <= d.in) return toast.error(`ביום ${dayLabel(d.weekday)} שעת היציאה חייבת להיות אחרי הכניסה`);
    }
    setSaving(true);
    api.put('/payroll/fixed-schedules', {
      employee_ids: selected.map(e => e.id),
      schedule: { days, start_date: startDate || null, note },
    })
      .then(r => {
        toast.success(`נשמר ל-${r.data.updated} עובדים · נוצרו ${r.data.punches_created} החתמות`);
        if (r.data.conflicts?.length) {
          toast.warning(`${r.data.conflicts.length} ימים שבהם יש גם החתמה בשעון — ממתינים להכרעה במסך "בעיות בהחתמה"`);
        }
        setSelected([]);
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const clearFor = async (emp) => {
    if (!(await confirm({
      title: 'ביטול שעות קבועות',
      message: `להפסיק לייצר החתמות קבועות עבור ${emp.full_name}? ההחתמות שכבר נוצרו יישארו.`,
      danger: true,
    }))) return;
    api.delete(`/payroll/fixed-schedules/${emp.id}`)
      .then(() => { toast.success('בוטל'); load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const saveException = () => {
    if (!exFor) return;
    if (!exDraft.date) return toast.error('בחר/י תאריך');
    if (!exDraft.off && (!exDraft.in || !exDraft.out)) return toast.error('הזן/י שעות, או סמן/י "לא עבדה"');
    setSaving(true);
    api.post(`/payroll/fixed-schedules/${exFor.id}/exception`, exDraft)
      .then(() => {
        toast.success('החריג נשמר וההחתמות עודכנו');
        setExDraft({ date: '', off: false, in: '', out: '', note: '' });
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const removeException = (emp, date) => {
    api.delete(`/payroll/fixed-schedules/${emp.id}/exception/${date}`)
      .then(() => { toast.success('החריג הוסר'); load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 700 }}>
        <ScheduleIcon color="primary" /> שעות קבועות — עובדים ללא החתמה
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          לעובדים שמוגדרים כאן המערכת מזינה החתמות אוטומטית לפי השעות הקבועות — <b>עד היום בלבד</b>, כך שדוח
          השעות תמיד משקף עבודה שכבר בוצעה. ניתן לשנות יום בודד בלשונית "חריגים", ואם העובדת בכל זאת החתימה
          בשעון — אותו יום עולה כהתנגשות במסך "בעיות בהחתמה" ולא נוצרות לו שעות קבועות.
        </Alert>

        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="הגדרת שעות לעובדים" />
          <Tab label={`עובדים עם שעות קבועות (${onFixed.length})`} />
        </Tabs>

        {loading && <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress /></Box>}

        {!loading && tab === 0 && (
          <Stack spacing={2}>
            <Autocomplete
              multiple
              options={candidates}
              value={selected}
              onChange={(_e, v) => setSelected(v)}
              getOptionLabel={(o) => `${o.full_name}${o.branch_name ? ` · ${o.branch_name}` : ''}`}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderOption={(props, option, { selected: sel }) => (
                <li {...props} key={option.id}>
                  <Checkbox size="small" checked={sel} sx={{ mr: 1 }} />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{option.full_name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {option.branch_name}{option.position ? ` · ${option.position}` : ''}
                    </Typography>
                  </Box>
                  {option.fixed_schedule && <Chip size="small" color="primary" label="כבר מוגדר" />}
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} label="בחר/י עובדים" placeholder="חיפוש לפי שם…" />
              )}
            />

            <Divider>ימי העבודה והשעות</Divider>
            <Stack spacing={1}>
              {WEEKDAYS.map(w => {
                const day = days.find(d => d.weekday === w.value);
                return (
                  <Stack key={w.value} direction="row" spacing={1} alignItems="center">
                    <FormControlLabel
                      sx={{ width: 110, m: 0 }}
                      control={<Checkbox size="small" checked={!!day} onChange={() => toggleDay(w.value)} />}
                      label={<Typography variant="body2" sx={{ fontWeight: day ? 700 : 400 }}>{w.label}</Typography>}
                    />
                    <TextField size="small" type="time" label="כניסה" InputLabelProps={{ shrink: true }}
                      disabled={!day} value={day?.in || ''} sx={{ width: 130 }}
                      onChange={e => setDayTime(w.value, 'in', e.target.value)} />
                    <TextField size="small" type="time" label="יציאה" InputLabelProps={{ shrink: true }}
                      disabled={!day} value={day?.out || ''} sx={{ width: 130 }}
                      onChange={e => setDayTime(w.value, 'out', e.target.value)} />
                    {day && (
                      <Typography variant="caption" color="text.secondary">
                        {hoursOf(day.in, day.out).toFixed(2)} שעות
                      </Typography>
                    )}
                  </Stack>
                );
              })}
            </Stack>
            {days.length > 0 && (
              <Alert severity="success" icon={false} sx={{ py: 0.5 }}>
                סה״כ שבועי: <b>{weeklyHours.toFixed(2)} שעות</b> · {days.length} ימים
              </Alert>
            )}

            <Stack direction="row" spacing={1}>
              <TextField size="small" type="date" label="החל מתאריך (אופציונלי)" InputLabelProps={{ shrink: true }}
                value={startDate} onChange={e => setStartDate(e.target.value)} sx={{ width: 200 }}
                helperText="לא ייווצרו החתמות לפני תאריך זה" />
              <TextField size="small" label="הערה" value={note} onChange={e => setNote(e.target.value)} fullWidth />
            </Stack>
          </Stack>
        )}

        {!loading && tab === 1 && (
          onFixed.length === 0 ? (
            <Alert severity="info">אין עדיין עובדים עם שעות קבועות. הגדר/י בלשונית הראשונה.</Alert>
          ) : (
            <Stack spacing={1.5}>
              {onFixed.map(emp => (
                <Paper key={emp.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    <Typography sx={{ fontWeight: 800 }}>{emp.full_name}</Typography>
                    {emp.branch_name && <Chip size="small" variant="outlined" label={emp.branch_name} />}
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" onClick={() => copyFrom(emp)}>העתק שעות</Button>
                    <Button size="small" onClick={() => { setExFor(emp); setExDraft({ date: '', off: false, in: '', out: '', note: '' }); }}
                      startIcon={<EventBusyIcon />}>חריג ליום</Button>
                    <Tooltip title="בטל שעות קבועות">
                      <IconButton size="small" color="error" onClick={() => clearFor(emp)}><DeleteIcon fontSize="small" /></IconButton>
                    </Tooltip>
                  </Stack>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    {emp.fixed_schedule.days.map(d => (
                      <Chip key={d.weekday} size="small" label={`${dayLabel(d.weekday)} ${d.in}–${d.out}`}
                        sx={{ fontSize: '0.68rem' }} />
                    ))}
                    {emp.fixed_schedule.start_date && (
                      <Chip size="small" variant="outlined" color="info" label={`מ-${emp.fixed_schedule.start_date}`} sx={{ fontSize: '0.68rem' }} />
                    )}
                  </Stack>
                  {emp.fixed_schedule.note && (
                    <Typography variant="caption" color="text.secondary">{emp.fixed_schedule.note}</Typography>
                  )}

                  {emp.fixed_schedule.exceptions?.length > 0 && (
                    <>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="caption" sx={{ fontWeight: 700 }}>חריגים ({emp.fixed_schedule.exceptions.length})</Typography>
                      <Table size="small">
                        <TableBody>
                          {[...emp.fixed_schedule.exceptions].sort((a, b) => b.date.localeCompare(a.date)).map(ex => (
                            <TableRow key={ex.date}>
                              <TableCell sx={{ py: 0.2, width: 110 }}>{ex.date}</TableCell>
                              <TableCell sx={{ py: 0.2 }}>
                                {ex.off
                                  ? <Chip size="small" color="error" variant="outlined" label="לא עבדה" />
                                  : <Chip size="small" color="primary" variant="outlined" label={`${ex.in}–${ex.out}`} />}
                              </TableCell>
                              <TableCell sx={{ py: 0.2, fontSize: '0.7rem', color: 'text.secondary' }}>{ex.note || ''}</TableCell>
                              <TableCell sx={{ py: 0.2, width: 40 }} align="center">
                                <IconButton size="small" onClick={() => removeException(emp, ex.date)}>
                                  <DeleteIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}

                  {exFor?.id === emp.id && (
                    <Paper variant="outlined" sx={{ p: 1.2, mt: 1, borderRadius: 2, bgcolor: '#fffbeb', borderColor: '#fde68a' }}>
                      <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.8 }}>
                        שינוי יום בודד — גובר על השעות הקבועות
                      </Typography>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <TextField size="small" type="date" label="תאריך" InputLabelProps={{ shrink: true }}
                          value={exDraft.date} onChange={e => setExDraft(d => ({ ...d, date: e.target.value }))} sx={{ width: 160 }} />
                        <FormControlLabel
                          control={<Switch size="small" checked={exDraft.off}
                            onChange={e => setExDraft(d => ({ ...d, off: e.target.checked }))} />}
                          label={<Typography variant="body2">לא עבדה</Typography>}
                        />
                        <TextField size="small" type="time" label="כניסה" InputLabelProps={{ shrink: true }}
                          disabled={exDraft.off} value={exDraft.in} sx={{ width: 125 }}
                          onChange={e => setExDraft(d => ({ ...d, in: e.target.value }))} />
                        <TextField size="small" type="time" label="יציאה" InputLabelProps={{ shrink: true }}
                          disabled={exDraft.off} value={exDraft.out} sx={{ width: 125 }}
                          onChange={e => setExDraft(d => ({ ...d, out: e.target.value }))} />
                        <TextField size="small" label="סיבה" value={exDraft.note} sx={{ flex: 1, minWidth: 120 }}
                          onChange={e => setExDraft(d => ({ ...d, note: e.target.value }))} />
                        <BusyButton size="small" variant="contained" loading={saving} onClick={saveException}>שמור חריג</BusyButton>
                        <Button size="small" onClick={() => setExFor(null)}>סגור</Button>
                      </Stack>
                    </Paper>
                  )}
                </Paper>
              ))}
            </Stack>
          )
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={load} disabled={loading}>רענן</Button>
        <Button onClick={onClose}>סגור</Button>
        {tab === 0 && (
          <BusyButton variant="contained" loading={saving} loadingText="שומר ומייצר החתמות…"
            onClick={save} disabled={selected.length === 0 || days.length === 0}>
            שמור ל-{selected.length} עובדים
          </BusyButton>
        )}
      </DialogActions>
    </Dialog>
  );
}
