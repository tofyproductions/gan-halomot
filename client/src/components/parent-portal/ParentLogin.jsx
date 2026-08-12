import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack, Alert, Link,
} from '@mui/material';
import parentApi, { parentApiError, PARENT_TOKEN_KEY } from '../../api/parentClient';

/**
 * One screen, four states.
 *
 * A parent does not know whether they have an account — they were told "there
 * is an app now". So the screen never asks. It opens on the everyday case, ID
 * number and password, and when the server answers NOT_ACTIVATED it moves
 * itself into activation instead of showing an error. Activation and "forgot
 * my password" are the same three steps and the same code, because they carry
 * the same risk; only the wording differs.
 *
 * The ID field accepts digits only and the code field likewise: both are
 * pasted from a message or typed on a phone keypad, and a stray space that
 * silently fails a comparison is a support call.
 */

const RESEND_SECONDS = 60;

export default function ParentLogin() {
  const navigate = useNavigate();

  const [step, setStep] = useState('login'); // login | code | password
  const [idNumber, setIdNumber] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [code, setCode] = useState('');

  const [setupToken, setSetupToken] = useState('');
  const [phoneHint, setPhoneHint] = useState('');
  const [mode, setMode] = useState('activate'); // activate | reset

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const codeRef = useRef(null);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const digitsOnly = (v, max) => v.replace(/\D/g, '').slice(0, max);

  const finish = (token) => {
    localStorage.setItem(PARENT_TOKEN_KEY, token);
    navigate('/parents', { replace: true });
  };

  /** Ask for a code. Shared by first activation and by a forgotten password. */
  const requestCode = async (nextMode) => {
    setError('');
    setNotice('');
    if (idNumber.length < 5) {
      setError('יש להזין מספר תעודת זהות');
      return;
    }
    setLoading(true);
    try {
      const { data } = await parentApi.post('/auth/start', { id_number: idNumber });
      setMode(data.mode || nextMode);
      setPhoneHint(data.phone_hint || '');
      setCode('');
      setStep('code');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      // The server counts the seconds; echoing its number keeps the screen
      // honest instead of guessing a wait it does not know.
      const wait = err?.response?.data?.retry_after_seconds;
      if (wait) setCooldown(wait);
      setError(parentApiError(err, 'שליחת הקוד נכשלה'));
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await parentApi.post('/auth/login', {
        id_number: idNumber,
        password,
      });
      finish(data.token);
    } catch (err) {
      // Never activated is not a failed login — send them to activation
      // rather than making them hunt for a password they never chose.
      if (err?.response?.data?.code === 'NOT_ACTIVATED') {
        setLoading(false);
        await requestCode('activate');
        return;
      }
      setError(parentApiError(err, 'שגיאה בהתחברות'));
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await parentApi.post('/auth/verify', {
        id_number: idNumber,
        code,
      });
      setSetupToken(data.setup_token);
      setPassword('');
      setPasswordAgain('');
      setStep('password');
    } catch (err) {
      setError(parentApiError(err, 'הקוד שגוי'));
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleSetPassword = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('הסיסמה חייבת להכיל לפחות 8 תווים');
      return;
    }
    if (password !== passwordAgain) {
      setError('שתי הסיסמאות אינן זהות');
      return;
    }
    setLoading(true);
    try {
      const { data } = await parentApi.post('/auth/set-password', {
        setup_token: setupToken,
        password,
      });
      finish(data.token);
    } catch (err) {
      setError(parentApiError(err, 'שמירת הסיסמה נכשלה'));
      setLoading(false);
    }
  };

  const backToLogin = () => {
    setStep('login');
    setError('');
    setNotice('');
    setCode('');
    setPassword('');
    setPasswordAgain('');
  };

  return (
    <Box sx={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      p: 2,
      bgcolor: 'background.default',
    }}>
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
            <Typography variant="h5" fontWeight={700}>גן החלומות</Typography>
            <Typography variant="body2" color="text.secondary">אזור אישי להורים</Typography>
          </Stack>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}

          {step === 'login' && (
            <form onSubmit={handleLogin}>
              <Stack spacing={2}>
                <TextField
                  label="תעודת זהות"
                  value={idNumber}
                  onChange={(e) => setIdNumber(digitsOnly(e.target.value, 9))}
                  inputMode="numeric"
                  autoComplete="username"
                  fullWidth
                  autoFocus
                />
                <TextField
                  label="סיסמה"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  fullWidth
                />
                <Button type="submit" variant="contained" size="large" disabled={loading} fullWidth>
                  {loading ? 'רגע…' : 'כניסה'}
                </Button>
                <Stack direction="row" justifyContent="space-between">
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={() => requestCode('activate')}
                  >
                    כניסה ראשונה
                  </Link>
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={() => requestCode('reset')}
                  >
                    שכחתי סיסמה
                  </Link>
                </Stack>
              </Stack>
            </form>
          )}

          {step === 'code' && (
            <form onSubmit={handleVerify}>
              <Stack spacing={2}>
                <Typography variant="body2">
                  שלחנו קוד בן 6 ספרות למספר {phoneHint || 'הרשום אצלנו'}.
                </Typography>
                <TextField
                  inputRef={codeRef}
                  label="קוד"
                  value={code}
                  onChange={(e) => setCode(digitsOnly(e.target.value, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  fullWidth
                  inputProps={{ style: { letterSpacing: '0.4em', textAlign: 'center' } }}
                />
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={loading || code.length < 6}
                  fullWidth
                >
                  {loading ? 'בודק…' : 'אישור'}
                </Button>
                <Button
                  type="button"
                  variant="text"
                  disabled={loading || cooldown > 0}
                  onClick={() => requestCode(mode)}
                >
                  {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown}` : 'שליחת קוד חדש'}
                </Button>
                <Link component="button" type="button" variant="body2" onClick={backToLogin}>
                  חזרה
                </Link>
              </Stack>
            </form>
          )}

          {step === 'password' && (
            <form onSubmit={handleSetPassword}>
              <Stack spacing={2}>
                <Typography variant="body2">
                  {mode === 'reset' ? 'בחרו סיסמה חדשה.' : 'בחרו סיסמה לכניסות הבאות.'}
                </Typography>
                <TextField
                  label="סיסמה חדשה"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  helperText="לפחות 8 תווים"
                  fullWidth
                  autoFocus
                />
                <TextField
                  label="שוב, לאימות"
                  type="password"
                  value={passwordAgain}
                  onChange={(e) => setPasswordAgain(e.target.value)}
                  autoComplete="new-password"
                  fullWidth
                />
                <Button type="submit" variant="contained" size="large" disabled={loading} fullWidth>
                  {loading ? 'שומר…' : 'שמירה וכניסה'}
                </Button>
              </Stack>
            </form>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
