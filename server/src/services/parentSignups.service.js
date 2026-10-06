/**
 * Which parents can reach the portal, and which already have.
 *
 * Nothing else in the system can answer this. There is no parent-accounts
 * screen, and the account itself is not the whole answer: a parent is only
 * able to activate when the ENROLMENT data lets them — an ID number the
 * lookup can find, and a mobile the code can be sent to. So the question is
 * asked of the children first and the accounts second, which is also the
 * order the portal's own login asks it in (parentDirectory.service).
 *
 * One service rather than one query in a controller and another in a script,
 * because there were two and they would have drifted inside a month — the
 * screen and the report would have shown the gan different numbers for the
 * same branch, and nobody would have known which to believe.
 */
const { Child, ParentAccount, Classroom, Branch } = require('../models');
const { contactFromChild, normalizeIdNumber } = require('./parentDirectory.service');
const nursery = require('./nursery.service');

/**
 * Why a parent cannot activate, or null when they can.
 *
 * These are the two the enrolment data decides, and they are the only ones a
 * reminder will not fix: no amount of nudging helps somebody the sign-in
 * screen cannot find, or whose code has nowhere to go. The office has to
 * change the record first, which is why they are surfaced separately rather
 * than counted among "has not signed up yet".
 */
function blockedReason(entry) {
  if (!entry.id) return 'no_id';
  if (!entry.phone) return 'no_phone';
  return null;
}

/**
 * @param {object} opts
 * @param {string[]|null} opts.branchIds  branches to look at; null = every one
 * @param {string} [opts.classroom]       narrow to rooms whose name contains this
 * @returns {Promise<{ branches, classrooms, parents, summary }>}
 */
async function signups({ branchIds = null, classroom = '' } = {}) {
  const branchFilter = branchIds ? { _id: { $in: branchIds } } : {};
  const branches = await Branch.find({ is_active: true, ...branchFilter })
    .select('name').sort({ name: 1 }).lean();

  let rooms = await Classroom.find({ branch_id: { $in: branches.map(b => b._id) } })
    .select('_id name category branch_id').lean();
  if (classroom) {
    const needle = String(classroom).trim();
    rooms = rooms.filter(r => String(r.name || '').includes(needle));
  }

  // Test families are excluded, not hidden by a name match — see
  // Child.is_test_account. Four of them, one per branch, and counted they
  // made "324 parents have not signed up" wrong by four every single day.
  const children = await Child.find({
    is_active: true,
    is_test_account: { $ne: true },
    classroom_id: { $in: rooms.map(r => r._id) },
  })
    .populate('registration_id', 'parent_name parent_phone parent_id_number start_date end_date')
    .populate('classroom_id', 'name category branch_id')
    .sort({ child_name: 1 })
    .lean();

  const branchName = new Map(branches.map(b => [String(b._id), b.name]));

  /**
   * Keyed on the ID number, not on the child: an account is a person and a
   * person is a family. Two siblings are one activation and one reminder, and
   * counting them twice would make the branch look half as far along as it is.
   */
  const byParent = new Map();
  const childrenWithoutParentId = [];

  for (const child of children) {
    const reg = child.registration_id;
    const room = child.classroom_id;
    const ids = new Set();
    for (const raw of [child.parent_id_number, child.parent2_id_number, reg?.parent_id_number]) {
      const id = normalizeIdNumber(raw);
      if (id) ids.add(id);
    }

    if (!ids.size) {
      childrenWithoutParentId.push({
        child_name: child.child_name,
        classroom: room?.name || '',
        branch: branchName.get(String(room?.branch_id)) || '',
      });
      continue;
    }

    for (const id of ids) {
      if (!byParent.has(id)) {
        byParent.set(id, { id, name: '', phone: null, children: [] });
      }
      const entry = byParent.get(id);
      entry.children.push({
        id: String(child._id),
        name: child.child_name,
        classroom: room?.name || '',
        classroom_id: String(room?._id || ''),
        branch: branchName.get(String(room?.branch_id)) || '',
        branch_id: String(room?.branch_id || ''),
        // Whether this family sees a daily board at all — the thing the
        // portal is mostly being opened for.
        board: room ? nursery.boardKindForChild(child, room) : 'none',
      });
      const { name, phone } = contactFromChild(child, id);
      if (!entry.name && name) entry.name = name;
      if (!entry.phone && phone) entry.phone = phone;
    }
  }

  const accounts = await ParentAccount.find({ id_number: { $in: [...byParent.keys()] } })
    .select('id_number activated is_active access_approved last_login_at created_at')
    .lean();
  const accountById = new Map(accounts.map(a => [normalizeIdNumber(a.id_number), a]));

  const parents = [...byParent.values()].map((entry) => {
    const account = accountById.get(entry.id) || null;
    const blocked = blockedReason(entry);

    let state;
    if (account && account.is_active === false) state = 'closed';
    else if (account && account.access_approved === false) state = 'awaiting_approval';
    else if (account && account.activated) state = 'active';
    else if (blocked) state = 'blocked';
    else state = 'not_signed_up';

    return {
      id_number: entry.id,
      name: entry.name || '',
      phone: entry.phone || null,
      children: entry.children,
      // The screen groups by branch, and a parent belongs wherever their
      // children are — one family can straddle two of them.
      branches: [...new Set(entry.children.map(c => c.branch).filter(Boolean))],
      classrooms: [...new Set(entry.children.map(c => c.classroom).filter(Boolean))],
      state,
      blocked_reason: blocked,
      last_login_at: account?.last_login_at || null,
      activated_at: account?.activated ? (account.created_at || null) : null,
    };
  }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  const count = (s) => parents.filter(p => p.state === s).length;
  const summary = {
    children: children.length,
    parents: parents.length,
    active: count('active'),
    not_signed_up: count('not_signed_up'),
    blocked: count('blocked'),
    awaiting_approval: count('awaiting_approval'),
    closed: count('closed'),
    children_without_parent_id: childrenWithoutParentId.length,
  };

  return {
    branches: branches.map(b => ({ id: String(b._id), name: b.name })),
    classrooms: [...new Set(rooms.map(r => r.name))].sort((a, b) => a.localeCompare(b, 'he')),
    parents,
    children_without_parent_id: childrenWithoutParentId,
    summary,
  };
}

module.exports = { signups, blockedReason };
