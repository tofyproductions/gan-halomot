import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  TextField, Typography, Alert, Box,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';

const BIO_USER_ID_KEY = 'gan_biometric_user_id';
const bioSupported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

/**
 * Choose the login password, then offer biometrics.
 *
 * A password is mandatory: a first login with none issues a restricted session
 * (must_change_password) that can reach nothing but this dialog. `forced` is
 * that case — no skip — and it runs in two steps: choose a password, then an
 * offer to add a fingerprint/Face so next time is one tap.
 *
 * The order matters. Choosing the password mints a full token, but we hold off
 * refreshing the global user until AFTER the biometric step — otherwise the
 * gate that mounts this dialog would see password_set=true and unmount us
 * mid-flow. refreshProfile() at the very end lifts the restriction and closes.
 */
export default function SetPasswordDialog({ open, onClose, allowSkip = false, forced = false }) {
  const { user, setPassword, refreshProfile } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState('password'); // 'password' | 'biometric'

  const finish = async (saved = true) => {
    try { await refreshProfile(); } catch { /* token is already applied */ }
    setPw(''); setPw2(''); setPhase('password');
    onClose(saved);
  };

  const submit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (pw.length < 4) return toast.error('סיסמה חייבת להיות לפחות 4 תווים');
    if (pw !== pw2) return toast.error('הסיסמאות אינן תואמות');
    setSaving(true);
    try {
      if (forced) {
        // Apply the new full token but do NOT refresh the global user yet — the
        // biometric step needs this dialog to stay mounted.
        const { data } = await api.post('/auth/set-password', { password: pw });
        if (data?.token) localStorage.setItem('token', data.token);
        toast.success('הסיסמה נקבעה');
        setSaving(false);
        if (bioSupported) setPhase('biometric');
        else await finish(true);
      } else {
        await setPassword(pw);
        toast.success('הסיסמה נקבעה — בכניסה הבאה תתבקש/י להזין אותה');
        setPw(''); setPw2('');
        onClose(true);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
      setSaving(false);
    }
  };

  const enrollBiometric = async () => {
    setSaving(true);
    try {
      const optionsRes = await api.post('/auth/webauthn/register/options');
      const credential = await startRegistration({ optionsJSON: optionsRes.data });
      await api.post('/auth/webauthn/register/verify', { credential });
      if (user?.id) localStorage.setItem(BIO_USER_ID_KEY, user.id);
      toast.success('כניסה ביומטרית הוגדרה');
      await finish(true);
    } catch (err) {
      // The OS prompt was dismissed — stay on the offer, let them try again or skip.
      if (err.name === 'NotAllowedError') { setSaving(false); return; }
      toast.error(err.response?.data?.error || 'שגיאה בהגדרת ביומטרי');
      setSaving(false);
    }
  };

  const biometricPhase = phase === 'biometric';

  return (
    <Dialog
      open={open}
      onClose={allowSkip && !biometricPhase ? () => onClose(false) : undefined}
      dir="rtl" maxWidth="xs" fullWidth
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {biometricPhase ? <FingerprintIcon color="primary" /> : <LockIcon color="primary" />}
        {biometricPhase ? 'כניסה מהירה בפעם הבאה' : (forced ? 'בחירת סיסמה למערכת' : 'בחירת סיסמה למערכת')}
      </DialogTitle>

      {biometricPhase ? (
        <>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1, alignItems: 'center', textAlign: 'center' }}>
              <FingerprintIcon sx={{ fontSize: 56, color: '#7c3aed' }} />
              <Typography variant="body2" color="text.secondary">
                אפשר להוסיף כניסה עם טביעת אצבע או זיהוי פנים במכשיר הזה —
                בפעם הבאה נכנסים בנגיעה אחת, בלי להקליד סיסמה.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => finish(true)} disabled={saving}>אולי אחר כך</Button>
            <Button variant="contained" startIcon={<FingerprintIcon />} onClick={enrollBiometric} disabled={saving}>
              {saving ? 'מגדיר…' : 'הפעלת כניסה ביומטרית'}
            </Button>
          </DialogActions>
        </>
      ) : (
        <Box component="form" onSubmit={submit}>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {forced ? (
                <Alert severity="warning" sx={{ py: 0.5 }}>
                  לאבטחת המידע צריך לבחור סיסמה אישית לפני הכניסה. מרגע שתיבחר,
                  הכניסה תדרוש אותה בכל פעם.
                </Alert>
              ) : (
                <Alert severity="info" sx={{ py: 0.5 }}>
                  לאבטחת המידע — בחירת סיסמה אישית. לאחר בחירתה, כל כניסה תדרוש אותה.
                </Alert>
              )}
              {/* Username hint so the browser/phone offers to SAVE the password. */}
              <input type="text" name="username" autoComplete="username" value={user?.full_name || ''}
                readOnly hidden aria-hidden="true" tabIndex={-1} />
              <TextField label="סיסמה חדשה" type="password" value={pw} autoFocus
                onChange={e => setPw(e.target.value)} fullWidth
                inputProps={{ dir: 'ltr', autoComplete: 'new-password' }} />
              <TextField label="אימות סיסמה" type="password" value={pw2}
                onChange={e => setPw2(e.target.value)} fullWidth
                inputProps={{ dir: 'ltr', autoComplete: 'new-password' }} />
              {allowSkip && (
                <Typography variant="caption" color="text.secondary">
                  אפשר לדלג — אך תתבקש/י שוב בכניסה הבאה עד שתיבחר סיסמה.
                </Typography>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            {allowSkip && <Button onClick={() => onClose(false)} disabled={saving}>דלג/י</Button>}
            <Button type="submit" variant="contained" disabled={saving}>
              {saving ? 'שומר…' : 'קביעת סיסמה'}
            </Button>
          </DialogActions>
        </Box>
      )}
    </Dialog>
  );
}
