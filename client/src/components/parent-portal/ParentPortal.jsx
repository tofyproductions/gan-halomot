import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box, AppBar, Toolbar, Typography, Button, Card, CardContent, Stack,
  Alert, CircularProgress, Chip, Tabs, Tab,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import parentApi, { parentApiError, PARENT_TOKEN_KEY } from '../../api/parentClient';
import ChildDetails from './ChildDetails';

/**
 * What a parent sees after signing in.
 *
 * The children come from /parent/me on every load rather than from anything
 * kept in the browser: the server resolves them from the current enrolment
 * data, so a child who left, a sibling who started, or a classroom reshuffle
 * shows up here without anyone clearing a cache.
 *
 * Right now this is the account and the children and nothing else. The
 * contract, the payments and the photographs are the next screens — they are
 * deliberately not stubbed in as empty tabs, because a tab that opens onto
 * nothing reads as a broken app rather than an unfinished one.
 */
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
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Sticky, because the way out and the sibling switcher are the two
          things a parent reaches for from halfway down a long day. */}
      <AppBar position="sticky" color="default" elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ minHeight: 60 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={800} lineHeight={1.2}>
              גן החלומות
            </Typography>
            {data?.full_name && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {data.full_name}
              </Typography>
            )}
          </Box>
          <Button size="small" color="inherit" startIcon={<LogoutIcon />} onClick={logout}>
            יציאה
          </Button>
        </Toolbar>

        {/* Siblings live in the bar, not in the page: they are a property of
            the account, and scrolling them away made a parent think the app
            had forgotten the other child. */}
        {!loading && !error && children.length > 1 && (
          <Tabs
            value={selected}
            onChange={(_, v) => setSelected(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderTop: 1, borderColor: 'divider', minHeight: 44 }}
          >
            {children.map((c) => (
              <Tab key={c.id} label={c.name} sx={{ minHeight: 44, fontWeight: 700 }} />
            ))}
          </Tabs>
        )}
      </AppBar>

      <Box sx={{ p: 2, maxWidth: 760, mx: 'auto' }}>
        {loading && (
          <Stack alignItems="center" sx={{ py: 8 }}>
            <CircularProgress />
          </Stack>
        )}

        {!loading && error && <Alert severity="error">{error}</Alert>}

        {!loading && !error && children.length === 0 && (
          <Alert severity="info">
            לא רשומים אצלנו ילדים פעילים עבורך. לבירור יש לפנות לגן.
          </Alert>
        )}

        {!loading && !error && child && (
          // Keyed by child so switching siblings remounts rather than showing
          // one child's details under another's name while the fetch runs.
          <ChildDetails key={child.id} childId={child.id} />
        )}
      </Box>
    </Box>
  );
}
