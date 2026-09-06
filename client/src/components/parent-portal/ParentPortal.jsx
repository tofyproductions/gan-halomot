import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Stack, Alert, Chip, Avatar, IconButton, Tooltip, Skeleton,
  CssBaseline,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';
import { ThemeProvider } from '@mui/material/styles';
import parentApi, { parentApiError, PARENT_TOKEN_KEY } from '../../api/parentClient';
import { registerNativePush, unregisterNativePush } from '../../utils/nativePush';
import DeleteAccountRequest from '../shared/DeleteAccountRequest';
import { DISPLAY } from '../../theme/parentTheme';
import useParentColorMode from '../../theme/useParentColorMode';
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

/**
 * The name to greet somebody by.
 *
 * The first word of what the records hold. "היי, מיכל כהן לוי!" is a form
 * letter; "היי, מיכל!" is somebody who knows her.
 */
function firstName(full) {
  const s = String(full || '').trim();
  return s ? s.split(/\s+/)[0] : '';
}

/** First letter of a name — a face for the avatar until there is a photograph. */
function initial(name) {
  const s = String(name || '').trim();
  return s ? s[0] : '•';
}

function Loading() {
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Skeleton variant="rounded" height={148} sx={{ borderRadius: '20px' }} />
      <Skeleton variant="rounded" height={96} sx={{ borderRadius: '20px' }} />
      <Skeleton variant="rounded" height={220} sx={{ borderRadius: '20px' }} />
    </Stack>
  );
}

/**
 * Auto → light → dark → auto.
 *
 * A cycle rather than a menu: three states is few enough to walk through, and
 * the icon shows where you are. Auto is first and is the default, because a
 * parent whose phone already turns dark in the evening has answered this
 * question once and should not be asked again by every app.
 */
const NEXT_MODE = { auto: 'light', light: 'dark', dark: 'auto' };
const MODE_LABEL = { auto: 'לפי המכשיר', light: 'בהיר', dark: 'כהה' };

