import { useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, TextField, FormControlLabel, Checkbox, Alert, Divider,
  ToggleButton, ToggleButtonGroup, InputAdornment,
} from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

const POLL_MS = 60_000;
/**
 * Who gets asked. NOT everyone who may answer.
 *
 * The branch manager is in the building and knows whether the instructor
 * walked in. A system admin is not, and was being asked every morning about
 * every class at every branch — a question they cannot answer, which is how a
 * popup becomes a thing you close without reading, including on the morning it
 * mattered. The server agrees (classes.controller `getsOccurrencePopup`);
 * this list only keeps the poll from running at all.
 */
const POPUP_ROLES = ['branch_manager', 'class_leader'];

/**
 * "Did she come this morning, and did she do all of it?"
 *
 * Mounted app-wide; polls once a minute for class sessions whose time has
 * arrived and that still need this person's answer.
 *
 * THE QUESTION IS ASKED ONCE PER VISIT, NOT ONCE PER GROUP. An instructor
 * arrives at one gan and takes the תינוקייה, then the צעירים, then the בוגרים:
 * three sessions, because they are three groups at three rates, but one
 * arrival. Asked three times in a row, a manager learns to close the box
 * without reading it — and then the answers are worth nothing, which is worse
 * than not asking.
 *
 * So: one dialog, one "did she come", and a row per group inside it. Each row
 * is settled on its own — התקיים / חלקית / לא — because the thing the old
 * spreadsheet could not express is exactly the middle case: she came, and did
 * two groups of three.
 */
