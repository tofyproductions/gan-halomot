import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, TextField, Alert, Chip } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { describe, STATUS_LABEL } from './constraintLabels';

/** Every constraint of the weeks after next — decided early, and finally. */
export default function FutureConstraintsDialog({ open, onClose, branchId, canEdit }) {
  const [list, setList] = useState(null);
  const [reason, setReason] = useState({});
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState({});
  const load = useCallback(() => {
    if (!branchId) return;
    api.get('/shifts/constraints/future', { params: { branch: branchId } }).then(r => setList(r.data.constraints)).catch(() => { setError(true); setList([]); });
  }, [branchId]);
  useEffect(() => { if (open) { setList(null); setError(false); load(); } }, [open, load]);

  const decide = async (c, accept) => {
    if (accept && !window.confirm(`הפעולה סופית: ${c.employee_name} תקבל הודעה שהאילוץ התקבל, ולא יהיה אפשר לשבץ אותה ביום הזה. לאשר?`)) return;
    setBusy(b => ({ ...b, [c._id]: true }));
    try {
      await api.post(`/shifts/constraints/${c._id}/decide`, accept ? { accept: true, confirm_far: true } : { accept: false, reason: reason[c._id] });
      toast.success(accept ? 'האילוץ התקבל' : 'האילוץ נדחה');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [c._id]: false })); }
  };

  const approveBroadcast = async (c) => {
    setBusy(b => ({ ...b, [c._id]: true }));
    try {
      await api.post(`/shifts/constraints/${c._id}/approve-broadcast`, {});
      toast.success('ההצעה נשלחה לכל הסניף');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [c._id]: false })); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>אילוצים עתידיים</DialogTitle>
      <DialogContent>
        {list === null && <Typography>טוען…</Typography>}
        {error && <Alert severity="error">לא הצלחנו לטעון את האילוצים</Alert>}
        {list && list.length === 0 && !error && <Alert severity="info">אין אילוצים פתוחים לשבועות הבאים.</Alert>}
        <Stack spacing={1.5}>
          {(list || []).map(c => (
            <Stack key={c._id} spacing={0.5} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography fontWeight={700}>{c.employee_name} — {describe(c)}</Typography>
                {STATUS_LABEL[c.status] && <Chip size="small" label={STATUS_LABEL[c.status]} />}
              </Stack>
              {c.details && <Typography variant="body2" color="text.secondary">{c.details}</Typography>}
              {canEdit && ['open', 'pending_broadcast'].includes(c.status) && (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
                  {c.status === 'open'
                    ? <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => decide(c, true)}>אישור</Button>
                    : <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => approveBroadcast(c)}>אישור שליחה לכל הסניף</Button>}
                  <TextField size="small" placeholder="סיבת דחייה" value={reason[c._id] || ''} onChange={e => setReason(s => ({ ...s, [c._id]: e.target.value }))} />
                  <Button size="small" color="error" disabled={!!busy[c._id] || !reason[c._id]?.trim()} onClick={() => decide(c, false)}>דחייה</Button>
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
