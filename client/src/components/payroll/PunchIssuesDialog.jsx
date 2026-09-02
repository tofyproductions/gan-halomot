import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Alert, Divider, ToggleButton, ToggleButtonGroup, Paper,
  Tabs, Tab, TextField, CircularProgress, Badge, FormControlLabel, Switch, Link,
} from '@mui/material';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ScheduleIcon from '@mui/icons-material/Schedule';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { BusyButton } from '../shared/UploadControls';

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

const ALL = '__all__';

/**
 * One place for everything wrong with the month's punches.
 *
 * BRANCH IS THE PRIMARY AXIS. Picking a branch tab filters every list to that
 * branch and pins its manager to the top with the reminder controls, because
 * the work is per-branch and so is the person who owns it: completing a missing
 * punch is the BRANCH MANAGER's job — they know who was actually there — and
 * accounting's job is to chase and then approve. Merely labelling each row with
 * a branch name left the accountant to do the sorting by eye.
 *
 * Direct entry stays available behind "הזן בעצמי" for when a manager can't be
 * reached.
 *
 *   • כפילויות — days with >2 punches; these block sending the month.
 *   • חוסרים — days holding a single punch; surfaced, not blocking.
 *   • שעות קבועות — a fixed-hours employee who also clocked in that day.
 */
