const XLSX = require('xlsx');
const {
  TmtApproval, ExternalEnrollment, EnrollmentImport, Branch,
} = require('../models');
const { parseSheet, missingColumns, COLUMNS, normalizeId } = require('../services/tmt.service');
const { reconcile, VERDICTS, ISSUES } = require('../services/enrollment-reconcile.service');
const { normalizeYear, enrollmentYear, formatAcademicYear } = require('../services/academic-year.service');

/**
 * רישום תמ"ת — the ministry's approvals, and the reconciliation against them.
 *
 * The registration for a ministry-supervised מעון runs in two places that
 * never speak to each other. In February families apply through משרד התמ"ת;
 * in July the ministry publishes, per gan, whom it approved. Separately, the
 * families who want us complete a registration in ClickTac. A child is
 * enrolled only when both are true, and every mismatch is either a place that
 * has to be given away or a family that has to be called.
 *
 * Nothing here enrolls anybody. The comparison is read-only and re-runs from
 * the two stored lists on every request, so a fresh file changes the answer
 * without anything needing to be recomputed or invalidated.
 */

/**
 * Is this branch under the ministry at all?
 *
 * קפלן is not: it registers directly with us, it is not in ClickTac and it has
 * no ministry list, so a comparison there would flag every child in the gan.
 * The answer is a field on the branch so it stays a setting rather than a
 * string match — the name fallback only covers rows written before the field
 * existed, and stops mattering the moment someone opens branch settings.
 */
function isTmtSupervised(branch) {
  if (!branch) return false;
  if (branch.tmt_supervised === false) return false;
  if (branch.tmt_supervised === true) return true;
  return !/קפלן/.test(branch.name || '');
}

/**
 * The branches this request may see, or null for "all".
 *
 * Same rule the events and payroll screens use. It matters more here than on
 * most screens: a reconciliation row carries a child's ת"ז, both parents'
 * phones and the family's address, and a branch manager has no business
 * reading another gan's intake.
 */
