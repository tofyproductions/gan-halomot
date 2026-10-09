import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, Button, Stack, Divider, Typography, ToggleButtonGroup, ToggleButton, Autocomplete, TextField } from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useUiVersion } from '../../hooks/useUiVersion';
import DeleteAccountRequest from '../shared/DeleteAccountRequest';
import {
  isWebPushSupported, getWebPushSubscriptionState, subscribeWebPush, unsubscribeWebPush,
} from '../../utils/webPush';
import { resetAllRememberedConfirms } from '../shared/ConfirmProvider';

/**
 * The two things the old Header kept in the foot of its drawer that were never
 * navigation: enrolling a fingerprint, and asking for the account to be
 * deleted. Both belong to the person rather than to any screen, so they live
 * behind the gear at the foot of the rail.
 *
 * The browser-notifications toggle lives here too. It arrived on main while
 * this branch was rewriting the shell, as an icon button in the old Header's
 * toolbar and a row in its drawer — and this branch deleted that file, so the
 * merge would have carried the feature away without a word. It belongs with
 * the fingerprint anyway: both are "this browser, this person".
 *
 * DELIBERATELY NOT /account. That route is MyAccount.jsx — the gan's
 * commercial screen, what they pay and why — and App.jsx gates it to
 * system_admin. Putting fingerprint enrolment behind it would have taken it
 * from every branch manager, teacher and assistant, which is exactly the group
 * that signs in on a phone in a room and wants it. The billing screen is
 * offered here as a link instead, and only to the person who has it.
 */
export default function AccountMenu({ open, onClose }) {
  const { user, isAdmin } = useAuth();
  const { isNew, switchTo } = useUiVersion();
  const navigate = useNavigate();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);

  useEffect(() => {
    let alive = true;
    isWebPushSupported().then(async (supported) => {
      if (!alive) return;
      setPushSupported(supported);
      if (!supported) return;
      const state = await getWebPushSubscriptionState();
      if (alive) setPushSubscribed(state === 'subscribed');
    });
    return () => { alive = false; };
  }, []);

  const handleTogglePush = useCallback(async () => {
    try {
      if (pushSubscribed) {
        await unsubscribeWebPush(api);
        setPushSubscribed(false);
        toast.success('התראות דפדפן כובו');
      } else {
        await subscribeWebPush(api);
        setPushSubscribed(true);
        toast.success('התראות דפדפן הופעלו!');
      }
    } catch (err) {
      toast.error(err.message || 'שגיאה בהגדרת התראות');
    }
  }, [pushSubscribed]);

  const handleSetupBiometric = useCallback(async () => {
    try {
      const optionsRes = await api.post('/auth/webauthn/register/options');
      const credential = await startRegistration({ optionsJSON: optionsRes.data });
      await api.post('/auth/webauthn/register/verify', { credential });
      localStorage.setItem('gan_biometric_user_id', user.id);
      toast.success('כניסה ביומטרית הוגדרה בהצלחה!');
    } catch (err) {
      // The browser's own "not now" is not an error worth a red toast.
      if (err.name === 'NotAllowedError') return;
      toast.error(err.response?.data?.error || 'שגיאה בהגדרת ביומטרי');
    }
  }, [user]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 0.5 }}>
        {user?.full_name || user?.email}
        <Typography variant="caption" component="div" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          חשבון והגדרות
        </Typography>
      </DialogTitle>

      <DialogContent>
        <Stack spacing={1} sx={{ pt: 1, pb: 1 }}>
          <Button
            startIcon={<FingerprintIcon />}
            onClick={handleSetupBiometric}
            fullWidth
            variant="outlined"
            sx={{ justifyContent: 'flex-start' }}
          >
            הפעלת כניסה בטביעת אצבע
          </Button>

          {/* The way back, and the way forward — the same door in both
              directions, which is what the offer dialog promised when it said
              "אפשר לחזור לעיצוב הישן בכל רגע". A promise like that has to be
              kept somewhere findable, and this is where everything else that
              belongs to the person rather than to a screen already lives. */}
          <Button
            startIcon={<ViewQuiltIcon />}
            onClick={() => switchTo(isNew ? 'classic' : 'new')}
            fullWidth
            variant="outlined"
            sx={{ justifyContent: 'flex-start' }}
          >
            {isNew ? 'חזרה לעיצוב הישן' : 'מעבר לעיצוב החדש'}
          </Button>

          {/* A browser that cannot do push should not be offered a switch for
              it — the check is asynchronous, so this is absent for a moment on
              first open rather than flickering off and on. */}
          {pushSupported && (
            <Button
              startIcon={pushSubscribed ? <NotificationsActiveIcon /> : <NotificationsOffIcon />}
              onClick={handleTogglePush}
              fullWidth
              variant="outlined"
              color={pushSubscribed ? 'success' : 'inherit'}
              sx={{ justifyContent: 'flex-start' }}
            >
              {pushSubscribed ? 'כיבוי התראות בדפדפן' : 'הפעלת התראות בדפדפן'}
            </Button>
          )}

          {/* The way back from "אל תשאל שוב".
              That checkbox writes to localStorage and the function that clears
              it has existed since the provider was written — reachable from
              nowhere in the app. Somebody who silenced a confirm by accident
              had no way to un-silence it short of clearing site data. */}
          <Button
            startIcon={<RestartAltIcon />}
            onClick={() => {
              const n = resetAllRememberedConfirms();
              toast.success(n ? `${n} אישורים יוצגו שוב` : 'לא היו אישורים מושתקים');
            }}
            fullWidth
            variant="outlined"
            color="inherit"
            sx={{ justifyContent: 'flex-start' }}
          >
            החזרת שאלות אישור שהושתקו
          </Button>

          {/* Offering a door that answers with a permission error is worse
              than not offering it. */}
          {isAdmin && (
            <Button
              startIcon={<ReceiptLongIcon />}
              onClick={() => { onClose(); navigate('/account'); }}
              fullWidth
              variant="outlined"
              sx={{ justifyContent: 'flex-start' }}
            >
              המנוי והחיוב של הגן
            </Button>
          )}

          <ViewAsSwitch onClose={onClose} />

          <Divider sx={{ pt: 1 }} />
          <DeleteAccountRequest />
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

