const { PayrollRollup, Branch } = require('../models');

/**
 * The payroll screen for somebody who is not standing in a branch.
 *
 * A network director opening the ordinary payroll month waits while every
 * employee in the network has their pay worked out one at a time — thirty
 * seconds at four hundred branches, and worse than linear from there. Then they
 * scroll past eighty thousand rows looking for a number that was never on the
 * screen: what the מחוז costs this month.
 *
 * So this answers the question they actually asked. One row per unit reporting
 * to them — twenty districts, not eighty thousand carers — and the cost is the
 * number of units they manage, not the size of the network beneath them. A
 * director of two thousand branches and a director of ten wait the same time.
 *
 * Drilling down is asking again with a lower node, and the last step down is
 * the branch, where the existing screen already answers in about 100ms and
 * shows the individual people. Nobody loses detail; it stops being fetched by
 * people who were never going to read it.
 *
 * THE FIGURES ARE AS OF WHEN EACH BRANCH WAS LAST COMPUTED, not as of now —
 * see PayrollRollup for why they are written rather than recalculated. That is
 * reported rather than hidden: `stale_since` is the oldest branch in the answer
 * and `missing` counts the ones nobody has opened at all. A total that quietly
 * leaves out four branches is worse than a total that says it did.
 */
async function rollup(req, res, next) {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM נדרש' });
    }

    const OrgUnit = req.models ? req.models.OrgUnit : null;
    if (!OrgUnit) {
      return res.status(501).json({ error: 'אין עץ ארגוני במערכת הזו' });
    }

    // Where the viewer STANDS — their own node, not the top of the tree. A
    // district head opening this without asking for anything gets their
    // district, because that is the screen they came for.
    let home = null;
    if (req.user && req.user.org_unit_id) {
      home = await OrgUnit.findById(req.user.org_unit_id).lean();
    }
    if (!home) {
      // No node on the user: only somebody who already sees the whole customer
      // may stand at the root. Anyone else is told to be placed in the chart
      // rather than quietly handed the network.
      if (req.user && req.user.role !== 'system_admin') {
        return res.status(403).json({ error: 'לא שויכת ליחידה בעץ הארגוני' });
      }
      home = await OrgUnit.findOne({ parent_id: null }).lean();
      if (!home) return res.status(404).json({ error: 'לא הוגדר עץ ארגוני' });
    }

    // Drilling down is asking for a lower node — and it may only go DOWN.
    // Without this check the id is a request parameter, which means a district
    // head reads a neighbouring district by editing a URL. The subtree is a
    // ceiling: `path` contains every ancestor, so "is this under me" is one
    // comparison and not a walk.
    let node = home;
    if (req.query.node && String(req.query.node) !== String(home._id)) {
      const asked = await OrgUnit.findById(req.query.node).lean();
      if (!asked) return res.status(404).json({ error: 'יחידה לא נמצאה' });
      const under = (asked.path || []).some((p) => String(p) === String(home._id));
      if (!under) return res.status(403).json({ error: 'היחידה הזו אינה תחת האחריות שלך' });
      node = asked;
    }

    const children = await OrgUnit.find({ parent_id: node._id })
      .select('_id name kind branch_id').sort({ name: 1 }).lean();

    // A leaf asked about itself has no children to summarise — that is the
    // branch screen's job, and saying so is more use than an empty table.
    if (!children.length) {
      return res.json({
        month,
        node: { id: String(node._id), name: node.name, kind: node.kind, branch_id: node.branch_id || null },
        is_leaf: true,
        rows: [],
        total: { units: 0, branches: 0, employees: 0, hours: 0, base: 0 },
        missing: 0,
        stale_since: null,
      });
    }

    // Every branch under each child, in ONE query. `path` holds the ancestry,
    // so the child a branch belongs to is simply the ancestor sitting one level
    // below this node — no walking, and no query per district.
    const childIds = children.map((c) => c._id);
    const leaves = await OrgUnit.find({
      branch_id: { $ne: null },
      $or: [{ _id: { $in: childIds } }, { path: { $in: childIds } }],
    }).select('_id branch_id path').lean();

    const branchToChild = new Map();
    const branchesByChild = new Map(childIds.map((id) => [String(id), []]));
    for (const leaf of leaves) {
      const own = String(leaf._id);
      const viaPath = (leaf.path || []).map(String).find((p) => branchesByChild.has(p));
      const childKey = branchesByChild.has(own) ? own : viaPath;
      if (!childKey) continue;
      branchToChild.set(String(leaf.branch_id), childKey);
      branchesByChild.get(childKey).push(leaf.branch_id);
    }

    const allBranchIds = [...branchToChild.keys()];
    const saved = allBranchIds.length
      ? await PayrollRollup.find({ month, branch_id: { $in: allBranchIds } })
        .select('branch_id employees hours base computed_at').lean()
      : [];

    const byBranch = new Map(saved.map((r) => [String(r.branch_id), r]));

    let oldest = null;
    let missing = 0;
    const rows = children.map((c) => {
      const key = String(c._id);
      const branchIds = branchesByChild.get(key) || [];
      const acc = { employees: 0, hours: 0, base: 0 };
      let counted = 0;
      for (const bid of branchIds) {
        const r = byBranch.get(String(bid));
        if (!r) continue;
        counted += 1;
        acc.employees += r.employees || 0;
        acc.hours += r.hours || 0;
        acc.base += r.base || 0;
        if (!oldest || (r.computed_at && r.computed_at < oldest)) oldest = r.computed_at;
      }
      missing += branchIds.length - counted;
      return {
        id: key,
        name: c.name,
        kind: c.kind,
        is_branch: Boolean(c.branch_id),
        branches: branchIds.length,
        computed_branches: counted,
        employees: acc.employees,
        hours: Math.round(acc.hours * 100) / 100,
        base: Math.round(acc.base * 100) / 100,
      };
    });

    const total = rows.reduce((a, r) => ({
      units: a.units + 1,
      branches: a.branches + r.branches,
      employees: a.employees + r.employees,
      hours: Math.round((a.hours + r.hours) * 100) / 100,
      base: Math.round((a.base + r.base) * 100) / 100,
    }), { units: 0, branches: 0, employees: 0, hours: 0, base: 0 });

    res.json({
      month,
      node: { id: String(node._id), name: node.name, kind: node.kind },
      // Where the viewer stands, so the screen can offer a way back up without
      // offering a way above them.
      home: { id: String(home._id), name: home.name, kind: home.kind },
      can_go_up: String(node._id) !== String(home._id),
      is_leaf: false,
      rows,
      total,
      missing,
      stale_since: oldest,
    });
  } catch (err) { next(err); }
}

module.exports = { rollup };
