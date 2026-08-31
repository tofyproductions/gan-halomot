#!/usr/bin/env node
/**
 * "What did they decide about what I asked for?"
 *
 * A branch manager cannot write payroll, employee cards or pay rates — each is
 * a request somebody else approves, in a different collection, on a different
 * screen. Nothing told her the answer, so she learned it from the payslip.
 *
 * The rule the popup and the screen share, checked here without a database:
 * ONE timestamp on the reader decides what is new, the popup shows only that,
 * and closing it stamps the newest item SHE WAS SHOWN — never `now`, or a
 * decision arriving while she reads is marked read having never appeared.
 *
 *   node scripts/my-decisions.test.js
 */

const { showValue } = require('../src/controllers/decisions.controller');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

/** The server's rule: an item is new when it was decided after the last look. */
const markUnseen = (items, seenAt) => items.map(i => ({
  ...i,
  unseen: !seenAt || (i.decided_at && new Date(i.decided_at) > new Date(seenAt)),
}));

/** The popup's rule: stamp the newest item that was ACTUALLY ON SCREEN. */
const stampFrom = (shown) => new Date(shown.reduce((max, i) => {
  const t = new Date(i.decided_at || 0).getTime();
  return t > max ? t : max;
}, 0)).toISOString();

const at = (s) => new Date(s).toISOString();
const item = (id, when) => ({ id, decided_at: at(when) });

console.log('\n🔔 החלטות על הבקשות שלי\n');

console.log('מה חדש');
{
  const items = [item('a', '2026-08-31T10:00:00Z'), item('b', '2026-08-30T10:00:00Z')];
  eq(markUnseen(items, null).map(i => i.unseen), [true, true],
    'מי שמעולם לא הסתכל — הכל חדש');
  eq(markUnseen(items, at('2026-08-30T12:00:00Z')).map(i => i.unseen), [true, false],
    'אחרי שהסתכל — רק מה שהוחלט מאז');
  eq(markUnseen(items, at('2026-09-01T00:00:00Z')).map(i => i.unseen), [false, false],
    'ואחרי הכל — כלום');
}

console.log('\nסגירת הפופ-אפ');
{
  const items = [item('a', '2026-08-31T10:00:00Z'), item('b', '2026-08-30T10:00:00Z')];
  const shown = markUnseen(items, null).filter(i => i.unseen);
  const stamp = stampFrom(shown);
  eq(stamp, at('2026-08-31T10:00:00Z'), 'הסימון נלקח מהפריט החדש ביותר שהוצג');

  const after = markUnseen(items, stamp);
  eq(after.map(i => i.unseen), [false, false], 'ואחרי הסגירה שתיהן כבר לא חדשות');
  ok(after.length === 2, 'אבל שתיהן עדיין ברשימה — המסך ממשיך להראות אותן');
}

console.log('\nהחלטה שנחתה בזמן שהיא קוראת');
{
  const shown = [item('a', '2026-08-31T10:00:00Z')];
  const stamp = stampFrom(shown);
  // Arrived after the popup rendered. Stamping `now` on close would have
  // buried it without it ever being on screen.
  const all = [item('c', '2026-08-31T10:05:00Z'), ...shown];
  const after = markUnseen(all, stamp);
  eq(after.map(i => [i.id, i.unseen]), [['c', true], ['a', false]],
    'מה שהגיע אחרי הרינדור נשאר חדש');
}

console.log('\nסדר');
{
  const items = [item('old', '2026-08-01T00:00:00Z'), { id: 'none', decided_at: null }, item('new', '2026-08-31T00:00:00Z')];
  const sorted = [...items].sort((a, b) => (
    new Date(b.decided_at || 0).getTime() - new Date(a.decided_at || 0).getTime()
  ));
  eq(sorted.map(i => i.id), ['new', 'old', 'none'],
    'החדש למעלה, ורשומה בלי תאריך בסוף ולא בהתחלה');
}

console.log('\nהצגת ערכים');
{
  eq(showValue(null), '—', 'ריק נראה כמו ריק ולא כמו null');
  eq(showValue(undefined), '—', 'וגם חסר');
  eq(showValue(''), '—', 'ומחרוזת ריקה');
  eq(showValue(0), '0', 'אבל אפס הוא ערך — הוא לא "לא מילאו"');
  eq(showValue(false), 'לא', 'ובוליאני בעברית');
  eq(showValue(true), 'כן', '');
  eq(showValue(1200), '1200', 'ומספר כמו שהוא');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} נכשלו`}\n`);
process.exit(failures === 0 ? 0 : 1);
