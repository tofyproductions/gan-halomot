const XLSX = require('xlsx');
const shabbat = require('../services/shabbatParents');
const {
  ExternalEnrollment, Registration, Child, Collection, Branch, BranchPricing, Classroom,
  EnrollmentImport,
} = require('../models');
const {
  parseSheet, parseContractsSheet, identifyHeader, AGE_GROUPS, idKey,
} = require('../services/clicktac.service');
const {
  paymentAlertFor, paymentMethodCounts, paymentMethodFor,
} = require('../services/paymentCheck');
const { tierFeeFor } = require('../services/tier-fee.service');
const {
  normalizeYear, enrollmentYear, hebrewYearForStart, academicYearOf, normalizeChildName,
} = require('../services/academic-year.service');
const { generateUniqueId } = require('../utils/id-generator');
const { getBranchFilter } = require('../utils/branch-filter');
const { canAccessBranch, resolveBranchScope } = require('../utils/branch-scope');

/** One refusal, one wording — every write below names a branch. */
const NOT_YOUR_BRANCH = { error: 'אין לך הרשאה לסניף זה' };

/**
 * קליטת רישומים מקליקטאק — the review queue between an external export and
 * this system's live tables.
 *
 * Nothing here writes a Registration on its own. A spreadsheet of 77 children
 * is not something to trust blind: the branch is not in the file, the tuition
 * is not in the file, and roughly half the rows are children who already exist
 * somewhere. Every row lands as an ExternalEnrollment, gets matched against
 * what is already here, and becomes a registration only when someone says so.
 */

/**
 * Which of ClickTac's two exports a stored row has been in.
 *
 * Every row written before the contracts export was supported came from the
 * registrations export — that was the only file there was — so an absent or
 * empty list means 'registrations' rather than "unknown". Reading it as
 * unknown would lock every one of those rows out of promotion.
 */
function sourcesOf(doc) {
  const s = Array.isArray(doc?.sources) ? doc.sources.filter(Boolean) : [];
  return s.length ? s : ['registrations'];
}

/**
 * Can this row become a registration?
 *
 * A contracts-only row is a real child with a real contract and NO parent: no
 * name, no phone, no email, no payment method. Promoting it would create a
 * Registration whose parent_name is empty and whose family nobody can reach,
 * and the gap would only surface when someone tried to call them.
 *
 * THE TEST IS `sources` AND ONLY `sources`. It was briefly also
 * `parent1.first_name`, which was wrong in the one direction that matters: the
 * registrations export does carry rows whose parent columns are blank — an
 * older cohort, a family entered by hand — and those rows were promotable
 * before the contracts export existed and are promotable now. Refusing them
 * told the office to upload a file it had already uploaded, with no way
 * forward. What this guard is for is the OTHER thing: a row that has only ever
 * been in the contracts export, which has no parent columns at all, so
 * promoting it would create a Registration whose family nobody can reach.
 */
function hasParents(doc) {
  return sourcesOf(doc).includes('registrations');
}

const NO_PARENTS_MESSAGE = 'חסרים פרטי הורים — יש לקלוט גם את ייצוא הנרשמים מקליקטאק';

/**
 * The ת"ז — or passport — of a child, wherever this system happens to keep it,
 * in the shape everything else compares against. See `idKey`: a Registration
 * carries no id TYPE, so the letters in the value are the only evidence that
 * it is a passport and must not be reduced to its digits.
 */
function childIdOf(reg, child) {
  return idKey({
    id_number: child?.child_id_number || reg?.configuration?.registration_card?.childIdNumber || '',
  });
}

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/**
 * May these two records be the same child, as far as their id numbers say?
 *
 * TWO DIFFERENT NUMBERS ARE A REFUSAL, NOT A TIE-BREAK. Matching on name plus
 * birth date exists because most of the children in this system have no ת"ז
 * stored at all, and without it a passport in one file and a ת"ז in the other
 * would double every child who has both. But two siblings born on the same day
 * with the same name is not a hypothetical — cousins share a grandmother's
 * name, twins share a birthday, and a family that registers both writes two
 * rows that differ in exactly one field: the ת"ז. Merging them puts one
 * child's דרגה, class and contract onto the other and deletes a row nobody
 * knows is gone.
 *
 * So the name+birth rule may only fire when the ids do not CONTRADICT: at
 * least one side has to be silent. When both sides carry a number and the
 * numbers agree, the id rule has already matched and this never runs.
 */
function idsAgree(a, b) {
  return !a || !b || a === b;
}

/**
 * The age group a child is actually placed in.
 *
 * A manager's decision first — it was made against the child's real age on 1
 * September and it is the only one of the three that is a placement rather
 * than a bracket. Then the computed group, then ClickTac's own.
 */
function effectiveAgeGroup(doc) {
  return doc.placement?.age_group_override
    || doc.computed?.age_group
    || doc.child?.age_group
    || '';
}

/**
 * The fields whose change between two exports is worth recording.
 *
 * The list is short on purpose: an operator re-uploading in August wants to
 * see that somebody cancelled or that a signature came in, not that a phone
 * number gained a dash.
 */
