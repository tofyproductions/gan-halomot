#!/usr/bin/env node
/**
 * One click, two stages, and a punch that quietly left the screen unpaid.
 *
 * A manual punch an employee reports starts at `pending_manager`. The branch
 * manager's approval does not pay it — it moves it to `pending_accountant`,
 * where the accountant has to approve it a second time. The banner in the
 * attendance screen deleted the row as soon as the PATCH resolved, without
 * reading the answer, and said "אושר". Somebody holding both authorities, which
 * is every accountant and every admin, therefore saw a punch confirmed, gone
 * from the list, and NOT in the salary — with no way back to it short of
 * reloading the page.
 *
 * These are the rules the list now follows. A row leaves only when the punch
 * the SERVER sent back has stopped being pending.
 *
 * The helper is client code with no imports of its own, so it is loaded here by
 * stripping the `export` keyword — the real file, not a copy, because a copy
 * would agree with itself forever.
 *
 *   node scripts/punch-approval-stage.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../client/src/components/attendance/punchApproval.js');
const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '');
const sandbox = { module: {}, exports: {}, console, Date, Array, String, Boolean, Object };
vm.createContext(sandbox);
vm.runInContext(
  `${code}\n;module.exports = { isPending, stageOf, applyDecision, approvalMessage, rejectionMessage, manualSource, formatManualBy };`,
  sandbox,
);
const {
  isPending, stageOf, applyDecision, approvalMessage, rejectionMessage, manualSource, formatManualBy,
} = sandbox.module.exports;

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = a === b;
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/** A row as the pending list holds it: populated employee, populated creator. */
const row = (over = {}) => ({
  _id: 'p1',
  approval_status: 'pending_manager',
  state: 0,
  timestamp: '2026-08-12T04:45:00.000Z',
  employee_id: { _id: 'e1', full_name: 'שרון ודש', israeli_id: '123456789', user_id: 'u-sharon' },
  created_by: { _id: 'u-sharon', full_name: 'שרון ודש', role: 'assistant' },
  ...over,
});

/** What the PATCH answers with: a raw punch, nothing populated. */
const serverPunch = (over = {}) => ({
  _id: 'p1',
  approval_status: 'pending_accountant',
  employee_id: 'e1',
  created_by: 'u-sharon',
  ...over,
});

console.log('\n🕐 אישור החתמה ידנית — שתי מדרגות\n');

console.log('הבאג: אישור מנהל/ת אינו כניסה לשכר');
{
  const list = [row()];
  const after = applyDecision(list, 'p1', serverPunch({ approval_status: 'pending_accountant' }));
  eq(after.length, 1, 'ההחתמה נשארת ברשימה — היא עברה למדרגה השנייה, לא לשכר');
  eq(stageOf(after[0]), 'accountant', 'ובמדרגה הנכונה: ממתינה להנהלת החשבונות');
  eq(approvalMessage(serverPunch({ approval_status: 'pending_accountant' })),
    'אושר — ממתין כעת לאישור הנהלת החשבונות',
    'וההודעה אומרת את האמת, במקום "אושר" סתם');
}

console.log('\nאישור סופי — ורק הוא — מסיר מהרשימה');
{
  const after = applyDecision([row()], 'p1', serverPunch({ approval_status: 'approved' }));
  eq(after.length, 0, 'approved — יצאה מהרשימה, היא בשכר');
  eq(approvalMessage(serverPunch({ approval_status: 'approved' })), 'אושר — נכנס לשכר',
    'ההודעה אומרת שזה נגמר');
}

console.log('\nדחייה');
{
  const after = applyDecision([row()], 'p1', serverPunch({ approval_status: 'rejected' }));
  eq(after.length, 0, 'rejected — יצאה מהרשימה');
  eq(rejectionMessage({ approval_status: 'rejected' }), 'נדחה', 'דחייה רגילה');
}

