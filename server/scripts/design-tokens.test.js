#!/usr/bin/env node
/**
 * The design tokens are the one place a colour is allowed to be written down,
 * so this is the one place their contrast is checked.
 *
 * The staff theme shipped `primary.main: '#f59e0b'` with white text for two
 * years — 2.2:1, failing WCAG AA on every contained primary button in the
 * app. Nobody noticed because nothing measured it. This does.
 *
 * tokens.js imports nothing, which is what lets this CommonJS script pull an
 * ESM module in with a dynamic import.
 *
 *   node scripts/design-tokens.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const TOKENS = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'theme', 'tokens.js')
).href;

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  console.log('=== אסימוני עיצוב: ניגודיות ושלמות ===\n');
  const { COLOR, RADIUS, SPACING_UNIT, TYPE, MOTION } = await import(TOKENS);

  console.log('נוכחות:');
  for (const key of ['sidebar', 'background', 'text', 'primary', 'success', 'warning', 'error', 'info', 'divider']) {
    ok(COLOR[key] !== undefined, `COLOR.${key} קיים`);
  }
  ok(typeof SPACING_UNIT === 'number' && SPACING_UNIT === 8, 'SPACING_UNIT = 8');
  ok(RADIUS && RADIUS.control === 6 && RADIUS.surface === 8 && RADIUS.pill === 999, 'סולם פינות: 6 / 8 / 999');
  ok(TYPE && TYPE.fontFamily && !/Varela/i.test(TYPE.fontFamily), 'משפחת גופנים אחת, בלי Varela Round');
  ok(MOTION && MOTION.duration >= 150 && MOTION.duration <= 250, 'משך תנועה 150–250ms');

  console.log('\nניגודיות טקסט (מינימום AA = 4.5):');
  const AA = 4.5;
  const pairs = [
    ['primary.contrastText על primary.main', COLOR.primary.contrastText, COLOR.primary.main],
    ['success.contrastText על success.main', COLOR.success.contrastText, COLOR.success.main],
    ['warning.contrastText על warning.main', COLOR.warning.contrastText, COLOR.warning.main],
    ['error.contrastText על error.main', COLOR.error.contrastText, COLOR.error.main],
    ['info.contrastText על info.main', COLOR.info.contrastText, COLOR.info.main],
    ['text.primary על background.paper', COLOR.text.primary, COLOR.background.paper],
    ['text.primary על background.default', COLOR.text.primary, COLOR.background.default],
    ['text.secondary על background.paper', COLOR.text.secondary, COLOR.background.paper],
    ['text.secondary על background.default', COLOR.text.secondary, COLOR.background.default],
    ['sidebar.fg על sidebar.bg', COLOR.sidebar.fg, COLOR.sidebar.bg],
    ['sidebar.fgActive על sidebar.bgActive', COLOR.sidebar.fgActive, COLOR.sidebar.bgActive],
    ['sidebar.groupLabel על sidebar.bg', COLOR.sidebar.groupLabel, COLOR.sidebar.bg],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    ok(ratio >= AA, `${label} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  console.log('\nניגודיות תגיות רכות:');
  for (const role of ['primary', 'success', 'warning', 'error', 'info']) {
    const ratio = contrast(COLOR[role].softOn, COLOR[role].soft);
    ok(ratio >= AA, `${role}.softOn על ${role}.soft — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  console.log('\nהצבע הישן לא חזר:');
  ok(COLOR.primary.main.toLowerCase() !== '#f59e0b',
    'primary.main אינו הכתום שנכשל בניגודיות');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
