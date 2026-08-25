#!/usr/bin/env node
/**
 * Which room a member of staff belongs to.
 *
 * The rule reads simply and is easy to get subtly wrong, so this pins the
 * edges rather than the happy path:
 *
 *   - one primary, and a room listed twice is not two rooms
 *   - a גננת cannot be left without a room, a cook can
 *   - an edit that never mentions rooms must not touch the ones on the card,
 *     which is what stops every unrelated save from re-validating (and
 *     refusing) the eighty existing teachers who have no room yet
 *
 * Pure functions, no database.
 *
 *   node scripts/staff-classrooms.test.js
 */

const { planAssignment, positionNeedsClassroom } = require('../src/services/staffClassrooms');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';

const card = (over = {}) => ({
  position: 'גננת', primary_classroom_id: null, extra_classroom_ids: [], ...over,
});

console.log('\n👩‍🏫  מי חייב כיתה ומי לא\n');
{
  for (const p of ['גננת', 'גנן', 'סייעת', 'סייע', 'מטפלת', 'מטפל', 'סייעת בכירה', 'גננת משלימה']) {
    ok(positionNeedsClassroom(p) === true, `${p} — חייב`);
  }
  for (const p of ['מנהלת', 'טבחית', 'מנהלת חשבונות', 'אב בית', '', null]) {
    ok(positionNeedsClassroom(p) === false, `${JSON.stringify(p)} — לא חייב`);
  }
}

console.log('\n🚫  עריכה שלא נגעה בכיתות לא משנה כלום\n');
{
  // The eighty teachers already on file have no room. If an unrelated edit
  // re-validated them, changing a phone number would start failing.
  const res = planAssignment(card(), { phone: '0501234567' });
  ok(res === null, 'שינוי טלפון לא מפעיל את הכלל בכלל');
}

console.log('\n1️⃣  כיתה ראשית אחת, והשאר נוספות\n');
{
  eq(planAssignment(card(), { primary_classroom_id: A, extra_classroom_ids: [B, C] }),
    { primary_classroom_id: A, extra_classroom_ids: [B, C] }, 'ראשית + שתי נוספות');

  eq(planAssignment(card(), { primary_classroom_id: A, extra_classroom_ids: [A, B] }),
    { primary_classroom_id: A, extra_classroom_ids: [B] },
    'כיתה שמופיעה גם כראשית וגם כנוספת נספרת פעם אחת');

  eq(planAssignment(card(), { primary_classroom_id: A, extra_classroom_ids: [B, B] }),
    { primary_classroom_id: A, extra_classroom_ids: [B] }, 'כפילות בנוספות מנוקה');

  eq(planAssignment(card(), { primary_classroom_id: A }),
    { primary_classroom_id: A, extra_classroom_ids: [] },
    'עדכון ראשית בלבד — הנוספות נשארות כפי שהיו (ריקות)');

  const withExtras = card({ primary_classroom_id: A, extra_classroom_ids: [B] });
  eq(planAssignment(withExtras, { primary_classroom_id: C }),
    { primary_classroom_id: C, extra_classroom_ids: [B] },
    'החלפת הכיתה הראשית לא מוחקת את הנוספות');
}

console.log('\n⚠️  מה נדחה\n');
{
  const noPrimary = planAssignment(card(), { primary_classroom_id: null, extra_classroom_ids: [B] });
  ok(/כיתה ראשית/.test(noPrimary?.error || ''), 'כיתות נוספות בלי ראשית נדחות');

  const teacherCleared = planAssignment(card({ primary_classroom_id: A }), { primary_classroom_id: null });
  ok(/חובה/.test(teacherCleared?.error || ''), 'לא ניתן להשאיר גננת בלי כיתה');

  const cook = planAssignment(card({ position: 'טבחית', primary_classroom_id: A }), { primary_classroom_id: null });
  eq(cook, { primary_classroom_id: null, extra_classroom_ids: [] }, 'טבחית כן יכולה להיות בלי כיתה');
}

console.log('\n🔄  שינוי תפקיד באותה שמירה נבדק לפי התפקיד החדש\n');
{
  // A סייעת promoted to מנהלת in the same save must not be refused for having
  // given up her room, and a מנהלת becoming a גננת must be required to take one.
  const promoted = planAssignment(
    card({ position: 'סייעת', primary_classroom_id: A }),
    { primary_classroom_id: null }, { position: 'מנהלת' },
  );
  eq(promoted, { primary_classroom_id: null, extra_classroom_ids: [] }, 'סייעת שהפכה למנהלת משוחררת מהכלל');

  const demoted = planAssignment(
    card({ position: 'מנהלת', primary_classroom_id: null }),
    { primary_classroom_id: null }, { position: 'גננת' },
  );
  ok(/חובה/.test(demoted?.error || ''), 'מנהלת שהפכה לגננת חייבת כיתה');
}

console.log(`\n${failures ? `❌  ${failures} בדיקות נכשלו\n` : '✅  הכל עבר\n'}`);
process.exit(failures ? 1 : 0);
