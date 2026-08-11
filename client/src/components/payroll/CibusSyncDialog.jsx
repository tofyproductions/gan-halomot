import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Typography, Alert, Paper, Chip, Switch, FormControlLabel, LinearProgress,
  Divider, Table, TableHead, TableBody, TableRow, TableCell, MenuItem, Tooltip,
} from '@mui/material';
import RestaurantIcon from '@mui/icons-material/Restaurant';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * ייבוא סיבוס אוטומטי.
 *
 * The unknown here is what Pluxee's scheduled email actually looks like, so the
 * screen leads with "סרוק תיבה": it lists what is really sitting in the mailbox
 * and the rules are set from that, instead of being guessed and then silently
 * matching nothing every month.
 */

const STATUS = {
  ok: { label: 'הצליח', color: 'success' },
  empty: { label: 'לא נמצא מייל', color: 'warning' },
  error: { label: 'שגיאה', color: 'error' },
};

const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function CibusSyncDialog({ open, month, onClose, onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [mail, setMail] = useState(null);
  const [nextMonth, setNextMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(null);

  const load = useCallback(() => {
    setBusy(true);
    api.get('/cibus-sync')
      .then(r => { setCfg(r.data.config); setMail(r.data.mail); setNextMonth(r.data.next_month); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => { if (open) { setScan(null); load(); } }, [open, load]);

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  const save = async (patch) => {
    setBusy(true);
    try {
      const r = await api.put('/cibus-sync', { ...cfg, ...patch });
      setCfg(r.data.config);
      toast.success('נשמר');
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); load(); }
    finally { setBusy(false); }
  };

  const testConn = async () => {
    setBusy(true);
    try {
      const r = await api.post('/cibus-sync/test');
      if (r.data.ok) toast.success(`חיבור תקין — ${r.data.mailbox} (${r.data.messages} הודעות)`);
      else toast.error(r.data.error);
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
    finally { setBusy(false); }
  };

  const doScan = async (applyRules) => {
    setBusy(true); setScan(null);
    try {
      const r = await api.post('/cibus-sync/scan', { days: 45, applyRules });
      setScan(r.data);
      if (!r.data.messages.length) toast.info(applyRules ? 'אין מיילים שתואמים לכללים' : 'לא נמצאו מיילים ב-45 הימים האחרונים');
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
    finally { setBusy(false); }
  };

  const runNow = async (dryRun) => {
    setBusy(true);
    try {
      const r = await api.post('/cibus-sync/run', { month, dryRun });
      const run = r.data.run;
      if (run.status === 'ok') {
        toast.success(`${dryRun ? 'בדיקה: ' : ''}שויכו ${run.matched_count} עובדות · ₪${Math.round(run.total_amount)}${run.unmatched_count ? ` · ${run.unmatched_count} ללא התאמה` : ''}`);
      } else {
        toast.warning(run.message || STATUS[run.status]?.label);
      }
      load();
      if (!dryRun && run.status === 'ok') onChanged && onChanged();
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        <RestaurantIcon sx={{ color: '#0f766e' }} /> ייבוא סיבוס אוטומטי
      </DialogTitle>
      <DialogContent dividers>
        {busy && <LinearProgress sx={{ mb: 1 }} />}
        {!cfg ? null : (
          <Stack spacing={2}>
            {!mail?.configured ? (
              <Alert severity="warning">
                <b>לשרת אין עדיין פרטי תיבת מייל.</b> יש להוסיף ב-Render (Environment) את המשתנים
                <code> CIBUS_MAIL_USER</code> — <b>כתובת המייל של התיבה</b> שאליה סיבוס שולח את הדוח —
                ו-<code>CIBUS_MAIL_PASS</code> — <b>סיסמת אפליקציה</b> של אותה תיבה.
                ב-Gmail חייבים <b>App Password</b>, לא סיסמת החשבון.
                <b>אלו אינם שם המשתמש והסיסמה בפורטל סיבוס</b> — המערכת לא נכנסת לפורטל,
                היא קוראת את המייל שסיבוס שולח. הסיסמה נשמרת רק שם, לא במסד ולא במסך הזה.
              </Alert>
            ) : (
              <Alert severity="success" icon={false}>
                תיבה מחוברת: <b>{mail.user}</b> ({mail.host}) ·{' '}
                <Button size="small" onClick={testConn}>בדוק חיבור</Button>
              </Alert>
            )}

            {/* Discovery first — the rules come from what is really there. */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, bgcolor: '#f0fdfa', borderColor: '#99f6e4' }}>
              <Typography sx={{ fontWeight: 800, mb: 0.5 }}>שלב 1 — למצוא את המייל</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                סורק 45 יום אחורה ומציג <b>שולח, נושא ושמות הקבצים המצורפים בלבד</b> — לא תוכן ההודעות.
                מכאן מעתיקים את השולח/הנושא לכללים למטה.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" size="small" disabled={busy || !mail?.configured}
                  onClick={() => doScan(false)}>סרוק את כל התיבה</Button>
                <Button variant="outlined" size="small" disabled={busy || !mail?.configured}
                  onClick={() => doScan(true)}>סרוק לפי הכללים הנוכחיים</Button>
              </Stack>

              {scan && (
                <Table size="small" sx={{ mt: 1.5, bgcolor: '#fff' }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>שולח</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>נושא</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>קבצים</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {scan.messages.map((m, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmt(m.date)}</TableCell>
                        <TableCell sx={{ fontSize: '0.75rem', direction: 'ltr', textAlign: 'left' }}>{m.from}</TableCell>
                        <TableCell sx={{ fontSize: '0.78rem' }}>{m.subject}</TableCell>
                        <TableCell>
                          {m.attachments.length
                            ? m.attachments.map(a => <Chip key={a.filename} size="small" color="success" label={a.filename} sx={{ maxWidth: 190 }} />)
                            : (m.has_links
                              ? <Tooltip title={m.links.join('\n')}><Chip size="small" color="warning" label="קישור בגוף המייל" /></Tooltip>
                              : <Typography variant="caption" color="text.disabled">—</Typography>)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!scan.messages.length && (
                      <TableRow><TableCell colSpan={4}>
                        <Typography variant="body2" color="text.secondary">לא נמצאו הודעות.</Typography>
                      </TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </Paper>

            {/* Rules */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 800, mb: 1.5 }}>שלב 2 — כללי זיהוי</Typography>
              <Stack spacing={1.5}>
                <TextField size="small" label="שולח מכיל (מופרד בפסיקים)"
                  value={(cfg.from_contains || []).join(', ')}
                  onChange={e => set('from_contains', e.target.value.split(','))}
                  helperText="די בהתאמה אחת. לדוגמה: pluxee, cibus"
                />
                <TextField size="small" label="נושא מכיל (מופרד בפסיקים)"
                  value={(cfg.subject_contains || []).join(', ')}
                  onChange={e => set('subject_contains', e.target.value.split(','))}
                  helperText="ריק = לא בודקים נושא"
                />
                <Stack direction="row" spacing={1.5}>
                  <TextField select size="small" label="לאיזה חודש לייבא" sx={{ minWidth: 200 }}
                    value={cfg.month_offset} onChange={e => set('month_offset', Number(e.target.value))}>
                    <MenuItem value={-1}>החודש הקודם (רגיל)</MenuItem>
                    <MenuItem value={0}>החודש הנוכחי</MenuItem>
                    <MenuItem value={-2}>לפני חודשיים</MenuItem>
                  </TextField>
                  <TextField size="small" type="number" label="מתחיל לבדוק ביום" sx={{ width: 160 }}
                    value={cfg.run_from_day} onChange={e => set('run_from_day', Number(e.target.value))}
                    helperText="בחודש" />
                </Stack>
                <FormControlLabel
                  control={<Switch checked={!!cfg.mark_seen} onChange={e => set('mark_seen', e.target.checked)} />}
                  label={<Typography variant="body2">סמן את המייל כנקרא אחרי ייבוא</Typography>}
                />
                <Button variant="outlined" onClick={() => save({})} disabled={busy}>שמור כללים</Button>
              </Stack>
            </Paper>

            {/* Run + switch */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>שלב 3 — הרצה</Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                <Button variant="outlined" size="small" disabled={busy} onClick={() => runNow(true)}>
                  הרצת בדיקה (לא שומר)
                </Button>
                <Button variant="contained" size="small" disabled={busy} onClick={() => runNow(false)}>
                  ייבא עכשיו לחודש {month}
                </Button>
              </Stack>
              <FormControlLabel
                control={<Switch checked={!!cfg.enabled} disabled={!mail?.configured}
                  onChange={e => save({ enabled: e.target.checked })} />}
                label={<Typography variant="body2" sx={{ fontWeight: 700 }}>
                  ייבוא אוטומטי חודשי — הבא: {nextMonth}
                </Typography>}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                רץ כל שעה מיום {cfg.run_from_day} בחודש ועד שהחודש נקלט, כך שמייל שמאחר לא מדלג על החודש.
              </Typography>
              {cfg.last_error && <Alert severity="error" sx={{ mt: 1 }}>{cfg.last_error}</Alert>}
            </Paper>

            {/* History — a scheduled import that stops working must be visible. */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>
                יומן הרצות · הצלחה אחרונה: {fmt(cfg.last_success_at)}{cfg.last_success_month ? ` (${cfg.last_success_month})` : ''}
              </Typography>
              {!(cfg.runs || []).length ? (
                <Typography variant="body2" color="text.secondary">עדיין לא רצה.</Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>מתי</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>חודש</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>שויכו</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>סכום</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>הערה</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {cfg.runs.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmt(r.at)}</TableCell>
                        <TableCell>{r.month}</TableCell>
                        <TableCell>
                          <Chip size="small" color={STATUS[r.status]?.color} label={STATUS[r.status]?.label || r.status} />
                        </TableCell>
                        <TableCell>{r.matched_count || 0}{r.unmatched_count ? ` (${r.unmatched_count} ללא)` : ''}</TableCell>
                        <TableCell>{r.total_amount ? `₪${Math.round(r.total_amount)}` : '—'}</TableCell>
                        <TableCell sx={{ fontSize: '0.72rem' }}>{r.message || r.file_name || ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {/* Names in the report with no employee behind them are money
                  nobody was charged for — surface them, don't bury them. */}
              {(cfg.runs || [])[0]?.unmatched?.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  לא שויכו בהרצה האחרונה: {cfg.runs[0].unmatched.map(u => `${u.name || u.id} (₪${Math.round(u.amount)})`).join(' · ')}
                </Alert>
              )}
            </Paper>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
