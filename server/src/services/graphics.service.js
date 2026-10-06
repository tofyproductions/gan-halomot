/**
 * הגרפיקות שלנו — the data behind the printables.
 *
 * Today this answers one question: whose birthday falls in a given month.
 * The gan has always kept that list on a wall calendar, which means it is
 * wrong whenever a child leaves and nobody rubs them out — and the enrolment
 * records already know. One service rather than a query inside the controller
 * because the next graphic (the class list, the name labels) asks the same
 * question of the same collection, and two copies of a branch-scoped child
 * query is how one of them quietly stops excluding the test families.
 */
const { Child, Classroom, Branch } = require('../models');

/** 'ישראל ישראלי' → 'ישראל'. The name a four-year-old answers to. */
function firstNameOf(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

/**
 * How old they turn this birthday.
 *
 * Null when the year is missing or absurd rather than printed as a guess: a
 * card that says the wrong age is worse than one that says no age, and the
 * age is decoration here — the screen shows it so the staff can tell two
 * children with the same name apart.
 */
function turningAge(birth, year) {
  const y = birth.getUTCFullYear();
  if (!y || y < 1990 || y > year) return null;
  return year - y;
}

/**
 * @param {object} opts
 * @param {string[]|null} opts.branchIds  branches to look at; null = every one
 * @param {number} opts.month             1–12
 * @param {number} opts.year              the year the birthday falls in
 * @param {string} [opts.classroom]       narrow to rooms whose name contains this
 */
async function birthdays({ branchIds = null, month, year, classroom = '' } = {}) {
  const branchFilter = branchIds ? { _id: { $in: branchIds } } : {};
  const branches = await Branch.find({ is_active: true, ...branchFilter })
    .select('name').sort({ name: 1 }).lean();

  let rooms = await Classroom.find({ branch_id: { $in: branches.map(b => b._id) } })
    .select('_id name branch_id').lean();
  if (classroom) {
    const needle = String(classroom).trim();
    rooms = rooms.filter(r => String(r.name || '').includes(needle));
  }

  // Same exclusions as every other child read in the system: inactive
  // enrolments are last year's children, and the four test families would
  // each get a card.
  const children = await Child.find({
    is_active: true,
    is_test_account: { $ne: true },
    classroom_id: { $in: rooms.map(r => r._id) },
    birth_date: { $ne: null },
    $expr: { $eq: [{ $month: '$birth_date' }, Number(month)] },
  })
    .select('child_name birth_date gender classroom_id')
    .populate('classroom_id', 'name branch_id')
    .lean();

  const branchName = new Map(branches.map(b => [String(b._id), b.name]));

  const list = children.map((c) => {
    const room = c.classroom_id;
    const birth = new Date(c.birth_date);
    return {
      id: String(c._id),
      full_name: String(c.child_name || '').trim(),
      first_name: firstNameOf(c.child_name),
      gender: c.gender || '',
      day: birth.getUTCDate(),
      age: turningAge(birth, Number(year)),
      classroom: room?.name || '',
      branch: branchName.get(String(room?.branch_id)) || '',
    };
  }).sort((a, b) => a.day - b.day || a.full_name.localeCompare(b.full_name, 'he'));

  return {
    branches: branches.map(b => ({ id: String(b._id), name: b.name })),
    classrooms: [...new Set(rooms.map(r => r.name))].sort((a, b) => a.localeCompare(b, 'he')),
    month: Number(month),
    year: Number(year),
    children: list,
  };
}

/**
 * One child, for the card — and scoped the same way the list is.
 *
 * The card endpoint cannot simply look a child up by id: the id arrives from
 * the browser, and a branch manager who edits it would otherwise print a card
 * carrying another branch's child's name. So the lookup is constrained to the
 * rooms the caller may see, and an id outside them is "not found".
 */
async function childForCard({ branchIds = null, childId }) {
  const branchFilter = branchIds ? { _id: { $in: branchIds } } : {};
  const branches = await Branch.find({ is_active: true, ...branchFilter }).select('_id').lean();
  const rooms = await Classroom.find({ branch_id: { $in: branches.map(b => b._id) } })
    .select('_id').lean();

  const child = await Child.findOne({
    _id: childId,
    is_active: true,
    classroom_id: { $in: rooms.map(r => r._id) },
  }).select('child_name gender').lean();

  if (!child) return null;
  return {
    full_name: String(child.child_name || '').trim(),
    first_name: firstNameOf(child.child_name),
    gender: child.gender || '',
  };
}

module.exports = { birthdays, childForCard, firstNameOf, turningAge };
