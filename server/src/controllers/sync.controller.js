const https = require('https');
const { Registration, Child, Collection, Classroom, Branch, Document } = require('../models');

const SPREADSHEET_ID = '1H-pCIZQEIm6aXYfgZt_ZU6LXn6rUIfh7t1j6N0adpy0';

/**
 * Read a response body as UTF-8 — the whole body, decoded once.
 *
 * The sheet arrives as a stream of Buffers, and a Hebrew letter is two bytes in
 * UTF-8. `text += chunk` decodes each chunk on its own, so a letter that
 * happens to straddle a chunk boundary is decoded as two orphaned halves and
 * comes out as U+FFFD. One mangled character per sheet, in a different place
 * on every run.
 *
 * That is where "בוגר�ם" came from, and it mattered because the classroom
 * lookup below was by name: a mangled name matched no room, so the sync
 * created one, and created another the next run. Nineteen junk classrooms,
 * every one of them counted in the dashboard's approved capacity.
 */
function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function fetchCSV(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, r2 => readBody(r2).then(resolve, reject)).on('error', reject);
        return;
      }
      readBody(res).then(resolve, reject);
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

// Digits-only normalization for matching ת"ז across rows / registrations.
const normId = (s) => String(s || '').replace(/\D/g, '');

// Build a { parent-ת"ז → signature data-URI } map from the contracts sheet.
// Old-system contracts stored the parent's digital signature inside the config
// JSON (col 11) as a data:image. Children often have several rows (early manual
// import without a signature + a later digitally-signed row), so keying by the
// parent's ת"ז lets us attach a recovered signature to whichever registration
// is active in the new system.
function buildSignatureMap(leads) {
  const map = {};
  for (let i = 1; i < leads.length; i++) {
    const row = leads[i];
    if (!row) continue;
    let cfg = {};
    try { cfg = JSON.parse(row[11] || '{}'); } catch { cfg = {}; }
    const sig = (typeof cfg.signature === 'string' && cfg.signature.startsWith('data:image'))
      ? cfg.signature : null;
    if (!sig) continue;
    const pid = normId(row[5]);
    if (pid && !map[pid]) map[pid] = sig;
  }
  return map;
}

/**
 * The room the sheet names, or nothing.
 *
 * This used to create the room when the name matched none. A sync has no
 * business inventing classrooms: it knows a name and a capacity guess and
 * nothing else, so what it created carried no age-group category — and a room
 * without a category is never offered on the placement screen. That is how a
 * gan ends up holding ten rooms for a year and unable to place one child into
 * any of them.
 *
 * A name that matches nothing is reported back to whoever pressed סנכרון, and
 * the registration is left without a room. "Not placed" is a state every
 * screen already knows how to show; a room that exists only because of a typo
 * is not.
 */
async function findClassroom(name, branchId, academicYear, unmatched) {
  // The room of the child's own year first — a gan reuses room names every
  // year, and matching on name alone hands next year's child last year's room.
  const room = (academicYear && await Classroom.findOne({
    name, branch_id: branchId, academic_year: academicYear, is_active: true,
  })) || await Classroom.findOne({ name, branch_id: branchId, is_active: true });
  if (!room) unmatched.add(name);
  return room;
}

const driveView = (fileId) => `https://drive.google.com/file/d/${fileId}/view`;

// Build a { parent-ת"ז → [{doc_type, file_name, external_url}] } map from the
// contracts sheet. Old-system parents uploaded their ID copy + payment proof to
// Google Drive; the config JSON stores the Drive file IDs under `files`
// ({ id, payment }). We carry these over as external-URL Document records.
function buildFilesMap(leads) {
  const map = {};
  for (let i = 1; i < leads.length; i++) {
    const row = leads[i];
    if (!row) continue;
    let cfg = {};
    try { cfg = JSON.parse(row[11] || '{}'); } catch { cfg = {}; }
    const f = cfg.files;
    if (!f || typeof f !== 'object') continue;
    const pid = normId(row[5]);
    if (!pid || map[pid]) continue;
    const docs = [];
    if (f.id) docs.push({ doc_type: 'id_copy', file_name: 'צילום תעודת זהות', external_url: driveView(f.id) });
    if (f.payment) docs.push({ doc_type: 'payment_proof', file_name: 'אישור תשלום', external_url: driveView(f.payment) });
    if (docs.length) map[pid] = docs;
  }
  return map;
}

