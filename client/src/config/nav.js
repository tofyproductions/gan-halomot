/**
 * What the sidebar draws, for one person.
 *
 * Kept apart from the component that renders it, and free of MUI imports, so
 * the question "does this role see exactly the screens it saw before" is
 * answerable by a test rather than by clicking through the app as five
 * different users (server/scripts/nav-model.test.js).
 *
 * TAB_GROUPS stays the single source of truth and is not modified here: this
 * is a filter over it, in its order.
 */
// Imported with its extension, unlike everywhere else in the client. Vite
// resolves './tabs' happily; plain node does not, and the test above runs
// under plain node with no bundler. The extension costs nothing and is what
// keeps this file testable.
import { TAB_GROUPS, hasTabAccess } from './tabs.js';

/**
 * @param {{role: string, tab_overrides_add?: string[], tab_overrides_remove?: string[]} | null} user
 * @returns {{label: string, items: {id: string, label: string, path: string}[]}[]}
 */
export function buildNavModel(user) {
  if (!user) return [];

  return TAB_GROUPS
    .map((group) => ({
      label: group.label,
      items: group.items
        // `path: null` marks a write grant — a permission stored and checked
        // exactly like a tab, but not a place you can navigate to.
        // clicktac_write is the right to act on רישום חיצוני rather than a
        // screen of its own, and drawing it would put an entry in the menu
        // that goes nowhere.
        .filter((item) => item.path && hasTabAccess(user, item.id))
        .map(({ id, label, path }) => ({ id, label, path })),
    }))
    // A heading with nothing under it is worse than a missing heading: it
    // tells someone the screens exist and that they do not have them.
    .filter((group) => group.items.length > 0);
}
