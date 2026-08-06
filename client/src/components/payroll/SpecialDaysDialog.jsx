import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  MenuItem, Typography, Alert, Paper, Chip, IconButton, Switch, FormControlLabel,
  LinearProgress, Divider, Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import CelebrationIcon from '@mui/icons-material/Celebration';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * ימים מיוחדים — a day the gan shut by the employer's decision (מסיבת סיום,
 * יום צוות) rather than by the calendar.
 *
 * The two switches are separate on purpose. Left alone, a global employee is
 * actively DEDUCTED a daily rate for the missed committed day, while an hourly
 * employee simply isn't paid. So "pay the globals" is the correction of a wrong
 * deduction and defaults on; "pay the hourly staff" is a decision to grant
 * money and defaults off.
 */
export default function SpecialDaysDialog({ open, month, branches = [], onClose, onChanged }) {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', date: '', branch_id: '', pay_global: true, pay_hourly: false, hourly_hours: '', note: '',
  });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll-month/special-days', { params: month ? { month } : {} })
      .then(r => setDays(r.data.special_days || []))
      .catch(() => toast.error('שגיאה בטעינת ימים מיוחדים'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => {
    if (!open) return;
    setForm(f => ({ ...f, date: `${month}-01`, name: '', note: '' }));
    load();
  }, [open, month, load]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const create = async () => {
    setBusy(true);
    try {
      await api.post('/payroll-month/special-days', {
        ...form,
        branch_id: form.branch_id || null,
        hourly_hours: form.hourly_hours === '' ? 0 : Number(form.hourly_hours),
      });
      toast.success('היום נוסף');
      setForm(f => ({ ...f, name: '', note: '' }));
      load(); onChanged && onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setBusy(false); }
  };

  const patch = async (id, body) => {
    try {
      await api.patch(`/payroll-month/special-days/${id}`, body);
      load(); onChanged && onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/payroll-month/special-days/${id}`);
      toast.success('נמחק');
      load(); onChanged && onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        <CelebrationIcon sx={{ color: '#7c3aed' }} /> ימים מיוחדים — {month}
      </DialogTitle>
      <DialogContent dividers>
        {(loading || busy) && <LinearProgress sx={{ mb: 1 }} />}

        <Alert severity="info" sx={{ mb: 2 }}>
          יום שהגן לא פעל בו בגלל החלטה שלכם — מסיבת סיום, יום צוות, סגירה חד-פעמית.
          <br />
          <b>עובדות גלובליות (תקן):</b> בלי סימון היום נקרא כהיעדרות ו<b>יורד להן משכר</b> —
          סימון "תשלום לגלובליות" מבטל את הניכוי והן מקבלות את היום כרגיל.
          <br />
          <b>עובדות שעתיות:</b> הן פשוט לא מקבלות שכר על יום שלא עבדו — סימון "תשלום לשעתיות"
          מזכה אותן ביום לפי התעריף שלהן. <b>אין ירידה מצבירת ימי החופשה</b> באף מקרה.
        </Alert>

        {/* New */}
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, mb: 2 }}>
          <Typography sx={{ fontWeight: 800, mb: 1.5 }}>הוספת יום</Typography>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField size="small" label="שם היום" fullWidth value={form.name}
                onChange={e => set('name', e.target.value)} placeholder="מסיבת סיום" />
              <TextField size="small" type="date" label="תאריך" InputLabelProps={{ shrink: true }}
                sx={{ minWidth: 165 }} value={form.date} onChange={e => set('date', e.target.value)} />
              <TextField select size="small" label="סניף" sx={{ minWidth: 190 }}
                value={form.branch_id} onChange={e => set('branch_id', e.target.value)}>
                <MenuItem value="">כל הסניפים</MenuItem>
                {branches.map(b => <MenuItem key={b.id || b._id} value={b.id || b._id}>{b.name}</MenuItem>)}
              </TextField>
            </Stack>
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <FormControlLabel
                control={<Switch checked={form.pay_global} onChange={e => set('pay_global', e.target.checked)} />}
                label="תשלום לגלובליות (תקן)"
              />
              <FormControlLabel
                control={<Switch checked={form.pay_hourly} onChange={e => set('pay_hourly', e.target.checked)} />}
                label="תשלום לשעתיות"
              />
              {form.pay_hourly && (
                <Tooltip arrow title="ריק = לפי ממוצע יום העבודה של כל עובדת החודש — הוגן יותר לחלקיות משרה מאשר 8 שעות אחידות">
                  <TextField size="small" type="number" label="שעות לזיכוי" sx={{ width: 150 }}
                    value={form.hourly_hours} onChange={e => set('hourly_hours', e.target.value)}
                    placeholder="ממוצע יום" />
                </Tooltip>
              )}
            </Stack>
            <TextField size="small" label="הערה (רשות)" value={form.note} onChange={e => set('note', e.target.value)} />
            <Button variant="contained" onClick={create}
              disabled={busy || !form.name.trim() || !form.date}>הוסף יום</Button>
          </Stack>
        </Paper>

        <Divider sx={{ mb: 2 }} />
        <Typography sx={{ fontWeight: 800, mb: 1 }}>ימים מוגדרים</Typography>
        {days.length === 0 ? (
          <Typography variant="body2" color="text.secondary">לא הוגדרו ימים מיוחדים בחודש זה.</Typography>
        ) : (
          <Stack spacing={1}>
            {days.map(d => (
              <Paper key={d.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#faf5ff', borderColor: '#e9d5ff' }}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                  <Typography sx={{ fontWeight: 800 }}>{d.name}</Typography>
                  <Chip size="small" color="secondary" label={d.date} />
                  <Chip size="small" variant="outlined" label={d.branch_name} />
                  <FormControlLabel
                    sx={{ ml: 1 }}
                    control={<Switch size="small" checked={!!d.pay_global}
                      onChange={e => patch(d.id, { pay_global: e.target.checked })} />}
                    label={<Typography variant="caption">גלובליות</Typography>}
                  />
                  <FormControlLabel
                    control={<Switch size="small" checked={!!d.pay_hourly}
                      onChange={e => patch(d.id, { pay_hourly: e.target.checked })} />}
                    label={<Typography variant="caption">שעתיות{d.pay_hourly ? ` (${d.hourly_hours || 'ממוצע'} ש׳)` : ''}</Typography>}
                  />
                  <div style={{ flex: 1 }} />
                  <IconButton size="small" color="error" onClick={() => remove(d.id)}><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
                {d.note && <Typography variant="caption" color="text.secondary">{d.note}</Typography>}
              </Paper>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
