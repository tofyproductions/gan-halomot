import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Typography, IconButton, Chip, List, ListItem, ListItemText, Divider, Box,
  Select, MenuItem, FormControl, InputLabel, Tooltip, CircularProgress, Alert,
  ToggleButtonGroup, ToggleButton,
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

/** A correction requested here for a GUEST employee — not one this dialog's
 * viewer necessarily manages. See the note on `canActPunch` below for why its
 * approve/reject icons never appear for this case. */
function isCrossBranchPending(p) {
  return !!p.pending_edit?.cross_branch && !p.pending_edit?.manager_approved;
}

function statusChip(p) {
  if (isCrossBranchPending(p)) {
    return <Chip size="small" color="secondary" label="תיקון ממתין לאישור מנהל/ת הבית" />;
  }
  if (p.pending_edit?.cross_branch && p.pending_edit?.manager_approved) {
    return <Chip size="small" color="info" label="תיקון אושר — ממתין להנה״ח" />;
  }
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
  /**
   * Who may act on a punch at its current stage (accountant is final).
   *
   * A cross-branch correction NEVER shows its approve/reject icons here,
   * whoever is looking — the manager who could legitimately click them is
   * the employee's home manager, not necessarily this branch's, and this
   * generic dialog has no way to tell the two apart. "עובדים שלי בסניפים
   * אחרים" is where that decision belongs; this dialog still shows the
   * request (see statusChip) so a host manager can see her own is pending.
   */
  const canActPunch = (p) => {
    if (isCrossBranchPending(p)) return false;
    const st = p.approval_status;
    if (st === 'pending_manager' || st === 'pending') return isManager || isAdmin;
    if (st === 'pending_accountant') return isAccountant || isAdmin;
    return false;
  };
  const { branches } = useBranch();
  const [punches, setPunches] = useState([]);
  const [resolution, setResolution] = useState(null); // the day's in/out decision (>2 punches)
  const [labels, setLabels] = useState({});           // punch id → 'in' | 'out' | 'ignore'
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ in_time: '', out_time: '', note: '' });
  const [addDate, setAddDate] = useState(date);   // which date the manual punch is for
  const [addBranch, setAddBranch] = useState(branchId || '');
  const [editing, setEditing] = useState({}); // id → { hhmm, state }
  const [dirty, setDirty] = useState(false);
  // Notify the parent (e.g. AttendanceMonitor) after every change so its grid
  // and totals refresh immediately — no manual page reload needed.
  const markDirty = () => { setDirty(true); if (onChanged) onChanged(); };
  const handleClose = () => { onClose(); };

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
      .then(res => {
        const list = res.data.punches || [];
        setPunches(list);
        const r = res.data.resolution || null;
        setResolution(r);
        // Start from the recorded decision when there is one; otherwise read
        // the day the way the clock did — alternate in/out down the list.
        // A device punch with an unknown state (255) says nothing, so order is
        // the only signal; the person then corrects what is wrong.
        const init = {};
        const fromRes = new Map((r?.labels || []).map(l => [String(l.punch_id), l.role]));
        list.filter(p => p.approval_status !== 'rejected').forEach((p, i) => {
          init[p._id] = fromRes.get(String(p._id)) || (i % 2 === 0 ? 'in' : 'out');
        });
        setLabels(init);
      })
      .catch(() => { setPunches([]); setResolution(null); })
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
      .then((res) => {
        setEditing(prev => { const x = { ...prev }; delete x[p._id]; return x; });
        load(); markDirty();
        // A parked time-change is not an update — say what actually happened.
        toast.success(res.data?.cross_branch
          ? 'התיקון נשלח לאישור מנהל/ת הבית של העובד/ת, ולאחר מכן להנהלת החשבונות — השעה תתעדכן אחרי האישור'
          : res.data?.pending
            ? 'שינוי השעה נשלח לאישור הנהלת החשבונות — השעה תתעדכן אחרי האישור'
            : 'עודכן');
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };
  const cancelEdit = (id) => setEditing(prev => { const x = { ...prev }; delete x[id]; return x; });

  const del = async (p) => {
    if (!(await confirm({ title: 'הסרת החתמה', message: 'להסיר את ההחתמה?', danger: true }))) return;
    api.delete(`/payroll/punches/${p._id}`)
      .then(() => { load(); markDirty(); toast.success('נמחק'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  /**
   * Approve. Accounting's (and the admin's) approval is FINAL, whatever stage
   * the punch is at. A self-report the branch manager has not seen yet is
   * approved with the manager bypassed — the server records that and tells
   * her after the fact — rather than bounced back for her signature: her
   * stage exists so that accounting is not the only pair of eyes, not so that
   * accounting's yes can be held up by it.
   */
  const approve = async (p) => {
    const st = p.approval_status;
    const overriding = (isAccountant || isAdmin) && (st === 'pending_manager' || st === 'pending');
    if (overriding && !(await confirm({
      title: 'אישור סופי',
      message: 'ההחתמה עוד לא עברה את מנהלת הסניף. האישור שלך סופי ונספר בשכר; המנהלת תקבל על כך הודעה.',
      confirm_label: 'אשר סופית',
    }))) return;
    api.patch(`/payroll/punches/${p._id}/approve`, overriding ? { override_manager: true } : {})
      .then(() => { load(); markDirty(); toast.success('אושר'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  /**
   * Settle a >2-punch day right here. The same decision the payroll issues
   * screen makes ("החתמות כפולות"), reached from the cell the person is
   * already looking at — which is where they went looking for it.
   */
  const dayPunches = punches.filter(p => p.approval_status !== 'rejected');
  const needsDecision = dayPunches.length > 2;
  const canDecideDay = isAdmin || isAccountant;
  const canProposeDay = isManager && !canDecideDay;
  const labelledMinutes = (() => {
    let total = 0, openIn = null;
    for (const p of dayPunches) {
      const role = labels[p._id] || 'ignore';
      if (role === 'in') openIn = p;
      else if (role === 'out' && openIn) { total += Math.max(0, Math.round((new Date(p.timestamp) - new Date(openIn.timestamp)) / 60000)); openIn = null; }
    }
    return total;
  })();
  const decideDay = async () => {
    if (!employee?._id) return;
    if (!(await confirm({
      title: canDecideDay ? 'אישור היום' : 'שליחה לאישור הנהלת החשבונות',
      message: `${(labelledMinutes / 60).toFixed(2)} שעות ייספרו ליום זה לפי הסימון (כניסה/יציאה/התעלם).`
        + (canDecideDay ? ' החתמות שעדיין ממתינות לאישור ואינן "התעלם" יאושרו סופית.' : ''),
      confirm_label: canDecideDay ? 'אשר את היום' : 'שלח לאישור',
    }))) return;
    api.post('/payroll-month/punch-resolutions', {
      employee_id: employee._id, date,
      labels: dayPunches.map(p => ({ punch_id: p._id, role: labels[p._id] || 'ignore' })),
    })
      .then(r => { load(); markDirty(); toast.success(r.data?.status === 'approved' ? 'היום אושר' : 'נשלח לאישור הנהלת החשבונות'); })
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
        // Keep date + branch so several punches can be entered quickly. The grid
        // behind refreshes live (markDirty → onChanged); the dialog stays open.
        setDraft({ in_time: '', out_time: '', note: '' });
        if (useDate === date) load();
        markDirty();
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
          <List dense sx={{ bgcolor: 'background.sunken', borderRadius: 2, mb: 2 }}>
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
                        {canActPunch(p) && (
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

        {!isUnlinked && employee && needsDecision && (
          <Alert
            severity={resolution?.status === 'approved' ? 'success' : 'warning'} icon={false}
            sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
              {resolution?.status === 'approved'
                ? `היום אושר — ${((resolution.minutes || 0) / 60).toFixed(2)} שעות נספרות`
                : resolution?.status === 'pending'
                  ? `הוצע על ידי ${resolution.proposed_by_name || 'מנהלת הסניף'} — ממתין לאישור הנהלת החשבונות`
                  : `${dayPunches.length} החתמות ביום אחד — צריך לסמן מה נכנס ומה יוצא`}
            </Typography>
            {(canDecideDay || canProposeDay) && (
              <Stack spacing={0.75}>
                {dayPunches.map(p => (
                  <Stack key={p._id} direction="row" spacing={1} alignItems="center">
                    <Typography sx={{ fontWeight: 700, minWidth: 48 }}>{israelHHmm(p.timestamp)}</Typography>
                    <ToggleButtonGroup
                      size="small" exclusive value={labels[p._id] || 'ignore'}
                      onChange={(_e, v) => { if (v) setLabels(l => ({ ...l, [p._id]: v })); }}
                    >
                      <ToggleButton value="in" sx={{ px: 1.2, py: 0.2 }}>כניסה</ToggleButton>
                      <ToggleButton value="out" sx={{ px: 1.2, py: 0.2 }}>יציאה</ToggleButton>
                      <ToggleButton value="ignore" sx={{ px: 1.2, py: 0.2 }}>התעלם</ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                ))}
                <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                    לפי הסימון: {(labelledMinutes / 60).toFixed(2)} שעות
                  </Typography>
                  <Button size="small" variant="contained" color={canDecideDay ? 'success' : 'primary'} onClick={decideDay}>
                    {canDecideDay ? (resolution?.status === 'approved' ? 'עדכן את האישור' : 'אשר את היום') : 'שלח לאישור הנה״ח'}
                  </Button>
                </Stack>
              </Stack>
            )}
          </Alert>
        )}

        {!isUnlinked && employee && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הוסף החתמה ידנית</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              אפשר להוסיף כמה החתמות לתאריכים שונים ברצף — הטבלה מתעדכנת אוטומטית אחרי כל פעולה.
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
