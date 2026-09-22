import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Stack, Button, TextField, Alert, CircularProgress, Chip,
} from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import api from '../../api/client';
import NurseryBoard from './NurseryBoard';

/**
 * לוח כיתה — the tablet on the wall of one room.
 *
 * The link says WHICH board; the password is the secret. Once in, it renders
 * the ordinary daily board, because that screen is the job and a second
 * implementation of it would be a second thing to keep correct. The server
 * hands this account exactly one classroom, so the picker on that screen has
 * one entry and nothing here has to hide anything.
 *
 * DESIGNED FOR A TABLET ON A WALL. It signs in for six months, it offers the
 * device's own fingerprint so nobody retypes a password at 07:00, and it has
 * no navigation out of itself. A board that is annoying to open is a board
 * that stops being filled in, which is the only failure mode that matters:
 * everything else here is about what a lost tablet is worth, and the server
 * answers that — one room's day, and nothing else in the system.
 */

/** Base64url → ArrayBuffer, the shape WebAuthn wants. */
const b64ToBuf = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

/** ArrayBuffer → base64url, which is how the server reads a credential back. */
const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default function BoardKiosk() {
  const { token: linkToken } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offerBiometric, setOfferBiometric] = useState(false);

  /** Take the session the server handed us and become that board. */
  const accept = useCallback((data) => {
    localStorage.setItem('token', data.token);
    // A tablet may have been signed in as somebody else once. The api client
    // appends this branch to every GET, and a stale one belongs to a gan this
    // board has nothing to do with.
    localStorage.removeItem('selectedBranch');
    setSignedIn(true);
    setPassword('');
  }, [linkToken]);

  useEffect(() => {
    let alive = true;
    api.get(`/public/board/${linkToken}`)
      .then(async (res) => {
        if (!alive) return;
        setInfo(res.data);
        // Where this tablet belongs, remembered as soon as the link is known
        // to be a real board — NOT only on a fresh sign-in. A tablet that is
        // already signed in never runs that path, and it is precisely the
        // tablet that has been on a wall for months that somebody will one day
        // navigate away from and need sending home.
        try { localStorage.setItem('boardLink', `/board/${linkToken}`); } catch { /* private mode */ }
        // Already signed in on this tablet? Trust the session rather than
        // asking a room full of people for a password every morning.
        const existing = localStorage.getItem('token');
        if (existing) {
          try {
            const me = await api.get('/auth/me');
            if (alive && me.data?.user?.role === 'classroom_board') setSignedIn(true);
          } catch { /* stale or somebody else's — the password screen stands */ }
        }
      })
      .catch(() => { if (alive) setError('הקישור אינו תקין. בקשו קישור חדש ממנהל המערכת.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [linkToken]);

  const signInWithPassword = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/public/board/${linkToken}/login`, { password });
      accept(res.data);
      // Offered AFTER the first successful sign-in, never before: a tablet
      // that has not proved it belongs here has no business registering a key.
      if (!info?.has_biometric && window.PublicKeyCredential) setOfferBiometric(true);
    } catch (err) {
      setError(err.response?.data?.error || 'הכניסה נכשלה');
    } finally { setBusy(false); }
  };

  const signInWithBiometric = async () => {
    if (busy || !info?.user_id) return;
    setBusy(true);
    setError('');
    try {
      const { data: options } = await api.post('/auth/webauthn/auth/options', { userId: info.user_id });
      const assertion = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: b64ToBuf(options.challenge),
          allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: b64ToBuf(c.id) })),
        },
      });
      const res = await api.post('/auth/webauthn/auth/verify', {
        userId: info.user_id,
        credential: {
          id: assertion.id,
          rawId: bufToB64(assertion.rawId),
          type: assertion.type,
          response: {
            authenticatorData: bufToB64(assertion.response.authenticatorData),
            clientDataJSON: bufToB64(assertion.response.clientDataJSON),
            signature: bufToB64(assertion.response.signature),
            userHandle: assertion.response.userHandle ? bufToB64(assertion.response.userHandle) : null,
          },
        },
      });
      accept(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'הזיהוי הביומטרי נכשל — אפשר להיכנס עם הסיסמה');
    } finally { setBusy(false); }
  };

  const registerBiometric = async () => {
    setBusy(true);
    setError('');
    try {
      const { data: options } = await api.post('/auth/webauthn/register/options');
      const cred = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64ToBuf(options.challenge),
          user: { ...options.user, id: b64ToBuf(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: b64ToBuf(c.id) })),
        },
      });
      await api.post('/auth/webauthn/register/verify', {
        credential: {
          id: cred.id,
          rawId: bufToB64(cred.rawId),
          type: cred.type,
          response: {
            attestationObject: bufToB64(cred.response.attestationObject),
            clientDataJSON: bufToB64(cred.response.clientDataJSON),
          },
        },
      });
      setOfferBiometric(false);
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו להגדיר כניסה ביומטרית במכשיר הזה');
    } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (signedIn) {
    return (
      <Box sx={{ p: { xs: 1.5, sm: 3 }, minHeight: '100vh', bgcolor: 'background.default' }}>
        {offerBiometric && (
          <Alert
            severity="info" sx={{ mb: 2 }}
            action={
              <Button size="small" startIcon={<FingerprintIcon />} onClick={registerBiometric} disabled={busy}>
                הגדרה
              </Button>
            }
            onClose={() => setOfferBiometric(false)}
          >
            להיכנס בפעם הבאה עם טביעת אצבע במקום סיסמה?
          </Alert>
        )}
        <NurseryBoard />
      </Box>
    );
  }

  return (
    <Box
      dir="rtl"
      sx={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        p: 2, bgcolor: 'background.default',
      }}
    >
      <Paper variant="outlined" sx={{ p: { xs: 3, sm: 4 }, borderRadius: 4, maxWidth: 420, width: '100%' }}>
        <Stack spacing={2.2}>
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 800 }}>לוח עדכונים</Typography>
            {info && (
              <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 1.2 }} flexWrap="wrap" useFlexGap>
                {info.branch && <Chip size="small" label={info.branch} />}
                {info.classroom && <Chip size="small" color="primary" label={info.classroom} />}
              </Stack>
            )}
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          {info && (
            <>
              {info.has_biometric && (
                <Button
                  fullWidth size="large" variant="contained" startIcon={<FingerprintIcon />}
                  onClick={signInWithBiometric} disabled={busy}
                >
                  כניסה עם טביעת אצבע
                </Button>
              )}

              <form onSubmit={signInWithPassword}>
                <Stack spacing={2}>
                  <TextField
                    label="סיסמת הלוח" type="password" fullWidth autoFocus
                    value={password} onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <Button
                    type="submit" fullWidth size="large"
                    variant={info.has_biometric ? 'outlined' : 'contained'}
                    startIcon={<LockOpenIcon />} disabled={busy || !password}
                  >
                    {busy ? 'רגע…' : 'כניסה'}
                  </Button>
                </Stack>
              </form>

              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                הסיסמה מוגדרת על ידי מנהל המערכת. הלוח הזה מציג את הכיתה הזו בלבד.
              </Typography>
            </>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
