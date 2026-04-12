/**
 * One-time Migration Script: Google Sheets -> PostgreSQL
 *
 * Usage: node scripts/import-from-gsheets.js
 *
 * Prerequisites:
 * 1. Create a Google Service Account and download the JSON key
 * 2. Share the spreadsheet with the service account email
 * 3. Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY_PATH in .env
 */

require('dotenv').config();
const { google } = require('googleapis');
const knex = require('knex');
const knexConfig = require('../knexfile');

const db = knex(knexConfig[process.env.NODE_ENV || 'development']);

// Sheet names from GAS config
const SHEETS = {
  LEADS: 'הסכמי התקשרות',
  ACTIVE: 'ילדים פעילים',
  ARCHIVE_SIGNED: 'ארכיון - נחתמו',
  ARCHIVE_UNSIGNED: 'ארכיון - לא נחתמו',
  COLLECTIONS: 'מעקב גבייה',
  COLLECTIONS_HISTORY: 'מעקב גבייה - היסטוריה',
};

async function getSheetData(sheets, sheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: sheetName,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return { headers: rows[0] || [], data: [] };
    return { headers: rows[0], data: rows.slice(1) };
  } catch (err) {
    console.warn(`⚠️ Sheet "${sheetName}" not found or empty:`, err.message);
    return { headers: [], data: [] };
  }
}