export default function ClassPopupPoller() {
  const { user } = useAuth();
  const [queue, setQueue] = useState([]);
  const [visit, setVisit] = useState(null);
  const [came, setCame] = useState(null);        // null | true | false
  const [rows, setRows] = useState({});          // sessionId → { status, amount, reason }
  const [reason, setReason] = useState('');      // whole-visit reason, when she did not come
  const [reschedule, setReschedule] = useState(false);
  const [newDate, setNewDate] = useState('');
  // The hour of the make-up. A lesson moved to another day lands wherever the
  // room is free, not at the hour it was meant to be — and the reminder goes
  // out at the hour the session carries.
  const [newTime, setNewTime] = useState('');
  const [saving, setSaving] = useState(false);
  const timerRef = useRef(null);

  const eligible = user && POPUP_ROLES.includes(user.role);

  const poll = () => {
    if (!eligible) return;
    api.get('/classes/sessions/due')
      .then(res => setQueue(res.data.visits || []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!eligible) return;
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  // Surface the next queued visit when nothing is currently open.
  useEffect(() => {
    if (visit || queue.length === 0) return;
    const next = queue[0];
    setVisit(next);
    setCame(null);
    setReason(''); setReschedule(false); setNewDate(''); setNewTime('');
    // Every group starts at "it happened", because that is what usually
    // happened — the manager is correcting an exception, not filling a form.
    setRows(Object.fromEntries((next.classes || []).map(c => [
      c.id, {
        status: 'occurred',
        amount: Math.round((c.rate / 2) * 100) / 100,
        reason: '',
        // A make-up for THIS group, when only this one was missed.
        postpone: false, newDate: '', newTime: c.time || '',
      },
    ])));
  }, [queue, visit]);

  if (!eligible || !visit) return null;

  const who = visit.provider_name || visit.instructor || 'החוג';
  const setRow = (id, patch) => setRows(r => ({ ...r, [id]: { ...r[id], ...patch } }));
  const dismiss = () => {
    setQueue(q => q.filter(v => v.key !== visit.key));
    setVisit(null);
  };

  const submit = () => {
    if (came === null) return toast.info('בחר/י אם הגיע/ה');
    if (came === false && reschedule && !newDate) return toast.error('בחר/י תאריך חדש');
    if (came === true) {
      const missingDate = (visit.classes || []).find(c => {
        const r = rows[c.id] || {};
        return r.status === 'no_show' && r.postpone && !r.newDate;
      });
      if (missingDate) return toast.error('בחר/י תאריך למפגש ההשלמה');
    }

    const answers = (visit.classes || []).map((c) => {
      if (came === false) {
        return {
          id: c.id,
          status: reschedule ? 'postponed' : 'no_show',
          reason,
          ...(reschedule ? { new_date: newDate, new_time: newTime || c.time || '' } : {}),
        };
      }
      const r = rows[c.id] || { status: 'occurred' };
      if (r.status === 'partial') {
        return { id: c.id, status: 'partial', partial_amount: Number(r.amount) || 0, reason: r.reason || '' };
      }
      if (r.status === 'no_show') {
        // Only this group was missed — the make-up is for it alone.
        if (r.postpone && r.newDate) {
          return {
            id: c.id, status: 'postponed', reason: r.reason || '',
            new_date: r.newDate, new_time: r.newTime || '',
          };
        }
        return { id: c.id, status: 'no_show', reason: r.reason || '' };
      }
      return { id: c.id, status: 'occurred' };
    });

    setSaving(true);
    api.post('/classes/sessions/answer-visit', { answers })
      .then(() => { toast.success('נרשם'); dismiss(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#0369a1' }}>
        <EventAvailableIcon /> מעקב חוג
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Box>
            <Typography sx={{ fontWeight: 700, fontSize: '1.05rem' }}>
              האם {who} הגיע/ה?
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {visit.branch_name ? `${visit.branch_name} · ` : ''}{visit.date}
              {visit.time ? ` · ${visit.time}` : ''}
              {visit.classes.length > 1 ? ` · ${visit.classes.length} כיתות` : ''}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1}>
            <Button
              fullWidth variant={came === true ? 'contained' : 'outlined'} color="success"
              onClick={() => { setCame(true); setReschedule(false); }}
            >כן, הגיע/ה</Button>
            <Button
              fullWidth variant={came === false ? 'contained' : 'outlined'} color="error"
              onClick={() => setCame(false)}
            >לא הגיע/ה</Button>
          </Stack>

          {/* Came — now which groups actually happened. */}
          {came === true && (
            <>
              <Divider />
              <Typography variant="body2" color="text.secondary">
                {visit.classes.length > 1
                  ? 'אילו כיתות התקיימו בפועל?'
                  : 'האם הכיתה התקיימה במלואה?'}
              </Typography>
              {visit.classes.map((c) => {
                const r = rows[c.id] || {};
                return (
                  <Box key={c.id} sx={{ border: '1px solid #e5e7eb', borderRadius: 2, p: 1.5 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                      <Typography sx={{ fontWeight: 600 }}>
                        {c.classroom_category || c.program_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.time ? `${c.time} · ` : ''}₪{c.rate}
                      </Typography>
                    </Stack>
                    <ToggleButtonGroup
                      size="small" fullWidth exclusive value={r.status || 'occurred'}
                      onChange={(_, v) => v && setRow(c.id, { status: v })}
                    >
                      <ToggleButton value="occurred" color="success">התקיימה</ToggleButton>
                      <ToggleButton value="partial" color="warning">חלקית</ToggleButton>
                      <ToggleButton value="no_show" color="error">לא התקיימה</ToggleButton>
                    </ToggleButtonGroup>
                    {r.status === 'partial' && (
                      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                        <TextField
                          label="לתשלום" size="small" type="number" sx={{ width: 130 }}
                          value={r.amount ?? ''} onChange={e => setRow(c.id, { amount: e.target.value })}
                          InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                        />
                        <TextField
                          label="מה חסר?" size="small" fullWidth
                          value={r.reason || ''} onChange={e => setRow(c.id, { reason: e.target.value })}
                        />
                      </Stack>
                    )}
                    {r.status === 'no_show' && (
                      <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                        <TextField
                          label="למה לא התקיימה?" size="small" fullWidth
                          value={r.reason || ''} onChange={e => setRow(c.id, { reason: e.target.value })}
                        />
                        <FormControlLabel
                          control={<Checkbox checked={!!r.postpone}
                            onChange={e => setRow(c.id, { postpone: e.target.checked })} />}
                          label="נקבע מועד השלמה לקבוצה הזאת"
                        />
                        {r.postpone && (
                          <Stack direction="row" spacing={1}>
                            <TextField
                              label="תאריך ההשלמה" type="date" size="small" sx={{ flex: 1 }}
                              InputLabelProps={{ shrink: true }}
                              value={r.newDate || ''} onChange={e => setRow(c.id, { newDate: e.target.value })}
                            />
                            <TextField
                              label="שעה" type="time" size="small" sx={{ width: 130 }}
                              InputLabelProps={{ shrink: true }}
                              value={r.newTime || ''} onChange={e => setRow(c.id, { newTime: e.target.value })}
                            />
                          </Stack>
                        )}
                        {r.postpone && (
                          <Alert severity="info" sx={{ py: 0 }}>
                            ייווצר מפגש חדש במועד שנבחר, והשאלה תחזור באותו יום ובאותה שעה.
                            המפגש של היום לא ייספר לתשלום.
                          </Alert>
                        )}
                      </Stack>
                    )}
                  </Box>
                );
              })}
            </>
          )}

          {/* Did not come at all — one reason for the whole visit. */}
          {came === false && (
            <Stack spacing={1.5}>
              <TextField
                label="למה לא הגיע/ה?" size="small" fullWidth multiline minRows={2}
                value={reason} onChange={e => setReason(e.target.value)}
              />
              <FormControlLabel
                control={<Checkbox checked={reschedule} onChange={e => setReschedule(e.target.checked)} />}
                label="נדחה לתאריך אחר"
              />
              {reschedule && (
                <Stack direction="row" spacing={1}>
                  <TextField
                    label="תאריך חדש" type="date" size="small" sx={{ flex: 1, maxWidth: 220 }}
                    value={newDate} onChange={e => setNewDate(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                  <TextField
                    label="שעה" type="time" size="small" sx={{ width: 130 }}
                    value={newTime} onChange={e => setNewTime(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                </Stack>
              )}
              <Alert severity="info" sx={{ py: 0 }}>
                {reschedule
                  ? `ייווצרו מפגשים חדשים במועד שנבחר עבור ${visit.classes.length} הכיתות, והשאלה תחזור באותו יום. המפגשים של היום לא ייספרו לתשלום.`
                  : `${visit.classes.length} הכיתות של היום לא ייספרו לתשלום.`}
              </Alert>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={dismiss} disabled={saving}>מאוחר יותר</Button>
        <Button variant="contained" onClick={submit} disabled={saving || came === null}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}
