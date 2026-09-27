import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, Paper, Alert,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { MissingCard, DuplicateCard, EmptyDayCard, dayLabel, KIND_TITLE } from './PunchFixCards';

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
