import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box, AppBar, Toolbar, Typography, Button, Card, CardContent, Stack,
  Alert, CircularProgress, Chip, Tabs, Tab,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import parentApi, { parentApiError, PARENT_TOKEN_KEY } from '../../api/parentClient';

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
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h6" fontWeight={700}>גן החלומות</Typography>
            {data?.full_name && (
              <Typography variant="caption" color="text.secondary">
                שלום {data.full_name}
              </Typography>
            )}
          </Box>
          <Button size="small" startIcon={<LogoutIcon />} onClick={logout}>
            יציאה
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2, maxWidth: 720, mx: 'auto' }}>
        {loading && (
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress />
          </Stack>
        )}

        {!loading && error && <Alert severity="error">{error}</Alert>}

        {!loading && !error && children.length === 0 && (
          <Alert severity="info">
            לא רשומים אצלנו ילדים פעילים עבורך. לבירור יש לפנות לגן.
          </Alert>
        )}

        {!loading && !error && children.length > 1 && (
          <Tabs
            value={selected}
            onChange={(_, v) => setSelected(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 2 }}
          >
            {children.map((c) => <Tab key={c.id} label={c.name} />)}
          </Tabs>
        )}

        {!loading && !error && child && (
          <Card>
            <CardContent>
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h6" fontWeight={700}>{child.name}</Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                    {child.classroom && <Chip size="small" label={child.classroom} />}
                    {child.classroom_category && (
                      <Chip size="small" variant="outlined" label={child.classroom_category} />
                    )}
                    {child.academic_year && (
                      <Chip size="small" variant="outlined" label={`שנת ${child.academic_year}`} />
                    )}
                  </Stack>
                </Box>

                <Alert severity="info">
                  בקרוב כאן: החוזה, הקבלות ותמונות הילד.
                </Alert>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Box>
    </Box>
  );
}
