import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack, Autocomplete, Alert } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** Set up a rate so an employee of another branch can be placed here. */
export default function RateRequestDialog({ open, onClose, candidates, hostBranchId, initialEmployeeId, onSent }) {
  const [emp, setEmp] = useState(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Reset only when the dialog opens, not when the board reloads underneath it.
    if (open && !wasOpen.current) {
      const initial = (candidates || []).find(c => c._id === initialEmployeeId) || null;
      setEmp(initial);
      setRate(initial?.home_hourly_rate ? String(initial.home_hourly_rate) : '');
    }
    wasOpen.current = open;
  }, [open, candidates, initialEmployeeId]);
  // Her regular rate is the default: picking a worker fills it in, and
  // leaving it untouched means "same pay here" — effective immediately.
  const pick = (v) => {
    setEmp(v);
    setRate(v?.home_hourly_rate ? String(v.home_hourly_rate) : '');
  };
  const changed = emp?.home_hourly_rate && rate && Number(rate) !== emp.home_hourly_rate;
  const send = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/shifts/rate-requests', { employee_id: emp._id, host_branch_id: hostBranchId, proposed_rate: rate ? Number(rate) : null });
      const status = data?.request?.status || data?.status;
      toast.success(status === 'approved'
        ? 'התעריף הרגיל שלה הועתק לסניף — אפשר לשבץ אותה מיד'
        : 'נשלחה בקשה לאישור הנהלת חשבונות — התעריף ייכנס לתוקף אחרי אישור');
      onSent();
    } catch (err) { toast.error(err.response?.data?.error || 'שליחה נכשלה'); } finally { setBusy(false); }
  };
  const options = (candidates || []).filter(c => !c.has_rate);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>תעריף לעובדת מסניף אחר</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">
            מוצג התעריף הרגיל של העובדת. השארת התעריף כמו שהוא — נכנס לתוקף מיד.
            שינוי התעריף — נשלח לאישור הנהלת חשבונות, והתעריף החדש ייכנס לתוקף רק אחרי האישור.
          </Alert>
          <Autocomplete options={options} value={emp} getOptionLabel={o => `${o.full_name} — ${o.branch_name}`}
            onChange={(_, v) => pick(v)} renderInput={p => <TextField {...p} label="עובדת" />} />
          <TextField type="number" label="תעריף לשעה" value={rate} onChange={e => setRate(e.target.value)}
            helperText={emp?.home_hourly_rate
              ? (changed ? `שונה מהתעריף הרגיל שלה (${emp.home_hourly_rate} ₪) — יישלח לאישור הנהלת חשבונות` : `התעריף הרגיל שלה: ${emp.home_hourly_rate} ₪`)
              : emp ? 'לעובדת אין תעריף שעתי רגיל — הנהלת חשבונות תקבע' : ''} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!emp || busy} onClick={send}>
          {changed || !emp?.home_hourly_rate ? 'שליחה לאישור' : 'אישור התעריף הרגיל'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
