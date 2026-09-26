import { useEffect, useState } from 'react';
import { Box, Button, Chip, IconButton, Stack, Typography } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { monthIL } from '../../utils/ilDates';

const DISMISS_KEY = 'punch_issues_banner_dismissed';

/**
 * "You opened the system — here is what's waiting."
 *
 * The morning push (punchIssuesDigest) reaches the phone; this is the same
 * fact met INSIDE the app: a manager, admin or accountant with open punch
 * issues this month sees the counts pinned under the header the moment they
 * arrive, one tap from the fix screen. The server scopes the counts to what
 * this user may act on (a manager sees her branches only), so the banner
 * never advertises problems the viewer can't touch.
 *
 * Soft, like PunchEntryTaskGate: dismissible for the session, back on the
 * next login while anything is still open. The gate handles ASSIGNED
 * homework; this covers everything the issues screen knows about, assigned
 * or not.
 */
export default function PunchIssuesBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [counts, setCounts] = useState(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');

  const role = user?.role;
  const relevant = role === 'system_admin' || role === 'accountant' || role === 'branch_manager';

  useEffect(() => {
    if (!relevant) return;
    api.get(`/payroll-month/${monthIL()}/punch-issues`)
      .then(r => setCounts({
        missing: r.data.missing_count || 0,
        duplicates: r.data.duplicates_count || 0,
        conflicts: r.data.conflicts_count || 0,
      }))
      .catch(() => setCounts(null)); // no banner is better than a wrong one
  }, [relevant]);

  if (!relevant || dismissed || !counts) return null;
  const total = counts.missing + counts.duplicates + counts.conflicts;
  if (total === 0) return null;

  const dismiss = () => { sessionStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); };

  return (
    <Box dir="rtl" sx={{
      display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1,
      bgcolor: 'warning.light', borderBottom: '2px solid', borderColor: 'warning.main',
    }}>
      <WarningAmberIcon fontSize="small" />
      <Typography variant="body2" sx={{ fontWeight: 800 }}>
        בעיות החתמה החודש:
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ flex: 1 }}>
        {counts.missing > 0 && (
          <Chip size="small" color="error" label={`${counts.missing} חסרות`} sx={{ fontWeight: 700 }} />
        )}
        {counts.duplicates > 0 && (
          <Chip size="small" color="warning" label={`${counts.duplicates} ימים כפולים`} sx={{ fontWeight: 700 }} />
        )}
        {counts.conflicts > 0 && (
          <Chip size="small" color="warning" variant="outlined" label={`${counts.conflicts} קונפליקטים`} sx={{ fontWeight: 700 }} />
        )}
      </Stack>
      <Button size="small" variant="contained" color="warning"
        onClick={() => navigate('/attendance?issues=1')}
        sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>
        פתח לטיפול
      </Button>
      <IconButton size="small" onClick={dismiss} aria-label="סגור לסשן הזה">
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
