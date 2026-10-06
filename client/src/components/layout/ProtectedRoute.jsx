import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Box, CircularProgress } from '@mui/material';
import { hasTabAccess } from '../../config/tabs';

/**
 * `tab` — guard the route by the SCREEN, the way the menu does.
 *
 * `roles` asks only "what is your role", and the permissions screen does not
 * work that way: a tab can be granted to one person by id, or to a whole role.
 * A back-office employee handed רישום לאמונה saw the menu item, clicked it,
 * and was thrown back to the dashboard — the menu said yes, the route said no,
 * because they were two different rules. Pass `tab` and there is one rule.
 */
export default function ProtectedRoute({ children, roles, tab }) {
  const { user, loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!isAuthenticated) {
    /**
     * A signed-in parent is not a signed-out employee.
     *
     * The installed app always opens at '/', so this branch is what every
     * launch runs — and it sent a parent who had already activated an account
     * back to the staff login every time, to a form asking for a full name
     * and an employee's תעודת זהות. The parent token was in storage the whole
     * while; nothing looked at it, because the two sides of the application
     * deliberately share no auth state (api/parentClient.js says why the keys
     * are separate).
     *
     * Checked here rather than given its own route, because '/' is not one
     * address: it is the dashboard, a tapped notification, a link somebody
     * sent. Whichever of them a parent arrives at, the answer is the portal.
     *
     * A member of staff who is also a parent is unaffected — they hold a
     * staff token, so isAuthenticated is true and this branch never runs.
     */
    let parentToken = null;
    try { parentToken = localStorage.getItem('gan_parent_token'); } catch { /* private window */ }
    if (parentToken) return <Navigate to="/parents" replace />;

    // Remember where she was going, so signing in continues there (a tapped
    // notification, a link) instead of always starting from the dashboard.
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  /**
   * A לוח כיתה belongs on its own page and nowhere else.
   *
   * The server already refuses it everything outside the daily board, so this
   * is not what keeps data safe — but without it a tablet that reaches any
   * other address is handed the management shell: a navigation rail, a
   * "צפי השכר שלי" panel apologising that it has no data, and an offer to
   * change the interface. On a wall in a room full of three-year-olds that
   * reads as a broken system, and every one of those screens is one more
   * thing for somebody to tap.
   *
   * Sent back to its OWN link, which the kiosk remembers when it signs in.
   */
  if (user?.role === 'classroom_board') {
    const back = (() => {
      try { return localStorage.getItem('boardLink'); } catch { return null; }
    })();
    return <Navigate to={back || '/login'} replace />;
  }

  // The tab decides when there is one; hasTabAccess already falls back to the
  // tab's own default roles, so this is the stricter rule and not a looser one.
  if (tab) {
    if (!hasTabAccess(user, tab)) return <Navigate to="/" replace />;
  } else if (roles && !roles.includes(user?.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
