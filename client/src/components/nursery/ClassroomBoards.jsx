import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, IconButton, Tooltip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert, CircularProgress,
  MenuItem,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import AddIcon from '@mui/icons-material/Add';
import KeyIcon from '@mui/icons-material/Key';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import TabletMacIcon from '@mui/icons-material/TabletMac';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * לוחות כיתה — the tablets, and the passwords that open them.
 *
 * The screen is a to-do list rather than an inventory: the rooms with no board
 * yet are listed beside the ones that have one, because "which classes are not
 * on a tablet" is the question somebody is actually holding when they open it.
 *
 * The link is shown and copied freely. It is not the secret — it says WHICH
 * board a tablet is, so the room opens on its own class instead of asking
 * somebody to pick from every room in the network. The password is the secret
 * and is only ever set here, never displayed: nothing in this screen can tell
 * you what a password IS, only replace it.
 */

const isInstalledApp = () =>
  typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone === true);

function useOrigin() {
  return useMemo(() => {
    const here = typeof window !== 'undefined' ? window.location.origin : '';
    // Inside the installed app the origin is capacitor://localhost, which is
    // valid here and useless on the tablet. A link nobody can open is worse
    // than no button.
    const unusable = !here
      || /^capacitor:/i.test(here)
      || /^https?:\/\/localhost(:|$)/i.test(here)
      || /^https?:\/\/127\./i.test(here);
    return unusable ? 'https://gan-halomot.onrender.com' : here;
  }, []);
}

