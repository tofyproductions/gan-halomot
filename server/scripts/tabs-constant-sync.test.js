#!/usr/bin/env node
/**
 * server/src/constants/tabs.js is a copy of client/src/config/tabs.js, and a
 * copy that drifts is worse than no copy at all.
 *
 * The server needs the role DEFAULTS in order to build a custom role from a
 * person's effective tabs (admin.controller#createCustomRoleFromUser): the
 * effective set starts from "what does this role get by default", and a tab
 * the server has never heard of would be dropped from the role — silently,
 * and only for the people the role was built for.
 *
 * The client file is ESM and imports nothing this process can execute, so it
 * is read as text: every `{ id: '…' … defaultRoles: … }` in it, in order.
 *
 *   node scripts/tabs-constant-sync.test.js
 */
const fs = require('fs');
const path = require('path');

const CLIENT_TABS = path.join(__dirname, '..', '..', 'client', 'src', 'config', 'tabs.js');
const { TAB_DEFAULT_ROLES } = require('../src/constants/tabs');

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

/** The client file's tab table, parsed out of the source text. */
function parseClientTabs() {
  const src = fs.readFileSync(CLIENT_TABS, 'utf8');

  const empMatch = src.match(/export const EMPLOYEE_ROLES\s*=\s*\[([^\]]*)\]/);
  if (!empMatch) throw new Error('לא נמצא EMPLOYEE_ROLES בקובץ הלקוח');
  const EMPLOYEE_ROLES = empMatch[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  const re = /\{\s*id:\s*'([^']+)'[\s\S]*?defaultRoles:\s*(null|EMPLOYEE_ROLES|\[[^\]]*\])/g;
  const out = {};
  let m;
  while ((m = re.exec(src))) {
    const [, id, expr] = m;
    if (expr === 'null') out[id] = null;
    else if (expr === 'EMPLOYEE_ROLES') out[id] = EMPLOYEE_ROLES;
    else out[id] = expr.slice(1, -1).split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }
  return out;
}

function main() {
  console.log('=== סנכרון טאבים: constants/tabs.js מול client/src/config/tabs.js ===\n');

  const client = parseClientTabs();
  const clientIds = Object.keys(client);
  const serverIds = Object.keys(TAB_DEFAULT_ROLES);

  ok(clientIds.length > 30, `נקראו ${clientIds.length} טאבים מקובץ הלקוח`, 'הפירסור כנראה נשבר');

  const missingOnServer = clientIds.filter(id => !(id in TAB_DEFAULT_ROLES));
  ok(missingOnServer.length === 0,
    'כל טאב בלקוח קיים גם בשרת',
    `חסרים בשרת: ${missingOnServer.join(', ')}`);

  const missingOnClient = serverIds.filter(id => !(id in client));
  ok(missingOnClient.length === 0,
    'כל טאב בשרת קיים גם בלקוח',
    `לא קיימים בלקוח: ${missingOnClient.join(', ')}`);

  const norm = (v) => (v === null ? null : [...v].sort());
  const differ = clientIds
    .filter(id => id in TAB_DEFAULT_ROLES)
    .filter(id => JSON.stringify(norm(client[id])) !== JSON.stringify(norm(TAB_DEFAULT_ROLES[id])));
  ok(differ.length === 0,
    'defaultRoles זהים בשני הקבצים',
    differ.map(id => `${id}: לקוח=${JSON.stringify(client[id])} שרת=${JSON.stringify(TAB_DEFAULT_ROLES[id])}`).join(' | '));

  // clicktac_write is a write GRANT and not a screen; it is the one id most
  // likely to be left out of a hand-written mirror, so it is named here.
  ok('clicktac_write' in TAB_DEFAULT_ROLES, "מזהה ההרשאה clicktac_write קיים בשרת");

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} בדיקות עברו`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
