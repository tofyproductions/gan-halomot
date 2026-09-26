#!/usr/bin/env node
/**
 * The morning punch-issues digest — what it promises:
 *   1. runs once per Israel day, only after 07:00, never on Shabbat;
 *   2. groups issues per branch and pushes ONE event per manager, plus one
 *      office summary to admins+accountants;
 *   3. every event is closed right after creation — the hourly resend loop
 *      must never nag a digest;
 *   4. a clean network pushes nothing.
 *
 * Models, the notification service and the issues engine are stubbed via
 * Module._load (the repo's pattern), so this runs without a database.
 *
 *   node scripts/punch-digest.test.js
 */
const Module = require('module');

// ── stubs ───────────────────────────────────────────────────────────────────
const state = {
  markerValue: null,
  created: [],       // createEvent calls
  resolved: [],      // NotificationEvent.updateMany calls
  issues: { duplicates: [], missing: [] },
  conflicts: [],
};

const stubs = {
  '../models': {
    Setting: {
      findOne: () => ({ lean: async () => (state.markerValue ? { value: state.markerValue } : null) }),
      updateOne: async (_f, u) => { state.markerValue = u.$set.value; },
    },
    Branch: { find: () => ({ select: () => ({ lean: async () => [
      { _id: 'b1', name: 'כפר סבא' }, { _id: 'b2', name: 'הרצליה' },
    ] }) }) },
    User: { find: () => ({ select: () => ({ lean: async () => [{ _id: 'admin1' }] }) }) },
    NotificationEvent: {
      updateMany: async (filter) => { state.resolved.push(filter); },
    },
  },
  './notification.service': {
    createEvent: async (e) => { state.created.push(e); },
    branchManagerIds: async (branchId) => (branchId === 'b1' ? ['mgr1'] : ['mgr2a', 'mgr2b']),
    accountantIds: async () => ['acct1'],
  },
  '../controllers/payrollMonth.controller': {
    punchIssues: async () => state.issues,
    fixedScheduleConflicts: async () => state.conflicts,
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename.endsWith('services/punchIssuesDigest.js') && stubs[request]) {
    return stubs[request];
  }
  return realLoad.call(this, request, parent, ...rest);
};

// mongoose is loaded for ObjectId — give tick string-safe ids.
const mongoose = require('mongoose');
const realOID = mongoose.Types.ObjectId;
mongoose.Types.ObjectId = function (v) { return String(v); };

const digest = require('../src/services/punchIssuesDigest');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

// Freeze "now" per case by stubbing the Intl-based helpers through Date.
function withNow(iso, fn) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(iso); }
    static now() { return new RealDate(iso).getTime(); }
  };
  return Promise.resolve(fn()).finally(() => { global.Date = RealDate; });
}

(async () => {
  console.log('\n⏰ the time gate\n');

  let r = await withNow('2026-09-26T09:00:00+03:00', () => digest.tick()); // Saturday
  ok(r.ran === false && r.why === 'shabbat', 'שבת — לא רץ');

  r = await withNow('2026-09-27T05:30:00+03:00', () => digest.tick()); // Sunday, early
  ok(r.ran === false && r.why === 'early', 'לפני 07:00 — לא רץ');

  console.log('\n📬 a dirty network pushes once, grouped\n');
  state.issues = {
    missing: [{ branch_id: 'b1' }, { branch_id: 'b1' }, { branch_id: 'b2' }],
    duplicates: [{ branch_id: 'b2' }],
  };
  state.conflicts = [{ branch_id: 'b1' }];
  r = await withNow('2026-09-27T07:30:00+03:00', () => digest.tick());
  ok(r.ran === true && r.branches === 2, 'רץ על 2 סניפים');
  ok(r.managerPushes === 3, 'שלושה פושים למנהלים (1 + 2 מנהלות בהרצליה)');
  const mgrEvent = state.created.find(e => e.type === 'punch_issues_digest' && e.recipient_id === 'mgr1');
  ok(!!mgrEvent && mgrEvent.body.includes('2 החתמות חסרות') && mgrEvent.body.includes('1 קונפליקטים'),
    'הגוף מונה את הבעיות של הסניף בלבד');
  ok(mgrEvent.url === '/attendance?issues=1', 'הקישור פותח את מסך הטיפול');
  const office = state.created.filter(e => e.type === 'punch_issues_digest_office');
  ok(office.length === 2, 'סיכום רשת לאדמין ולהנהח"ש');
  ok(state.resolved.length === state.created.length, 'כל אירוע נסגר מיד — אין נדנוד שעתי');

  console.log('\n🔁 once per day\n');
  const before = state.created.length;
  r = await withNow('2026-09-27T09:00:00+03:00', () => digest.tick());
  ok(r.ran === false && r.why === 'already-ran', 'ריצה שנייה באותו יום — מדלגת');
  ok(state.created.length === before, 'ולא נוצר שום פוש נוסף');

  console.log('\n🧹 a clean network is silent\n');
  state.markerValue = null;
  state.issues = { missing: [], duplicates: [] };
  state.conflicts = [];
  state.created.length = 0;
  r = await withNow('2026-09-28T08:00:00+03:00', () => digest.tick());
  ok(r.ran === true && r.branches === 0 && state.created.length === 0, 'אין בעיות — אין פוש');

  mongoose.Types.ObjectId = realOID;
  console.log('');
  if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
  console.log('✅ הכל עבר');
})();
