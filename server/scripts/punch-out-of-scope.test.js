#!/usr/bin/env node
/**
 * "May this request change THIS punch?" — the two-sided rule, on its own.
 *
 * editPunch, approvePunch, rejectPunch and deletePunch all hang their refusal
 * on payroll.controller#punchOutOfScope, and under the viewer's branch_manager
 * fallback its 403 is what becomes a proposal. So the predicate decides both
 * who may edit an hour of somebody's pay AND what quietly turns into an
 * approval request — and until now nothing tested it.
 *
 * The rule has two sides because one is not enough: a punch that was filed
 * before the guard existed (or by an admin) can name a branch the employee
 * never worked at, and a manager of that branch would otherwise be editing
 * another branch's employee's hours. Both the punch's branch and the
 * employee's branches must meet the caller's scope.
 *
 *   node scripts/punch-out-of-scope.test.js
 */

/* Nothing may read server/.env — stub dotenv before config/env loads it. */
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true, children: [], paths: [],
  exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
};

const Module = require('module');

// ---------- the two things the predicate reaches for ----------
let scope = null;              // what resolveBranchScope answers
let employees = {};            // the Employee rows findById can return

const Employee = {
  findById: (id) => ({ select: () => ({ lean: async () => employees[String(id)] || null }) }),
};

const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  const from = parent && parent.filename ? parent.filename : '';
  if (from.endsWith('controllers/payroll.controller.js')) {
    if (request === '../models') {
      // Everything else the controller destructures stays real; only the one
      // model this predicate reads is faked.
      return { ...realLoad.call(this, request, parent, ...rest), Employee };
    }
    if (request === '../utils/branch-scope') {
      return {
        ...realLoad.call(this, request, parent, ...rest),
        resolveBranchScope: async () => scope,
      };
    }
  }
  return realLoad.call(this, request, parent, ...rest);
};

const { punchOutOfScope } = require('../src/controllers/payroll.controller');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const BRANCH_DENIED = 'ההחתמה שייכת לסניף שאינו בניהולך';
const EMPLOYEE_DENIED = 'ההחתמה שייכת לעובד/ת בסניף שאינו בניהולך';

const req = { user: { id: 'u1', role: 'branch_manager', managed_branch_ids: ['bA'] } };
const punch = (branch, employee = 'e1') => ({ _id: 'p1', branch_id: branch, employee_id: employee });

(async () => {
  console.log('\n🕐 החתמה מחוץ לסניפי הניהול\n');

  console.log('מנהלת מערכת / הנה"ח — אין תחום כלל');
  {
    scope = null;
    employees = {};
    eq(await punchOutOfScope(req, punch('bZ', 'e-nobody')), null,
      'תחום null — כל החתמה מותרת, בלי קריאה נוספת למסד');
  }

  console.log('\nהסניף של ההחתמה');
  {
    scope = ['bA'];
    employees = { e1: { _id: 'e1', branch_id: 'bA' } };
    eq(await punchOutOfScope(req, punch('bB')), BRANCH_DENIED,
      'החתמה בסניף שאינו בניהול — נדחית');
    eq(await punchOutOfScope(req, punch('bA')), null,
      'החתמה בסניף שבניהול, לעובדת של אותו סניף — עוברת');
  }

  console.log('\nהסניף של העובדת — הצד השני של אותו כלל');
  {
    scope = ['bA'];
    // The punch says בA. The employee has never worked there — this is the
    // row the branch-only check used to let through.
    employees = { e1: { _id: 'e1', branch_id: 'bB' } };
    eq(await punchOutOfScope(req, punch('bA')), EMPLOYEE_DENIED,
      'הסניף בתחום אבל העובדת אינה — נדחית');
  }
  {
    scope = ['bA'];
    // A genuine multi-branch worker: her card lives in בB, she is also paid
    // at בA. The manager of בA may sign her in — for בA.
    employees = { e1: { _id: 'e1', branch_id: 'bB', branch_rates: [{ branch_id: 'bA', hourly_rate: 55 }] } };
    eq(await punchOutOfScope(req, punch('bA')), null,
      'עובדת דו-סניפית (branch_rates) — עוברת');
  }
  {
    scope = ['bA'];
    employees = { e1: { _id: 'e1', branch_id: 'bB', hourly_bonuses: [{ branch_id: 'bA', amount: 3 }] } };
    eq(await punchOutOfScope(req, punch('bA')), null,
      'גם תוספת שעתית בסניף סופרת כשיוך');
  }

  console.log('\nשורת עובדת שנמחקה');
  {
    scope = ['bA'];
    employees = {};
    eq(await punchOutOfScope(req, punch('bA', 'e-gone')), null,
      'העובדת אינה במסד — ההחתמה נשפטת לפי הסניף בלבד, ולא נדחית על לא כלום');
    eq(await punchOutOfScope(req, punch('bB', 'e-gone')), BRANCH_DENIED,
      'ועדיין נדחית כשהסניף עצמו מחוץ לתחום');
  }
  {
    scope = ['bA'];
    employees = {};
    eq(await punchOutOfScope(req, { _id: 'p1', branch_id: 'bA', employee_id: null }), null,
      'החתמה בלי עובדת כלל — אותו דין');
  }

  console.log('\nכמה סניפים בתחום');
  {
    scope = ['bA', 'bB'];
    employees = { e1: { _id: 'e1', branch_id: 'bB' } };
    eq(await punchOutOfScope(req, punch('bB')), null, 'שני סניפים בניהול — שניהם עוברים');
    eq(await punchOutOfScope(req, punch('bC')), BRANCH_DENIED, 'ושלישי לא');
  }

  console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
  process.exit(failures ? 1 : 0);
})();
