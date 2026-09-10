import { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Select, MenuItem, Tooltip, IconButton, Avatar, Collapse } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
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

export const SIDEBAR_WIDTH = 244;

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

  /**
   * Which sections are open.
   *
   * Thirty-eight rows in one column is a scroll, and a scroll is a list nobody
   * reads to the end of — the four screens at the bottom may as well not exist.
   * So a section opens when you are inside it and closes when you leave, and
   * anything you open by hand stays open until you close it.
   *
   * The current section is derived rather than stored: arriving anywhere — a
   * link, a badge, a fresh tab — opens the section that screen lives in,
   * without every entry point having to remember to.
   */
  const groupOfCurrent = useMemo(
    () => model.find((g) => g.items.some((i) => i.path === pathname))?.label,
    [model, pathname]
  );
  const [openGroups, setOpenGroups] = useState(() => new Set());

  useEffect(() => {
    if (groupOfCurrent) setOpenGroups((prev) => new Set(prev).add(groupOfCurrent));
  }, [groupOfCurrent]);

  const toggleGroup = (label) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(label)) next.delete(label); else next.add(label);
    return next;
  });

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
        color: 'sidebar.fg',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        px: 1.5,
        py: 2,
        // A very slight fall from top to bottom. Flat ink over 900px of height
        // reads as a painted block; this reads as a surface.
        background: (t) => `linear-gradient(180deg, ${t.palette.sidebar.bg} 0%, ${t.palette.sidebar.bgDeep} 100%)`,
        // Hide the scrollbar's own chrome — a light system scrollbar down the
        // side of an ink rail is the loudest thing on the screen.
        scrollbarWidth: 'thin',
        scrollbarColor: (t) => `${t.palette.sidebar.bgActive} transparent`,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-thumb': { backgroundColor: 'sidebar.bgActive', borderRadius: 999 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 0.5, mb: 2 }}>
        <Box
          sx={{
            width: 30, height: 30, borderRadius: 1.5, flexShrink: 0,
            bgcolor: 'sidebar.marker',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'sidebar.bg', fontWeight: 800, fontSize: '0.875rem',
          }}
        >
          ג
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ color: 'sidebar.fgActive', fontWeight: 700, fontSize: '0.9375rem', lineHeight: 1.2 }}>
            גן החלומות
          </Typography>
          <Typography sx={{ color: 'sidebar.groupLabel', fontSize: '0.6875rem', lineHeight: 1.3 }}>
            ניהול חכם
          </Typography>
        </Box>
      </Box>

      {canSeeAllBranches && branches.length > 1 && (
        <Select
          value={selectedBranch || ''}
          onChange={(e) => changeBranch(e.target.value)}
          size="small"
          aria-label="בחירת סניף"
          sx={{
            mb: 2,
            bgcolor: 'sidebar.bgActive',
            color: 'sidebar.fgActive',
            fontSize: '0.8125rem',
            fontWeight: 600,
            borderRadius: 1.5,
            '& fieldset': { border: 'none' },
            '& .MuiSelect-select': { py: 1 },
            '& .MuiSvgIcon-root': { color: 'sidebar.fg' },
          }}
        >
          {branches.map((b) => (
            <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
          ))}
        </Select>
      )}

      <Box sx={{ flex: 1 }}>
        {model.map((group) => {
          const open = openGroups.has(group.label);
          const holdsCurrent = group.label === groupOfCurrent;
          // What is waiting inside a section you cannot see into.
          const groupBadge = group.items.reduce((n, i) => n + (badges[i.id] || 0), 0);
          return (
          <Box key={group.label} sx={{ mb: open ? 1.5 : 0.25 }}>
            <Box
              component="button"
              type="button"
              onClick={() => toggleGroup(group.label)}
              aria-expanded={open}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1,
                width: '100%', px: 1, py: 0.75, mb: open ? 0.5 : 0,
                border: 0, bgcolor: 'transparent', cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'inherit', borderRadius: 1.5,
                '&:hover': { bgcolor: 'sidebar.bgActive' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'sidebar.marker', outlineOffset: -2 },
              }}
            >
              <ExpandMoreIcon
                sx={{
                  fontSize: 16, flexShrink: 0,
                  color: 'sidebar.groupLabel',
                  transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform 160ms',
                }}
              />
              <Typography
                component="div"
                sx={{
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: holdsCurrent ? 'sidebar.marker' : 'sidebar.groupLabel',
                  flexShrink: 0,
                }}
              >
                {group.label}
              </Typography>
              {/* A rule that runs out to the edge. It is what turns four lists
                  into four sections without spending a heading's worth of height
                  on each. */}
              <Box sx={{ flex: 1, height: '1px', bgcolor: 'sidebar.rule' }} />
              {/* Closed sections still have to be able to say that something is
                  waiting inside them, or collapsing the rail hides the badge
                  that was the reason to look. */}
              {!open && groupBadge > 0 && (
                <Box
                  component="span"
                  sx={{
                    flexShrink: 0, bgcolor: 'sidebar.marker', color: 'sidebar.bg',
                    borderRadius: 999, minWidth: 19, textAlign: 'center',
                    px: 0.625, fontSize: '0.6875rem', fontWeight: 800, lineHeight: 1.55,
                  }}
                >
                  {groupBadge}
                </Box>
              )}
              {!open && (
                <Typography sx={{ flexShrink: 0, fontSize: '0.6875rem', color: 'sidebar.groupLabel', opacity: 0.7 }}>
                  {group.items.length}
                </Typography>
              )}
            </Box>

            <Collapse in={open} timeout={160} unmountOnExit>

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
                    position: 'relative',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    px: 1,
                    py: 0.875,
                    border: 0,
                    cursor: 'pointer',
                    textAlign: 'inherit',
                    borderRadius: 1.5,
                    fontSize: '0.84375rem',
                    fontFamily: 'inherit',
                    color: active ? 'sidebar.fgActive' : 'sidebar.fg',
                    fontWeight: active ? 700 : 500,
                    bgcolor: active ? 'sidebar.markerSoft' : 'transparent',
                    transition: 'background-color 140ms, color 140ms',
                    // The marker is an inset bar rather than a full-height
                    // border: a 2px line running the whole row reads as a table
                    // rule, a short bar reads as a bookmark.
                    '&::before': {
                      content: '""',
                      position: 'absolute',
                      insetInlineStart: 0,
                      top: 8,
                      bottom: 8,
                      width: 3,
                      borderRadius: 999,
                      bgcolor: active ? 'sidebar.marker' : 'transparent',
                    },
                    '&:hover': { bgcolor: active ? 'sidebar.markerSoft' : 'sidebar.bgActive', color: 'sidebar.fgActive' },
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'sidebar.marker',
                      outlineOffset: -2,
                    },
                  }}
                >
                  <Icon sx={{ fontSize: 18, flexShrink: 0, color: active ? 'sidebar.marker' : 'inherit', opacity: active ? 1 : 0.6 }} />
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
                        minWidth: 19,
                        textAlign: 'center',
                        px: 0.625,
                        fontSize: '0.6875rem',
                        fontWeight: 800,
                        lineHeight: 1.55,
                      }}
                    >
                      {count}
                    </Box>
                  )}
                </Box>
              );
            })}
            </Collapse>
          </Box>
          );
        })}
      </Box>

      <Box sx={{ height: '1px', bgcolor: 'sidebar.rule', mt: 'auto', mb: 1.25, mx: 0.5 }} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, pb: 0.5 }}>
        <Avatar
          sx={{
            width: 30,
            height: 30,
            fontSize: '0.8125rem',
            fontWeight: 700,
            bgcolor: 'sidebar.bgActive',
            color: 'sidebar.marker',
          }}
        >
          {(user?.full_name || '?').trim().charAt(0)}
        </Avatar>
        <Box
          component="span"
          sx={{
            flex: 1,
            fontSize: '0.78125rem',
            fontWeight: 600,
            color: 'sidebar.fgActive',
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