export default function ParentPortal() {
  const navigate = useNavigate();
  const token = localStorage.getItem(PARENT_TOKEN_KEY);
  const { theme, preference, setPreference } = useParentColorMode();

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
        if (!cancelled) { setData(res.data); registerNativePush(parentApi); }
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
    unregisterNativePush(parentApi);
    localStorage.removeItem(PARENT_TOKEN_KEY);
    navigate('/parents/login', { replace: true });
  };

  const children = data?.children || [];
  const child = children[selected] || null;

  return (
    <ThemeProvider theme={theme}>
      {/* Re-applied under THIS theme. The one at the app root was built with
          the staff palette, so without this the page keeps the management
          system's cold grey behind the content — visible the moment anybody
          overscrolls — and the keyframes this portal animates with are never
          injected at all. */}
      <CssBaseline />
      {/* The gap above the header on a wide screen is PADDING here, not a
          margin on the header itself. A top margin on a first child with no
          border or padding above it collapses straight out of its parent,
          taking the parent's background with it — which showed as a pale strip
          across the top of the page, and on the dark theme as a white one. */}
      <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default', pt: { md: 3 } }}>
        {/* Not an AppBar. A parent needs the way out and the name of the gan,
            and neither of those is worth a floating bar that follows them down
            a screen already carrying a fixed navigation at the bottom.

            A FILLED BLOCK, not a white strip with a hairline under it. The
            first version of this portal opened on paper-white and read as a
            form; the top of the screen is the one place a colour costs nothing
            and says everything, and this is the gan's own. It curves into the
            page below it, which is the whole difference between an app and an
            administrative system. */}
        <Box
          component="header"
          sx={{
            px: 2, pt: 'max(16px, env(safe-area-inset-top))', pb: 3.5,
            bgcolor: (t) => t.playful.coral.bg,
            color: (t) => t.playful.coral.on,
            // On a phone it runs edge to edge and curves into the page. On a
            // wide screen that same block became a banner across 1400px with
            // its rounded corners out at the bezel, attached to nothing — so
            // there it becomes a card at the top of the content column, the
            // width of everything below it.
            borderRadius: { xs: '0 0 26px 26px', md: '26px' },
            maxWidth: { md: 760 },
            mx: { md: 'auto' },
          }}
        >
          <Stack
            direction="row" alignItems="center" spacing={1}
            sx={{ maxWidth: 760, mx: 'auto' }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              {/* Their name first, the institution's second. A parent opening
                  this is not visiting an office. */}
              <Typography
                sx={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: '1.3rem', lineHeight: 1.2 }}
                noWrap
              >
                {firstName(data?.full_name) ? `היי, ${firstName(data.full_name)}!` : 'גן החלומות'}
              </Typography>
              <Typography variant="caption" noWrap component="div" sx={{ opacity: 0.95 }}>
                {firstName(data?.full_name) ? 'גן החלומות' : (data?.full_name || '')}
              </Typography>
            </Box>
            <Tooltip title={`תצוגה: ${MODE_LABEL[preference]}`}>
              <IconButton
                onClick={() => setPreference(NEXT_MODE[preference])}
                aria-label={`תצוגה: ${MODE_LABEL[preference]}. החלפה`}
                size="small"
                sx={{ color: 'inherit', bgcolor: 'rgba(255,255,255,0.16)' }}
              >
                {preference === 'auto' && <BrightnessAutoIcon fontSize="small" />}
                {preference === 'light' && <LightModeIcon fontSize="small" />}
                {preference === 'dark' && <DarkModeIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="יציאה">
              <IconButton
                onClick={logout} aria-label="יציאה מהחשבון" size="small"
                sx={{ color: 'inherit', bgcolor: 'rgba(255,255,255,0.16)' }}
              >
                <LogoutIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <DeleteAccountRequest client={parentApi} endpoint="/data-deletion/me" variant="icon" />
          </Stack>
        </Box>

        <Box
          sx={{
            px: 2,
            // Pulled up ONTO the header's curve, so the first thing on the page
            // overlaps it rather than floating in a gap beneath it. `relative`
            // is what makes that work: without it the header paints last and
            // takes a bite out of the sibling chips.
            position: 'relative', zIndex: 1,
            pt: 0, mt: -2.5,
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
                  variant="filled"
                  avatar={<Avatar>{initial(c.name)}</Avatar>}
                  label={c.name}
                  // ONE sx. There were two on this element and the second
                  // silently discarded the first — JSX keeps the last of a
                  // repeated prop — which is why the chosen chip stayed the
                  // default grey no matter what was written above it.
                  //
                  // Amber when chosen, paper when not: a border alone is too
                  // quiet for the control that decides whose screen this is.
                  sx={{
                    height: 40, flex: '0 0 auto', fontSize: '0.9375rem', px: 0.5,
                    fontWeight: 800,
                    border: 2, borderStyle: 'solid',
                    bgcolor: (t) => (i === selected ? t.playful.amber.bg : t.palette.background.paper),
                    color: (t) => (i === selected ? t.playful.amber.on : t.palette.text.secondary),
                    borderColor: (t) => (i === selected ? t.playful.amber.bg : t.palette.divider),
                    '&:hover': {
                      bgcolor: (t) => (i === selected ? t.playful.amber.bg : t.palette.background.paper),
                    },
                    // Chip styles its own avatar, and `.MuiChip-avatar { color }`
                    // beat the colour set on the Avatar itself — the letter came
                    // out MUI's default grey on both, at 1.2:1 against the teal.
                    // Set from here, where the specificity is the Chip's own.
                    '& .MuiChip-avatar': {
                      bgcolor: (t) => (i === selected ? t.playful.amber.on : t.playful.teal.bg),
                      color: (t) => (i === selected ? t.playful.amber.bg : t.playful.teal.on),
                      fontWeight: 800,
                    },
                  }}
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
