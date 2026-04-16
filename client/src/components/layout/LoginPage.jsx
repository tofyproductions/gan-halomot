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
  const { login } = useAuth();
  const [fullName, setFullName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);

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

      // Save or clear credentials
      if (rememberMe) {
        localStorage.setItem(SAVED_CREDS_KEY, JSON.stringify({ fullName, idNumber }));
      } else {
        localStorage.removeItem(SAVED_CREDS_KEY);
      }

      // Save user ID for biometric if they have it set up
      if (result.hasWebauthn) {
        localStorage.setItem(SAVED_USER_ID_KEY, result.user.id);
      }

      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה בהתחברות');
    } finally {
      setLoading(false);
    }
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

          {/* Biometric login button */}
          {hasBiometric && (
            <>
              <Button
                variant="outlined"
                size="large"
                fullWidth
                disabled={loading}
                startIcon={<FingerprintIcon />}
                onClick={handleBiometricLogin}
                sx={{
                  mb: 2, py: 1.5,
                  borderColor: '#7c3aed',
                  color: '#7c3aed',
                  '&:hover': { borderColor: '#6d28d9', bgcolor: '#f5f3ff' },
                }}
              >
                כניסה עם טביעת אצבע
              </Button>
              <Divider sx={{ mb: 2 }}>
                <Typography variant="caption" color="text.secondary">או</Typography>
              </Divider>
            </>
          )}

          <Box component="form" onSubmit={handleSubmit}>
            <Stack spacing={2.5}>
              <TextField
                label="שם מלא"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                fullWidth
                required
                autoFocus={!hasBiometric}
              />
              <TextField
                label="תעודת זהות"
                type="password"
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
        </CardContent>
      </Card>
    </Box>
  );
}
