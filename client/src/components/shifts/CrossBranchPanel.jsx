import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { fmtDate } from './shiftRows';

const WEEKDAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** What waits for this manager across branches: placements of her people, permanent arrangements, rate requests. */
export default function CrossBranchPanel({ board, onChanged }) {
  const [reason, setReason] = useState({});
  const [rate, setRate] = useState({});
  const [busy, setBusy] = useState({});
  const pending = board.cross_pending || [];
  const arrangements = board.arrangements || [];
  const requests = (board.rate_requests || []).filter(r => r.can_decide);
  if (!pending.length && !arrangements.length && !requests.length) return null;

  const post = async (key, url, body, ok) => {
    setBusy(b => ({ ...b, [key]: true }));
    try { await api.post(url, body); toast.success(ok); onChanged(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {pending.map(p => (
        <Alert key={p._id} severity="info" icon={false}>
          <Typography fontWeight={700}>{p.employee_name} שובצה ב{p.branch_name} — {fmtDate(p.date)} <span dir="ltr">{p.start_hhmm}–{p.end_hhmm}</span></Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Button size="small" variant="contained" disabled={!!busy[p._id]} onClick={() => post(p._id, `/shifts/weeks/${p.week_id}/cross/${p._id}/decide`, { approve: true }, 'השיבוץ אושר')}>אישור</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[p._id] || ''} onChange={e => setReason(s => ({ ...s, [p._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[p._id] || !reason[p._id]?.trim()} onClick={() => post(p._id, `/shifts/weeks/${p.week_id}/cross/${p._id}/decide`, { approve: false, reason: reason[p._id] }, 'השיבוץ נדחה')}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
      {arrangements.map(a => (
        <Alert key={a._id} severity={a.status === 'active' ? 'success' : 'warning'} icon={false}>
          <Typography fontWeight={700}>
            {a.status === 'active' ? 'סידור קבוע' : 'סידור קבוע?'}: {a.employee_name} ב{a.host_branch_name} — כל יום {WEEKDAY[a.weekday]} <span dir="ltr">{a.start_hhmm}–{a.end_hhmm}</span>
          </Typography>
          {a.status === 'proposed' && <Typography variant="body2">{a.host_confirmed ? 'הסניף המארח אישר. ' : ''}{a.home_confirmed ? 'סניף הבית אישר.' : ''}</Typography>}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            {a.can_confirm && <Button size="small" variant="contained" disabled={!!busy[a._id]} onClick={() => post(a._id, `/shifts/arrangements/${a._id}/confirm`, {}, 'אישרת')}>אישור כסידור קבוע</Button>}
            {a.can_cancel && <Button size="small" color="inherit" disabled={!!busy[a._id]} onClick={() => post(a._id, `/shifts/arrangements/${a._id}/cancel`, {}, 'הסידור הקבוע בוטל')}>ביטול</Button>}
          </Stack>
        </Alert>
      ))}
      {requests.map(r => (
        <Alert key={r._id} severity="warning" icon={false}>
          <Typography fontWeight={700}>תעריף ל{r.employee_name} ({r.home_branch_name}) לעבודה ב{r.host_branch_name}{r.proposed_rate ? ` — הוצע ${r.proposed_rate} ₪ לשעה` : ''}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
            {r.status === 'pending_office' && <TextField size="small" type="number" label="תעריף לשעה" value={rate[r._id] ?? (r.proposed_rate || '')} onChange={e => setRate(s => ({ ...s, [r._id]: e.target.value }))} />}
            <Button size="small" variant="contained" disabled={!!busy[r._id]} onClick={() => post(r._id, `/shifts/rate-requests/${r._id}/decide`, { approve: true, final_rate: rate[r._id] ? Number(rate[r._id]) : undefined }, r.status === 'pending_office' ? 'התעריף נקבע' : 'אישרת — הבקשה עברה למשרד')}>אישור</Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[r._id] || ''} onChange={e => setReason(s => ({ ...s, [r._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[r._id] || !reason[r._id]?.trim()} onClick={() => post(r._id, `/shifts/rate-requests/${r._id}/decide`, { approve: false, reason: reason[r._id] }, 'הבקשה נדחתה')}>דחייה</Button>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
