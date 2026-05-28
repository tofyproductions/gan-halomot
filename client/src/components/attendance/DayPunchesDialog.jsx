import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Typography, IconButton, Chip, List, ListItem, ListItemText, Divider, Box,
  Select, MenuItem, FormControl, InputLabel, Tooltip, CircularProgress, Alert,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';

/**
 * Dialog for managing all punches on a specific (employee × day). Manager
 * can edit the timestamp / state, delete bad punches, approve pending ones,
 * or add a fresh entry/exit for forgotten clocks.
 */

function timeToIsraelDate(date, hhmm) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // Build a UTC date from IL local time using DST-aware offset detection
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const ilHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(probe),
    10
  );
  const offsetHours = ilHour - 12;
  return new Date(Date.UTC(y, m - 1, d, hh - offsetHours, mm, 0));
}

function israelHHmm(iso) {
  return new Date(iso).toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusChip(p) {
  switch (p.approval_status) {
    case 'pending':
    case 'pending_manager':    return <Chip size="small" color="warning" label="ממתין לאישור מנהל" />;
    case 'pending_accountant': return <Chip size="small" color="info" label="ממתין לאישור הנה״ח" />;
    case 'approved': return <Chip size="small" color="success" label="מאושר" variant="outlined" />;
    case 'rejected': return <Chip size="small" color="error" label="נדחה" />;
    default:         return null;
  }
}

export default function DayPunchesDialog({ open, onClose, employee, date, branchId, isUnlinked, israeliId, onChanged }) {
  const confirm = useConfirm();
  const { isAdmin, isManager, isAccountant } = useAuth();
  // Who may act on a punch at its current stage (accountant is final).
  const canActPunch = (st) => {
    if (st === 'pending_manager' || st === 'pending') return isManager || isAdmin;
    if (st === 'pending_accountant') return isAccountant || isAdmin;
    return false;
  };
  const { branches } = useBranch();
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ in_time: '', out_time: '', note: '' });
  const [addDate, setAddDate] = useState(date);   // which date the manual punch is for
  const [addBranch, setAddBranch] = useState(branchId || '');
  const [editing, setEditing] = useState({}); // id → { hhmm, state }
  const [dirty, setDirty] = useState(false);   // changed anything → refresh parent once on close
  const markDirty = () => setDirty(true);
  const handleClose = () => { if (dirty) markDirty(); onClose(); };

  const load = useCallback(() => {
    if (!open || !date) return;
    setLoading(true);
    const params = { date };
    if (isUnlinked) {
      if (branchId) params.branch = branchId;
      if (israeliId) params.israeli_id = israeliId;
    } else if (employee?._id) {
      params.employee_id = employee._id;
    }
    api.get('/payroll/punches/day', { params })
      .then(res => setPunches(res.data.punches || []))
      .catch(() => setPunches([]))
      .finally(() => setLoading(false));
  }, [open, date, employee, branchId, isUnlinked, israeliId]);

  useEffect(load, [load]);
  useEffect(() => {
    if (open) {
      setDraft({ in_time: '', out_time: '', note: '' });
      setEditing({}); setDirty(false);
      setAddDate(date); setAddBranch(branchId || '');
    }
  }, [open, date, branchId]);

  const beginEdit = (p) => {
    setEditing(prev => ({ ...prev, [p._id]: { hhmm: israelHHmm(p.timestamp), state: p.state, manual_note: p.manual_note || '' } }));
  };
  const saveEdit = (p) => {
    const e = editing[p._id];
    if (!e) return;
    const ts = timeToIsraelDate(date, e.hhmm);
    api.patch(`/payroll/punches/${p._id}`, { timestamp: ts.toISOString(), state: Number(e.state), manual_note: e.manual_note })
      .then(() => { setEditing(prev => { const x = { ...prev }; delete x[p._id]; return x; }); load(); markDirty(); toast.success('עודכן'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };
  const cancelEdit = (id) => setEditing(prev => { const x = { ...prev }; delete x[id]; return x; });

  const del = async (p) => {
    if (!(await confirm({ title: 'הסרת החתמה', message: 'להסיר את ההחתמה?', danger: true, remember_key: 'delete-punch' }))) return;
    api.delete(`/payroll/punches/${p._id}`)
      .then(() => { load(); markDirty(); toast.success('נמחק'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const approve = (p) => {
    api.patch(`/payroll/punches/${p._id}/approve`)
      .then(() => { load(); markDirty(); toast.success('אושר'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };
  const reject = (p) => {
    api.patch(`/payroll/punches/${p._id}/reject`)
      .then(() => { load(); markDirty(); toast.success('נדחה'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const add = () => {
    if (!employee?._id) return toast.error('לא ניתן להוסיף החתמה לרשומה לא מזוהה');
    if (!draft.in_time && !draft.out_time) return toast.error('יש למלא לפחות אחד מהשדות');
    const useDate = addDate || date;
    api.post('/payroll/manual-punches', { employee_id: employee._id, date: useDate, branch_id: addBranch || undefined, ...draft })
      .then(() => {
        // Keep date + branch so several punches can be entered quickly; don't
        // refresh the whole page (deferred to close) so we stay on this employee.
        setDraft({ in_time: '', out_time: '', note: '' });
        markDirty();
        if (useDate === date) load();
        toast.success(`נוספה החתמה ל-${useDate}`);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  if (!open) return null;

  const title = employee
    ? `החתמות ${employee.full_name} • ${date}`
    : `החתמות לא מזוהות • ${date}`;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {isUnlinked && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            החתמות אלו לא משויכות לעובד פעיל. ניתן רק לערוך זמן או למחוק. כדי לשייך — עדכן ת״ז בפרטי העובד.
          </Alert>
        )}

        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>החתמות קיימות ({punches.length})</Typography>

        {loading ? <Box sx={{ textAlign: 'center', py: 2 }}><CircularProgress size={28} /></Box> : punches.length === 0 ? (
          <Typography variant="caption" color="text.disabled">אין החתמות ליום זה.</Typography>
        ) : (
          <List dense sx={{ bgcolor: 'grey.50', borderRadius: 2, mb: 2 }}>
            {punches.map(p => {
              const e = editing[p._id];
              return (
                <ListItem key={p._id} sx={{ pr: 1, alignItems: 'flex-start' }}>
                  {e ? (
                    <Stack spacing={1} sx={{ width: '100%' }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <TextField
                          type="time" size="small" value={e.hhmm}
                          onChange={ev => setEditing(prev => ({ ...prev, [p._id]: { ...e, hhmm: ev.target.value } }))}
                          InputLabelProps={{ shrink: true }} sx={{ width: 110 }}
                        />
                        <FormControl size="small" sx={{ minWidth: 100 }}>
                          <InputLabel>סוג</InputLabel>
                          <Select label="סוג" value={e.state}
                            onChange={ev => setEditing(prev => ({ ...prev, [p._id]: { ...e, state: Number(ev.target.value) } }))}>
                            <MenuItem value={0}>כניסה</MenuItem>
                            <MenuItem value={1}>יציאה</MenuItem>
                          </Select>
                        </FormControl>
                        <Box sx={{ flex: 1 }} />
                        <Button size="small" variant="contained" onClick={() => saveEdit(p)}>שמור</Button>
                        <Button size="small" onClick={() => cancelEdit(p._id)}>ביטול</Button>
                      </Stack>
                      <TextField
                        size="small" placeholder="הערה" value={e.manual_note}
                        onChange={ev => setEditing(prev => ({ ...prev, [p._id]: { ...e, manual_note: ev.target.value } }))}
                      />
                    </Stack>
                  ) : (
                    <>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                            <Typography sx={{ fontWeight: 700, minWidth: 50 }}>{israelHHmm(p.timestamp)}</Typography>
                            <Chip size="small" variant="outlined" color={p.state === 0 ? 'primary' : 'default'} label={p.state === 0 ? 'כניסה' : 'יציאה'} />
                            {p.timestamp_source === 'manual' && <Chip size="small" label="ידני" variant="outlined" />}
                            {statusChip(p)}
                          </Stack>
                        }
                        secondary={
                          <Box>
                            {p.manual_note && <Typography variant="caption" sx={{ display: 'block' }}>{p.manual_note}</Typography>}
                            <Typography variant="caption" color="text.disabled">
                              {p.branch_id?.name && `סניף: ${p.branch_id.name}`}
                              {p.created_by?.full_name && ` • דווח ע"י ${p.created_by.full_name}`}
                            </Typography>
                          </Box>
                        }
                      />
                      <Stack direction="row" spacing={0.3}>
                        {canActPunch(p.approval_status) && (
                          <>
                            <Tooltip title="אשר"><IconButton size="small" color="success" onClick={() => approve(p)}><CheckCircleIcon fontSize="small" /></IconButton></Tooltip>
                            <Tooltip title="דחה"><IconButton size="small" color="error" onClick={() => reject(p)}><CancelIcon fontSize="small" /></IconButton></Tooltip>
                          </>
                        )}
                        <Tooltip title="ערוך"><IconButton size="small" onClick={() => beginEdit(p)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="מחק"><IconButton size="small" color="error" onClick={() => del(p)}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                      </Stack>
                    </>
                  )}
                </ListItem>
              );
            })}
          </List>
        )}

        {!isUnlinked && employee && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הוסף החתמה ידנית</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              אפשר להוסיף כמה החתמות לתאריכים שונים ברצף — הדף לא יתרענן עד שתסגור.
            </Typography>
            <Stack spacing={1}>
              <Stack direction="row" spacing={1}>
                <TextField type="date" label="תאריך" size="small" value={addDate}
                  onChange={e => setAddDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
                <TextField select label="סניף" size="small" value={addBranch}
                  onChange={e => setAddBranch(e.target.value)} fullWidth>
                  <MenuItem value="">סניף הבית</MenuItem>
                  {(branches || []).map(b => <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction="row" spacing={1}>
                <TextField type="time" label="כניסה" size="small" value={draft.in_time}
                  onChange={e => setDraft({ ...draft, in_time: e.target.value })}
                  InputLabelProps={{ shrink: true }} fullWidth />
                <TextField type="time" label="יציאה" size="small" value={draft.out_time}
                  onChange={e => setDraft({ ...draft, out_time: e.target.value })}
                  InputLabelProps={{ shrink: true }} fullWidth />
              </Stack>
              <TextField label="הערה" size="small" value={draft.note}
                onChange={e => setDraft({ ...draft, note: e.target.value })} fullWidth />
              <Button startIcon={<AddIcon />} variant="contained" onClick={add} size="small">הוסף החתמה</Button>
            </Stack>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
