import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Alert, Divider, ToggleButton, ToggleButtonGroup, Paper,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { toast } from 'react-toastify';
import api from '../../api/client';

const ROLE_LABEL = { in: 'כניסה', out: 'יציאה', ignore: 'התעלם' };
const ROLE_COLOR = { in: 'success', out: 'error', ignore: 'standard' };

// Σ(in→out) over the chosen labels, chronologically — never the out→in gaps.
function previewMinutes(punches, roles) {
  let total = 0, openIn = null;
  for (const p of punches) {
    const r = roles[p.id];
    if (r === 'in') openIn = p;
    else if (r === 'out' && openIn) {
      const [ah, am] = openIn.hhmm.split(':').map(Number);
      const [bh, bm] = p.hhmm.split(':').map(Number);
      total += Math.max(0, (bh * 60 + bm) - (ah * 60 + am));
      openIn = null;
    }
  }
  return total;
}
const asHours = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} (${Math.round(m / 60 * 100) / 100}h)`;

/**
 * Review of days with MORE THAN TWO punches for one employee. The accountant
 * labels each punch כניסה / יציאה / התעלם; pay is Σ(in→out), so a genuine
 * in-out-in-out day pays the worked stretches and not the break between them.
 * Until a day is approved it is billed provisionally (first→last) and flagged.
 */
export default function PunchReviewDialog({ open, row, canApprove, onClose, onSaved }) {
  const [roles, setRoles] = useState({});   // punchId → role
  const [saving, setSaving] = useState({}); // date → bool
  const days = row?.punch_review || [];

  useEffect(() => {
    if (!open || !row) return;
    const init = {};
    for (const d of days) {
      d.punches.forEach((p, i) => {
        // Approved days show their stored labels; pending days get a sensible
        // first-guess (first=in, last=out, middles ignored) that the accountant
        // adjusts — nothing is applied until they approve.
        init[p.id] = p.role || (i === 0 ? 'in' : i === d.punches.length - 1 ? 'out' : 'ignore');
      });
    }
    setRoles(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  if (!row) return null;

  const setRole = (punchId, role) => { if (role) setRoles(r => ({ ...r, [punchId]: role })); };

  const approve = (day) => {
    setSaving(s => ({ ...s, [day.date]: true }));
    api.post('/payroll-month/punch-resolutions', {
      employee_id: row.employee_id,
      date: day.date,
      labels: day.punches.map(p => ({ punch_id: p.id, role: roles[p.id] || 'ignore' })),
    })
      .then(() => { toast.success(`${day.date} אושר`); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(s => ({ ...s, [day.date]: false })));
  };

  const reopen = (day) => {
    api.delete('/payroll-month/punch-resolutions', { params: { employee_id: row.employee_id, date: day.date } })
      .then(() => { toast.info(`${day.date} הוחזר לבדיקה`); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#b45309' }}>
        <FactCheckIcon /> אישור החתמות — {row.full_name}
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          ימים עם יותר משתי החתמות דורשים החלטה. סמנ/י לכל החתמה אם היא <b>כניסה</b>, <b>יציאה</b> או <b>התעלם</b>.
          התשלום מחושב מכניסה ליציאה בלבד — לא בין יציאה לכניסה. עד לאישור, היום מחושב זמנית מההחתמה הראשונה עד האחרונה.
        </Alert>
        {days.length === 0 ? (
          <Alert severity="success">אין ימים הדורשים אישור לעובד/ת זה/זו בחודש הנבחר.</Alert>
        ) : (
          <Stack spacing={2}>
            {days.map(day => {
              const mins = previewMinutes(day.punches, roles);
              const approved = day.status === 'approved';
              return (
                <Paper key={day.date} variant="outlined"
                  sx={{ p: 1.5, borderRadius: 2, bgcolor: approved ? '#f0fdf4' : '#fffbeb',
                    borderColor: approved ? '#86efac' : '#fde68a' }}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                    <Typography sx={{ fontWeight: 800 }}>{day.date}</Typography>
                    <Chip size="small" label={`${day.punches.length} החתמות`} />
                    <Chip size="small" color={approved ? 'success' : 'warning'}
                      label={approved ? 'מאושר' : 'ממתין לאישור'} />
                    <Box sx={{ flex: 1 }} />
                    <Typography sx={{ fontWeight: 700 }}>לתשלום: {asHours(mins)}</Typography>
                  </Stack>
                  <Stack spacing={1}>
                    {day.punches.map(p => (
                      <Stack key={p.id} direction="row" alignItems="center" spacing={1}>
                        <Typography sx={{ minWidth: 62, fontWeight: 700, fontFamily: 'monospace' }} dir="ltr">{p.hhmm}</Typography>
                        {p.is_manual && <Chip size="small" variant="outlined" color="secondary" label="ידני" sx={{ height: 18, fontSize: '0.6rem' }} />}
                        <ToggleButtonGroup
                          size="small" exclusive value={roles[p.id] || 'ignore'}
                          onChange={(_e, v) => setRole(p.id, v)} disabled={!canApprove}
                        >
                          {['in', 'out', 'ignore'].map(r => (
                            <ToggleButton key={r} value={r} color={ROLE_COLOR[r]} sx={{ py: 0.2, px: 1.2, fontSize: '0.72rem' }}>
                              {ROLE_LABEL[r]}
                            </ToggleButton>
                          ))}
                        </ToggleButtonGroup>
                      </Stack>
                    ))}
                  </Stack>
                  {canApprove && (
                    <>
                      <Divider sx={{ my: 1 }} />
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        {approved && <Button size="small" onClick={() => reopen(day)}>החזר לבדיקה</Button>}
                        <Button size="small" variant="contained" color={approved ? 'inherit' : 'success'}
                          disabled={saving[day.date]} onClick={() => approve(day)}>
                          {approved ? 'עדכן אישור' : 'אשר יום'}
                        </Button>
                      </Stack>
                    </>
                  )}
                </Paper>
              );
            })}
          </Stack>
        )}
        {!canApprove && (
          <Alert severity="warning" sx={{ mt: 2 }}>תצוגה בלבד — רק הנהלת חשבונות או מנהל מערכת יכולים לאשר.</Alert>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}
