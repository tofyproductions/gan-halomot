import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, Collapse,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import {
  applyDecision, approvalMessage, rejectionMessage, stageOf, manualSource,
  STAGE_LABEL, STAGE_ORDER,
} from './punchApproval';

/**
 * Manual punches waiting on review, in the order the approval chain actually
 * runs: what the branch manager still owes, then what the accountant still owes.
 *
 * Approval is TWO stages. A manager approving an employee's report does not put
 * the hours in the salary — it hands the punch to the accountant. This banner
 * used to remove the row on any successful PATCH and say "אושר", so an
 * accountant or an admin, who sees both stages, would confirm a punch in one
 * click, watch it disappear, and be told it was approved when it was in fact
 * parked at a stage they could no longer reach without reloading. The list is
 * now redrawn from the punch the server sends back (see `punchApproval.js`),
 * and every row states which desk it is on.
 *
 * `onChanged` matters as much as the display: approving a punch changes what
 * counts in the salary, which changes the month's punch problems (a day that
 * reaches three counted readings becomes a "החתמה כפולה" that blocks the send).
 * The screens showing those numbers have to be told.
 */
export default function PendingPunchApprovals({ onChanged }) {
  const { isAdmin, isAccountant } = useAuth();
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [reject, setReject] = useState({ open: false, punch: null, note: '' });
  // Per-group full-day context: what the employee's day actually looks like —
  // clock punches, other reports, their statuses — fetched on demand so the
  // accountant approves against the whole day, not a bare time.
  const [dayCtx, setDayCtx] = useState({}); // group.key → { loading, punches } | undefined (closed)

  const toggleDayCtx = (group) => {
    setDayCtx(prev => {
      if (prev[group.key]) { const next = { ...prev }; delete next[group.key]; return next; }
      return { ...prev, [group.key]: { loading: true, punches: [] } };
    });
    if (dayCtx[group.key]) return; // was open — just closed it
    api.get('/payroll/punches/day', { params: { employee_id: group.employee_db_id, date: group.iso_date } })
      .then(res => {
        const list = (res.data?.punches || [])
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        setDayCtx(prev => (prev[group.key] ? { ...prev, [group.key]: { loading: false, punches: list } } : prev));
      })
      .catch(() => {
        toast.error('טעינת יום ההחתמות נכשלה');
        setDayCtx(prev => { const next = { ...prev }; delete next[group.key]; return next; });
      });
  };

  const DAY_SRC = { manual: 'ידני', fixed_schedule: 'שעות קבועות', closure_completion: 'בונוס אוגוסט' };
  const DAY_STATUS = {
    auto: { label: 'שעון', color: 'success' },
    approved: { label: 'מאושר', color: 'success' },
    pending: { label: 'ממתין', color: 'warning' },
    pending_manager: { label: 'ממתין למנהל', color: 'warning' },
    pending_accountant: { label: 'ממתין להנה״ח', color: 'warning' },
    rejected: { label: 'נדחה', color: 'error' },
  };
  // Accounting/admin approving a stage-1 row directly — the branch manager
  // never got to look at it. See services/decisions.js for how she's told.
  const [bypassConfirm, setBypassConfirm] = useState({ open: false, punch: null, busy: false });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll/punches/pending')
      .then(res => setPunches([...(res.data.pending_manager || []), ...(res.data.pending_accountant || [])]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const doApprove = (id, body) => api.patch(`/payroll/punches/${id}/approve`, body)
    .then((res) => {
      const updated = res.data?.punch;
      toast.success(approvalMessage(updated));
      setPunches(p => applyDecision(p, id, updated));
      // An answer without a punch tells us nothing about where it landed —
      // reload rather than guess.
      if (!updated) load();
      onChanged && onChanged();
    })
    .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));

  // Clicking ✓ on a stage-1 row is the normal handoff for a branch manager.
  // For accounting/admin it's a decision to skip her review entirely — that
  // needs the explicit warning + confirmation, never a plain click.
  const approve = (p) => {
    if (stageOf(p) === 'manager' && (isAdmin || isAccountant)) {
      setBypassConfirm({ open: true, punch: p, busy: false });
      return;
    }
    doApprove(p._id);
  };

  const confirmBypass = () => {
    const p = bypassConfirm.punch;
    if (!p) return;
    setBypassConfirm(s => ({ ...s, busy: true }));
    doApprove(p._id, { override_manager: true })
      .finally(() => setBypassConfirm({ open: false, punch: null, busy: false }));
  };

  const doReject = () => {
    const { punch, note } = reject;
    if (!punch) return;
    api.patch(`/payroll/punches/${punch._id}/reject`, { note })
      .then((res) => {
        const updated = res.data?.punch;
        toast.success(rejectionMessage(updated));
        setPunches(p => applyDecision(p, punch._id, updated));
        if (!updated) load();
        setReject({ open: false, punch: null, note: '' });
        onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Two sections, each grouped by employee+date inside. A row's stage is read
  // from the punch itself, so a punch that moved up a stage moves section
  // without a round trip.
  const sections = useMemo(() => {
    const byStage = new Map(STAGE_ORDER.map(s => [s, new Map()]));
    for (const p of punches) {
      const stage = stageOf(p) || 'manager';
      const groups = byStage.get(stage);
      if (!groups) continue;
      const key = `${p.employee_id?._id || 'no-emp'}-${new Date(p.timestamp).toLocaleDateString('he-IL')}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          employee_name: p.employee_id?.full_name || '—',
          israeli_id: p.employee_id?.israeli_id || '',
          employee_db_id: p.employee_id?._id || null,
          iso_date: new Date(p.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }),
          date: new Date(p.timestamp).toLocaleDateString('he-IL'),
          items: [],
        });
      }
      groups.get(key).items.push(p);
    }
    return STAGE_ORDER
      .map(stage => ({ stage, groups: [...byStage.get(stage).values()] }))
      .filter(s => s.groups.length > 0);
  }, [punches]);

  if (loading && punches.length === 0) return null;
  if (punches.length === 0) return null;

  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 3, mb: 2, p: 2, borderColor: 'warning.main', bgcolor: 'warning.50' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: expanded ? 1.5 : 0 }}>
          <PendingActionsIcon color="warning" />
          <Typography variant="subtitle1" sx={{ fontWeight: 800, flex: 1 }}>
            דיווחים ממתינים לאישור
          </Typography>
          <Chip label={`${punches.length} פריטים`} size="small" color="warning" />
          <IconButton size="small" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>

        <Collapse in={expanded}>
          <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }} icon={false}>
            החתמות ידניות ממתינות. האישור הוא בשני שלבים — מנהל/ת הסניף ואז הנה״ח.
            רק לאחר האישור הסופי של הנה״ח הן נכנסות לשכר.
          </Alert>

          <Stack spacing={2}>
            {sections.map(({ stage, groups }) => (
              <Box key={stage}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.8 }}>
                  <Chip
                    size="small"
                    label={STAGE_LABEL[stage]}
                    color={stage === 'accountant' ? 'warning' : 'default'}
                    variant={stage === 'accountant' ? 'filled' : 'outlined'}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {groups.reduce((n, g) => n + g.items.length, 0)} החתמות
                  </Typography>
                </Stack>

                <Stack spacing={1}>
                  {groups.map(group => (
                    <Paper key={group.key} variant="outlined" sx={{ borderRadius: 2, p: 1.2 }}>
                      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                        <Typography sx={{ fontWeight: 700, minWidth: 130 }}>{group.employee_name}</Typography>
                        <Typography variant="caption" color="text.secondary">{group.date}</Typography>
                        {group.employee_db_id && (
                          <Tooltip title="הצג את כל החתמות היום — שעון ודיווחים — לפני האישור">
                            <Chip
                              size="small" variant={dayCtx[group.key] ? 'filled' : 'outlined'} color="info"
                              label={dayCtx[group.key] ? 'הסתר יום' : '🕐 הצג יום מלא'}
                              onClick={() => toggleDayCtx(group)}
                              sx={{ height: 20, fontSize: '0.65rem', cursor: 'pointer' }}
                            />
                          </Tooltip>
                        )}
                        <Box sx={{ flex: 1 }} />
                        {group.items.map((p) => {
                          const src = manualSource(p, p.employee_id);
                          return (
                            <Stack key={p._id} direction="row" spacing={0.5} alignItems="center" sx={{ bgcolor: 'background.paper', borderRadius: 2, px: 1, py: 0.3 }}>
                              <Chip
                                size="small" label={p.state === 0 ? 'כניסה' : 'יציאה'}
                                color={p.state === 0 ? 'primary' : 'default'} variant="outlined"
                              />
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {new Date(p.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                              </Typography>
                              {/* Who typed this in. An employee reporting her own day and a
                                  manager filling one in are different claims about the hours. */}
                              <Tooltip title={src.key === 'unknown' ? 'נוצר לפני שהמערכת תיעדה מי מזין' : `הוזן ע״י ${src.label}`}>
                                <Chip
                                  size="small"
                                  label={src.label}
                                  variant="outlined"
                                  color={src.key === 'self' ? 'info' : 'default'}
                                />
                              </Tooltip>
                              {p.manual_note && (
                                <Tooltip title={p.manual_note}>
                                  <Chip size="small" label="הערה" variant="outlined" />
                                </Tooltip>
                              )}
                              <Tooltip title={stage === 'accountant'
                                ? 'אשר סופית — ייכנס לשכר'
                                : (isAdmin || isAccountant) ? 'אשר ישירות — עוקף את מנהל/ת הסניף' : 'אשר והעבר להנה״ח'}>
                                <IconButton size="small" color="success" onClick={() => approve(p)}>
                                  <CheckCircleIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="דחה">
                                <IconButton size="small" color="error" onClick={() => setReject({ open: true, punch: p, note: '' })}>
                                  <CancelIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Stack>
                          );
                        })}
                      </Stack>
                      {dayCtx[group.key] && (
                        <Box sx={{ mt: 1, p: 1, borderRadius: 2, bgcolor: '#f0f9ff', border: '1px solid #bae6fd' }}>
                          {dayCtx[group.key].loading ? (
                            <Typography variant="caption" color="text.secondary">טוען את היום…</Typography>
                          ) : dayCtx[group.key].punches.length === 0 ? (
                            <Typography variant="caption" color="text.secondary">
                              אין החתמות נוספות ביום זה — הדיווח הממתין הוא כל מה שיש. אישורו ישאיר את היום עם החתמה בודדת.
                            </Typography>
                          ) : (
                            <>
                              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                                כל החתמות היום ({group.date}):
                              </Typography>
                              <Stack direction="row" spacing={0.7} flexWrap="wrap" useFlexGap>
                                {dayCtx[group.key].punches.map(dp => {
                                  const st = DAY_STATUS[dp.approval_status || 'auto'] || { label: dp.approval_status, color: 'default' };
                                  const isThisPending = group.items.some(it => it._id === dp._id);
                                  return (
                                    <Chip
                                      key={dp._id}
                                      size="small"
                                      variant={isThisPending ? 'filled' : 'outlined'}
                                      color={st.color}
                                      label={`${new Date(dp.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · ${DAY_SRC[dp.timestamp_source] || 'שעון'} · ${st.label}`}
                                      sx={{ height: 22, fontSize: '0.68rem', fontWeight: isThisPending ? 800 : 500 }}
                                    />
                                  );
                                })}
                              </Stack>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                המודגש הוא הדיווח שממתין כאן — אשרו/דחו אותו בכפתורים שבשורה למעלה.
                              </Typography>
                            </>
                          )}
                        </Box>
                      )}
                    </Paper>
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        </Collapse>
      </Paper>

      <Dialog open={reject.open} onClose={() => setReject({ open: false, punch: null, note: '' })} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>דחיית דיווח</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={3}
            label="סיבת הדחייה (אופציונלי)"
            value={reject.note}
            onChange={e => setReject(r => ({ ...r, note: e.target.value }))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReject({ open: false, punch: null, note: '' })}>ביטול</Button>
          <Button variant="contained" color="error" onClick={doReject}>דחה</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={bypassConfirm.open} onClose={() => setBypassConfirm({ open: false, punch: null, busy: false })} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberIcon color="warning" />
          אישור עוקף מנהל/ת סניף
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 1 }}>
            אישור זה עוקף את מנהל/ת הסניף ושולח לה/לו התראה.
          </Alert>
          <Typography variant="body2" color="text.secondary">
            מנהל/ת הסניף עדיין לא בדק/ה את הדיווח הזה. אישור ישיר ידלג על השלב שלה/ו ויכניס את ההחתמה לשכר מיד — היא/הוא תקבל/י הודעה שהאישור בוצע בלעדיה/ו.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBypassConfirm({ open: false, punch: null, busy: false })} disabled={bypassConfirm.busy}>ביטול</Button>
          <Button variant="contained" color="warning" onClick={confirmBypass} disabled={bypassConfirm.busy}>
            אשר בכל זאת
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
