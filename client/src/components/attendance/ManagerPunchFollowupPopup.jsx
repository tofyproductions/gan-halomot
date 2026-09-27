import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, Paper,
  Chip, TextField, Divider, Fab, Box,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { MissingCard, DuplicateCard, EmptyDayCard, dayLabel, KIND_TITLE } from './PunchFixCards';

/**
 * "החתמות לטיפול" — the branch manager's daily punch follow-up
 * (docs/superpowers/specs/2026-09-27-punch-followup-design.md, stage 3),
 * modeled on tofy's owner-only DailyApprovalsModal.
 *
 * Opens once a day at her first entry (localStorage date); `?punch_followup=1`
 * (the morning push's link) opens it regardless. Closed with work left → a
 * floating chip reopens it. Two sections: what employees already answered
 * (approve / reject), and days nobody handled (fix it herself, or remind).
 */
const DISMISS_KEY = 'punchFollowupDismissedOn';
const todayIL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const ROLE_HE = { in: 'כניסה', out: 'יציאה', ignore: 'בטעות' };
const REQ_HE = { sick: 'בקשת מחלה', vacation: 'בקשת חופשה', pregnancy_exam: 'בדיקת הריון' };

function Reported({ card }) {
  const r = card.reported;
  const clock = card.punches.filter(p => p.counted).map(p => p.hhmm);
  return (
    <Stack spacing={0.5}>
      {clock.length > 0 && <Typography variant="body2" color="text.secondary">בשעון: {clock.join(', ')}</Typography>}
      {r.punches.length > 0 && (
        <Typography variant="body2">
          דיווחה: {r.punches.map(p => p.hhmm).join(', ')}
          {r.punches.some(p => p.note) ? ` — "${r.punches.map(p => p.note).filter(Boolean).join(' · ')}"` : ''}
        </Typography>
      )}
      {r.labels && (
        <Typography variant="body2">
          סימנה: {r.labels.map(l => `${l.hhmm} ${ROLE_HE[l.role]}`).join(' · ')}
        </Typography>
      )}
      {r.explanation && <Typography variant="body2">הסבר: "{r.explanation}"</Typography>}
      {card.schedule && (
        <Typography variant="caption" color="text.secondary">
          לפי ההתחייבות: {card.schedule.start}–{card.schedule.end}
        </Typography>
      )}
    </Stack>
  );
}

function AwaitingCard({ card, busy, onDecide, onGo }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  if (card.reported.request && !card.reported.punches.length && !card.reported.labels && !card.reported.explanation) {
    return (
      <Stack spacing={1}>
        <Typography variant="body2">{REQ_HE[card.reported.request.type] || 'בקשה'} ממתינה ליום הזה.</Typography>
        <Button size="small" variant="outlined" onClick={() => onGo('/employee-requests')}>למסך הבקשות</Button>
      </Stack>
    );
  }
  return (
    <Stack spacing={1}>
      <Reported card={card} />
      {!rejecting ? (
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="contained" color="success" disabled={busy} onClick={() => onDecide(true)}>✓ אשר</Button>
          <Button size="small" variant="outlined" color="error" disabled={busy} onClick={() => setRejecting(true)}>✗ דחה</Button>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1}>
          <TextField size="small" label="סיבה (העובדת תראה)" value={reason} onChange={e => setReason(e.target.value)} fullWidth />
          <Button size="small" variant="contained" color="error" disabled={busy || !reason.trim()}
            onClick={() => onDecide(false, reason)}>דחה</Button>
        </Stack>
      )}
    </Stack>
  );
}

