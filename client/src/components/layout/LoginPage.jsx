import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack, Alert,
  FormControlLabel, Checkbox, Divider,
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { startAuthentication } from '@simplewebauthn/browser';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';

const SAVED_CREDS_KEY = 'gan_saved_credentials';
const SAVED_USER_ID_KEY = 'gan_biometric_user_id';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, loginWithPassword, requestResetCode, resetWithCode } = useAuth();
  const [fullName, setFullName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);
  const [step, setStep] = useState('creds'); // 'creds' | 'password' | 'reset'
  // The forgotten-password leg. `phoneHint` is a masked number, so the person
  // can tell which of their phones to go and look at.
  const [phoneHint, setPhoneHint] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [password, setPassword] = useState('');
  const [bioForStep2, setBioForStep2] = useState(false); // user has fingerprint set

  // Load saved credentials on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_CREDS_KEY));
      if (saved?.fullName && saved?.idNumber) {
        setFullName(saved.fullName);
        setIdNumber(saved.idNumber);
        setRememberMe(true);
      }
    } catch { /* ignore */ }

    // Check if biometric user ID is saved
    const bioUserId = localStorage.getItem(SAVED_USER_ID_KEY);
    if (bioUserId) setHasBiometric(true);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!fullName || !idNumber) {
      setError('יש למלא את כל השדות');
      return;
    }
    setLoading(true);
    try {
      const result = await login(fullName, idNumber, rememberMe);
      // The user has a password set → move to the password step, no token yet.
      // Offer biometric there (as a replacement for typing the password).
      if (result.needs_password) {
        if (result.hasWebauthn && result.user_id) {
          localStorage.setItem(SAVED_USER_ID_KEY, result.user_id);
          setBioForStep2(true);
        } else {
          setBioForStep2(false);
        }
        setStep('password');
        setLoading(false);
        return;
      }
      finishLogin(result);
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה בהתחברות');
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!password) { setError('יש להזין סיסמה'); return; }
    setLoading(true);
    try {
      const result = await loginWithPassword(fullName, idNumber, password, rememberMe);
      finishLogin(result);
    } catch (err) {
      setError(err.response?.data?.error || 'סיסמה שגויה');
      setLoading(false);
    }
  };

  const finishLogin = (result) => {
    if (rememberMe) {
      localStorage.setItem(SAVED_CREDS_KEY, JSON.stringify({ fullName, idNumber }));
    } else {
      localStorage.removeItem(SAVED_CREDS_KEY);
    }
    if (result.hasWebauthn) localStorage.setItem(SAVED_USER_ID_KEY, result.user.id);
    navigate('/');
  };

  const handleBiometricLogin = async () => {
    setError('');
    setLoading(true);
    const userId = localStorage.getItem(SAVED_USER_ID_KEY);
    if (!userId) {
      setError('לא נמצאו נתוני כניסה ביומטרית');
      setLoading(false);
      return;
    }

    try {
      // Get authentication options from server
      const optionsRes = await api.post('/auth/webauthn/auth/options', { userId });
      const options = optionsRes.data;

      // Trigger biometric prompt
      const credential = await startAuthentication({ optionsJSON: options });

      // Verify with server
      const verifyRes = await api.post('/auth/webauthn/auth/verify', { userId, credential });

      // Set token and user
      localStorage.setItem('token', verifyRes.data.token);
      if (verifyRes.data.user.branch_id) {
        localStorage.setItem('selectedBranch', verifyRes.data.user.branch_id);
      }

      // Force reload to pick up new auth state
      window.location.href = '/';
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'שגיאה באימות ביומטרי';
      setError(msg);
      // If biometric data is invalid, clear it
      if (err.response?.status === 404 || err.response?.status === 400) {
        localStorage.removeItem(SAVED_USER_ID_KEY);
        setHasBiometric(false);
      }
    } finally {
      setLoading(false);
    }
  };

  // Name and id are already typed and already verified by step 1, so the link
  // sends the code straight away rather than asking for them a second time.
  const handleForgot = async () => {
    setError(''); setSending(true);
    try {
      const data = await requestResetCode(fullName, idNumber);
      setPhoneHint(data.phone_hint || '');
      setPassword('');
      setStep('reset');
    } catch (err) {
      setError(err.response?.data?.error || 'שליחת הקוד נכשלה');
    } finally { setSending(false); }
  };

  const handleResetSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await resetWithCode(fullName, idNumber, resetCode, newPassword, rememberMe);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'איפוס הסיסמה נכשל');
    } finally { setLoading(false); }
  };

  return (
    <Box
      dir="rtl"
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        px: 2,
      }}
    >
      <Card sx={{ maxWidth: 420, width: '100%' }}>
        <CardContent sx={{ p: 4 }}>
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Typography variant="h4" sx={{ fontWeight: 900, fontFamily: 'Varela Round', mb: 1 }}>
              גן החלומות
            </Typography>
            <Typography variant="body2" color="text.secondary">
              מערכת ניהול גן ילדים
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          {/* Password step — the user has a login password set */}
          {step === 'password' ? (
            <Box component="form" onSubmit={handlePasswordSubmit}>
              <Stack spacing={2.5}>
                <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                  שלום {fullName} — הזן/י את הסיסמה שלך
                </Typography>
                <TextField
                  label="סיסמה" type="password" value={password} autoFocus
                  onChange={(e) => setPassword(e.target.value)} fullWidth required
                  inputProps={{ dir: 'ltr' }}
                />
                <Button type="submit" variant="contained" size="large" fullWidth disabled={loading} startIcon={<LoginIcon />}>
                  {loading ? 'מתחבר...' : 'כניסה'}
                </Button>
                {bioForStep2 && (
                  <>
                    <Divider><Typography variant="caption" color="text.secondary">או</Typography></Divider>
                    <Button
                      variant="outlined" size="large" fullWidth disabled={loading}
                      startIcon={<FingerprintIcon />} onClick={handleBiometricLogin}
                      sx={{ borderColor: '#7c3aed', color: '#7c3aed', '&:hover': { borderColor: '#6d28d9', bgcolor: '#f5f3ff' } }}
                    >
                      כניסה עם טביעת אצבע
                    </Button>
                  </>
                )}
                <Button variant="text" size="small" onClick={handleForgot} disabled={sending}>
                  {sending ? 'שולח קוד…' : 'שכחתי סיסמה'}
                </Button>
                <Button variant="text" size="small" onClick={() => { setStep('creds'); setPassword(''); setError(''); }}>
                  חזרה
                </Button>
              </Stack>
            </Box>
          ) : step === 'reset' ? (
            <Box component="form" onSubmit={handleResetSubmit}>
              <Stack spacing={2.5}>
                <Alert severity="info" sx={{ borderRadius: 2 }}>
                  שלחנו קוד בהודעת SMS{phoneHint ? ` למספר ${phoneHint}` : ''}.
                  הקוד תקף לחמש דקות.
                </Alert>
                <TextField
                  label="הקוד מההודעה" value={resetCode} autoFocus
                  onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  fullWidth required
                  inputProps={{ dir: 'ltr', inputMode: 'numeric', autoComplete: 'one-time-code',
                    style: { letterSpacing: '0.4em', fontSize: 22, textAlign: 'center' } }}
                />
                <TextField
                  label="סיסמה חדשה" type="password" value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)} fullWidth required
                  helperText="לפחות 4 תווים" inputProps={{ dir: 'ltr' }}
                />
                <Button type="submit" variant="contained" size="large" fullWidth
                        disabled={loading || resetCode.length < 6} startIcon={<LoginIcon />}>
                  {loading ? 'מאפס…' : 'שמירה וכניסה'}
                </Button>
                <Button variant="text" size="small" onClick={handleForgot} disabled={sending}>
                  {sending ? 'שולח…' : 'לא קיבלתי — שלחו שוב'}
                </Button>
                <Button variant="text" size="small"
                        onClick={() => { setStep('creds'); setResetCode(''); setNewPassword(''); setError(''); }}>
                  חזרה
                </Button>
              </Stack>
            </Box>
          ) : (
          <>
          <Box component="form" onSubmit={handleSubmit}>
            <Stack spacing={2.5}>
              <TextField
                label="שם מלא"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                fullWidth
                required
                autoFocus
              />
              <TextField
                label="תעודת זהות"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                fullWidth
                required
                inputProps={{ dir: 'ltr', inputMode: 'numeric' }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    size="small"
                  />
                }
                label={<Typography variant="body2">זכור אותי</Typography>}
              />
              <Button
                type="submit"
                variant="contained"
                size="large"
                fullWidth
                disabled={loading}
                startIcon={<LoginIcon />}
              >
                {loading ? 'מתחבר...' : 'התחברות'}
              </Button>
            </Stack>
          </Box>
          </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
