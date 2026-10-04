import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Typography, Divider, MenuItem } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

export default function ShiftSettingsDialog({ open, onClose, board, onChanged }) {
  const [ratios, setRatios] = useState({ infants: '', young: '', older: '' });
  const [closeId, setCloseId] = useState('');
  const [reopenId, setReopenId] = useState('');
  useEffect(() => { if (open && board) setRatios(board.ratios); }, [open, board]);
  if (!board) return null;
  const branchId = board.branch_id;

  const call = async (fn, ok) => {
    try { await fn(); toast.success(ok); onChanged(); } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>הגדרות סידור</DialogTitle>
      <DialogContent>
        <Typography fontWeight={700} sx={{ mt: 1, mb: 1 }}>יחס חניכה (ילדים לעובדת)</Typography>
        <Stack direction="row" spacing={1}>
          {[['infants', 'תינוקייה'], ['young', 'צעירים'], ['older', 'בוגרים']].map(([k, label]) => (
            <TextField key={k} type="number" label={label} value={ratios[k] ?? ''} size="small"
              onChange={e => setRatios(r => ({ ...r, [k]: e.target.value }))} />
          ))}
        </Stack>
        <Button sx={{ mt: 1 }} disabled={!branchId} onClick={() => call(() => api.put(`/shifts/ratios/${branchId}`, ratios), 'היחסים נשמרו')}>שמירת יחסים</Button>
        <Typography variant="caption" display="block" color="text.secondary">שדה ריק = ברירת המחדל של העיר.</Typography>

        <Divider sx={{ my: 2 }} />
        <Typography fontWeight={700} sx={{ mb: 1 }}>סגירת כיתה שלא קיימת כרגע</Typography>
        <Stack direction="row" spacing={1}>
          <TextField select size="small" fullWidth label="כיתה" value={closeId} onChange={e => setCloseId(e.target.value)}>
            {board.classrooms.map(c => <MenuItem key={c._id} value={c._id}>{c.name} ({c.enrolled} ילדים)</MenuItem>)}
          </TextField>
          <Button color="warning" disabled={!closeId} onClick={() => call(() => api.post(`/shifts/classrooms/${closeId}/close`), 'הכיתה נסגרה')}>סגירה</Button>
        </Stack>
        <Typography fontWeight={700} sx={{ mt: 2, mb: 1 }}>פתיחת כיתה מחדש</Typography>
        <Stack direction="row" spacing={1}>
          <TextField select size="small" fullWidth label="כיתה סגורה" value={reopenId} onChange={e => setReopenId(e.target.value)}>
            {board.inactive_classrooms.map(c => <MenuItem key={c._id} value={c._id}>{c.name} · {c.academic_year}</MenuItem>)}
          </TextField>
          <Button disabled={!reopenId} onClick={() => call(() => api.post(`/shifts/classrooms/${reopenId}/reopen`), 'הכיתה נפתחה')}>פתיחה</Button>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
