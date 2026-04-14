import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack, Alert,
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import { useAuth } from '../../hooks/useAuth';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [fullName, setFullName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!fullName || !idNumber) {
      setError('יש למלא את כל השדות');
      return;
    }
    setLoading(true);
    try {
      await login(fullName, idNumber);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה בהתחברות');
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
                type="password"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                fullWidth
                required
                inputProps={{ dir: 'ltr', inputMode: 'numeric' }}
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
