const https = require('https');
const { Registration, Child, Collection, Classroom, Branch } = require('../models');

const SPREADSHEET_ID = '1H-pCIZQEIm6aXYfgZt_ZU6LXn6rUIfh7t1j6N0adpy0';

function fetchCSV(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (r2) => {
          let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(d));
        }).on('error', reject);
        return;
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const lines = []; let current = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { inQ = !inQ; current += '"'; }
    else if (text[i] === '\n' && !inQ) { lines.push(current); current = ''; }
    else current += text[i];
  }
  if (current.trim()) lines.push(current);

  return lines.map(line => {
    const cols = []; let cell = '', q = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { if (q && line[i+1] === '"') { cell += '"'; i++; } else q = !q; }
      else if (line[i] === ',' && !q) { cols.push(cell); cell = ''; }
      else cell += line[i];
    }
    cols.push(cell);
    return cols;
  });
}

function parseDate(str) {
  if (!str) return null;
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

async function syncFromSheets(req, res, next) {
  try {
    const results = { registrations: 0, children: 0, collections: 0, updated: 0 };

    // Find kaplan branch
    const kaplan = await Branch.findOne({ name: /קפלן/ });
    if (!kaplan) return res.status(400).json({ error: 'סניף קפלן לא נמצא' });

    // Read sheets
    const leadsCSV = await fetchCSV('הסכמי התקשרות');
    const activeCSV = await fetchCSV('ילדים פעילים');
    const collectionsCSV = await fetchCSV('מעקב גבייה');

    const leads = parseCSV(leadsCSV);
    const active = parseCSV(activeCSV);
    const collections = parseCSV(collectionsCSV);

    // Sync registrations
    for (let i = 1; i < leads.length; i++) {
      const row = leads[i];
      const uniqueId = (row[1] || '').trim();
      if (!uniqueId) continue;

      let config = {};
      try { config = JSON.parse(row[11] || '{}'); } catch {}

      const cls = row[3] || 'כללי';
      const startDate = parseDate(row[7]);
      const acadYear = getAcademicYear(startDate);
      let classroom = await Classroom.findOne({ name: cls, branch_id: kaplan._id, is_active: true });
      if (!classroom) {
        classroom = await Classroom.create({ name: cls, academic_year: acadYear || '2025-2026', branch_id: kaplan._id, capacity: 35 });
      }

      const existing = await Registration.findOne({ unique_id: uniqueId });
      if (existing) {
        // Update status
        const newStatus = (row[9] === 'כן' && row[10] === 'כן') ? 'completed' : (row[9] === 'כן' ? 'contract_signed' : 'link_generated');
        if (existing.status !== newStatus || existing.monthly_fee !== parseFloat(row[6])) {
          existing.status = newStatus;
          existing.agreement_signed = row[9] === 'כן';
          existing.card_completed = row[10] === 'כן';
          existing.monthly_fee = parseFloat(row[6]) || existing.monthly_fee;
          existing.classroom_id = classroom._id;
          await existing.save();
          results.updated++;
        }
        continue;
      }

      await Registration.create({
        unique_id: uniqueId, branch_id: kaplan._id,
        child_name: row[2] || '', classroom_id: classroom._id,
        parent_name: row[4] || '', parent_id_number: row[5] || '',
        parent_phone: config.phone || '', parent_email: config.parentEmail || '',
        monthly_fee: parseFloat(row[6]) || 0,
        registration_fee: parseFloat(config.regFee) || 0,
        start_date: startDate || new Date('2025-09-01'),
        end_date: parseDate(row[8]) || new Date('2026-08-10'),
        status: (row[9] === 'כן' && row[10] === 'כן') ? 'completed' : 'link_generated',
        agreement_signed: row[9] === 'כן',
        card_completed: row[10] === 'כן',
        configuration: config,
        child_birth_date: parseDate(row[12]) || parseDate(config.childBirthDate) || null,
      });
      results.registrations++;
    }

    // Sync active children
    for (let i = 1; i < active.length; i++) {
      const row = active[i];
      const childName = (row[0] || '').trim();
      const leadId = (row[6] || '').trim();
      if (!childName) continue;

      const reg = leadId ? await Registration.findOne({ unique_id: leadId }) : null;
      const existing = await Child.findOne({ child_name: childName, registration_id: reg?._id });
      if (existing) continue;

      const cls = row[1] || 'כללי';
      const classroom = await Classroom.findOne({ name: cls, branch_id: kaplan._id, is_active: true });

      await Child.create({
        registration_id: reg?._id || null,
        child_name: childName,
        birth_date: parseDate(row[2]),
        classroom_id: classroom?._id || null,
        parent_name: row[3] || '',
        phone: row[4] || '',
        medical_alerts: row[5] || '',
        is_active: true,
        academic_year: reg ? getAcademicYear(new Date(reg.start_date)) : '2025-2026',
      });
      results.children++;
    }

    // Sync collections (receipt numbers)
    const monthColMap = { 9: 2, 10: 3, 11: 4, 12: 5, 1: 6, 2: 7, 3: 8, 4: 9, 5: 10, 6: 11, 7: 12, 8: 13 };

    for (let i = 1; i < collections.length; i++) {
      const row = collections[i];
      const leadId = (row[0] || '').trim();
      if (!leadId) continue;

      const reg = await Registration.findOne({ unique_id: leadId });
      if (!reg) continue;

      let coll = await Collection.findOne({ registration_id: reg._id });

      const months = [];
      for (const [monthNum, colIdx] of Object.entries(monthColMap)) {
        const val = (row[colIdx] || '').trim();
        if (!val) continue;
        months.push({
          month_number: parseInt(monthNum),
          receipt_number: val,
          payment_status: 'paid',
        });
      }

      if (!coll && months.length > 0) {
        const child = await Child.findOne({ registration_id: reg._id, is_active: true });
        await Collection.create({
          registration_id: reg._id,
          child_id: child?._id || null,
          academic_year: (row[1] || '').trim() || '2025-2026',
          months,
        });
        results.collections++;
      } else if (coll) {
        // Update existing months
        for (const m of months) {
          const existingIdx = coll.months.findIndex(cm => cm.month_number === m.month_number);
          if (existingIdx >= 0) {
            if (coll.months[existingIdx].receipt_number !== m.receipt_number) {
              coll.months[existingIdx].receipt_number = m.receipt_number;
              coll.months[existingIdx].payment_status = 'paid';
            }
          } else {
            coll.months.push(m);
          }
        }
        await coll.save();
      }
    }

    res.json({
      message: 'סנכרון הושלם',
      results,
      summary: `${results.registrations} רישומים חדשים, ${results.updated} עודכנו, ${results.children} ילדים חדשים, ${results.collections} גביות חדשות`,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { syncFromSheets };
