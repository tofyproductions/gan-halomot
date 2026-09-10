import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack, Typography,
  Paper, Chip, IconButton, Tooltip, TextField, CircularProgress, Alert, Divider,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * "עובדים שלי בסניפים אחרים" — every correction another branch's manager has
 * asked for on one of MY employees, this month.
 *
 * A branch manager only ever sees an aggregate "away hours" number for an
 * employee who clocked at another gan (see attendanceByMonth's away_days) —
 * she has no way to see WHAT happened there, let alone that another manager
 * is asking her to bless a time change. This screen is that missing half:
 * per employee, per month, every such request — pending or already decided —
 * so nothing about her own employee's pay is ever decided somewhere she
 * cannot see.
 *
 * Approval/rejection go through the SAME punch endpoints every other
 * correction uses (`/payroll/punches/:id/approve|reject`) — this is a
 * reading + routing surface, not a second approval mechanism. The server
 * (crossBranchEditGate in payroll.controller.js) is what actually enforces
 * that only this employee's own manager — or system_admin/accountant — may
 * act on a still-pending one.
 */

const STATUS_META = {
  pending_manager: { label: 'ממתין לאישורך', color: 'warning' },
  pending_accountant: { label: 'אישרת — ממתין להנה״ח', color: 'info' },
  approved: { label: 'אושר סופית', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');

export default function CrossBranchEdits({ open, onClose, month, onCountChange, onChanged }) {
  const { isAdmin, isAccountant } = useAuth();
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState([]);
  const [reject, setReject] = useState({ open: false, edit: null, note: '', busy: false });
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll/cross-branch-edits', { params: { month } })
      .then((res) => {
        const list = res.data?.edits || [];
        setEdits(list);
        if (onCountChange) onCountChange(list.filter(e => e.status === 'pending_manager').length);
      })
      .catch(() => setEdits([]))
      .finally(() => setLoading(false));
  }, [month, onCountChange]);

  // Loaded whether the dialog is open or not — this is also where the
  // toolbar badge count comes from.
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const byEmp = new Map();
    for (const e of edits) {
      const key = String(e.employee_id || e.employee_name);
      if (!byEmp.has(key)) {
        byEmp.set(key, { key, employee_name: e.employee_name || '—', items: [] });
      }
      byEmp.get(key).items.push(e);
    }
    return [...byEmp.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name, 'he'));
  }, [edits]);

  const doApprove = (e) => {
    setBusyId(e._id);
    api.patch(`/payroll/punches/${e.punch_id}/approve`)
      .then(() => {
        toast.success(e.status === 'pending_manager' ? 'אושר — עבר להנה״ח לאישור סופי' : 'אושר סופית');
        load();
        onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה באישור'))
      .finally(() => setBusyId(null));
  };

  const doReject = () => {
    const { edit, note } = reject;
    if (!edit) return;
    setReject(r => ({ ...r, busy: true }));
    api.patch(`/payroll/punches/${edit.punch_id}/reject`, { note })
      .then(() => {
        toast.success('התיקון נדחה — ההחתמה המקורית נשארה כפי שהייתה');
        load();
        onChanged && onChanged();
        setReject({ open: false, edit: null, note: '', busy: false });
      })
      .catch((err) => {
        toast.error(err.response?.data?.error || 'שגיאה בדחייה');
        setReject(r => ({ ...r, busy: false }));
      });
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth dir="rtl">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PeopleAltIcon color="secondary" />
          עובדים שלי בסניפים אחרים
        </DialogTitle>
        <DialogContent dividers>
          <Alert severity="info" icon={false} sx={{ mb: 2 }}>
            כשעובדת שלך מחתימה בסניף של מנהל/ת אחר/ת, והוא/היא מתקן/ת לה שעה — התיקון מגיע לכאן.
            עד שתאשרי אותו הוא לא נכנס לשכר, ואחרי שתאשרי הוא עדיין עובר להנהלת חשבונות כמו כל תיקון אחר.
          </Alert>

          {loading && <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={28} /></Box>}
          {!loading && !groups.length && (
            <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              אין השבוע/החודש שינויים לעובדים שלך בסניפים אחרים.
            </Typography>
          )}

          <Stack spacing={2}>
            {groups.map(group => (
              <Paper key={group.key} variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
                <Typography sx={{ fontWeight: 700, mb: 1 }}>{group.employee_name}</Typography>
                <Stack spacing={1}>
                  {group.items.map((e) => {
                    const meta = STATUS_META[e.status] || { label: e.status, color: 'default' };
                    const canAct = e.status === 'pending_manager' && !busyId;
                    return (
                      <Box key={e._id} sx={{ p: 1, borderRadius: 2, bgcolor: 'grey.50' }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip size="small" color="default" variant="outlined" label={e.host_branch_name} />
                          <Typography variant="body2">
                            {fmtDate(e.prev_timestamp)} · {fmtTime(e.prev_timestamp)} ← <b>{fmtTime(e.requested_timestamp)}</b>
                          </Typography>
                          <Box sx={{ flex: 1 }} />
                          <Chip size="small" color={meta.color} label={meta.label}
                            variant={e.status === 'pending_manager' ? 'filled' : 'outlined'} />
                          {canAct && (
                            <>
                              <Tooltip title="אשר — יעבור להנה״ח">
                                <IconButton size="small" color="success" onClick={() => doApprove(e)} disabled={busyId === e._id}>
                                  <CheckCircleIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="דחה — ההחתמה המקורית תישאר">
                                <IconButton size="small" color="error"
                                  onClick={() => setReject({ open: true, edit: e, note: '', busy: false })}>
                                  <CancelIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </>
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                          ביקש/ה: {e.requested_by_name || '—'} · {fmtDateTime(e.requested_at)}
                          {e.note ? ` · "${e.note}"` : ''}
                        </Typography>
                        {(e.status === 'pending_accountant' || e.status === 'approved') && e.manager_decided_by_name && (
                          <Typography variant="caption" color="success.main" display="block">
                            אישרת: {e.manager_decided_by_name} · {fmtDateTime(e.manager_decided_at)}
                          </Typography>
                        )}
                        {e.status === 'approved' && (
                          <Typography variant="caption" color="success.main" display="block">
                            אישור סופי: {e.final_decided_by_name || '—'} · {fmtDateTime(e.final_decided_at)}
                          </Typography>
                        )}
                        {e.status === 'rejected' && (
                          <Typography variant="caption" color="error.main" display="block">
                            נדחה ע״י: {e.final_decided_by_name || '—'} · {fmtDateTime(e.final_decided_at)}
                            {e.final_decided_note ? ` · "${e.final_decided_note}"` : ''}
                          </Typography>
                        )}
                      </Box>
                    );
                  })}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>סגירה</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={reject.open} onClose={() => setReject({ open: false, edit: null, note: '', busy: false })} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>דחיית תיקון</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            ההחתמה המקורית תישאר כפי שהייתה — הדחייה היא רק על התיקון המבוקש.
          </Typography>
          <TextField
            autoFocus fullWidth multiline minRows={2}
            label="סיבת הדחייה (אופציונלי)"
            value={reject.note}
            onChange={e => setReject(r => ({ ...r, note: e.target.value }))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReject({ open: false, edit: null, note: '', busy: false })} disabled={reject.busy}>ביטול</Button>
          <Button variant="contained" color="error" onClick={doReject} disabled={reject.busy}>דחה</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
