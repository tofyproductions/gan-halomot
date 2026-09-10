import { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Select, MenuItem, Tooltip, IconButton, Avatar, Collapse, InputBase } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import HistoryIcon from '@mui/icons-material/History';
import { useNavigate, useLocation } from 'react-router-dom';
import LogoutIcon from '@mui/icons-material/Logout';
import SettingsIcon from '@mui/icons-material/Settings';
import { buildNavModel } from '../../config/nav';
import { screenForPath } from '../../config/screenMeta';
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

const RECENTS_KEY = 'nav_recents';
const RECENTS_MAX = 3;

/**
 * The last three screens this person opened, on this device.
 *
 * Forty-one screens in six sections, and almost everybody lives in four of
 * them — but those four are spread across three sections, so the daily route
 * to each is open a section, find the row, and the section you had open closes.
 * Recents is the shortcut the rail could not otherwise offer without guessing
 * what somebody's job is.
 *
 * localStorage, deliberately: it is a per-device convenience worth nothing to
 * anyone else, it must survive a reload, and it must never reach the server —
 * which screens a named employee opens is not something this app should be
 * storing centrally in order to save her a click.
 */
function useRecents(currentId, model) {
  const [ids, setIds] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
    } catch {
      // A private window, cleared site data, or storage blocked outright. An
      // empty list is the correct answer, not a crash in the navigation.
      return [];
    }
  });

  useEffect(() => {
    if (!currentId) return;
    setIds((prev) => {
      const next = [currentId, ...prev.filter((x) => x !== currentId)].slice(0, RECENTS_MAX + 1);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* see above */ }
      return next;
    });
  }, [currentId]);

  // Resolved against the model, so a screen this person lost access to — or one
  // that no longer exists — silently drops out instead of rendering a dead row.
  // The screen you are on now is excluded: it is not somewhere to go back to.
  return useMemo(() => {
    const all = model.flatMap((g) => g.items);
    return ids
      .filter((id) => id !== currentId)
      .map((id) => all.find((i) => i.id === id))
      .filter(Boolean)
      .slice(0, RECENTS_MAX);
  }, [ids, model, currentId]);
}

/**
 * One row in the rail.
 *
 * Pulled out of the section loop because there are now three places a screen
 * can be listed — inside its section, in the search results, and in recents —
 * and three copies of a row is three chances for the marker, the badge or the
 * focus ring to drift apart. `hint` is the section name, shown only where the
 * row has been taken out of its section and the name is the missing context.
 */
