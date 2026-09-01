#!/usr/bin/env node
/**
 * Physical offsets on a badge, in an app that mirrors its own CSS.
 *
 * The client's emotion cache runs stylis-plugin-rtl, so a `right` written in an
 * `sx` block is rewritten to `left` before the browser ever sees it. MUI's own
 * badge anchor is mirrored by that same plugin. A hand-written `right: -14`
 * therefore did not correct the mirroring — it pushed the badge a second time in
 * the direction it had already moved, and the count for "בקשות שינוי" ended up
 * floating in the gap between two tabs.
 *
 * The mistake is invisible in review: the rule reads like it moves the badge
 * right, and it does exactly the opposite. So it is checked here rather than
 * remembered. A badge offset must be either laid out in the flow, or expressed
 * with a logical property (`insetInlineStart` / `insetInlineEnd`), which the
 * plugin leaves alone because it already follows the text direction.
 *
 *   node scripts/rtl-badge-position.test.js
 */

const fs = require('fs');
const path = require('path');

const CLIENT_SRC = path.join(__dirname, '../../client/src');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = walk(CLIENT_SRC);

console.log('\n🎯 מיקום באדג׳ים בפריסת RTL\n');

console.log('אין היסטים פיזיים על באדג׳ים');
{
  // The whole `sx` object attached to a MuiBadge-badge override, however it is
  // wrapped across lines.
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let i = src.indexOf('MuiBadge-badge');
    while (i !== -1) {
      // The declaration block that follows the selector, up to its closing brace.
      const open = src.indexOf('{', i);
      const block = open === -1 ? '' : src.slice(open, open + 400);
      const end = block.indexOf('}');
      const decls = end === -1 ? block : block.slice(0, end);
      const bad = decls.match(/\b(right|left)\s*:/g);
      if (bad) {
        const line = src.slice(0, i).split('\n').length;
        offenders.push(`${path.relative(CLIENT_SRC, f)}:${line} → ${bad.join(', ')}`);
      }
      i = src.indexOf('MuiBadge-badge', i + 1);
    }
  }
  ok(offenders.length === 0,
    offenders.length === 0
      ? 'אף באדג׳ לא ממוקם עם right/left — התוסף היה הופך אותם'
      : `נמצאו היסטים פיזיים: ${offenders.join(' | ')}`);
}

console.log('\nהבאדג׳ של "בקשות שינוי" יושב בתוך תיבת התווית');
{
  const src = fs.readFileSync(path.join(CLIENT_SRC, 'components/payroll/PayrollPage.jsx'), 'utf8');
  ok(/position:\s*'static'/.test(src), 'position: static — לא נתלש מהתווית');
  ok(/transform:\s*'none'/.test(src), 'transform: none — לא מורם מעל גבול הגלילה שחותך');
  ok(/marginInlineStart/.test(src), 'ההיסט לוגי, כך שהוא נכון בשתי הפריסות');
  // Comments stripped first: the block above this fix quotes the old `right: -14`
  // to explain it, and a test that reads prose would fail on its own explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/right:\s*-?\d/.test(code), 'ולא נשאר שום היסט פיזי בקוד עצמו');
}

console.log('\nשורת הטאבים נשארה כפי שהייתה');
{
  const src = fs.readFileSync(path.join(CLIENT_SRC, 'components/payroll/PayrollPage.jsx'), 'utf8');
  ok(/variant="scrollable"/.test(src), 'הגלילה האופקית לא בוטלה');
  ok(/scrollButtons="auto"/.test(src), 'כפתורי הגלילה נשארו');
  ok(/dir="rtl"/.test(src), 'כיוון הפריסה נשאר rtl');
  ok(/value=\{tab\}/.test(src) && /onChange=\{handleChange\}/.test(src),
    'בחירת הטאב הפעיל לא נגעה');
}

console.log(`\n${failures === 0 ? '✅ הכל עבר' : `❌ ${failures} כשלונות`}\n`);
process.exit(failures === 0 ? 0 : 1);
