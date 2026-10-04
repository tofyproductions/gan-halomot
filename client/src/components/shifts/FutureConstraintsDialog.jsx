import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, TextField, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { describe } from './constraintLabels';

/** Every constraint of the weeks after next — decided early, and finally. */
export default function FutureConstraintsDialog({ open, onClose, branchId, canEdit }) {
  const [list, setList] = useState(null);
  const [reason, setReason] = useState({});
  const load = useCallback(() => {
    if (!branchId) return;
    api.get('/shifts/constraints/future', { params: { branch: branchId } }).then(r => setList(r.data.constraints)).catch(() => setList([]));
  }, [branchId]);
  useEffect(() => { if (open) { setList(null); load(); } }, [open, load]);

  const decide = async (c, accept) => {
    if (accept && !window.confirm(`הפעולה סופית: ${c.employee_name} תקבל הודעה שהאילוץ התקבל, ולא יהיה אפשר לשבץ אותה ביום הזה. לאשר?`)) return;
    try {
      await api.post(`/shifts/constraints/${c._id}/decide`, accept ? { accept: true, confirm_far: true } : { accept: false, reason: reason[c._id] });
      toast.success(accept ? 'האילוץ התקבל' : 'האילוץ נדחה');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>אילוצים עתידיים</DialogTitle>
      <DialogContent>
        {list === null && <Typography>טוען…</Typography>}
        {list && list.length === 0 && <Alert severity="info">אין אילוצים פתוחים לשבועות הבאים.</Alert>}
        <Stack spacing={1.5}>
          {(list || []).map(c => (
            <Stack key={c._id} spacing={0.5} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 1 }}>
              <Typography fontWeight={700}>{c.employee_name} — {describe(c)}</Typography>
              {c.details && <Typography variant="body2" color="text.secondary">{c.details}</Typography>}
              {canEdit && c.status === 'open' && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button size="small" variant="contained" onClick={() => decide(c, true)}>אישור</Button>
                  <TextField size="small" placeholder="סיבת דחייה" value={reason[c._id] || ''} onChange={e => setReason(s => ({ ...s, [c._id]: e.target.value }))} />
                  <Button size="small" color="error" disabled={!reason[c._id]?.trim()} onClick={() => decide(c, false)}>דחייה</Button>
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
