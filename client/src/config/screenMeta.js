import { TAB_GROUPS } from './tabs.js';

/**
 * Which screen a URL is, and what it is called.
 *
 * TAB_GROUPS already knows every screen's name and the section it belongs to,
 * and three separate things want that: the browser tab's title, the breadcrumb
 * above the page, and the 404. Reading it from one place is what keeps them
 * from disagreeing — a screen renamed in the rail would otherwise keep its old
 * name in the tab title, which is where somebody hunting through eleven open
 * tabs is actually reading.
 *
 * Deliberately free of React and MUI so the whole thing stays testable under
 * plain node (server/scripts/screen-meta.test.js).
 */

/** Screens that are steps inside another screen rather than places of their own. */
const CHILD_OF = {
  '/new-registration': { path: '/registrations', suffix: 'רישום חדש' },
  '/edit-registration': { path: '/registrations', suffix: 'עריכת רישום' },
  '/orders/new': { path: '/orders', suffix: 'הזמנה חדשה' },
  '/gantt/edit': { path: '/gantt', suffix: 'עריכה' },
  '/gantt/parents': { path: '/gantt', suffix: 'מה ההורים רואים' },
  '/nursery/settings': { path: '/nursery', suffix: 'הגדרות' },
  '/admin/permissions': { path: null, suffix: null, label: 'הרשאות', group: 'ניהול' },
  '/account': { path: null, suffix: null, label: 'המנוי והחיוב', group: 'ניהול' },
  '/proposed-changes': { path: null, suffix: null, label: 'שינויים לאישור', group: 'ניהול' },
};

const FLAT = TAB_GROUPS.flatMap((g) =>
  g.items.filter((i) => i.path).map((i) => ({ id: i.id, label: i.label, group: g.label, path: i.path }))
);

/**
 * @param {string} pathname
 * @returns {{ id: string|null, label: string, group: string|null, suffix: string|null, known: boolean }}
 */
export function screenForPath(pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';

  // An exact tab match is the common case and wins outright.
  const exact = FLAT.find((s) => s.path === clean);
  if (exact) return { ...exact, suffix: null, known: true };

  // A step inside a screen: `/orders/new` is still "הזמנות", plus what you are
  // doing there. Longest key first so `/gantt/edit` never matches `/gantt`.
  const childKey = Object.keys(CHILD_OF)
    .sort((a, b) => b.length - a.length)
    .find((k) => clean === k || clean.startsWith(`${k}/`));
  if (childKey) {
    const c = CHILD_OF[childKey];
    if (c.path) {
      const parent = FLAT.find((s) => s.path === c.path);
      if (parent) return { ...parent, suffix: c.suffix, known: true };
    }
    return { id: null, label: c.label, group: c.group, suffix: null, known: true };
  }

  // `/orders/abc123` and the like: the deepest tab path this URL sits under.
  const under = FLAT
    .filter((s) => s.path !== '/' && clean.startsWith(`${s.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (under) return { ...under, suffix: null, known: true };

  return { id: null, label: 'לא נמצא', group: null, suffix: null, known: false };
}

/** What the browser tab says. The screen first — that is what is readable in a narrow tab. */
export function titleForPath(pathname) {
  const s = screenForPath(pathname);
  if (!s.known) return 'לא נמצא · גן החלומות';
  const head = s.suffix ? `${s.label} · ${s.suffix}` : s.label;
  return `${head} · גן החלומות`;
}