function UnhandledCard({ card, busy, onFix, onRemind }) {
  const [fixing, setFixing] = useState(false);
  const last = card.last_reminder
    ? `תזכורת אחרונה: ${card.last_reminder.action === 'manager_push' ? 'פוש' : 'וואטסאפ'} · ${new Date(card.last_reminder.at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : 'לא נשלחה תזכורת';
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        פתוח {card.days_open} ימים · {last}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button size="small" variant={fixing ? 'contained' : 'outlined'} onClick={() => setFixing(f => !f)}>אתקן בעצמי</Button>
        {card.has_phone && (
          <Button size="small" variant="outlined" color="success" disabled={busy} onClick={() => onRemind('whatsapp')}>📲 וואטסאפ</Button>
        )}
        {card.has_user && (
          <Button size="small" variant="outlined" disabled={busy} onClick={() => onRemind('push')}>🔔 פוש</Button>
        )}
      </Stack>
      {fixing && (
        <Box sx={{ pt: 0.5 }}>
          {card.kind === 'missing' && <MissingCard issue={card} busy={busy} onSend={onFix} />}
          {card.kind === 'duplicate' && <DuplicateCard issue={card} busy={busy} onSend={onFix} />}
          {card.kind === 'empty_day' && <EmptyDayCard issue={card} busy={busy} onSend={onFix} forManager />}
        </Box>
      )}
    </Stack>
  );
}

export default function ManagerPunchFollowupPopup() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isBranchManager = user?.role === 'branch_manager' || user?.role === 'admin_viewer';
  const [data, setData] = useState({ active: false, awaiting: [], unhandled: [] });
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const forced = new URLSearchParams(location.search).get('punch_followup') === '1';

  const load = useCallback(() => {
    api.get('/punch-followup/manager')
      .then(res => setData(res.data))
      .catch(() => setData({ active: false, awaiting: [], unhandled: [] }));
  }, []);

  useEffect(() => { if (isBranchManager) load(); }, [isBranchManager, load, forced]);

  const count = data.awaiting.length + data.unhandled.length;

  useEffect(() => {
    if (!count) { setOpen(false); return; }
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === todayIL(); } catch { /* private mode */ }
    if (forced || !dismissed) setOpen(true);
  }, [count, forced]);

  const close = () => {
    try { localStorage.setItem(DISMISS_KEY, todayIL()); } catch { /* private mode */ }
    setOpen(false);
  };

  const call = async (card, path, payload, okText) => {
    // WhatsApp: the window must open inside the tap itself — a phone blocks a
    // window opened after the server answers. Open it now, aim it after.
    const waWin = payload?.channel === 'whatsapp' ? window.open('', '_blank') : null;
    setBusyKey(card.key);
    try {
      const res = await api.post(`/punch-followup/${path}`, { issue_key: card.key, ...payload });
      if (res.data?.url) {
        if (waWin) waWin.location.href = res.data.url; else window.location.href = res.data.url;
      }
      if (okText) toast.success(okText);
      load();
    } catch (err) {
      if (waWin) waWin.close();
      toast.error(err.response?.data?.error || 'הפעולה נכשלה');
    } finally { setBusyKey(null); }
  };

  if (!isBranchManager || !count) return null;

  const title = (card) => (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
      <Typography sx={{ fontWeight: 800 }}>{card.full_name}</Typography>
      <Chip size="small" label={`${dayLabel(card.date)} · ${KIND_TITLE[card.kind]}`} />
      {card.branch_name && <Typography variant="caption" color="text.secondary">{card.branch_name}</Typography>}
    </Stack>
  );

  return (
    <>
      {!open && (
        <Fab variant="extended" color="warning" size="medium" onClick={() => setOpen(true)}
          sx={{ position: 'fixed', bottom: { xs: 88, md: 24 }, left: 24, zIndex: 1200, fontWeight: 800 }}>
          ⏱️ {count} לטיפול בהחתמות
        </Fab>
      )}
      <Dialog open={open} onClose={close} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>
          החתמות לטיפול
          <Typography variant="body2" color="text.secondary">
            {data.awaiting.length} ממתינים לאישורך · {data.unhandled.length} לא טופלו ע״י העובדת
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            {data.awaiting.length > 0 && (
              <>
                <Typography sx={{ fontWeight: 800 }}>✋ ממתינים לאישורך</Typography>
                {data.awaiting.map(card => (
                  <Paper key={card.key} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                    {title(card)}
                    <AwaitingCard card={card} busy={busyKey === card.key} onGo={(to) => { close(); navigate(to); }}
                      onDecide={(approve, reason) => call(card, 'decide', { approve, reason }, approve ? 'אושר' : 'נדחה — העובדת תקבל הודעה')} />
                  </Paper>
                ))}
              </>
            )}
            {data.awaiting.length > 0 && data.unhandled.length > 0 && <Divider />}
            {data.unhandled.length > 0 && (
              <>
                <Typography sx={{ fontWeight: 800 }}>⛔ לא טופלו ע״י העובדת</Typography>
                {data.unhandled.map(card => (
                  <Paper key={card.key} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                    {title(card)}
                    <UnhandledCard card={card} busy={busyKey === card.key}
                      onFix={(payload) => call(card, 'fix-as-manager', payload, 'נשמר — עבר לאישור הנה״ח')}
                      onRemind={(channel) => call(card, 'remind', { channel }, channel === 'push' ? 'נשלחה תזכורת בפוש' : null)} />
                  </Paper>
                ))}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>אחר כך</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
