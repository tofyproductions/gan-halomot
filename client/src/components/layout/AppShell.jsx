import { Suspense, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import ScreenSkeleton from '../ui/ScreenSkeleton';
import ScreenBoundary from '../ui/ScreenBoundary';
import Breadcrumb from './Breadcrumb';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileNav, { MOBILE_NAV_SPACE, useHasMobileNav } from './MobileNav';
import { useAuth } from '../../hooks/useAuth';
import ClassPopupPoller from '../classes/ClassPopupPoller';
import SetPasswordDialog from '../shared/SetPasswordDialog';
import PunchEntryTaskGate from '../attendance/PunchEntryTaskGate';
import { MyDecisionsPopup } from '../payroll/MyDecisions';

/**
 * The shell: a fixed rail, and everything else.
 *
 * What is gone from the old Layout, on purpose. Four blurred ellipses drifted
 * across every screen behind the content — decoration, and four fixed 30px
 * blur filters repainting on every scroll. A per-branch background tint said
 * which gan you were in, which the branch selector in the rail says in words.
 * And WIDE_ROUTES granted three routes a wider container because the other
 * seventy were capped at 1200px; the workspace is now simply as wide as the
 * window, which is what the three exceptions were asking for.
 *
 * What is carried across unchanged, because none of it is decoration:
 * FreshEntryGate, SetPasswordGate, the class popup poller, the punch-entry
 * task gate and the decisions popup.
 */
export default function AppShell() {
  const hasMobileNav = useHasMobileNav();
  const { pathname } = useLocation();

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Sidebar />
      </Box>

      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          px: { xs: 2, md: 3 },
          py: { xs: 2, md: 2.5 },
          // Clear of the phone's bottom bar, which is fixed and would otherwise
          // sit on top of the last row of whatever table is open — but only
          // when there is a bar. MobileNav renders nothing for somebody with no
          // visible tabs, and reserving the space anyway left 72px of blank
          // page under the content.
          pb: { xs: hasMobileNav ? `calc(${MOBILE_NAV_SPACE} + 16px)` : 2, md: 2.5 },
        }}
      >
        {/* A branch manager's open "complete your missing punches" assignment —
            pinned above whatever page they navigate to until the branch is clean. */}
        <PunchEntryTaskGate />
        {/* What accounting decided on the requests THIS person sent. Shown once
            on entry, then reachable from the bell — the screen keeps the rest. */}
        <MyDecisionsPopup />

        {/* Where you are, and what the browser tab says — both from
            config/screenMeta, both here rather than in each of 62 screens, so
            renaming a screen in the rail renames it in the tab strip too. */}
        <Breadcrumb />

        {/* Screens arrive one at a time now (see App.jsx), and the boundary is
            HERE rather than around the whole route tree so the rail, the branch
            selector and the gates above stay on screen while one loads. A
            person clicking שכר should see שכר appear inside the app, not the
            app disappear and come back. */}
        {/* The boundary sits OUTSIDE the Suspense: a screen whose code never
            arrives rejects the lazy import, and without something to catch it
            the whole tree unmounts to a white page. It is keyed on the route so
            one broken screen does not shadow every screen after it. */}
        <ScreenBoundary routeKey={pathname}>
          <Suspense fallback={<ScreenSkeleton />}>
            <Outlet />
          </Suspense>
        </ScreenBoundary>
      </Box>

      <MobileNav />

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
