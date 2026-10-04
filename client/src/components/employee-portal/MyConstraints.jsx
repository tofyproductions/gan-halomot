import { useCallback, useEffect, useState } from 'react';
import { Box, Stack, Typography, Button, Chip, Card, CardContent, Alert, LinearProgress, Link } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ConstraintForm from './ConstraintForm';
import { STATUS_LABEL, STATUS_COLOR, describe, openConstraintFile } from '../shifts/constraintLabels';
import { fmtDate } from '../shifts/shiftRows';

const CANCELLABLE = new Set(['pending_colleague', 'pending_broadcast', 'broadcast', 'open', 'accepted']);

export default function MyConstraints() {
  const [data, setData] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const load = useCallback(() => {
    api.get('/shifts/constraints/mine').then(r => setData(r.data)).catch(() => setData({ error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (url, body, ok) => {
    try { const r = await api.post(url, body); toast.success(ok(r.data)); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const cancel = (c) => {
    if (!window.confirm('לבטל את האילוץ?')) return;
    act(`/shifts/constraints/${c._id}/cancel`, {}, d => (d.after_publish ? 'האילוץ בוטל. הסידור לשבוע הזה כבר נבנה — ייתכן שלא יתחשבו בביטול.' : 'האילוץ בוטל'));
  };

  if (!data) return <LinearProgress />;
  if (data.error) return <Alert severity="error">לא הצלחנו לטעון את האילוצים</Alert>;
  if (data.reason === 'no_employee') return <Alert severity="warning">לא נמצא כרטיס עובדת מקושר למשתמש שלך. פני למשרד.</Alert>;

  return (
    <Box>
      <Button variant="contained" onClick={() => setFormOpen(true)} sx={{ mb: 2 }}>אילוץ חדש</Button>

      {(data.incoming.length > 0 || data.offers.length > 0) && (
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Typography fontWeight={700}>בקשות אליי</Typography>
          {data.incoming.map(c => (
            <Alert key={c._id} severity="info" action={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => act(`/shifts/constraints/${c._id}/colleague-response`, { accept: true }, () => 'אישרת — הבקשה עברה למנהלת')}>מסכימה</Button>
                <Button size="small" color="inherit" onClick={() => act(`/shifts/constraints/${c._id}/colleague-response`, { accept: false }, () => 'סירבת')}>לא יכולה</Button>
              </Stack>
            }>{c.employee_name} מבקשת: {describe(c)}</Alert>
          ))}
          {data.offers.map(c => (
            <Alert key={c._id} severity="info" action={
              c.i_volunteered
                ? <Chip size="small" color="success" label="סימנת שאת יכולה" />
                : <Button size="small" onClick={() => act(`/shifts/constraints/${c._id}/volunteer`, {}, () => 'תודה! המנהלת תחליט')}>אני יכולה</Button>
            }>מחפשים מחליפה ב-{fmtDate(c.date)}</Alert>
          ))}
        </Stack>
      )}

      <Typography fontWeight={700} sx={{ mb: 1 }}>האילוצים שלי</Typography>
      {data.mine.length === 0 && <Typography color="text.secondary">עוד לא הגשת אילוצים.</Typography>}
      <Stack spacing={1}>
        {data.mine.map(c => (
          <Card key={c._id} variant="outlined">
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Typography fontWeight={600}>{describe(c)}</Typography>
                <Chip size="small" color={STATUS_COLOR[c.status]} label={STATUS_LABEL[c.status]} />
              </Stack>
              {c.details && <Typography variant="body2" color="text.secondary">{c.details}</Typography>}
              {c.status === 'rejected' && c.reject_reason && <Typography variant="body2" color="error.main">סיבה: {c.reject_reason}</Typography>}
              {c.status === 'broadcast' && <Typography variant="body2">{c.volunteer_count ? `${c.volunteer_count} עובדות הסכימו להחלפה` : 'עוד אף אחת לא הסכימה'}</Typography>}
              <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                {c.files.map((file, i) => <Link key={i} component="button" variant="caption" onClick={() => openConstraintFile(c._id, i)}>{file.name}</Link>)}
                {CANCELLABLE.has(c.status) && <Button size="small" color="inherit" onClick={() => cancel(c)} sx={{ mr: 'auto' }}>ביטול</Button>}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
      <ConstraintForm open={formOpen} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); load(); }} />
    </Box>
  );
}
