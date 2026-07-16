import { useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, TextField, FormControlLabel, Checkbox, Alert,
} from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

const POLL_MS = 60_000;
// Only these roles ever get the occurrence popup (managers + class leads).
const POPUP_ROLES = ['system_admin', 'branch_manager', 'class_leader'];

/**
 * Mounted app-wide. Every minute it asks the server for class sessions whose
 * time has arrived and that still need this user's answer, then shows one popup
 * at a time: "did class X arrive?" → כן / לא (+ reason, + reschedule to a new
 * date). No WebSocket in the app, so this is a simple poll.
 */
export default function ClassPopupPoller() {
  const { user } = useAuth();
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [arrived, setArrived] = useState(null); // null | true | false
  const [reason, setReason] = useState('');
  const [reschedule, setReschedule] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [saving, setSaving] = useState(false);
  const timerRef = useRef(null);

  const eligible = user && POPUP_ROLES.includes(user.role);

  const poll = () => {
    if (!eligible) return;
    api.get('/classes/sessions/due')
      .then(res => setQueue(res.data.sessions || []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!eligible) return;
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  // Surface the next queued session when nothing is currently open.
  useEffect(() => {
    if (!current && queue.length > 0) {
      setCurrent(queue[0]);
      setArrived(null); setReason(''); setReschedule(false); setNewDate('');
    }
  }, [queue, current]);

  if (!eligible || !current) return null;

  const submit = () => {
    if (arrived === null) return toast.info('בחר/י כן או לא');
    if (arrived === false && reschedule && !newDate) return toast.error('בחר/י תאריך חדש');
    setSaving(true);
    api.post(`/classes/sessions/${current.id}/answer`, {
      arrived,
      reason: reason || null,
      reschedule: arrived === false ? reschedule : false,
      new_date: arrived === false && reschedule ? newDate : null,
    })
      .then(() => {
        toast.success('נרשם');
        // Drop this one from the queue and move on.
        setQueue(q => q.filter(s => s.id !== current.id));
        setCurrent(null);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#0369a1' }}>
        <EventAvailableIcon /> מעקב חוג
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '1.05rem' }}>
            האם החוג "{current.program_name}"{current.instructor ? ` (${current.instructor})` : ''} הגיע?
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {current.date}{current.time ? ` · ${current.time}` : ''}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              fullWidth variant={arrived === true ? 'contained' : 'outlined'} color="success"
              onClick={() => { setArrived(true); setReschedule(false); }}
            >כן, הגיע</Button>
            <Button
              fullWidth variant={arrived === false ? 'contained' : 'outlined'} color="error"
              onClick={() => setArrived(false)}
            >לא הגיע</Button>
          </Stack>
          {arrived === false && (
            <Stack spacing={1.5}>
              <TextField
                label="למה לא הגיע?" size="small" fullWidth multiline minRows={2}
                value={reason} onChange={e => setReason(e.target.value)}
              />
              <FormControlLabel
                control={<Checkbox checked={reschedule} onChange={e => setReschedule(e.target.checked)} />}
                label="נדחה לתאריך אחר"
              />
              {reschedule && (
                <TextField
                  label="תאריך חדש" type="date" size="small"
                  value={newDate} onChange={e => setNewDate(e.target.value)}
                  InputLabelProps={{ shrink: true }} sx={{ maxWidth: 220 }}
                />
              )}
              {reschedule && (
                <Alert severity="info" sx={{ py: 0 }}>ייווצר מפגש חדש בתאריך שנבחר; המפגש הזה יסומן כנדחה ולא ייספר לתשלום.</Alert>
              )}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setQueue(q => q.filter(s => s.id !== current.id)); setCurrent(null); }} disabled={saving}>
          מאוחר יותר
        </Button>
        <Button variant="contained" onClick={submit} disabled={saving || arrived === null}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}
