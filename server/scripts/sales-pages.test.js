#!/usr/bin/env node
/**
 * The public sales pages — and specifically, that the one on the internet is
 * the one without the speaker notes.
 *
 *   node scripts/sales-pages.test.js
 *
 * /pitch is a link sent to a gan owner in a WhatsApp message. pitch.html, the
 * copy presented from, carries notes on which objection is coming, on not
 * lowering the price, and on the fact that whoever speaks first after the price
 * question loses. They are hidden behind a CSS class and a keypress — enough to
 * keep them off the wall behind the presenter, nothing at all against a reader
 * holding the page.
 *
 * So the failure this guards is one character wide: routing 'pitch.html' where
 * 'pitch-share.html' belongs publishes the sales playbook to the person it was
 * written about, and the page looks completely normal while it does.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SALES = path.join(ROOT, 'sales');
const INDEX = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

console.log('\n🔗  הנתיבים הציבוריים\n');
{
  ok(/app\.get\('\/pitch',\s*sales\('pitch-share\.html'\)\)/.test(INDEX),
    'הנתיב /pitch מגיש את הגרסה ללא הערות המנחה');
  ok(!/app\.get\('\/pitch',\s*sales\('pitch\.html'\)\)/.test(INDEX),
    'ולא את המצגת שמציגים ממנה');
  ok(/app\.get\('\/spec',\s*sales\('spec\.html'\)\)/.test(INDEX),
    'הנתיב /spec מגיש את מסמך האפיון');
}

console.log('\n🤫  מה שאסור שיהיה בקובץ הציבורי\n');
{
  const share = fs.readFileSync(path.join(SALES, 'pitch-share.html'), 'utf8');

  // Removed from the markup, not hidden harder. A hidden element is still in
  // the file, and "view source" is one menu item.
  for (const marker of ['class="notes"', 'ntoggle', 'notes-on']) {
    ok(!share.includes(marker), `אין "${marker}"`);
  }

  // A phrase from the notes themselves. If the build ever stops removing the
  // blocks, the markers above might still pass while the words survive.
  ok(!share.includes('אל תתגונן'), 'אין ציטוטים מהערות המנחה');
  ok(!/הערות \(N\)/.test(share), 'אין כפתור הצגת הערות');
}

console.log('\n📑  ושהקובץ הציבורי הוא בכל זאת המצגת\n');
{
  const pitch = fs.readFileSync(path.join(SALES, 'pitch.html'), 'utf8');
  const share = fs.readFileSync(path.join(SALES, 'pitch-share.html'), 'utf8');
  const count = (s) => (s.match(/<section class="slide/g) || []).length;

  ok(count(share) === count(pitch),
    `אותו מספר שקופיות בשתי הגרסאות (${count(share)})`);
  ok(count(share) > 0, 'ויש בה שקופיות בכלל');

  // The presenting copy is the source. If it lost its notes, somebody edited
  // the wrong file and the presenter is about to walk in without them.
  ok(pitch.includes('class="notes"'), 'המצגת שמציגים ממנה עדיין נושאת הערות');

  // Drift check: the share copy is generated, so a change to the deck that was
  // never rebuilt leaves the sent link showing last week's deck.
  const stale = fs.statSync(path.join(SALES, 'pitch.html')).mtimeMs
              > fs.statSync(path.join(SALES, 'pitch-share.html')).mtimeMs;
  ok(!stale, 'גרסת השליחה עודכנה אחרי המצגת (אחרת: node sales/build-share.js)');
}

console.log(failures === 0 ? '\n✅  הכל עבר\n' : `\n❌  ${failures} בדיקות נכשלו\n`);
process.exit(failures === 0 ? 0 : 1);
