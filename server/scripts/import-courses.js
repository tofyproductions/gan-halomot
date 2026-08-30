#!/usr/bin/env node
/**
 * מעקב קורסים — one-time import of the tracking sheet into EmployeeCourse.
 *
 * Reads courses-import.json (generated from the Google Sheet "מעקב קורסים -
 * רשת גן החלומות"), matches each row to an Employee by ת"ז — the sheet's names
 * have nicknames and married names, the ת"ז doesn't — and creates course rows
 * carrying the sheet's expiry dates and its Drive links, so every תעודה that
 * lived behind a cell keeps opening in one click.
 *
 * Idempotent: an employee who already has a live row of a course type is
 * skipped for that type, so re-running after a partial failure adds only what
 * is missing and never duplicates or overwrites what somebody edited by hand.
 *
 *   node scripts/import-courses.js           # dry run — reports, writes nothing
 *   node scripts/import-courses.js --apply   # actually writes
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI חסר'); process.exit(1); }
  await mongoose.connect(uri);

  const Employee = require('../src/models/Employee');
  const EmployeeCourse = require('../src/models/EmployeeCourse');

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'courses-import.json'), 'utf8'));

  const pad9 = v => String(v || '').replace(/\D/g, '').padStart(9, '0');

  const employees = await Employee.find({}).select('full_name israeli_id is_active').lean();
  const byId = new Map(employees.filter(e => e.israeli_id).map(e => [pad9(e.israeli_id), e]));
  const norm = s => String(s || '').replace(/[\s'"׳״()-]/g, '');
  const byName = new Map();
  for (const e of employees) {
    const k = norm(e.full_name);
    // A name that appears twice matches nobody — better unmatched than wrong.
    byName.set(k, byName.has(k) ? null : e);
  }

  // The sheet and the system disagree on one ת"ז by a transposed digit, and on
  // the name's order. Verified by hand — this is the same person.
  const ID_ALIASES = { 316942897: '316942879' }; // איה סבשין (ראיסה) ← ראסיה סבשין (איה)

  let created = 0; let skippedExisting = 0; const unmatched = [];
  for (const row of data.employees) {
    const sheetId = pad9(ID_ALIASES[String(Number(row.israeli_id || 0))] || row.israeli_id);
    const emp = byId.get(sheetId) || byName.get(norm(row.full_name)) || null;
    if (!emp) { unmatched.push(`${row.full_name} (${row.branch}, ת"ז ${row.israeli_id || '—'})`); continue; }

    const types = ['first_aid', 'safe_conduct', 'caregiver', 'advanced_caregiver'];
    for (const type of types) {
      const src = row[type];
      if (!src) continue;

      const exists = await EmployeeCourse.findOne({
        employee_id: emp._id, course_type: type, is_archived: false,
      }).select('_id').lean();
      if (exists) { skippedExisting++; continue; }

      if (APPLY) {
        await EmployeeCourse.create({
          employee_id: emp._id,
          course_type: type,
          expires_at: src.expires_at ? new Date(src.expires_at) : null,
          external_url: src.external_url || '',
          status_note: src.status_note || '',
          notes: row.notes || '',
          source: 'import',
        });
      }
      created++;
    }
  }

  console.log(`${APPLY ? '' : '[dry run] '}נוצרו ${created} רשומות קורס · ${skippedExisting} כבר קיימות ודולגו`);
  if (unmatched.length) {
    console.log(`\n${unmatched.length} שורות מהגיליון בלי עובד/ת תואם/ת במערכת (לא נקלטו):`);
    unmatched.forEach(u => console.log(`  · ${u}`));
  }
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
