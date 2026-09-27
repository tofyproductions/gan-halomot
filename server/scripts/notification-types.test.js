#!/usr/bin/env node
/**
 * Every notification `type` the code creates must exist in the
 * NotificationEvent enum.
 *
 * The 07:00 punch digest shipped with two types missing from the enum: every
 * create() failed validation, the day's "sent" marker was already written, and
 * nothing retried — so no manager ever got the push. Its own test stubbed
 * createEvent, which is exactly why it passed. This test reads the SOURCE, so
 * a new call site with a new type fails here before it fails in production.
 *
 *   node scripts/notification-types.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NotificationEvent = require('../src/models/NotificationEvent');

const allowed = new Set(NotificationEvent.schema.path('type').enumValues);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// A creation call and the `type:` inside the next few lines — the shape every
// call site uses (createEvent / pushOnce / NotificationEvent.create).
const CALL = /(createEvent|notifyOnce|pushOnce|NotificationEvent\.create)\s*\(/g;
const used = [];
for (const file of walk(path.join(__dirname, '..', 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = CALL.exec(src))) {
    const window = src.slice(m.index, m.index + 600);
    const t = /type:\s*'([a-z_]+)'/.exec(window);
    if (t) used.push({ type: t[1], file: path.relative(process.cwd(), file) });
  }
}

assert.ok(used.length > 0, 'found no notification call sites — the scan is broken');
const missing = used.filter(u => !allowed.has(u.type));
assert.deepStrictEqual(missing, [], `types missing from the NotificationEvent enum:\n${
  missing.map(u => `  ${u.type}  (${u.file})`).join('\n')}`);

console.log(`✓ all ${used.length} notification call sites use a type the enum accepts`);
