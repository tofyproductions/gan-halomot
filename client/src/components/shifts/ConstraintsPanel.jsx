import { useState } from 'react';
import { Alert, Stack, Button, TextField, Typography, Chip, Link, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { STATUS_LABEL, describe, isDone, openConstraintFile } from './constraintLabels';

/** "הוסרו 2 שיבוצים, שיבוץ אחד קוצר" — what the approval just did to the board. */
function appliedText(a) {
  if (!a || !a.applied) return '';
  const bits = [];
  if (a.removed) bits.push(`הוסרו ${a.removed} שיבוצים`);
  if (a.moved) bits.push(`הועברו ${a.moved} ליום החדש`);
  if (a.reassigned) bits.push(`הועברו ${a.reassigned} לעובדת המחליפה`);
  if (a.trimmed) bits.push(`קוצרו ${a.trimmed} לשעות המותרות`);
  return bits.join(', ');
}

/** The week's constraints that need the manager, with the actions each one allows. */
export default function ConstraintsPanel({ constraints, canEdit, onChanged, entries }) {
  const [reason, setReason] = useState({});
  const [busy, setBusy] = useState({});
  const list = constraints || [];
  const actionable = list.filter(c => ['open', 'pending_broadcast', 'broadcast'].includes(c.status));
  const accepted = list.filter(c => c.status === 'accepted');
  if (!list.length) return null;

  const post = async (c, url, body, ok) => {
    setBusy(b => ({ ...b, [c._id]: true }));
    try {
      let data;
      try { ({ data } = await api.post(url, body)); } catch (err) {
        // A far-off week: the server asks for an explicit "this is final" first.
        if (err.response?.status !== 409 || !err.response?.data?.needs_confirm) throw err;
        if (!window.confirm('הפעולה סופית — העובדת תקבל הודעה ולא יהיה אפשר לשבץ אותה ביום הזה. לאשר?')) return;
        ({ data } = await api.post(url, { ...body, confirm_far: true }));
      }
      // Say what the approval DID, not just that it happened — the board
      // behind this toast has already changed.
      const did = appliedText(data?.applied || data?.constraint?.applied);
      toast.success(did ? `${ok} — ${did}. העובדת קיבלה הודעה.` : ok);
      onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
    finally { setBusy(b => ({ ...b, [c._id]: false })); }
  };

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {actionable.map(c => (
        <Alert key={c._id} severity="warning" icon={false}>
          <Typography component="div" fontWeight={700}>{c.employee_name} — {describe(c)} <Chip size="small" label={STATUS_LABEL[c.status]} sx={{ mr: 1 }} />{c.manual && <Chip size="small" variant="outlined" color="info" label="נרשם ידנית" sx={{ mr: 0.5 }} />}</Typography>
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
      {accepted.length > 0 && (() => {
        // Approved is not the same as DONE: each one is checked against the
        // board as it stands, so a leftover placement cannot hide in here.
        const rows = accepted.map(c => ({ c, done: isDone(c, entries) }));
        const undone = rows.filter(r => r.done === false).length;
        return (
          <Accordion disableGutters defaultExpanded={undone > 0}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography>אילוצים שאושרו השבוע ({accepted.length})</Typography>
                {undone > 0
                  ? <Chip size="small" color="error" label={`${undone} עוד לא בוצעו בסידור`} />
                  : <Chip size="small" color="success" label="כולם בוצעו בסידור ✓" />}
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              {rows.map(({ c, done }) => (
                <Stack key={c._id} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  {done === false
                    ? <Chip size="small" color="error" label="לא בוצע — עדיין משובצת" />
                    : done === true
                      ? <Chip size="small" color="success" label="בוצע ✓" />
                      : <Chip size="small" variant="outlined" label="לידיעה" />}
                  <Typography variant="body2">{c.employee_name} — {describe(c)}{c.decided_auto ? ' (אוטומטית)' : ''}</Typography>
                </Stack>
              ))}
            </AccordionDetails>
          </Accordion>
        );
      })()}
    </Stack>
  );
}
