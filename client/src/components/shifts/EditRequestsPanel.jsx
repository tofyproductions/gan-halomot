import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/** The office's pending proposals for this week, for the branch manager to approve or refuse with a reason. */
export default function EditRequestsPanel({ requests, onDecided }) {
  const [reason, setReason] = useState({});
  const [busy, setBusy] = useState({});
  if (!requests?.length) return null;
  const decide = async (id, approve) => {
    setBusy(b => ({ ...b, [id]: true }));
    try {
      await api.post(`/shifts/edit-requests/${id}/decide`, { approve, reason: reason[id] || '' });
      toast.success(approve ? 'השינוי אושר והוחל' : 'הבקשה נדחתה');
      onDecided();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [id]: false })); }
  };
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {requests.map(r => (
        <Alert key={r._id} severity="warning">
          <Typography fontWeight={700}>{r.requested_by_name || 'המשרד'} מבקש/ת לשנות את הסידור ({r.entries.length} שיבוצים)</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Button size="small" variant="contained" disabled={!!busy[r._id]} onClick={() => decide(r._id, true)}>אישור והחלה</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[r._id] || ''} onChange={e => setReason(s => ({ ...s, [r._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[r._id] || !reason[r._id]?.trim()} onClick={() => decide(r._id, false)}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