console.log('\nתיקון שהוחנה על החתמה שכבר נספרת');
{
  const parked = row({
    _id: 'p2',
    approval_status: 'auto',
    pending_edit: { timestamp: '2026-08-12T05:00:00.000Z', prev_status: 'auto' },
  });
  ok(isPending(parked), 'החתמה במצב auto עם תיקון ממתין — עדיין פתוחה');
  eq(stageOf(parked), 'accountant', 'ומחכה להנהלת החשבונות');

  // The server clears pending_edit and answers with the punch as it now is.
  const after = applyDecision([parked], 'p2', { _id: 'p2', approval_status: 'auto' });
  eq(after.length, 0, 'אחרי החלטה — יצאה מהרשימה, למרות שהסטטוס עצמו לא השתנה');
  eq(rejectionMessage({ approval_status: 'auto' }),
    'הבקשה נדחתה — ההחתמה המקורית נשארה כפי שהייתה',
    'דחיית תיקון אינה מוחקת יום עבודה אמיתי');
}

console.log('\nמה שהשרת מחזיר לא הורס את מה שכבר על המסך');
{
  const after = applyDecision([row()], 'p1', serverPunch());
  eq(after[0].employee_id.full_name, 'שרון ודש', 'שם העובדת נשמר — לא הוחלף במזהה גולמי');
  eq(after[0].created_by.role, 'assistant', 'וגם המזין, כדי שצ׳יפ המקור לא ייעלם');
}

console.log('\nתשובה ריקה מהשרת — לא מנחשים');
{
  const after = applyDecision([row()], 'p1', null);
  eq(after.length, 1, 'הרשימה נשארת כמות שהיא; הרכיב טוען מחדש במקום להמציא');
}

console.log('\nשורות אחרות לא נוגעים בהן');
{
  const after = applyDecision([row(), row({ _id: 'p9' })], 'p1', serverPunch({ approval_status: 'approved' }));
  eq(after.length, 1, 'רק המאושרת יצאה');
  eq(after[0]._id, 'p9', 'והשנייה נשארה');
}

console.log('\n👤 מקור העדכון הידני\n');

console.log('מי הזין');
{
  const emp = { _id: 'e1', user_id: 'u-sharon' };
  eq(manualSource(row(), emp).label, 'דיווח עצמי',
    'העובדת דיווחה על עצמה — created_by זהה למשתמש שלה');

  const byManager = row({ created_by: { _id: 'u-lidor', full_name: 'לידור כהן', role: 'branch_manager' } });
  eq(manualSource(byManager, emp).label, 'לידור כהן · מנהל/ת סניף', 'מנהלת סניף — שם ותפקיד');

  const byAccountant = row({ created_by: { _id: 'u-acc', full_name: 'רונית', role: 'accountant' } });
  eq(manualSource(byAccountant, emp).label, 'רונית · הנהלת חשבונות', 'הנהלת חשבונות');
}

console.log('\nהחתמות ישנות — לא מנחשים');
{
  eq(manualSource(row({ created_by: null }), { user_id: 'u-sharon' }).label, 'לא ידוע',
    'נוצרה לפני שהשדה קיים — "לא ידוע", ולא ייחוס להנה״ח');
  eq(manualSource(row({ created_by: 'u-lidor' }), { user_id: 'u-sharon' }).label, 'לא ידוע',
    'מזהה בלי populate — אין שם להציג, ולא ממציאים');
  eq(manualSource(row({ created_by: 'u-sharon' }), { user_id: 'u-sharon' }).label, 'דיווח עצמי',
    'אבל מזהה שמתאים לעובדת עדיין מזוהה כדיווח עצמי');
  eq(manualSource(row(), { user_id: null }).label, 'שרון ודש · סייעת',
    'עובדת בלי משתמש מקושר — לא ניתן לקבוע דיווח עצמי, אז מוצג מי שהזין');
}

console.log('\nאותו משפט בטבלת ההחתמות');
{
  eq(formatManualBy({ name: 'שרון ודש', role: 'assistant', self: true }), 'דיווח עצמי · שרון ודש',
    'דיווח עצמי בטבלה');
  eq(formatManualBy({ name: 'לידור כהן', role: 'branch_manager', self: false }), 'לידור כהן · מנהל/ת סניף',
    'מנהלת סניף בטבלה');
  eq(formatManualBy(null), 'לא ידוע', 'ובלי מידע — "לא ידוע", לא "עודכן ידנית ע״י הנה״ח"');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} כשלונות`}\n`);
process.exit(failures === 0 ? 0 : 1);
