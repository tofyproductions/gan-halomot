import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Typography, Alert, Box, Divider } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳'];

/** Her current card as the dialog's starting choice. */
function initialChoice(item) {
  if (item.shift_area) return { main: item.shift_area, second: '', days: {} };
  const main = item.primary_classroom_id || item.suggestion || '';
  const map = item.shift_day_classrooms || [];
  const second = map.find(m => m.classroom_id !== item.primary_classroom_id)?.classroom_id || '';
  return { main, second, days: second ? Object.fromEntries(map.map(m => [m.day, m.classroom_id])) : {} };
}

/**
 * Where each employee sits on the rota, saved on her card for good: a class,
 * two classes split by weekday, or the kitchen / floater row. Asked the first
 * time a manager opens the rota (`items` = the pending ones), and editable any
 * time from "כיתות קבועות" (`items` = everyone). Saving also places her
 * "ללא כיתה" shifts in the weeks already opened.
 */
export default function PrimaryClassDialog({ open, onClose, items, classrooms, onDone, manage = false }) {
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setChoice(Object.fromEntries(items.map(p => [p.employee_id, initialChoice(p)])));
  }, [open, items]);
  const nameOf = (id) => classrooms.find(c => c._id === id)?.name || id;
  const set = (id, patch) => setChoice(c => ({ ...c, [id]: { ...c[id], ...patch } }));
  const isClass = (v) => v && v !== 'kitchen' && v !== 'floater';
  // The card as it is now (a suggestion is not saved yet, so it counts as a change).
  const changed = (p) => JSON.stringify(choice[p.employee_id]) !== JSON.stringify(initialChoice({ ...p, suggestion: '' }));

  const save = async () => {
    setSaving(true);
    let placed = 0;
    try {
      for (const p of items) {
        const ch = choice[p.employee_id];
        if (!ch || !ch.main || !changed(p)) continue;
        const body = isClass(ch.main)
          ? { employee_id: p.employee_id, area: 'class', classroom_id: ch.main, second_classroom_id: ch.second || null, day_classrooms: ch.second ? ch.days : {} }
          : { employee_id: p.employee_id, area: ch.main };
        const { data } = await api.post('/shifts/primary-class', body);
        placed += data.placed || 0;
      }
      toast.success(placed ? `נשמר — ${placed} משמרות שובצו בשבועות שכבר נפתחו` : 'נשמר');
      onDone();
    } catch (err) { toast.error(err.response?.data?.error || 'שמירה נכשלה'); } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>{manage ? 'כיתות קבועות לעובדות' : 'כיתה ראשית לעובדות'}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          {manage
            ? 'כך ייפתח כל שבוע חדש. עובדת בשתי כיתות — בחרו כיתה שנייה ואז באיזו כיתה היא בכל יום.'
            : 'לעובדות האלה אין כיתה ראשית. הבחירה נשמרת בכרטיס העובדת.'}
        </Alert>
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          {items.map(p => {
            const ch = choice[p.employee_id] || { main: '', second: '', days: {} };
            const options = p.candidates?.length ? p.candidates : classrooms.map(c => c._id);
            const workDays = Object.keys(p.commitment || {}).map(Number).sort();
            return (
              <Box key={p.employee_id}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                  <Typography sx={{ flex: 1 }}>{p.full_name}{p.commitment_text ? ` (בהתחייבות: ${p.commitment_text})` : ''}</Typography>
                  <TextField select size="small" sx={{ minWidth: 170 }} label="שיבוץ" value={ch.main}
                    onChange={e => set(p.employee_id, { main: e.target.value, second: '', days: {} })}>
                    <MenuItem value="">{manage ? 'לא נקבע' : 'לא עכשיו'}</MenuItem>
                    {options.map(id => <MenuItem key={id} value={id}>{nameOf(id)}</MenuItem>)}
                    <MenuItem value="kitchen">עובדת מטבח</MenuItem>
                    <MenuItem value="floater">מחליפה</MenuItem>
                  </TextField>
                  {isClass(ch.main) && (
                    <TextField select size="small" sx={{ minWidth: 150 }} label="כיתה שנייה" value={ch.second}
                      onChange={e => {
                        const second = e.target.value;
                        set(p.employee_id, { second, days: second ? Object.fromEntries(workDays.map(d => [d, ch.main])) : {} });
                      }}>
                      <MenuItem value="">אין</MenuItem>
                      {classrooms.filter(c => c._id !== ch.main).map(c => <MenuItem key={c._id} value={c._id}>{c.name}</MenuItem>)}
                    </TextField>
                  )}
                </Stack>
                {isClass(ch.main) && ch.second && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
                    {(workDays.length ? workDays : [0, 1, 2, 3, 4, 5]).map(d => (
                      <TextField key={d} select size="small" sx={{ minWidth: 120 }} label={`יום ${DAY_NAMES[d]}`}
                        value={ch.days[d] || ch.main}
                        onChange={e => set(p.employee_id, { days: { ...ch.days, [d]: e.target.value } })}>
                        <MenuItem value={ch.main}>{nameOf(ch.main)}</MenuItem>
                        <MenuItem value={ch.second}>{nameOf(ch.second)}</MenuItem>
                      </TextField>
                    ))}
                  </Stack>
                )}
              </Box>
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{manage ? 'סגירה' : 'אחר כך'}</Button>
        <Button variant="contained" onClick={save} disabled={saving}>שמירה</Button>
      </DialogActions>
    </Dialog>
  );
}
