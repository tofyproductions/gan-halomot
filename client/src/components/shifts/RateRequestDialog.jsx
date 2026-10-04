import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Autocomplete, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** Ask for a rate so an employee of another branch can be placed here. */
export default function RateRequestDialog({ open, onClose, candidates, hostBranchId, initialEmployeeId, onSent }) {
  const [emp, setEmp] = useState(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Reset only when the dialog opens, not when the board reloads underneath it.
    if (open && !wasOpen.current) {
      setEmp((candidates || []).find(c => c._id === initialEmployeeId) || null);
      setRate('');
    }
    wasOpen.current = open;
  }, [open, candidates, initialEmployeeId]);
  const send = async () => {
    setBusy(true);
    try {
      await api.post('/shifts/rate-requests', { employee_id: emp._id, host_branch_id: hostBranchId, proposed_rate: rate ? Number(rate) : null });
      toast.success('הבקשה נשלחה למנהלת סניף הבית');
      onSent();
    } catch (err) { toast.error(err.response?.data?.error || 'שליחה נכשלה'); } finally { setBusy(false); }
  };
  const options = (candidates || []).filter(c => !c.has_rate);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>בקשת תעריף לעובדת מסניף אחר</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">מנהלת סניף הבית מאשרת, ואחריה המשרד קובע את התעריף. אחרי זה אפשר לשבץ אותה.</Alert>
          <Autocomplete options={options} value={emp} getOptionLabel={o => `${o.full_name} — ${o.branch_name}`}
            onChange={(_, v) => setEmp(v)} renderInput={p => <TextField {...p} label="עובדת" />} />
          <TextField type="number" label="תעריף מוצע לשעה (לא חובה)" value={rate} onChange={e => setRate(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!emp || busy} onClick={send}>שליחה</Button>
      </DialogActions>
    </Dialog>
  );
}