async function run() {
  console.log('🚀 Starting Google Sheets -> PostgreSQL Migration');
  console.log('================================================');

  // 1. Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 2. Read all sheets
  console.log('\n📄 Reading sheets...');
  const leadsSheet = await getSheetData(sheets, SHEETS.LEADS);
  const activeSheet = await getSheetData(sheets, SHEETS.ACTIVE);
  const signedArchive = await getSheetData(sheets, SHEETS.ARCHIVE_SIGNED);
  const unsignedArchive = await getSheetData(sheets, SHEETS.ARCHIVE_UNSIGNED);
  const collectionsSheet = await getSheetData(sheets, SHEETS.COLLECTIONS);
  const collHistorySheet = await getSheetData(sheets, SHEETS.COLLECTIONS_HISTORY);

  console.log(`  Leads: ${leadsSheet.data.length} rows`);
  console.log(`  Active Kids: ${activeSheet.data.length} rows`);
  console.log(`  Archive Signed: ${signedArchive.data.length} rows`);
  console.log(`  Archive Unsigned: ${unsignedArchive.data.length} rows`);
  console.log(`  Collections: ${collectionsSheet.data.length} rows`);
  console.log(`  Collections History: ${collHistorySheet.data.length} rows`);

  // 3. Begin transaction
  const trx = await db.transaction();

  try {
    // --- STEP A: Classrooms ---
    console.log('\n🏫 Importing classrooms...');
    const classroomNames = new Set();
    const classroomYears = new Map(); // name -> Set of years

    leadsSheet.data.forEach(row => {
      const cls = row[3] || 'כללי';
      classroomNames.add(cls);
      const startDate = row[7];
      if (startDate) {
        const d = new Date(startDate);
        const yr = d.getFullYear();
        const m = d.getMonth() + 1;
        const acadYear = (m > 8 || (m === 8 && d.getDate() >= 10)) ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
        if (!classroomYears.has(cls)) classroomYears.set(cls, new Set());
        classroomYears.get(cls).add(acadYear);
      }
    });

    const classroomMap = {}; // "name|year" -> id
    for (const [name, years] of classroomYears) {
      for (const year of years) {
        const [existing] = await trx('classrooms').where({ name, academic_year: year });
        if (existing) {
          classroomMap[`${name}|${year}`] = existing.id;
        } else {
          const [inserted] = await trx('classrooms').insert({ name, academic_year: year, is_active: true }).returning('id');
          classroomMap[`${name}|${year}`] = inserted.id;
        }
      }
    }
    console.log(`  ✅ ${Object.keys(classroomMap).length} classroom-year combinations`);

    // --- STEP B: Registrations ---
    console.log('\n📝 Importing registrations...');
    const regMap = {}; // unique_id -> db id

    for (const row of leadsSheet.data) {
      const uniqueId = String(row[1] || '').trim();
      if (!uniqueId) continue;

      const cls = row[3] || 'כללי';
      const startDate = row[7] ? new Date(row[7]) : null;
      let acadYear = '';
      if (startDate) {
        const yr = startDate.getFullYear();
        const m = startDate.getMonth() + 1;
        acadYear = (m > 8 || (m === 8 && startDate.getDate() >= 10)) ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
      }

      const classroomId = classroomMap[`${cls}|${acadYear}`] || null;
      let config = {};
      try { config = JSON.parse(row[11] || '{}'); } catch (e) {}

      const regData = {
        unique_id: uniqueId,
        child_name: row[2] || '',
        child_birth_date: row[12] ? new Date(row[12]) : null,
        classroom_id: classroomId,
        parent_name: row[4] || '',
        parent_id_number: row[5] || '',
        parent_phone: config.phone || '',
        parent_email: config.parentEmail || '',
        monthly_fee: parseFloat(row[6]) || 0,
        registration_fee: parseFloat(config.regFee) || 0,
        start_date: startDate,
        end_date: row[8] ? new Date(row[8]) : null,
        status: (row[9] === 'כן' && row[10] === 'כן') ? 'completed' : 'link_generated',
        agreement_signed: row[9] === 'כן',
        card_completed: row[10] === 'כן',
        configuration: JSON.stringify(config),
        signature_data: config.signature || null,
        contract_pdf_path: config.contractPdfUrl || null,
        created_at: row[0] ? new Date(row[0]) : new Date(),
      };

      const [inserted] = await trx('registrations').insert(regData).returning('id');
      regMap[uniqueId] = inserted.id;
    }
    console.log(`  ✅ ${Object.keys(regMap).length} registrations`);

    // --- STEP C: Active Children ---
    console.log('\n👶 Importing active children...');
    let childCount = 0;

    for (const row of activeSheet.data) {
      const leadId = String(row[6] || '').trim();
      const regId = regMap[leadId] || null;

      // Determine academic year from the linked registration
      let acadYear = '';
      if (regId) {
        const [reg] = await trx('registrations').where({ id: regId }).select('start_date');
        if (reg && reg.start_date) {
          const d = new Date(reg.start_date);
          const yr = d.getFullYear();
          const m = d.getMonth() + 1;
          acadYear = (m > 8 || (m === 8 && d.getDate() >= 10)) ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
        }
      }

      const cls = row[1] || 'כללי';
      const classroomId = classroomMap[`${cls}|${acadYear}`] || null;

      await trx('children').insert({
        registration_id: regId,
        child_name: row[0] || '',
        birth_date: row[2] ? new Date(row[2]) : null,
        classroom_id: classroomId,
        parent_name: row[3] || '',
        phone: row[4] || '',
        medical_alerts: row[5] || '',
        is_active: true,
        academic_year: acadYear || 'unknown',
      });
      childCount++;
    }
    console.log(`  ✅ ${childCount} active children`);

    // --- STEP D: Archives ---
    console.log('\n📦 Importing archives...');
    let archiveCount = 0;

    const importArchive = async (data, type) => {
      for (const row of data) {
        const uniqueId = String(row[1] || '').trim();
        let config = {};
        try { config = JSON.parse(row[11] || '{}'); } catch (e) {}

        const startDate = row[7] ? new Date(row[7]) : null;
        let acadYear = '';
        if (startDate) {
          const yr = startDate.getFullYear();
          const m = startDate.getMonth() + 1;
          acadYear = (m > 8 || (m === 8 && startDate.getDate() >= 10)) ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
        }

        await trx('archives').insert({
          registration_id: null,
          archive_type: type,
          original_data: JSON.stringify({ row, config }),
          child_name: row[2] || '',
          classroom_name: row[3] || '',
          academic_year: acadYear,
          archived_at: row[13] ? new Date(row[13]) : new Date(),
        });
        archiveCount++;
      }
    };

    await importArchive(signedArchive.data, 'signed');
    await importArchive(unsignedArchive.data, 'unsigned');
    console.log(`  ✅ ${archiveCount} archived records`);

    // --- STEP E: Collections ---
    console.log('\n💰 Importing collections...');
    // Collections sheet: [Lead_ID, Academic_Year, Reg_Fee, Sept..Aug (12 cols), Last_Update, Exit_Month]
    // Month columns: indices 3-14 (Sept=3, Oct=4, ..., Aug=14)
    let collCount = 0;

    for (const row of collectionsSheet.data) {
      const leadId = String(row[0] || '').trim();
      const acadYear = String(row[1] || '').trim();
      const regId = regMap[leadId] || null;

      if (!leadId) continue;

      const [collInserted] = await trx('collections').insert({
        registration_id: regId,
        academic_year: acadYear,
        registration_fee_receipt: 0,
        exit_month: row[16] && row[16] !== 'פעיל' ? parseInt(row[16]) : null,
        last_updated: row[15] ? new Date(row[15]) : new Date(),
      }).returning('id');

      const collId = collInserted.id;

      // Months: Sept(9)=col3, Oct(10)=col4, Nov(11)=col5, Dec(12)=col6
      //         Jan(1)=col7, Feb(2)=col8, Mar(3)=col9, Apr(4)=col10
      //         May(5)=col11, Jun(6)=col12, Jul(7)=col13, Aug(8)=col14
      const monthColMap = {
        9: 3, 10: 4, 11: 5, 12: 6,
        1: 7, 2: 8, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 14,
      };

      // Reg fee column
      const regFeeReceipt = row[2] || '';

      for (const [monthNum, colIdx] of Object.entries(monthColMap)) {
        const receiptVal = row[colIdx] || '';
        await trx('collection_months').insert({
          collection_id: collId,
          month_number: parseInt(monthNum),
          receipt_number: receiptVal,
          payment_status: receiptVal ? 'paid' : 'pending',
        });
      }
      collCount++;
    }
    console.log(`  ✅ ${collCount} collection records`);

    // --- STEP F: Create admin user ---
    console.log('\n👤 Creating admin user...');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    await trx('users').insert({
      email: 'admin@ganhalomot.co.il',
      password_hash: hash,
      full_name: 'מנהלת המערכת',
      role: 'admin',
    }).onConflict('email').ignore();
    console.log('  ✅ Admin user created (email: admin@ganhalomot.co.il, password: admin123)');

    // Commit
    await trx.commit();
    console.log('\n✨ Migration completed successfully!');

  } catch (err) {
    await trx.rollback();
    console.error('\n❌ Migration failed! Transaction rolled back.');
    console.error(err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

run().catch(console.error);
