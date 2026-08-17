import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Button, TextField, Chip, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions, MenuItem, Select,
  FormControl, InputLabel, Switch, FormControlLabel, CircularProgress,
  LinearProgress, Divider, IconButton, Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import SmsIcon from '@mui/icons-material/Sms';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * הודעות לגן — the staff side of what the families are told.
 *
 * One screen for two jobs, because they are the same list seen from two
 * chairs. A teacher writes and watches; a branch manager sees the same rows
 * with three more buttons on them. Splitting it into "compose" and "approve"
 * would hide from the teacher what has already gone out, which is exactly what
 * she needs before writing something that contradicts it.
 *
 * The three ways out are not equal and the screen says so:
 *
 *   published  — on every parent's home screen. Free, immediate, and the one
 *                that is true by construction.
 *   WhatsApp   — copies the text. The button says העתקה, the record says
 *                "copied", and neither claims the group was posted to. This
 *                system cannot know that.
 *   SMS        — really sent, really costs, and capped. The dialog shows the
 *                number of families, the number of MESSAGES (Hebrew is 70
 *                characters per message and a long title quietly triples the
 *                bill), and what is left this month, before anything is spent.
 */

const STATUS = {
  draft: { label: 'טיוטה', color: 'default' },
  pending: { label: 'ממתין לאישור', color: 'warning' },
  published: { label: 'פורסם', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

const DECIDERS = ['system_admin', 'branch_manager'];

function fmt(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('he-IL', {
    day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function errText(e, fallback) {
  return e?.response?.data?.error || fallback;
}

/**
 * The month's SMS allowance, always on screen.
 *
 * Above the compose button rather than inside the send dialog: somebody about
 * to write an urgent notice should know before they write it whether it can be
 * sent, not after they have chosen the words.
 */
function BudgetBar({ budget }) {
  if (!budget) return null;
  const used = budget.total ? Math.min(100, Math.round((budget.spent / budget.total) * 100)) : 0;
  const dry = budget.remaining === 0;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
          <SmsIcon fontSize="small" color={dry ? 'error' : 'action'} />
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            מכסת SMS לחודש {budget.month}
          </Typography>
          <Typography variant="subtitle2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            נותרו {budget.remaining.toLocaleString('he-IL')}
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate" value={used}
          color={dry ? 'error' : 'primary'}
          sx={{ height: 6, borderRadius: 3 }}
        />
        <Typography variant="caption" color="text.secondary">
          נוצלו {budget.spent.toLocaleString('he-IL')} מתוך {budget.total.toLocaleString('he-IL')}
          {' · '}
          {budget.sends_allowed} הודעות לכל ההורים ({budget.children_counted} ילדים)
          {budget.extra_granted > 0 && ` · תוספת ${budget.extra_granted}`}
        </Typography>
        {dry && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            המכסה נוצלה. הודעות ימשיכו להתפרסם בפורטל ובוואטסאפ — SMS לא ייצא עד החודש הבא,
            אלא אם מנהל המערכת יאשר תוספת.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** Compose, or fix a rejected one. */
function ComposeDialog({ open, onClose, onSaved, branchId, classrooms, editing }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setTitle(editing?.title || '');
    setBody(editing?.body || '');
    setUrgent(!!editing?.is_urgent);
    setRooms((editing?.classroom_ids || []).map(String));
    setExpires(editing?.expires_at ? String(editing.expires_at).slice(0, 10) : '');
  }, [open, editing]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const payload = {
        branch_id: branchId,
        classroom_ids: rooms,
        title, body,
        is_urgent: urgent,
        expires_at: expires || null,
      };
      if (editing) await api.patch(`/announcements/${editing.id}`, payload);
      else await api.post('/announcements', payload);
      onSaved();
      onClose();
    } catch (e) {
      setError(errText(e, 'השמירה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? 'עריכת הודעה' : 'הודעה חדשה'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="כותרת" value={title} onChange={(e) => setTitle(e.target.value)}
            fullWidth inputProps={{ maxLength: 120 }}
            helperText={`${title.length}/120 · הכותרת היא מה שנשלח ב-SMS, אם ההודעה דחופה`}
          />
          <TextField
            label="תוכן" value={body} onChange={(e) => setBody(e.target.value)}
            fullWidth multiline minRows={4} inputProps={{ maxLength: 2000 }}
          />

          <FormControl fullWidth>
            <InputLabel>למי</InputLabel>
            <Select
              multiple value={rooms} label="למי"
              onChange={(e) => setRooms(e.target.value)}
              renderValue={(v) => (v.length
                ? classrooms.filter(c => v.includes(String(c._id))).map(c => c.name).join(', ')
                : 'כל הגן')}
            >
              {classrooms.map(c => (
                <MenuItem key={c._id} value={String(c._id)}>{c.name}</MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              בלי בחירה — ההודעה מגיעה לכל הורי הסניף, כולל כיתות שייפתחו בהמשך.
            </Typography>
          </FormControl>

          <TextField
            label="להסתיר אחרי" type="date" value={expires}
            onChange={(e) => setExpires(e.target.value)}
            InputLabelProps={{ shrink: true }} fullWidth
            helperText="הודעה על מחר לא צריכה להישאר על המסך בעוד שבועיים. אפשר להשאיר ריק."
          />

          <FormControlLabel
            control={<Switch checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />}
            label="דחוף"
          />
          {urgent && (
            <Alert severity="info">
              סימון „דחוף" רק פותח את האפשרות לשלוח SMS. השליחה עצמה היא פעולה נפרדת של
              מנהלת הסניף, אחרי שההודעה מפורסמת.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={busy || !title.trim() || !body.trim()}>
          {busy ? 'שומר…' : 'שמירה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The send dialog. Everything it costs, before it costs it.
 *
 * Opened on the audience endpoint rather than on stored numbers, so the count
 * is the families who are in the gan right now, and `unreachable` is on screen
 * — those are the families this send does NOT tell, and somebody has to ring
 * them.
 */
function SendSmsDialog({ open, onClose, announcement, onSent }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open || !announcement) return undefined;
    let dead = false;
    setLoading(true); setError(''); setResult(null); setInfo(null);
    api.get(`/announcements/${announcement.id}/audience`)
      .then(r => { if (!dead) setInfo(r.data); })
      .catch(e => { if (!dead) setError(errText(e, 'לא הצלחנו לחשב את הנמענים')); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [open, announcement]);

  const send = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/announcements/${announcement.id}/sms`);
      setResult(r.data);
      onSent();
    } catch (e) {
      const d = e?.response?.data;
      setError(d?.code === 'BUDGET_EXCEEDED'
        ? `המכסה לא מספיקה: נדרשות ${d.needed} הודעות, נותרו ${d.remaining}.`
        : errText(e, 'השליחה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  const fits = info && info.sms.messages <= info.budget.remaining && !info.sms.over_limit;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>שליחת SMS דחוף</DialogTitle>
      <DialogContent>
        {loading && <Stack alignItems="center" sx={{ py: 3 }}><CircularProgress size={28} /></Stack>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {result && (
          <Alert severity="success">
            נשלחו {result.sent} הודעות{result.failed ? `, ${result.failed} נכשלו` : ''}.
            נותרו {result.budget.remaining} במכסה החודשית.
          </Alert>
        )}

        {!loading && info && !result && (
          <Stack spacing={1.5}>
            <Card variant="outlined">
              <CardContent sx={{ py: 1.5 }}>
                <Typography variant="caption" color="text.secondary">הטקסט שיישלח</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{info.sms.text}</Typography>
              </CardContent>
            </Card>

            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">משפחות</Typography>
              <Typography variant="body2" fontWeight={700}>{info.audience.families}</Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">
                אורך ההודעה
                {info.sms.segments > 1 && ` (${info.sms.segments} חלקים)`}
              </Typography>
              <Typography variant="body2" fontWeight={700}>{info.sms.chars} תווים</Typography>
            </Stack>
            <Divider />
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" fontWeight={700}>סה״כ הודעות</Typography>
              <Typography variant="body2" fontWeight={800}>{info.sms.messages}</Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">נותרו במכסה</Typography>
              <Typography variant="body2" fontWeight={700}>{info.budget.remaining}</Typography>
            </Stack>

            {info.sms.segments > 1 && (
              <Alert severity="warning">
                הכותרת ארוכה מ-{info.sms.single_segment_chars} תווים, ולכן כל משפחה מקבלת
                {' '}{info.sms.segments} הודעות במקום אחת. קיצור הכותרת ב-{info.sms.chars_over_single} תווים
                יחסוך {info.sms.messages - info.audience.families} הודעות.
              </Alert>
            )}
            {info.audience.unreachable > 0 && (
              <Alert severity="warning">
                ל-{info.audience.unreachable} ילדים אין מספר נייד תקין במערכת. המשפחות האלה
                לא יקבלו את ה-SMS.
              </Alert>
            )}
            {!fits && !info.sms.over_limit && (
              <Alert severity="error">המכסה החודשית לא מספיקה לשליחה הזו.</Alert>
            )}
            {info.sms.over_limit && (
              <Alert severity="error">הכותרת ארוכה מדי לשליחה. יש לקצר אותה.</Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{result ? 'סגירה' : 'ביטול'}</Button>
        {!result && (
          <Button variant="contained" color="error" onClick={send} disabled={busy || !fits}>
            {busy ? 'שולח…' : 'שליחה'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default function Announcements() {
  const { user } = useAuth();
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [classrooms, setClassrooms] = useState([]);
  const [items, setItems] = useState([]);
  const [budget, setBudget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [smsFor, setSmsFor] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState('');

  const canDecide = DECIDERS.includes(user?.role);

  useEffect(() => {
    (async () => {
      try {
        const [b, c] = await Promise.all([api.get('/branches'), api.get('/classrooms')]);
        const list = b.data.branches || b.data || [];
        setBranches(list);
        setClassrooms(c.data.classrooms || c.data || []);
        const stored = localStorage.getItem('selectedBranch');
        const initial = (stored && stored !== 'all' && list.some(x => String(x._id) === stored))
          ? stored
          : String(list[0]?._id || '');
        setBranchId(initial);
      } catch (e) {
        setError(errText(e, 'לא הצלחנו לטעון את הסניפים'));
        setLoading(false);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true); setError('');
    try {
      const [a, bud] = await Promise.all([
        api.get('/announcements', { params: { branch: branchId } }),
        api.get('/announcements/budget', { params: { branch: branchId } }),
      ]);
      setItems(a.data.announcements || []);
      setBudget(bud.data);
    } catch (e) {
      setError(errText(e, 'לא הצלחנו לטעון את ההודעות'));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const roomsOfBranch = useMemo(
    () => classrooms.filter(c => String(c.branch_id?._id || c.branch_id) === String(branchId)),
    [classrooms, branchId],
  );
  const roomName = useCallback(
    (id) => classrooms.find(c => String(c._id) === String(id))?.name || '',
    [classrooms],
  );

  const decide = async (a, approve) => {
    try {
      await api.post(`/announcements/${a.id}/decide`, { approve, reason });
      setRejecting(null); setReason('');
      load();
    } catch (e) { setError(errText(e, 'הפעולה נכשלה')); }
  };

  /**
   * Copy to the clipboard, and say so honestly.
   *
   * The button reads העתקה and the toast reads "הועתק — הדביקי בקבוצה", never
   * "נשלח". Nothing here reaches WhatsApp.
   */
  const copyWhatsapp = async (a) => {
    try {
      const r = await api.post(`/announcements/${a.id}/whatsapp`);
      await navigator.clipboard.writeText(r.data.text);
      setCopied(a.id);
      setTimeout(() => setCopied(''), 4000);
      load();
    } catch (e) {
      setError(errText(e, 'ההעתקה נכשלה. אפשר לסמן את הטקסט ולהעתיק ידנית.'));
    }
  };

  const remove = async (a) => {
    try { await api.delete(`/announcements/${a.id}`); load(); }
    catch (e) { setError(errText(e, 'המחיקה נכשלה')); }
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ flex: 1 }}>הודעות לגן</Typography>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>סניף</InputLabel>
          <Select value={branchId} label="סניף" onChange={(e) => setBranchId(e.target.value)}>
            {branches.map(b => (
              <MenuItem key={b._id} value={String(b._id)}>{b.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained" startIcon={<AddIcon />}
          onClick={() => { setEditing(null); setComposeOpen(true); }}
          disabled={!branchId}
        >
          הודעה חדשה
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <BudgetBar budget={budget} />

      {!canDecide && (
        <Alert severity="info" sx={{ mb: 2 }}>
          הודעה שתכתבי תעבור לאישור מנהלת הסניף לפני שההורים יראו אותה.
        </Alert>
      )}

      {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

      {!loading && items.length === 0 && (
        <Alert severity="info">עדיין לא נכתבו הודעות בסניף הזה.</Alert>
      )}

      <Stack spacing={2}>
        {items.map(a => {
          const s = STATUS[a.status] || STATUS.draft;
          const mine = String(a.author_name || '') === String(user?.name || '');
          return (
            <Card key={a.id}>
              <CardContent>
                <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="h6">{a.title}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {a.author_name} · {fmt(a.created_at)}
                      {a.classroom_ids.length
                        ? ` · ${a.classroom_ids.map(roomName).filter(Boolean).join(', ')}`
                        : ' · כל הגן'}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    {a.is_urgent && <Chip size="small" label="דחוף" color="error" />}
                    <Chip size="small" label={s.label} color={s.color} />
                  </Stack>
                </Stack>

                <Typography variant="body2" sx={{ whiteSpace: 'pre-line', mb: 1.5 }}>
                  {a.body}
                </Typography>

                {a.status === 'rejected' && a.rejected_reason && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    נדחה על ידי {a.approved_by_name}: {a.rejected_reason}
                  </Alert>
                )}

                {a.status === 'published' && (
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                    פורסם {fmt(a.published_at)}
                    {a.approved_by_name && ` על ידי ${a.approved_by_name}`}
                    {a.delivery.whatsapp_copied_at && ` · הועתק לוואטסאפ ${fmt(a.delivery.whatsapp_copied_at)}`}
                    {a.delivery.sms_sent_at && ` · SMS נשלח ${fmt(a.delivery.sms_sent_at)} (${a.delivery.sms_recipients} הודעות${a.delivery.sms_failed ? `, ${a.delivery.sms_failed} נכשלו` : ''})`}
                  </Typography>
                )}

                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {a.status === 'pending' && canDecide && (
                    <>
                      <Button size="small" variant="contained" onClick={() => decide(a, true)}>
                        אישור ופרסום
                      </Button>
                      <Button size="small" color="error" onClick={() => { setRejecting(a); setReason(''); }}>
                        דחייה
                      </Button>
                    </>
                  )}

                  {(a.status === 'rejected' || (a.status === 'pending' && mine)) && (
                    <Button
                      size="small" startIcon={<EditIcon />}
                      onClick={() => { setEditing(a); setComposeOpen(true); }}
                    >
                      עריכה
                    </Button>
                  )}

                  {a.status === 'published' && (
                    <Tooltip title="מעתיק את הטקסט. ההדבקה בקבוצה היא ידנית — המערכת לא שולחת לוואטסאפ.">
                      <Button size="small" startIcon={<WhatsAppIcon />} onClick={() => copyWhatsapp(a)}>
                        {copied === a.id ? 'הועתק — הדביקי בקבוצה' : 'העתקה לוואטסאפ'}
                      </Button>
                    </Tooltip>
                  )}

                  {a.status === 'published' && a.is_urgent && canDecide && !a.delivery.sms_sent_at && (
                    <Button
                      size="small" color="error" variant="outlined" startIcon={<SmsIcon />}
                      onClick={() => setSmsFor(a)}
                    >
                      שליחת SMS
                    </Button>
                  )}

                  {a.status !== 'published' && (mine || canDecide) && (
                    <IconButton size="small" onClick={() => remove(a)} aria-label="מחיקה">
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              </CardContent>
            </Card>
          );
        })}
      </Stack>

      <ComposeDialog
        open={composeOpen}
        onClose={() => { setComposeOpen(false); setEditing(null); }}
        onSaved={load}
        branchId={branchId}
        classrooms={roomsOfBranch}
        editing={editing}
      />

      <SendSmsDialog
        open={!!smsFor}
        announcement={smsFor}
        onClose={() => setSmsFor(null)}
        onSent={load}
      />

      {/* Rejecting needs a reason, and the field is the dialog — there is no
          way to reject without typing one. A teacher told only "no" writes the
          same announcement again. */}
      <Dialog open={!!rejecting} onClose={() => setRejecting(null)} fullWidth maxWidth="xs">
        <DialogTitle>דחיית ההודעה</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={3} sx={{ mt: 1 }}
            label="למה?" value={reason} onChange={(e) => setReason(e.target.value)}
            helperText="הכותבת תראה את זה ותוכל לתקן ולשלוח שוב."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejecting(null)}>ביטול</Button>
          <Button color="error" variant="contained" disabled={!reason.trim()}
            onClick={() => decide(rejecting, false)}>
            דחייה
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
