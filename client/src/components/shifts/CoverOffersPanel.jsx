import { useState } from 'react';
import { Alert, Stack, Typography, Button, TextField } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { HEB_DAYS, fmtDate } from './shiftRows';

const weekdayOf = (ymd) => new Date(`${ymd}T12:00`).getDay();
const WIN = { am: 'בוקר ☀️', pm: 'צהריים 🌙' };

/** Employees who raised a hand for an open gap — approve places her, through
 *  the same validated save as any placement. */
export default function CoverOffersPanel({ offers, onChanged }) {
  const [reason, setReason] = useState({});
  const [busy, setBusy] = useState({});
  if (!offers?.length) return null;

  const decide = async (o, approve) => {
    setBusy(b => ({ ...b, [o._id]: true }));
    try {
      await api.post(`/shifts/cover-offers/${o._id}/decide`, { approve, reason: reason[o._id] });
      toast.success(approve ? `${o.employee_name} שובצה — היא קיבלה הודעה` : 'ההצעה נדחתה והעובדת עודכנה');
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפעולה נכשלה');
    } finally { setBusy(b => ({ ...b, [o._id]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {offers.map(o => (
        <Alert key={o._id} severity="info" icon="🙋">
          <Typography fontWeight={700}>
            {o.employee_name}{o.foreign ? ` (${o.home_branch_name || 'סניף אחר'})` : ''} מציעה את עצמה: {o.classroom_name} · {HEB_DAYS[weekdayOf(o.date)]} {fmtDate(o.date)} · {WIN[o.window]}
          </Typography>
          {o.bonus && (
            <Typography variant="body2" sx={{ color: '#92400E', fontWeight: 700 }}>
              🎁 כולל בונוס ₪{o.bonus} — עם האישור יוגש אוטומטית כתוספת שכר לאישור הנהלת חשבונות
            </Typography>
          )}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
            <Button size="small" variant="contained" disabled={!!busy[o._id]} onClick={() => decide(o, true)}>
              אישור ושיבוץ
            </Button>
            <TextField size="small" placeholder="סיבת דחייה" value={reason[o._id] || ''}
              onChange={e => setReason(s => ({ ...s, [o._id]: e.target.value }))} />
            <Button size="small" color="error" disabled={!!busy[o._id] || !reason[o._id]?.trim()}
              onClick={() => decide(o, false)}>
              דחייה
            </Button>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
