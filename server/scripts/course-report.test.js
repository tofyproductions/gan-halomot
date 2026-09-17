/**
 * The expired-and-missing report.
 *
 * The document is read by somebody who then picks up a phone, or hands it to
 * an inspector. So what is asserted here is not that it renders — it is that a
 * ת"ז comes out in the order it was typed, that a phone number is dialable,
 * that "no certificate" does not look like a broken link, and that a course
 * type nobody is expected to hold cannot manufacture a page of false
 * shortfalls.
 *
 *   node scripts/course-report.test.js
 */
const assert = require('assert');
const { buildHtml, certificateLink, fmtDate, fmtPhone } = require('../src/services/course-report');
const { latestOfType, REQUIRED_TYPES } = require('../src/controllers/employeeCourses.controller');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${label} — ${e.message}`); }
}

console.log('\nthe cells a person acts on');

check('a date is Hebrew-readable, not ISO', () =>
  assert.strictEqual(fmtDate('2026-07-09T00:00:00.000Z'), '09.07.2026'));
check('no date is a dash, not "Invalid Date"', () => {
  assert.strictEqual(fmtDate(null), '—');
  assert.strictEqual(fmtDate('not a date'), '—');
});
check('a mobile number is grouped for dialing', () =>
  assert.strictEqual(fmtPhone('0501234567'), '050-1234567'));
check('a number stored with punctuation still comes out clean', () =>
  assert.strictEqual(fmtPhone('050-123-4567'), '050-1234567'));
check('no number is a dash', () => assert.strictEqual(fmtPhone(''), '—'));

console.log('\nthe certificate link, which is three different situations');

check('a Drive link opens from the page itself', () => {
  const l = certificateLink({ external_url: 'https://drive.example/x' }, 'https://app.example');
  assert.strictEqual(l.href, 'https://drive.example/x');
});
check('a file in the system points at the screen, not at a link that will 401', () => {
  const l = certificateLink({ has_file: true }, 'https://app.example/');
  assert.strictEqual(l.href, 'https://app.example/courses');
  assert.ok(/שמורה במערכת/.test(l.text));
});
check('nothing at all is a dash with no href — it must not look broken', () => {
  const l = certificateLink({ has_file: false, external_url: '' }, 'https://app.example');
  assert.strictEqual(l.href, '');
  assert.strictEqual(l.text, '—');
});
check('a missing course has no link', () => assert.strictEqual(certificateLink(null, 'x').href, ''));

console.log('\nwhich certificate counts as hers');

const dated = (t, iso) => ({ course_type: t, expires_at: new Date(iso) });
check('of several, the one that lasts longest', () => {
  const c = latestOfType([dated('first_aid', '2025-01-01'), dated('first_aid', '2027-01-01')], 'first_aid');
  assert.strictEqual(c.expires_at.getFullYear(), 2027);
});
check('a course that never expires beats any dated one — she has done it', () => {
  const permanent = { course_type: 'caregiver', expires_at: null };
  const c = latestOfType([dated('caregiver', '2027-01-01'), permanent], 'caregiver');
  assert.strictEqual(c, permanent);
});
check('another type is not hers', () =>
  assert.strictEqual(latestOfType([dated('safe_conduct', '2027-01-01')], 'first_aid'), null));

console.log('\nwhat may be "missing"');

check('the two everyone is expected to hold and renew', () => {
  assert.ok(REQUIRED_TYPES.includes('first_aid'));
  assert.ok(REQUIRED_TYPES.includes('safe_conduct'));
});
check('"אחר" is not a certificate anyone is expected to hold', () =>
  assert.ok(!REQUIRED_TYPES.includes('other')));
// Against the live roster, treating these as required produced 50 and 72
// "חסרות" — a cook is not short of קורס מטפלות מתקדמות. Which positions owe
// them is the gan's rule to state, not one to infer from a roster.
check('the caregiver courses do not manufacture shortfalls', () => {
  assert.ok(!REQUIRED_TYPES.includes('caregiver'));
  assert.ok(!REQUIRED_TYPES.includes('advanced_caregiver'));
});

console.log('\nthe document');

const html = buildHtml({
  title: 'קורסים והכשרות — פג תוקף וחסרים',
  subtitle: 'כפר סבא - משה דיין',
  generatedAt: '17.09.2026',
  appUrl: 'https://app.example',
  sections: [
    {
      key: 'first_aid',
      label: 'עזרה ראשונה (מד"א)',
      rows: [{
        full_name: 'גאליה כהן', israeli_id: '051429389', phone: '0501234567',
        branch_name: 'כפר סבא - משה דיין', status: 'expired',
        course: { expires_at: '2026-07-09', external_url: 'https://drive.example/a', has_file: false },
      }, {
        full_name: 'פלונית <script>', israeli_id: '', phone: '',
        branch_name: '', status: 'missing', course: null,
      }],
    },
    { key: 'safe_conduct', label: 'התנהלות בטוחה', rows: [] },
  ],
});

check('a ת"ז is marked left-to-right so it does not print backwards', () => {
  const cell = html.match(/<td class="ltr">051429389<\/td>/);
  assert.ok(cell, 'the id cell is not marked ltr');
});
check('the phone is grouped and also ltr', () =>
  assert.ok(html.includes('<td class="ltr">050-1234567</td>'), 'phone cell missing'));
check('a name containing markup cannot become markup', () => {
  assert.ok(!html.includes('<script>'), 'unescaped name');
  assert.ok(html.includes('&lt;script&gt;'), 'name not escaped');
});
check('each course type is its own page', () => {
  assert.strictEqual((html.match(/class="type"/g) || []).length, 2);
  assert.ok(html.includes('page-break-after: always'));
});
check('a type with nobody short says so rather than printing an empty table', () => {
  assert.ok(html.includes('אין חוסרים בקורס זה'));
});
check('the count in the heading is the number of rows', () =>
  assert.ok(html.includes('2 עובדות'), 'heading count wrong'));
check('expired and missing read differently', () => {
  assert.ok(html.includes('פג תוקף'));
  assert.ok(html.includes('אין תעודה'));
});
check('the document declares Hebrew and right-to-left', () => {
  assert.ok(html.includes('lang="he"'));
  assert.ok(html.includes('dir="rtl"'));
});

console.log(failures === 0 ? '\nOK\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
