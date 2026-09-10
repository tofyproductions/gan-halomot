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

  console.log('\nניגודיות מצבי ההחתמה (הצבע הוא המידע):');
  for (const [state, pair] of Object.entries(COLOR.punch)) {
    const ratio = contrast(pair.on, pair.bg);
    ok(ratio >= AA, `punch.${state} — ${ratio.toFixed(2)}:1  ${pair.label}`, `נדרש ${AA}`);
  }
  // Six states a manager tells apart at a glance across a month of forty
  // employees: two that look alike are two she reads wrong.
  const bgs = Object.values(COLOR.punch).map((p) => p.bg.toLowerCase());
  ok(new Set(bgs).size === bgs.length, `כל ${bgs.length} מצבי ההחתמה בגוון נפרד`);

  console.log('\nניגודיות צבעי הסניפים:');
  for (const [name, b] of Object.entries(COLOR.branch)) {
    const onStrip = contrast(b.stripText, b.strip);
    const onName = contrast(COLOR.text.primary, b.nameTint);
    const onRow = contrast(COLOR.text.primary, b.rowTint);
    const worst = Math.min(onStrip, onName, onRow);
    ok(worst >= AA, `branch.${name} — כותרת ${onStrip.toFixed(2)} · עמודת שם ${onName.toFixed(2)} · שורה ${onRow.toFixed(2)}`, `נדרש ${AA}`);
  }
  // Telling four gans apart at a glance is the entire job of this palette.
  const strips = Object.values(COLOR.branch).map((b) => b.strip.toLowerCase());
  ok(new Set(strips).size === strips.length, `כל ${strips.length} צבעי הסניפים נפרדים`);

  console.log('\nצבעי תאי הגאנט (ערכים שמורים במסד — לא לשנות):');
  ok(Array.isArray(COLOR.ganttCell) && COLOR.ganttCell.length === 6, 'שישה צבעים לבחירה');
  for (const c of COLOR.ganttCell) {
    const ratio = contrast(COLOR.text.primary, c.value);
    ok(ratio >= AA, `ganttCell ${c.label} — טקסט ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  console.log('\nניגודיות גווני עמודות השכר:');
  for (const [kind, c] of Object.entries(COLOR.payrollColumn)) {
    const onHead = contrast(COLOR.text.primary, c.head);
    const onCell = contrast(COLOR.text.primary, c.cell);
    ok(Math.min(onHead, onCell) >= AA, `payrollColumn.${kind} — כותרת ${onHead.toFixed(2)} · תא ${onCell.toFixed(2)}`, `נדרש ${AA}`);
  }
  // Six families, and the body tint has to stay lighter than its own heading
  // or the column reads upside down.
  for (const [kind, c] of Object.entries(COLOR.payrollColumn)) {
    ok(luminance(c.cell) > luminance(c.head), `payrollColumn.${kind} — התא בהיר מהכותרת`);
  }

  console.log('\nניגודיות מצבי הריון:');
  for (const [state, c] of Object.entries(COLOR.maternity)) {
    const ratio = contrast(c.on, c.bg);
    ok(ratio >= AA, `maternity.${state} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }
  const mBgs = Object.values(COLOR.maternity).map((c) => c.bg.toLowerCase());
  ok(new Set(mBgs).size === mBgs.length, `כל ${mBgs.length} מצבי ההריון בגוון נפרד`);

  console.log('\nניגודיות לוח הגאנט:');
  for (const [state, c] of Object.entries(COLOR.gantt.day)) {
    const ratio = contrast(c.on, c.bg);
    ok(ratio >= AA, `gantt.day.${state} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }
  const dayBgs = Object.values(COLOR.gantt.day).map((c) => c.bg.toLowerCase());
  ok(new Set(dayBgs).size === dayBgs.length, `כל ${dayBgs.length} מצבי היום בגוון נפרד`);
  for (const [k, c] of Object.entries(COLOR.gantt.cell)) {
    const ratio = contrast(COLOR.text.primary, c);
    ok(ratio >= AA, `gantt.cell.${k} — טקסט ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }
  for (const k of ['note', 'span']) {
    const ratio = contrast(COLOR.gantt[k].on, COLOR.gantt[k].bg);
    ok(ratio >= AA, `gantt.${k} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  for (const [kind, c] of Object.entries(COLOR.gantt.row)) {
    const onBg = contrast(c.ink, c.bg);
    const onLabel = contrast(c.ink, c.label);
    ok(Math.min(onBg, onLabel) >= AA, `gantt.row.${kind} — רקע ${onBg.toFixed(2)} · תווית ${onLabel.toFixed(2)}`, `נדרש ${AA}`);
  }
  const rowBgs = Object.values(COLOR.gantt.row).map((c) => c.bg.toLowerCase());
  ok(new Set(rowBgs).size === rowBgs.length, `כל ${rowBgs.length} סוגי השורה בגוון נפרד`);

  console.log('\nניגודיות דוח השעות:');
  for (const [state, c] of Object.entries(COLOR.hours.row)) {
    const ratio = contrast(c.on, c.bg);
    ok(ratio >= AA, `hours.row.${state} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }
  const hBgs = Object.values(COLOR.hours.row).map((c) => c.bg.toLowerCase());
  ok(new Set(hBgs).size === hBgs.length, `כל ${hBgs.length} מצבי השורה בגוון נפרד`);
  const lBgs = Object.values(COLOR.hours.leave).map((c) => c.toLowerCase());
  ok(new Set(lBgs).size === lBgs.length, `כל ${lBgs.length} סוגי ההיעדרות בגוון נפרד`);
  for (const [k, c] of Object.entries(COLOR.hours.leave)) {
    ok(contrast(COLOR.text.primary, c) >= AA, `hours.leave.${k} — טקסט ${contrast(COLOR.text.primary, c).toFixed(2)}:1`);
  }

  console.log('\nהצבע הישן לא חזר:');
  ok(COLOR.primary.main.toLowerCase() !== '#f59e0b',
    'primary.main אינו הכתום שנכשל בניגודיות');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
