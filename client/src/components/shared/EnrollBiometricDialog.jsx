import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
} from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { startRegistration } from '@simplewebauthn/browser';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * "Add a fingerprint" for the people who already have a password.
 *
 * The enrolment step after CHOOSING a password only ever reached somebody
 * choosing one. Everybody already in the system had passed that point long
 * ago, which is most of the staff — so the lock on the payslips existed and
 * nobody had the key to it.
 *
 * It repeats rather than blocks. A dialog with no way out is the wrong tool
 * here: platform authenticators report themselves available and then fail,
 * phones get handed over mid-shift, and a woman who cannot reach the daily
 * board because of a security prompt is a worse outcome than one who puts it
 * off. So "לא עכשיו" closes it for THIS session only and it is back at the
 * next launch — the same shape the punch popup uses, and the reason is the
 * same: the popup is the repeating reminder.
 *
 * Shown only where it can actually work: asking somebody on a desktop with no
 * reader to enrol a fingerprint teaches them to dismiss dialogs.
 */
export default function EnrollBiometricDialog({ open, onClose }) {
  const { refreshProfile } = useAuth();
  const [busy, setBusy] = useState(false);

  const enroll = async () => {
    setBusy(true);
    try {
      const optionsRes = await api.post('/auth/webauthn/register/options');
      const credential = await startRegistration({ optionsJSON: optionsRes.data });
      await api.post('/auth/webauthn/register/verify', { credential });
      toast.success('הכניסה הביומטרית הופעלה');
      try { await refreshProfile(); } catch { /* the flag refreshes on next load */ }
      onClose(true);
    } catch (err) {
      const name = err?.name || '';
      // Cancelling is a decision, not a fault.
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        toast.error(err.response?.data?.error || 'ההגדרה נכשלה — אפשר לנסות שוב מתפריט החשבון');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => onClose(false)} dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <FingerprintIcon color="primary" />
        כניסה מהירה ומוגנת
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1, alignItems: 'center', textAlign: 'center' }}>
          <FingerprintIcon sx={{ fontSize: 56, color: 'primary.main' }} />
          <Typography variant="body2" color="text.secondary">
            מוסיפים כניסה עם טביעת אצבע או זיהוי פנים במכשיר הזה —
            בפעם הבאה נכנסים בנגיעה אחת, בלי להקליד סיסמה.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            נדרש כדי לפתוח את "צפי השכר שלי", התלושים והמסמכים האישיים.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(false)} disabled={busy} color="inherit" size="small">
          לא עכשיו
        </Button>
        <Button variant="contained" startIcon={<FingerprintIcon />} onClick={enroll} disabled={busy}>
          {busy ? 'מגדיר…' : 'הפעלה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Whether this device can do it at all. Kept beside the dialog because the
 * gate and BiometricGate both need the same answer to the same question.
 */
export async function platformAuthenticatorAvailable() {
  try {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
    const fn = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn !== 'function') return false;
    return await fn.call(window.PublicKeyCredential);
  } catch { return false; }
}
