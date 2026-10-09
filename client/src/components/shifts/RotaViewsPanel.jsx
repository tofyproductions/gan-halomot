import { useState } from 'react';
import { Paper, Stack, Typography, Chip, Tooltip, Button } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * The published rota's read receipts: everyone standing in it, green for
 * whoever opened her my-shifts since the publish, red for whoever has not —
 * and one button that pushes "הסידור פורסם" to exactly the red ones.
 * Repeatable on purpose: a nudge ignored on Thursday may be needed again
 * on Saturday night.
 */
export default function RotaViewsPanel({ week }) {
  const [busy, setBusy] = useState(false);
  if (!week?.published_at) return null;

  const people = new Map();
  for (const e of week.published || []) {
    if (!people.has(String(e.employee_id))) people.set(String(e.employee_id), e.employee_name || 'עובדת');
  }
  if (!people.size) return null;
  const viewedAt = new Map((week.views || []).map(v => [String(v.employee_id), v.at]));
  const viewed = [...people].filter(([id]) => viewedAt.has(id));
  const pending = [...people].filter(([id]) => !viewedAt.has(id));
  const fmtAt = (at) => new Date(at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const remind = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/shifts/weeks/${week._id}/remind-unviewed`);
      toast.success(data.reminded
        ? `נשלחה התראה ל-${data.reminded} עובדות${data.no_user ? ` (${data.no_user} בלי משתמש באפליקציה)` : ''}`
        : 'לאף אחת מהממתינות אין משתמש באפליקציה — אי אפשר לשלוח התראה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'השליחה נכשלה');
    } finally { setBusy(false); }
  };

  return (
    <Paper sx={{ p: 1.5, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: pending.length || viewed.length ? 1 : 0 }}>
        <Typography fontWeight={800}>👁 צפייה בסידור</Typography>
        <Chip size="small" color="success" variant="outlined" label={`צפו: ${viewed.length}`} />
        <Chip size="small" color={pending.length ? 'error' : 'default'}
          variant={pending.length ? 'filled' : 'outlined'} sx={{ fontWeight: 700 }}
          label={pending.length ? `טרם צפו: ${pending.length}` : 'כולן צפו ✓'} />
        {pending.length > 0 && (
          <Button size="small" variant="contained" color="warning" disabled={busy} onClick={remind}>
            📣 שלח תזכורת למי שלא צפתה ({pending.length})
          </Button>
        )}
      </Stack>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {pending.map(([id, name]) => (
          <Chip key={id} size="small" color="error" variant="outlined" sx={{ fontWeight: 700 }} label={name} />
        ))}
        {viewed.map(([id, name]) => (
          <Tooltip key={id} title={`צפתה ב-${fmtAt(viewedAt.get(id))}`}>
            <Chip size="small" color="success" variant="outlined" label={`✓ ${name}`} />
          </Tooltip>
        ))}
      </Stack>
    </Paper>
  );
}
