import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Box } from '@mui/material';
import { useState, useEffect } from 'react';
import Header from './Header';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import ClassPopupPoller from '../classes/ClassPopupPoller';
import SetPasswordDialog from '../shared/SetPasswordDialog';
import PunchEntryTaskGate from '../attendance/PunchEntryTaskGate';
import { MyDecisionsPopup } from '../payroll/MyDecisions';

// Routes that benefit from extra horizontal space — payroll/attendance tables
// are dense, used mostly on desktops, and the 1200px cap was leaving big gutters.
const WIDE_ROUTES = ['/payroll', '/attendance', '/employees'];

/**
 * Branch → subtle background tint. The tint is very light so text remains
 * readable. Falls back to the default slate if no branch matched.
 */
const BRANCH_TINTS = {
  'כפר סבא - קפלן':     { bg: '#fdf2f8', tint: 'rgba(236,72,153,0.04)' },   // pink
  'כפר סבא - משה דיין':  { bg: '#fff7ed', tint: 'rgba(251,146,60,0.04)' },    // orange
  'תל אביב':             { bg: '#f0f9ff', tint: 'rgba(56,189,248,0.04)' },     // cyan
  'הרצליה הרצוג':        { bg: '#fefce8', tint: 'rgba(250,204,21,0.04)' },     // yellow
};
const DEFAULT_BG = '#f8fafc';

/**
 * Gentle floating clouds via CSS keyframes. The clouds are purely decorative
 * white ellipses that drift slowly across the viewport. They sit behind all
 * content (z-index: 0) and have very low opacity so they never interfere
 * with readability.
 */
const cloudKeyframes = `
@keyframes drift1 {
  0%   { transform: translateX(-20vw) translateY(0); }
  100% { transform: translateX(110vw) translateY(-8vh); }
}
@keyframes drift2 {
  0%   { transform: translateX(110vw) translateY(0); }
  100% { transform: translateX(-20vw) translateY(6vh); }
}
@keyframes drift3 {
  0%   { transform: translateX(-30vw) translateY(0); }
  100% { transform: translateX(120vw) translateY(-4vh); }
}
`;

const cloudStyle = (top, size, duration, delay, anim) => ({
  position: 'fixed',
  top,
  width: size,
  height: `calc(${size} * 0.4)`,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.55)',
  filter: 'blur(30px)',
  animation: `${anim} ${duration}s linear ${delay}s infinite`,
  pointerEvents: 'none',
  zIndex: 0,
});

export default function Layout() {
  const { selectedBranchName } = useBranch();
  const palette = BRANCH_TINTS[selectedBranchName] || { bg: DEFAULT_BG, tint: 'transparent' };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: palette.bg, position: 'relative', overflow: 'hidden' }}>
      {/* Inject keyframes */}
      <style>{cloudKeyframes}</style>

      {/* Decorative clouds */}
      <Box sx={cloudStyle('12vh', '260px', 45, 0, 'drift1')} />
      <Box sx={cloudStyle('35vh', '340px', 60, 8, 'drift2')} />
      <Box sx={cloudStyle('65vh', '200px', 50, 15, 'drift3')} />
      <Box sx={cloudStyle('80vh', '280px', 55, 25, 'drift1')} />

      <Box sx={{ position: 'relative', zIndex: 1 }}>
        <Header />
        <RouteAwareContainer />
      </Box>
      <ClassPopupPoller />
      <SetPasswordGate />
      <FreshEntryGate />
    </Box>
  );
}

/**
 * A closed tab reopened on a bookmark, or a shared office computer left on a
 * deep link (the branch manager's Employees screen — rates and salaries) —
 * this sends a brand-new tab home instead of restoring whatever page the URL
 * bar happened to say, so the "what was decided" popup lands over the
 * dashboard instead of a table full of numbers a passer-by should not read.
 *
 * sessionStorage is the right primitive here: it survives an in-tab refresh
 * (F5), but is wiped the moment the tab actually closes — closing and
 * reopening the same link is indistinguishable from a stranger opening it
 * cold, which is exactly the case this exists for.
 */
function FreshEntryGate() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (sessionStorage.getItem('app_entered')) return;
    sessionStorage.setItem('app_entered', '1');
    if (location.pathname !== '/') navigate('/', { replace: true });
    // Fresh-tab check only — deliberately not reacting to later navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// Nags the user to choose a login password once per session while they have
// none set (they may skip; it reappears next login). Dismissed-for-session is
// tracked in sessionStorage so it doesn't pop on every route change.
function SetPasswordGate() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  // A password somebody else issued. Not a nag — the server refuses every
  // request but this one while it is held, so a dialog that could be closed
  // would leave the person looking at screens that will not load.
  const mustChange = Boolean(user && user.must_change_password);

  useEffect(() => {
    if (mustChange) { setOpen(true); return; }
    if (user && user.password_set === false && !sessionStorage.getItem('pw_nag_dismissed')) {
      setOpen(true);
    }
  }, [user, mustChange]);

  if (!user || (!mustChange && user.password_set !== false)) return null;
  return (
    <SetPasswordDialog
      open={open} allowSkip={!mustChange}
      forced={mustChange}
      onClose={(saved) => { if (!saved) sessionStorage.setItem('pw_nag_dismissed', '1'); setOpen(false); }}
    />
  );
}

function RouteAwareContainer() {
  const { pathname } = useLocation();
  const isWide = WIDE_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));
  return (
    <Box sx={{
      maxWidth: isWide ? '100%' : 1200,
      mx: 'auto',
      px: { xs: 1, sm: 2 },
      py: { xs: 1.5, sm: 3 },
    }}>
      {/* A branch manager's open "complete your missing punches" assignment —
          pinned above whatever page they navigate to until the branch is clean. */}
      <PunchEntryTaskGate />
      {/* What accounting decided on the requests THIS person sent. Shown once
          on entry, then reachable from the bell — the screen keeps the rest. */}
      <MyDecisionsPopup />
      <Outlet />
    </Box>
  );
}

