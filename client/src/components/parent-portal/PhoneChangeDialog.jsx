import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  Stack, Alert, Typography,
} from '@mui/material';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * Changing the phone, in the only order that is safe.
 *
 * The code goes to the NEW number, not the old one. Whoever is looking at this
 * dialog is already inside the session, so a code to the current phone proves
 * nothing; a code to the new one proves they hold the phone they are about to
 * point every future login at.
 *
 * The screen says so plainly. A parent who mistypes their new number and never
 * receives the code should understand immediately why, rather than concluding
 * the app is broken — the alternative is a phone call to the gan and, worse, a
 * parent who assumes the change went through.
 */
const RESEND_SECONDS = 60;

export default function PhoneChangeDialog({ open, currentPhone, onClose, onChanged }) {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!open) return;
    setStep('phone'); setPhone(''); setCode(''); setError(''); setCooldown(0);
  }, [open]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async () => {
    setError('');
    setLoading(true);
    try {
      await parentApi.post('/phone/start', { phone });
      setStep('code');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      const wait = err?.response?.data?.retry_after_seconds;
      if (wait) setCooldown(wait);
      setError(parentApiError(err, 'שליחת הקוד נכשלה'));
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    setError('');
    setLoading(true);
    try {
      const { data } = await parentApi.post('/phone/confirm', { code });
      onChanged?.(data.phone);
      onClose();
    } catch (err) {
      setError(parentApiError(err, 'הקוד שגוי'));
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>שינוי מספר טלפון</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          {step === 'phone' && (
            <>
              <Typography variant="body2" color="text.secondary">
                המספר הרשום כעת: {currentPhone || 'לא ידוע'}
              </Typography>
              <TextField
                label="מספר חדש"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                inputMode="numeric"
                fullWidth
                autoFocus
              />
              <Alert severity="info">
                נשלח קוד <b>למספר החדש</b>. יש להיות עם המכשיר בהישג יד.
              </Alert>
            </>
          )}

          {step === 'code' && (
            <>
              <Typography variant="body2">
                שלחנו קוד למספר {phone}.
              </Typography>
              <TextField
                label="קוד"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                fullWidth
                autoFocus
                inputProps={{ style: { letterSpacing: '0.4em', textAlign: 'center' } }}
              />
              <Button variant="text" disabled={loading || cooldown > 0} onClick={send}>
                {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown}` : 'שליחת קוד חדש'}
              </Button>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>ביטול</Button>
        {step === 'phone' ? (
          <Button variant="contained" onClick={send} disabled={loading || phone.length < 9}>
            {loading ? 'שולח…' : 'שליחת קוד'}
          </Button>
        ) : (
          <Button variant="contained" onClick={confirm} disabled={loading || code.length < 6}>
            {loading ? 'בודק…' : 'אישור'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
