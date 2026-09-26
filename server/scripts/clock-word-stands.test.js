#!/usr/bin/env node
/**
 * THE CLOCK'S WORD STANDS — the owner's rule (26.09.2026) for self-reports:
 * an employee cannot re-report a side of the day the clock already recorded.
 *
 * The subtlety that made the naive version wrong: TIMEDOX reports direction
 * "unknown" (state 255) for most punches, so "did the clock record an ENTRY"
 * is often unanswerable — the enforceable question is COUNT: a complete
 * (even) clock day accepts no reports; a half day accepts exactly one; and
 * when the clock does know its direction, that side is refused by name.
 * Manager and accounting entries are untouched — correcting the clock is
 * their job.
 *
 * Textual net over the controller — each rule is one edited line from
 * quietly vanishing.
 *
 *   node scripts/clock-word-stands.test.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};

const src = fs.readFileSync(
  path.join(__dirname, '../src/controllers/payroll.controller.js'), 'utf8');

console.log('\n⌚ the clock-stands gate\n');

// Locate the gate block and interrogate it, not the whole file.
const gateStart = src.indexOf("code: 'CLOCK_ALREADY_PUNCHED'");
ok(gateStart !== -1, 'הקוד CLOCK_ALREADY_PUNCHED קיים');
const around = src.slice(Math.max(0, gateStart - 3000), gateStart + 1500);

ok(around.includes('if (opts.selfReport)'),
  'השער חל על דיווח עצמי בלבד — מנהל והנהח"ש מתקנים כרגיל');
ok(around.includes("timestamp_source: { $in: ['device', 'agent_received_at'] }"),
  'נספרות רק החתמות שעון פיזיות');
ok(around.includes('clockPunches.length % 2 === 0'),
  'יום זוגי (שלם) בשעון — שום דיווח לא מתקבל');
ok(around.includes('wanted.length > 1'),
  'שעון עם צד חסר — מותר לדווח בדיוק אחד, לא שניים');
ok(around.includes('s === 0 || s === 1') && around.includes('directional.has(wanted[0].state)'),
  'כשהשעון כן יודע כיוון — הצד הקיים נדחה בשמו');
ok(around.includes('255') || around.includes('unknown'),
  'ההסבר מתעד את מצב 255 — הסיבה שספירה גוברת על כיוון');
ok(around.includes('לפנות למנהל/ת הסניף'),
  'ההודעה מפנה למנהל — הדרך הנכונה לתקן שעת שעון');

console.log('');
if (failures) { console.log(`❌ ${failures} נכשלו`); process.exit(1); }
console.log('✅ הכל עבר');
