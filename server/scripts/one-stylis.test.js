#!/usr/bin/env node
/**
 * There must be exactly ONE stylis in the tree.
 *
 * This app had two, and the way it showed up was a white screen with no
 * mention of the cause. client/package.json asked for `stylis: ^4.3.4` while
 * @emotion/cache pins EXACTLY 4.2.0, so npm hoisted 4.3.6 to the top and
 * nested emotion's copy underneath it. Both are then live at once:
 *
 *   theme/rtlTheme.js  imports { prefixer } from 'stylis'   → 4.3.6
 *   @emotion/cache     compiles and serializes with its own → 4.2.0
 *
 * and `createCache({ stylisPlugins })` REPLACES emotion's built-in prefixer
 * with whatever it is handed. So 4.3.6's prefixer walked an AST built by
 * 4.2.0. It survived that for every selector but a handful: `::placeholder`
 * (and its neighbours in the same switch) are handled via `lift()`, which
 * reads `root.siblings` — a field 4.3 adds and 4.2 does not have. The result
 * is "Cannot read properties of undefined (reading 'push')" thrown from inside
 * emotion's insertion, naming no file of ours and no selector.
 *
 * Nothing in the build says any of that. So this does.
 *
 *   node scripts/one-stylis.test.js
 */
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', 'client');

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
}

/** Every installed copy of a package, however deeply nested. */
function findCopies(dir, name, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === name && fs.existsSync(path.join(p, 'package.json'))) {
      try {
        out.push({
          dir: path.relative(CLIENT, p),
          version: JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version,
        });
      } catch { /* not a package after all */ }
      continue;
    }
    // Only descend where packages actually live.
    if (e.name === 'node_modules' || e.name.startsWith('@')) findCopies(p, name, out);
    else if (fs.existsSync(path.join(p, 'node_modules'))) findCopies(path.join(p, 'node_modules'), name, out);
  }
  return out;
}

function main() {
  console.log('=== stylis אחד בלבד ===\n');

  const nm = path.join(CLIENT, 'node_modules');
  if (!fs.existsSync(nm)) {
    console.log('אין node_modules ב-client. הרץ קודם:  npm --prefix client install\n');
    process.exit(1);
  }

  const copies = findCopies(nm, 'stylis');
  for (const c of copies) console.log(`  ${c.version.padEnd(8)} ${c.dir}`);
  console.log('');

  ok(copies.length === 1,
    `עותק אחד של stylis (נמצאו ${copies.length})`,
    copies.map((c) => `${c.version} — ${c.dir}`).join('\n     '));

  /**
   * And the pin has to keep matching, because @emotion/cache pins an exact
   * version: any range on our side is free to drift off it on the next install
   * and put the second copy back.
   */
  const ours = JSON.parse(fs.readFileSync(path.join(CLIENT, 'package.json'), 'utf8'));
  const declared = ours.dependencies?.stylis;
  const emotionPin = JSON.parse(
    fs.readFileSync(path.join(nm, '@emotion', 'cache', 'package.json'), 'utf8')
  ).dependencies?.stylis;

  ok(declared === emotionPin,
    `client/package.json מצמיד stylis ל-${emotionPin} בדיוק`,
    `מוצהר "${declared}", ו-@emotion/cache מצמיד "${emotionPin}". טווח כאן = שני עותקים.`);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
