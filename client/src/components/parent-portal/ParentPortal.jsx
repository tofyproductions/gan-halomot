import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Stack, Alert, Chip, Avatar, IconButton, Tooltip, Skeleton,
  CssBaseline,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import { ThemeProvider } from '@mui/material/styles';
import parentApi, { parentApiError, PARENT_TOKEN_KEY } from '../../api/parentClient';
import parentTheme, { DISPLAY } from '../../theme/parentTheme';
import ChildDetails from './ChildDetails';

/**
 * What a parent sees after signing in.
 *
 * The children come from /parent/me on every load rather than from anything
 * kept in the browser: the server resolves them from the current enrolment
 * data, so a child who left, a sibling who started, or a classroom reshuffle
 * shows up here without anyone clearing a cache.
 *
 * The whole portal is wrapped in its own theme here rather than in main.jsx,
 * which is what keeps a parent-side design decision from reaching the staff
 * screens: everything below this line is warm paper, everything above it is
 * the management system it always was.
 */

/** First letter of a name — a face for the avatar until there is a photograph. */
function initial(name) {
  const s = String(name || '').trim();
  return s ? s[0] : '•';
}

function Loading() {
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Skeleton variant="rounded" height={148} sx={{ borderRadius: 5 }} />
      <Skeleton variant="rounded" height={96} sx={{ borderRadius: 5 }} />
      <Skeleton variant="rounded" height={220} sx={{ borderRadius: 5 }} />
    </Stack>
  );
}

export default function ParentPortal() {
  const navigate = useNavigate();
  const token = localStorage.getItem(PARENT_TOKEN_KEY);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await parentApi.get('/me');
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(parentApiError(err, 'לא הצלחנו לטעון את הנתונים'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (!token) return <Navigate to="/parents/login" replace />;

  const logout = () => {
    localStorage.removeItem(PARENT_TOKEN_KEY);
    navigate('/parents/login', { replace: true });
  };

  const children = data?.children || [];
  const child = children[selected] || null;

  return (
    <ThemeProvider theme={parentTheme}>
      {/* Re-applied under THIS theme. The one at the app root was built with
          the staff palette, so without this the page keeps the management
          system's cold grey behind the content — visible the moment anybody
          overscrolls — and the keyframes this portal animates with are never
          injected at all. */}
      <CssBaseline />
      <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default' }}>
        {/* Not an AppBar. A parent needs the way out and the name of the gan,
            and neither of those is worth a floating bar that follows them down
            a screen already carrying a fixed navigation at the bottom. */}
        <Box
          component="header"
          sx={{
            px: 2, pt: 'max(14px, env(safe-area-inset-top))', pb: 1.5,
            bgcolor: 'background.paper',
            borderBottom: 1, borderColor: 'divider',
          }}
        >
          <Stack
            direction="row" alignItems="center" spacing={1.5}
            sx={{ maxWidth: 760, mx: 'auto' }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography
                sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.2rem', lineHeight: 1.2 }}
              >
                גן החלומות
              </Typography>
              {data?.full_name && (
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {data.full_name}
                </Typography>
              )}
            </Box>
            <Tooltip title="יציאה">
              <IconButton onClick={logout} aria-label="יציאה מהחשבון" size="small">
                <LogoutIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        <Box
          sx={{
            px: 2, pt: 2,
            // Room for the fixed navigation, plus the gesture bar under it.
            // Wide screens have no such bar and should not carry its gap.
            pb: { xs: 'calc(96px + env(safe-area-inset-bottom))', md: 5 },
            maxWidth: 760, mx: 'auto',
          }}
        >
          {loading && <Loading />}

          {!loading && error && <Alert severity="error">{error}</Alert>}

          {!loading && !error && children.length === 0 && (
            <Alert severity="info">
              לא רשומים אצלנו ילדים פעילים עבורך. לבירור יש לפנות לגן.
            </Alert>
          )}

          {/* Siblings, when there are any. Above the child rather than inside
              a bar, because a parent of one child — which is most of them —
              should never see this row at all. */}
          {!loading && !error && children.length > 1 && (
            <Stack
              direction="row" spacing={1} sx={{ mb: 2, overflowX: 'auto', pb: 0.5 }}
            >
              {children.map((c, i) => (
                <Chip
                  key={c.id}
                  onClick={() => setSelected(i)}
                  color={i === selected ? 'primary' : 'default'}
                  variant={i === selected ? 'filled' : 'outlined'}
                  avatar={
                    <Avatar sx={{ bgcolor: i === selected ? 'primary.dark' : 'secondary.light' }}>
                      {initial(c.name)}
                    </Avatar>
                  }
                  label={c.name}
                  sx={{ height: 40, flex: '0 0 auto', fontSize: '0.9375rem', px: 0.5 }}
                />
              ))}
            </Stack>
          )}

          {!loading && !error && child && (
            // Keyed by child so switching siblings remounts rather than showing
            // one child's details under another's name while the fetch runs.
            <ChildDetails key={child.id} childId={child.id} />
          )}
        </Box>
      </Box>
    </ThemeProvider>
  );
}
