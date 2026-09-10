#!/usr/bin/env node
/**
 * The browser tab's title, the breadcrumb and the 404 all read one function.
 *
 * Every screen in this app used to put the same words in the tab — "גן החלומות
 * - ניהול חכם", 72 times — so an office with eleven tabs open had eleven
 * identical ones and found the right screen by clicking through them. The title
 * is the only label a browser gives you when a tab is 90px wide, and it was
 * spent on the product name.
 *
 * What this checks is mostly that the mapping never falls back to a blank or a
 * wrong section: a heading that says the wrong group is worse than no heading,
 * because it is believed.
 *
 *   node scripts/screen-meta.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const META = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'config', 'screenMeta.js')
).href;
const TABS = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'config', 'tabs.js')
).href;

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

async function main() {
  console.log('=== שם המסך, לכותרת הלשונית ולפירורי הלחם ===\n');
  const { screenForPath, titleForPath } = await import(META);
  const { TAB_GROUPS } = await import(TABS);

  const all = TAB_GROUPS.flatMap((g) => g.items.filter((i) => i.path).map((i) => ({ ...i, group: g.label })));

  console.log('כל מסך ברשימה מזוהה נכון:');
  const wrong = all.filter((i) => {
    const s = screenForPath(i.path);
    return !s.known || s.label !== i.label || s.group !== i.group;
  });
  ok(wrong.length === 0, `כל ${all.length} המסכים`, wrong.map((w) => w.path).join(', '));

  console.log('\nכל כותרת ייחודית — אחרת אין טעם בכותרת:');
  const titles = all.map((i) => titleForPath(i.path));
  const dupes = titles.filter((t, n) => titles.indexOf(t) !== n);
  ok(dupes.length === 0, `${new Set(titles).size} כותרות שונות ל-${all.length} מסכים`, [...new Set(dupes)].join(' | '));
  ok(titles.every((t) => t.endsWith('· גן החלומות')), 'כל כותרת נגמרת בשם המערכת');
  ok(titles.every((t) => !t.startsWith('גן החלומות')),
    'שם המסך לפני שם המערכת — זה מה שנקרא בלשונית צרה');

  console.log('\nמסך בתוך מסך שומר על הקבוצה שלו:');
  const child = screenForPath('/orders/new');
  ok(child.known && child.label === 'הזמנות' && child.suffix === 'הזמנה חדשה',
    `/orders/new → ${child.label} · ${child.suffix}`);
  const ganttEdit = screenForPath('/gantt/edit');
  ok(ganttEdit.label === 'גאנט' && ganttEdit.suffix === 'עריכה',
    `/gantt/edit → ${ganttEdit.label} · ${ganttEdit.suffix}`,
    'הנתיב הארוך חייב לנצח את הקצר');
  const orderView = screenForPath('/orders/6aa25681');
  ok(orderView.known && orderView.label === 'הזמנות', `/orders/:id → ${orderView.label}`);

  console.log('\nכתובת שאינה קיימת:');
  const missing = screenForPath('/no-such-screen');
  ok(!missing.known, 'מזוהה כלא-נמצאת');
  ok(titleForPath('/no-such-screen').startsWith('לא נמצא'), 'ולכותרת שאומרת זאת');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
