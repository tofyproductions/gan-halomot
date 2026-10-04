import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography, Chip, Link, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { STATUS_LABEL, describe, openConstraintFile } from './constraintLabels';

/** The week's constraints that need the manager, with the actions each one allows. */
export default function ConstraintsPanel({ constraints, canEdit, onChanged }) {
  const [reason, setReason] = useState({});
  const [busy, setBusy] = useState({});
  const list = constraints || [];
  const actionable = list.filter(c => ['open', 'pending_broadcast', 'broadcast'].includes(c.status));
  const accepted = list.filter(c => c.status === 'accepted');
  if (!list.length) return null;

  const post = async (c, url, body, ok) => {
    setBusy(b => ({ ...b, [c._id]: true }));
    try { await api.post(url, body); toast.success(ok); onChanged(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [c._id]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {actionable.map(c => (
        <Alert key={c._id} severity="warning" icon={false}>
          <Typography fontWeight={700}>{c.employee_name} — {describe(c)} <Chip size="small" label={STATUS_LABEL[c.status]} sx={{ mr: 1 }} /></Typography>
          {c.details && <Typography variant="body2">{c.details}</Typography>}
          {c.colleague_name && <Typography variant="body2">עם: {c.colleague_name}</Typography>}
          {(c.files || []).map((f, i) => <Link key={i} component="button" variant="caption" sx={{ ml: 1 }} onClick={() => openConstraintFile(c._id, i, f.name)}>{f.name}</Link>)}
          {canEdit && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
              {c.status === 'open' && <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/decide`, { accept: true }, 'האילוץ התקבל')}>אישור</Button>}
              {c.status === 'pending_broadcast' && <Button size="small" variant="contained" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/approve-broadcast`, {}, 'ההצעה נשלחה לכל הסניף')}>אישור שליחה לכל הסניף</Button>}
              {c.status === 'broadcast' && ((c.volunteers || []).length
                ? c.volunteers.map(v => (
                  <Button key={v.employee_id} size="small" variant="outlined" disabled={!!busy[c._id]} onClick={() => post(c, `/shifts/constraints/${c._id}/pick`, { employee_id: v.employee_id }, `${v.full_name} נבחרה`)}>
                    {v.full_name}{v.free_that_day ? ' (פנויה ביום הזה)' : ''}
                  </Button>
                ))
                : <Typography variant="body2">עוד אף אחת לא התנדבה</Typography>)}
              <TextField size="small" placeholder="סיבת דחייה" value={reason[c._id] || ''} onChange={e => setReason(s => ({ ...s, [c._id]: e.target.value }))} />
              <Button size="small" color="error" disabled={!!busy[c._id] || !reason[c._id]?.trim()} onClick={() => post(c, `/shifts/constraints/${c._id}/decide`, { accept: false, reason: reason[c._id] }, 'האילוץ נדחה')}>דחייה</Button>
            </Stack>
          )}
        </Alert>
      ))}
      {accepted.length > 0 && (
        <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>אילוצים שהתקבלו השבוע ({accepted.length})</Typography></AccordionSummary>
          <AccordionDetails>
            {accepted.map(c => <Typography key={c._id} variant="body2">{c.employee_name} — {describe(c)}{c.decided_auto ? ' (אוטומטית)' : ''}</Typography>)}
          </AccordionDetails>
        </Accordion>
      )}
    </Stack>
  );
}
