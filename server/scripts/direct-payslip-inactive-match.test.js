#!/usr/bin/env node
/**
 * Direct distribution matches former employees too.
 *
 * The one page this screen exists for is the final payslip of someone who was
 * missed — and the second most common shape of that is someone whose
 * employment ENDED this month. By the time her corrected payslip is uploaded
 * she is already archived (is_active: false), and a match pool of active
 * employees only reads her page as "לא זוהה עובד" with no way to assign her,
 * because the picker was active-only as well.
 *
 * So the pool is everyone, with one rule: when a ת"ז or a name fits several
 * records, the active record wins. Only a tie that survives that preference
 * is ambiguous, and ambiguity still refuses to guess — a wrong guess here
 * mails one person's salary to another.
 *
 *   node scripts/direct-payslip-inactive-match.test.js
 */

const { matchPage } = require('../src/controllers/directPayslips.controller');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const emp = (over) => ({
  _id: over.full_name, full_name: '', israeli_id: '', clock_aliases: [], is_active: true, ...over,
});

console.log('ת"ז match reaches archived employees');
{
  const gone = emp({ full_name: 'מור אונלי', israeli_id: '203953781', is_active: false });
  const { emp: hit, basis } = matchPage({ employee_id: '203953781', employee_name: 'מור אונלי' }, [
    emp({ full_name: 'אחרת לגמרי', israeli_id: '012345678' }),
    gone,
  ]);
  check('THE BUG: an employee who left this month is still found by ת"ז', hit === gone);
  check('and the basis is still the identity, not the name', basis === 'israeli_id');
}

console.log('\nactive record wins a tie (rehire left an archived twin)');
{
  const old = emp({ full_name: 'רחל כהן', israeli_id: '012345678', is_active: false });
  const cur = emp({ full_name: 'רחל כהן', israeli_id: '012345678', is_active: true });
  const byId = matchPage({ employee_id: '012345678', employee_name: '' }, [old, cur]);
  check('same ת"ז twice: the active record is the match', byId.emp === cur);

  const byName = matchPage({ employee_id: '', employee_name: 'רחל כהן' }, [old, cur]);
  check('same name twice: the active record is the match', byName.emp === cur);
}

console.log('\nambiguity still refuses to guess');
{
  const a = emp({ full_name: 'דנה לוי', israeli_id: '111111118', is_active: false });
  const b = emp({ full_name: 'דנה לוי', israeli_id: '222222226', is_active: false });
  const r = matchPage({ employee_id: '', employee_name: 'דנה לוי' }, [a, b]);
  check('two archived employees sharing a name match no one', r.emp === null);
}

console.log('\na unique former employee is reachable by name too');
{
  const gone = emp({ full_name: 'שרה אברהם', israeli_id: '', is_active: false });
  const r = matchPage({ employee_id: '', employee_name: 'שרה אברהם' }, [
    emp({ full_name: 'מישהי אחרת', israeli_id: '333333334' }),
    gone,
  ]);
  check('name on the payslip finds the archived record when it is the only carrier', r.emp === gone);
  check('basis says name, so the row shows how thin the match is', r.basis === 'name');
}

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
