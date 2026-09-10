import { useMemo, useState } from 'react';
import { Box, Drawer, Typography, Divider, Avatar } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import { buildNavModel } from '../../config/nav';
import { iconFor } from './navIcons';
import AccountMenu from './AccountMenu';
import { useAuth } from '../../hooks/useAuth';

export const MOBILE_NAV_HEIGHT = 56;

/**
 * The bar's real height on a device with a home indicator.
 *
 * `height: 56` with `padding-bottom: env(safe-area-inset-bottom)` inside it
 * does not make the bar taller — it eats 34px of the 56, leaving 22px for
 * targets declared at 44. The inset has to be ADDED to the height, and anyone
 * reserving space below the content has to reserve the same expression.
 */
export const MOBILE_NAV_SPACE = `calc(${MOBILE_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`;

/**
 * Whether the bottom bar will actually render, for anyone who needs to leave
 * room for it. AppShell used to assume it always does and reserved the space
 * unconditionally; a person with no visible tabs got 72px of empty page.
 */
export function useHasMobileNav() {
  const { user } = useAuth();
  const model = useMemo(() => buildNavModel(user), [user]);
  return model.some((g) => g.items.length > 0);
}

/**
 * The four screens that are actually opened from a phone, standing in a room:
 * the infant board, what ran out, the punch clock, and the camera roll. The
 * office screens are all still here under "עוד" — they are simply not what
 * someone holding a phone in a gan is reaching for.
 *
 * Filtered through the same nav model as the rail, so a role without one of
 * these gets a shorter bar rather than a tab that goes nowhere.
 */
const PHONE_FIRST_BY_ROLE = {
  // In the room: the infant board, what ran out, who is away today, who may
  // collect. `attendance` is NOT here — tabs.js does not grant it to a teacher
  // or an assistant at all, so it was one of four slots showing nothing, while
  // the two screens she opens most sat under "עוד".
  teacher:      ['nursery', 'supplies', 'absences', 'pickup'],
  assistant:    ['nursery', 'supplies', 'absences', 'pickup'],
  class_leader: ['nursery', 'supplies', 'absences', 'photos'],
  cook:         ['supplies', 'nursery', 'absences', 'photos'],
  // Running a branch from a phone: the punch clock is the reason she opens it.
  branch_manager: ['attendance', 'nursery', 'supplies', 'absences'],
  accountant:     ['attendance', 'collections', 'payroll', 'employees'],
  admin_viewer:   ['attendance', 'nursery', 'employees', 'collections'],
  system_admin:   ['attendance', 'nursery', 'supplies', 'photos'],
};
const PHONE_FIRST_FALLBACK = ['nursery', 'supplies', 'attendance', 'photos'];

export default function MobileNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const model = useMemo(() => buildNavModel(user), [user]);

  const all = useMemo(() => model.flatMap((g) => g.items), [model]);
  const primary = useMemo(() => {
    const wanted = PHONE_FIRST_BY_ROLE[user?.role] || PHONE_FIRST_FALLBACK;
    const picked = wanted.map((id) => all.find((i) => i.id === id)).filter(Boolean);
    // Never fewer than four while there are screens to fill them with: a role
    // whose preferred four are not all granted should still get a full bar.
    for (const item of all) {
      if (picked.length >= 4) break;
      if (!picked.some((p) => p.id === item.id)) picked.push(item);
    }
    return picked.slice(0, 4);
  }, [all, user?.role]);

  if (all.length === 0) return null;

  const go = (path) => { setMoreOpen(false); navigate(path); };

  // 44px is the floor for a target somebody hits with a thumb while holding a
  // child's folder in the other hand.
  const cell = (active) => ({
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.25,
    border: 0,
    bgcolor: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.6875rem',
    color: active ? 'primary.main' : 'text.secondary',
  });

  return (
    <>
      <Box
        component="nav"
        aria-label="ניווט"
        sx={{
          display: { xs: 'flex', md: 'none' },
          position: 'fixed',
          insetInline: 0,
          bottom: 0,
          height: MOBILE_NAV_SPACE,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          zIndex: (t) => t.zIndex.appBar,
          pb: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {primary.map((item) => {
          const Icon = iconFor(item.id);
          const active = pathname === item.path;
          return (
            <Box
              component="button"
              type="button"
              key={item.id}
              onClick={() => go(item.path)}
              aria-current={active ? 'page' : undefined}
              sx={cell(active)}
            >
              <Icon sx={{ fontSize: 20 }} />
              {item.label}
            </Box>
          );
        })}

        <Box
          component="button"
          type="button"
          onClick={() => setMoreOpen(true)}
          sx={cell(false)}
          aria-label="עוד מסכים"
        >
          <MoreHorizIcon sx={{ fontSize: 20 }} />
          עוד
        </Box>
      </Box>

      <Drawer
        anchor="bottom"
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        PaperProps={{ sx: { maxHeight: '80dvh', borderTopLeftRadius: 12, borderTopRightRadius: 12 } }}
      >
        <Box sx={{ p: 2 }}>
          {/**
           * Who you are, settings, and the way out.
           *
           * These live in the foot of the rail on a desktop, and the rail does
           * not exist on a phone — so without this block there is no way to log
           * out or enrol a fingerprint from a phone at all, which is the one
           * device most of this app's users hold. The old Header kept the same
           * two actions in the foot of its own drawer.
           */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1.5 }}>
            <Avatar sx={{ width: 34, height: 34, fontSize: '0.875rem', bgcolor: 'primary.soft', color: 'primary.softOn' }}>
              {(user?.full_name || '?').trim().charAt(0)}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ fontSize: '0.875rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.full_name || user?.email}
              </Box>
            </Box>
            <Box
              component="button"
              type="button"
              onClick={() => { setMoreOpen(false); setAccountOpen(true); }}
              aria-label="חשבון והגדרות"
              sx={{
                minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 0, bgcolor: 'transparent', cursor: 'pointer', color: 'text.secondary',
              }}
            >
              <SettingsIcon sx={{ fontSize: 20 }} />
            </Box>
            <Box
              component="button"
              type="button"
              onClick={logout}
              aria-label="התנתק"
              sx={{
                minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 0, bgcolor: 'transparent', cursor: 'pointer', color: 'text.secondary',
              }}
            >
              <LogoutIcon sx={{ fontSize: 20 }} />
            </Box>
          </Box>

          <Divider sx={{ mb: 1.5 }} />

          {model.map((group) => (
            <Box key={group.label} sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: '0.6875rem', color: 'text.secondary', mb: 0.5 }}>
                {group.label}
              </Typography>
              {group.items.map((item) => {
                const Icon = iconFor(item.id);
                return (
                  <Box
                    component="button"
                    type="button"
                    key={item.id}
                    onClick={() => go(item.path)}
                    aria-current={pathname === item.path ? 'page' : undefined}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.25,
                      width: '100%',
                      minHeight: 44,
                      px: 1,
                      borderRadius: 1,
                      border: 0,
                      fontWeight: pathname === item.path ? 700 : 400,
                      bgcolor: pathname === item.path ? 'primary.soft' : 'transparent',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '0.875rem',
                      textAlign: 'inherit',
                      color: 'text.primary',
                    }}
                  >
                    <Icon sx={{ fontSize: 18, color: 'text.secondary' }} />
                    {item.label}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Drawer>

      <AccountMenu open={accountOpen} onClose={() => setAccountOpen(false)} />
    </>
  );
}
