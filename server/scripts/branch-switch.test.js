#!/usr/bin/env node
/**
 * Switching gans has to mean something, and כל הסניפים has to be reachable.
 *
 * Which gan a request is about is never passed as a prop. api/client.js reads
 * `selectedBranch` out of localStorage and appends it to every GET, so a screen
 * depends on the branch without ever mentioning it — no prop, no effect
 * dependency, nothing a reviewer would notice missing. That is why both of the
 * bugs this file exists for were invisible to `vite build` and to every other
 * test here:
 *
 *   1. The rail's branch selector listed the gans and nothing else. 'all' is a
 *      real, persisted value of selectedBranch — the classic bar offers it and
 *      a dozen screens branch on it — so somebody who was looking at
 *      כל הסניפים and then accepted the new interface came back to a selector
 *      rendering a value it did not contain: blank, with no way out of it. The
 *      phone drawer had no selector at all, which pinned a manager of several
 *      gans to whatever had been chosen at a desk.
 *
 *   2. The old top bar called window.location.reload() on every change. The
 *      rail replaced the bar and dropped the reload, and nothing took its
 *      place: the selector said כפר סבא while the table under it still listed
 *      תל אביב. AppShell now keys the screen on the branch, so the effects
 *      re-run and refetch without reloading the page.
 *
 * Source assertions rather than a rendered tree, matching the other checks in
 * this directory — there is no React test runner here, and the thing worth
 * locking is the wiring, which is visible in the source.
 *
 *   node scripts/branch-switch.test.js
 */
const fs = require('fs');
const path = require('path');

const LAYOUT = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'layout');
const HOOKS = path.join(__dirname, '..', '..', 'client', 'src', 'hooks');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * A <Select> that can hold 'all' must offer 'all'. Matched on the MenuItem's
 * value rather than on the Hebrew label: the label is what somebody reads, the
 * value is what the api client sends, and only the second one can be wrong in
 * a way the screen does not show.
 */
function offersAllBranches(src) {
  return /<MenuItem[^>]*\bvalue="all"/.test(src);
}

function main() {
  console.log('=== מעבר בין סניפים ===\n');

  // --- 1. Both navigations offer the cross-branch view -----------------------
  const sidebar = read(path.join(LAYOUT, 'Sidebar.jsx'));
  const mobile = read(path.join(LAYOUT, 'MobileNav.jsx'));
  const classic = read(path.join(LAYOUT, 'classic', 'ClassicHeader.jsx'));

  ok(offersAllBranches(classic), 'הסרגל הישן מציע "כל הסניפים"',
    'ClassicHeader.jsx — זו הנקודה שממנה נמדדות השתיים הבאות');
  ok(offersAllBranches(sidebar), 'הסרגל החדש מציע "כל הסניפים"',
    'Sidebar.jsx — בלי MenuItem value="all" מי שנמצא ב-all רואה בורר ריק');
  ok(offersAllBranches(mobile), 'מגירת הטלפון מציעה "כל הסניפים"',
    'MobileNav.jsx — הסרגל לא קיים בטלפון, ולכן הבורר חייב להיות כאן');

  /**
   * And the phone must offer the gans themselves, not only 'all' — the drawer
   * is the ONLY branch selector on a phone, so a missing list there is a
   * manager who cannot leave the gan she is standing in.
   */
  ok(/branches\.map\(/.test(mobile), 'מגירת הטלפון מציגה את רשימת הסניפים',
    'MobileNav.jsx — בלי branches.map הבורר ריק מגנים');
  ok(/changeBranch\(/.test(mobile), 'ובחירה בטלפון באמת מחליפה סניף',
    'MobileNav.jsx — בלי changeBranch הבורר מצייר ולא עושה');

  /**
   * The gate. `canSeeAllBranches && branches.length > 1` is the same condition
   * the classic bar uses, and it is not cosmetic: an accountant sees every gan
   * and a branch manager of one gan must not be offered a cross-branch view the
   * server would refuse.
   */
  for (const [name, src] of [['Sidebar.jsx', sidebar], ['MobileNav.jsx', mobile]]) {
    const gated = /canSeeAllBranches && branches\.length > 1 &&[\s\S]{0,400}?value="all"/.test(src);
    ok(gated, `"כל הסניפים" ב-${name} מותנה בהרשאה`,
      `${name} — האפשרות צריכה לשבת מאחורי canSeeAllBranches && branches.length > 1`);
  }

  // --- 2. Changing the branch refetches the screen ---------------------------
  const shell = read(path.join(LAYOUT, 'AppShell.jsx'));

  ok(/useBranch\(\)/.test(shell), 'AppShell יודע איזה סניף נבחר',
    'AppShell.jsx — בלי useBranch אין על מה למפתח את המסך');

  /**
   * The remount itself. Either the key on the element wrapping <Outlet />, or
   * the boundary's routeKey — both are checked, because a change that keeps one
   * and drops the other brings half the bug back: the boundary would reset
   * without the screen refetching, or the screen would refetch while a stale
   * error stayed on top of it.
   */
  ok(/key=\{selectedBranch\}[\s\S]{0,200}<Outlet\s*\/>/.test(shell),
    'המסך ממותג מחדש כשהסניף משתנה',
    'AppShell.jsx — צריך key={selectedBranch} על העוטף של <Outlet />');
  ok(/routeKey=\{`\$\{pathname\}\|\$\{selectedBranch\}`\}/.test(shell),
    'וגבול השגיאה מתאפס יחד איתו',
    'AppShell.jsx — routeKey צריך לכלול גם את הנתיב וגם את הסניף');

  /**
   * The counters in the rail are branch-scoped by the same invisible mechanism,
   * so they need the branch in their dependency list or the badge keeps
   * answering for the gan you just left — for up to a minute, which is long
   * enough to act on.
   */
  for (const f of ['useNewLeadsCount.js', 'usePendingProposals.js']) {
    const src = read(path.join(HOOKS, f));
    ok(/}, \[[^\]]*selectedBranch\]\);/.test(src), `הסמן ב-${f} מתעדכן עם החלפת סניף`,
      `${f} — selectedBranch חייב להיות ברשימת התלויות של ה-useEffect`);
  }

  console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures ? 1 : 0);
}

main();
