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
    // The server refuses anything shorter than 8 (auth.controller setPassword).
    if (pw.length < 8) return toast.error('סיסמה חייבת להיות לפחות 8 תווים');
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
              {/* The token, not a literal: this dialog renders under BOTH shells
                  and a hex here would be the redesign's purple sitting on the
                  classic theme. `primary.main` is whichever accent the person
                  is actually looking at. */}
              <FingerprintIcon sx={{ fontSize: 56, color: 'primary.main' }} />
              <Typography variant="body2" color="text.secondary">
                מוסיפים כניסה עם טביעת אצבע או זיהוי פנים במכשיר הזה —
                בפעם הבאה נכנסים בנגיעה אחת, בלי להקליד סיסמה.
              </Typography>
              {/*
                Asked for rather than offered, and the reason is on the screen.
                This was a suggestion with "אולי אחר כך" beside it, and almost
                nobody accepts a suggestion at the end of a form. The personal
                area holds payslips, an ID number and a salary, on a phone that
                gets put down on a table in a room full of people — so the
                second lock is the point, not a nicety, and this is the one
                moment the person is already here and already proving who she
                is. Still refusable: a device that cannot do it exists, and
                refusing must not lock anybody out of the system.
              */}
              <Typography variant="caption" color="text.secondary">
                נדרש כדי לפתוח את "צפי השכר שלי", התלושים והמסמכים האישיים.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => finish(true)} disabled={saving} color="inherit" size="small">
              לא עכשיו
            </Button>
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
                error={pw.length > 0 && pw.length < 8}
                helperText={pw.length > 0 && pw.length < 8 ? `לפחות 8 תווים — חסרים עוד ${8 - pw.length}` : 'לפחות 8 תווים'}
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
