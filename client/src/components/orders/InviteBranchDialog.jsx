import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** Pick a branch to order together with. Lists only branches not yet in the group. */
export default function InviteBranchDialog({ open, onClose, orderId, onInvited }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !orderId) return undefined;
    let alive = true;
    setBranchId('');
    api.get(`/orders/${orderId}/invitable-branches`)
      .then(res => { if (alive) setBranches(res.data.branches || []); })
      .catch(() => { if (alive) setBranches([]); });
    return () => { alive = false; };
  }, [open, orderId]);

  const submit = async () => {
    if (!branchId) return toast.error('בחר סניף');
    setBusy(true);
    try {
      const res = await api.post(`/orders/${orderId}/invite`, { branch_id: branchId });
      toast.success('הסניף הוזמן — מנהל/ת הסניף קיבל/ה התראה');
      onInvited?.(res.data.order);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהזמנת סניף');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 700 }}>הזמן סניף להצטרף</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          הסניף יקבל טיוטה משלו עם אותו ספק, יוסיף את הפריטים שלו, וההזמנה תישלח לספק יחד — כל סניף עם המשלוח שלו.
        </Typography>
        {branches.length === 0 ? (
          <Typography variant="body2">אין סניפים נוספים להזמנה</Typography>
        ) : (
          <TextField select fullWidth size="small" label="סניף" value={branchId} onChange={e => setBranchId(e.target.value)}>
            {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !branchId}>הזמן</Button>
      </DialogActions>
    </Dialog>
  );
}
