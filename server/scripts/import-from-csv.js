/**
 * Import registrations from local CSV file
 * Usage: node scripts/import-from-csv.js <csv-path>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const CSV_PATH = process.argv[2] || '/Users/amits-mac/Downloads/Parent Registration Kaplan Branch Agreements.csv';

function parseCSV(text) {
  const rows = [];
  const lines = [];
  let current = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { inQ = !inQ; current += '"'; }
    else if (text[i] === '\n' && !inQ) { lines.push(current); current = ''; }
    else current += text[i];
  }
  if (current.trim()) lines.push(current);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = []; let cell = '', q = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (q && line[i+1] === '"') { cell += '"'; i++; }
        else q = !q;
      }
      else if (line[i] === ',' && !q) { cols.push(cell); cell = ''; }
      else cell += line[i];
    }
    cols.push(cell);
    rows.push(cols);
  }
  return rows;
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim().replace(/^"|"$/g, '');
  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ddmmyyyy) return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2,'0')}-${ddmmyyyy[1].padStart(2,'0')}`);
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function getAcademicYear(date) {
  if (!date) return '';
  const yr = date.getFullYear(), m = date.getMonth() + 1, day = date.getDate();
  const s = (m > 8 || (m === 8 && day >= 10)) ? yr : yr - 1;
  return `${s}-${s + 1}`;
}

async function run() {
  console.log('📦 Importing from CSV:', CSV_PATH);

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(text);
  console.log(`Read ${rows.length} rows`);

  await mongoose.connect(process.env.MONGODB_URI);
  const { Registration, Classroom, Branch } = require('../src/models');

  const kaplan = await Branch.findOne({ name: /קפלן/ });
  if (!kaplan) throw new Error('Kaplan branch not found');
  console.log('Kaplan branch:', kaplan._id);

  // Ensure classrooms exist for Kaplan
  const classroomNames = new Set();
  for (let i = 1; i < rows.length; i++) {
    const cls = (rows[i][3] || '').trim();
    if (cls) classroomNames.add(cls);
  }
  console.log('Classrooms to ensure:', [...classroomNames]);

  const classroomMap = {};
  for (const name of classroomNames) {
    // Find any existing classroom with this name in Kaplan (active or not)
    let cls = await Classroom.findOne({ name, branch_id: kaplan._id });
    if (cls) {
      if (!cls.is_active) {
        cls.is_active = true;
        await cls.save();
        console.log(`Reactivated: ${name}`);
      }
    } else {
      cls = await Classroom.create({
        name, branch_id: kaplan._id,
        academic_year: '2025-2026', capacity: 35, is_active: true,
      });
      console.log(`Created: ${name}`);
    }
    classroomMap[name] = cls._id;
  }

  // Process registrations
  let created = 0, updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const uniqueId = (row[1] || '').trim();
    if (!uniqueId) continue;

    let config = {};
    try { config = JSON.parse(row[11] || '{}'); } catch {}

    const cls = (row[3] || 'כללי').trim();
    const classroomId = classroomMap[cls] || null;
    const startDate = parseDate(row[7]);
    const endDate = parseDate(row[8]);

    const signed = row[9] === 'כן';
    const cardDone = row[10] === 'כן';
    const status = (signed && cardDone) ? 'completed' : (signed ? 'contract_signed' : 'link_generated');

    const data = {
      unique_id: uniqueId,
      branch_id: kaplan._id,
      child_name: row[2] || '',
      child_birth_date: parseDate(row[12]) || parseDate(config.childBirthDate) || null,
      classroom_id: classroomId,
      parent_name: row[4] || '',
      parent_id_number: row[5] || '',
      parent_phone: config.phone || '',
      parent_email: config.parentEmail || '',
      monthly_fee: parseFloat(row[6]) || 0,
      registration_fee: parseFloat(config.regFee) || 0,
      start_date: startDate || new Date('2025-09-01'),
      end_date: endDate || new Date('2026-08-10'),
      status, agreement_signed: signed, card_completed: cardDone,
      configuration: config,
    };

    const existing = await Registration.findOne({ unique_id: uniqueId });
    if (existing) {
      Object.assign(existing, data);
      await existing.save();
      updated++;
    } else {
      await Registration.create(data);
      created++;
    }
  }

  console.log(`\n✅ Created: ${created}, Updated: ${updated}`);

  // Stats
  const totalRegs = await Registration.countDocuments({ branch_id: kaplan._id });
  const byStatus = {};
  for (const s of ['completed', 'contract_signed', 'link_generated']) {
    byStatus[s] = await Registration.countDocuments({ branch_id: kaplan._id, status: s });
  }
  console.log(`Total Kaplan registrations: ${totalRegs}`);
  console.log(`By status:`, byStatus);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
