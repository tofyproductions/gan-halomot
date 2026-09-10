#!/usr/bin/env node
/**
 * The RTL plugin must not flip the rules that exist to stop it flipping things.
 *
 * `.num` sets `direction: ltr` and `text-align: right` so an Israeli ID, a
 * phone number or a shekel figure keeps its own reading order inside a Hebrew
 * sentence. Both declarations pass through stylis-plugin-rtl, which does not
 * know they are the point — it turned them into `rtl` and `left`, so the class
 * written to fix the problem was causing it, silently, everywhere.
 *
 * The fix is the plugin's own /*!@noflip*\/ escape hatch, and this is what
 * makes removing it fail loudly instead of quietly.
 *
 *   node scripts/rtl-noflip.test.js
 */
const path = require('path');
const CLIENT = path.join(__dirname, '..', '..', 'client');
const { serialize, compile, middleware, stringify } = require(path.join(CLIENT, 'node_modules', 'stylis'));
const rtlModule = require(path.join(CLIENT, 'node_modules', 'stylis-plugin-rtl'));
const rtlPlugin = rtlModule.default || rtlModule;

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
}

const through = (css) => serialize(compile(css), middleware([rtlPlugin, stringify]));

console.log('=== מספרים לא מתהפכים בתוך משפט עברי ===\n');

// What the theme ships, verbatim in shape.
const guarded = '.num{unicode-bidi:isolate;/*!@noflip*/direction:ltr;/*!@noflip*/text-align:right;}';
const out = through(guarded);
ok(/direction:\s*ltr/.test(out), 'direction נשאר ltr אחרי התוסף', out);
ok(/text-align:\s*right/.test(out), 'text-align נשאר right אחרי התוסף', out);

// And prove the guard is doing the work rather than the plugin being harmless.
const unguarded = through('.num{direction:ltr;text-align:right;}');
ok(/direction:\s*rtl/.test(unguarded),
  'בלי ההגנה התוסף אכן הופך — ההגנה היא שעושה את העבודה', unguarded);

// The theme file must actually carry the guard.
const fs = require('fs');
const theme = fs.readFileSync(path.join(CLIENT, 'src', 'theme', 'rtlTheme.js'), 'utf8');
ok(/@noflip.*direction/s.test(theme) && /@noflip.*textAlign/s.test(theme),
  'rtlTheme.js מכיל את ההגנה על שתי ההצהרות');

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
process.exit(failures === 0 ? 0 : 1);
