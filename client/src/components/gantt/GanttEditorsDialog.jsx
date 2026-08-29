import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  Typography, Chip, Box, CircularProgress, TextField, InputAdornment, Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CheckIcon from '@mui/icons-material/Check';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Who may write this room's plan, besides the manager.
 *
 * It lives here, on the plan itself, rather than buried in the branch setup
 * screen — the manager decides this at the moment she is looking at the room's
 * month and thinking "let the two of them do it", and a permission you have to
 * go and find is a permission nobody sets.
 *
 * The list is people with a LOGIN. A gananet without one cannot be given
 * access to anything, and offering her name here would promise something the
 * system cannot deliver.
 */
export default function GanttEditorsDialog({ open, onClose, classroomId, classroomName, onSaved }) {
  const [users, setUsers] = useState([]);
  const [chosen, setChosen] = useState([]);
  const [leadId, setLeadId] = useState(null);
  const [leadName, setLeadName] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !classroomId) return;
    setLoading(true);
    setQ('');
    Promise.all([
      api.get('/admin/users').catch(() => ({ data: { users: [] } })),
      api.get('/classrooms'),
    ]).then(([u, c]) => {
      setUsers((u.data.users || []).filter(x => x.is_active !== false));
      const room = (c.data.classrooms || []).find(x => String(x._id || x.id) === String(classroomId));
      setChosen((room?.gantt_editor_ids || []).map(String));
      setLeadId(room?.lead_teacher_id ? String(room.lead_teacher_id) : null);
      setLeadName(room?.lead_teacher_name || '');
    }).catch(() => toast.error('שגיאה בטעינת המשתמשים'))
      .finally(() => setLoading(false));
  }, [open, classroomId]);

  const toggle = (id) => setChosen(prev => (
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  ));

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/classrooms/${classroomId}`, { gantt_editor_ids: chosen });
      toast.success('ההרשאות נשמרו');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setBusy(false); }
  };

  const shown = users.filter(u => !q || (u.full_name || '').includes(q.trim()));

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>מי עורכת את התוכנית</DialogTitle>
      <DialogContent>
        {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

        {!loading && (
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {classroomName} · מנהלת יכולה לערוך תמיד. כאן בוחרים מי עוד.
            </Typography>

            {leadId && (
              <Alert severity="info" sx={{ py: 0.3 }}>
                <b>{leadName || 'מובילת הכיתה'}</b> רשומה כמובילה של הכיתה ויכולה לערוך גם בלי לסמן אותה כאן.
              </Alert>
            )}

            <TextField size="small" placeholder="חיפוש שם" value={q}
              onChange={e => setQ(e.target.value)}
              InputProps={{ startAdornment: (
                <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment>
              ) }}
            />

            {shown.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                לא נמצאו משתמשים.
              </Typography>
            )}

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, maxHeight: 320, overflowY: 'auto' }}>
              {shown.map(u => {
                const id = String(u._id || u.id);
                const on = chosen.includes(id);
                return (
                  <Chip
                    key={id}
                    label={u.full_name || u.email}
                    icon={on ? <CheckIcon sx={{ fontSize: 16 }} /> : undefined}
                    color={on ? 'primary' : 'default'}
                    variant={on ? 'filled' : 'outlined'}
                    onClick={() => toggle(id)}
                    sx={{ fontWeight: on ? 700 : 500 }}
                  />
                );
              })}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={busy}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}
