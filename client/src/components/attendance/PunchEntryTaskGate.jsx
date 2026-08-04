import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Alert, Paper, TextField, Collapse,
} from '@mui/material';
import AssignmentLateIcon from '@mui/icons-material/AssignmentLate';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { BusyButton } from '../shared/UploadControls';

const DISMISS_KEY = 'punch_entry_task_dismissed';

/**
 * The branch manager's standing homework, met at login.
 *
 * Completing a missing punch is the branch manager's job — they know who was
 * actually there — but an email nobody opens is not a handover. When accounting
 * assigns the task, this greets the manager on their next entry with the exact
 * days and a field per day, so the fix happens where the reminder lands.
 *
 * Deliberately a SOFT block: "אמלא מאוחר יותר" closes it for the session, but a
 * red bar stays pinned under the header until the branch is clean, and the
 * dialog returns on the next login. Hard-locking a manager who first has to go
 * ask an employee what time she left would just get the app worked around.
 *
 * The list is live, not the assignment snapshot: a day the employee completes
 * herself from האזור שלי vanishes, and when nothing is left the task closes
 * itself server-side.
 */
export default function PunchEntryTaskGate() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [open, setOpen] = useState(false);
  const [fill, setFill] = useState({});   // 'empId|date' → {in, out}
  const [busy, setBusy] = useState({});
  const [closing, setClosing] = useState(null); // task id being declared done
  const [note, setNote] = useState('');

  const load = useCallback((autoOpen) => {
    api.get('/payroll-month/punch-entry-tasks/mine')
      .then(r => {
        const list = r.data?.tasks || [];
        setTasks(list);
        if (autoOpen && list.length > 0 && !sessionStorage.getItem(DISMISS_KEY)) setOpen(true);
      })
      .catch(() => {});
  }, []);

  // Managers only — for everyone else the endpoint answers with an empty list,
  // but there is no reason to ask at all.
  const relevant = user && (user.role === 'branch_manager' || user.role === 'system_admin');
  useEffect(() => { if (relevant) load(true); }, [relevant, load]);

  if (!relevant || tasks.length === 0) return null;

  const keyOf = (m) => `${m.employee_id}|${m.date}`;
  const totalMissing = tasks.reduce((n, t) => n + t.missing.length, 0);

  const withBusy = (k, p) => {
    setBusy(b => ({ ...b, [k]: true }));
    return p.finally(() => setBusy(b => ({ ...b, [k]: false })));
  };

  const addMissing = (task, item) => {
    const k = keyOf(item);
    const v = fill[k] || {};
    if (!v.in && !v.out) return toast.error('הזן/י שעה להשלמה');
    return withBusy(k, api.post('/payroll/manual-punches', {
      employee_id: item.employee_id,
      date: item.date,
      in_time: v.in || undefined,
      out_time: v.out || undefined,
      note: `השלמת החתמה חסרה (משימת ${task.month})`,
    })
      .then(() => {
        toast.success(`${item.full_name} · ${item.date} הושלם`);
        setFill(f => { const n = { ...f }; delete n[k]; return n; });
        load(false);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));
  };

  const declareDone = (task) => withBusy(`done|${task.id}`,
    api.post(`/payroll-month/punch-entry-tasks/${task.id}/done`, { note })
      .then(() => {
        toast.success('המשימה נסגרה');
        setClosing(null); setNote('');
        load(false);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));

  const dismiss = () => { sessionStorage.setItem(DISMISS_KEY, '1'); setOpen(false); };

  return (
    <>
      {/* Stays put once the dialog is dismissed — the task does not go quiet. */}
      <Paper
        onClick={() => setOpen(true)}
        sx={{
          mb: 1.5, px: 2, py: 1, borderRadius: 2, cursor: 'pointer',
          bgcolor: '#fef2f2', border: '1px solid #fecaca',
          display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
        }}
      >
        <AssignmentLateIcon sx={{ color: '#b91c1c' }} />
        <Typography sx={{ fontWeight: 800, color: '#b91c1c' }}>
          נדרשת ממך השלמת החתמות
        </Typography>
        <Chip size="small" color="error" label={`${totalMissing} ימים`} />
        {tasks.map(t => (
          <Chip key={t.id} size="small" variant="outlined" label={`${t.branch_name} · ${t.month}`} />
        ))}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" color="error">פתח והשלם</Button>
      </Paper>

      <Dialog open={open} onClose={dismiss} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#b91c1c' }}>
          <AssignmentLateIcon /> השלמת החתמות חסרות
        </DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning" sx={{ mb: 2 }}>
            הנהלת החשבונות ביקשה ממך להשלים את השעות של הימים הבאים. אלו ימים שבהם נרשמה
            החתמה אחת בלבד — מלא/י את השעה החסרה לפי מה שאת/ה יודע/ת שקרה בפועל.
            לאחר ההשלמה השעות עוברות לאישור סופי של הנהלת החשבונות.
          </Alert>

          {tasks.map(task => (
            <Box key={task.id} sx={{ mb: 3 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 800 }}>{task.branch_name}</Typography>
                <Chip size="small" color="warning" label={task.month} />
                <Chip size="small" label={`${task.missing.length} ימים להשלמה`} />
                {task.duplicates_count > 0 && (
                  <Chip size="small" color="error" variant="outlined"
                    label={`+${task.duplicates_count} ימים כפולים בטיפול הנה״ח`} />
                )}
              </Stack>

              <Stack spacing={1.2}>
                {task.missing.map(item => {
                  const k = keyOf(item);
                  const v = fill[k] || {};
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#fff7ed', borderColor: '#fed7aa' }}>
                      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                        <Typography sx={{ fontWeight: 800, minWidth: 130 }}>{item.full_name}</Typography>
                        <Chip size="small" color="warning" label={item.date} />
                        <Chip size="small" label={`נרשם: ${item.punch_hhmm}`} />
                        <Box sx={{ flex: 1 }} />
                        <TextField size="small" type="time" label="כניסה" InputLabelProps={{ shrink: true }}
                          value={v.in || ''} sx={{ width: 125 }}
                          onChange={e => setFill(f => ({ ...f, [k]: { ...v, in: e.target.value } }))} />
                        <TextField size="small" type="time" label="יציאה" InputLabelProps={{ shrink: true }}
                          value={v.out || ''} sx={{ width: 125 }}
                          onChange={e => setFill(f => ({ ...f, [k]: { ...v, out: e.target.value } }))} />
                        <BusyButton size="small" variant="contained" loading={!!busy[k]}
                          onClick={() => addMissing(task, item)}>שמור</BusyButton>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        מלא/י רק את השעה החסרה — ההחתמה שכבר קיימת נשמרת.
                      </Typography>
                    </Paper>
                  );
                })}
              </Stack>

              <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                <Button size="small" color="inherit" onClick={() => { setClosing(closing === task.id ? null : task.id); setNote(''); }}>
                  לא ניתן להשלים חלק מהימים?
                </Button>
              </Stack>
              <Collapse in={closing === task.id}>
                <Paper variant="outlined" sx={{ p: 1.2, mt: 1, borderRadius: 2 }}>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    אם יום מסוים לא ניתן להשלמה (למשל העובד/ת לא עבד/ה באותו יום והחתמה נרשמה בטעות) —
                    כתב/י כאן מה קרה, והמשימה תיסגר ותעבור להנהלת החשבונות.
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <TextField size="small" fullWidth multiline minRows={2} value={note}
                      onChange={e => setNote(e.target.value)}
                      placeholder="לדוגמה: 12.8 — רונית לא עבדה, ההחתמה נרשמה בטעות" />
                    <BusyButton size="small" variant="contained" color="warning"
                      loading={!!busy[`done|${task.id}`]} onClick={() => declareDone(task)}>
                      סגור משימה
                    </BusyButton>
                  </Stack>
                </Paper>
              </Collapse>
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => load(false)}>רענן</Button>
          <Button onClick={dismiss}>אמלא מאוחר יותר</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
