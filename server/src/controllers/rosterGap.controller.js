const { Registration, ExternalEnrollment, Child, Branch, Classroom } = require('../models');
const { resolveBranchScope } = require('../utils/branch-scope');
const { normalizeChildName, getAcademicYears } = require('../services/academic-year.service');
const { compareRoster, KINDS } = require('../services/roster-gap');

/**
 * פערי רישום — the roster the gan actually keeps, against the cards here.
 *
 * Read-only, on purpose and for now. Every finding this produces has more than
 * one honest answer — a child with no card may be a card nobody made or a
 * child who never came, and a card claiming this year with no registration
 * behind it may be a direct entry or a leftover — and the person at the gan is
 * the one who knows which. The screen shows the disagreement; it does not
 * resolve it.
 */

/**
 * Which screen holds this branch's real roster.
 *
 * Stated rather than inferred. It could be derived — a branch with external
 * rows uses them — but a single stray import would then flip a branch onto the
 * wrong source silently, and the answer would change under somebody without
 * anything being decided. The response says which source each branch was read
 * against, so a wrong one is visible rather than buried.
 *
 * כפר סבא - קפלן registers in this system. The other three sit under רשת
 * מעונות אמונה and register in קליקטאק.
 */
const REGISTRATION_BRANCHES = ['כפר סבא - קפלן'];

function sourceFor(branchName) {
  return REGISTRATION_BRANCHES.includes(branchName) ? 'registration' : 'external';
}

/** The roster rows, in the one shape the comparison understands. */
async function rosterFor({ branch, year }) {
  if (sourceFor(branch.name) === 'registration') {
    const rows = await Registration.find({ branch_id: branch._id, academic_year: year })
      .select('child_name status classroom_id')
      .populate('classroom_id', 'name academic_year')
      .lean();
    return rows.map((r) => ({
      id: String(r._id),
      name: r.child_name,
      id_number: '',
      status: r.status || '',
      classroom_name: r.classroom_id?.name || '',
    }));
  }
  const rows = await ExternalEnrollment.find({
    branch_id: branch._id,
    academic_year: year,
    // An ignored row is a decision already taken about that child. A pending
    // one has not been decided and is exactly what this screen is for.
    'review.status': { $ne: 'ignored' },
  })
    .select('child.full_name child.first_name child.last_name child.id_number review.status class_name')
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    name: r.child?.full_name
      || [r.child?.first_name, r.child?.last_name].filter(Boolean).join(' '),
    id_number: r.child?.id_number || '',
    status: r.review?.status || '',
    classroom_name: r.class_name || '',
  }));
}

/** GET /api/roster-gap?year=YYYY-YYYY&branch=<id|all> */
async function list(req, res, next) {
  try {
    const year = req.query.year || getAcademicYears().current.range;
    const scope = await resolveBranchScope(req);
    const filter = scope === null ? {} : { _id: { $in: scope } };
    if (req.query.branch && req.query.branch !== 'all') {
      if (scope !== null && !scope.map(String).includes(String(req.query.branch))) {
        return res.status(403).json({ error: 'הסניף המבוקש אינו בניהולך' });
      }
      filter._id = req.query.branch;
    }
    const branches = await Branch.find(filter).select('name').sort({ name: 1 }).lean();

    const out = [];
    for (const branch of branches) {
      // eslint-disable-next-line no-await-in-loop
      const roster = await rosterFor({ branch, year });
      // eslint-disable-next-line no-await-in-loop
      const rooms = await Classroom.find({ branch_id: branch._id }).select('_id name academic_year').lean();
      const roomById = new Map(rooms.map((r) => [String(r._id), r]));
      // eslint-disable-next-line no-await-in-loop
      const cardRows = await Child.find({ classroom_id: { $in: rooms.map((r) => r._id) } })
        .select('child_name academic_year classroom_id').lean();
      const cards = cardRows.map((c) => {
        const room = roomById.get(String(c.classroom_id));
        return {
          id: String(c._id),
          name: c.child_name,
          academic_year: c.academic_year || '',
          classroom_name: room?.name || '',
          classroom_year: room?.academic_year || '',
        };
      });

      out.push({
        branch_id: String(branch._id),
        branch_name: branch.name,
        ...compareRoster({
          source: sourceFor(branch.name),
          roster,
          cards,
          year,
          normalize: normalizeChildName,
        }),
      });
    }

    const years = getAcademicYears();
    res.json({
      year,
      // The year being asked about, the one before it, and the one after —
      // enough to answer "did last year ever get closed" without a year picker
      // that lists a decade.
      years: [years.next, years.current, {
        range: `${Number(years.current.range.slice(0, 4)) - 1}-${Number(years.current.range.slice(0, 4))}`,
        label: `${Number(years.current.range.slice(0, 4)) - 1}/${Number(years.current.range.slice(0, 4))}`,
      }].map((y) => ({ range: y.range, label: y.label })),
      branches: out,
      // So the screen can say what each label means without hard-coding it.
      kinds: {
        [KINDS.NO_CARD]: 'אין כרטיס ילד',
        [KINDS.STALE_YEAR]: 'הכרטיס בשנה קודמת',
        [KINDS.ORPHAN_CARD]: 'כרטיס בלי רישום',
        [KINDS.DUPLICATE_CARD]: 'שני כרטיסים לאותה שנה',
      },
      sources: { registration: 'רישום', external: 'רישום חיצוני' },
    });
  } catch (err) { next(err); }
}

module.exports = { list, sourceFor, REGISTRATION_BRANCHES };
