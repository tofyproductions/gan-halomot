import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  MenuItem, Stack, Autocomplete, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

const TYPES = [
  { value: 'day_off', label: 'יום חופש' },
  { value: 'partial', label: 'היעדרות בשעות מסוימות' },
  { value: 'sick_expected', label: 'יום מחלה צפוי' },
  { value: 'other', label: 'אחר' },
];

/**
 * The constraint the manager types in herself — for the employee who called,
 * WhatsApped or said it across the yard because the app defeated her. It
 * lands in the same panel as an app-sent one, marked "נרשם ידנית", and the
 * usual approve button applies it to the board.
 */
export default function ManualConstraintDialog({ open, onClose, onSaved, employees, defaultDate }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({ employee: null, type: 'day_off', date: defaultDate || '', from_hhmm: '', to_hhmm: '', details: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!form) return null;

  const partial = form.type === 'partial';
  const valid = form.employee && form.date && form.details.trim()
    && (!partial || (form.from_hhmm && form.to_hhmm && form.from_hhmm < form.to_hhmm));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/shifts/constraints/manual', {
        employee_id: form.employee._id,
        type: form.type,
        date: form.date,
        details: form.details.trim(),
        ...(partial ? { from_hhmm: form.from_hhmm, to_hhmm: form.to_hhmm } : {}),
      });
      toast.success('האילוץ נרשם — אפשר לאשר אותו בפאנל האילוצים ואז הוא יחול על הלוח');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הרישום נכשל');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>אילוץ ידני</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            לעובדת שלא הצליחה לשלוח מהאפליקציה. האילוץ יופיע בפאנל כרגיל, מסומן
            "נרשם ידנית", ויחול על הלוח אחרי אישור.
          </Typography>
          <Autocomplete
            options={employees}
            value={form.employee}
            getOptionLabel={(o) => o.full_name}
            onChange={(_, v) => setForm(f => ({ ...f, employee: v }))}
            renderInput={(p) => <TextField {...p} label="עובדת" />}
          />
          <TextField select label="סוג אילוץ" value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          <TextField label="תאריך" type="date" value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            InputLabelProps={{ shrink: true }} />
          {partial && (
            <Stack direction="row" spacing={1}>
              <TextField label="לא זמינה משעה" type="time" value={form.from_hhmm}
                onChange={e => setForm(f => ({ ...f, from_hhmm: e.target.value }))}
                InputLabelProps={{ shrink: true }} fullWidth />
              <TextField label="עד שעה" type="time" value={form.to_hhmm}
                onChange={e => setForm(f => ({ ...f, to_hhmm: e.target.value }))}
                InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
          )}
          <TextField label="סיבה / פירוט" value={form.details} multiline minRows={2}
            onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
            placeholder="למשל: הודיעה בטלפון — תור לרופא" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!valid || busy} onClick={save}>רישום האילוץ</Button>
      </DialogActions>
    </Dialog>
  );
}