function NavRow({ item, active, count, onClick, hint }) {
  const Icon = iconFor(item.id);
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
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
        transition: (t) => `background-color ${t.motion.fast}, color ${t.motion.fast}`,
        // The marker is an inset bar rather than a full-height border: a 2px
        // line running the whole row reads as a table rule, a short bar reads
        // as a bookmark.
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
        '&:focus-visible': { outline: '2px solid', outlineColor: 'sidebar.marker', outlineOffset: -2 },
      }}
    >
      <Icon sx={{ fontSize: 18, flexShrink: 0, color: active ? 'sidebar.marker' : 'inherit', opacity: active ? 1 : 0.6 }} />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </Box>
        {hint && (
          <Box component="span" sx={{ fontSize: '0.625rem', color: 'sidebar.groupLabel', flexShrink: 0 }}>
            {hint}
          </Box>
        )}
      </Box>
      {count > 0 && (
        <Box
          component="span"
          sx={{
            flexShrink: 0, bgcolor: 'sidebar.marker', color: 'sidebar.bg',
            borderRadius: 999, minWidth: 19, textAlign: 'center',
            px: 0.625, fontSize: '0.6875rem', fontWeight: 800, lineHeight: 1.55,
          }}
        >
          {count}
        </Box>
      )}
    </Box>
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
   * Which section is open — exactly one, or none.
   *
   * Thirty-eight rows in one column is a scroll, and a scroll is a list nobody
   * reads to the end of; the four screens at the bottom may as well not exist.
   * Sections collapse to fix that, and then letting several stand open undoes
   * the fix — two open sections are already 25 rows and the scroll is back.
   *
   * So opening one closes the last. There is nothing to compare across sections
   * here: you are going to one screen, and the section is how you find it.
   *
   * The current section is derived rather than stored, so arriving anywhere —
   * a link, a badge, a fresh tab, the browser's back button — opens the section
   * that screen lives in without every entry point having to remember to.
   */
  /**
   * Which screen you are on, including when you are one level inside it.
   *
   * Exact path matching meant /orders/new, /gantt/edit, /nursery/settings and
   * /edit-registration/:id opened no section and lit no row — the rail claimed
   * you were nowhere while the breadcrumb said "הזמנות / הזמנה חדשה".
   * screenForPath already resolves sub-screens to their parent; it just was
   * not being asked.
   */
  const currentId = useMemo(() => screenForPath(pathname).id, [pathname]);
  const groupOfCurrent = useMemo(
    () => model.find((g) => g.items.some((i) => i.id === currentId))?.label,
    [model, currentId]
  );
  const [openGroup, setOpenGroup] = useState(null);
  const [query, setQuery] = useState('');
  const recents = useRecents(currentId, model);

  useEffect(() => {
    if (groupOfCurrent) setOpenGroup(groupOfCurrent);
  }, [groupOfCurrent]);

  /**
   * Typing searches every screen at once, across every section.
   *
   * This is the answer to the one thing sections cost: a person who knows the
   * screen's name still has to know which section somebody else filed it under.
   * "גיוס" is under כוח אדם, "ארכיון" is under מערכת — obvious once you know,
   * unfindable until then.
   *
   * Matches on the label and on the section name, so "שכר" finds both the
   * payroll table and the monthly updates, and "מערכת" lists what is in that
   * section without opening it.
   */
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const out = [];
    for (const g of model) {
      for (const i of g.items) {
        if (i.label.includes(q) || g.label.includes(q)) out.push({ ...i, group: g.label });
      }
    }
    return out;
  }, [query, model]);

  const go = (path) => { setQuery(''); navigate(path); };

  // Clicking the open one closes it, so the rail can be reduced to four rows.
  const toggleGroup = (label) => setOpenGroup((prev) => (prev === label ? null : label));

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

      {/* Type to find a screen, anywhere.
          Sections cost one thing: a person who knows the screen's name still
          has to know which section somebody else filed it under. This is that
          cost paid back. */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.75,
          mb: 1.5, px: 1, py: 0.5,
          borderRadius: 1.5,
          bgcolor: 'sidebar.bgDeep',
          border: '1px solid',
          borderColor: query ? 'sidebar.marker' : 'sidebar.rule',
          transition: (t) => `border-color ${t.motion.fast}`,
        }}
      >
        <SearchIcon sx={{ fontSize: 16, color: 'sidebar.groupLabel', flexShrink: 0 }} />
        <InputBase
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            // The first result is the obvious one; Enter should take it rather
            // than making somebody reach for the mouse after typing.
            if (e.key === 'Enter' && results?.length) go(results[0].path);
          }}
          placeholder="חיפוש מסך"
          inputProps={{ 'aria-label': 'חיפוש מסך' }}
          /**
           * NO `::placeholder` RULE HERE, and it is not an oversight.
           *
           * `sx={{ '& input::placeholder': {...} }}` crashes this app — a white
           * screen, caught only by ScreenBoundary. client/node_modules holds
           * TWO copies of stylis: 4.3.6 at the top level (pulled in by
           * stylis-plugin-rtl) and 4.2.0 inside @emotion/cache. Stylis handles
           * `::placeholder` by calling `lift()`, which reads `root.siblings` —
           * a field one of those versions creates and the other does not — so
           * it throws "Cannot read properties of undefined (reading 'push')"
           * from inside emotion's insertion, with nothing pointing at the
           * selector that caused it.
           *
           * MUI already renders the placeholder as currentColor at reduced
           * opacity, so setting `color` here is enough. The real fix is one
           * stylis in the tree, which is a dependency change and not this
           * branch's business.
           */
          sx={{ flex: 1, color: 'sidebar.fgActive', fontSize: '0.8125rem' }}
        />
        {query && (
          <IconButton size="small" onClick={() => setQuery('')} aria-label="ניקוי החיפוש"
            sx={{ p: 0.25, color: 'sidebar.groupLabel' }}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        )}
      </Box>

      {/* Results replace the sections rather than sitting above them: while you
          are searching, the sections are not what you are looking at. */}
      {results && (
        <Box sx={{ flex: 1 }}>
          {results.length === 0 ? (
            <Typography sx={{ px: 1, py: 2, fontSize: '0.75rem', color: 'sidebar.groupLabel' }}>
              אין מסך בשם הזה
            </Typography>
          ) : results.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={item.id === currentId}
              count={badges[item.id] || 0}
              hint={item.group}
              onClick={() => go(item.path)}
            />
          ))}
        </Box>
      )}

      <Box sx={{ flex: 1, display: results ? 'none' : 'block' }}>
        {/* Where you just were. Four screens is most people's whole job, and
            they are spread across three sections — so the daily route to each
            was: open a section, find the row, and the section you had open
            closes behind you. */}
        {recents.length > 0 && (
          <Box sx={{ mb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75 }}>
              <HistoryIcon sx={{ fontSize: 14, color: 'sidebar.groupLabel', flexShrink: 0 }} />
              <Typography
                component="div"
                sx={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.08em', color: 'sidebar.groupLabel', flexShrink: 0 }}
              >
                אחרונים
              </Typography>
              <Box sx={{ flex: 1, height: '1px', bgcolor: 'sidebar.rule' }} />
            </Box>
            {recents.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={false}
                count={badges[item.id] || 0}
                onClick={() => go(item.path)}
              />
            ))}
          </Box>
        )}

        {model.map((group) => {
          const open = openGroup === group.label;
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
                  transition: (t) => `transform ${t.motion.fast}`,
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

            <Collapse in={open} timeout={{ enter: 200, exit: 140 }} unmountOnExit>

            {group.items.map((item) => (
              <NavRow
                key={item.id}
                item={item}
                active={item.id === currentId}
                count={badges[item.id] || 0}
                onClick={() => go(item.path)}
              />
            ))}
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
