/**
 * Migration script for the legacy Google Apps Script kindergarten registration system.
 *
 * Source data: 2 CSV files exported from the old Google Sheet.
 *   - "הסכמי התקשרות" (active leads, both signed and unsigned)
 *   - "ארכיון - נחתמו" (signed records that were deleted from the active sheet)
 *
 * Each row has a Configuration_JSON column (col L) with the full payload:
 *   parent IDs, child id, signature, registrationCard (parent1/parent2/child),
 *   files.id, files.payment, contractPdfUrl.
 *
 * The script supports two modes:
 *   --dry-run  (default)  Parse CSVs, dedupe against MongoDB, print stats. No writes.
 *   --commit              Actually create Registration + Child + Contract records.
 *
 * Branch: hard-coded to "כפר סבא - קפלן" (the legacy system was used at Kaplan only).
 *
 * Usage:
 *   node scripts/migrate-old-contracts.js
 *   node scripts/migrate-old-contracts.js --commit
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');

const Branch = require('../src/models/Branch');
const Classroom = require('../src/models/Classroom');
const Registration = require('../src/models/Registration');
const Child = require('../src/models/Child');
const Contract = require('../src/models/Contract');
const Document = require('../src/models/Document');
const fileStorage = require('../src/services/file-storage.service');

const DOWNLOADS = '/Users/amitkohta/Downloads';
const FILE_LEADS = `${DOWNLOADS}/רישום הורים - סניף קפלן - אפליקצייה - הסכמי התקשרות.csv`;
const FILE_ARCHIVE = `${DOWNLOADS}/רישום הורים - סניף קפלן - אפליקצייה - ארכיון - נחתמו.csv`;

const COMMIT = process.argv.includes('--commit');

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  // Handle DD/MM/YYYY [HH:MM:SS]
  const m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2}):(\d{1,2}):?(\d{0,2}))?$/);
  if (m) {
    const [, dd, mm, yyyy, hh = 0, mi = 0, ss = 0] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss) || 0);
    return isNaN(d.getTime()) ? null : d;
  }
  // ISO format
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function deriveAcademicYear(startDate) {
  const d = parseDate(startDate);
  if (!d) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // Aug 10+ rolls into the next academic year
  const after = m > 8 || (m === 8 && day >= 10);
  const start = after ? y : y - 1;
  return `${start}-${start + 1}`;
}

function normalizeId(id) {
  if (!id) return null;
  return String(id).replace(/\D/g, '').trim() || null;
}

function loadCsv(filePath) {
  const buf = fs.readFileSync(filePath);
  const records = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  return records;
}

function parseConfig(row) {
  try {
    return JSON.parse(row.Configuration_JSON || '{}');
  } catch (e) {
    return null;
  }
}

function rowToRecord(row, source) {
  const cfg = parseConfig(row);
  if (!cfg) {
    return { ok: false, reason: 'invalid_json', uniqueId: row.Unique_ID, raw: row };
  }

  const parentIdRaw = row.Parent_ID || cfg.parentId || '';
  const childIdRaw = cfg.registrationCard?.child?.id || '';
  const childName = (row.Child_Name || cfg.childName || '').trim();
  const parentName = (row.Parent_Name || cfg.parentName || '').trim();
  const classroom = (row.Classroom || cfg.classroom || '').trim();
  const startDate = row.Start_Date || cfg.startDate;
  const endDate = row.End_Date || cfg.endDate;
  const monthlyFee = parseFloat(row.Monthly_Fee || cfg.monthlyFee || 0) || 0;

  return {
    ok: true,
    source,
    uniqueId: row.Unique_ID,
    parentIdRaw,
    parentId: normalizeId(parentIdRaw),
    childIdRaw,
    childId: normalizeId(childIdRaw),
    childName,
    parentName,
    classroom,
    startDate,
    endDate,
    monthlyFee,
    regFee: parseFloat(cfg.regFee || 0) || 0,
    parent1: cfg.registrationCard?.parent1 || null,
    parent2: cfg.registrationCard?.parent2 || null,
    childInfo: cfg.registrationCard?.child || null,
    childBirthDate: row.Child_Birth_Date || cfg.childBirthDate,
    phone: cfg.phone || cfg.registrationCard?.parent1?.mobile,
    email: cfg.parentEmail || cfg.registrationCard?.parent1?.email || cfg.registrationCard?.parent2?.email,
    medical: cfg.medical || '',
    address: cfg.registrationCard?.parent1?.address,
    signature: cfg.signature || null,
    contractPdfUrl: cfg.contractPdfUrl || null,
    fileIdId: cfg.files?.id || null,
    filePaymentId: cfg.files?.payment || null,
    signed: row.Agreement_Signed === 'כן',
    cardCompleted: row.Card_Completed === 'כן',
    rawTimestamp: row.Timestamp,
  };
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MIGRATION SCRIPT - ${COMMIT ? 'COMMIT MODE (writes to DB!)' : 'DRY RUN (read-only)'}`);
  console.log(`${'='.repeat(70)}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  const kaplan = await Branch.findOne({ name: /קפלן/ });
  if (!kaplan) throw new Error('Kaplan branch not found');
  console.log(`✅ Kaplan Branch: ${kaplan._id}`);

  // 1. Load CSVs
  console.log('\n--- Loading CSVs ---');
  const leadsRows = loadCsv(FILE_LEADS);
  console.log(`Active leads: ${leadsRows.length}`);
  const archiveRows = loadCsv(FILE_ARCHIVE);
  console.log(`Archive (signed): ${archiveRows.length}`);

  const allRecords = [
    ...leadsRows.map(r => rowToRecord(r, 'leads')),
    ...archiveRows.map(r => rowToRecord(r, 'archive')),
  ];

  // 2. Filter validity
  const valid = allRecords.filter(r => r.ok);
  const invalid = allRecords.filter(r => !r.ok);
  console.log(`\n✅ Valid records: ${valid.length}`);
  console.log(`❌ Invalid records (bad JSON): ${invalid.length}`);
  invalid.forEach(r => console.log(`   - ${r.uniqueId} (${r.reason})`));

  // 3. Stats
  const academicYears = new Set();
  const classrooms = new Set();
  valid.forEach(r => {
    const ay = deriveAcademicYear(r.startDate);
    if (ay) academicYears.add(ay);
    if (r.classroom) classrooms.add(r.classroom);
  });

  console.log(`\n📅 Academic years found: ${[...academicYears].sort().join(', ')}`);
  console.log(`🏫 Classroom names found: ${[...classrooms].join(', ')}`);

  // Withouts
  const noParentId = valid.filter(r => !r.parentId);
  const noContractPdf = valid.filter(r => !r.contractPdfUrl);
  const noSignature = valid.filter(r => !r.signature);
  console.log(`\n📋 Missing parent ID: ${noParentId.length}`);
  console.log(`📄 Missing contract PDF URL: ${noContractPdf.length}`);
  console.log(`✍️  Missing signature: ${noSignature.length}`);

  // 4. Dedup against existing DB
  console.log('\n--- Checking duplicates against existing DB ---');
  const existingRegs = await Registration.find({ branch_id: kaplan._id })
    .select('parent_id_number child_name unique_id parent_name')
    .lean();
  const existingChildren = await Child.find({}).select('parent_id_number child_id_number child_name registration_id').lean();
  console.log(`Existing Registrations in Kaplan: ${existingRegs.length}`);

  const existingByParentId = new Map();
  existingRegs.forEach(r => {
    if (r.parent_id_number) {
      const key = normalizeId(r.parent_id_number);
      if (!existingByParentId.has(key)) existingByParentId.set(key, []);
      existingByParentId.get(key).push(r);
    }
  });
  const existingByChildId = new Map();
  existingChildren.forEach(c => {
    if (c.child_id_number) {
      const key = normalizeId(c.child_id_number);
      if (!existingByChildId.has(key)) existingByChildId.set(key, []);
      existingByChildId.get(key).push(c);
    }
  });

  const willMigrate = [];
  const conflicts = [];
  const seenInBatch = new Map(); // dedup within the import batch itself

  valid.forEach(r => {
    // skip rows that have nothing useful
    if (!r.parentId && !r.childName) {
      return; // truly empty
    }

    let conflict = null;
    if (r.parentId && existingByParentId.has(r.parentId)) {
      // Same parent already in DB. Check if same child.
      const matches = existingByParentId.get(r.parentId);
      const sameChild = matches.find(m => (m.child_name || '').trim() === r.childName.trim());
      if (sameChild) {
        conflict = { type: 'parent_id+child_name', existing: sameChild };
      } else {
        conflict = { type: 'parent_id_only_diff_child', existing: matches[0] };
      }
    } else if (r.childId && existingByChildId.has(r.childId)) {
      conflict = { type: 'child_id', existing: existingByChildId.get(r.childId)[0] };
    }

    // Dedup within the batch (sometimes a row appears in BOTH leads and archive)
    const batchKey = `${r.parentId || ''}::${r.childName}::${r.startDate}`;
    if (seenInBatch.has(batchKey)) {
      conflicts.push({ ...r, conflictType: 'duplicate_in_csv', existing: seenInBatch.get(batchKey) });
      return;
    }
    seenInBatch.set(batchKey, r);

    if (conflict) {
      conflicts.push({ ...r, conflictType: conflict.type, existing: conflict.existing });
    } else {
      willMigrate.push(r);
    }
  });

  console.log(`\n✅ Will MIGRATE (new): ${willMigrate.length}`);
  console.log(`⚠️  CONFLICTS: ${conflicts.length}`);
  if (conflicts.length > 0) {
    console.log(`\n--- Conflict breakdown ---`);
    const types = {};
    conflicts.forEach(c => { types[c.conflictType] = (types[c.conflictType] || 0) + 1; });
    Object.entries(types).forEach(([t, n]) => console.log(`   ${t}: ${n}`));
  }

  // 4b. Enrichment analysis: how many existing records have missing data we could fill
  console.log(`\n--- Enrichment opportunities for EXISTING records ---`);
  const enrichable = [];
  for (const c of conflicts) {
    if (c.conflictType !== 'parent_id+child_name') continue;
    const existing = c.existing;
    const fullExisting = await Registration.findById(existing._id).lean();
    const reasons = [];
    if (!fullExisting.signature_data && c.signature) reasons.push('signature');
    if (!fullExisting.contract_pdf_path && c.contractPdfUrl) reasons.push('contract_pdf');
    if (!fullExisting.configuration?.registrationCard && c.parent1) reasons.push('registrationCard');
    const contractCount = await Contract.countDocuments({ registration_id: existing._id });
    if (contractCount === 0 && c.contractPdfUrl) reasons.push('contract_doc');
    if (reasons.length > 0) {
      enrichable.push({ ...c, registration_id: existing._id, missing: reasons });
    }
  }
  console.log(`Existing records that can be enriched: ${enrichable.length}`);
  if (enrichable.length > 0) {
    const allMissing = {};
    enrichable.forEach(e => e.missing.forEach(m => { allMissing[m] = (allMissing[m] || 0) + 1; }));
    Object.entries(allMissing).forEach(([k, v]) => console.log(`   - missing ${k}: ${v} records`));
  }

  // 5. Sample preview
  console.log(`\n--- Sample records to migrate (first 3) ---`);
  willMigrate.slice(0, 3).forEach((r, i) => {
    console.log(`\n[${i + 1}] ${r.childName} (${r.parentName})`);
    console.log(`    Parent ID: ${r.parentId} | Child ID: ${r.childId || 'N/A'}`);
    console.log(`    Classroom: ${r.classroom} | Year: ${deriveAcademicYear(r.startDate)}`);
    console.log(`    Fee: ${r.monthlyFee} ₪ | RegFee: ${r.regFee} ₪`);
    console.log(`    Phone: ${r.phone} | Email: ${r.email || 'N/A'}`);
    console.log(`    Has signature: ${!!r.signature} | Has PDF URL: ${!!r.contractPdfUrl}`);
    console.log(`    PDF: ${r.contractPdfUrl?.substring(0, 80) || 'none'}`);
  });

  // Final summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total CSV rows scanned:       ${allRecords.length}`);
  console.log(`Valid (parsed JSON):          ${valid.length}`);
  console.log(`Invalid:                      ${invalid.length}`);
  console.log(`Conflicts (already in DB):    ${conflicts.length}`);
  console.log(`Will be migrated as NEW:      ${willMigrate.length}`);
  console.log(`  - With contract PDF:        ${willMigrate.filter(r => r.contractPdfUrl).length}`);
  console.log(`  - With signature:           ${willMigrate.filter(r => r.signature).length}`);
  console.log(`  - With ID file:             ${willMigrate.filter(r => r.fileIdId).length}`);
  console.log(`  - With payment file:        ${willMigrate.filter(r => r.filePaymentId).length}`);
  console.log(`${'='.repeat(70)}\n`);

  if (!COMMIT) {
    console.log('💡 To actually migrate, run with --commit');
    await mongoose.disconnect();
    return;
  }

  // ============ COMMIT MODE ============
  console.log('🚨 COMMIT MODE — starting actual writes\n');

  // Pre-cache classrooms
  const classroomsCache = new Map(); // key: name|year, value: classroom._id
  async function getClassroom(name, academicYear) {
    if (!name || !academicYear) return null;
    const key = `${name}|${academicYear}`;
    if (classroomsCache.has(key)) return classroomsCache.get(key);
    let cls = await Classroom.findOne({
      name,
      academic_year: academicYear,
      branch_id: kaplan._id,
    });
    if (!cls) {
      // Auto-create missing classroom for year (e.g. 2024-2025, 2026-2027)
      let category = null;
      if (name.includes('תינוקייה')) category = 'תינוקייה';
      else if (name.includes('צעירים')) category = 'צעירים';
      else if (name.includes('בוגרים')) category = 'בוגרים';
      cls = await Classroom.create({
        name,
        category,
        academic_year: academicYear,
        branch_id: kaplan._id,
        is_active: true,
      });
      console.log(`   📚 Created Classroom: ${name} (${academicYear})`);
    }
    classroomsCache.set(key, cls._id);
    return cls._id;
  }

  async function downloadDriveFile(driveIdOrUrl) {
    let id = driveIdOrUrl;
    const m = String(driveIdOrUrl).match(/\/d\/([^/?]+)/) || String(driveIdOrUrl).match(/id=([^&]+)/);
    if (m) id = m[1];
    if (!id || id.length < 10) throw new Error(`Invalid Drive ID: ${driveIdOrUrl}`);

    const url = `https://drive.google.com/uc?export=download&id=${id}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error(`Downloaded file too small (${buf.length} bytes) — likely a Google warning page`);

    // Check if response is HTML (virus scan warning page from Drive for large files)
    const head = buf.slice(0, 200).toString('utf-8');
    if (head.startsWith('<!DOCTYPE') || head.includes('<html')) {
      throw new Error('Drive returned an HTML warning page instead of the file');
    }

    return buf;
  }

  let stats = { created: 0, enriched: 0, contractsAdded: 0, documentsAdded: 0, errors: 0, r2Skipped: 0 };
  const r2Configured = !!process.env.R2_ENDPOINT && !!process.env.R2_ACCESS_KEY_ID;
  if (!r2Configured) {
    console.log('   ⚠️  R2_ENDPOINT not configured locally — Documents (ID/Payment) will be skipped.');
    console.log('       Contract PDFs will still be saved as base64 in MongoDB.\n');
  }

  // ===== Phase 1: CREATE new registrations =====
  console.log(`\n--- Phase 1: Creating ${willMigrate.length} new registrations ---`);
  for (const r of willMigrate) {
    try {
      const academicYear = deriveAcademicYear(r.startDate);
      const classroomId = await getClassroom(r.classroom, academicYear);

      const startDate = parseDate(r.startDate);
      const endDate = parseDate(r.endDate);
      const childBirthParsed = parseDate(r.childBirthDate);
      const signedAt = parseDate(r.rawTimestamp);

      const config = {
        startDate: r.startDate,
        endDate: r.endDate,
        startTime: '07:00',
        endTime: '17:00',
        friTime: '07:30-12:30',
        regFee: r.regFee,
        registrationCard: {
          child: r.childInfo,
          parent1: r.parent1,
          parent2: r.parent2,
        },
        files: { id: r.fileIdId, payment: r.filePaymentId },
        signature: r.signature,
        legacy_unique_id: r.uniqueId,
        legacy_imported_at: new Date().toISOString(),
      };

      const reg = await Registration.create({
        unique_id: r.uniqueId,
        branch_id: kaplan._id,
        classroom_id: classroomId,
        child_name: r.childName,
        child_birth_date: childBirthParsed,
        parent_name: r.parentName,
        parent_id_number: r.parentId,
        parent_phone: r.phone,
        parent_email: r.email,
        monthly_fee: r.monthlyFee,
        registration_fee: r.regFee,
        start_date: startDate,
        end_date: endDate,
        status: r.signed ? 'completed' : 'link_generated',
        agreement_signed: r.signed,
        card_completed: r.cardCompleted,
        signature_data: r.signature,
        contract_pdf_path: r.contractPdfUrl,
        configuration: config,
      });

      // Create child
      await Child.create({
        registration_id: reg._id,
        child_name: r.childName,
        child_id_number: r.childId,
        birth_date: childBirthParsed,
        classroom_id: classroomId,
        parent_name: r.parentName,
        parent_id_number: r.parentId,
        phone: r.phone,
        email: r.email,
        parent2_name: r.parent2 ? `${r.parent2.name || ''} ${r.parent2.lastName || ''}`.trim() : null,
        parent2_id_number: r.parent2 ? normalizeId(r.parent2.id) : null,
        parent2_phone: r.parent2?.mobile,
        parent2_email: r.parent2?.email,
        address: r.address,
        medical_alerts: r.medical,
        academic_year: academicYear,
        is_active: true,
      });

      stats.created++;
      console.log(`   ✅ Created: ${r.childName} (${r.uniqueId})`);

      // Try to download contract PDF
      if (r.contractPdfUrl) {
        try {
          const buf = await downloadDriveFile(r.contractPdfUrl);
          await Contract.create({
            registration_id: reg._id,
            branch_id: kaplan._id,
            type: 'enrollment',
            doc_type: 'enrollment_contract',
            file_name: `Contract_${r.childName}_${r.uniqueId}.pdf`,
            file_data: buf.toString('base64'),
            file_mimetype: 'application/pdf',
            status: 'signed',
            signed_at: r.signed ? signedAt : null,
          });
          stats.contractsAdded++;
          console.log(`      📄 Contract PDF downloaded (${(buf.length / 1024).toFixed(1)} KB)`);
        } catch (e) {
          console.log(`      ⚠️  PDF download failed: ${e.message}`);
        }
      }

      // Upload ID + Payment files to R2
      for (const [fileKey, label] of [['fileIdId', 'id_card'], ['filePaymentId', 'payment_proof']]) {
        const driveId = r[fileKey];
        if (!driveId) continue;
        if (!r2Configured) { stats.r2Skipped++; continue; }
        try {
          const buf = await downloadDriveFile(driveId);
          const ext = label === 'id_card' ? 'jpg' : 'pdf';
          const key = `documents/${r.uniqueId}/${label}_${Date.now()}.${ext}`;
          await fileStorage.upload(buf, key, ext === 'pdf' ? 'application/pdf' : 'image/jpeg');
          await Document.create({
            registration_id: reg._id,
            doc_type: label,
            file_name: `${label}.${ext}`,
            file_path: key,
            mime_type: ext === 'pdf' ? 'application/pdf' : 'image/jpeg',
            file_size_bytes: buf.length,
          });
          stats.documentsAdded++;
          console.log(`      📎 ${label}: uploaded to R2 (${(buf.length / 1024).toFixed(1)} KB)`);
        } catch (e) {
          console.log(`      ⚠️  ${label} upload failed: ${e.message}`);
        }
      }
    } catch (e) {
      stats.errors++;
      console.log(`   ❌ Failed: ${r.childName} (${r.uniqueId}): ${e.message}`);
    }
  }

  // ===== Phase 2: ENRICH existing records =====
  console.log(`\n--- Phase 2: Enriching ${enrichable.length} existing records ---`);
  for (const e of enrichable) {
    try {
      const reg = await Registration.findById(e.registration_id);
      if (!reg) continue;

      const update = {};
      if (e.missing.includes('signature') && e.signature) {
        update.signature_data = e.signature;
      }
      if (e.missing.includes('contract_pdf') && e.contractPdfUrl) {
        update.contract_pdf_path = e.contractPdfUrl;
      }
      if (e.missing.includes('registrationCard') && e.parent1) {
        const cfg = reg.configuration || {};
        cfg.registrationCard = {
          child: e.childInfo,
          parent1: e.parent1,
          parent2: e.parent2,
        };
        cfg.legacy_enriched_at = new Date().toISOString();
        update.configuration = cfg;
      }

      if (Object.keys(update).length > 0) {
        await Registration.updateOne({ _id: reg._id }, { $set: update });
        stats.enriched++;
        console.log(`   ✏️  Enriched: ${e.childName} (added: ${e.missing.filter(m => m !== 'contract_doc').join(', ')})`);
      }

      // Add Contract document
      if (e.missing.includes('contract_doc') && e.contractPdfUrl) {
        try {
          const buf = await downloadDriveFile(e.contractPdfUrl);
          await Contract.create({
            registration_id: reg._id,
            branch_id: kaplan._id,
            type: 'enrollment',
            doc_type: 'enrollment_contract',
            file_name: `Contract_${e.childName}_${e.uniqueId}.pdf`,
            file_data: buf.toString('base64'),
            file_mimetype: 'application/pdf',
            status: 'signed',
            signed_at: e.signed ? parseDate(e.rawTimestamp) : null,
          });
          stats.contractsAdded++;
          console.log(`      📄 Contract PDF added (${(buf.length / 1024).toFixed(1)} KB)`);
        } catch (err) {
          console.log(`      ⚠️  PDF download failed: ${err.message}`);
        }
      }

      // Files
      for (const [fileKey, label] of [['fileIdId', 'id_card'], ['filePaymentId', 'payment_proof']]) {
        const driveId = e[fileKey];
        if (!driveId) continue;
        const existingDoc = await Document.findOne({ registration_id: reg._id, doc_type: label });
        if (existingDoc) continue;
        if (!r2Configured) { stats.r2Skipped++; continue; }
        try {
          const buf = await downloadDriveFile(driveId);
          const ext = label === 'id_card' ? 'jpg' : 'pdf';
          const key = `documents/${reg.unique_id}/${label}_${Date.now()}.${ext}`;
          await fileStorage.upload(buf, key, ext === 'pdf' ? 'application/pdf' : 'image/jpeg');
          await Document.create({
            registration_id: reg._id,
            doc_type: label,
            file_name: `${label}.${ext}`,
            file_path: key,
            mime_type: ext === 'pdf' ? 'application/pdf' : 'image/jpeg',
            file_size_bytes: buf.length,
          });
          stats.documentsAdded++;
          console.log(`      📎 ${label}: uploaded`);
        } catch (err) {
          console.log(`      ⚠️  ${label} upload failed: ${err.message}`);
        }
      }
    } catch (err) {
      stats.errors++;
      console.log(`   ❌ Enrich failed: ${e.childName}: ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`✅ MIGRATION COMPLETE`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Created:           ${stats.created}`);
  console.log(`Enriched:          ${stats.enriched}`);
  console.log(`Contracts added:   ${stats.contractsAdded}`);
  console.log(`Documents added:   ${stats.documentsAdded}`);
  console.log(`Errors:            ${stats.errors}`);
  console.log(`${'='.repeat(70)}\n`);

  await mongoose.disconnect();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
