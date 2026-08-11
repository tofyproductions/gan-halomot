import { Navigate } from 'react-router-dom';
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

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
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
