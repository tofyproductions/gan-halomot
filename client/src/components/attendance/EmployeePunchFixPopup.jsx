import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  TextField, Paper, ToggleButton, ToggleButtonGroup, Alert, Chip,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * "יש לך החתמות לתקן" — the employee's side of the punch follow-up
 * (docs/superpowers/specs/2026-09-27-punch-followup-design.md, stage 2).
 *
 * Opens on every app open while she has an open problem day. "אחר כך" is
 * quiet only until the next open (sessionStorage) — the popup IS the
 * repeating reminder, the morning push is sent once. `?punch_fix=1` (the
 * push's link) opens it regardless.
 */
const SNOOZE_KEY = 'punchFixSnoozed';
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayLabel = (ymd) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `יום ${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};

function MissingCard({ issue, onSend, busy }) {
  const p = issue.punches.find(x => x.counted);
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const what = p?.state === 0 ? 'נרשמה כניסה' : p?.state === 1 ? 'נרשמה יציאה' : 'נרשמה החתמה אחת';
  const missing = p?.state === 0 ? 'שעת היציאה' : p?.state === 1 ? 'שעת הכניסה' : 'השעה החסרה';
  return (
    <Stack spacing={1}>
      <Typography variant="body2">{what} ב-{p?.hhmm}. מה {missing}?</Typography>
      <Stack direction="row" spacing={1}>
        <TextField size="small" type="time" label={missing} value={time}
          onChange={e => setTime(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ minWidth: 140 }} />
        <TextField size="small" label="הערה (לא חובה)" value={note} onChange={e => setNote(e.target.value)} fullWidth />
      </Stack>
      <Button variant="contained" size="small" disabled={busy || !time}
        onClick={() => onSend({ time, note })}>שליחה לאישור</Button>
    </Stack>
  );
}

function DuplicateCard({ issue, onSend, busy }) {
  const counted = issue.punches.filter(x => x.counted);
  const [roles, setRoles] = useState(() => Object.fromEntries(counted.map((p, i) => [
    p.id, i === 0 ? 'in' : i === counted.length - 1 ? 'out' : 'ignore',
  ])));
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        נרשמו {counted.length} החתמות. סמני ליד כל אחת מה היא הייתה:
      </Typography>
      {counted.map(p => (
        <Stack key={p.id} direction="row" spacing={1} alignItems="center">
          <Chip label={p.hhmm} size="small" sx={{ minWidth: 64 }} />
          <ToggleButtonGroup size="small" exclusive value={roles[p.id]}
            onChange={(_e, v) => v && setRoles(r => ({ ...r, [p.id]: v }))}>
            <ToggleButton value="in">כניסה</ToggleButton>
            <ToggleButton value="out">יציאה</ToggleButton>
            <ToggleButton value="ignore">בטעות</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      ))}
      <Button variant="contained" size="small" disabled={busy}
        onClick={() => onSend({ labels: counted.map(p => ({ punch_id: p.id, role: roles[p.id] })) })}>
        שליחה לאישור
      </Button>
    </Stack>
  );
}

function EmptyDayCard({ issue, onSend, busy, onRequest }) {
  const [mode, setMode] = useState(null); // 'worked' | 'not'
  const [inT, setInT] = useState(issue.schedule?.start || '');
  const [outT, setOutT] = useState(issue.schedule?.end || '');
  const [text, setText] = useState('');
  const [other, setOther] = useState(false);
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        לא נמצאו החתמות
        {issue.schedule ? ` (לפי ההתחייבות: ${issue.schedule.start}–${issue.schedule.end})` : ''}.
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button size="small" variant={mode === 'worked' ? 'contained' : 'outlined'} onClick={() => setMode('worked')}>עבדתי</Button>
        <Button size="small" variant={mode === 'not' ? 'contained' : 'outlined'} onClick={() => setMode('not')}>לא עבדתי</Button>
      </Stack>
      {mode === 'worked' && (
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField size="small" type="time" label="כניסה" value={inT} onChange={e => setInT(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" type="time" label="יציאה" value={outT} onChange={e => setOutT(e.target.value)} InputLabelProps={{ shrink: true }} />
          <Button variant="contained" size="small" disabled={busy || !inT || !outT}
            onClick={() => onSend({ action: 'worked', in_time: inT, out_time: outT })}>שליחה</Button>
        </Stack>
      )}
      {mode === 'not' && (
        <Stack spacing={1}>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={() => onRequest('sick', issue.date)}>מחלה</Button>
            <Button size="small" variant="outlined" onClick={() => onRequest('vacation', issue.date)}>חופשה</Button>
            <Button size="small" variant={other ? 'contained' : 'outlined'} onClick={() => setOther(true)}>אחר</Button>
          </Stack>
          {other && (
            <Stack direction="row" spacing={1}>
              <TextField size="small" label="מה קרה?" value={text} onChange={e => setText(e.target.value)} fullWidth />
              <Button variant="contained" size="small" disabled={busy || !text.trim()}
                onClick={() => onSend({ action: 'other', text })}>שליחה</Button>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

const KIND_TITLE = { missing: 'חסרה החתמה', duplicate: 'החתמה כפולה', empty_day: 'יום ללא החתמות' };

export default function EmployeePunchFixPopup() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [issues, setIssues] = useState([]);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const forced = new URLSearchParams(location.search).get('punch_fix') === '1';

  const load = useCallback(() => {
    api.get('/punch-followup/mine')
      .then(res => setIssues(res.data.issues || []))
      .catch(() => setIssues([]));
  }, []);

  useEffect(() => { if (isAuthenticated) load(); }, [isAuthenticated, load, forced]);

  const toFix = issues.filter(i => i.view === 'fix');
  const sent = issues.filter(i => i.view === 'sent');

  useEffect(() => {
    if (!toFix.length) { setOpen(false); return; }
    let snoozed = false;
    try { snoozed = sessionStorage.getItem(SNOOZE_KEY) === '1'; } catch { /* private mode */ }
    if (forced || !snoozed) setOpen(true);
  }, [toFix.length, forced]);

  const later = () => {
    try { sessionStorage.setItem(SNOOZE_KEY, '1'); } catch { /* private mode */ }
    setOpen(false);
  };

  const send = async (issue, payload) => {
    setBusyKey(issue.key);
    try {
      await api.post('/punch-followup/fix', { issue_key: issue.key, ...payload });
      toast.success('נשלח לאישור המנהלת');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'השליחה נכשלה');
    } finally { setBusyKey(null); }
  };

  const toRequest = (type, date) => {
    later();
    navigate(`/my-updates?open=${type}&date=${date}`);
  };

  if (!open) return null;
  return (
    <Dialog open onClose={later} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {toFix.length === 1 ? 'יש יום אחד לתקן בהחתמות' : `יש ${toFix.length} ימים לתקן בהחתמות`}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          {toFix.map(issue => (
            <Paper key={issue.key} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>
                {dayLabel(issue.date)} · {KIND_TITLE[issue.kind]}
              </Typography>
              {issue.kind === 'missing' && (
                <MissingCard issue={issue} busy={busyKey === issue.key} onSend={p => send(issue, p)} />
              )}
              {issue.kind === 'duplicate' && (
                <DuplicateCard issue={issue} busy={busyKey === issue.key} onSend={p => send(issue, p)} />
              )}
              {issue.kind === 'empty_day' && (
                <EmptyDayCard issue={issue} busy={busyKey === issue.key} onSend={p => send(issue, p)} onRequest={toRequest} />
              )}
            </Paper>
          ))}
          {sent.length > 0 && (
            <Alert severity="success" variant="outlined">
              נשלח לאישור המנהלת ✓ — {sent.map(i => dayLabel(i.date)).join(', ')}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={later}>אחר כך</Button>
      </DialogActions>
    </Dialog>
  );
}
