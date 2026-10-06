import { useState, useEffect } from 'react';
import { Box, Card, CardContent, Typography, Button, Stack, CircularProgress } from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import LockIcon from '@mui/icons-material/Lock';
import { startAuthentication } from '@simplewebauthn/browser';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * A second lock on the screens that hold somebody's money.
 *
 * Signing in already proved who she is, so this is not about identity — it is
 * about the gap between signing in and reading. A staff phone is unlocked and
 * put down on a table in a room full of people, and the session lasts thirty
 * days; anyone who picks it up is already inside. The payslips, the ID number
 * and the salary should take one more deliberate act to open, and a touch of
 * a finger is the cheapest deliberate act there is.
 *
 * WHAT IT IS NOT. It is not a security boundary the server enforces — the API
 * answers the same token it always did, and somebody determined could call it
 * directly. Claiming otherwise in a comment is how the next person comes to
 * rely on it for something it cannot carry. It raises the cost of a glance at
 * a borrowed phone, which is the threat that actually happens here.
 *
 * Unlocked per visit, not per session: coming back to the screen asks again.
 * The state lives in React and dies with the page, deliberately — remembering
 * it in storage would turn "ask every time" into "asked once, months ago".
 *
 * A person with no fingerprint enrolled is let through with the reason said
 * out loud and an offer to set one up. Locking her out of her own payslip
 * because of a setting she has not found yet would be its own kind of damage.
 */
export default function BiometricGate({ title = 'אזור אישי', children }) {
  const { user } = useAuth();
  const [state, setState] = useState('checking'); // checking | locked | open | unavailable
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // No platform authenticator at all — a desktop without Windows Hello, an
      // older device, a browser that does not support it.
      const supported = typeof window !== 'undefined'
        && window.PublicKeyCredential
        && await window.PublicKeyCredential
          .isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false);
      if (!alive) return;
      if (!supported || !user?.hasWebauthn) { setState('unavailable'); return; }
      setState('locked');
    })();
    return () => { alive = false; };
  }, [user?.hasWebauthn]);

  const unlock = async () => {
    setBusy(true);
    try {
      const options = await api.post('/auth/webauthn/auth/options', { userId: user.id });
      const credential = await startAuthentication({ optionsJSON: options.data });
      await api.post('/auth/webauthn/auth/verify', { userId: user.id, credential });
      setState('open');
    } catch (err) {
      // A cancelled prompt is a decision, not a fault — no red toast for it.
      const name = err?.name || '';
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        toast.error(err.response?.data?.error || 'האימות נכשל');
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === 'checking') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (state === 'open' || state === 'unavailable') {
    return (
      <>
        {state === 'unavailable' && !user?.hasWebauthn && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            אפשר להגן על המסך הזה בטביעת אצבע — ההגדרה בתפריט החשבון.
          </Typography>
        )}
        {children}
      </>
    );
  }

  return (
    <Box dir="rtl" sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
      <Card sx={{ maxWidth: 380, width: '100%' }}>
        <CardContent>
          <Stack spacing={2.5} alignItems="center" sx={{ textAlign: 'center', py: 2 }}>
            <LockIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{title}</Typography>
            <Typography variant="body2" color="text.secondary">
              המסך הזה מוגן. אשרו בטביעת אצבע או בזיהוי פנים כדי לפתוח אותו.
            </Typography>
            <Button
              variant="contained" size="large" fullWidth disabled={busy}
              startIcon={<FingerprintIcon />} onClick={unlock}
            >
              {busy ? 'מאמת…' : 'פתיחה'}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
