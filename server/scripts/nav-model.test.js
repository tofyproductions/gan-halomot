#!/usr/bin/env node
/**
 * The rail is about to become the only way to reach a screen, so the set of
 * screens it draws has to be exactly the set the old dropdowns drew — no more,
 * and no fewer.
 *
 * Two failure modes are worth a test of their own. A write grant is a tab id
 * with `path: null` (clicktac_write is the permission to ACT on רישום חיצוני,
 * not a screen); drawing it puts an entry in the menu that goes nowhere. And a
 * group whose every item is hidden from this role must disappear rather than
 * leave a heading standing over nothing, which tells someone the screens exist
 * and that they may not have them.
 *
 *   node scripts/nav-model.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const NAV = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'config', 'nav.js')
).href;
const TABS = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'config', 'tabs.js')
).href;

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

const user = (role, extra = {}) => ({
  role,
  tab_overrides_add: [],
  tab_overrides_remove: [],
  ...extra,
});

async function main() {
  console.log('=== מודל הניווט של סרגל הצד ===\n');
  const { buildNavModel } = await import(NAV);
  const { TAB_GROUPS, hasTabAccess } = await import(TABS);

  const flat = (model) => model.flatMap((g) => g.items.map((i) => i.id));

  console.log('התאמה להרשאות הקיימות:');
  for (const role of ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'teacher']) {
    const u = user(role);
    const expected = TAB_GROUPS
      .flatMap((g) => g.items)
      .filter((i) => i.path && hasTabAccess(u, i.id))
      .map((i) => i.id);
    const got = flat(buildNavModel(u));
    ok(
      expected.length === got.length && expected.every((id, n) => got[n] === id),
      `${role}: ${got.length} מסכים, זהה ל-hasTabAccess`,
      `ציפינו ל-${expected.length}`
    );
  }

  console.log('\nמענקי כתיבה אינם מסכים:');
  const admin = user('system_admin');
  const adminIds = flat(buildNavModel(admin));
  ok(!adminIds.includes('clicktac_write'), 'clicktac_write לא מופיע בתפריט');
  const nullPathIds = TAB_GROUPS.flatMap((g) => g.items).filter((i) => !i.path).map((i) => i.id);
  ok(
    nullPathIds.every((id) => !adminIds.includes(id)),
    `אף פריט ללא path לא מופיע (${nullPathIds.length} כאלה)`
  );

  console.log('\nקבוצות ריקות נעלמות:');
  const teacherModel = buildNavModel(user('teacher'));
  ok(teacherModel.every((g) => g.items.length > 0), 'אין קבוצה בלי פריטים');
  ok(teacherModel.length < TAB_GROUPS.length, 'מורה רואה פחות קבוצות ממנהל מערכת');

  console.log('\nעקיפות אישיות נשמרות:');
  const granted = user('teacher', { tab_overrides_add: ['pricing'] });
  ok(flat(buildNavModel(granted)).includes('pricing'), 'מסך שהוענק ידנית מופיע');
  const revoked = user('system_admin', { tab_overrides_remove: ['pricing'] });
  ok(!flat(buildNavModel(revoked)).includes('pricing'), 'מסך שנשלל ידנית לא מופיע');

  console.log('\nצורת המודל:');
  ok(
    teacherModel.every((g) => typeof g.label === 'string' && Array.isArray(g.items)),
    'כל קבוצה: label + items'
  );
  ok(
    teacherModel.every((g) => g.items.every((i) => i.id && i.label && i.path)),
    'כל פריט: id + label + path'
  );
  ok(buildNavModel(null).length === 0, 'ללא משתמש — תפריט ריק, לא קריסה');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
