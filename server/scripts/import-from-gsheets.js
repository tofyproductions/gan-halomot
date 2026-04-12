/**
 * One-time Migration Script: Google Sheets -> MongoDB
 * Reads directly from public Google Sheets (no service account needed)
 *
 * Usage: node scripts/import-from-gsheets.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const https = require('https');

const SPREADSHEET_ID = '1H-pCIZQEIm6aXYfgZt_ZU6LXn6rUIfh7t1j6N0adpy0';

const SHEETS = {
  LEADS: 'הסכמי התקשרות',
  ACTIVE: 'ילדים פעילים',
  COLLECTIONS: 'מעקב גבייה',
  ARCHIVE_SIGNED: 'ארכיון - נחתמו',
  ARCHIVE_UNSIGNED: 'ארכיון - לא נחתמו',
};

function fetchCSV(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encoded}`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Language': 'en' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => resolve(data));
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSV(csvText) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const lines = [];

  // Split into lines respecting quoted newlines
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cell = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        cols.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }
    cols.push(cell);
    rows.push(cols);
  }

  if (rows.length < 2) return { headers: rows[0] || [], data: [] };
  return { headers: rows[0], data: rows.slice(1) };
}

function parseDate(str) {
  if (!str) return null;
  // Try DD/MM/YYYY HH:mm:ss
  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  }
  // Try YYYY-MM-DD
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function getAcademicYear(date) {
  if (!date) return '';
  const yr = date.getFullYear();
  const m = date.getMonth() + 1;
  const day = date.getDate();
  const isAfter = m > 8 || (m === 8 && day >= 10);
  const startYear = isAfter ? yr : yr - 1;
  return `${startYear}-${startYear + 1}`;
}

async function run() {
  console.log('🚀 Starting Google Sheets -> MongoDB Migration');
  console.log('================================================\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  const { Classroom, Registration, Child, Collection, Archive } = require('../src/models');

  // 1. Read all sheets
  console.log('📄 Reading sheets...');
  const leadsCSV = await fetchCSV(SHEETS.LEADS);
  const activeCSV = await fetchCSV(SHEETS.ACTIVE);
  const collectionsCSV = await fetchCSV(SHEETS.COLLECTIONS);
  const signedArchiveCSV = await fetchCSV(SHEETS.ARCHIVE_SIGNED);
  const unsignedArchiveCSV = await fetchCSV(SHEETS.ARCHIVE_UNSIGNED);

  const leads = parseCSV(leadsCSV);
  const active = parseCSV(activeCSV);
  const collections = parseCSV(collectionsCSV);
  const signedArchive = parseCSV(signedArchiveCSV);
  const unsignedArchive = parseCSV(unsignedArchiveCSV);

  console.log(`  Leads: ${leads.data.length} rows`);
  console.log(`  Active Kids: ${active.data.length} rows`);
  console.log(`  Collections: ${collections.data.length} rows`);
  console.log(`  Archive Signed: ${signedArchive.data.length} rows`);
  console.log(`  Archive Unsigned: ${unsignedArchive.data.length} rows`);

  // 2. Build classroom map
  console.log('\n🏫 Importing classrooms...');
  const classroomMap = {}; // "name|year" -> ObjectId

  for (const row of leads.data) {
    const cls = row[3] || 'כללי';
    const startDate = parseDate(row[7]);
    const acadYear = getAcademicYear(startDate);
    if (!acadYear) continue;

    const key = `${cls}|${acadYear}`;
    if (classroomMap[key]) continue;

    let existing = await Classroom.findOne({ name: cls, academic_year: acadYear });
    if (!existing) {
      existing = await Classroom.create({ name: cls, academic_year: acadYear, capacity: 35 });
    }
    classroomMap[key] = existing._id;
  }
  console.log(`  ✅ ${Object.keys(classroomMap).length} classroom-year combinations`);

  // 3. Import registrations
  console.log('\n📝 Importing registrations...');
  const regMap = {}; // unique_id -> ObjectId

  for (const row of leads.data) {
    const uniqueId = (row[1] || '').trim();
    if (!uniqueId) continue;

    // Skip if already exists
    const existingReg = await Registration.findOne({ unique_id: uniqueId });
    if (existingReg) {
      regMap[uniqueId] = existingReg._id;
      continue;
    }

    const cls = row[3] || 'כללי';
    const startDate = parseDate(row[7]);
    const endDate = parseDate(row[8]);
    const acadYear = getAcademicYear(startDate);
    const classroomId = classroomMap[`${cls}|${acadYear}`] || null;

    let config = {};
    try { config = JSON.parse(row[11] || '{}'); } catch {}

    const reg = await Registration.create({
      unique_id: uniqueId,
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
      status: (row[9] === 'כן' && row[10] === 'כן') ? 'completed' : (row[9] === 'כן' ? 'contract_signed' : 'link_generated'),
      agreement_signed: row[9] === 'כן',
      card_completed: row[10] === 'כן',
      configuration: config,
      signature_data: config.signature || null,
      contract_pdf_path: config.contractPdfUrl || null,
    });

    regMap[uniqueId] = reg._id;
  }
  console.log(`  ✅ ${Object.keys(regMap).length} registrations`);

  // 4. Import active children
  console.log('\n👶 Importing active children...');
  let childCount = 0;

  for (const row of active.data) {
    const childName = (row[0] || '').trim();
    if (!childName) continue;

    const leadId = (row[6] || '').trim();
    const regId = regMap[leadId] || null;

    // Determine academic year
    let acadYear = '2025-2026';
    if (regId) {
      const reg = await Registration.findById(regId).select('start_date');
      if (reg?.start_date) acadYear = getAcademicYear(new Date(reg.start_date));
    }

    const cls = row[1] || 'כללי';
    const classroomId = classroomMap[`${cls}|${acadYear}`] || null;

    // Skip duplicates
    const existing = await Child.findOne({ registration_id: regId, child_name: childName });
    if (existing) continue;

    await Child.create({
      registration_id: regId,
      child_name: childName,
      birth_date: parseDate(row[2]),
      classroom_id: classroomId,
      parent_name: row[3] || '',
      phone: row[4] || '',
      medical_alerts: row[5] || '',
      is_active: true,
      academic_year: acadYear,
    });
    childCount++;
  }
  console.log(`  ✅ ${childCount} active children`);

  // 5. Import collections
  console.log('\n💰 Importing collections...');
  // Headers: Lead_ID, Academic_Year, Sept, Oct, Nov, Dec, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Last_Update, ExitMonth
  let collCount = 0;

  for (const row of collections.data) {
    const leadId = (row[0] || '').trim();
    if (!leadId) continue;

    const regId = regMap[leadId] || null;
    const acadYear = (row[1] || '').trim() || '2025-2026';

    // Skip if exists
    if (regId) {
      const existing = await Collection.findOne({ registration_id: regId, academic_year: acadYear });
      if (existing) continue;
    }

    // Month columns: Sept=2, Oct=3, ..., Aug=13
    const monthColMap = { 9: 2, 10: 3, 11: 4, 12: 5, 1: 6, 2: 7, 3: 8, 4: 9, 5: 10, 6: 11, 7: 12, 8: 13 };

    const months = [];
    for (const [monthNum, colIdx] of Object.entries(monthColMap)) {
      const val = (row[colIdx] || '').trim();
      if (!val) continue;

      // Values in the sheet are receipt numbers, not payment amounts
      months.push({
        month_number: parseInt(monthNum),
        receipt_number: val,
        paid_amount: 0, // Will be calculated from expected on display
        payment_status: 'paid',
      });
    }

    // No exit_month column in the Google Sheet - always null
    const exitMonth = null;

    // Get child
    let childId = null;
    if (regId) {
      const child = await Child.findOne({ registration_id: regId, is_active: true });
      if (child) childId = child._id;
    }

    await Collection.create({
      registration_id: regId,
      child_id: childId,
      academic_year: acadYear,
      exit_month: exitMonth,
      months,
    });
    collCount++;
  }
  console.log(`  ✅ ${collCount} collection records`);

  // 6. Import archives
  console.log('\n📦 Importing archives...');
  let archiveCount = 0;

  const importArchive = async (data, type) => {
    for (const row of data) {
      const uniqueId = (row[1] || '').trim();
      if (!uniqueId) continue;

      let config = {};
      try { config = JSON.parse(row[11] || '{}'); } catch {}

      const startDate = parseDate(row[7]);
      const acadYear = getAcademicYear(startDate);

      await Archive.create({
        archive_type: type,
        original_data: {
          unique_id: uniqueId,
          child_name: row[2] || '',
          classroom: row[3] || '',
          parent_name: row[4] || '',
          parent_id_number: row[5] || '',
          monthly_fee: parseFloat(row[6]) || 0,
          start_date: startDate,
          end_date: parseDate(row[8]),
          agreement_signed: row[9] === 'כן',
          card_completed: row[10] === 'כן',
          configuration: config,
        },
        child_name: row[2] || '',
        classroom_name: row[3] || '',
        academic_year: acadYear,
        archived_at: parseDate(row[13]) || new Date(),
      });
      archiveCount++;
    }
  };

  await importArchive(signedArchive.data, 'signed');
  await importArchive(unsignedArchive.data, 'unsigned');
  console.log(`  ✅ ${archiveCount} archived records`);

  // Done
  console.log('\n✨ Migration completed successfully!');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