export default function PunchIssuesDialog({ open, month, canFix, canRemind = false, onClose, onChanged }) {
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ duplicates: [], missing: [], conflicts: [] });
  const [roles, setRoles] = useState({});
  const [busy, setBusy] = useState({});
  const [fill, setFill] = useState({}); // key → {in, out}
  const [newPunch, setNewPunch] = useState({}); // key → {time, role} — a punch missing from the middle of the day (e.g. "back from an errand")
  const [selfEntry, setSelfEntry] = useState(false); // accountant's fallback
  const [reminders, setReminders] = useState({});    // branch_id → send result
  const [transfer, setTransfer] = useState({});      // day key → HH:mm typed by the manager
  const [branch, setBranch] = useState(ALL);         // which branch tab is open

  const load = useCallback(() => {
    if (!month) return;
    setLoading(true);
    api.get(`/payroll-month/${month}/punch-issues`)
      .then(r => {
        const d = r.data || {};
        setData({
          duplicates: d.duplicates || [], missing: d.missing || [],
          conflicts: d.conflicts || [], cross_branch: d.cross_branch || [],
          branches: d.branches || [], scoped: d.scoped,
        });
        const init = {};
        for (const day of d.duplicates || []) {
          for (const p of day.punches) init[p.id] = p.suggested_role || 'ignore';
        }
        setRoles(init);
      })
      .catch(() => setData({ duplicates: [], missing: [], conflicts: [], cross_branch: [], branches: [] }))
      .finally(() => setLoading(false));
  }, [month]);
  useEffect(() => { if (open) { load(); setReminders({}); setBranch(ALL); } }, [open, load]);

  const keyOf = (d) => `${d.employee_id}|${d.date}`;
  const setRole = (id, role) => { if (role) setRoles(r => ({ ...r, [id]: role })); };
  const withBusy = (k, p) => {
    setBusy(b => ({ ...b, [k]: true }));
    return p.finally(() => setBusy(b => ({ ...b, [k]: false })));
  };

  const approve = (day) => withBusy(keyOf(day),
    api.post('/payroll-month/punch-resolutions', {
      employee_id: day.employee_id,
      date: day.date,
      labels: day.punches.map(p => ({ punch_id: p.id, role: roles[p.id] || 'ignore' })),
    })
      .then((r) => {
        toast.success(r.data?.status === 'pending'
          ? `${day.full_name} · ${day.date} — נשלח לאישור הנהלת החשבונות`
          : `${day.full_name} · ${day.date} אושר`);
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));

  /** Split a day opened at one branch and closed at another. */
  const splitBranchDay = (day) => {
    const k = keyOf(day);
    const t = (transfer[k] || '').trim();
    if (!/^\d{2}:\d{2}$/.test(t)) return toast.error('הזן/י שעת מעבר בין הסניפים');
    return withBusy(k, api.post(`/payroll-month/${month}/punch-issues/split-branch`, {
      employee_id: day.employee_id, date: day.date, transfer_time: t,
    })
      .then(r => {
        toast.success(r.data?.status === 'pending'
          ? `${day.full_name} · ${day.date} — נשלח לאישור הנהלת החשבונות`
          : `${day.full_name} · ${day.date} פוצל`);
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));
  };

  /**
   * A genuinely missing punch in the MIDDLE of a >2-punch day — she clocked in,
   * left for something, came back, and never clocked the return. "Ignore" the
   * middle reading and the span pays for the time she was out; cut the day
   * there and the afternoon she actually worked goes unpaid. Neither is right
   * — the fix is a real punch for when she came back, then label all four.
   *
   * Accountant/admin only (canRemind): punch-issues only lists punches with
   * approval_status auto/approved (payrollMonth.controller.js#punchIssues) — a
   * branch_manager's addition would come back pending_accountant and simply
   * not reappear here, which would look like the click did nothing.
   */
  const addPunchToDay = (day) => {
    const k = keyOf(day);
    const v = newPunch[k] || {};
    if (!/^\d{2}:\d{2}$/.test(v.time || '')) return toast.error('הזן/י שעה להחתמה החדשה');
    const role = v.role === 'out' ? 'out' : 'in';
    return withBusy(`${k}-add`, api.post('/payroll/manual-punches', {
      employee_id: day.employee_id,
      date: day.date,
      branch_id: day.branch_id,
      [role === 'in' ? 'in_time' : 'out_time']: v.time,
      note: 'החתמה נוספה ידנית (בעיות בהחתמה — כפילויות)',
    })
      .then(() => {
        toast.success(`החתמה נוספה ל-${day.full_name} · ${day.date} — סמנ/י לה תפקיד ואשר/י את היום`);
        setNewPunch(s => ({ ...s, [k]: {} }));
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));
  };

  const addMissing = (item) => {
    const k = keyOf(item);
    const v = fill[k] || {};
    if (!v.in && !v.out) return toast.error('הזן/י שעה להשלמה');
    return withBusy(k, api.post('/payroll/manual-punches', {
      employee_id: item.employee_id,
      date: item.date,
      in_time: v.in || undefined,
      out_time: v.out || undefined,
      note: 'השלמת החתמה חסרה (מסך בעיות בהחתמה)',
    })
      .then(() => { toast.success(`${item.full_name} · ${item.date} הושלם`); load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));
  };

  // A "missing" day that already carries a PENDING report: the right fix is
  // approving that report, not retyping it (the dedup guard 409s the retype).
  // A report still waiting for the branch manager needs the explicit
  // override flag — with a confirmation, so the bypass is never a silent click.
  const approvePending = (item, pp) => {
    const needsOverride = pp.status === 'pending_manager' || pp.status === 'pending';
    if (needsOverride
      && !window.confirm('הדיווח עדיין לא אושר ע״י מנהל/ת הסניף — לאשר בכל זאת ולעקוף את שלב המנהל?')) return undefined;
    return withBusy(`pp|${pp.id}`,
      api.patch(`/payroll/punches/${pp.id}/approve`, needsOverride ? { override_manager: true } : {})
        .then(() => {
          toast.success(`הדיווח של ${item.full_name} (${pp.hhmm}) אושר — היום הושלם`);
          load(); onChanged && onChanged();
        })
        .catch(err => toast.error(err.response?.data?.error || 'האישור נכשל')));
  };

  const resolveConflict = (item, decision) => withBusy(keyOf(item),
    api.post(`/payroll-month/${month}/punch-issues/fixed-conflict`, {
      employee_id: item.employee_id, date: item.date, decision,
    })
      .then(() => {
        toast.success(decision === 'clock' ? 'נקבע לפי החתמת השעון' : 'נקבע לפי השעות הקבועות');
        load(); onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));

  const remind = (b) => withBusy(`remind|${b.id}`,
    api.post(`/payroll-month/${month}/punch-issues/remind`, { branch_id: b.id })
      .then(r => {
        setReminders(prev => ({ ...prev, [b.id]: r.data }));
        toast.success(r.data.emailed
          ? `נשלחה תזכורת ל-${r.data.emailed} מנהלים בסניף ${r.data.branch_name}`
          : `אין כתובת מייל למנהל ${r.data.branch_name} — השתמש/י בקישור הוואטסאפ`);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));

  /**
   * Unlike "תזכורת", this leaves a standing task: the manager meets it on their
   * next login and we can see whether they opened it. Reloading afterwards is
   * what surfaces the "נשלח / נצפה" state on the branch row.
   */
  const assign = (b) => withBusy(`assign|${b.id}`,
    api.post(`/payroll-month/${month}/punch-issues/assign`, { branch_id: b.id })
      .then(r => {
        setReminders(prev => ({ ...prev, [b.id]: r.data }));
        toast.success(
          `${r.data.resent ? 'המשימה נשלחה שוב' : 'נשלחה משימה'} למנהל/ת ${r.data.branch_name}`
          + (r.data.emailed ? ` (+מייל ל-${r.data.emailed})` : ' — ללא מייל, אין כתובת אמיתית'),
        );
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה')));

  const branches = data.branches || [];
  const inBranch = (list) => (branch === ALL ? list : list.filter(i => String(i.branch_id) === branch));
  const dups = inBranch(data.duplicates || []);
  const miss = inBranch(data.missing || []);
  const conflicts = inBranch(data.conflicts || []);
  // A cross-branch day belongs to both ends, so the branch tab matches either.
  const crossDays = (data.cross_branch || []).filter(i => branch === ALL
    || String(i.in_branch_id) === branch || String(i.out_branch_id) === branch);
  const activeBranch = branches.find(b => b.id === branch) || null;

  const copyText = (text) => navigator.clipboard.writeText(text)
    .then(() => toast.success('ההודעה הועתקה'))
    .catch(() => toast.error('ההעתקה נכשלה'));

  const shortDate = (s) => (s ? new Date(s).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }) : '');

  /** Sent / seen state of the branch's standing entry task — or nothing yet. */
  const TaskChip = ({ b }) => {
    const t = b.entry_task;
    if (!t) return null;
    return (
      <Chip
        size="small"
        color={t.seen_count ? 'success' : 'info'}
        variant={t.seen_count ? 'filled' : 'outlined'}
        sx={{ fontSize: '0.66rem', fontWeight: 700 }}
        label={t.seen_count
          ? `המשימה נצפתה ${shortDate(t.last_seen_at)}`
          : `נשלחה ${shortDate(t.assigned_at)} · טרם נפתחה`}
      />
    );
  };

  /** One manager: name + a WhatsApp link carrying the ready reminder text. */
  const ManagerChips = ({ m }) => (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Chip size="small" label={m.name} sx={{ fontSize: '0.68rem', fontWeight: 700 }} />
      {m.whatsapp_url ? (
        <Chip size="small" clickable icon={<WhatsAppIcon sx={{ fontSize: 15 }} />} label="וואטסאפ"
          component={Link} href={m.whatsapp_url} target="_blank" rel="noopener"
          sx={{ fontSize: '0.68rem', bgcolor: '#dcfce7', color: '#166534', '& .MuiChip-icon': { color: '#25D366' } }} />
      ) : (
        <Chip size="small" variant="outlined" color="warning" label="אין טלפון"
          title="הוסף/י טלפון בכרטיס העובד/ת של המנהל/ת כדי לאפשר וואטסאפ" sx={{ fontSize: '0.66rem' }} />
      )}
    </Stack>
  );

  /**
   * The חוסרים tab's action list: every branch that still owes hours, who owns
   * it, one WhatsApp per manager, and the button that hands the work over for
   * real — an assignment the manager meets on their next login, not just a mail.
   */
  const AssignmentBoard = () => {
    const rows = (branches || [])
      .filter(b => b.missing_count > 0 && (branch === ALL || b.id === branch));
    if (rows.length === 0) return null;
    return (
      <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2, bgcolor: '#f8fafc' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>
          העברה למנהלי הסניפים
        </Typography>
        <Stack spacing={1}>
          {rows.map(b => (
            <Paper key={b.id} variant="outlined" sx={{ p: 1.1, borderRadius: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 800, minWidth: 140 }}>{b.name}</Typography>
                <Chip size="small" color="warning" label={`${b.missing_count} חוסרים`} />
                {(b.managers || []).length === 0
                  ? <Typography variant="caption" color="error" sx={{ fontWeight: 700 }}>
                      לא מוגדר מנהל לסניף — אי אפשר להקצות
                    </Typography>
                  : (b.managers || []).map(m => <ManagerChips key={m.id} m={m} />)}
                <TaskChip b={b} />
                <Box sx={{ flex: 1 }} />
                <Chip size="small" clickable icon={<ContentCopyIcon sx={{ fontSize: 14 }} />} label="העתק הודעה"
                  onClick={() => copyText(reminders[b.id]?.message || b.reminder_text)} sx={{ fontSize: '0.68rem' }} />
                <BusyButton size="small" variant="contained" color="error"
                  startIcon={<AssignmentTurnedInIcon />}
                  loading={!!busy[`assign|${b.id}`]} loadingText="שולח…"
                  disabled={(b.managers || []).length === 0}
                  onClick={() => assign(b)}>
                  {b.entry_task ? 'שלח שוב להזנה' : 'שלח למנהל הסניף להזנה'}
                </BusyButton>
              </Stack>
              {b.entry_task && (
                <Typography variant="caption" color="text.secondary">
                  נשלחה {shortDate(b.entry_task.assigned_at)}
                  {b.entry_task.reminder_count > 1 && ` (${b.entry_task.reminder_count} פעמים)`}
                  {b.entry_task.seen_count
                    ? ` · נפתחה ע״י המנהל/ת ${b.entry_task.seen_count} פעמים, אחרונה ${shortDate(b.entry_task.last_seen_at)}`
                    : ' · המנהל/ת עדיין לא פתח/ה אותה'}
                  . המשימה תיסגר מעצמה כשלא יישארו ימים חסרים.
                </Typography>
              )}
            </Paper>
          ))}
        </Stack>
      </Paper>
    );
  };

  /**
   * Who owns this branch's fixes, pinned above the lists once a branch tab is
   * selected — name, phone, the reminder button and a one-click WhatsApp.
   */
  const ManagerPanel = () => {
    if (!activeBranch) return null;
    const rem = reminders[activeBranch.id];
    const mgrs = activeBranch.managers || [];
    return (
      <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography sx={{ fontWeight: 800 }}>{activeBranch.name}</Typography>
          {activeBranch.duplicates_count + activeBranch.missing_count + activeBranch.conflicts_count === 0 ? (
            <Chip size="small" color="success" label="אין בעיות בסניף זה החודש" />
          ) : (
            <>
              <Chip size="small" color="error" label={`${activeBranch.duplicates_count} כפילויות`} />
              <Chip size="small" color="warning" label={`${activeBranch.missing_count} חוסרים`} />
              {activeBranch.conflicts_count > 0 && (
                <Chip size="small" color="secondary" label={`${activeBranch.conflicts_count} שעות קבועות`} />
              )}
            </>
          )}
          <Box sx={{ flex: 1 }} />
          {canRemind && (
            <>
              <TaskChip b={activeBranch} />
              <Chip size="small" clickable icon={<ContentCopyIcon sx={{ fontSize: 14 }} />} label="העתק הודעה"
                onClick={() => copyText(rem?.message || activeBranch.reminder_text)} sx={{ fontSize: '0.68rem' }} />
              <BusyButton size="small" variant="outlined" color="primary"
                startIcon={<NotificationsActiveIcon />}
                loading={!!busy[`remind|${activeBranch.id}`]} loadingText="שולח…"
                disabled={activeBranch.duplicates_count + activeBranch.missing_count === 0}
                onClick={() => remind(activeBranch)}>
                תזכורת בלבד
              </BusyButton>
              {/* The one that actually hands the work over. */}
              <BusyButton size="small" variant="contained" color="error"
                startIcon={<AssignmentTurnedInIcon />}
                loading={!!busy[`assign|${activeBranch.id}`]} loadingText="שולח…"
                disabled={(activeBranch.managers || []).length === 0
                  || activeBranch.duplicates_count + activeBranch.missing_count === 0}
                onClick={() => assign(activeBranch)}>
                {activeBranch.entry_task ? 'שלח שוב להזנה' : 'שלח למנהל הסניף להזנה'}
              </BusyButton>
            </>
          )}
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>אחראי/ת:</Typography>
          {mgrs.length === 0 && (
            <Typography variant="caption" color="error">
              לא מוגדר מנהל לסניף זה — אי אפשר לשלוח תזכורת עד שישויך מנהל
            </Typography>
          )}
          {mgrs.map(m => (
            <Stack key={m.id} direction="row" spacing={0.5} alignItems="center">
              <ManagerChips m={m} />
              <Chip size="small" variant="outlined" sx={{ fontSize: '0.66rem' }}
                label={m.email || 'אין מייל'} color={m.email ? 'default' : 'warning'} />
            </Stack>
          ))}
          {rem && (
            <Typography variant="caption" sx={{ color: rem.emailed ? 'success.main' : 'warning.main', fontWeight: 700 }}>
              {rem.emailed ? `✓ מייל נשלח (${rem.emailed})` : 'לא נשלח מייל — אין כתובת אמיתית'}
            </Typography>
          )}
        </Stack>
      </Paper>
    );
  };

  const IssueList = ({ items, empty, render }) => (
    items.length === 0 ? <Alert severity="success">{empty}</Alert> : (
      <Stack spacing={1.5}>{items.map(render)}</Stack>
    )
  );

  /** Show the branch on each row only in the "all branches" view. */
  const BranchChip = ({ item }) => (
    branch === ALL && item.branch_name
      ? <Chip size="small" variant="outlined" label={item.branch_name} />
      : null
  );

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
              {data.scoped && ' מוצגים הסניפים שבאחריותך בלבד.'}
            </Alert>
            {canRemind && miss.length > 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                השלמת החתמות חסרות היא באחריות מנהל/ת הסניף. "שלח למנהל הסניף להזנה" פותח לו/ה משימה
                שתקפוץ בכניסה הבאה לאפליקציה ולא תיעלם עד שתטופל — והאישור הסופי יגיע אלייך.
                להזנה ישירה במקרה חריג, הפעל/י את "הזן בעצמי".
              </Alert>
            )}

            {/* Branch is the primary filter — everything below is scoped to it. */}
            {branches.length > 0 && (
              <Tabs
                value={branch} onChange={(_e, v) => setBranch(v)}
                variant="scrollable" scrollButtons="auto"
                sx={{
                  mb: 2, borderBottom: '2px solid', borderColor: 'divider',
                  '& .MuiTab-root': { fontWeight: 700, minHeight: 44 },
                }}
              >
                <Tab value={ALL} label={`כל הסניפים (${(data.duplicates || []).length + (data.missing || []).length})`} />
                {branches.map(b => (
                  <Tab
                    key={b.id} value={b.id}
                    label={
                      <Stack direction="row" spacing={0.7} alignItems="center">
                        <span>{b.name}</span>
                        {b.duplicates_count > 0 && (
                          <Box component="span" sx={{ bgcolor: '#dc2626', color: '#fff', borderRadius: 5, px: 0.7, fontSize: '0.62rem', fontWeight: 800 }}>
                            {b.duplicates_count}
                          </Box>
                        )}
                        {b.missing_count > 0 && (
                          <Box component="span" sx={{ bgcolor: '#f59e0b', color: '#fff', borderRadius: 5, px: 0.7, fontSize: '0.62rem', fontWeight: 800 }}>
                            {b.missing_count}
                          </Box>
                        )}
                        {/* A clean branch says so out loud. Dropping it from the
                            strip would read as "you can't see this branch". */}
                        {b.duplicates_count + b.missing_count + b.conflicts_count === 0 && (
                          <Box component="span" sx={{ color: '#16a34a', fontSize: '0.8rem', fontWeight: 800 }}>✓</Box>
                        )}
                      </Stack>
                    }
                    sx={{ opacity: b.duplicates_count + b.missing_count + b.conflicts_count === 0 ? 0.6 : 1 }}
                  />
                ))}
              </Tabs>
            )}

            <ManagerPanel />

            <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
              <Tab label={<Badge color="error" badgeContent={dups.length}><Box sx={{ pl: 1.5 }}>כפילויות</Box></Badge>} />
              <Tab label={<Badge color="warning" badgeContent={miss.length}><Box sx={{ pl: 1.5 }}>חוסרים</Box></Badge>} />
              <Tab label={<Badge color="secondary" badgeContent={conflicts.length}><Box sx={{ pl: 1.5 }}>שעות קבועות</Box></Badge>} />
              <Tab label={<Badge color="error" badgeContent={crossDays.length}><Box sx={{ pl: 1.5 }}>מעבר בין סניפים</Box></Badge>} />
            </Tabs>

            {tab === 0 && (
              <IssueList
                items={dups}
                empty="אין ימים עם יותר מ-2 החתמות שממתינים להחלטה."
                render={(day) => {
                  const k = keyOf(day);
                  const mins = previewMinutes(day.punches, roles);
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fffbeb', borderColor: '#fde68a' }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 800 }}>{day.full_name}</Typography>
                        <BranchChip item={day} />
                        <Chip size="small" color="error" label={day.date} />
                        <Chip size="small" label={`${day.punches.length} החתמות`} />
                        <Box sx={{ flex: 1 }} />
                        <Typography sx={{ fontWeight: 700 }}>לתשלום: {asHours(mins)}</Typography>
                      </Stack>
                      {day.pending_resolution ? (
                        <Alert severity="warning" icon={false} sx={{ py: 0.2, mb: 1, fontSize: '0.78rem' }}>
                          ⏳ מנהל/ת הסניף {day.pending_resolution.by ? `(${day.pending_resolution.by}) ` : ''}
                          כבר סימנ/ה את היום — הסימון למטה הוא שלה
                          {canRemind ? '. ממתין לאישורך הסופי.' : '. ממתין לאישור הנהלת החשבונות.'}
                        </Alert>
                      ) : day.suggestion_reason && (
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
                      {canRemind && (
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
                          <Typography variant="caption" color="text.secondary">
                            חסרה החתמה באמצע (למשל חזרה מהפסקה)?
                          </Typography>
                          <TextField size="small" type="time" label="שעה" InputLabelProps={{ shrink: true }}
                            value={(newPunch[k] || {}).time || ''}
                            onChange={e => setNewPunch(s => ({ ...s, [k]: { ...(s[k] || {}), time: e.target.value } }))}
                            sx={{ width: 130 }}
                          />
                          <ToggleButtonGroup size="small" exclusive value={(newPunch[k] || {}).role || 'in'}
                            onChange={(_e, v) => v && setNewPunch(s => ({ ...s, [k]: { ...(s[k] || {}), role: v } }))}>
                            <ToggleButton value="in" sx={{ py: 0.2, px: 1.2, fontSize: '0.72rem' }}>כניסה</ToggleButton>
                            <ToggleButton value="out" sx={{ py: 0.2, px: 1.2, fontSize: '0.72rem' }}>יציאה</ToggleButton>
                          </ToggleButtonGroup>
                          <BusyButton size="small" variant="outlined" loading={!!busy[`${k}-add`]}
                            onClick={() => addPunchToDay(day)}>
                            הוסף החתמה
                          </BusyButton>
                        </Stack>
                      )}
                      {canFix && (
                        <>
                          <Divider sx={{ my: 1 }} />
                          <Stack direction="row" justifyContent="flex-end">
                            {/* Only accounting/admin settle a day. A manager's
                                click is a proposal, and the label says so. */}
                            <BusyButton size="small" variant="contained" color="success"
                              loading={!!busy[k]} onClick={() => approve(day)}>
                              {canRemind ? 'אשר יום' : 'שלח לאישור הנה״ח'}
                            </BusyButton>
                          </Stack>
                        </>
                      )}
                    </Paper>
                  );
                }}
              />
            )}

            {tab === 1 && (
              <>
                {canRemind && <AssignmentBoard />}
                {canRemind && (
                  <FormControlLabel
                    sx={{ mb: 1 }}
                    control={<Switch size="small" checked={selfEntry} onChange={e => setSelfEntry(e.target.checked)} />}
                    label={<Typography variant="body2">הזן בעצמי (עוקף את מנהל הסניף)</Typography>}
                  />
                )}
                <IssueList
                  items={miss}
                  empty="אין ימים עם החתמה חסרה."
                  render={(item) => {
                    const k = keyOf(item);
                    const v = fill[k] || {};
                    // Managers always fill their own staff's days; the accountant
                    // only when they explicitly switch on the override.
                    const mayEnter = canFix && (!canRemind || selfEntry);
                    return (
                      <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fff7ed', borderColor: '#fed7aa' }}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                          <Typography sx={{ fontWeight: 800 }}>{item.full_name}</Typography>
                          <BranchChip item={item} />
                          <Chip size="small" color="warning" label={item.date} />
                          <Chip size="small" label={`החתמה יחידה: ${item.punch_hhmm}`} />
                          {item.is_manual && <Chip size="small" variant="outlined" color="secondary" label="ידני" />}
                        </Stack>
                        {(item.pending_punches || []).length > 0 && (
                          <Alert severity="info" sx={{ mb: 1, py: 0.3, borderRadius: 2 }}>
                            <Typography variant="caption" sx={{ fontWeight: 700, display: 'block' }}>
                              כבר קיים דיווח ממתין לאישור ליום זה — אשרו אותו במקום להקליד שוב (הקלדה חוזרת תיחסם ככפולה):
                            </Typography>
                            <Stack direction="row" spacing={1} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                              {item.pending_punches.map(pp => (
                                <BusyButton key={pp.id} size="small" variant="contained" color="success"
                                  loading={!!busy[`pp|${pp.id}`]} onClick={() => approvePending(item, pp)}>
                                  אשר {pp.state === 0 ? 'כניסה' : 'יציאה'} {pp.hhmm}
                                  {(pp.status === 'pending_manager' || pp.status === 'pending') ? ' · ממתין למנהל' : ''}
                                </BusyButton>
                              ))}
                            </Stack>
                          </Alert>
                        )}
                        {mayEnter ? (
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="caption" color="text.secondary">השלמה:</Typography>
                            <TextField size="small" type="time" label="כניסה" InputLabelProps={{ shrink: true }}
                              value={v.in || ''} onChange={e => setFill(f => ({ ...f, [k]: { ...v, in: e.target.value } }))} sx={{ width: 130 }} />
                            <TextField size="small" type="time" label="יציאה" InputLabelProps={{ shrink: true }}
                              value={v.out || ''} onChange={e => setFill(f => ({ ...f, [k]: { ...v, out: e.target.value } }))} sx={{ width: 130 }} />
                            <BusyButton size="small" variant="contained" loading={!!busy[k]} onClick={() => addMissing(item)}>הוסף</BusyButton>
                            <Typography variant="caption" color="text.secondary">מלא/י רק את החסר</Typography>
                          </Stack>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            ממתין להשלמה ע״י מנהל/ת הסניף או ע״י העובד/ת מהאזור האישי.
                          </Typography>
                        )}
                      </Paper>
                    );
                  }}
                />
              </>
            )}

            {tab === 2 && (
              <IssueList
                items={conflicts}
                empty="אין התנגשויות בין שעות קבועות להחתמות בשעון."
                render={(item) => {
                  const k = keyOf(item);
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#f0fdfa', borderColor: '#99f6e4' }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                        <ScheduleIcon fontSize="small" sx={{ color: '#0f766e' }} />
                        <Typography sx={{ fontWeight: 800 }}>{item.full_name}</Typography>
                        <BranchChip item={item} />
                        <Chip size="small" color="secondary" label={item.date} />
                        <Chip size="small" variant="outlined" label={`שעות קבועות: ${item.planned_in}–${item.planned_out}`} />
                        <Chip size="small" variant="outlined" color="success" label={`${item.clock_punches} החתמות בשעון`} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                        לעובדת זו מוגדרות שעות קבועות, אך היא גם החתימה בשעון באותו יום — לכן לא נוצרו שעות קבועות. מה קובע?
                      </Typography>
                      {canFix && (
                        <Stack direction="row" spacing={1}>
                          <BusyButton size="small" variant="contained" color="success" loading={!!busy[k]}
                            onClick={() => resolveConflict(item, 'clock')}>שלם לפי השעון</BusyButton>
                          <BusyButton size="small" variant="outlined" color="secondary" loading={!!busy[k]}
                            onClick={() => resolveConflict(item, 'fixed')}>שלם לפי השעות הקבועות</BusyButton>
                        </Stack>
                      )}
                    </Paper>
                  );
                }}
              />
            )}

            {tab === 3 && (
              <IssueList
                items={crossDays}
                empty="אין ימים שנפתחו בסניף אחד ונסגרו באחר."
                render={(item) => {
                  const k = keyOf(item);
                  return (
                    <Paper key={k} variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fef2f2', borderColor: '#fecaca' }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 800 }}>{item.full_name}</Typography>
                        <Chip size="small" color="error" label={item.date} />
                        <Box sx={{ flex: 1 }} />
                        <Typography sx={{ fontWeight: 700 }}>{asHours(item.minutes)}</Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap' }}>
                        <Chip size="small" color="success" label={`כניסה ${item.in_hhmm} · ${item.in_branch_name}`} />
                        <Typography sx={{ opacity: 0.6 }}>→</Typography>
                        <Chip size="small" color="error" label={`יציאה ${item.out_hhmm} · ${item.out_branch_name}`} />
                      </Stack>
                      <Alert severity="warning" icon={false} sx={{ py: 0.2, mb: 1, fontSize: '0.78rem' }}>
                        לא נסגרה החתמה ב{item.in_branch_name} ולא נפתחה ב{item.out_branch_name}. כל היום נזקף כרגע
                        ל{item.in_branch_name} — ולסניפים יש תעריפים ועמותות שונים. הזינו את שעת המעבר בפועל
                        והמערכת תפצל ליציאה מ{item.in_branch_name} וכניסה ל{item.out_branch_name}.
                      </Alert>
                      {item.pending_resolution && (
                        <Alert severity="info" icon={false} sx={{ py: 0.2, mb: 1, fontSize: '0.78rem' }}>
                          ⏳ נשלח כבר לאישור {item.pending_resolution.by ? `על ידי ${item.pending_resolution.by}` : ''}.
                        </Alert>
                      )}
                      {canFix && (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <TextField
                            size="small" type="time" label="שעת המעבר" InputLabelProps={{ shrink: true }}
                            sx={{ width: 150 }}
                            value={transfer[k] || ''}
                            onChange={(e) => setTransfer(t => ({ ...t, [k]: e.target.value }))}
                          />
                          <BusyButton size="small" variant="contained" color="error" loading={!!busy[k]}
                            onClick={() => splitBranchDay(item)}>
                            {canRemind ? 'פצל את היום' : 'שלח לאישור הנה״ח'}
                          </BusyButton>
                        </Stack>
                      )}
                    </Paper>
                  );
                }}
              />
            )}

            {!canFix && <Alert severity="warning" sx={{ mt: 2 }}>תצוגה בלבד — אין לך הרשאה לתקן במסך זה.</Alert>}
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