/**
 * מצב תצוגה — the admin walking the building in somebody else's shoes.
 * Client-side skin only: the data stays the admin's; the screens arrange
 * themselves as the chosen role sees them. The purple banner (AppShell) is
 * the way back, always visible.
 */
function ViewAsSwitch({ onClose }) {
  const { canViewAs, viewAs, setViewAs, impersonate } = useAuth();
  const [pickOpen, setPickOpen] = useState(false);
  const [users, setUsers] = useState(null);
  const [target, setTarget] = useState(null);
  const [starting, setStarting] = useState(false);
  if (!canViewAs && !viewAs) return null;

  const openPick = async () => {
    setPickOpen(true);
    if (users) return;
    try {
      const { data } = await api.get('/admin/users');
      setUsers((data.users || data || []).filter(u => u.role !== 'system_admin'));
    } catch { toast.error('טעינת המשתמשים נכשלה'); setPickOpen(false); }
  };
  const start = async () => {
    setStarting(true);
    try { await impersonate(target._id || target.id); }
    catch (err) { toast.error(err.response?.data?.error || 'הכניסה נכשלה'); setStarting(false); }
  };

  return (
    <>
      <Divider sx={{ pt: 1 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        מצב תצוגה — איך המערכת נראית לתפקידים אחרים (הנתונים נשארים שלך)
      </Typography>
      <ToggleButtonGroup
        exclusive fullWidth size="small"
        value={viewAs || 'admin'}
        onChange={(_, v) => { if (v) { onClose(); setViewAs(v === 'admin' ? '' : v); } }}
      >
        <ToggleButton value="admin">מנהל מערכת</ToggleButton>
        <ToggleButton value="branch_manager">מנהלת סניף</ToggleButton>
        <ToggleButton value="teacher">עובדת</ToggleButton>
      </ToggleButtonGroup>

      {/* Borrowed eyes: a specific person's REAL data. Server-minted token,
          read-only by construction, 30 minutes, logged. */}
      {!pickOpen ? (
        <Button fullWidth variant="outlined" sx={{ justifyContent: 'flex-start' }} onClick={openPick}>
          🔍 כניסה בשם משתמש ספציפי (נתונים אמיתיים)
        </Button>
      ) : (
        <Stack spacing={1}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            צפייה בנתונים האמיתיים של המשתמש — קריאה בלבד, ל-30 דקות. שום פעולה לא תירשם בשמו/ה.
          </Typography>
          <Autocomplete
            size="small"
            options={users || []}
            loading={!users}
            value={target}
            getOptionLabel={(u) => `${u.full_name}${u.branch_id?.name ? ` — ${u.branch_id.name}` : ''}`}
            onChange={(_, v) => setTarget(v)}
            renderInput={(p) => <TextField {...p} label="משתמש" />}
          />
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setPickOpen(false)}>ביטול</Button>
            <Button size="small" variant="contained" disabled={!target || starting} onClick={start}>
              {starting ? 'נכנס…' : 'כניסה בשמו/ה'}
            </Button>
          </Stack>
        </Stack>
      )}
    </>
  );
}
