#!/usr/bin/env node
/**
 * Returned-but-unflagged payslips in a correction round.
 *
 * The accountant's corrected PDF usually carries the whole branch, not only
 * the flagged employees. "The rest came back unchanged" must be a verified
 * statement: every unflagged payslip is diffed field-by-field against the
 * payslip the original audit parsed. Three verdicts come out of it —
 * unchanged (verified), changed (nobody asked — loud), no_baseline (nothing
 * to compare against).
 *
 *   node scripts/payslip-untouched.test.js
 */

const { diffParsedPayslips, classifyUnflaggedPayslips, attachPriorCompare } =
  require('../src/controllers/payslipAudit.controller');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function slip(over = {}) {
  return {
    employee_id: '012345678',
    employee_name: 'דנה כהן',
    employee_no: 7,
    page_index: 3,
    net_to_pay: 8450.5,
    total_payments: 10200,
    paid_hours: 162,
    base_salary: 7238,
    vacation: { balance: 4.5, used: 1 },
    sick: { used: 0 },
    items: [{ amount: 250, rate: 250 }, { amount: 400, rate: 400 }],
    ...over,
  };
}

console.log('diffParsedPayslips');
{
  const { diffs, compared } = diffParsedPayslips(slip(), slip());
  check('זהים — אין הבדלים', diffs.length === 0);
  check('זהים — שדות הושוו', compared > 0, `compared=${compared}`);
}
{
  const { diffs } = diffParsedPayslips(slip(), slip({ net_to_pay: 9000 }));
  check('נטו השתנה — מדווח', diffs.length === 1 && diffs[0].field === 'net_to_pay');
  check('ההבדל נושא לפני/אחרי', diffs[0].before === 8450.5 && diffs[0].after === 9000);
}
{
  // A field only one side parsed is parser noise, not a change.
  const { diffs } = diffParsedPayslips(slip({ paid_hours: null }), slip());
  check('שדה שפוענח רק בצד אחד לא נחשב שינוי', diffs.length === 0);
}
{
  const { diffs } = diffParsedPayslips(slip(), slip({ items: [{ amount: 250, rate: 250 }] }));
  check('שורת תשלום שנעלמה — מדווחת', diffs.some((d) => d.field === 'items'));
}
{
  // Item order must not matter.
  const { diffs } = diffParsedPayslips(
    slip(),
    slip({ items: [{ amount: 400, rate: 400 }, { amount: 250, rate: 250 }] }));
  check('סדר שורות שונה אינו שינוי', diffs.length === 0);
}
{
  const { diffs } = diffParsedPayslips(slip(), slip({ vacation: { balance: 3.5, used: 1 } }));
  check('יתרת חופשה (שדה מקונן) מושווית', diffs.some((d) => d.field === 'vacation.balance'));
}

console.log('classifyUnflaggedPayslips');
{
  const original = slip();
  const doc = { full_result: { results: [
    { payslip: original, table_row: { employee_name: 'דנה כהן', branch: 'סניף רמות' }, __source_branch: 'סניף רמות' },
  ] } };

  const same = { ...slip(), __round_branch: 'סניף רמות', page_index: 5 };
  let out = classifyUnflaggedPayslips(doc, [same], new Set());
  check('תלוש שחזר זהה — unchanged', out.length === 1 && out[0].verdict === 'unchanged');
  check('נשמר עמוד לתצוגה מהסבב', out[0].page_index === 5 && out[0].round_branch === 'סניף רמות');
  check('נספרו שדות שהושוו', out[0].compared_fields > 0);

  const changed = { ...slip({ net_to_pay: 9999 }), __round_branch: 'סניף רמות' };
  out = classifyUnflaggedPayslips(doc, [changed], new Set());
  check('תלוש שהשתנה בלי שנתבקש — changed', out[0].verdict === 'changed');
  check('ההבדלים מפורטים', out[0].diffs.length === 1 && out[0].diffs[0].label === 'נטו לתשלום');

  const stranger = { ...slip({ employee_id: '099999999', employee_name: 'יוסי לוי' }), __round_branch: 'סניף רמות' };
  out = classifyUnflaggedPayslips(doc, [stranger], new Set());
  check('תלוש בלי מקור — no_baseline', out[0].verdict === 'no_baseline');

  // A flagged employee whose page failed the table match arrives here as an
  // orphan; the round item already reports it as unmatched — skip it.
  out = classifyUnflaggedPayslips(doc, [same], new Set(['id:012345678']));
  check('עובד מסומן שלא זוהה בטבלה לא נכנס לרשימה', out.length === 0);

  // ID missing on the round payslip — matched back to the original by name.
  const byName = { ...slip({ employee_id: null }), __round_branch: 'סניף רמות' };
  out = classifyUnflaggedPayslips(doc, [byName], new Set());
  check('זיהוי לפי שם כשאין ת"ז', out.length === 1 && out[0].verdict === 'unchanged');
}

console.log('attachPriorCompare — re-uploaded month vs its previous check');
{
  const priorDoc = { full_result: { results: [
    { payslip: slip(), table_row: { employee_name: 'דנה כהן' } },
    { payslip: slip({ employee_id: '045678912', employee_name: 'רות אשר', net_to_pay: 7000 }), table_row: { employee_name: 'רות אשר' } },
  ] } };
  const audit = { results: [
    { payslip: slip(), table_row: { employee_name: 'דנה כהן' } },                                  // untouched
    { payslip: slip({ employee_id: '045678912', employee_name: 'רות אשר', net_to_pay: 7555 }), table_row: { employee_name: 'רות אשר' } }, // changed
    { payslip: slip({ employee_id: '011111111', employee_name: 'חדש לגמרי' }), table_row: null },  // no prior
    { payslip: null, table_row: { employee_name: 'חסר תלוש' } },                                    // no payslip — skipped
  ] };
  attachPriorCompare(audit, priorDoc);
  check('תלוש זהה — unchanged', audit.results[0].__prior_compare?.verdict === 'unchanged');
  check('תלוש שהשתנה — changed עם פירוט', audit.results[1].__prior_compare?.verdict === 'changed'
    && audit.results[1].__prior_compare.diffs[0].field === 'net_to_pay');
  check('עובד חדש בחודש — no_baseline', audit.results[2].__prior_compare?.verdict === 'no_baseline');
  check('שורה בלי תלוש לא מוחתמת', audit.results[3].__prior_compare === undefined);
}

console.log('');
if (failures) { console.error(`${failures} בדיקות נכשלו`); process.exit(1); }
console.log('כל הבדיקות עברו');
