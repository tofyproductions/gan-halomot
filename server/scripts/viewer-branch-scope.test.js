#!/usr/bin/env node
/**
 * Which branches a viewer's request may touch: all of them to read, only
 * the managed ones to write, none when there are no managed ones.
 *
 *   node scripts/viewer-branch-scope.test.js
 */
const Module = require('module');

// Stand-in for the User model: what the database says about each user.
let dbUsers = {};
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === '../models' && parent && parent.filename.endsWith('utils/branch-scope.js')) {
    return {
      User: {
        findById: (id) => ({ select: () => ({ lean: async () => dbUsers[id] || null }) }),
      },
    };
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { resolveBranchScope } = require('../src/utils/branch-scope');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

(async () => {
  console.log('\n🗺️ טווח הסניפים של הצופה\n');
  dbUsers = {
    v1: { role: 'admin_viewer', managed_branch_ids: ['b1'], branch_id: 'b1' },
    v0: { role: 'admin_viewer', managed_branch_ids: [], branch_id: 'b9' },
    a1: { role: 'system_admin', managed_branch_ids: [], branch_id: null },
    m1: { role: 'branch_manager', managed_branch_ids: ['b2', 'b3'], branch_id: 'b2' },
    t1: { role: 'teacher', managed_branch_ids: [], branch_id: 'b4' },
  };
  const req = (id, method) => ({ method, user: { id, role: 'x' } });

  eq(await resolveBranchScope(req('v1', 'GET')), null, 'צופה קורא — כל הסניפים');
  eq(await resolveBranchScope(req('v1', 'PATCH')), ['b1'], 'צופה כותב — רק הסניפים שבניהולו');
  eq(await resolveBranchScope(req('v0', 'GET')), null, 'צופה בלי סניפים קורא — כל הסניפים');
  eq(await resolveBranchScope(req('v0', 'POST')), [], 'צופה בלי סניפים כותב — אף סניף (לא הסניף האישי)');
  eq(await resolveBranchScope(req('a1', 'POST')), null, 'מנהל מערכת — ללא שינוי');
  eq(await resolveBranchScope(req('m1', 'POST')), ['b2', 'b3'], 'מנהל סניף — ללא שינוי');
  eq(await resolveBranchScope(req('t1', 'GET')), ['b4'], 'גננת — ללא שינוי');

  console.log('\nהרשאת פעולה למסך (req.tabWriteGrant) — כל הסניפים');
  // `clicktac_write` means "act on רישום חיצוני for EVERY branch": the person
  // it is granted to files the ministry's list for כפר סבא and the ClickTac
  // export for תל אביב. requireTabWrite sets the flag on the request when the
  // pass came from the grant, and nowhere else.
  const granted = (id, method) => ({ method, user: { id, role: 'x' }, tabWriteGrant: 'clicktac' });
  eq(await resolveBranchScope(granted('m1', 'POST')), null,
    'מנהלת סניף עם הרשאת הפעולה כותבת בכל הסניפים');
  eq(await resolveBranchScope(req('m1', 'POST')), ['b2', 'b3'],
    'ובלי ההרשאה — רק הסניפים שבניהולה (ללא שינוי)');
  eq(await resolveBranchScope(granted('v1', 'POST')), null,
    'צופה עם הרשאת הפעולה כותבת בכל הסניפים');
  eq(await resolveBranchScope(req('v1', 'POST')), ['b1'],
    'ובלי ההרשאה — רק הסניפים שבניהולה (ללא שינוי)');
  eq(await resolveBranchScope(granted('t1', 'POST')), null,
    'גם גננת שקיבלה את ההרשאה — כל הסניפים');

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