function CopyLink({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { toast.error('ההעתקה נכשלה'); }
  };
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, minWidth: 240 }}>
      <Typography
        dir="ltr"
        sx={{
          flex: 1, fontFamily: 'monospace', fontSize: '.78rem',
          color: 'text.secondary', wordBreak: 'break-all', textAlign: 'left',
        }}
      >
        {url}
      </Typography>
      <Tooltip title={copied ? 'הועתק' : 'העתקה'}>
        <IconButton size="small" color={copied ? 'success' : 'primary'} onClick={copy}>
          {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="פתיחה">
        <IconButton size="small" href={url} target="_blank" rel="noopener noreferrer">
          <OpenInNewIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="שליחה בוואטסאפ">
        <IconButton
          size="small" sx={{ color: 'success.main' }}
          href={`https://wa.me/?text=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer"
        >
          <WhatsAppIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

export default function ClassroomBoards() {
  const origin = useOrigin();
  const [data, setData] = useState({ boards: [], missing: [] });
  const [loading, setLoading] = useState(true);
  const [create, setCreate] = useState(null);   // { classroom_id, classroom, branch, password }
  const [pwd, setPwd] = useState(null);         // { board, password }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/classroom-boards')
      .then(res => setData(res.data))
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת הלוחות'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const doCreate = async () => {
    if ((create.password || '').length < 6) return toast.error('הסיסמה חייבת להיות באורך 6 תווים לפחות');
    setBusy(true);
    try {
      await api.post('/classroom-boards', {
        classroom_id: create.classroom_id, password: create.password,
      });
      toast.success('הלוח נוצר');
      setCreate(null);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'היצירה נכשלה'); }
    finally { setBusy(false); }
  };

  const doSetPassword = async () => {
    if ((pwd.password || '').length < 6) return toast.error('הסיסמה חייבת להיות באורך 6 תווים לפחות');
    setBusy(true);
    try {
      await api.post(`/classroom-boards/${pwd.board.id}/password`, { password: pwd.password });
      toast.success('הסיסמה עודכנה');
      setPwd(null);
    } catch (err) { toast.error(err.response?.data?.error || 'העדכון נכשל'); }
    finally { setBusy(false); }
  };

  const revoke = async (board) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `לבטל את הקישור של "${board.classroom}"?\n\n`
      + 'הקישור הנוכחי יפסיק לעבוד וגם הכניסה הביומטרית בטאבלט תימחק. '
      + 'יהיה צריך לפתוח את הקישור החדש בטאבלט ולהיכנס מחדש עם הסיסמה.',
    )) return;
    try {
      await api.post(`/classroom-boards/${board.id}/revoke`);
      toast.success('הקישור הוחלף');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const toggleActive = async (board) => {
    try {
      await api.patch(`/classroom-boards/${board.id}`, { is_active: !board.is_active });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>לוחות כיתה</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        משתמש אחד לכל כיתה, לטאבלט שתלוי בחדר. פותחים את הקישור בטאבלט, מזינים את הסיסמה פעם אחת,
        ומשם הצוות מזין את לוח העדכונים בלי להתחבר עם משתמש אישי.
      </Typography>

      {isInstalledApp() && (
        <Alert severity="info" sx={{ mb: 2 }}>
          הקישורים מוצגים עם הכתובת האמיתית של האתר ולא עם הכתובת הפנימית של האפליקציה,
          כדי שיעבדו בטאבלט.
        </Alert>
      )}

      {loading ? <CircularProgress /> : (
        <Stack spacing={2}>
          {data.boards.length > 0 && (
            <Stack spacing={1.5}>
              {data.boards.map(b => (
                <Paper key={b.id} variant="outlined" sx={{ p: 2, borderRadius: 3, opacity: b.is_active ? 1 : 0.55 }}>
                  <Stack direction="row" spacing={1.2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.2 }}>
                    <TabletMacIcon color="primary" />
                    <Typography sx={{ fontWeight: 800 }}>{b.classroom || '—'}</Typography>
                    <Chip size="small" label={b.branch || 'ללא סניף'} />
                    {b.has_biometric && (
                      <Tooltip title="הוגדרה כניסה ביומטרית בטאבלט">
                        <Chip size="small" color="success" variant="outlined" icon={<FingerprintIcon />} label="ביומטרי" />
                      </Tooltip>
                    )}
                    {!b.has_password && <Chip size="small" color="error" label="אין סיסמה" />}
                    {!b.is_active && <Chip size="small" color="warning" label="מכובה" />}
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" startIcon={<KeyIcon />} onClick={() => setPwd({ board: b, password: '' })}>
                      החלפת סיסמה
                    </Button>
                    <Button size="small" color="error" startIcon={<LinkOffIcon />} onClick={() => revoke(b)}>
                      ביטול קישור
                    </Button>
                    <Button size="small" color={b.is_active ? 'warning' : 'success'} onClick={() => toggleActive(b)}>
                      {b.is_active ? 'כיבוי' : 'הפעלה'}
                    </Button>
                  </Stack>
                  <Divider sx={{ mb: 1 }} />
                  <CopyLink url={`${origin}/board/${b.board_token}`} />
                </Paper>
              ))}
            </Stack>
          )}

          {data.missing.length > 0 && (
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Typography sx={{ fontWeight: 800, mb: 0.5 }}>כיתות ללא לוח</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                לכיתות האלה עדיין אין טאבלט מחובר.
              </Typography>
              <Stack spacing={0.8}>
                {data.missing.map(m => (
                  <Stack
                    key={m.classroom_id} direction="row" spacing={1} alignItems="center"
                    flexWrap="wrap" useFlexGap
                    sx={{ px: 1.2, py: 0.9, borderRadius: 2, bgcolor: 'background.default' }}
                  >
                    <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 130 }}>{m.classroom}</Typography>
                    <Chip size="small" variant="outlined" label={m.branch || 'ללא סניף'} />
                    <Box sx={{ flex: 1 }} />
                    <Button
                      size="small" variant="contained" startIcon={<AddIcon />}
                      onClick={() => setCreate({ ...m, password: '' })}
                    >
                      יצירת לוח
                    </Button>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}

          {data.boards.length === 0 && data.missing.length === 0 && (
            <Alert severity="info" icon={false}>אין כיתות פעילות להצגה.</Alert>
          )}
        </Stack>
      )}

      <Alert severity="warning" sx={{ mt: 2.5 }} icon={false}>
        <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>שימו לב</Typography>
        הטאבלט נשאר מחובר לאורך זמן, ולכן הלוח רואה את הכיתה שלו בלבד — לא כיתות אחרות,
        לא עובדים, לא שכר ולא פרטי הורים. אם טאבלט אבד — ״ביטול קישור״ מנתק אותו מיד.
      </Alert>

      <Dialog open={!!create} onClose={() => !busy && setCreate(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle sx={{ fontWeight: 800 }}>לוח חדש — {create?.classroom}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField size="small" label="סניף" value={create?.branch || ''} disabled fullWidth />
            <TextField
              size="small" label="סיסמה ללוח" type="text" fullWidth autoFocus
              value={create?.password || ''}
              onChange={e => setCreate(c => ({ ...c, password: e.target.value }))}
              helperText="לפחות 6 תווים. זו הסיסמה שהצוות יקליד בטאבלט פעם אחת."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreate(null)} disabled={busy}>ביטול</Button>
          <Button variant="contained" onClick={doCreate} disabled={busy}>יצירה</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!pwd} onClose={() => !busy && setPwd(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle sx={{ fontWeight: 800 }}>סיסמה חדשה — {pwd?.board?.classroom}</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2, mt: 1 }}>
            הטאבלט שכבר מחובר ימשיך לעבוד. הסיסמה החדשה נדרשת רק בכניסה הבאה.
          </Alert>
          <TextField
            size="small" label="סיסמה" type="text" fullWidth autoFocus
            value={pwd?.password || ''}
            onChange={e => setPwd(p => ({ ...p, password: e.target.value }))}
            helperText="לפחות 6 תווים"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPwd(null)} disabled={busy}>ביטול</Button>
          <Button variant="contained" onClick={doSetPassword} disabled={busy}>שמירה</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
