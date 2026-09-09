const XLSX = require('xlsx');
const {
  TmtApproval, ExternalEnrollment, EnrollmentImport, Branch, Classroom, Child, ReconcileDecision,
} = require('../models');
const { parseSheet, missingColumns, COLUMNS, normalizeId } = require('../services/tmt.service');
const { undoBatch, snapshotCollector } = require('../services/enrollment-undo.service');
const { reconcile, VERDICTS, ISSUES, familyOf } = require('../services/enrollment-reconcile.service');
const { AGE_GROUPS } = require('../services/clicktac.service');
const {
  promoteOne, effectiveAgeGroup, hasParents, NO_PARENTS_MESSAGE, lastClickTacImports,
  withImporterName, branchPricingFor, feeEntry,
} = require('./externalEnrollment.controller');
const {
  normalizeYear, enrollmentYear, formatAcademicYear,
} = require('../services/academic-year.service');

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
 * It matters more here than on most screens: a reconciliation row carries a
 * child's ת"ז, both parents' phones and the family's address, and nobody has
 * business reading another gan's intake.
 *
 * Read from the database rather than the token — see utils/branch-scope.js.
 * The version this replaced trusted the JWT, so a back-office manager granted
 * three branches saw all three in the dropdown (served fresh from the DB) and
 * was refused by every endpoint here until she logged out and back in.
 */
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');

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
    if (!await canAccessBranch(req, branchId)) {
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
    const createdIds = [];
    const snapshots = snapshotCollector();

    for (const doc of parsed) {
      const id = doc.child.id_number;
      seen.add(id);
      doc.imported_by = req.user?.id || null;

      const existing = existingById.get(id);
      if (!existing) {
        const fresh = await TmtApproval.create({
          ...doc,
          presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
        });
        createdIds.push(fresh._id);
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

      snapshots.take(existing);
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
      snapshots.take(doc);
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
      created_ids: createdIds,
      snapshots: snapshots.list,
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
      if (!await canAccessBranch(req, req.query.branch)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      filter.branch_id = req.query.branch;
    } else {
      // No branch asked for: a manager still gets only her own.
      const scope = await resolveBranchScope(req);
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

/** "2025-2026" for "2026-2027"; '' when the year is not in that shape. */
function previousYear(academicYear) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(academicYear || ''));
  if (!m) return '';
  return `${Number(m[1]) - 1}-${Number(m[2]) - 1}`;
}

/**
 * Load both lists and compare them.
 *
 * TmtApproval is fetched for the YEAR and not only for the branch: a child
 * approved at משה דיין and registered at כפר סבא has to be found, and the only
 * way to find them is to look outside the branch being reconciled.
 */
async function buildReconciliation({ branchId, academicYear, req }) {
  if (req && !await canAccessBranch(req, branchId)) {
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

  // The year before — "2025-2026" for "2026-2027" — for the continuing-child
  // and last-year-debt checks, when that file has been uploaded.
  const prevYear = previousYear(academicYear);
  const [tmtAll, ctDocs, pricing, decisionDocs, prevYearDocs] = await Promise.all([
    TmtApproval.find({ academic_year: academicYear })
      .select('-raw')
      .populate('branch_id', 'name')
      .lean(),
    // standing_order IS read here and never sent: reconcile() needs the bank
    // code and account number to tell a הו"ק that is merely waiting for the
    // bank details from one that is complete, and it builds each row out of a
    // fixed list of fields, so nothing from the sub-document reaches the wire.
    // Excluding it would have reported every הו"ק family as incomplete.
    ExternalEnrollment.find({ branch_id: branchId, academic_year: academicYear })
      .select('-raw')
      .lean(),
    // The branch's price matrix, so every row can carry the fee its own דרגה
    // prices. Read here rather than inside reconcile() because that function
    // is pure and has no database — and read once for the whole screen.
    branchPricingFor(branchId, academicYear),
    // What people decided — notes, closed findings, overrides. See the model.
    ReconcileDecision.find({ branch_id: branchId, academic_year: academicYear }).lean(),
    prevYear
      ? ExternalEnrollment.find({ branch_id: branchId, academic_year: prevYear })
        .select('child.id_number child.full_name enrollment.status contract.status contract.class_name contract.balance contract.family_balance')
        .lean()
      : [],
  ]);
  const decisions = new Map(decisionDocs.map(d => [d.id_number, d]));

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
    pricing,
    decisions,
    prevYearDocs: prevYearDocs.length ? prevYearDocs : null,
    prevYear,
  });
  // The size of each side, which the verdicts alone cannot tell you: a branch
  // with no תמ"ת file and a branch whose every child was refused produce the
  // same rows. Only the caller that WRITES needs to tell them apart.
  return { result, branch, tmtCount: tmtDocs.length, ctCount: ctDocs.length };
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

    const prevYear = previousYear(academicYear);
    const [lastTmt, lastCt, lastClickTac, lastPrevYear] = await Promise.all([
      // NEVER the snapshots: they are whole rows as they were, bank account
      // included. They exist for the undo and for nothing else. See
      // EnrollmentImport.snapshots.
      EnrollmentImport.findOne({ source: 'tmt', branch_id: branchId, academic_year: academicYear })
        .select('-snapshots -created_ids')
        .sort({ created_at: -1 }).populate('imported_by', 'full_name username').lean(),
      EnrollmentImport.findOne({ source: 'clicktac', branch_id: branchId, academic_year: academicYear })
        .select('-snapshots -created_ids')
        .sort({ created_at: -1 }).populate('imported_by', 'full_name username').lean(),
      // ClickTac publishes TWO exports and they are uploaded independently, so
      // "the last ClickTac file" is two dates. `clicktac` above stays the most
      // recent of either, because every caller that already reads it means
      // "has anything come in at all".
      lastClickTacImports({ branch_id: branchId, academic_year: academicYear }),
      // Last year's file, if it was ever uploaded — either export.
      prevYear
        ? EnrollmentImport.findOne({ source: 'clicktac', branch_id: branchId, academic_year: prevYear })
          .select('-snapshots -created_ids')
          .sort({ created_at: -1 }).populate('imported_by', 'full_name username').lean()
        : null,
    ]);

    res.json({
      ...result,
      academic_year_label: formatAcademicYear(academicYear),
      previous_year: prevYear,
      previous_year_label: prevYear ? formatAcademicYear(prevYear) : '',
      last_import: {
        // Flattened the same way for all four, so the one component that
        // renders an upload line reads the same field whichever it is given.
        tmt: withImporterName(lastTmt),
        clicktac: withImporterName(lastCt),
        clicktac_registrations: lastClickTac.registrations,
        clicktac_contracts: lastClickTac.contracts,
        previous_year: withImporterName(lastPrevYear),
      },
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
      if (!await canAccessBranch(req, req.query.branch)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
      filter.branch_id = req.query.branch;
    } else {
      const scope = await resolveBranchScope(req);
      if (scope) filter.branch_id = { $in: scope };
    }
    if (req.query.source) filter.source = req.query.source;

    const imports = await EnrollmentImport.find(filter)
      // The snapshots stay on the server — see reconcileBranch. Only whether
      // there ARE any travels, so the undo dialog can say what it will do.
      .select('-snapshots')
      .populate('branch_id', 'name')
      .populate('imported_by', 'full_name username')
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    const exact = await EnrollmentImport.aggregate([
      { $match: { _id: { $in: imports.map(i => i._id) } } },
      { $project: { n: { $size: { $ifNull: ['$snapshots', []] } } } },
    ]);
    const snapshotCount = new Map(exact.map(e => [String(e._id), e.n]));

    res.json({
      imports: imports.map(({ created_ids, ...i }) => ({
        ...i,
        id: i._id,
        branch_name: i.branch_id?.name || '',
        imported_by_name: i.imported_by?.full_name || i.imported_by?.username || '',
        // Recorded ids and snapshots = the undo puts back exactly what this
        // file changed. Without them only the created rows can be removed.
        exact_undo: !!(created_ids?.length || snapshotCount.get(String(i._id))),
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
 *
 * A COMPARISON NEEDS TWO SIDES. It ran once at משה דיין in the six minutes
 * between the ClickTac upload at 11:14 and the תמ"ת upload at 11:20 on
 * 11.8.2026. With no approvals loaded yet, every one of the 77 registered
 * children read as "נרשם אצלנו — אין אישור תמ"ת", and all 77 were marked out
 * of the intake queue in one pass. Seventy-four of them match a תמ"ת approval
 * by ת"ז today; not one of them should have been touched.
 *
 * Nothing about that was visible while it happened: an empty side is not an
 * error, it is a comparison against nothing, and it produces a confident
 * verdict on every row. So the emptiness is checked here rather than inferred
 * from the verdicts, which cannot tell "the ministry refused them" apart from
 * "the ministry's file is not loaded".
 */
async function apply(req, res, next) {
  try {
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.body?.academic_year || enrollmentYear());

    const { result, error, status, code, tmtCount, ctCount } =
      await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    if (!tmtCount) {
      return res.status(409).json({
        code: 'NO_TMT_DATA',
        error: 'לא נטען קובץ תמ"ת לסניף ולשנה האלה. בלי הקובץ ההצלבה תסיק שלאף ילד '
          + 'אין אישור ותפסול את כולם. יש להעלות את קובץ התמ"ת ואז להריץ שוב.',
      });
    }
    if (!ctCount) {
      return res.status(409).json({
        code: 'NO_CLICKTAC_DATA',
        error: 'לא נטען קובץ קליקטאק לסניף ולשנה האלה — אין רישומים להצליב מולם.',
      });
    }

    const wanted = Array.isArray(req.body?.verdicts) && req.body.verdicts.length
      ? req.body.verdicts
      : ['missing_approval', 'cancelled', 'not_approved', 'withdrawn'];

    /**
     * Both files present and the comparison still rejects every last child.
     *
     * That is what a תמ"ת file downloaded inside the wrong gan's account looks
     * like — the ministry's portal is per-מעון and the file carries no branch,
     * so the ids simply do not meet and nobody matches anybody. It is also
     * what a genuine catastrophe looks like, which is why this asks instead of
     * refusing: the operator can see the screen and knows which one it is.
     */
    const queue = result.rows.filter(r => r.clicktac && r.clicktac.review_status !== 'imported');
    const wouldDrop = queue.filter(r => wanted.includes(r.verdict));
    if (queue.length >= 5 && wouldDrop.length === queue.length && !req.body?.confirm_drop_all) {
      return res.status(409).json({
        code: 'WOULD_DROP_ALL',
        error: `ההצלבה פוסלת את כל ${queue.length} הרשומות הממתינות — אף ילד לא נשאר. `
          + 'זה מה שקורה כשקובץ התמ"ת שייך לסניף אחר. יש לוודא שהקובץ הנכון הועלה.',
        would_drop: wouldDrop.length,
        queue_size: queue.length,
      });
    }

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
      // 'private' is the office saying "in the gan without the ministry" —
      // cleared by a person rather than by the files, and cleared all the same.
      if (!['approved', 'private'].includes(row.verdict) || !row.clicktac) continue;
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

/** Same label the standing-order status maps to on the reconcile screen. */
const STANDING_ORDER_LABEL = { complete: 'קיימת', missing: 'חסרה' };

/** Which ClickTac export(s) this row has actually been seen in. */
function sourceLabel(sources) {
  const list = sources?.length ? sources : ['registrations'];
  const hasReg = list.includes('registrations');
  const hasContract = list.includes('contracts');
  if (hasReg && hasContract) return 'נרשמים+חוזים';
  if (hasContract) return 'חוזים';
  return 'נרשמים';
}

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
      // The payment alert rides in the flags column rather than in one of its
      // own: the sheet is printed and worked through line by line, and a
      // family to call about their הו"ק is the same kind of item as a name
      // that does not match. The raw method is in its own column beside it,
      // because "מזומן — לא מתקבל" is the verdict and not what the file said.
      issues: [
        ...r.issues.map(i => `${i.label}${i.detail ? ` (${i.detail})` : ''}`),
        ...(r.clicktac?.payment_alert ? [r.clicktac.payment_alert.label] : []),
      ].join(' · '),
      // Two columns, because they answer two questions. The kind is what the
      // sheet is sorted and skimmed by — "הוראת קבע", "צ'ק" — and the raw cell
      // beside it is what ClickTac actually wrote, which is the only way to
      // see a label change from the workbook. The verdict itself rides in the
      // flags column above, cheques included.
      payment_method: r.clicktac?.payment_method_kind?.label || '',
      payment_method_raw: r.clicktac?.payment_method || '',
      // The contract half of the row — כיתה ודרגה only ever exist once the
      // contracts export has been read, and the fee is what that דרגה costs
      // off the branch's own matrix (see fee_by_tier in the reconcile
      // service). Built field by field, same as the rest of asRow, so a raw
      // ct object (and its bank sub-document) never gets near the sheet.
      class_name: r.clicktac?.class_name || '',
      tier: r.clicktac?.tier || '',
      fee_by_tier: r.clicktac?.fee_by_tier ?? '',
      payment_alert: r.clicktac?.payment_alert?.label || '',
      // Which upload(s) this child has actually been seen in — the same test
      // the screen and missing_parents apply, spelled out for the sheet.
      source: sourceLabel(r.clicktac?.sources),
      missing_parents: r.clicktac?.missing_parents ? 'כן' : '',
      // תנאי התשלום, out of payment_terms — bank fields excluded there by
      // construction (paymentTermsFor), so nothing here can leak them.
      pt_tuition_method: r.clicktac?.payment_terms?.tuition_method || '',
      pt_tuition_card_last4: r.clicktac?.payment_terms?.tuition_card_last4 || '',
      pt_registration_fee_method: r.clicktac?.payment_terms?.registration_fee_method || '',
      pt_amount_in_file: r.clicktac?.payment_terms?.amount_in_file ?? '',
      pt_receipt_number: r.clicktac?.payment_terms?.receipt_number || '',
      pt_standing_order: STANDING_ORDER_LABEL[r.clicktac?.payment_terms?.standing_order_status] || '',
      pt_continuing: r.clicktac?.payment_terms?.continuing ? 'כן' : '',
      // Informational only — see the note in enrollment-reconcile.service on
      // why a second signer still waiting no longer raises a finding.
      pt_second_signer: r.clicktac?.payment_terms?.second_signer || '',
      // The wider contracts export's own facts — blank when it did not carry
      // them. Balance is signed as ClickTac signs it: negative owes.
      ct_balance: r.clicktac?.balance ?? '',
      ct_family_balance: r.clicktac?.family_balance ?? '',
      ct_tuition_amount: r.clicktac?.tuition_amount ?? '',
      ct_continuing_contract: r.clicktac?.continuing_contract == null ? '' : (r.clicktac.continuing_contract ? 'כן' : 'לא'),
      tmt_decision: r.tmt?.decision || '',
      tmt_absorbed_at: dateCell(r.tmt?.absorbed_at),
      tmt_present: r.tmt ? (r.tmt.is_present ? 'כן' : `הוסר/ה ${dateCell(r.tmt.missing_since)}`) : 'לא ברשימה',
      ct_present: r.clicktac
        ? (r.clicktac.live ? 'כן' : `הוסר/ה ${dateCell(r.clicktac.contract_missing_since || r.clicktac.missing_since)}`)
        : 'לא נרשם',
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
      // What the office wrote and decided — see ReconcileDecision.
      note: r.decision?.note || '',
      parent_fix: r.decision?.parent_overrides?.pending ? 'לתקן בקליקטאק' : '',
      // Last year's file — blank columns until it is uploaded.
      prev_year_present: r.prev_year ? (r.prev_year.present ? 'כן' : 'לא') : '',
      prev_year_class: r.prev_year?.class_name || '',
      prev_year_balance: r.prev_year?.balance ?? '',
    });

    const COLS_FULL = [
      ['child_name', 'שם הילד/ה'], ['id_number', 'ת"ז'], ['birth_date', 'תאריך לידה'],
      ['age_group', 'שכבת גיל'], ['age_at_start', 'גיל ב־1.9'], ['age_months', 'חודשים ב־1.9'],
      ['placed_group', 'שובץ ידנית ל'], ['verdict', 'מסקנה'], ['action', 'פעולה נדרשת'],
      ['issues', 'חריגות'], ['tmt_decision', 'החלטת תמ"ת'], ['tmt_absorbed_at', 'תאריך כניסה בתמ"ת'],
      ['tmt_present', 'ברשימת תמ"ת'],
      ['ct_status', 'סטטוס קליקטאק'], ['ct_present', 'בקובץ קליקטאק'], ['ct_signed', 'חתימה'],
      ['ct_balance', 'מאזן בקליקטאק'], ['ct_family_balance', 'מאזן משפחתי'],
      ['ct_tuition_amount', 'שכ"ל בחוזה'], ['ct_continuing_contract', 'ממשיך (חוזה)'],
      ['payment_method', 'אמצעי תשלום'], ['payment_method_raw', 'אמצעי תשלום — כפי שנרשם'],
      ['class_name', 'כיתה'], ['tier', 'דרגה'], ['fee_by_tier', 'שכ"ל לפי דרגה'],
      ['payment_alert', 'התרעת תשלום'], ['source', 'מקור'], ['missing_parents', 'חסר פרטי הורים'],
      ['pt_tuition_method', 'שכ"ל — אמצעי'], ['pt_tuition_card_last4', 'כרטיס (4 ספרות)'],
      ['pt_registration_fee_method', 'דמי רישום — אמצעי'], ['pt_amount_in_file', 'סכום בקובץ'],
      ['pt_receipt_number', 'מספר קבלה'], ['pt_standing_order', 'הו"ק'],
      ['pt_continuing', 'ממשיך'], ['pt_second_signer', 'חותם שני'],
      ['parent1', 'הורה 1'], ['parent1_phone', 'טלפון 1'],
      ['parent2', 'הורה 2'], ['parent2_phone', 'טלפון 2'],
      ['tmt_contact', 'איש קשר תמ"ת'], ['tmt_phone', 'טלפון תמ"ת'],
      ['email', 'מייל'], ['address', 'כתובת'], ['review', 'במערכת'],
      ['note', 'הערה'], ['parent_fix', 'תיקון הורים'],
      ['prev_year_present', 'היה/תה בשנה שעברה'], ['prev_year_class', 'כיתה שנה שעברה'],
      ['prev_year_balance', 'מאזן שנה שעברה'],
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

    // Children gone from every list — their own tab, since they are not on
    // the screen's table either.
    const archived = (result.archived || []).map(asRow);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(anomalies, COLS_FULL), 'חריגות');
    XLSX.utils.book_append_sheet(wb, sheetFrom(approved, COLS_FULL), 'מאושרים');
    XLSX.utils.book_append_sheet(wb, sheetFrom(needsDate, COLS_FULL), 'להזין תאריך כניסה');
    XLSX.utils.book_append_sheet(wb, sheetFrom(approved, COLS_CONTACT), 'דף קשר');
    XLSX.utils.book_append_sheet(wb, sheetFrom(all, COLS_FULL), 'הכל');
    XLSX.utils.book_append_sheet(wb, sheetFrom(archived, COLS_FULL), 'ארכיון');

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
 * ClickTac's age layer -> this system's classroom category.
 *
 * Classroom.category is the enum that survives renaming: a branch calls its
 * rooms תינוקייה א and תינוקייה ב and both are the same category. Matching on
 * the name would put half a cohort nowhere.
 */
const AGE_GROUP_TO_CATEGORY = {
  'תינוק': 'תינוקייה',
  'פעוט': 'צעירים',
  'בוגר': 'בוגרים',
};

/** The group a child is actually placed in: the manager's call, then the age. */
function placedGroup(row) {
  return row.age_group_override
    || row.age_at_year_start?.suggested_group
    || row.computed_age_group
    || row.age_group
    || '';
}

/**
 * GET /api/tmt/placement?branch=&year=
 *
 * The placement board: every child the comparison approved, arranged by the
 * room they are going into, against how many places that room has and how many
 * the ministry licensed the gan for.
 *
 * Two capacity numbers, deliberately not merged. `licensed_capacity` is the
 * ministry's licence for the whole מעון, typed in by hand because nothing
 * computes it; the sum of the rooms' own capacities is what the gan set up.
 * They disagree in real life — rooms are often laid out for more places than
 * the licence allows — so both are shown and the smaller one is named as the
 * one that actually binds.
 *
 * Children already turned into registrations count as occupying their room, so
 * "how many are left" means places left, not rows left in a queue.
 */
async function placement(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    const academicYear = normalizeYear(req.query.year || enrollmentYear());

    const { result, error, status, code, branch } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error, code });

    const [rooms, seated, pricing] = await Promise.all([
      Classroom.find({ branch_id: branchId, academic_year: academicYear, is_active: true })
        .select('name category capacity').lean(),
      // Children already filed into a room for this year — places already taken.
      Child.find({ academic_year: academicYear, is_active: true, classroom_id: { $ne: null } })
        .select('classroom_id child_name').lean(),
      branchPricingFor(branchId, academicYear),
    ]);

    // A name with a replacement character in it is a corrupted row, not a room
    // anybody should be able to pick.
    const clean = rooms.filter(r => !/\uFFFD/.test(r.name));
    const seatedByRoom = {};
    for (const c of seated) {
      const k = String(c.classroom_id);
      seatedByRoom[k] = (seatedByRoom[k] || 0) + 1;
    }

    // Only children who can actually be placed: approved, registered with us,
    // and not already imported.
    const waiting = result.rows.filter(r => r.verdict === 'approved' && r.clicktac
      && r.clicktac.review_status !== 'imported');
    const done = result.rows.filter(r => r.clicktac?.review_status === 'imported');

    const children = waiting.map(r => ({
      id: r.clicktac.id,
      id_number: r.id_number,
      child_name: r.child_name,
      birth_date: r.birth_date,
      age_label: r.age_at_year_start?.label || '',
      age_months: r.age_at_year_start?.months ?? null,
      suggested_group: r.age_at_year_start?.suggested_group || '',
      files_group: r.age_group || '',
      group: placedGroup(r),
      is_manual: !!r.age_group_override,
      classroom_id: r.clicktac.classroom_id || null,
      parent_name: r.clicktac.parent1_name || '',
      parent_phone: r.clicktac.parent1_phone || '',
      issues: r.issues.filter(i => i.severity !== 'info').map(i => i.label),
      // The דרגה off the family's signed contract, and what it prices here.
      tier: r.clicktac.tier || '',
      // What the tier costs in the group this child is in right now.
      fee_by_tier: r.clicktac.fee_by_tier ?? null,
      /**
       * …and in each of the other two, because the ROOM decides the group.
       *
       * The dropdown beside this child offers every room in the year, and
       * confirmPlacement bills the group of the room they end up in — so a
       * single number here would be a promise about a group the manager may
       * be about to change. The screen picks the entry for the selected room
       * and the confirm step then bills exactly that, which is what makes the
       * board's fee column true rather than nearly true.
       */
      fees_by_group: r.clicktac.fees_by_group || null,
    }));

    const groups = Object.entries(AGE_GROUP_TO_CATEGORY).map(([group, category]) => {
      const kids = children.filter(c => c.group === group);
      const groupRooms = clean.filter(r => r.category === category);
      return {
        age_group: group,
        category,
        waiting: kids.length,
        children: kids,
        classrooms: groupRooms.map(r => ({
          id: r._id,
          name: r.name,
          capacity: r.capacity || null,
          seated: seatedByRoom[String(r._id)] || 0,
          assigned: kids.filter(c => String(c.classroom_id) === String(r._id)).length,
        })),
      };
    });

    const roomCapacitySum = clean.reduce((n, r) => n + (r.capacity || 0), 0);
    const seatedTotal = clean.reduce((n, r) => n + (seatedByRoom[String(r._id)] || 0), 0);
    const licensed = branch.licensed_capacity ?? null;
    // The binding number is the smaller of the two when both are known: a room
    // laid out for thirty places does not make the licence thirty.
    const binding = licensed != null && roomCapacitySum
      ? Math.min(licensed, roomCapacitySum)
      : (licensed ?? roomCapacitySum ?? 0);

    res.json({
      branch_name: branch.name,
      academic_year: academicYear,
      groups,
      classrooms: clean.map(r => ({
        id: r._id, name: r.name, category: r.category, capacity: r.capacity || null,
        seated: seatedByRoom[String(r._id)] || 0,
      })),
      capacity: {
        licensed,                       // משרד החינוך — typed in by hand
        rooms_sum: roomCapacitySum,     // what the rooms were set up for
        binding,                        // the one that actually limits intake
        seated: seatedTotal,            // places already taken
        waiting: children.length,       // approved and not yet placed
        remaining: Math.max(0, binding - seatedTotal),
        // How many more than the licence the approved list would put in.
        over: Math.max(0, (seatedTotal + children.length) - binding),
      },
      already_imported: done.length,
      // The price matrix, so the confirm step can offer the tiers instead of
      // sending anyone to another screen mid-placement.
      pricing: pricing ? {
        pricing_type: pricing.pricing_type,
        fixed_monthly_fee: pricing.fixed_monthly_fee,
        age_groups: pricing.age_groups,
        tiers: pricing.tiers,
        one_time: pricing.one_time,
      } : null,
      age_group_order: AGE_GROUPS.map(g => g.name),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/tmt/placement/confirm
 *   { branch_id, academic_year, assignments: [{ id, classroom_id }],
 *     fees_by_age_group, registration_fee }
 *
 * אישור שיבוץ — the moment the board stops being a plan.
 *
 * Each child is written into the room chosen for them and then turned into a
 * real registration: a Registration, a Child, and the collections row holding
 * whatever ClickTac already receipted. From that point they are in the גן like
 * any child registered here directly — which is the whole point, because it is
 * the Child rows with a classroom_id that the dashboard counts.
 *
 * A room is required for every child being confirmed. Importing without one
 * puts the child outside the classes screen, the attendance screen and the
 * collections grouping — present in the database and invisible in the gan.
 *
 * Failures are per child and reported, never aborting the run: one child
 * without a fee for their group must not leave half a cohort placed with
 * nothing saying which half.
 */
async function confirmPlacement(req, res, next) {
  try {
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף' });
    if (!await canAccessBranch(req, branchId)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
    const academicYear = normalizeYear(req.body?.academic_year || enrollmentYear());

    const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    if (!assignments.length) return res.status(400).json({ error: 'לא נבחרו ילדים לשיבוץ' });

    const fees = req.body?.fees_by_age_group || {};
    const regFee = Number(req.body?.registration_fee) || 0;
    /**
     * `fees_by_age_group` IS THE FALLBACK NOW.
     *
     * A child whose contract names a דרגה is billed off that child's own row of
     * the branch's matrix — the fee the board already showed beside their name.
     * These per-group numbers still price everybody the matrix cannot: a
     * private branch, a blank tier, a combination the matrix has no cell for.
     * `override_tier` is how somebody says they mean these numbers to win
     * anyway, and it is a deliberate word rather than a side effect of posting
     * a fee.
     */
    const overrideTier = ['1', 'true', true].includes(req.body?.override_tier);
    // One matrix for the whole run — this route is one branch and one year by
    // construction, and promoteOne would otherwise read it once per child.
    const pricing = await branchPricingFor(branchId, academicYear);

    const rooms = await Classroom.find({ branch_id: branchId, academic_year: academicYear })
      .select('name category capacity').lean();
    const roomById = new Map(rooms.map(r => [String(r._id), r]));
    const categoryToGroup = Object.fromEntries(
      Object.entries(AGE_GROUP_TO_CATEGORY).map(([g, c]) => [c, g]),
    );

    const placed = [];
    const skipped = [];

    for (const a of assignments) {
      const doc = await ExternalEnrollment.findById(a.id);
      if (!doc) { skipped.push({ id: a.id, error: 'רשומה לא נמצאה' }); continue; }
      const name = doc.child?.full_name || '';
      if (doc.review?.status === 'imported') { skipped.push({ id: a.id, child: name, error: 'כבר נקלט/ה' }); continue; }
      if (String(doc.branch_id) !== String(branchId)) {
        skipped.push({ id: a.id, child: name, error: 'שייך/ת לסניף אחר' }); continue;
      }

      // The same refusal the promote endpoints give: a child known only from
      // ClickTac's contracts export has no family behind them, and placing
      // them in a room would create a registration nobody can phone.
      if (!hasParents(doc.toObject())) {
        skipped.push({ id: a.id, child: name, error: NO_PARENTS_MESSAGE, code: 'MISSING_PARENTS' });
        continue;
      }

      const room = roomById.get(String(a.classroom_id));
      if (!room) { skipped.push({ id: a.id, child: name, error: 'לא נבחרה כיתה' }); continue; }

      // The room decides the group: a child put in a בוגרים room IS a בוגר,
      // whatever the files said. That keeps the fee column and the room from
      // ever disagreeing.
      const group = categoryToGroup[room.category] || effectiveAgeGroup(doc.toObject());
      /**
       * Absent reads as "nothing was said about this group", which is not the
       * same as ₪0 — see feeEntry. For a child the matrix prices, a blank group
       * field leaves the matrix's number alone even under `override_tier`; for
       * a child it does not, the fee stays open at 0, the deliberate state.
       * Only a present, unparseable or negative figure stops a child.
       */
      const entered = feeEntry(fees[group]);
      if (entered.invalid) {
        skipped.push({ id: a.id, child: name, error: `שכר לימוד לא תקין לשכבה "${group}"` });
        continue;
      }
      const fee = entered.value ?? 0;

      doc.placement = {
        age_group_override: group,
        classroom_id: room._id,
        decided_by: req.user?.id || null,
        decided_at: new Date(),
        note: doc.placement?.note || '',
      };
      await doc.save();

      try {
        const reg = await promoteOne(doc.toObject(), {
          monthly_fee: fee,
          // A blank group is not an override of zero — see feeEntry.
          monthly_fee_override: overrideTier && entered.value !== null ? entered.value : undefined,
          pricing,
          registration_fee: regFee,
          classroom_id: room._id,
          userId: req.user?.id || null,
        });
        placed.push({
          id: a.id, child: name, classroom: room.name, age_group: group,
          // The fee that was ACTUALLY written, not the one this loop offered —
          // for a child with a דרגה those are different numbers, and reporting
          // the offer would tell the office something untrue about what it
          // just committed.
          monthly_fee: reg.monthly_fee,
          fee_source: reg.fee_source,
          fee_tier: reg.fee_tier,
          registration_id: reg._id,
        });
      } catch (e) {
        skipped.push({ id: a.id, child: name, error: e.message });
      }
    }

    res.json({ placed: placed.length, skipped, details: placed });
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
    if (!await canAccessBranch(req, branchId)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });
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

/* ------------------------------------------------------------------ *
 * החלטות — what a person says about one child, kept across uploads.
 * See models/ReconcileDecision.
 * ------------------------------------------------------------------ */

/** The (branch, year, ת"ז) key of a decision, from the request. */
async function decisionScope(req) {
  const branchId = req.body?.branch_id || req.query?.branch;
  if (!branchId) return { error: 'יש לציין סניף', status: 400 };
  if (!await canAccessBranch(req, branchId)) return { error: 'אין לך הרשאה לסניף זה', status: 403 };
  const academicYear = normalizeYear(req.body?.academic_year || req.query?.year || enrollmentYear());
  const idNumber = normalizeId(req.params.idNumber);
  if (!idNumber) return { error: 'ת"ז לא תקינה', status: 400 };
  return { branchId, academicYear, idNumber };
}

const who = (req) => ({ by: req.user?.id || null, by_name: req.user?.full_name || req.user?.name || '' });

/** The decision as the screen reads it — no user ids. */
function decisionOut(doc) {
  if (!doc) return null;
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id_number: d.id_number,
    note: d.note || '',
    verdict_override: d.verdict_override?.kind ? {
      kind: d.verdict_override.kind, reason: d.verdict_override.reason || '',
      by_name: d.verdict_override.by_name || '', at: d.verdict_override.at || null,
    } : null,
    parent_overrides: (d.parent_overrides?.parent1 || d.parent_overrides?.parent2) ? {
      parent1: d.parent_overrides.parent1 || null, parent2: d.parent_overrides.parent2 || null,
      by_name: d.parent_overrides.by_name || '', at: d.parent_overrides.at || null,
    } : null,
    resolutions: (d.resolutions || []).map(r => ({
      code: r.code, choice: r.choice, value: r.value, note: r.note, by_name: r.by_name, at: r.at,
    })),
  };
}

/**
 * PUT /api/tmt/decisions/:idNumber  { branch_id, academic_year, note?, verdict_override?, parent_overrides? }
 *
 * Each key that is PRESENT is set; a key that is absent is left alone, so the
 * note field and the parents form can each save on their own. `null` clears.
 */
async function putDecision(req, res, next) {
  try {
    const scope = await decisionScope(req);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { branchId, academicYear, idNumber } = scope;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
    const set = {};
    if (has('note')) set.note = String(req.body.note || '').slice(0, 4000);
    if (has('verdict_override')) {
      const v = req.body.verdict_override;
      set.verdict_override = v?.kind === 'private'
        ? { kind: 'private', reason: String(v.reason || '').slice(0, 500), ...who(req), at: new Date() }
        : { kind: null, reason: '', by: null, by_name: '', at: null };
    }
    if (has('parent_overrides')) {
      const p = req.body.parent_overrides;
      const party = (x) => (x && (x.name || x.phone)
        ? { name: String(x.name || '').trim().slice(0, 120), phone: String(x.phone || '').trim().slice(0, 30) }
        : null);
      const parent1 = party(p?.parent1);
      const parent2 = party(p?.parent2);
      set.parent_overrides = (parent1 || parent2)
        ? { parent1, parent2, ...who(req), at: new Date() }
        : { parent1: null, parent2: null, by: null, by_name: '', at: null };
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'אין מה לשמור' });

    const doc = await ReconcileDecision.findOneAndUpdate(
      { branch_id: branchId, academic_year: academicYear, id_number: idNumber },
      { $set: set, $setOnInsert: { branch_id: branchId, academic_year: academicYear, id_number: idNumber } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ decision: decisionOut(doc) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/tmt/decisions/:idNumber/resolve
 *   { branch_id, academic_year, code, choice?, value?, note? }
 *
 * Closes one finding. The snapshot of what the files say RIGHT NOW is taken
 * from the comparison itself (every open issue carries one), so the answer
 * is tied to exactly the values the person saw.
 */
async function resolveIssue(req, res, next) {
  try {
    const scope = await decisionScope(req);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { branchId, academicYear, idNumber } = scope;
    const code = String(req.body?.code || '');
    if (!ISSUES[code]) return res.status(400).json({ error: 'סוג חריגה לא מוכר' });
    const choice = ['ok', 'tmt', 'clicktac', 'custom'].includes(req.body?.choice) ? req.body.choice : 'ok';
    const value = String(req.body?.value || '').trim().slice(0, 200);
    if (choice === 'custom' && !value) return res.status(400).json({ error: 'יש להזין ערך' });

    const { result, error, status } = await buildReconciliation({ branchId, academicYear, req });
    if (error) return res.status(status).json({ error });
    const row = [...result.rows, ...result.archived].find(r => r.id_number === idNumber
      || (r.clicktac && normalizeId(r.clicktac.id_number_raw) === idNumber));
    if (!row) return res.status(404).json({ error: 'הילד/ה אינו/ה בהצלבה' });
    const issue = row.issues.find(i => i.code === code);
    if (!issue) return res.status(409).json({ error: 'החריגה אינה פתוחה — אין מה לסגור', code: 'NOT_OPEN' });

    const resolution = {
      code, choice, value, snapshot: issue.snapshot ?? null,
      note: String(req.body?.note || '').slice(0, 500), ...who(req), at: new Date(),
    };
    // One answer per question: the new one replaces the old — and "שם שונה"
    // and "שם חלקי" are one question (see familyOf).
    const sameQuestion = Object.keys(ISSUES).filter(c => familyOf(c) === familyOf(code));
    await ReconcileDecision.updateOne(
      { branch_id: branchId, academic_year: academicYear, id_number: row.id_number },
      { $pull: { resolutions: { code: { $in: sameQuestion } } } },
      { upsert: true },
    );
    const doc = await ReconcileDecision.findOneAndUpdate(
      { branch_id: branchId, academic_year: academicYear, id_number: row.id_number },
      { $push: { resolutions: resolution } },
      { new: true },
    );
    res.json({ decision: decisionOut(doc) });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/tmt/decisions/:idNumber/resolve/:code?branch=&year= — reopen a finding. */
async function reopenIssue(req, res, next) {
  try {
    const scope = await decisionScope(req);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { branchId, academicYear, idNumber } = scope;
    const code = String(req.params.code || '');
    const sameQuestion = Object.keys(ISSUES).filter(c => familyOf(c) === familyOf(code));
    const doc = await ReconcileDecision.findOneAndUpdate(
      { branch_id: branchId, academic_year: academicYear, id_number: idNumber },
      { $pull: { resolutions: { code: { $in: sameQuestion.length ? sameQuestion : [code] } } } },
      { new: true },
    );
    res.json({ decision: decisionOut(doc) });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/tmt/debtors?year=
 *
 * חייבים משנה שעברה — every family with a negative מאזן in ClickTac, across
 * EVERY branch the caller may see, in one table. Before this, seeing them
 * meant opening ClickTac itself and switching between its three separate
 * מעונות one at a time; this reads the same balances this system already
 * imported (see contract.balance in clicktac.service) and puts them side by
 * side.
 *
 * BOTH YEARS, NOT ONLY "LAST YEAR" LITERALLY. A branch that has not yet
 * uploaded last year's ClickTac file (see the "קובץ שנה קודמת" checkbox) has
 * no debtor row for it at all — and on 09.09.2026 that was every branch. A
 * family can also owe money on THIS year's running account before the year
 * is even over. So both the current and the previous academic year are
 * queried and every row is labelled with which one it came from; a family
 * showing in both is two rows, one per year — the two balances are two
 * separate ClickTac accounts on two separate uploads and are never summed
 * into a number this system did not actually see.
 *
 * The note per row is the SAME ReconcileDecision.note the child's card on
 * the reconcile screen uses — same collection, same (branch, year, ת"ז) key,
 * saved through the same PUT /api/tmt/decisions/:idNumber. A call logged here
 * is visible there too, and the other way round.
 */
async function debtors(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const currentYear = normalizeYear(enrollmentYear());
    const prevYear = previousYear(currentYear);
    const years = req.query.year ? [normalizeYear(req.query.year)] : [currentYear, prevYear];

    const branchFilter = scope ? { _id: { $in: scope } } : {};
    const branches = await Branch.find(branchFilter).select('name').lean();
    const branchName = new Map(branches.map(b => [String(b._id), b.name]));
    const branchIds = branches.map(b => b._id);

    const [allRows, decisionDocs] = await Promise.all([
      ExternalEnrollment.find({
        academic_year: { $in: years }, branch_id: { $in: branchIds },
      }).select('branch_id academic_year child parent1 parent2 contract.balance contract.family_balance contract.class_name enrollment.status sources presence.is_present contract.present').lean(),
      ReconcileDecision.find({ academic_year: { $in: years }, branch_id: { $in: branchIds } })
        .select('branch_id academic_year id_number note').lean(),
    ]);

    const noteByKey = new Map(decisionDocs.map(d => [`${d.branch_id}|${d.academic_year}|${d.id_number}`, d.note || '']));
    // Who is live THIS year, per branch — so a previous-year debtor can be
    // marked "still with us" or "gone", the fact that decides whether a call
    // is worth making at all.
    const liveThisYear = new Set(
      allRows
        .filter(r => r.academic_year === currentYear && r.presence?.is_present !== false)
        .map(r => `${r.branch_id}|${normalizeId(r.child?.id_number)}`),
    );

    const party = (p) => ({
      name: `${p?.first_name || ''} ${p?.last_name || ''}`.trim(),
      phone: p?.phone || '',
    });

    const rows = allRows
      .filter(r => typeof r.contract?.balance === 'number' && r.contract.balance < 0)
      .map((r) => {
        const idNumber = normalizeId(r.child?.id_number);
        const key = `${r.branch_id}|${r.academic_year}|${idNumber}`;
        return {
          branch_id: r.branch_id,
          branch_name: branchName.get(String(r.branch_id)) || '',
          academic_year: r.academic_year,
          is_current_year: r.academic_year === currentYear,
          id_number: idNumber,
          child_name: r.child?.full_name || '',
          class_name: r.contract?.class_name || '',
          status: r.enrollment?.status || '',
          balance: r.contract.balance,
          family_balance: r.contract?.family_balance ?? null,
          parent1: party(r.parent1),
          parent2: party(r.parent2),
          // Only meaningful for a PREVIOUS-year row — a current-year row is
          // trivially "yes, this is the current row".
          active_this_year: r.academic_year === currentYear ? null
            : liveThisYear.has(`${r.branch_id}|${idNumber}`),
          note: noteByKey.get(key) || '',
        };
      })
      .sort((a, b) => a.balance - b.balance); // biggest debt first (most negative)

    // Which branches were ASKED for but have no row at all for a given year —
    // "not uploaded yet", not "nobody owes anything there".
    const uploadedFor = new Map(); // year -> Set(branch_id)
    for (const y of years) uploadedFor.set(y, new Set());
    for (const r of allRows) uploadedFor.get(r.academic_year)?.add(String(r.branch_id));
    const missingUploads = years.flatMap(y => branches
      .filter(b => !uploadedFor.get(y)?.has(String(b._id)))
      .map(b => ({ year: y, year_label: formatAcademicYear(y), branch_name: b.name })));

    res.json({
      years: years.map(y => ({ year: y, label: formatAcademicYear(y) })),
      rows,
      total_debt: rows.reduce((s, r) => s - r.balance, 0),
      by_year: Object.fromEntries(years.map(y => [y, {
        count: rows.filter(r => r.academic_year === y).length,
        total: rows.filter(r => r.academic_year === y).reduce((s, r) => s - r.balance, 0),
      }])),
      missing_uploads: missingUploads,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/tmt/alerts/test — send both alerts for real, right now, on
 * purpose. The one way to prove the email half actually arrives: the
 * provider credentials (GAS/Resend/SMTP) live only in this server's own
 * environment, so nothing run from a laptop can exercise them. `force: true`
 * on the reminder means it goes out even if this month's SMS or email
 * already succeeded — that repetition is the point of asking for a test.
 */
async function sendTestAlerts(req, res, next) {
  try {
    const reminder = require('../services/reconcileUploadReminderJob');
    const digest = require('../services/reconcileDigestJob');
    const [reminderResult, digestResult] = await Promise.all([
      reminder.send({ force: true }),
      digest.send(),
    ]);
    res.json({ reminder: reminderResult, digest: digestResult });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/tmt/imports/:id — undo one ministry upload, the latest one. */
async function undoImport(req, res, next) {
  try {
    const batch = await EnrollmentImport.findById(req.params.id);
    if (!batch || batch.source !== 'tmt') return res.status(404).json({ error: 'העלאה לא נמצאה' });
    if (!await canAccessBranch(req, batch.branch_id)) return res.status(403).json({ error: 'אין לך הרשאה לסניף זה' });

    const result = await undoBatch({
      Model: TmtApproval,
      batch,
      sameKind: { source: 'tmt' },
      legacyExtra: { source_file: batch.file_name },
    });
    if (result.error) return res.status(result.status).json(result);
    res.json({ ok: true, file_name: batch.file_name, ...result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  importFile, listApprovals, reconcileBranch, listImports, apply, contacts,
  exportReconcile, removeApproval, deleteData, placement, confirmPlacement,
  isTmtSupervised, undoImport, putDecision, resolveIssue, reopenIssue,
  sendTestAlerts, debtors,
  // The comparison itself, so the daily urgent-findings digest reads exactly
  // what the screen reads rather than recomputing its own version of it.
  buildReconciliation,
};
