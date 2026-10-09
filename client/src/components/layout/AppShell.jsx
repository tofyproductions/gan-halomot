import { Fragment, Suspense, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import ScreenSkeleton from '../ui/ScreenSkeleton';
import ScreenBoundary from '../ui/ScreenBoundary';
import Breadcrumb from './Breadcrumb';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileNav, { MOBILE_NAV_SPACE, useHasMobileNav } from './MobileNav';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import ClassPopupPoller from '../classes/ClassPopupPoller';
import SetPasswordDialog from '../shared/SetPasswordDialog';
import PunchEntryTaskGate from '../attendance/PunchEntryTaskGate';
import PunchIssuesBanner from '../attendance/PunchIssuesBanner';
import { MyDecisionsPopup } from '../payroll/MyDecisions';
import EmployeePunchFixPopup from '../attendance/EmployeePunchFixPopup';
import ManagerPunchFollowupPopup from '../attendance/ManagerPunchFollowupPopup';
import HelpButton from '../shared/HelpButton';
import api from '../../api/client';
import { registerNativePush } from '../../utils/nativePush';
import EnrollBiometricDialog, { platformAuthenticatorAvailable } from '../shared/EnrollBiometricDialog';

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
  const { selectedBranch } = useBranch();
  const { isAuthenticated, viewAs, setViewAs } = useAuth();

  /**
   * Native push for STAFF, which had never been switched on.
   *
   * nativePush.js was written for both sides and says so — "`api` for staff,
   * `parentApi` for the parent portal" — and the parent portal calls it.
   * Nothing on the staff side ever did. So a rota published on Thursday
   * night, a swap somebody was waiting on, a punch correction rejected with
   * a reason: all of it was written, sent, and delivered to nobody who had
   * the app installed. The only channel staff really had was a browser
   * notification they had to go and find in a menu.
   *
   * On every launch rather than once per login, because almost nobody logs
   * in — the token lasts thirty days, so for an installed app "once per
   * login" means once, long ago, before this existed. The server upserts on
   * the token, so repeating costs nothing.
   *
   * A no-op in a browser: registerNativePush returns at once off-device.
   */
  useEffect(() => {
    if (!isAuthenticated) return;
    registerNativePush(api).catch(() => { /* a device that refuses push still works */ });
  }, [isAuthenticated]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
    {viewAs && (
      /* The admin is wearing another role's skin — this strip is the truth
         and the way back, above everything, on every screen. */
      <Box sx={{
        position: 'sticky', top: 0, zIndex: (t) => t.zIndex.appBar + 1,
        bgcolor: '#6d28d9', color: '#fff', px: 2, py: 0.5,
        display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', fontSize: '0.85rem',
      }}>
        <span>👁 מצב תצוגה: {viewAs === 'teacher' ? 'עובדת' : 'מנהלת סניף'} — הנתונים עדיין שלך, רק המסכים נראים אחרת</span>
        <Box
          component="button" type="button"
          onClick={() => setViewAs('')}
          sx={{
            border: '1px solid rgba(255,255,255,0.7)', borderRadius: 1, bgcolor: 'transparent',
            color: '#fff', cursor: 'pointer', fontWeight: 700, px: 1.25, py: 0.25, fontFamily: 'inherit', fontSize: '0.8rem',
          }}
        >
          חזרה למנהל מערכת
        </Box>
      </Box>
    )}
    <Box sx={{ display: 'flex', flex: 1, bgcolor: 'background.default' }}>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Sidebar />
      </Box>

      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          // A wide table pans HERE, between the header and the bottom bar,
          // instead of dragging the whole page (and the fixed nav) sideways —
          // the Galaxy disproportion. html/body are clamped in rtlTheme.
          overflowX: 'auto',
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
      <PunchIssuesBanner />
        {/* What accounting decided on the requests THIS person sent. Shown once
            on entry, then reachable from the bell — the screen keeps the rest. */}
        <MyDecisionsPopup />
        {/* Her own open punch problems — fix first, before anyone chases her. */}
        <EmployeePunchFixPopup />
        {/* The branch manager's daily list — what employees answered, what nobody handled. */}
        <ManagerPunchFollowupPopup />

        {/* Where you are, and what the browser tab says — both from
            config/screenMeta, both here rather than in each of 62 screens, so
            renaming a screen in the rail renames it in the tab strip too. */}
        {/* The breadcrumb says where you are; the "?" says what you can do
            once you are there. Same row, because they answer the same
            question from two sides. */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <Breadcrumb />
          <HelpButton />
        </Box>

        {/* Screens arrive one at a time now (see App.jsx), and the boundary is
            HERE rather than around the whole route tree so the rail, the branch
            selector and the gates above stay on screen while one loads. A
            person clicking שכר should see שכר appear inside the app, not the
            app disappear and come back. */}
        {/* The boundary sits OUTSIDE the Suspense: a screen whose code never
            arrives rejects the lazy import, and without something to catch it
            the whole tree unmounts to a white page. It is keyed on the route so
            one broken screen does not shadow every screen after it. */}
        {/* The key carries the branch as well as the route, and that is not a
            detail — it is what makes switching gans mean anything.

            Which gan a request is about is not passed down as a prop. The api
            client reads `selectedBranch` out of localStorage and appends it to
            every GET (api/client.js), so a screen depends on the branch without
            ever mentioning it, and no screen's effects re-run when it changes.
            The old top bar hid this by calling window.location.reload() on the
            selector; the rail replaced the bar and dropped the reload, so the
            selector said כפר סבא while the table underneath still listed תל
            אביב — silently wrong, on the screens where being sure which gan you
            are looking at matters most.

            Remounting the screen instead of reloading the page: the effects
            re-run and refetch under the new branch, while the rail, the year
            and the gates above stay put and nothing is downloaded twice. */}
        <ScreenBoundary routeKey={`${pathname}|${selectedBranch}`}>
          <Suspense fallback={<ScreenSkeleton />}>
            <Fragment key={selectedBranch}>
              <Outlet />
            </Fragment>
          </Suspense>
        </ScreenBoundary>
      </Box>

      <MobileNav />

      <ClassPopupPoller />
      <SetPasswordGate />
      <EnrollBiometricGate />
      <FreshEntryGate />
    </Box>
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
    // Opened by tapping a notification (public/sw.js adds the marker): the
    // link IS the point — "ממתין לאישורך" must open the approvals, not the
    // dashboard. Keep the address, drop only the marker.
    const params = new URLSearchParams(location.search);
    if (params.get('from') === 'push') {
      params.delete('from');
      const rest = params.toString();
      navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true });
      return;
    }
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

/**
 * And the same for a fingerprint, for everybody who already has a password.
 *
 * The enrolment step after CHOOSING a password only ever reached somebody
 * choosing one — and almost the whole staff passed that point long ago. So
 * the lock on the payslips was in place and nobody had the key to it.
 *
 * Waits for the password gate: two dialogs stacked on a first launch is how
 * people learn to dismiss dialogs without reading them. Shown only on a
 * device that can actually do it, and only once per session — "לא עכשיו"
 * closes it until the next launch, which is the same shape as the punch
 * popup and for the same reason: the popup is the repeating reminder, and a
 * woman who cannot reach the daily board because of a security prompt is a
 * worse outcome than one who puts it off.
 */
function EnrollBiometricGate() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const needs = Boolean(
    user && user.password_set && !user.must_change_password && !user.hasWebauthn,
  );

  useEffect(() => {
    if (!needs) { setOpen(false); return undefined; }
    if (sessionStorage.getItem('bio_nag_dismissed')) return undefined;
    let alive = true;
    platformAuthenticatorAvailable().then((can) => { if (alive && can) setOpen(true); });
    return () => { alive = false; };
  }, [needs]);

  if (!needs) return null;
  return (
    <EnrollBiometricDialog
      open={open}
      onClose={(done) => {
        if (!done) sessionStorage.setItem('bio_nag_dismissed', '1');
        setOpen(false);
      }}
    />
  );
}
