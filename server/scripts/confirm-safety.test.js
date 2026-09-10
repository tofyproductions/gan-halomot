#!/usr/bin/env node
/**
 * A destructive confirm must never be skippable.
 *
 * Five call sites paired `danger: true` with `remember_key`, one of them on
 * "מחיקת החתמה — לא ניתן לשחזר". A single accidental tick on "אל תשאל שוב"
 * removed the last guard on an irreversible action for that browser, forever,
 * and the function that clears the flag was reachable from nowhere in the app.
 *
 * ConfirmProvider now ignores the pairing at runtime. This is the other half:
 * the pairing should not be WRITTEN, because a call site that asks to be
 * skippable and silently isn't will confuse the next person to read it.
 *
 *   node scripts/confirm-safety.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  console.log('=== בטיחות אישורי פעולה ===\n');

  const files = walk(SRC).filter((f) => !f.endsWith('ConfirmProvider.jsx'));

  /**
   * Matched inside one confirm({...}) call rather than per line: several call
   * sites put the whole options object on one line and others break it over
   * four, and a per-line check would miss every one of the second kind.
   */
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/confirm\(\s*\{([\s\S]{0,600}?)\}\s*\)/g)) {
      const body = m[1];
      if (/\bdanger\s*:\s*true/.test(body) && /\bremember_key\s*:/.test(body)) {
        const line = src.slice(0, m.index).split('\n').length;
        const key = /remember_key\s*:\s*'([^']*)'/.exec(body)?.[1] || '?';
        offenders.push(`${path.relative(SRC, f)}:${line} — remember_key: '${key}'`);
      }
    }
  }

  ok(offenders.length === 0,
    'אין פעולה הרסנית שאפשר להשתיק',
    offenders.join('\n     '));

  // And the way back has to exist somewhere a person can reach.
  const reachable = files.some((f) =>
    /resetAllRememberedConfirms/.test(fs.readFileSync(f, 'utf8')));
  ok(reachable, 'אפשר להחזיר אישורים שהושתקו מתוך האפליקציה',
    'resetAllRememberedConfirms מוגדר אך לא נקרא בשום מסך');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
