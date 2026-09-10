#!/usr/bin/env node
/**
 * Two themes ship. The screens are shared. Both themes must answer.
 *
 * The app now renders under one of two complete themes — `rtlTheme` (the
 * redesign) and `classicTheme` (the interface the gans were already using) —
 * chosen per person by `User.ui_version`. What is NOT duplicated is the
 * screens: there is one גבייה, one החתמות, one רישום חיצוני, and roughly
 * thirty of them were rebuilt during the redesign and now read theme keys the
 * old theme never had.
 *
 * A missing key there is not a missing style. `sx={{ transition: (t) =>
 * t.motion.fast }}` against a theme with no `motion` throws, React unmounts
 * the subtree, and the person lands on the error boundary. That is exactly
 * what happened the first time the classic shell was rendered with the
 * rebuilt dashboard inside it: StatBoard.jsx:78, "Cannot read properties of
 * undefined (reading 'fast')".
 *
 * `vite build` cannot see it — the property is only read at render — so this
 * reads what the components actually ask a theme for, and requires both theme
 * files to define it.
 *
 *   node scripts/theme-parity.test.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const THEMES = {
  rtlTheme: path.join(SRC, 'theme', 'rtlTheme.js'),
  classicTheme: path.join(SRC, 'theme', 'classicTheme.js'),
};

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
  console.log('=== שני נושאים, מסכים משותפים ===\n');

  const themeSrc = Object.fromEntries(
    Object.entries(THEMES).map(([n, p]) => [n, fs.readFileSync(p, 'utf8')])
  );

  /**
   * The contract, written down rather than scraped.
   *
   * The first version of this file derived the list by grepping components for
   * `t.something` — and matched every local variable that happened to be named
   * `t`, so it reported `theme.total`, `theme.value` and `theme.trim` as
   * missing theme keys. Forty-two false alarms. A check that cries wolf gets
   * switched off, which would have been worse than not having one.
   *
   * So this is the list of what the redesign ADDED to the theme, maintained by
   * hand. If you add another extension key to rtlTheme and read it from a
   * shared screen, add it here — that is the whole job of this file.
   */
  const REQUIRED_TOP_LEVEL = ['motion', 'figure', 'overline'];
  const REQUIRED_PALETTE = ['sidebar', 'row', 'dividerStrong'];
  const SEMANTIC = ['primary', 'success', 'warning', 'error', 'info'];

  console.log('מפתחות שהעיצוב החדש הוסיף, ושני הנושאים חייבים לענות עליהם:\n');
  for (const key of REQUIRED_TOP_LEVEL) {
    const missing = Object.entries(themeSrc)
      .filter(([, s]) => !new RegExp(`^\\s*${key}\\s*:`, 'm').test(s))
      .map(([n]) => n);
    ok(missing.length === 0, `theme.${key}`,
      `חסר ב: ${missing.join(', ')} — קריאה אליו במסך משותף זורקת בזמן ריצה`);
  }

  /**
   * Palette branches named as strings — `sx={{ bgcolor: 'row.attention' }}`.
   * These fail SILENTLY rather than throwing: MUI hands the unresolved string
   * to CSS, CSS drops it, and the row is simply not tinted. Harder to notice
   * than the crash, which is why it is asserted separately.
   */
  console.log('\nענפי פלטה שהמסכים מבקשים בשם:\n');
  for (const branch of REQUIRED_PALETTE) {
    const missing = Object.entries(themeSrc)
      .filter(([, s]) => !new RegExp(`${branch}\\s*:`).test(s))
      .map(([n]) => n);
    ok(missing.length === 0, `palette.${branch}`, `חסר ב: ${missing.join(', ')}`);
  }

  /**
   * The soft pairs reach the two themes by different routes, so this asserts
   * the route rather than the text: rtlTheme assigns the whole token family
   * (`primary: COLOR.primary`, which carries soft/softOn), classicTheme keeps
   * its own colours and grafts only the pair on. Both have to end up with it —
   * 49 places in the components ask for a `.soft` fill.
   */
  console.log('\nהצמדים הרכים מגיעים לשני הנושאים:\n');
  for (const fam of SEMANTIC) {
    const inNew = new RegExp(`${fam}\\s*:\\s*COLOR\\.${fam}\\b`).test(themeSrc.rtlTheme);
    const inClassic = new RegExp(`${fam}\\s*:\\s*\\{[^}]*COLOR\\.\\w+\\.soft`).test(themeSrc.classicTheme);
    ok(inNew && inClassic, `${fam}.soft / ${fam}.softOn`,
      `${!inNew ? 'rtlTheme לא מקצה את משפחת האסימון; ' : ''}${!inClassic ? 'classicTheme לא משתיל את הצמד' : ''}`);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
