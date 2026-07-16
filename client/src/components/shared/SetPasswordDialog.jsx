import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  TextField, Typography, Alert,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { toast } from 'react-toastify';
import { useAuth } from '../../hooks/useAuth';

/**
 * Choose/change the login password. Used both as the first-login nag (dismissible
 * via `allowSkip`) and from the user menu. On success the auth profile refreshes
 * so password_set becomes true and the nag stops.
 */
export default function SetPasswordDialog({ open, onClose, allowSkip = false }) {
  const { setPassword } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (pw.length < 4) return toast.error('סיסמה חייבת להיות לפחות 4 תווים');
    if (pw !== pw2) return toast.error('הסיסמאות אינן תואמות');
    setSaving(true);
    try {
      await setPassword(pw);
      toast.success('הסיסמה נקבעה — בכניסה הבאה תתבקש/י להזין אותה');
      setPw(''); setPw2('');
      onClose(true);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={allowSkip ? () => onClose(false) : undefined} dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockIcon color="primary" /> בחירת סיסמה למערכת
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info" sx={{ py: 0.5 }}>
            לאבטחת המידע — מומלץ לבחור סיסמה אישית. לאחר בחירתה, כל כניסה תדרוש אותה.
          </Alert>
          <TextField label="סיסמה חדשה" type="password" value={pw} autoFocus
            onChange={e => setPw(e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
          <TextField label="אימות סיסמה" type="password" value={pw2}
            onChange={e => setPw2(e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
          {allowSkip && (
            <Typography variant="caption" color="text.secondary">
              אפשר לדלג — אך תתבקש/י שוב בכניסה הבאה עד שתיבחר סיסמה.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {allowSkip && <Button onClick={() => onClose(false)} disabled={saving}>דלג/י</Button>}
        <Button variant="contained" onClick={submit} disabled={saving}>
          {saving ? 'שומר…' : 'קבע סיסמה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
