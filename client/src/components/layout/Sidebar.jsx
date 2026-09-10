import { useMemo, useState } from 'react';
import { Box, Typography, Select, MenuItem, Tooltip, IconButton, Avatar } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import LogoutIcon from '@mui/icons-material/Logout';
import SettingsIcon from '@mui/icons-material/Settings';
import { buildNavModel } from '../../config/nav';
import { iconFor } from './navIcons';
import AccountMenu from './AccountMenu';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import { usePendingProposals } from '../../hooks/usePendingProposals';
import { useNewLeadsCount } from '../../hooks/useNewLeadsCount';

export const SIDEBAR_WIDTH = 224;

/**
 * Badges hang off tab ids rather than off screens, so a screen never has to
 * know that it is being counted somewhere else.
 */
function useBadges() {
  const pendingProposals = usePendingProposals();
  const newLeads = useNewLeadsCount();
  return useMemo(
    () => ({ proposed_changes: pendingProposals, leads: newLeads }),
    [pendingProposals, newLeads]
  );
}

/**
 * Every screen this person may open, visible at once.
 *
 * What it replaces: four category dropdowns in a top bar. A system_admin has
 * 38 screens and a branch manager 34, and under the old bar each of them was
 * two clicks and a guess away — which is why staff who use three screens never
 * discovered the other thirty-five.
 *
 * The list comes from buildNavModel, which is TAB_GROUPS filtered by
 * hasTabAccess and nothing else. Permissions are not re-decided here; if this
 * file ever starts deciding who sees what, that is the bug.
 */
export default function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout, canSeeAllBranches } = useAuth();
  const { branches, selectedBranch, changeBranch } = useBranch();
  const badges = useBadges();
  const [accountOpen, setAccountOpen] = useState(false);
  const model = useMemo(() => buildNavModel(user), [user]);

  return (
    <Box
      component="nav"
      aria-label="ניווט ראשי"
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: '100dvh',
        position: 'sticky',
        top: 0,
        bgcolor: 'sidebar.bg',
        color: 'sidebar.fg',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        px: 1.25,
        py: 1.75,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.75, mb: 1.5 }}>
        <Box sx={{ width: 26, height: 26, borderRadius: 1.25, bgcolor: 'sidebar.marker', flexShrink: 0 }} />
        <Typography sx={{ color: 'sidebar.fgActive', fontWeight: 700, fontSize: '0.9375rem' }}>
          גן החלומות
        </Typography>
      </Box>

      {canSeeAllBranches && branches.length > 1 && (
        <Select
          value={selectedBranch || ''}
          onChange={(e) => changeBranch(e.target.value)}
          size="small"
          aria-label="בחירת סניף"
          sx={{
            mb: 1.5,
            bgcolor: 'sidebar.bgActive',
            color: 'sidebar.fgActive',
            fontSize: '0.8125rem',
            '& fieldset': { border: 'none' },
            '& .MuiSvgIcon-root': { color: 'sidebar.fg' },
          }}
        >
          {branches.map((b) => (
            <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
          ))}
        </Select>
      )}

      <Box sx={{ flex: 1 }}>
        {model.map((group) => (
          <Box key={group.label} sx={{ mb: 1.25 }}>
            <Typography
              component="div"
              sx={{
                px: 1,
                pt: 0.75,
                pb: 0.25,
                fontSize: '0.625rem',
                letterSpacing: '0.06em',
                color: 'sidebar.groupLabel',
              }}
            >
              {group.label}
            </Typography>

            {group.items.map((item) => {
              const Icon = iconFor(item.id);
              const active = pathname === item.path;
              const count = badges[item.id] || 0;
              return (
                <Box
                  key={item.id}
                  component="button"
                  type="button"
                  onClick={() => navigate(item.path)}
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1,
                    py: 0.75,
                    border: 0,
                    cursor: 'pointer',
                    textAlign: 'inherit',
                    borderRadius: 1,
                    fontSize: '0.8125rem',
                    fontFamily: 'inherit',
                    color: active ? 'sidebar.fgActive' : 'sidebar.fg',
                    fontWeight: active ? 600 : 400,
                    bgcolor: active ? 'sidebar.bgActive' : 'transparent',
                    borderRight: '2px solid',
                    borderRightColor: active ? 'sidebar.marker' : 'transparent',
                    '&:hover': { bgcolor: 'sidebar.bgActive' },
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'sidebar.marker',
                      outlineOffset: -2,
                    },
                  }}
                >
                  <Icon sx={{ fontSize: 17, opacity: active ? 1 : 0.75, flexShrink: 0 }} />
                  <Box
                    component="span"
                    sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {item.label}
                  </Box>
                  {count > 0 && (
                    <Box
                      component="span"
                      sx={{
                        flexShrink: 0,
                        bgcolor: 'sidebar.marker',
                        color: 'sidebar.bg',
                        borderRadius: 999,
                        px: 0.75,
                        fontSize: '0.625rem',
                        fontWeight: 700,
                        lineHeight: 1.6,
                      }}
                    >
                      {count}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, pt: 1, mt: 'auto' }}>
        <Avatar
          sx={{
            width: 26,
            height: 26,
            fontSize: '0.75rem',
            bgcolor: 'sidebar.bgActive',
            color: 'sidebar.fgActive',
          }}
        >
          {(user?.full_name || '?').trim().charAt(0)}
        </Avatar>
        <Box
          component="span"
          sx={{
            flex: 1,
            fontSize: '0.75rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {user?.full_name || user?.email}
        </Box>
        <Tooltip title="חשבון והגדרות">
          <IconButton
            size="small"
            onClick={() => setAccountOpen(true)}
            sx={{ color: 'sidebar.fg' }}
            aria-label="חשבון והגדרות"
          >
            <SettingsIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="התנתק">
          <IconButton size="small" onClick={logout} sx={{ color: 'sidebar.fg' }} aria-label="התנתק">
            <LogoutIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <AccountMenu open={accountOpen} onClose={() => setAccountOpen(false)} />
    </Box>
  );
}