function managedBranchIds(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null;
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

/** Whether this request may work on this branch. */
function canAccessBranch(req, branchId) {
  const scope = managedBranchIds(req);
  if (!scope) return true;
  return scope.includes(String(branchId));
}

/** The fields whose change between two uploads is worth recording. */
const TRACKED = [
  { path: 'ministry.decision', label: 'החלטת תמ"ת' },
  { path: 'child.full_name', label: 'שם' },
  { path: 'child.birth_date', label: 'תאריך לידה' },
  { path: 'child.age_group', label: 'שכבת גיל' },
  { path: 'ministry.continuing', label: 'ילד ממשיך' },
  { path: 'ministry.welfare', label: 'ילד רווחה' },
  { path: 'ministry.absorbed_at', label: 'תאריך קליטה' },
  { path: 'contact.name', label: 'איש קשר' },
  { path: 'contact.phone', label: 'טלפון' },
];

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const asText = (v) => {
  if (v == null || v === '') return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  return String(v);
};

/** What changed between the stored record and the freshly parsed one. */
function diffFields(existing, doc) {
  return TRACKED
    .map(({ path, label }) => ({ label, from: asText(at(existing, path)), to: asText(at(doc, path)) }))
    .filter(c => c.from !== c.to);
}

/**
 * POST /api/tmt/import   (multipart: file, branch_id, academic_year?)
 *
 * The branch is a parameter and never a column: the ministry's portal is
 * per-מעון and the file it produces has no branch in it at all. So is the
 * year — the export carries decisions, not a year.
 */
async function importFile(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף — קובץ התמ"ת לא כולל את שם הסניף' });
    if (!canAccessBranch(req, branchId)) {
      return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    }
    const branch = await Branch.findById(branchId).lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });
    if (!isTmtSupervised(branch)) {
      return res.status(400).json({
        error: `סניף ${branch.name} אינו תחת משרד התמ"ת — הרישום בו מתבצע ישירות מולנו`,
        code: 'BRANCH_NOT_TMT',
      });
    }

    const academicYear = normalizeYear(req.body?.academic_year || enrollmentYear());
    if (!/^\d{4}-\d{4}$/.test(academicYear)) {
      return res.status(400).json({ error: 'שנת לימודים לא תקינה' });
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    // header:1 — the ministry's first line is a confidentiality banner, not a
    // header row, so the columns are located by content further down.
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'הגיליון ריק' });

    const missing = missingColumns(rows);
    if (missing.length) {
      return res.status(400).json({
        error: `חסרות עמודות בקובץ: ${missing.join(', ')}`,
        code: 'MISSING_COLUMNS',
        expected: Object.values(COLUMNS),
      });
    }

    const parsed = parseSheet(rows, {
      branchId,
      academicYear,
      sourceFile: req.file.originalname || '',
    });
    if (!parsed.length) return res.status(400).json({ error: 'לא נמצאו שורות עם תעודת זהות' });

    const existingDocs = await TmtApproval.find({ branch_id: branchId, academic_year: academicYear });
    const existingById = new Map(existingDocs.map(d => [normalizeId(d.child.id_number), d]));
    const seen = new Set();
    const now = new Date();

    const details = { created: [], updated: [], missing: [] };
    let created = 0; let updated = 0; let unchanged = 0;

    for (const doc of parsed) {
      const id = doc.child.id_number;
      seen.add(id);
      doc.imported_by = req.user?.id || null;

      const existing = existingById.get(id);
      if (!existing) {
        await TmtApproval.create({
          ...doc,
          presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
        });
        created += 1;
        details.created.push(doc.child.full_name);
        continue;
      }

      if (existing.content_hash === doc.content_hash && existing.presence?.is_present !== false) {
        existing.presence.last_seen_at = now;
        existing.source_file = doc.source_file;
        await existing.save();
        unchanged += 1;
        continue;
      }

      const changes = diffFields(existing.toObject(), doc);
      // A child who was gone from the previous file and is back in this one:
      // the return is the change, even when no field moved.
      const returned = existing.presence?.is_present === false;
      if (returned) changes.push({ label: 'נוכחות ברשימת תמ"ת', from: 'הוסר/ה', to: 'חזר/ה' });

      Object.assign(existing, doc);
      existing.presence = {
        is_present: true,
        first_seen_at: existing.presence?.first_seen_at || now,
        last_seen_at: now,
        missing_since: null,
      };
      for (const c of changes) {
        existing.changes.push({ at: now, field: c.label, from: c.from, to: c.to });
      }
      await existing.save();

      // The hash moved but nothing a person cares about did — a whitespace fix
      // in an address, or the record being rehashed after the hash function was
      // corrected. Saved either way; only counted as an update when the meaning
      // actually moved, so the summary stays a list of real changes.
      if (!changes.length) { unchanged += 1; continue; }
      updated += 1;
      details.updated.push({ name: doc.child.full_name, changes: changes.map(c => `${c.label}: ${c.from} ← ${c.to}`) });
    }

    /**
     * Children this gan had approved before and that the new file no longer
     * lists. The record is kept and marked gone rather than deleted — a
     * withdrawn approval means a place just opened, which is the single most
     * actionable thing an updated file can say.
     */
    for (const [id, doc] of existingById) {
      if (seen.has(id)) continue;
      if (doc.presence?.is_present === false) continue;
      doc.presence.is_present = false;
      doc.presence.missing_since = now;
      doc.changes.push({ at: now, field: 'נוכחות ברשימת תמ"ת', from: 'מאושר/ת', to: 'הוסר/ה מהרשימה' });
      await doc.save();
      details.missing.push(doc.child.full_name);
    }

    const batch = await EnrollmentImport.create({
      source: 'tmt',
      branch_id: branchId,
      academic_year: academicYear,
      file_name: req.file.originalname || '',
      sheet_name: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: details.missing.length,
      details: {
        created: details.created.slice(0, 100),
        updated: details.updated.slice(0, 100),
        missing: details.missing.slice(0, 100),
      },
      imported_by: req.user?.id || null,
    });

    res.json({
      branch: branch.name,
      academic_year: academicYear,
      sheet: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: details.missing.length,
      details,
      import_id: batch._id,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/tmt/approvals?branch=&year= — the ministry's list as stored. */
async function listApprovals(req, res, next) {
  try {
    const filter = { academic_year: normalizeYear(req.query.year || enrollmentYear()) };
    if (req.query.branch && req.query.branch !== 'all') {
      if (!canAccessBranch(req, req.query.branch)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      filter.branch_id = req.query.branch;
    } else {
      // No branch asked for: a manager still gets only her own.
      const scope = managedBranchIds(req);
      if (scope) filter.branch_id = { $in: scope };
    }

    const docs = await TmtApproval.find(filter)
      .select('-raw')
      .populate('branch_id', 'name')
      .sort({ 'child.full_name': 1 })
      .lean();

    res.json({
      approvals: docs.map(d => ({
        ...d,
        id: d._id,
        branch_name: d.branch_id?.name || '',
        branch_id: d.branch_id?._id || d.branch_id,
      })),
      summary: {
        total: docs.length,
        approved: docs.filter(d => d.ministry?.is_approved).length,
        present: docs.filter(d => d.presence?.is_present !== false).length,
        removed: docs.filter(d => d.presence?.is_present === false).length,
        continuing: docs.filter(d => d.ministry?.continuing).length,
        welfare: docs.filter(d => d.ministry?.welfare).length,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Load both lists and compare them.
 *
 * TmtApproval is fetched for the YEAR and not only for the branch: a child
 * approved at משה דיין and registered at כפר סבא has to be found, and the only
 * way to find them is to look outside the branch being reconciled.
 */
async function buildReconciliation({ branchId, academicYear, req }) {
  if (req && !canAccessBranch(req, branchId)) {
    return { error: 'אין לך הרשאה לסניף זה', status: 403 };
  }
  const branch = await Branch.findById(branchId).lean();
  if (!branch) return { error: 'סניף לא נמצא', status: 404 };
  if (!isTmtSupervised(branch)) {
    return {
      error: `סניף ${branch.name} אינו תחת משרד התמ"ת — אין מולו רשימת אישורים להצליב`,
      code: 'BRANCH_NOT_TMT',
      status: 400,
    };
  }

  const [tmtAll, ctDocs] = await Promise.all([
    TmtApproval.find({ academic_year: academicYear })
      .select('-raw')
      .populate('branch_id', 'name')
      .lean(),
    ExternalEnrollment.find({ branch_id: branchId, academic_year: academicYear })
      .select('-standing_order -raw')
      .lean(),
  ]);

  const ctIds = new Set(ctDocs.map(d => normalizeId(d.child?.id_number)).filter(Boolean));
  const tmtDocs = tmtAll
    .filter(t => String(t.branch_id?._id || t.branch_id) === String(branchId)
      // A child approved elsewhere but registered HERE is pulled in so the
      // branch mismatch is reported instead of reading as "no approval".
      || ctIds.has(normalizeId(t.child?.id_number)))
    .map(t => ({ ...t, branch_name: t.branch_id?.name || '' }));

  const result = reconcile({
    tmtDocs,
    ctDocs,
    branchId,
    academicYear,
    branchName: branch.name,
  });
  return { result, branch };
}

/** GET /api/tmt/reconcile?branch=&year= */
async function reconcileBranch(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') {
      return res.status(400).json({ error: 'יש לבחור סניף — ההצלבה נעשית מול רשימת תמ"ת של מעון אחד' });
    }
    const academicYear = normalizeYear(req.query.year || enrollmentYear());
    const { result, error, status, code } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    const [lastTmt, lastCt] = await Promise.all([
      EnrollmentImport.findOne({ source: 'tmt', branch_id: branchId, academic_year: academicYear })
        .sort({ created_at: -1 }).populate('imported_by', 'full_name username').lean(),
      EnrollmentImport.findOne({ source: 'clicktac', branch_id: branchId, academic_year: academicYear })
        .sort({ created_at: -1 }).populate('imported_by', 'full_name username').lean(),
    ]);

    res.json({
      ...result,
      academic_year_label: formatAcademicYear(academicYear),
      last_import: { tmt: lastTmt || null, clicktac: lastCt || null },
      dictionaries: { verdicts: VERDICTS, issues: ISSUES },
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/tmt/imports?branch=&year= — the upload history, newest first. */
async function listImports(req, res, next) {
  try {
    const filter = { academic_year: normalizeYear(req.query.year || enrollmentYear()) };
    if (req.query.branch && req.query.branch !== 'all') {
      if (!canAccessBranch(req, req.query.branch)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      filter.branch_id = req.query.branch;
    } else {
      const scope = managedBranchIds(req);
      if (scope) filter.branch_id = { $in: scope };
    }
    if (req.query.source) filter.source = req.query.source;

    const imports = await EnrollmentImport.find(filter)
      .populate('branch_id', 'name')
      .populate('imported_by', 'full_name username')
      .sort({ created_at: -1 })
      .limit(50)
      .lean();

    res.json({
      imports: imports.map(i => ({
        ...i,
        id: i._id,
        branch_name: i.branch_id?.name || '',
        imported_by_name: i.imported_by?.full_name || i.imported_by?.username || '',
      })),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/tmt/apply  { branch_id, academic_year, verdicts?: [] }
 *
 * Write the comparison's conclusion onto the ClickTac queue: everyone the
 * reconciliation rejects is marked 'ignored' with the reason, so the import
 * screen stops offering them and the note says why.
 *
 * A child who was ALREADY turned into a registration is never touched here.
 * Removing an enrolled child means ending a registration, cancelling a
 * standing order and freeing a classroom place — none of which should happen
 * as a side effect of uploading a spreadsheet. Those come back as a list for
 * a human to act on.
 */
async function apply(req, res, next) {
  try {
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.body?.academic_year || enrollmentYear());

    const { result, error, status, code } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    const wanted = Array.isArray(req.body?.verdicts) && req.body.verdicts.length
      ? req.body.verdicts
      : ['missing_approval', 'cancelled', 'not_approved', 'withdrawn'];

    const dropped = [];
    const needsManual = [];
    const now = new Date();

    for (const row of result.rows) {
      if (!wanted.includes(row.verdict)) continue;
      if (!row.clicktac) continue;

      if (row.clicktac.review_status === 'imported') {
        needsManual.push({
          child_name: row.child_name,
          id_number: row.id_number,
          verdict: row.verdict,
          verdict_label: row.verdict_label,
          registration_id: row.clicktac.imported_registration_id,
        });
        continue;
      }

      await ExternalEnrollment.updateOne({ _id: row.clicktac.id }, {
        $set: {
          'review.status': 'ignored',
          'review.note': `הצלבת תמ"ת ${now.toLocaleDateString('he-IL')}: ${row.verdict_label}`,
        },
      });
      dropped.push({ child_name: row.child_name, id_number: row.id_number, verdict: row.verdict });
    }

    // Everyone the comparison clears goes back to 'pending' — a child marked
    // out by an earlier, staler file must not stay out once the ministry
    // approves them.
    const restored = [];
    for (const row of result.rows) {
      if (row.verdict !== 'approved' || !row.clicktac) continue;
      if (row.clicktac.review_status !== 'ignored') continue;
      await ExternalEnrollment.updateOne({ _id: row.clicktac.id }, {
        $set: {
          'review.status': 'pending',
          'review.note': `הצלבת תמ"ת ${now.toLocaleDateString('he-IL')}: מאושר/ת`,
        },
      });
      restored.push({ child_name: row.child_name, id_number: row.id_number });
    }

    res.json({
      dropped: dropped.length,
      restored: restored.length,
      needs_manual: needsManual,
      details: { dropped, restored },
      summary: result.summary,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/tmt/contacts?branch=&year=&verdict=
 *
 * דף קשר — one row per child with both parents and the ministry's own contact.
 * Defaults to the children who are actually enrolling; the whole point of the
 * sheet is the list somebody rings through in July.
 */
async function contacts(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.query.year || enrollmentYear());
    const { result, error, status, code } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    const wanted = String(req.query.verdict || 'approved').split(',').filter(Boolean);
    const rows = wanted.includes('all') ? result.rows : result.rows.filter(r => wanted.includes(r.verdict));

    res.json({
      branch_name: result.branch_name,
      academic_year: academicYear,
      contacts: rows.map(r => ({
        child_name: r.child_name,
        id_number: r.id_number,
        birth_date: r.birth_date,
        age_group: r.age_group,
        age_at_year_start: r.age_at_year_start?.label || '',
        verdict: r.verdict,
        verdict_label: r.verdict_label,
        parent1_name: r.clicktac?.parent1_name || '',
        parent1_phone: r.clicktac?.parent1_phone || '',
        parent1_email: r.clicktac?.parent1_email || '',
        parent2_name: r.clicktac?.parent2_name || '',
        parent2_phone: r.clicktac?.parent2_phone || '',
        parent2_email: r.clicktac?.parent2_email || '',
        address: r.clicktac?.address || '',
        // For a child who never registered with us, this is the ONLY phone
        // number that exists — and they are exactly the family to call.
        tmt_contact_name: r.tmt?.contact_name || '',
        tmt_contact_phone: r.tmt?.contact_phone || '',
        tmt_contact_email: r.tmt?.contact_email || '',
      })),
    });
  } catch (error) {
    next(error);
  }
}

/** A worksheet from an array of objects, with the columns in a fixed order. */
function sheetFrom(rows, columns) {
  const data = rows.map(r => Object.fromEntries(columns.map(([key, label]) => [label, r[key] ?? ''])));
  const ws = XLSX.utils.json_to_sheet(data, { header: columns.map(c => c[1]) });
  ws['!cols'] = columns.map(([, label]) => ({ wch: Math.max(12, label.length + 4) }));
  return ws;
}

const dateCell = (d) => (d ? new Date(d).toLocaleDateString('he-IL', { timeZone: 'UTC' }) : '');

/**
 * GET /api/tmt/reconcile/export?branch=&year=
 *
 * The same comparison as a workbook: the anomalies, the approved list, and the
 * contact sheet, in three tabs. The screen is where the work is done; this is
 * what gets mailed to the bookkeeper and printed for the phone calls.
 */
async function exportReconcile(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.query.year || enrollmentYear());
    const { result, error, status, code } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    const asRow = (r) => ({
      child_name: r.child_name,
      id_number: r.id_number,
      birth_date: dateCell(r.birth_date),
      age_group: r.age_group,
      age_at_start: r.age_at_year_start?.label || '',
      age_months: r.age_at_year_start?.months ?? '',
      placed_group: r.age_group_override || '',
      verdict: r.verdict_label,
      action: r.verdict_action,
      issues: r.issues.map(i => `${i.label}${i.detail ? ` (${i.detail})` : ''}`).join(' · '),
      tmt_decision: r.tmt?.decision || '',
      tmt_absorbed_at: dateCell(r.tmt?.absorbed_at),
      tmt_present: r.tmt ? (r.tmt.is_present ? 'כן' : `הוסר/ה ${dateCell(r.tmt.missing_since)}`) : 'לא ברשימה',
      ct_status: r.clicktac?.status || 'לא נרשם',
      ct_signed: r.clicktac?.second_signer || '',
      parent1: r.clicktac?.parent1_name || '',
      parent1_phone: r.clicktac?.parent1_phone || '',
      parent2: r.clicktac?.parent2_name || '',
      parent2_phone: r.clicktac?.parent2_phone || '',
      tmt_contact: r.tmt?.contact_name || '',
      tmt_phone: r.tmt?.contact_phone || '',
      email: r.clicktac?.parent1_email || r.tmt?.contact_email || '',
      address: r.clicktac?.address || '',
      review: r.clicktac?.review_status === 'imported' ? 'נקלט במערכת' : '',
    });

    const COLS_FULL = [
      ['child_name', 'שם הילד/ה'], ['id_number', 'ת"ז'], ['birth_date', 'תאריך לידה'],
      ['age_group', 'שכבת גיל'], ['age_at_start', 'גיל ב־1.9'], ['age_months', 'חודשים ב־1.9'],
      ['placed_group', 'שובץ ידנית ל'], ['verdict', 'מסקנה'], ['action', 'פעולה נדרשת'],
      ['issues', 'חריגות'], ['tmt_decision', 'החלטת תמ"ת'], ['tmt_absorbed_at', 'תאריך כניסה בתמ"ת'],
      ['tmt_present', 'ברשימת תמ"ת'],
      ['ct_status', 'סטטוס קליקטאק'], ['ct_signed', 'חתימה'],
      ['parent1', 'הורה 1'], ['parent1_phone', 'טלפון 1'],
      ['parent2', 'הורה 2'], ['parent2_phone', 'טלפון 2'],
      ['tmt_contact', 'איש קשר תמ"ת'], ['tmt_phone', 'טלפון תמ"ת'],
      ['email', 'מייל'], ['address', 'כתובת'], ['review', 'במערכת'],
    ];
    const COLS_CONTACT = [
      ['child_name', 'שם הילד/ה'], ['id_number', 'ת"ז'], ['age_group', 'שכבת גיל'],
      ['age_at_start', 'גיל ב־1.9'], ['parent1', 'הורה 1'], ['parent1_phone', 'טלפון 1'],
      ['parent2', 'הורה 2'], ['parent2_phone', 'טלפון 2'],
      ['email', 'מייל'], ['address', 'כתובת'],
      ['tmt_contact', 'איש קשר תמ"ת'], ['tmt_phone', 'טלפון תמ"ת'],
    ];

    const all = result.rows.map(asRow);
    const anomalies = result.rows.filter(r => r.verdict !== 'approved' || r.issue_severity !== 'ok').map(asRow);
    const approved = result.rows.filter(r => r.verdict === 'approved').map(asRow);
    // Its own tab, because it is not a problem to investigate — it is a list to
    // work through in the ministry's portal, one entry date at a time.
    const needsDate = result.rows
      .filter(r => r.issues.some(i => i.code === 'needs_absorption_date'))
      .map(asRow);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(anomalies, COLS_FULL), 'חריגות');
    XLSX.utils.book_append_sheet(wb, sheetFrom(approved, COLS_FULL), 'מאושרים');
    XLSX.utils.book_append_sheet(wb, sheetFrom(needsDate, COLS_FULL), 'להזין תאריך כניסה');
    XLSX.utils.book_append_sheet(wb, sheetFrom(approved, COLS_CONTACT), 'דף קשר');
    XLSX.utils.book_append_sheet(wb, sheetFrom(all, COLS_FULL), 'הכל');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeBranch = String(result.branch_name).replace(/[^\p{L}\p{N}\- ]/gu, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`הצלבת תמת ${safeBranch} ${academicYear}.xlsx`)}`);
    res.send(buf);
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/tmt/data?branch=&year=  — undo a whole upload.
 *
 * The ministry's portal is per-מעון and the file carries no branch, so the one
 * mistake that is easy to make is downloading inside one gan's account and
 * uploading it under another. That files a whole cohort against the wrong
 * branch, and no row-by-row edit fixes it. So the unit of undo is the unit of
 * the mistake: every approval for one branch and one year, and the upload
 * history with it, deleted together and re-uploaded clean.
 *
 * Nothing downstream depends on an approval — it creates no registration and
 * no child — so unlike the ClickTac side there is nothing here to refuse.
 */
async function deleteData(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    if (!canAccessBranch(req, branchId)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    const academicYear = normalizeYear(req.query.year || '');
    if (!/^\d{4}-\d{4}$/.test(academicYear)) return res.status(400).json({ error: 'יש לבחור שנת לימודים' });

    const { deletedCount } = await TmtApproval.deleteMany({
      branch_id: branchId, academic_year: academicYear,
    });
    const batches = await EnrollmentImport.deleteMany({
      source: 'tmt', branch_id: branchId, academic_year: academicYear,
    });

    res.json({ deleted: deletedCount, batches_deleted: batches.deletedCount });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/tmt/approvals/:id — a row uploaded against the wrong branch. */
async function removeApproval(req, res, next) {
  try {
    const doc = await TmtApproval.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    res.json({ removed: doc.child?.full_name || '' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  importFile, listApprovals, reconcileBranch, listImports, apply, contacts,
  exportReconcile, removeApproval, deleteData, isTmtSupervised,
};
