import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Alert, Divider, ToggleButton, ToggleButtonGroup, Paper,
  Tabs, Tab, TextField, CircularProgress, Badge,
} from '@mui/material';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import { toast } from 'react-toastify';
import api from '../../api/client';

const ROLE_LABEL = { in: 'כניסה', out: 'יציאה', ignore: 'התעלם' };
const ROLE_COLOR = { in: 'success', out: 'error', ignore: 'standard' };

// Σ(in→out), chronologically — never the out→in gaps.
function previewMinutes(punches, roles) {
  let total = 0, openIn = null;
  for (const p of punches) {
    const r = roles[p.id];
    if (r === 'in') openIn = p;
    else if (r === 'out' && openIn) {
      const [ah, am] = openIn.hhmm.split(':').map(Number);
      const [bh, bm] = p.hhmm.split(':').map(Number);
      total += Math.max(0, (bh * 60 + bm) - (ah * 60 + am));
      openIn = null;
    }
  }
  return total;
}
const asHours = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} (${Math.round(m / 60 * 100) / 100}h)`;

/**
 * One place for everything wrong with the month's punches, across ALL branches:
 *   • כפילויות — days with >2 punches. Each is labelled in/out/ignore and
 *     approved here; these are what block sending the month to the accountant.
 *   • חוסרים — days with a single punch (the in/out pair never completed). The
 *     accountant fills the missing time and it is added as a manual punch.
 */
export default function PunchIssuesDialog({ open, month, canFix, onClose, onChanged }) {
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ duplicates: [], missing: [] });
  const [roles, setRoles] = useState({});
  const [busy, setBusy] = useState({});
  const [fill, setFill] = useState({}); // key → {in, out}

  const load = useCallback(() => {
    if (!month) return;
    setLoading(true);
    api.get(`/payroll-month/${month}/punch-issues`)
      .then(r => {
        const d = r.data || { duplicates: [], missing: [] };
        setData(d);
        const init = {};
        for (const day of d.duplicates || []) {
          for (const p of day.punches) init[p.id] = p.suggested_role || 'ignore';
        }
        setRoles(init);
      })
      .catch(() => setData({ duplicates: [], missing: [] }))
      .finally(() => setLoading(false));
  }, [month]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const keyOf = (d) => `${d.employee_id}|${d.date}`;
  const setRole = (id, role) => { if (role) setRoles(r => ({ ...r, [id]: role })); };

  const approve = (day) => {
    const k = keyOf(day);
    setBusy(b => ({ ...b, [k]: true }));
    api.post('/payroll-month/punch-resolutions', {
      employee_id: day.employee_id,
      date: day.date,
      labels: day.punches.map(p => ({ punch_id: p.id, role: roles[p.id] || 'ignore' })),
    })
      .then(() => { toast.success(`${day.full_name} · ${day.date} אושר`); load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setBusy(b => ({ ...b, [k]: false })));
  };

  const addMissing = (item) => {
    const k = keyOf(item);
    const v = fill[k] || {};
    if (!v.in && !v.out) return toast.error('הזן/י שעה להשלמה');
    setBusy(b => ({ ...b, [k]: true }));
    api.post('/payroll/manual-punches', {
      employee_id: item.employee_id,
      date: item.date,
      in_time: v.in || undefined,
      out_time: v.out || undefined,
      note: 'השלמת החתמה חסרה (מסך בעיות בהחתמה)',
    })
      .then(() => { toast.success(`${item.full_name} · ${item.date} הושלם`); load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setBusy(b => ({ ...b, [k]: false })));
  };

  const dups = data.duplicates || [];
  const miss = data.missing || [];

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#b91c1c' }}>
        <ReportProblemIcon /> בעיות בהחתמה — {month}
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ textAlign: 'center', py: 5 }}><CircularProgress /></Box>
        ) : (
          <>
            <Alert severity={dups.length ? 'error' : 'success'} sx={{ mb: 2 }}>
              {dups.length
                ? `${dups.length} ימים עם יותר מ-2 החתמות ממתינים להחלטה — שליחת השכר לרו״ח חסומה עד לטיפול בכולם.`
                : 'אין כפילויות פתוחות — ניתן לשלוח לרו״ח.'}
              {miss.length > 0 && ` בנוסף ${miss.length} ימים עם החתמה חסרה (לא חוסמים, אך מומלץ להשלים).`}
            </Alert>
            <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
              <Tab label={<Badge color="error" badgeContent={dups.length}><Box sx={{ pl: 1.5 }}>כפילויות</Box></Badge>} />
              <Tab label={<Badge color="warning" badgeContent={miss.length}><Box sx={{ pl: 1.5 }}>חוסרים</Box></Badge>} />
            </Tabs>

            {tab === 0 && (dups.length === 0 ? (
              <Alert severity="success">אין ימים עם יותר מ-2 החתמות שממתינים להחלטה.</Alert>
            ) : (
              <Stack spacing={1.5}>
                {dups.map(day => {
                  const k = keyOf(day);
                  const mins = previewMinutes(day.punches, roles);
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fffbeb', borderColor: '#fde68a' }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 800 }}>{day.full_name}</Typography>
                        {day.branch_name && <Chip size="small" variant="outlined" label={day.branch_name} />}
                        <Chip size="small" color="error" label={day.date} />
                        <Chip size="small" label={`${day.punches.length} החתמות`} />
                        <Box sx={{ flex: 1 }} />
                        <Typography sx={{ fontWeight: 700 }}>לתשלום: {asHours(mins)}</Typography>
                      </Stack>
                      {day.suggestion_reason && (
                        <Alert severity="info" icon={false} sx={{ py: 0.2, mb: 1, fontSize: '0.78rem' }}>💡 {day.suggestion_reason}</Alert>
                      )}
                      <Stack spacing={0.8}>
                        {day.punches.map(p => (
                          <Stack key={p.id} direction="row" alignItems="center" spacing={1}>
                            <Typography sx={{ minWidth: 58, fontWeight: 700, fontFamily: 'monospace' }} dir="ltr">{p.hhmm}</Typography>
                            {p.is_manual && <Chip size="small" variant="outlined" color="secondary" label="ידני" sx={{ height: 18, fontSize: '0.6rem' }} />}
                            <ToggleButtonGroup size="small" exclusive value={roles[p.id] || 'ignore'}
                              onChange={(_e, v) => setRole(p.id, v)} disabled={!canFix}>
                              {['in', 'out', 'ignore'].map(r => (
                                <ToggleButton key={r} value={r} color={ROLE_COLOR[r]} sx={{ py: 0.2, px: 1.2, fontSize: '0.72rem' }}>
                                  {ROLE_LABEL[r]}
                                </ToggleButton>
                              ))}
                            </ToggleButtonGroup>
                          </Stack>
                        ))}
                      </Stack>
                      {canFix && (
                        <>
                          <Divider sx={{ my: 1 }} />
                          <Stack direction="row" justifyContent="flex-end">
                            <Button size="small" variant="contained" color="success"
                              disabled={busy[k]} onClick={() => approve(day)}>אשר יום</Button>
                          </Stack>
                        </>
                      )}
                    </Paper>
                  );
                })}
              </Stack>
            ))}

            {tab === 1 && (miss.length === 0 ? (
              <Alert severity="success">אין ימים עם החתמה חסרה.</Alert>
            ) : (
              <Stack spacing={1.5}>
                {miss.map(item => {
                  const k = keyOf(item);
                  const v = fill[k] || {};
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fff7ed', borderColor: '#fed7aa' }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 800 }}>{item.full_name}</Typography>
                        {item.branch_name && <Chip size="small" variant="outlined" label={item.branch_name} />}
                        <Chip size="small" color="warning" label={item.date} />
                        <Chip size="small" label={`החתמה יחידה: ${item.punch_hhmm}`} />
                        {item.is_manual && <Chip size="small" variant="outlined" color="secondary" label="ידני" />}
                      </Stack>
                      {canFix && (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="caption" color="text.secondary">השלמה:</Typography>
                          <TextField size="small" type="time" label="כניסה" InputLabelProps={{ shrink: true }}
                            value={v.in || ''} onChange={e => setFill(f => ({ ...f, [k]: { ...v, in: e.target.value } }))} sx={{ width: 130 }} />
                          <TextField size="small" type="time" label="יציאה" InputLabelProps={{ shrink: true }}
                            value={v.out || ''} onChange={e => setFill(f => ({ ...f, [k]: { ...v, out: e.target.value } }))} sx={{ width: 130 }} />
                          <Button size="small" variant="contained" disabled={busy[k]} onClick={() => addMissing(item)}>הוסף</Button>
                          <Typography variant="caption" color="text.secondary">מלא/י רק את החסר</Typography>
                        </Stack>
                      )}
                    </Paper>
                  );
                })}
              </Stack>
            ))}
            {!canFix && <Alert severity="warning" sx={{ mt: 2 }}>תצוגה בלבד — רק הנהלת חשבונות או מנהל מערכת יכולים לתקן.</Alert>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={load}>רענן</Button>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
