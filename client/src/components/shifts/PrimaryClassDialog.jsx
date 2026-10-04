import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Typography, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Most employee cards have no primary class. The rota needs one, so the first
 * time a manager opens it she is asked — with a guess read from the
 * commitment's free text — and the answer is saved on the card for good.
 */
export default function PrimaryClassDialog({ open, onClose, pending, classrooms, onDone }) {
  const [choice, setChoice] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setChoice(Object.fromEntries(pending.map(p => [p.employee_id, p.suggestion || ''])));
  }, [open, pending]);
  const nameOf = (id) => classrooms.find(c => c._id === id)?.name || id;

  const save = async () => {
    setSaving(true);
    try {
      for (const p of pending) {
        if (!choice[p.employee_id]) continue;
        await api.post('/shifts/primary-class', { employee_id: p.employee_id, classroom_id: choice[p.employee_id] });
      }
      toast.success('הכיתות הראשיות נשמרו');
      onDone();
    } catch (err) { toast.error(err.response?.data?.error || 'שמירה נכשלה'); } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>כיתה ראשית לעובדות</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>לעובדות האלה אין כיתה ראשית. הבחירה נשמרת בכרטיס העובדת.</Alert>
        <Stack spacing={2}>
          {pending.map(p => (
            <Stack key={p.employee_id} direction="row" spacing={2} alignItems="center">
              <Typography sx={{ flex: 1 }}>{p.full_name}{p.commitment_text ? ` (בהתחייבות: ${p.commitment_text})` : ''}</Typography>
              <TextField select size="small" sx={{ minWidth: 180 }} label="כיתה" value={choice[p.employee_id] || ''}
                onChange={e => setChoice(c => ({ ...c, [p.employee_id]: e.target.value }))}>
                <MenuItem value="">לא עכשיו</MenuItem>
                {(p.candidates.length ? p.candidates : classrooms.map(c => c._id)).map(id => <MenuItem key={id} value={id}>{nameOf(id)}</MenuItem>)}
              </TextField>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>אחר כך</Button>
        <Button variant="contained" onClick={save} disabled={saving}>שמירה</Button>
      </DialogActions>
    </Dialog>
  );
}