const TRACKED = [
  { path: 'enrollment.status', label: 'סטטוס' },
  { path: 'enrollment.second_signer', label: 'חותם שני' },
  { path: 'enrollment.continuing', label: 'ממשיך' },
  { path: 'child.full_name', label: 'שם' },
  { path: 'child.birth_date', label: 'תאריך לידה' },
  { path: 'child.age_group', label: 'שכבת גיל' },
  { path: 'parent1.phone', label: 'טלפון הורה 1' },
  { path: 'parent2.phone', label: 'טלפון הורה 2' },
  { path: 'enrollment.receipt_number', label: 'מספר קבלה' },
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
 * Tie an imported row to a registration that already exists.
 *
 * ת"ז first — it is unique in every export seen and it is the child's own.
 * Name + birth date second, because this system barely stores child ID numbers
 * (one record in seventy), so for almost every existing child the ת"ז cannot
 * match anything and the fallback is the only thing that will.
 */
function matchExisting(doc, registrations, childByReg) {
  const wantId = idKey(doc.child);
  if (wantId) {
    const byId = registrations.find(r => childIdOf(r, childByReg.get(String(r._id))) === wantId);
    if (byId) return { reg: byId, by: 'id_number' };
  }
  const wantName = normalizeChildName(doc.child.full_name);
  const wantBirth = dayKey(doc.child.birth_date);
  // …and only where the two ת"ז do not contradict each other. See idsAgree:
  // the same name and the same birthday with two different numbers is two
  // children, and tying the import to the wrong registration would file a
  // sibling's row against their brother's.
  const byNameBirth = registrations.find(r => normalizeChildName(r.child_name) === wantName
    && dayKey(r.child_birth_date) === wantBirth
    && idsAgree(wantId, childIdOf(r, childByReg.get(String(r._id)))));
  if (byNameBirth) return { reg: byNameBirth, by: 'name_birth' };
  return { reg: null, by: '' };
}

/**
 * The row this parsed child belongs to — the whole merge, in one function.
 *
 * BOTH IMPORTS CALL IT, which is the point: whichever export arrives second
 * has to land on the row the first one created, and a rule written twice would
 * eventually be two rules. Registrations-then-contracts and
 * contracts-then-registrations must produce the same single row.
 *
 * The order is the order of certainty:
 *
 *   1. the ת"ז, inside this branch and year. It is the child's own number and
 *      it is what both files carry, once the punctuation is stripped.
 *   2. name + birth date, inside this branch and year, AND ONLY WHERE THE TWO
 *      ID NUMBERS DO NOT CONTRADICT. The contracts export writes a passport
 *      for the children who have one, and passports do not compare with the
 *      ת"ז the registrations export holds; without this fallback those
 *      children would double. But two children can share a name and a
 *      birthday, and then the ת"ז is the only thing that tells them apart —
 *      so a candidate whose id is present and different is refused. See
 *      idsAgree.
 *   3. the ת"ז ACROSS branches. Not a merge rule so much as a collision guard:
 *      the unique index is (source, academic_year, child.id_number) and knows
 *      nothing about branches, so a child filed against the wrong gan last
 *      week would make this import throw E11000 instead of merging. This is
 *      also exactly what the registrations importer did before the contracts
 *      export existed, so nothing about that path changes.
 *
 * `candidates` is every row already stored for this branch and year — a few
 * hundred at the very most, and comparing them in memory is what lets rule 2
 * exist at all (it is not expressible as an index lookup).
 *
 * IT RETURNS WHICH RULE FIRED, not only the row. Rule 3 is the one the callers
 * have to be able to tell apart: it reaches outside the branch, and a contracts
 * file uploaded against the wrong gan must not be quietly absorbed by the right
 * one. See `importContractsExport`.
 */
async function findMergeTarget({ child, academicYear, candidates }) {
  const wantId = idKey(child);
  if (wantId) {
    const byId = candidates.find(d => idKey(d.child) === wantId);
    if (byId) return { target: byId, by: 'id_number' };
  }

  const wantName = normalizeChildName(child.full_name);
  const wantBirth = dayKey(child.birth_date);
  if (wantName && wantBirth) {
    // VERIFIED WITH THE ת"ז. Two rows may share a name and a birthday and
    // still be two children — siblings named for the same grandmother, twins
    // — and the one field that separates them is the id number. When both
    // sides carry one and they differ, this is not the same child and the row
    // falls through to be created. See idsAgree.
    const byNameBirth = candidates.find(d => normalizeChildName(d.child?.full_name) === wantName
      && dayKey(d.child?.birth_date) === wantBirth
      && idsAgree(wantId, idKey(d.child)));
    if (byNameBirth) return { target: byNameBirth, by: 'name_birth' };
  }

  if (child.id_number) {
    const anywhere = await ExternalEnrollment.findOne({
      source: 'clicktac',
      academic_year: academicYear,
      'child.id_number': child.id_number,
    });
    if (anywhere) return { target: anywhere, by: 'cross_branch' };
  }
  return { target: null, by: '' };
}

/**
 * Fill a field the other export left blank — and only then.
 *
 * The two files overlap on the child (both carry a name, a birth date, a
 * קופת חולים) and they do not always agree, because they were filled in at
 * different moments by different people. Whichever export wrote a value first
 * keeps it; the second one only supplies what is missing. Letting the later
 * file win would mean a re-upload of an old contracts export could quietly
 * revert a name that was corrected in the registrations export.
 */
function fillBlanks(target, source, fields) {
  let changed = false;
  for (const f of fields) {
    const incoming = source[f];
    if (incoming === undefined || incoming === null || incoming === '') continue;
    const current = target[f];
    if (current !== undefined && current !== null && current !== '') continue;
    target[f] = incoming;
    changed = true;
  }
  return changed;
}

/**
 * The child fields a stored row already has and the incoming one is silent
 * about — the mirror image of `fillBlanks`, for the one place that cannot use
 * it.
 *
 * The registrations merge is `Object.assign(existing, doc, …)`, which replaces
 * the WHOLE `child` path in one go. `parseRow` produces no `nickname`, no
 * `id_type` and no `medical_notes` — three fields only the contracts export
 * fills — so a registrations upload after a contracts upload erased all three
 * off every merged row. Nothing healed it either: `content_hash_contracts` is
 * untouched by that path, so re-uploading the contracts file read as
 * "unchanged" and put nothing back. `medical_notes` is an allergy list.
 *
 * Written generically rather than as those three names, because the next field
 * only one of the two exports carries would have gone the same way silently.
 */
function keepFilledChildFields(existingChild, incomingChild) {
  const kept = {};
  for (const [key, value] of Object.entries(existingChild || {})) {
    if (key === '_id') continue;
    if (value === undefined || value === null || value === '') continue;
    const incoming = incomingChild?.[key];
    if (incoming === undefined || incoming === null || incoming === '') kept[key] = value;
  }
  return kept;
}

/**
 * ת"ז ריקה או כפולה — a row that cannot be written, said in the one sentence
 * the office can act on.
 *
 * The unique index is (source, academic_year, child.id_number) and it indexes
 * the empty string like any other value, so the SECOND child in a file whose
 * ת"ז column was left blank collides with the first. Before this it threw
 * E11000 out of the middle of the loop: a 500, half the file written, and no
 * way to tell which half.
 */
const DUPLICATE_ID_LABEL = 'דילוג — ת"ז חסרה או כפולה';
const isDuplicateKeyError = (err) => err?.code === 11000;

/** The other reason a contracts row is not written. See importContractsExport. */
const CROSS_BRANCH_LABEL = 'לא נקלט — הילד/ה רשום/ה בסניף אחר';

/** The child fields the contracts export can supply. */
const CONTRACT_CHILD_FIELDS = [
  'first_name', 'last_name', 'full_name', 'nickname', 'id_number', 'id_type',
  'birth_date', 'health_fund', 'medical_notes', 'age_group',
];

/**
 * POST /api/external-enrollments/import   (multipart: file, branch_id, academic_year?)
 *
 * ONE BUTTON, TWO FILES. ClickTac publishes a registrations export and a
 * contracts export, and the office needs both: the first is the only place the
 * parents and the payment method exist, the second is the only place the class
 * and the subsidy tier (דרגה) exist. Asking someone to pick the right upload
 * button for a file they downloaded twenty minutes ago is asking for the
 * cohort to be filed wrong, so the HEADER decides which file this is and the
 * import branches on that.
 *
 * The branch is a parameter and never a column, in either file. `מוסד` and
 * `מעון` both read "כפר סבא" on every row and two branches answer to that;
 * filing a whole cohort under the wrong gan is not a mistake anyone would
 * notice quickly.
 */
async function importFile(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
    const branchId = req.body?.branch_id;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף — הקובץ עצמו לא מבחין בין סניפי כפר סבא' });
    // The branch arrives in the BODY, so without this the gate on the route is
    // the only thing between a caller and any gan in the system. That was
    // survivable while only admins and accountants could reach the route (they
    // hold every branch anyway); it stops being survivable the moment the
    // clicktac_write grant lets other people in. Whoever holds the grant passes
    // here — resolveBranchScope returns null for them — and everybody else is
    // held to the branches they actually have.
    if (!await canAccessBranch(req, branchId)) return res.status(403).json(NOT_YOUR_BRANCH);
    const branch = await Branch.findById(branchId).lean();
    if (!branch) return res.status(404).json({ error: 'סניף לא נמצא' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
    if (!rows.length) return res.status(400).json({ error: 'הגיליון ריק' });

    // Which of the two — or neither, in which case this is the refusal that
    // names both accepted exports instead of listing columns.
    const verdict = identifyHeader(rows[0]);
    if (!verdict.type) return res.status(400).json(verdict);

    const ctx = { req, res, next, branch, branchId, rows, sheetName };
    return verdict.type === 'contracts'
      ? importContractsExport(ctx)
      : importRegistrationsExport(ctx);
  } catch (error) {
    return next(error);
  }
}

/**
 * The registrations export — the original import, unchanged in what it does.
 *
 * What IS new: it may now land on a row the contracts export created. That row
 * has a child, a contract and no parents, and this file is the half it was
 * waiting for — so it is filled in place rather than duplicated, and gains
 * 'registrations' in `sources`, which is what unlocks promotion for it.
 */
async function importRegistrationsExport({ req, res, next, branch, branchId, rows, sheetName }) {
  try {
    const parsed = parseSheet(rows, {
      branchId,
      sourceFile: req.file.originalname || '',
    });
    if (req.body?.academic_year) {
      const forced = normalizeYear(req.body.academic_year);
      for (const d of parsed) d.academic_year = forced;
    }
    // Without a year there is nothing to scope the "which children are gone"
    // query to, and an unscoped one would mark the whole branch missing.
    if (!parsed.length || !parsed[0].academic_year) {
      return res.status(400).json({ error: 'לא נמצאו שורות עם שנת לימודים' });
    }

    // What this system already holds, for matching. Not branch-filtered: a
    // family that moved between branches is still the same child.
    const registrations = await Registration.find({}).lean();
    const children = await Child.find({}).select('registration_id child_id_number').lean();
    const childByReg = new Map(children.map(c => [String(c.registration_id), c]));

    // Every row already stored for this branch and year — the pool the merge
    // matches against. Loaded once: the contracts export may have created rows
    // under a passport number or under a ת"ז written differently, and finding
    // them needs the name+birth comparison that no index can do.
    const candidates = await ExternalEnrollment.find({
      source: 'clicktac',
      branch_id: branchId,
      academic_year: parsed[0].academic_year,
    });

    let created = 0; let updated = 0; let unchanged = 0;
    const results = [];
    const now = new Date();
    const seen = new Set();
    const updateDetails = [];
    const skippedNames = [];

    for (const doc of parsed) {
      const { reg, by } = matchExisting(doc, registrations, childByReg);
      doc.review = {
        status: 'pending',
        matched_registration_id: reg?._id || null,
        matched_by: by,
      };
      doc.imported_by = req.user?.id || null;
      seen.add(idKey(doc.child));

      const { target: existing } = await findMergeTarget({
        child: doc.child,
        academicYear: doc.academic_year,
        candidates,
      });

      if (!existing) {
        let fresh;
        try {
          fresh = await ExternalEnrollment.create({
            ...doc,
            presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
          });
        } catch (err) {
          // The unique index refused this row — almost always a second child
          // whose ת"ז column is blank. One skipped row is not a reason to lose
          // the other seventy: the file is written, the name is reported, and
          // the office fixes the ת"ז in ClickTac and uploads again.
          if (!isDuplicateKeyError(err)) throw err;
          skippedNames.push(doc.child.full_name);
          continue;
        }
        // So a child listed twice in one file merges with itself instead of
        // being created twice.
        candidates.push(fresh);
        created += 1;
        results.push({ child: doc.child.full_name, action: 'created' });
      } else if (existing.content_hash === doc.content_hash && existing.presence?.is_present !== false) {
        existing.presence.last_seen_at = now;
        await existing.save();
        unchanged += 1;
      } else {
        // A row that changed in ClickTac. Keep the review decision already made
        // about it — the point of re-importing is the data, not to reopen a
        // question somebody answered.
        const keepReview = existing.review;
        // The placement is a decision somebody made, not data from the file.
        // A fresh export must not undo it.
        const keepPlacement = existing.placement;
        const wasContractsOnly = !sourcesOf(existing).includes('registrations');
        const before = existing.toObject();
        // Object.assign below replaces the whole `child` path and this file has
        // nothing to say about half of it. See keepFilledChildFields.
        const keptChild = keepFilledChildFields(before.child, doc.child);
        // Diffed against what the row will ACTUALLY hold, not against `doc` —
        // otherwise a field this file could not read would be written into the
        // change log as "cleared" while the old value quietly stayed put.
        const changes = diffFields(before, { ...doc, child: { ...doc.child, ...keptChild } });
        if (existing.presence?.is_present === false) {
          changes.push({ label: 'נוכחות בקובץ קליקטאק', from: 'הוסר/ה', to: 'חזר/ה' });
        }
        // The row the contracts export created is finally getting its family.
        // Worth recording as a change in its own right: "the parents arrived"
        // is the event that turns a row nobody could act on into one that can
        // be promoted, and it is not visible in any of the TRACKED fields
        // (they were all blank before, so they read as ordinary fills).
        if (wasContractsOnly) {
          changes.push({ label: 'פרטי הורים', from: 'חסרים', to: 'נקלטו מייצוא הנרשמים' });
        }
        // `doc` carries no `contract` key, so Object.assign leaves the
        // contracts half alone — but `sources` IS in it, hard-coded to
        // ['registrations'], and would drop 'contracts' on the floor.
        const mergedSources = [...new Set([...sourcesOf(existing), 'registrations'])];
        Object.assign(existing, doc, {
          review: keepReview,
          placement: keepPlacement,
          sources: mergedSources,
        });
        // ...and put back what only the other export knows. Set path by path
        // rather than by mutating the object Object.assign just installed, so
        // mongoose records every one of them as changed.
        for (const [key, value] of Object.entries(keptChild)) existing.set(`child.${key}`, value);
        // Same trap as `child`: Object.assign just installed `doc.computed`
        // wholesale. If this file's birth-date cell was unreadable, that
        // computed is all nulls — mirror the contracts-path guard (~:718) and
        // keep the age this row already had rather than erasing it.
        if (doc.computed?.age_months == null && before.computed?.age_months != null) {
          existing.set('computed.age_months', before.computed.age_months);
          existing.set('computed.age_group', before.computed.age_group);
          existing.set('computed.agrees_with_source', before.computed.agrees_with_source);
        }
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
        // The hash moved but nothing a person cares about did — a whitespace
        // fix in an address, or the record being rehashed after the hash
        // function was corrected. Saved either way; only counted as an update
        // when the meaning actually moved.
        if (!changes.length) { unchanged += 1; continue; }
        updated += 1;
        results.push({ child: doc.child.full_name, action: 'updated' });
        updateDetails.push({ name: doc.child.full_name, changes: changes.map(c => `${c.label}: ${c.from} ← ${c.to}`) });
      }
    }

    /**
     * Children this branch had in an earlier export and that this file no
     * longer lists. Not the same as "ביטל רישום": a cancelled family is still
     * IN the file with a status. A family that is simply gone was removed from
     * ClickTac, and the ministry may still be holding a place for them.
     */
    const gone = await ExternalEnrollment.find({
      source: 'clicktac',
      branch_id: branchId,
      academic_year: parsed[0]?.academic_year,
      'presence.is_present': { $ne: false },
    });
    const missingNames = [];
    for (const doc of gone) {
      if (seen.has(idKey(doc.child))) continue;
      // A row that has only ever been in the CONTRACTS export was never in
      // this file to begin with, so its absence from it says nothing. Marking
      // it "הוסר/ה מהקובץ" would report a family as withdrawn on the strength
      // of a file that does not list them either way.
      if (!sourcesOf(doc).includes('registrations')) continue;
      doc.presence.is_present = false;
      doc.presence.missing_since = now;
      doc.changes.push({ at: now, field: 'נוכחות בקובץ קליקטאק', from: 'רשום/ה', to: 'הוסר/ה מהקובץ' });
      await doc.save();
      missingNames.push(doc.child.full_name);
    }

    /**
     * The other direction of the manager's "הסרה זמנית": a child she hid
     * because they dropped off the list, whose ת"ז now appears in this fresh
     * file — the file is the proof they are back, so they come back. Only
     * children hidden THROUGH the temporary mechanism are touched; ordinary
     * deactivations are not the file's to reverse.
     */
    const restoredNames = [];
    const hiddenKids = await Child.find({ hidden_at: { $ne: null }, is_active: false })
      .select('child_name child_id_number').lean();
    for (const kid of hiddenKids) {
      const idNum = idKey({ id_number: kid.child_id_number });
      if (!idNum || !seen.has(idNum)) continue;
      await Child.updateOne(
        { _id: kid._id },
        { $set: { is_active: true, hidden_at: null, hidden_by_name: '', hide_note: '' } },
      );
      restoredNames.push(kid.child_name);
    }

    const batch = await EnrollmentImport.create({
      source: 'clicktac',
      export_type: 'registrations',
      branch_id: branchId,
      academic_year: parsed[0]?.academic_year || '',
      file_name: req.file.originalname || '',
      sheet_name: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: missingNames.length,
      details: {
        created: results.filter(r => r.action === 'created').map(r => r.child).slice(0, 100),
        updated: updateDetails.slice(0, 100),
        missing: missingNames.slice(0, 100),
      },
      imported_by: req.user?.id || null,
    });

    return res.json({
      branch: branch.name,
      sheet: sheetName,
      export_type: 'registrations',
      export_label: 'ייצוא הנרשמים',
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: missingNames.length,
      missing_names: missingNames.slice(0, 50),
      // Rows the unique index refused — see DUPLICATE_ID_LABEL. Reported by
      // name, because the fix is in ClickTac and it needs a child to point at.
      skipped_duplicate: skippedNames.length,
      skipped_names: skippedNames.slice(0, 50),
      skipped_label: DUPLICATE_ID_LABEL,
      restored: restoredNames.length,
      restored_names: restoredNames.slice(0, 50),
      results: results.slice(0, 50),
      import_id: batch._id,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * The contracts export.
 *
 * WHAT IT MAY AND MAY NOT DO. It writes the `contract` sub-document, it fills
 * child fields the other file left blank, and it creates a row for a child the
 * registrations export has not reached yet. It does NOT touch parent1/parent2,
 * enrollment or standing_order — it has nothing to put there — and it does NOT
 * run the "who disappeared" sweep: the two files list different populations at
 * different moments in the summer, and a child missing from the contracts
 * export has not been removed from ClickTac, they simply have not signed yet.
 *
 * Its no-op check is `content_hash_contracts`, its own hash, so re-uploading
 * the same contracts file changes nothing even if the registrations export has
 * moved half the phone numbers since.
 */
async function importContractsExport({ req, res, next, branch, branchId, rows, sheetName }) {
  try {
    const parsed = parseContractsSheet(rows, {
      branchId,
      sourceFile: req.file.originalname || '',
    });
    if (req.body?.academic_year) {
      const forced = normalizeYear(req.body.academic_year);
      for (const d of parsed) d.academic_year = forced;
    }
    if (!parsed.length || !parsed[0].academic_year) {
      return res.status(400).json({ error: 'לא נמצאו שורות עם שנת לימודים' });
    }

    const academicYear = parsed[0].academic_year;
    const registrations = await Registration.find({}).lean();
    const children = await Child.find({}).select('registration_id child_id_number').lean();
    const childByReg = new Map(children.map(c => [String(c.registration_id), c]));

    const candidates = await ExternalEnrollment.find({
      source: 'clicktac',
      branch_id: branchId,
      academic_year: academicYear,
    });

    let created = 0; let updated = 0; let unchanged = 0;
    const now = new Date();
    const results = [];
    const updateDetails = [];
    const skippedNames = [];
    const crossBranchNames = [];

    for (const row of parsed) {
      const { target: existing, by } = await findMergeTarget({
        child: row.child,
        academicYear,
        candidates,
      });

      /**
       * THE CHILD IS SOMEBODY ELSE'S.
       *
       * Rule 3 of the merge deliberately reaches across branches, because the
       * unique index does too and a row filed against the wrong gan would
       * otherwise throw. For the REGISTRATIONS export that is right — it is
       * the whole record, and a family that moved should follow its row.
       *
       * Here it is wrong. The branch is not in this file; it is whatever was
       * selected in the dialog, and selecting the wrong one of the two כפר סבא
       * branches takes a click. Merging would write הרצליה's classes and
       * דרגות onto כפר סבא's rows, under כפר סבא's name, with nothing on any
       * screen saying it happened. So the row is refused and reported, and the
       * office uploads it against the right branch.
       */
      if (existing && by === 'cross_branch'
        && String(existing.branch_id) !== String(branchId)) {
        crossBranchNames.push(row.child.full_name);
        continue;
      }

      const contract = { ...row.contract, imported_at: now };

      if (!existing) {
        // A child with a contract and no family yet. Created rather than
        // skipped: the class and the דרגה are real facts about a real child,
        // and the office needs to SEE that the registration is the half that
        // is missing — which is exactly what the "חסר פרטי הורים" flag says.
        const { reg, by: matchedBy } = matchExisting(row, registrations, childByReg);
        let fresh;
        try {
          fresh = await ExternalEnrollment.create({
            source: 'clicktac',
            source_file: req.file.originalname || '',
            imported_by: req.user?.id || null,
            branch_id: branchId,
            academic_year: academicYear,
            child: row.child,
            contract,
            computed: row.computed,
            sources: ['contracts'],
            review: {
              status: 'pending',
              matched_registration_id: reg?._id || null,
              matched_by: matchedBy,
            },
            presence: { is_present: true, first_seen_at: now, last_seen_at: now, missing_since: null },
            // Namespaced so it can never be mistaken for a registrations hash —
            // see the note on the two hashes in the model.
            content_hash: `contracts:${row.content_hash_contracts}`,
            content_hash_contracts: row.content_hash_contracts,
          });
        } catch (err) {
          // Two children in one file with a blank ת"ז — the second one hits the
          // unique index, which treats '' as a value like any other. Skipped by
          // name instead of taking the whole import down mid-write.
          if (!isDuplicateKeyError(err)) throw err;
          skippedNames.push(row.child.full_name);
          continue;
        }
        candidates.push(fresh);
        created += 1;
        results.push({ child: row.child.full_name, action: 'created' });
        continue;
      }

      if (existing.content_hash_contracts === row.content_hash_contracts) {
        existing.presence.last_seen_at = now;
        await existing.save();
        unchanged += 1;
        continue;
      }

      const before = existing.toObject();
      const changes = contractChanges(before, contract);
      const gainedContract = !before.contract;

      existing.contract = contract;
      existing.content_hash_contracts = row.content_hash_contracts;
      existing.sources = [...new Set([...sourcesOf(existing), 'contracts'])];
      // Only the blanks. A name corrected in the registrations export outranks
      // whatever the contracts export still says — see fillBlanks.
      fillBlanks(existing.child, row.child, CONTRACT_CHILD_FIELDS);
      // The age group follows the birth date, and the contracts export may
      // have just supplied one for a row that had none.
      if (!existing.computed?.age_months && row.computed.age_months != null) {
        existing.computed.age_months = row.computed.age_months;
        existing.computed.age_group = row.computed.age_group;
        existing.computed.agrees_with_source = row.computed.agrees_with_source;
      }
      existing.presence.last_seen_at = now;
      if (gainedContract) {
        changes.unshift({ label: 'חוזה', from: '—', to: contract.class_name || 'נקלט' });
      }
      for (const c of changes) {
        existing.changes.push({ at: now, field: c.label, from: c.from, to: c.to });
      }
      await existing.save();

      if (!changes.length) { unchanged += 1; continue; }
      updated += 1;
      results.push({ child: existing.child.full_name, action: 'updated' });
      updateDetails.push({
        name: existing.child.full_name,
        changes: changes.map(c => `${c.label}: ${c.from} ← ${c.to}`),
      });
    }

    const batch = await EnrollmentImport.create({
      source: 'clicktac',
      export_type: 'contracts',
      branch_id: branchId,
      academic_year: academicYear,
      file_name: req.file.originalname || '',
      sheet_name: sheetName,
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      // Always zero, and deliberately: this file's silence about a child is
      // not evidence of anything. See the note above.
      missing: 0,
      details: {
        created: results.filter(r => r.action === 'created').map(r => r.child).slice(0, 100),
        updated: updateDetails.slice(0, 100),
        missing: [],
      },
      imported_by: req.user?.id || null,
    });

    // How many rows in this branch and year still have no family behind them.
    // The number the office acts on after uploading contracts first.
    const missingParents = (await ExternalEnrollment.find({
      source: 'clicktac', branch_id: branchId, academic_year: academicYear,
    }).select('sources parent1.first_name').lean()).filter(d => !hasParents(d)).length;

    return res.json({
      branch: branch.name,
      sheet: sheetName,
      export_type: 'contracts',
      export_label: 'ייצוא החוזים',
      rows: rows.length,
      parsed: parsed.length,
      created,
      updated,
      unchanged,
      missing: 0,
      missing_names: [],
      missing_parents: missingParents,
      // Rows the unique index refused (blank/duplicate ת"ז) and rows that
      // belong to another branch — both skipped, both named, because both are
      // fixed outside this system and then re-uploaded.
      skipped_duplicate: skippedNames.length,
      skipped_names: skippedNames.slice(0, 50),
      skipped_label: DUPLICATE_ID_LABEL,
      cross_branch: crossBranchNames.length,
      cross_branch_names: crossBranchNames.slice(0, 50),
      cross_branch_label: CROSS_BRANCH_LABEL,
      restored: 0,
      restored_names: [],
      results: results.slice(0, 50),
      import_id: batch._id,
    });
  } catch (error) {
    return next(error);
  }
}

/** What moved between the stored contract and the one this file carries. */
const CONTRACT_TRACKED = [
  { path: 'class_name', label: 'כיתה' },
  { path: 'tier', label: 'דרגה' },
  { path: 'tuition_type', label: 'סוג מימון' },
  { path: 'status', label: 'סטטוס בחוזה' },
  { path: 'start_date', label: 'תחילת חוזה' },
  { path: 'end_date', label: 'סיום חוזה' },
];

function contractChanges(existing, contract) {
  const before = existing.contract || {};
  return CONTRACT_TRACKED
    .map(({ path, label }) => ({
      label, from: asText(before[path]), to: asText(contract[path]),
    }))
    .filter(c => c.from !== c.to);
}

/**
 * Who uploaded it, flattened onto the record.
 *
 * `imported_by` is populated to a user document, and every screen that shows an
 * upload wants one string. Doing it here rather than in the component is what
 * makes the "last file" card and the upload-history table read the same field:
 * the card was asking for `imported_by_name` on an object that only ever had
 * `imported_by`, and silently showed nothing.
 */
function withImporterName(imp) {
  if (!imp) return null;
  return {
    ...imp,
    imported_by_name: imp.imported_by?.full_name || imp.imported_by?.username || '',
  };
}

/**
 * The latest upload of EACH ClickTac export, for a branch/year scope.
 *
 * "When was the last ClickTac file uploaded" stopped being one question the
 * moment there were two files: a branch can be current on registrations and
 * three weeks behind on contracts, and one date cannot say so.
 *
 * Batches written before `export_type` existed have no such field, and every
 * one of them was a registrations upload — hence the `$exists: false` arm,
 * which is the same reading `sourcesOf` applies to the rows themselves.
 */
async function lastClickTacImports(scope = {}) {
  const base = { source: 'clicktac' };
  if (scope.branch_id) base.branch_id = scope.branch_id;
  if (scope.academic_year) base.academic_year = scope.academic_year;

  const latest = (where) => EnrollmentImport.findOne({ ...base, ...where })
    .sort({ created_at: -1 })
    .populate('imported_by', 'full_name username')
    .lean();

  const [registrations, contracts] = await Promise.all([
    latest({ $or: [{ export_type: 'registrations' }, { export_type: { $exists: false } }] }),
    latest({ export_type: 'contracts' }),
  ]);
  return { registrations: withImporterName(registrations), contracts: withImporterName(contracts) };
}

/** GET /api/external-enrollments — the queue. Never includes bank details. */
async function list(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req) };
    if (req.query.year) filter.academic_year = normalizeYear(req.query.year);
    if (req.query.status) filter['review.status'] = req.query.status;

    const docs = await ExternalEnrollment.find(filter)
      // `raw` is deliberately absent. `standing_order` is READ and then
      // stripped below, one line before the response is built: a הו"ק with no
      // bank details is one of the three payment alerts, and it cannot be told
      // from a complete one without looking at them. A list request is still
      // not a reason to put 64 families' bank accounts on the wire.
      .select('-raw')
      .populate('branch_id', 'name')
      .populate('review.matched_registration_id', 'child_name academic_year monthly_fee')
      .sort({ 'child.full_name': 1 })
      .lean();

    const q = String(req.query.q || '').trim().toLowerCase();
    let filtered = q
      ? docs.filter(d => d.child.full_name?.toLowerCase().includes(q)
        || String(d.child.id_number).includes(q)
        || `${d.parent1?.first_name} ${d.parent1?.last_name}`.toLowerCase().includes(q)
        || `${d.parent2?.first_name} ${d.parent2?.last_name}`.toLowerCase().includes(q))
      : docs;
    // The work list after a contracts-first upload: children with a contract
    // and no family behind them, who cannot be promoted until the
    // registrations export arrives.
    if (['1', 'true'].includes(String(req.query.missing_parents || ''))) {
      filtered = filtered.filter(d => !hasParents(d));
    }

    /**
     * The matrices behind `fee_by_tier`, one per (branch, year) in the queue.
     *
     * The queue is not one branch — an admin sees every gan at once — so the
     * pricing document cannot be loaded once, and it must not be loaded per
     * row either. Loaded per distinct pair, which for the real screen is one
     * or four reads.
     */
    const pricingKey = (d) => `${String(d.branch_id?._id || d.branch_id)}|${d.academic_year}`;
    const pricingByKey = new Map(docs.map(d => [pricingKey(d), null]));
    await Promise.all([...pricingByKey.keys()].map(async (key) => {
      const [branchId, year] = key.split('|');
      pricingByKey.set(key, await branchPricingFor(branchId, year));
    }));

    res.json({
      enrollments: filtered.map(({ standing_order: bank, ...d }) => ({
        ...d,
        id: d._id,
        branch_name: d.branch_id?.name || '',
        branch_id: d.branch_id?._id || d.branch_id,
        // Normalised for the client rather than left to it: an old row has no
        // `sources` at all, and every consumer would have to know that means
        // 'registrations'.
        sources: sourcesOf(d),
        missing_parents: !hasParents(d),
        // Recomputed rather than read from `computed.payment_alert`: the
        // stored copy is what the counters are built from, and the rows
        // imported before this check existed do not have one. `bank` above is
        // destructured out of the response in the same breath it is used.
        payment_alert: paymentAlertFor({ ...d, standing_order: bank }),
        // How the family pays, named — shown for every row, not only for the
        // ones with a problem. Null for a contracts-only row, which has no
        // payment column behind it at all.
        payment_method_kind: paymentMethodFor(d),
        /**
         * שכר הלימוד שהדרגה של המשפחה מייצרת — או null.
         *
         * The number the screen shows beside the דרגה, and the number this row
         * will actually be billed when it is promoted (see promoteOne). Null
         * for a child with no tier, a private branch, or a matrix that does not
         * price this combination — all three of which mean "a person still has
         * to choose", and saying so with an empty cell is more honest than
         * showing a zero.
         */
        fee_by_tier: tierFeeFor({
          pricing: pricingByKey.get(pricingKey(d)),
          tier: d.contract?.tier,
          ageGroup: effectiveAgeGroup(d),
        })?.fee ?? null,
      })),
      summary: {
        total: docs.length,
        pending: docs.filter(d => d.review?.status === 'pending').length,
        imported: docs.filter(d => d.review?.status === 'imported').length,
        ignored: docs.filter(d => d.review?.status === 'ignored').length,
        matched: docs.filter(d => d.review?.matched_registration_id).length,
        cancelled: docs.filter(d => d.enrollment?.status === 'ביטל רישום').length,
        disagree_age_group: docs.filter(d => d.computed?.agrees_with_source === false).length,
        missing_parents: docs.filter(d => !hasParents(d)).length,
        with_contract: docs.filter(d => !!d.contract).length,
        // מזומן / לא הוגדר / הו"ק ללא בנק. Counted over the same rows as
        // every other counter above — the whole queue, before the search box
        // and the filters narrow it.
        //
        // ERRORS ONLY, since a cheque became an alert too — see the note on
        // severity in services/paymentCheck.
        payment_alerts: docs.filter(d => paymentAlertFor(d)?.severity === 'error').length,
        // The soft half — today, the families paying by cheque.
        payment_warnings: docs.filter(d => paymentAlertFor(d)?.severity === 'warning').length,
      },
      // What ClickTac actually writes in `צורת תשלום שכ"ל`, counted. The rule
      // above matches on a substring precisely because these strings are the
      // vendor's and can change; this is how the office sees when they have.
      payment_methods: paymentMethodCounts(docs),
      last_import: await lastClickTacImports(filter),
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/external-enrollments/:id — one record, bank details included. */
async function getOne(req, res, next) {
  try {
    const doc = await ExternalEnrollment.findById(req.params.id)
      .populate('branch_id', 'name')
      .populate('review.matched_registration_id', 'child_name academic_year monthly_fee parent_name')
      .lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    res.json({ enrollment: { ...doc, id: doc._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/external-enrollments/pricing?branch=&year=
 *
 * The tuition is NOT in either export — ClickTac carries the funding type
 * ("מימון משרד הכלכלה"), never an amount. So the price comes from the branch's
 * own state matrix, crossed with the family's subsidy tier (דרגה).
 *
 * WHERE THE TIER NOW COMES FROM. It used to come from nowhere: the
 * registrations export does not have it, so the screen asked for ONE tier and
 * applied it to a whole import, which is wrong for every family whose income
 * differs from the one that was typed. The contracts export DOES carry it, per
 * child, and it is now stored on the row (`contract.tier`) and shown next to
 * the child.
 *
 * AND IT IS NOW APPLIED. The matrix below is still handed to the client for
 * the children who have no tier, but a child whose contract names one is
 * priced on the server, off this same document — see promoteOne and
 * services/tier-fee.service.js. The screen shows the number rather than asking
 * for it, and the registration records which row produced it.
 *
 * The matrix columns are the state's: עד 15 חודש / 15–24 חודש / מעל 24 חודש —
 * the same two boundaries the export's own age groups fall on, which is what
 * makes the computed age group usable for picking a column.
 */

/**
 * The branch's price matrix for a gan year, or null.
 *
 * ONE PLACE, BECAUSE THE YEAR IS WRITTEN THREE WAYS. BranchPricing's
 * `academic_year` is whatever the screen that saved it sent, and the screens do
 * not agree: the pricing editor offers `תשפ"ז` with an ASCII double quote,
 * `hebrewYearForStart` produces `תשפ״ז` with a gershayim (U+05F4), and some
 * rows carry the plain "2026-2027". They are the same year and they are three
 * different strings, so a lookup that knows one of them finds no matrix, prices
 * every child manually, and says nothing — which is exactly the silent failure
 * this whole change exists to end. All the spellings are asked for at once.
 */
function yearSpellings(year) {
  const hebrew = hebrewYearForStart(Number(year.split('-')[0]));
  return [...new Set([
    year,
    hebrew,
    hebrew.replace(/״/g, '"'),   // the pricing editor's own spelling
    hebrew.replace(/"/g, '״'),
  ])];
}

async function branchPricingFor(branchId, academicYear) {
  if (!branchId) return null;
  const year = normalizeYear(academicYear || enrollmentYear());
  return BranchPricing.findOne({
    branch_id: branchId,
    academic_year: { $in: yearSpellings(year) },
  }).lean();
}

async function pricing(req, res, next) {
  try {
    const year = normalizeYear(req.query.year || enrollmentYear());
    const doc = await branchPricingFor(req.query.branch, year);
    if (!doc) return res.json({ pricing: null, age_groups: AGE_GROUPS.map(g => g.name) });
    res.json({
      pricing: {
        pricing_type: doc.pricing_type,
        fixed_monthly_fee: doc.fixed_monthly_fee,
        age_groups: doc.age_groups,
        tiers: doc.tiers,
        addons: doc.addons,
        one_time: doc.one_time,
        installments: doc.installments,
      },
      // Which matrix column each ClickTac age group belongs to. Index-aligned
      // to `age_groups`, because the labels are the state's wording and will
      // not match the export's.
      age_group_columns: AGE_GROUPS.map((g, i) => ({ name: g.name, column: i })),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * ClickTac's age layer -> this system's classroom category.
 *
 * Classroom.category is the enum that survives renaming: a branch calls its
 * rooms תינוקייה א and תינוקייה ב, and both are the same category. Matching on
 * the name would put half a cohort nowhere.
 */
const AGE_GROUP_TO_CATEGORY = {
  'תינוק': 'תינוקייה',
  'פעוט': 'צעירים',
  'בוגר': 'בוגרים',
};

/**
 * GET /api/external-enrollments/classroom-plan?branch=&year=
 *
 * How many children fall in each age group, and which classrooms exist to
 * receive them. משה דיין has no classrooms at all for תשפ״ז — importing
 * seventy-seven children into a year with no rooms puts every one of them
 * outside the classes screen, the attendance screen and the collections
 * grouping, which is a worse outcome than not importing.
 */
async function classroomPlan(req, res, next) {
  try {
    const year = normalizeYear(req.query.year || enrollmentYear());
    const branchId = req.query.branch;
    if (!branchId) return res.status(400).json({ error: 'יש לבחור סניף' });

    const pending = await ExternalEnrollment.find({
      branch_id: branchId,
      academic_year: year,
      'review.status': 'pending',
    }).select('computed.age_group child.age_group enrollment.status').lean();

    const rooms = await Classroom.find({ branch_id: branchId, academic_year: year, is_active: true })
      .select('name category capacity').lean();

    // A name with a replacement character in it is a corrupted row, not a
    // room anybody should be able to pick. Half the classrooms in the database
    // are these; offering them would file children into a name nobody can read.
    const clean = rooms.filter(r => !/�/.test(r.name));

    const groups = Object.entries(AGE_GROUP_TO_CATEGORY).map(([ageGroup, category]) => {
      const children = pending.filter(p => (p.computed?.age_group || p.child?.age_group) === ageGroup);
      return {
        age_group: ageGroup,
        category,
        count: children.length,
        active_count: children.filter(p => p.enrollment?.status !== 'ביטל רישום').length,
        classrooms: clean.filter(r => r.category === category)
          .map(r => ({ id: r._id, name: r.name, capacity: r.capacity })),
      };
    });

    res.json({
      academic_year: year,
      groups,
      // Every clean room in the year, for the cases where the category is not
      // set on an older row and the name is the only clue.
      classrooms: clean.map(r => ({ id: r._id, name: r.name, category: r.category, capacity: r.capacity })),
      garbled_classrooms: rooms.length - clean.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/external-enrollments/classrooms  { branch_id, academic_year, category, name, capacity }
 *
 * Creating the year's rooms from inside the import, because that is where the
 * absence is discovered and sending someone to another screen mid-import is
 * how a cohort ends up half-filed.
 */
async function createClassroom(req, res, next) {
  try {
    const { branch_id, category, name, capacity } = req.body || {};
    const academic_year = normalizeYear(req.body?.academic_year || '');
    if (!branch_id || !name || !academic_year) {
      return res.status(400).json({ error: 'חסרים סניף, שם כיתה או שנה' });
    }
    // A branch manager reaches this route, and the branch is a body field.
    if (!await canAccessBranch(req, branch_id)) return res.status(403).json(NOT_YOUR_BRANCH);
    // Required, not merely validated. A room with no age group is invisible to
    // this very screen — see the note on categoryError in classroom.controller.
    if (!category) {
      return res.status(400).json({
        error: 'יש לבחור קבוצת גיל לכיתה. בלי קבוצה הכיתה לא תוצע כאן ואי אפשר יהיה לשבץ אליה.',
      });
    }
    if (!Classroom.CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'קטגוריית כיתה לא תקינה' });
    }
    const existing = await Classroom.findOne({ name, academic_year, branch_id });
    if (existing) {
      return res.status(409).json({ error: 'כיתה בשם זה כבר קיימת בסניף לשנה זו' });
    }
    const classroom = await Classroom.create({
      name, category, academic_year, branch_id,
      capacity: Number(capacity) || null,
    });
    res.status(201).json({ classroom: { ...classroom.toObject(), id: classroom._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * Turn one reviewed enrollment into a real registration.
 *
 * Creates the Registration and the Child, and — when ClickTac recorded a
 * registration-fee receipt — the Collection row that already holds it, so the
 * money the family has demonstrably paid is not asked for a second time.
 *
 * The contract was signed in ClickTac. `agreement_signed` stays FALSE because
 * this system holds no signature, and `configuration.external_source` records
 * where it was signed instead — a completed registration with no signature is
 * flagged on the registrations page, and that flag would be a lie here.
 *
 * THE FEE IS DECIDED HERE AND NOWHERE ELSE. Three paths reach this function —
 * the single promote, the bulk promote and the placement confirm — and until
 * now each of them passed a number a screen had picked. The contracts export
 * carries the family's own דרגה, so the number is derivable, and deriving it in
 * one place is the only way the three paths can agree. `opts.monthly_fee` is
 * still honoured for every child the matrix cannot price; `monthly_fee_override`
 * beats the tier and says a person meant to.
 */
async function promoteOne(doc, opts) {
  const { registration_fee, classroom_id, userId } = opts;

  /**
   * WHICH NUMBER, AND WHY THAT ONE.
   *
   * The order is the order of authority. A human who typed a figure into the
   * override beat the matrix on purpose and must not be second-guessed. Then
   * the family's own דרגה off their signed contract, which is the state's
   * answer and the one that can be defended to a parent. Then whatever the
   * screen sent, which is where every fee came from before this existed and is
   * still where the private branches and the un-priced tiers come from.
   *
   * `opts.pricing` is the branch's matrix, loaded by the caller so a bulk run
   * of seventy children does not read the same document seventy times. Passing
   * `null` explicitly means "priced manually, do not look" — passing nothing
   * makes this load it, which is what keeps a future fourth caller correct by
   * default.
   */
  const pricingDoc = opts.pricing !== undefined
    ? opts.pricing
    : await branchPricingFor(doc.branch_id, doc.academic_year);
  const byTier = tierFeeFor({
    pricing: pricingDoc,
    tier: doc.contract?.tier,
    ageGroup: effectiveAgeGroup(doc),
  });

  const override = opts.monthly_fee_override;
  const hasOverride = override !== undefined && override !== null && override !== ''
    && Number.isFinite(Number(override));

  let monthly_fee;
  let feeSource;
  let feeTier = '';
  if (hasOverride) {
    monthly_fee = Number(override);
    feeSource = 'override';
    // Kept even on an override: "the matrix said 1,410 and somebody chose
    // 1,200" is the fact worth having six months later, and dropping the tier
    // here would leave only the number nobody can explain.
    feeTier = byTier?.tier_label || '';
  } else if (byTier) {
    monthly_fee = byTier.fee;
    feeSource = 'tier';
    feeTier = byTier.tier_label;
  } else {
    monthly_fee = Number(opts.monthly_fee ?? 0) || 0;
    feeSource = 'manual';
  }

  const parentName = `${doc.parent1?.first_name || ''} ${doc.parent1?.last_name || ''}`.trim();
  const [y1, y2] = doc.academic_year.split('-').map(Number);

  const registration = await Registration.create({
    unique_id: generateUniqueId('REG'),
    branch_id: doc.branch_id,
    child_name: doc.child.full_name,
    child_birth_date: doc.child.birth_date,
    classroom_id: classroom_id || null,
    parent_name: parentName,
    parent_id_number: doc.parent1?.id_number || null,
    parent_phone: doc.parent1?.phone || null,
    parent_email: doc.parent1?.email || null,
    monthly_fee,
    fee_source: feeSource,
    fee_tier: feeTier,
    registration_fee: registration_fee || 0,
    start_date: new Date(Date.UTC(y1, 8, 1)),
    end_date: new Date(Date.UTC(y2, 7, 31)),
    academic_year: doc.academic_year,
    // Enrolled, and accepted — but signed somewhere else.
    status: 'completed',
    agreement_signed: false,
    card_completed: true,
    configuration: {
      external_source: {
        system: 'clicktac',
        enrollment_id: String(doc._id),
        child_id_number: doc.child.id_number,
        status: doc.enrollment?.status || '',
        second_signer: doc.enrollment?.second_signer || '',
        continuing: !!doc.enrollment?.continuing,
        registered_at: doc.enrollment?.registered_at || null,
        receipt_number: doc.enrollment?.receipt_number || '',
        portal: doc.enrollment?.portal || '',
        age_group: doc.child.age_group,
        computed_age_group: doc.computed?.age_group,
        placed_age_group: doc.placement?.age_group_override || '',
        health_fund: doc.child.health_fund,
        gender: doc.child.gender,
        standing_order: doc.standing_order || {},
        tuition_method: doc.enrollment?.tuition_method || '',
        // From the contracts export, when it has been uploaded. The tier is
        // the one thing that explains a fee after the fact — a registration
        // billed 1,410 with no record of which דרגה produced it is a number
        // nobody can defend to a parent six months later.
        contract_class: doc.contract?.class_name || '',
        contract_tier: doc.contract?.tier || '',
        contract_tuition_type: doc.contract?.tuition_type || '',
        contract_start: doc.contract?.start_date || null,
        contract_end: doc.contract?.end_date || null,
      },
      medical_alerts: doc.child.has_allergy ? doc.child.allergy_detail : '',
    },
  });

  // Both parents, from the start. ClickTac asks for two registrants and 73 of
  // 77 rows have both — this is the one import where the second parent is not
  // something to infer later.
  const parent2Name = `${doc.parent2?.first_name || ''} ${doc.parent2?.last_name || ''}`.trim();
  await Child.create({
    registration_id: registration._id,
    child_name: doc.child.full_name,
    child_id_number: doc.child.id_number || null,
    birth_date: doc.child.birth_date,
    // ClickTac already asked. Kept on the child rather than only inside the
    // registration's blob, because that is where the gan reads it from —
    // אבא / אמא של שבת is two rotations, and nobody should be re-entering a
    // fact the import was handed.
    gender: shabbat.normalizeGender(doc.child.gender),
    classroom_id: classroom_id || null,
    parent_name: parentName,
    parent_id_number: doc.parent1?.id_number || null,
    phone: doc.parent1?.phone || null,
    email: doc.parent1?.email || null,
    parent2_name: parent2Name || null,
    parent2_id_number: doc.parent2?.id_number || null,
    parent2_phone: doc.parent2?.phone || null,
    parent2_email: doc.parent2?.email || null,
    address: doc.parent1?.address || doc.parent2?.address || null,
    allergies: doc.child.has_allergy ? doc.child.allergy_detail : null,
    medical_alerts: doc.child.health_fund ? `קופת חולים: ${doc.child.health_fund}` : null,
    emergency_contact: doc.child.aide_name || null,
    emergency_phone: doc.child.aide_phone || null,
    academic_year: doc.academic_year,
    is_active: true,
  });

  // A child absorbed before their fee is known.
  //
  // At the subsidised branches the monthly fee is a function of the family's
  // income bracket — twelve tiers against three age groups, 938 to 3,936 at
  // הרצליה — and the bracket appears in neither file: not in ClickTac, and not
  // in the ministry's export, whose columns stop at the absorption date. So a
  // cohort can be fully approved, fully registered and certain to attend, and
  // still have no defensible number to bill.
  //
  // Enrolling them at zero is the honest version of that: it says the child is
  // here and the money is not yet decided, where inventing a figure would put a
  // number nobody agreed to onto a family's account. But zero is also what a
  // fee of zero looks like, so the intent is recorded rather than left to be
  // guessed from the amount — this is the list to work through against ClickTac
  // when the brackets arrive.
  if (!monthly_fee) {
    await Registration.updateOne({ _id: registration._id }, {
      $set: { 'configuration.external_source.fee_pending': true },
    });
  }

  // The registration fee was paid in ClickTac and has a receipt number. Filing
  // it means the collections table opens showing it paid rather than owed.
  if (doc.enrollment?.receipt_number) {
    await Collection.findOneAndUpdate(
      { registration_id: registration._id, academic_year: doc.academic_year },
      {
        $set: { registration_fee_receipt: doc.enrollment.receipt_number },
        $setOnInsert: { registration_id: registration._id, academic_year: doc.academic_year, months: [] },
      },
      { upsert: true },
    );
  }

  await ExternalEnrollment.updateOne({ _id: doc._id }, {
    $set: {
      'review.status': 'imported',
      'review.imported_registration_id': registration._id,
      'review.imported_at': new Date(),
    },
  });

  return registration;
}

/** POST /api/external-enrollments/:id/promote */
async function promote(req, res, next) {
  try {
    const doc = await ExternalEnrollment.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    // The row carries its own branch — the id in the path does not say which.
    if (!await canAccessBranch(req, doc.branch_id)) return res.status(403).json(NOT_YOUR_BRANCH);
    if (doc.review?.status === 'imported') {
      return res.status(409).json({ error: 'הרשומה כבר יובאה למערכת' });
    }
    /**
     * A contract without a family.
     *
     * The contracts export brings the class and the דרגה and not one parent
     * column, so a row that has only been in it would become a Registration
     * with an empty parent_name, no phone and no email — a child in the system
     * whose family nobody can reach, discovered in October. Refused here
     * rather than filled with placeholders: the missing half exists, it is one
     * upload away, and saying so is more useful than inventing it.
     */
    if (!hasParents(doc)) {
      return res.status(400).json({ error: NO_PARENTS_MESSAGE, code: 'MISSING_PARENTS' });
    }
    // Zero is allowed and means "not decided yet" — see promoteOne. A missing
    // or negative figure is still refused: that is a mistake, not a decision.
    const monthlyFee = Number(req.body?.monthly_fee ?? 0);
    if (!Number.isFinite(monthlyFee) || monthlyFee < 0) {
      return res.status(400).json({ error: 'שכר לימוד לא תקין' });
    }
    /**
     * BACKWARD COMPATIBLE ON PURPOSE. `monthly_fee` still means what it always
     * meant — the fee a screen picked — and it is still what a child with no
     * דרגה is billed. `monthly_fee_override` is the new, louder word: it beats
     * the tier, and it exists so that overriding the state's matrix is
     * something a caller has to say rather than something it does by accident
     * because it happened to post a number.
     */
    const overrideRaw = req.body?.monthly_fee_override;
    const hasOverride = overrideRaw !== undefined && overrideRaw !== null && overrideRaw !== '';
    if (hasOverride && !(Number.isFinite(Number(overrideRaw)) && Number(overrideRaw) >= 0)) {
      return res.status(400).json({ error: 'שכר לימוד לא תקין' });
    }
    if (doc.review?.matched_registration_id && !req.body?.allow_duplicate) {
      return res.status(409).json({
        error: `${doc.child.full_name} כבר קיים/ת במערכת`,
        code: 'ALREADY_IN_SYSTEM',
        matched_registration_id: doc.review.matched_registration_id,
      });
    }

    const registration = await promoteOne(doc, {
      monthly_fee: monthlyFee,
      monthly_fee_override: hasOverride ? Number(overrideRaw) : undefined,
      registration_fee: Number(req.body?.registration_fee) || 0,
      // The room decided on the placement screen, unless this call names one.
      classroom_id: req.body?.classroom_id || doc.placement?.classroom_id || null,
      userId: req.user?.id || null,
    });

    res.status(201).json({ registration: { ...registration.toObject(), id: registration._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/external-enrollments/promote-bulk  { ids, fees_by_age_group, registration_fee }
 *
 * `fees_by_age_group` rather than one fee: the state matrix prices a תינוק
 * differently from a בוגר, and a single number applied to seventy children
 * would be wrong for most of them.
 *
 * AND IT IS NOW THE FALLBACK, NOT THE RULE. A child whose contract names a
 * דרגה is priced off that child's own row of the matrix, which is the whole
 * point of the contracts export — `fees_by_age_group` is what the children
 * WITHOUT a tier are billed. `override_tier: true` says the caller means these
 * numbers to beat the matrix, and only then do they.
 *
 * Each failure is reported with its reason instead of aborting the run — a
 * duplicate in the middle of a list should not leave half of it imported with
 * nothing saying which half.
 */
async function promoteBulk(req, res, next) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'לא נבחרו רשומות' });
    const fees = req.body?.fees_by_age_group || {};
    const regFee = Number(req.body?.registration_fee) || 0;
    const overrideTier = ['1', 'true', true].includes(req.body?.override_tier);
    /**
     * One matrix per branch, for the whole run.
     *
     * A bulk promote is seventy rows and they are almost always one branch;
     * loading the pricing document per row would be seventy identical reads,
     * and loading it once outside the loop would be wrong for the list that
     * spans two gans. Keyed by branch and year, which is exactly what the
     * document is unique on.
     */
    const pricingCache = new Map();
    const pricingFor = async (branchId, year) => {
      const key = `${branchId}|${year}`;
      if (!pricingCache.has(key)) pricingCache.set(key, await branchPricingFor(branchId, year));
      return pricingCache.get(key);
    };

    // One lookup for the whole batch instead of one User.findById per row —
    // canAccessBranch(req, branchId) just calls resolveBranchScope(req) and
    // tests the id against it, and that scope does not change row to row.
    const scope = await resolveBranchScope(req);

    const imported = [];
    const skipped = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await ExternalEnrollment.findById(id).lean();
      if (!doc) { skipped.push({ id, error: 'לא נמצאה' }); continue; }
      // Reported per row rather than aborting, like every other refusal here:
      // a list that spans two gans should import the half it may.
      if (!(scope === null || scope.includes(String(doc.branch_id)))) {
        skipped.push({ id, child: doc.child?.full_name, error: 'אין לך הרשאה לסניף זה' });
        continue;
      }
      if (doc.review?.status === 'imported') { skipped.push({ id, child: doc.child.full_name, error: 'כבר יובאה' }); continue; }
      // Same refusal as the single promote, reported per row rather than
      // aborting: a branch that uploaded contracts first has a list where some
      // children have their family and some do not, and the half that can be
      // imported should be.
      if (!hasParents(doc)) {
        skipped.push({ id, child: doc.child.full_name, error: NO_PARENTS_MESSAGE, code: 'MISSING_PARENTS' });
        continue;
      }
      if (doc.review?.matched_registration_id && !req.body?.allow_duplicate) {
        skipped.push({ id, child: doc.child.full_name, error: 'כבר קיים/ת במערכת' });
        continue;
      }
      const group = effectiveAgeGroup(doc);
      const fee = Number(fees[group] ?? 0);
      if (!Number.isFinite(fee) || fee < 0) {
        skipped.push({ id, child: doc.child.full_name, error: `שכר לימוד לא תקין לשכבה "${group}"` });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const reg = await promoteOne(doc, {
          monthly_fee: fee,
          monthly_fee_override: overrideTier ? fee : undefined,
          // eslint-disable-next-line no-await-in-loop
          pricing: await pricingFor(doc.branch_id, doc.academic_year),
          registration_fee: regFee,
          // The classroom follows the child's age group, which is the whole
          // point of computing it. One classroom for everybody would put a
          // four-month-old in with the two-year-olds.
          classroom_id: doc.placement?.classroom_id
            || (req.body?.classrooms_by_age_group || {})[group]
            || req.body?.classroom_id || null,
          userId: req.user?.id || null,
        });
        imported.push({ id, child: doc.child.full_name, registration_id: reg._id });
      } catch (e) {
        skipped.push({ id, child: doc.child.full_name, error: e.message });
      }
    }

    res.json({ imported: imported.length, skipped, details: imported });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/external-enrollments/:id/review  { status, note } */
async function setReview(req, res, next) {
  try {
    const status = req.body?.status;
    if (!['pending', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }
    // Read before write: the row's branch is the only thing that says whether
    // this caller may touch it, and findByIdAndUpdate would have written first.
    const before = await ExternalEnrollment.findById(req.params.id).select('branch_id').lean();
    if (!before) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    if (!await canAccessBranch(req, before.branch_id)) return res.status(403).json(NOT_YOUR_BRANCH);

    const doc = await ExternalEnrollment.findByIdAndUpdate(
      req.params.id,
      { $set: { 'review.status': status, 'review.note': req.body?.note || '' } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    // Same strip as `list`. This route answers a click on a chip in a table —
    // it is not the detail view — and a status change is no reason to put the
    // family's bank account and the whole raw spreadsheet row on the wire.
    const { standing_order: _bank, raw: _raw, ...rest } = doc;
    res.json({ enrollment: { ...rest, id: doc._id } });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/external-enrollments/:id/placement  { age_group, classroom_id, note }
 *
 * The manager's own call on which group a child joins.
 *
 * The ministry's שכבת גיל is a funding bracket and ClickTac's is whatever the
 * parent's form said; neither knows this gan. A child of 22 months may belong
 * with the בוגרים here and with the צעירים next door, and the person who runs
 * the room is the one who can say. The decision is stored separately from
 * everything parsed out of a file, so the next export cannot quietly undo it,
 * and it is what the import then uses to pick the fee column and the room.
 *
 * Sending an empty age_group clears the decision and hands the child back to
 * the computed group.
 */
async function setPlacement(req, res, next) {
  try {
    const group = String(req.body?.age_group || '').trim();
    const valid = AGE_GROUPS.map(g => g.name);
    if (group && !valid.includes(group)) {
      return res.status(400).json({ error: `שכבת גיל לא תקינה. אפשרויות: ${valid.join(', ')}` });
    }

    const doc = await ExternalEnrollment.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'רשומה לא נמצאה' });
    // A branch manager reaches this route; the row says which gan it belongs to.
    if (!await canAccessBranch(req, doc.branch_id)) return res.status(403).json(NOT_YOUR_BRANCH);
    if (doc.review?.status === 'imported') {
      return res.status(409).json({
        error: `${doc.child.full_name} כבר נקלט/ה למערכת — שיבוץ הכיתה משתנה במסך הכיתות`,
        code: 'ALREADY_IMPORTED',
      });
    }

    let classroomId = req.body?.classroom_id || null;
    if (classroomId) {
      const room = await Classroom.findById(classroomId).lean();
      if (!room) return res.status(404).json({ error: 'כיתה לא נמצאה' });
      if (String(room.branch_id) !== String(doc.branch_id)) {
        return res.status(400).json({ error: 'הכיתה שייכת לסניף אחר' });
      }
      if (room.academic_year && normalizeYear(room.academic_year) !== doc.academic_year) {
        return res.status(400).json({ error: 'הכיתה שייכת לשנת לימודים אחרת' });
      }
    }
    // Clearing the group with no room named clears the whole decision.
    if (!group && !classroomId) classroomId = null;

    doc.placement = {
      age_group_override: group,
      classroom_id: classroomId,
      decided_by: req.user?.id || null,
      decided_at: group || classroomId ? new Date() : null,
      note: String(req.body?.note || ''),
    };
    await doc.save();

    res.json({
      enrollment: {
        id: doc._id,
        child_name: doc.child.full_name,
        placement: doc.placement,
        effective_age_group: effectiveAgeGroup(doc.toObject()),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/external-enrollments/data?branch=&year=   — undo a whole upload.
 *
 * A file put against the wrong branch files a whole cohort in the wrong gan,
 * and there is no way to un-see that row by row. So the unit of undo is the
 * unit of the mistake: every ClickTac record for one branch and one year, and
 * the upload history with it, deleted together and re-uploaded clean.
 *
 * Rows already turned into registrations are the one thing this refuses to
 * touch. Those created a Registration, a Child and possibly a paid collection
 * row; deleting the enrollment behind them would leave the registration
 * standing with nothing to explain where it came from. They are listed by
 * name instead, so whoever is undoing knows exactly what is in the way.
 */
async function deleteData(req, res, next) {
  try {
    const branchId = req.query.branch;
    if (!branchId || branchId === 'all') return res.status(400).json({ error: 'יש לבחור סניף' });
    if (!await canAccessBranch(req, branchId)) return res.status(403).json(NOT_YOUR_BRANCH);
    const academicYear = normalizeYear(req.query.year || '');
    if (!/^\d{4}-\d{4}$/.test(academicYear)) return res.status(400).json({ error: 'יש לבחור שנת לימודים' });

    const filter = { source: 'clicktac', branch_id: branchId, academic_year: academicYear };
    const imported = await ExternalEnrollment.find({ ...filter, 'review.status': 'imported' })
      .select('child.full_name review.imported_registration_id').lean();

    if (imported.length && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${imported.length} רשומות כבר נקלטו למערכת כרישום ולא ניתן למחוק אותן מכאן`,
        code: 'HAS_IMPORTED',
        imported: imported.map(d => d.child?.full_name).filter(Boolean),
      });
    }

    // With force, the ones already promoted stay — only the untouched go.
    const toDelete = imported.length
      ? { ...filter, 'review.status': { $ne: 'imported' } }
      : filter;
    const { deletedCount } = await ExternalEnrollment.deleteMany(toDelete);
    const batches = await EnrollmentImport.deleteMany({
      source: 'clicktac', branch_id: branchId, academic_year: academicYear,
    });

    res.json({
      deleted: deletedCount,
      kept_imported: imported.length,
      batches_deleted: batches.deletedCount,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/external-enrollments/contacts?branch=&year=
 *
 * The parent contact sheet — the thing that could not be built at all from the
 * previous export, which carried no parent data of any kind. One row per
 * child, both parents, phones and emails, with the relation (אם / אב) so it is
 * clear who is who.
 */
async function contacts(req, res, next) {
  try {
    const filter = { ...getBranchFilter(req) };
    if (req.query.year) filter.academic_year = normalizeYear(req.query.year);
    if (req.query.status) filter['review.status'] = req.query.status;

    const docs = await ExternalEnrollment.find(filter)
      .select('child parent1 parent2 academic_year enrollment.status computed')
      .sort({ 'child.full_name': 1 })
      .lean();

    res.json({
      contacts: docs.map(d => ({
        child_name: d.child.full_name,
        child_id_number: d.child.id_number,
        birth_date: d.child.birth_date,
        age_group: d.computed?.age_group || d.child.age_group,
        status: d.enrollment?.status || '',
        parent1_name: `${d.parent1?.first_name || ''} ${d.parent1?.last_name || ''}`.trim(),
        parent1_relation: d.parent1?.relation || '',
        parent1_phone: d.parent1?.phone || '',
        parent1_email: d.parent1?.email || '',
        parent2_name: `${d.parent2?.first_name || ''} ${d.parent2?.last_name || ''}`.trim(),
        parent2_relation: d.parent2?.relation || '',
        parent2_phone: d.parent2?.phone || '',
        parent2_email: d.parent2?.email || '',
        address: d.parent1?.address || d.parent2?.address || '',
      })),
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  importFile, list, getOne, pricing, promote, promoteBulk, setReview, contacts,
  classroomPlan, createClassroom, setPlacement, deleteData, effectiveAgeGroup,
  // The merge rules, so the reconciliation view and the tests read the same
  // answer the importer wrote rather than each deciding for themselves.
  sourcesOf, hasParents, NO_PARENTS_MESSAGE, lastClickTacImports, withImporterName,
  // Used by the placement board's confirm step, which is the same act of
  // creating a registration seen from the other end.
  promoteOne,
  // …and the matrix that step prices with, so the two screens read the same
  // document through the same year-format tolerance.
  branchPricingFor,
};