async function syncFromSheets(req, res, next) {
  try {
    const results = { registrations: 0, children: 0, collections: 0, updated: 0, signaturesAttached: 0, documentsAttached: 0 };
    // Room names in the sheet that match no classroom we hold. Reported rather
    // than conjured into existence — see findClassroom.
    const unmatchedRooms = new Set();

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
      const classroom = await findClassroom(cls, kaplan._id, acadYear, unmatchedRooms);

      const existing = await Registration.findOne({ unique_id: uniqueId });
      if (existing) {
        // Update status
        const newStatus = (row[9] === 'כן' && row[10] === 'כן') ? 'completed' : (row[9] === 'כן' ? 'contract_signed' : 'link_generated');
        if (existing.status !== newStatus || existing.monthly_fee !== parseFloat(row[6])) {
          existing.status = newStatus;
          existing.agreement_signed = row[9] === 'כן';
          existing.card_completed = row[10] === 'כן';
          existing.monthly_fee = parseFloat(row[6]) || existing.monthly_fee;
          // Only when we found one: a name that matched nothing must not
          // erase a room somebody assigned by hand on the classes screen.
          if (classroom) existing.classroom_id = classroom._id;
          await existing.save();
          results.updated++;
        }
        continue;
      }

      await Registration.create({
        unique_id: uniqueId, branch_id: kaplan._id,
        child_name: row[2] || '', classroom_id: classroom?._id || null,
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
      const classroom = await findClassroom(
        cls, kaplan._id, reg ? getAcademicYear(new Date(reg.start_date)) : null, unmatchedRooms,
      );

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
    // Sheet headers are misleading: col 2 = reg fee receipt, col 3 = Sept, ..., col 13 = Jul
    const monthColMap = { 9: 3, 10: 4, 11: 5, 12: 6, 1: 7, 2: 8, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13 };
    const regFeeColIdx = 2;

    // Normalize multi-receipt cells: "2584) 2515" → "2584 / 2515"
    function normalizeReceipt(val) {
      if (!val) return '';
      const parts = String(val).split(/[\s,/)]+/).map(s => s.trim()).filter(Boolean);
      return parts.join(' / ');
    }

    for (let i = 1; i < collections.length; i++) {
      const row = collections[i];
      const leadId = (row[0] || '').trim();
      if (!leadId) continue;

      const reg = await Registration.findOne({ unique_id: leadId });
      if (!reg) continue;

      let coll = await Collection.findOne({ registration_id: reg._id });

      const regFeeReceipt = normalizeReceipt(row[regFeeColIdx]) || null;
      const months = [];
      for (const [monthNum, colIdx] of Object.entries(monthColMap)) {
        const val = normalizeReceipt(row[colIdx]);
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
          registration_fee_receipt: regFeeReceipt,
          months,
        });
        results.collections++;
      } else if (coll) {
        // Update reg fee receipt
        if (regFeeReceipt && coll.registration_fee_receipt !== regFeeReceipt) {
          coll.registration_fee_receipt = regFeeReceipt;
        }
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

    // Backfill recovered signatures: attach a signature (from the contracts
    // sheet, matched by parent ת"ז) to every active registration that lacks one.
    // Handles duplicate registrations where the signature sits on a sibling uid.
    const sigMap = buildSignatureMap(leads);
    const regsForSig = await Registration.find({ branch_id: kaplan._id })
      .select('signature_data configuration parent_id_number');
    for (const reg of regsForSig) {
      if (reg.signature_data) continue;
      const fromConfig = reg.configuration && reg.configuration.signature;
      const sig = (typeof fromConfig === 'string' && fromConfig.startsWith('data:image'))
        ? fromConfig
        : sigMap[normId(reg.parent_id_number)];
      if (sig) {
        reg.signature_data = sig;
        await reg.save();
        results.signaturesAttached++;
      }
    }

    // Backfill recovered documents: parents' ID copy + payment proof were
    // uploaded to Google Drive in the old system (config.files = { id, payment }).
    // Carry them over as external-URL Document records, matched by parent ת"ז,
    // for registrations that have no documents yet.
    const filesMap = buildFilesMap(leads);
    for (const reg of regsForSig) {
      const docs = filesMap[normId(reg.parent_id_number)];
      if (!docs || !docs.length) continue;
      const existing = await Document.countDocuments({ registration_id: reg._id });
      if (existing > 0) continue;
      for (const d of docs) {
        await Document.create({
          registration_id: reg._id,
          doc_type: d.doc_type,
          file_name: d.file_name,
          external_url: d.external_url,
        });
        results.documentsAttached++;
      }
    }

    // Named last and separately: it is the one line that asks for a decision.
    // A room name the sheet uses and we do not hold means somebody has to
    // either open that room or fix the sheet, and the children on those rows
    // are sitting unplaced until they do.
    results.unmatchedRooms = [...unmatchedRooms];

    const unmatchedNote = results.unmatchedRooms.length
      ? ` · כיתות בגיליון שאין להן התאמה: ${results.unmatchedRooms.join(', ')} — הילדים בשורות האלה נשארו ללא שיבוץ`
      : '';

    res.json({
      message: 'סנכרון הושלם',
      results,
      summary: `${results.registrations} רישומים חדשים, ${results.updated} עודכנו, ${results.children} ילדים חדשים, ${results.collections} גביות חדשות, ${results.signaturesAttached} חתימות הושלמו, ${results.documentsAttached} מסמכים שוחזרו${unmatchedNote}`,
    });
  } catch (error) {
    next(error);
  }
}

// Read-only pre-check: report what a sync would do WITHOUT writing anything —
// which contract rows are missing from the new system, and how many signatures
// would be recovered (matched by parent ת"ז).
async function syncCheck(req, res, next) {
  try {
    const kaplan = await Branch.findOne({ name: /קפלן/ });
    if (!kaplan) return res.status(400).json({ error: 'סניף קפלן לא נמצא' });

    const leads = parseCSV(await fetchCSV('הסכמי התקשרות'));
    const sigMap = buildSignatureMap(leads);
    const filesMap = buildFilesMap(leads);

    const missingImports = [];
    let sheetRows = 0;
    for (let i = 1; i < leads.length; i++) {
      const row = leads[i];
      const uid = (row[1] || '').trim();
      if (!uid) continue;
      sheetRows++;
      const exists = await Registration.exists({ unique_id: uid });
      if (!exists) missingImports.push({ unique_id: uid, child_name: row[2] || '', signed: row[9] === 'כן' });
    }

    // Signatures that would be attached to existing registrations missing one.
    const regs = await Registration.find({ branch_id: kaplan._id })
      .select('signature_data configuration parent_id_number child_name');
    const backfillCandidates = [];
    let alreadyHaveSignature = 0;
    let docsToAttach = 0;
    for (const reg of regs) {
      const fromConfig = reg.configuration && reg.configuration.signature;
      const hasConfigSig = typeof fromConfig === 'string' && fromConfig.startsWith('data:image');
      if (!(reg.signature_data || hasConfigSig) && sigMap[normId(reg.parent_id_number)]) {
        backfillCandidates.push({ child_name: reg.child_name });
      }
      if (reg.signature_data || hasConfigSig) alreadyHaveSignature++;
      const docs = filesMap[normId(reg.parent_id_number)];
      if (docs && docs.length) {
        const existing = await Document.countDocuments({ registration_id: reg._id });
        if (existing === 0) docsToAttach += docs.length;
      }
    }

    res.json({
      message: 'בדיקה בלבד — לא בוצעו שינויים',
      sheet_rows: sheetRows,
      signatures_in_sheet: Object.keys(sigMap).length,
      existing_registrations: regs.length,
      already_have_signature: alreadyHaveSignature,
      missing_imports: { count: missingImports.length, list: missingImports },
      signatures_to_attach: { count: backfillCandidates.length, list: backfillCandidates },
      documents_to_attach: { count: docsToAttach },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { syncFromSheets, syncCheck };
