import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Button, Card, CardContent, Stack, Chip, Tabs, Tab, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, AlertTitle,
  CircularProgress, Tooltip, IconButton, Divider, FormControlLabel, Checkbox,
  MenuItem,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import PhoneIcon from '@mui/icons-material/Phone';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import BlockIcon from '@mui/icons-material/Block';
import PhoneMissedIcon from '@mui/icons-material/PhoneMissed';
import HistoryIcon from '@mui/icons-material/History';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/**
 * גיוס עובדים — the screen a manager works from.
 *
 * One list, not three. A new applicant, somebody to try again after a missed
 * call, and somebody parked until March are all the same job on the day they
 * come due — call this person — and splitting them would only ask the manager
 * to remember to look in three places.
 */

const VIEWS = [
  { key: 'due', label: 'לטיפול' },
  { key: 'scheduled', label: 'ראיונות' },
  // Interviews that have already happened and nobody has said what came of
  // them. Its own tab because it is its own job: the manager who invited them
  // has finished, and somebody has to close the loop.
  { key: 'interviewed', label: 'ממתין להחלטה' },
  { key: 'decided', label: 'הוחלט' },
  { key: 'archived', label: 'ארכיון' },
];

const OUTCOME_LABELS = {
  hired: 'התקבל/ה',
  rejected: 'לא התקבל/ה',
  no_show: 'לא הגיע/ה',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');
const fmtWhen = (d) => (d
  ? new Date(d).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '');

/** A local datetime string the <input type="datetime-local"> accepts. */
function defaultInterviewSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RecruitmentPage() {
  const { branches } = useBranch();
  const [view, setView] = useState(0);
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [search, setSearch] = useState('');
  // Narrows the list to one branch (or to 'office' — candidates with no
  // branch). On top of the server's scope, never instead of it.
  const [branchFilter, setBranchFilter] = useState('');
  const [invite, setInvite] = useState(null);
  const [reject, setReject] = useState(null);
  const [history, setHistory] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [move, setMove] = useState(null);

  const viewKey = VIEWS[view].key;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = search.trim() ? { q: search.trim() } : { view: viewKey };
      if (branchFilter) params.branch_filter = branchFilter;
      const [list, c] = await Promise.all([
        api.get('/recruitment', { params }),
        api.get('/recruitment/counts'),
      ]);
      setRows(list.data.candidates || []);
      setCounts(c.data || {});
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת מועמדים');
    } finally {
      setLoading(false);
    }
  }, [viewKey, search, branchFilter]);

  useEffect(() => { load(); }, [load]);

  const handlePull = async () => {
    setPulling(true);
    try {
      const res = await api.post('/recruitment/pull');
      toast.success(res.data.summary || 'נמשך');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה במשיכה');
    } finally {
      setPulling(false);
    }
  };

  const noAnswer = async (row) => {
    try {
      const res = await api.post(`/recruitment/${row.id}/no-answer`);
      toast.info(res.data.status === 'archived'
        ? `${row.full_name} עבר/ה לארכיון אחרי ${res.data.attempts} ניסיונות`
        : `נרשם. לחזור ב־${fmtDate(res.data.next_action_at)}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const saveInvite = async () => {
    try {
      const res = await api.post(`/recruitment/${invite.row.id}/interview`, {
        at: invite.at, note: invite.note,
      });
      // Handed over rather than sent: the link opens WhatsApp with the message
      // ready and the manager presses send. Nothing leaves on its own.
      setInvite({ ...invite, saved: true, whatsapp_url: res.data.whatsapp_url });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בקביעת הראיון');
    }
  };

  const saveOutcome = async () => {
    try {
      await api.post(`/recruitment/${outcome.row.id}/outcome`, {
        result: outcome.result,
        reason: outcome.reason,
        future_relevant: outcome.future,
        callback_at: outcome.future ? outcome.callback : null,
      });
      toast.success('נשמר');
      setOutcome(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const noShow = async (row) => {
    try {
      const res = await api.post(`/recruitment/${row.id}/outcome`, { result: 'no_show' });
      toast.info(res.data.status === 'archived'
        ? `${row.full_name} לא הגיע/ה פעמיים — עבר/ה לארכיון`
        : `${row.full_name} חזר/ה לרשימת הטיפול לתיאום ראיון חדש`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const saveMove = async () => {
    try {
      const res = await api.post(`/recruitment/${move.row.id}/reschedule`, { at: move.at });
      setMove({ ...move, saved: true, whatsapp_url: res.data.whatsapp_url });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const saveReject = async () => {
    try {
      await api.post(`/recruitment/${reject.row.id}/not-relevant`, {
        reason: reject.reason,
        future_relevant: reject.future,
        callback_at: reject.future ? reject.callback : null,
      });
      toast.success('נשמר');
      setReject(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>גיוס עובדים</Typography>
          <Typography variant="body2" color="text.secondary">
            פניות מטופס הגיוס באתר, ממוינות לסניף המבוקש
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <TextField
            select size="small" label="סניף" value={branchFilter}
            onChange={e => setBranchFilter(e.target.value)} sx={{ minWidth: 150 }}
          >
            <MenuItem value="">כל הסניפים</MenuItem>
            {branches.map(b => (
              <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
            ))}
            <MenuItem value="office">מענה כללי / ללא שיוך</MenuItem>
          </TextField>
          <TextField
            size="small" placeholder="חיפוש שם או טלפון" value={search}
            onChange={e => setSearch(e.target.value)} sx={{ minWidth: 220 }}
          />
          <Button variant="outlined" startIcon={<RefreshIcon />} onClick={handlePull} disabled={pulling}>
            {pulling ? 'מושך…' : 'משיכת פניות'}
          </Button>
        </Stack>
      </Stack>

      {/* The office's line. Shown only to whoever can see across branches —
          a manager cannot act on somebody else's candidate anyway. */}
      {counts.stale > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>{counts.stale} מועמדים ממתינים מעל {counts.stale_hours} שעות</AlertTitle>
          שויכו לסניף ואיש עדיין לא יצר קשר. מועמד שממתין יומיים בדרך כלל כבר מצא עבודה אחרת.
        </Alert>
      )}

      <Tabs value={view} onChange={(_, v) => { setSearch(''); setView(v); }} sx={{ mb: 2 }}>
        {VIEWS.map(v => (
          <Tab key={v.key} label={`${v.label}${counts[v.key] != null ? ` (${counts[v.key]})` : ''}`} />
        ))}
      </Tabs>

      {loading ? <CircularProgress /> : (
        <Stack spacing={1.5}>
          {rows.map(row => (
            <Card key={row.id} variant="outlined">
              <CardContent sx={{ pb: 1.5 }}>
                <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{row.full_name}</Typography>
                  <Typography dir="ltr" sx={{ color: 'text.secondary' }}>{row.phone}</Typography>

                  {row.for_office
                    ? <Chip size="small" color={row.branch_unmatched ? 'error' : 'warning'}
                        label={row.branch_unmatched ? `סניף לא זוהה: ${row.requested_branch}` : 'מענה כללי — לשיוך'} />
                    : row.branch_names.map(n => <Chip key={n} size="small" label={n} />)}

                  {row.application_count > 1 && (
                    <Tooltip title="פנה/תה יותר מפעם אחת">
                      <Chip size="small" color="info" variant="outlined"
                        label={`${row.application_count} פניות`} onClick={() => setHistory(row)} />
                    </Tooltip>
                  )}
                  {row.status === 'hired' && <Chip size="small" color="success" label="התקבל/ה" />}
                  {row.status === 'rejected' && <Chip size="small" color="error" variant="outlined" label="לא התקבל/ה" />}
                  {row.no_show_count > 0 && (
                    <Chip size="small" color="warning" variant="outlined" label={`לא הגיע/ה ×${row.no_show_count}`} />
                  )}
                  {row.attempt_count > 0 && (
                    <Chip size="small" color="warning" variant="outlined" label={`${row.attempt_count} ניסיונות`} />
                  )}
                  {row.hours_waiting >= 48 && (
                    <Chip size="small" color="error" label={`ממתין/ה ${row.hours_waiting} שעות`} />
                  )}

                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" color="text.secondary">הגיע/ה {fmtDate(row.applied_at)}</Typography>
                  <IconButton size="small" onClick={() => setHistory(row)}><HistoryIcon fontSize="small" /></IconButton>
                </Stack>

                {row.message && (
                  <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
                    {row.message}
                  </Typography>
                )}

                {row.interview && (
                  <Alert severity="success" sx={{ mt: 1.5, py: 0.5 }}
                    action={row.whatsapp_url && (
                      <Button size="small" color="success" startIcon={<WhatsAppIcon />}
                        href={row.whatsapp_url} target="_blank" rel="noopener">
                        ווטסאפ לעובד
                      </Button>
                    )}>
                    ראיון — {fmtWhen(row.interview.at)}
                  </Alert>
                )}

                {row.close_reason && (
                  <Alert severity={row.future_relevant ? 'info' : 'warning'} sx={{ mt: 1.5, py: 0.5 }}>
                    {row.future_relevant ? 'רלוונטי/ת לעתיד — ' : 'לא רלוונטי/ת — '}{row.close_reason}
                  </Alert>
                )}

                {row.awaiting_decision && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                      <Typography variant="body2" color="text.secondary">מה קרה בראיון?</Typography>
                      <Box sx={{ flex: 1 }} />
                      <Button size="small" variant="contained" color="success"
                        onClick={() => setOutcome({ row, result: 'hired', reason: '', future: false, callback: '' })}>
                        התקבל/ה
                      </Button>
                      <Button size="small" variant="outlined" color="error"
                        onClick={() => setOutcome({ row, result: 'rejected', reason: '', future: false, callback: '' })}>
                        לא התקבל/ה
                      </Button>
                      <Button size="small" variant="outlined" color="warning" onClick={() => noShow(row)}>
                        לא הגיע/ה
                      </Button>
                    </Stack>
                  </>
                )}

                {viewKey === 'scheduled' && !row.awaiting_decision && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={1}>
                      <Box sx={{ flex: 1 }} />
                      <Button size="small" onClick={() => setMove({ row, at: '', saved: false })}>
                        שינוי מועד
                      </Button>
                    </Stack>
                  </>
                )}

                {viewKey === 'due' && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      <Button size="small" startIcon={<PhoneIcon />} href={`tel:${row.phone}`}>חיוג</Button>
                      <Box sx={{ flex: 1 }} />
                      <Button size="small" variant="contained" color="success" startIcon={<EventAvailableIcon />}
                        onClick={() => setInvite({ row, at: defaultInterviewSlot(), note: '', saved: false })}>
                        התקשרתי וזומן לראיון
                      </Button>
                      <Button size="small" variant="outlined" color="error" startIcon={<BlockIcon />}
                        onClick={() => setReject({ row, reason: '', future: false, callback: '' })}>
                        התקשרתי ולא רלוונטי
                      </Button>
                      <Button size="small" variant="outlined" color="warning" startIcon={<PhoneMissedIcon />}
                        onClick={() => noAnswer(row)}>
                        לא ענה
                      </Button>
                    </Stack>
                  </>
                )}
              </CardContent>
            </Card>
          ))}

          {!rows.length && (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary">
                {search.trim() ? 'לא נמצאו מועמדים' : 'אין מועמדים ברשימה הזו'}
              </Typography>
            </Box>
          )}
        </Stack>
      )}

      {/* ---- זימון לראיון ---- */}
      <Dialog open={!!invite} onClose={() => { setInvite(null); }} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>זימון לראיון — {invite?.row.full_name}</DialogTitle>
        <DialogContent>
          {invite?.saved ? (
            <Alert severity="success">
              <AlertTitle>הראיון נקבע ל{fmtWhen(invite.at)}</AlertTitle>
              ההודעה מוכנה. לחיצה על הכפתור תפתח את ווטסאפ עם הטקסט — צריך עדיין ללחוץ "שלח".
            </Alert>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                type="datetime-local" label="מועד הראיון" InputLabelProps={{ shrink: true }}
                value={invite?.at || ''} onChange={e => setInvite(v => ({ ...v, at: e.target.value }))} fullWidth
              />
              <TextField
                label="סיכום השיחה (ייכנס להודעה)" multiline minRows={3}
                value={invite?.note || ''} onChange={e => setInvite(v => ({ ...v, note: e.target.value }))} fullWidth
                placeholder="למשל: לתפקיד סייעת, משרה מלאה, להביא תעודות"
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInvite(null)}>סגירה</Button>
          {invite?.saved
            ? (
              <Button variant="contained" color="success" startIcon={<WhatsAppIcon />}
                href={invite.whatsapp_url} target="_blank" rel="noopener">
                פתיחת ווטסאפ
              </Button>
            )
            : <Button variant="contained" onClick={saveInvite}>שמירה</Button>}
        </DialogActions>
      </Dialog>

      {/* ---- לא רלוונטי ---- */}
      <Dialog open={!!reject} onClose={() => setReject(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>לא רלוונטי/ת — {reject?.row.full_name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="סיבה" multiline minRows={3} required
              value={reject?.reason || ''} onChange={e => setReject(v => ({ ...v, reason: e.target.value }))}
              helperText="זה מה שיישאר למי שיפתח את הכרטיס בעוד חצי שנה"
              fullWidth
            />
            <FormControlLabel
              control={<Checkbox checked={!!reject?.future}
                onChange={e => setReject(v => ({ ...v, future: e.target.checked }))} />}
              label="רלוונטי/ת לעתיד"
            />
            {reject?.future && (
              <TextField
                type="date" label="תאריך לשיחה חוזרת" InputLabelProps={{ shrink: true }}
                value={reject?.callback || ''} onChange={e => setReject(v => ({ ...v, callback: e.target.value }))}
                helperText="בתאריך הזה המועמד/ת יחזור/תחזור לרשימת הטיפול"
                fullWidth
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReject(null)}>ביטול</Button>
          <Button variant="contained" color="error" onClick={saveReject}>שמירה</Button>
        </DialogActions>
      </Dialog>

      {/* ---- תוצאת הראיון ---- */}
      <Dialog open={!!outcome} onClose={() => setOutcome(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>
          {OUTCOME_LABELS[outcome?.result]} — {outcome?.row.full_name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {outcome?.result === 'hired' ? (
              <>
                <Alert severity="success">
                  <AlertTitle>מסומן/ת כהתקבל/ה</AlertTitle>
                  הפקת החוזה, אישור הנה״ח, החתימה ופתיחת המשתמש בשעון עדיין נעשים ידנית —
                  החיבור האוטומטי אליהם הוא השלב הבא.
                </Alert>
                <TextField
                  label="תנאים שסוכמו (לא חובה)" multiline minRows={2}
                  value={outcome?.reason || ''}
                  onChange={e => setOutcome(v => ({ ...v, reason: e.target.value }))}
                  placeholder="תפקיד, היקף משרה, שכר, תאריך תחילה"
                  fullWidth
                />
              </>
            ) : (
              <>
                <TextField
                  label="סיבה" multiline minRows={3} required
                  value={outcome?.reason || ''}
                  onChange={e => setOutcome(v => ({ ...v, reason: e.target.value }))}
                  helperText="זה מה שיישאר למי שיפתח את הכרטיס בעוד חצי שנה"
                  fullWidth
                />
                <FormControlLabel
                  control={<Checkbox checked={!!outcome?.future}
                    onChange={e => setOutcome(v => ({ ...v, future: e.target.checked }))} />}
                  label="רלוונטי/ת לעתיד"
                />
                {outcome?.future && (
                  <TextField
                    type="date" label="תאריך לשיחה חוזרת" InputLabelProps={{ shrink: true }}
                    value={outcome?.callback || ''}
                    onChange={e => setOutcome(v => ({ ...v, callback: e.target.value }))}
                    helperText="בתאריך הזה יחזור/תחזור לרשימת הטיפול"
                    fullWidth
                  />
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOutcome(null)}>ביטול</Button>
          <Button variant="contained" color={outcome?.result === 'hired' ? 'success' : 'error'}
            onClick={saveOutcome}>
            שמירה
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- שינוי מועד ---- */}
      <Dialog open={!!move} onClose={() => setMove(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>שינוי מועד — {move?.row.full_name}</DialogTitle>
        <DialogContent>
          {move?.saved ? (
            <Alert severity="success">
              <AlertTitle>המועד עודכן</AlertTitle>
              כדאי לעדכן את המועמד/ת — ההודעה מוכנה בכפתור.
            </Alert>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                המועד הנוכחי: {fmtWhen(move?.row.interview?.at)}
              </Typography>
              <TextField
                type="datetime-local" label="מועד חדש" InputLabelProps={{ shrink: true }}
                value={move?.at || ''} onChange={e => setMove(v => ({ ...v, at: e.target.value }))} fullWidth
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMove(null)}>סגירה</Button>
          {move?.saved
            ? (
              <Button variant="contained" color="success" startIcon={<WhatsAppIcon />}
                href={move.whatsapp_url} target="_blank" rel="noopener">
                פתיחת ווטסאפ
              </Button>
            )
            : <Button variant="contained" onClick={saveMove}>שמירה</Button>}
        </DialogActions>
      </Dialog>

      {/* ---- היסטוריה ---- */}
      <Dialog open={!!history} onClose={() => setHistory(null)} maxWidth="sm" fullWidth dir="rtl">
        <DialogTitle>{history?.full_name} — היסטוריה</DialogTitle>
        <DialogContent>
          {!!history?.history?.length && (
            <Alert severity="info" sx={{ mb: 2 }}>
              פנה/תה גם {history.history.map(h => `${fmtDate(h.at)}${h.branch ? ` (${h.branch})` : ''}`).join(' · ')}
            </Alert>
          )}
          <Stack spacing={1}>
            {(history?.events || []).slice().reverse().map((e, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1.5, fontSize: '0.9rem' }}>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 110 }}>
                  {fmtWhen(e.at)}
                </Typography>
                <Typography variant="body2">
                  <b>{{
                    applied: 'הגיעה פנייה',
                    reapplied: 'פנה/תה שוב',
                    interview_scheduled: 'זומן/ה לראיון',
                    not_relevant: 'לא רלוונטי/ת',
                    no_answer: 'לא ענה/תה',
                    archived: 'הועבר/ה לארכיון',
                    interview_moved: 'מועד הראיון שונה',
                    no_show: 'לא הגיע/ה לראיון',
                    hired: 'התקבל/ה',
                    rejected: 'לא התקבל/ה בראיון',
                  }[e.type] || e.type}</b>
                  {e.note ? ` — ${e.note}` : ''}
                  {e.by ? ` · ${e.by}` : ''}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setHistory(null)}>סגירה</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
