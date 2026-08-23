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

    // Where the viewer is standing. Without a node it is the top of the tree —
    // and a customer with no tree at all gets told so rather than an empty page.
    let node = null;
    if (req.query.node) {
      node = await OrgUnit.findById(req.query.node).lean();
      if (!node) return res.status(404).json({ error: 'יחידה לא נמצאה' });
    } else {
      node = await OrgUnit.findOne({ parent_id: null }).lean();
      if (!node) return res.status(404).json({ error: 'לא הוגדר עץ ארגוני' });
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
      is_leaf: false,
      rows,
      total,
      missing,
      stale_since: oldest,
    });
  } catch (err) { next(err); }
}

module.exports = { rollup };
