#!/usr/bin/env node
/**
 * A decided proposal shows up in "ההחלטות שלי" like any other request the
 * viewer made — same card, same words — and a replay that failed says why.
 *
 *   node scripts/proposed-change-decisions.test.js
 */
const { proposalToDecisionItem } = require('../src/controllers/decisions.controller');

let failures = 0;
const eq = (a, b, label) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${good ? '✅' : '❌'} ${label}${good ? '' : `  (קיבלנו ${JSON.stringify(a)}, ציפינו ${JSON.stringify(b)})`}`);
  if (!good) failures++;
};

console.log('\n🗂️ הצעה כפריט החלטה\n');
const base = {
  _id: 'p1', screen_label: 'עובדים', branch_name: 'תל אביב', decided_at: '2026-09-07T08:00:00.000Z',
  decided_by_name: 'רו"ח', decision_note: '', apply_error: '',
  summary: [{ key: 'full_name', label: 'שם מלא', value: 'דנה' }],
};
eq(proposalToDecisionItem({ ...base, status: 'approved' }), {
  id: 'p1', kind: 'proposed', kind_label: 'שינוי לאישור', title: 'עובדים · תל אביב',
  status: 'approved', status_label: 'אושרה', decided_at: '2026-09-07T08:00:00.000Z',
  decided_by_name: 'רו"ח', note: '',
  lines: [{ label: 'שם מלא', who: '', from: '', to: 'דנה', decision: 'approved' }],
}, 'אושרה');
eq(proposalToDecisionItem({ ...base, status: 'rejected', decision_note: 'לא עכשיו' }).note, 'לא עכשיו', 'נדחתה עם הערה');
eq(proposalToDecisionItem({ ...base, status: 'rejected' }).status_label, 'נדחתה', 'תווית דחייה');
eq(proposalToDecisionItem({ ...base, status: 'failed', apply_error: 'החודש נעול' }).note, 'החודש נעול', 'נכשלה — הסיבה היא ההערה');
eq(proposalToDecisionItem({ ...base, status: 'failed', apply_error: 'x' }).status_label, 'נכשלה', 'תווית כישלון');
eq(proposalToDecisionItem({ ...base, branch_name: '', status: 'approved' }).title, 'עובדים', 'בלי סניף — רק המסך');

console.log(failures ? `\n❌ ${failures} כשלונות\n` : '\n✅ הכל עבר\n');
process.exit(failures ? 1 : 0);
