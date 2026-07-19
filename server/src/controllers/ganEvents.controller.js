const XLSX = require('xlsx');
const { GanEvent, Branch } = require('../models');
const { generateAccessToken } = require('../utils/id-generator');
const env = require('../config/env');

// Branch scope a manager may see/act on (system_admin & accountant → all).
function managedBranchIds(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null; // null = all
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

// May this request see/manage a campaign covering these member branches?
function canAccess(req, memberIds) {
  const scope = managedBranchIds(req);
  if (!scope) return true; // admin / accountant
  const members = (memberIds || []).map(String);
  return members.some((b) => scope.includes(b));
}

function publicLink(ev) {
  return `${env.FRONTEND_URL}/event/${ev.access_token}`;
}

/**
 * Collapse a per-slot items array into display groups (one per distinct name,
 * first-appearance order) with the claim detail the manager view + PDF need.
 */
function groupItems(items = []) {
  const order = [];
  const byName = new Map();
  for (const it of items) {
    if (!byName.has(it.name)) { byName.set(it.name, { name: it.name, total: 0, taken: 0, claims: [] }); order.push(it.name); }
    const g = byName.get(it.name);
    g.total += 1;
    if (it.claimed_by_id) {
      g.taken += 1;
      g.claims.push({ slot_id: String(it._id), parent_name: it.parent_name || '', parent_phone: it.parent_phone || '', claimed_at: it.claimed_at });
    }
  }
  return order.map((n) => { const g = byName.get(n); return { name: g.name, total: g.total, taken: g.taken, remaining: g.total - g.taken, claims: g.claims }; });
}

// One branch instance → summary object for the client.
function instanceSummary(ev) {
  const groups = groupItems(ev.items);
  const total = ev.items.length;
  const taken = ev.items.filter((i) => i.claimed_by_id).length;
  return {
    id: String(ev._id),
    branch_id: String(ev.branch_id?._id || ev.branch_id),
    branch_name: ev.branch_id?.name || '',
    status: ev.status,
    access_token: ev.access_token,
    link: publicLink(ev),
    total_items: total,
    taken_items: taken,
    remaining_items: total - taken,
    groups,
  };
}

// A set of instances sharing a group_id → one campaign object.
function campaignFromInstances(instances) {
  const first = instances[0];
  const branches = instances
    .map(instanceSummary)
    .sort((a, b) => a.branch_name.localeCompare(b.branch_name, 'he'));
  const total_items = branches.reduce((s, b) => s + b.total_items, 0);
  const taken_items = branches.reduce((s, b) => s + b.taken_items, 0);
  // Status is coherent across the campaign (meta edits propagate); if instances
  // ever diverge, surface 'published' when any branch is live.
  const statuses = new Set(branches.map((b) => b.status));
  const status = statuses.size === 1 ? [...statuses][0] : (statuses.has('published') ? 'published' : [...statuses][0]);
  return {
    group_id: first.group_id,
    name: first.name,
    event_date: first.event_date,
    event_time: first.event_time,
    description: first.description,
    allow_multiple_per_parent: !!first.allow_multiple_per_parent,
    status,
    branches,
    branch_count: branches.length,
    total_items,
    taken_items,
    remaining_items: total_items - taken_items,
    created_at: first.created_at,
  };
}

/**
 * Turn display groups [{ name, qty }] into a flat slot array while PRESERVING
 * existing claims (add free slots when qty grows; drop only free slots when it
 * shrinks; never remove a claimed slot; keep claimed slots of dropped names).
 */
function reconcileSlots(existingItems, groups) {
  const byName = new Map();
  for (const it of existingItems) { if (!byName.has(it.name)) byName.set(it.name, []); byName.get(it.name).push(it); }
  const result = [];
  let sort = 0;
  const seen = new Set();
  for (const g of groups) {
    const name = String(g.name || '').trim();
    if (!name) continue;
    const qty = Math.max(1, Math.min(500, parseInt(g.qty, 10) || 1));
    seen.add(name);
    const slots = byName.get(name) || [];
    const claimed = slots.filter((s) => s.claimed_by_id);
    const free = slots.filter((s) => !s.claimed_by_id);
    const keep = Math.max(qty, claimed.length);
    const take = [...claimed, ...free.slice(0, Math.max(0, keep - claimed.length))];
    for (const s of take) { s.sort = sort++; result.push(s); }
    for (let i = take.length; i < keep; i++) result.push({ name, sort: sort++, claimed_by_id: null, parent_name: '', parent_phone: '', claimed_at: null });
  }
  for (const [name, slots] of byName) {
    if (seen.has(name)) continue;
    for (const s of slots) if (s.claimed_by_id) { s.sort = sort++; result.push(s); }
  }
  return result;
}

// Fresh (unclaimed) slots cloned from another instance's items — used when a new
// branch is added to a campaign so it starts from the same list.
function freshSlotsFrom(items) {
  return items.map((it, i) => ({ name: it.name, sort: i, claimed_by_id: null, parent_name: '', parent_phone: '', claimed_at: null }));
}

async function loadGroup(groupId) {
  return GanEvent.find({ group_id: groupId }).populate('branch_id', 'name').sort({ created_at: 1 });
}

// ============================ Manager endpoints ============================

async function listEvents(req, res, next) {
  try {
    const scope = managedBranchIds(req);
    const filter = {};
    if (scope) filter.member_branch_ids = { $in: scope };
    if (req.query.branch && req.query.branch !== 'all') filter.member_branch_ids = req.query.branch;

    const instances = await GanEvent.find(filter).populate('branch_id', 'name').sort({ created_at: -1 }).lean();

    // Group by campaign.
    const byGroup = new Map();
    for (const ev of instances) {
      if (!byGroup.has(ev.group_id)) byGroup.set(ev.group_id, []);
      byGroup.get(ev.group_id).push(ev);
    }
    const campaigns = [];
    for (const group of byGroup.values()) campaigns.push(campaignFromInstances(group));
    campaigns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ events: campaigns });
  } catch (err) { next(err); }
}

async function getGroup(req, res, next) {
  try {
    const instances = await loadGroup(req.params.groupId);
    if (!instances.length) return res.status(404).json({ error: 'אירוע לא נמצא' });
    if (!canAccess(req, instances[0].member_branch_ids)) return res.status(403).json({ error: 'אין הרשאה' });
    const c = campaignFromInstances(instances.map((i) => i.toObject()));
    res.json({ event: c });
  } catch (err) { next(err); }
}

async function createEvent(req, res, next) {
  try {
    const { name, event_date, event_time, description, items, status, branch_ids, branch_id, allow_multiple_per_parent } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'שם אירוע נדרש' });

    // Resolve target branches.
    let branches = Array.isArray(branch_ids) && branch_ids.length ? branch_ids.map(String)
      : (branch_id ? [String(branch_id)] : []);
    branches = [...new Set(branches)];
    const scope = managedBranchIds(req);
    if (!branches.length) branches = scope ? [scope[0]] : [];
    if (!branches.length) return res.status(400).json({ error: 'בחר לפחות סניף אחד' });
    if (scope && !branches.every((b) => scope.includes(b))) {
      return res.status(403).json({ error: 'אין הרשאה לאחד הסניפים שנבחרו' });
    }
    // Validate the branches exist.
    const found = await Branch.find({ _id: { $in: branches } }).select('_id').lean();
    if (found.length !== branches.length) return res.status(400).json({ error: 'סניף לא תקין' });

    const group_id = generateAccessToken();
    const meta = {
      group_id, member_branch_ids: branches, name: String(name).trim(),
      event_date: event_date || '', event_time: event_time || '', description: description || '',
      status: status === 'published' ? 'published' : 'draft',
      allow_multiple_per_parent: !!allow_multiple_per_parent,
      created_by: req.user?._id || req.user?.id || null,
    };
    // 'copy' (default): every branch gets the full list. 'split': each item's
    // quantity is divided as evenly as possible across the branches, so the SUM
    // across branches equals the original list (a shared/joint event).
    const distribution = req.body.distribution === 'split' ? 'split' : 'copy';
    const baseGroups = (Array.isArray(items) ? items : [])
      .map((g) => ({ name: String(g.name || '').trim(), qty: Math.max(1, Math.min(500, parseInt(g.qty, 10) || 1)) }))
      .filter((g) => g.name);
    const N = branches.length;
    const groupsForBranch = (idx) => {
      if (distribution === 'copy' || N === 1) return baseGroups;
      return baseGroups
        .map((g) => ({ name: g.name, qty: Math.floor(g.qty / N) + (idx < (g.qty % N) ? 1 : 0) }))
        .filter((g) => g.qty > 0);
    };
    await GanEvent.insertMany(branches.map((b, idx) => ({
      ...meta, branch_id: b, items: reconcileSlots([], groupsForBranch(idx)), access_token: generateAccessToken(),
    })));

    const instances = await loadGroup(group_id);
    res.status(201).json({ event: campaignFromInstances(instances.map((i) => i.toObject())) });
  } catch (err) { next(err); }
}

// Edit ONE branch instance. Meta fields propagate to the whole campaign; the
// item list is per-branch (only this instance changes).
async function updateEvent(req, res, next) {
  try {
    const ev = await GanEvent.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'אירוע לא נמצא' });
    if (!canAccess(req, ev.member_branch_ids)) return res.status(403).json({ error: 'אין הרשאה' });

    const { name, event_date, event_time, description, items, status, allow_multiple_per_parent } = req.body || {};
    const metaUpdate = {};
    if (name !== undefined) metaUpdate.name = String(name).trim();
    if (event_date !== undefined) metaUpdate.event_date = event_date || '';
    if (event_time !== undefined) metaUpdate.event_time = event_time || '';
    if (description !== undefined) metaUpdate.description = description || '';
    if (allow_multiple_per_parent !== undefined) metaUpdate.allow_multiple_per_parent = !!allow_multiple_per_parent;
    if (status !== undefined && ['draft', 'published', 'closed'].includes(status)) metaUpdate.status = status;
    if (Object.keys(metaUpdate).length) {
      await GanEvent.updateMany({ group_id: ev.group_id }, { $set: metaUpdate });
    }
    if (Array.isArray(items)) {
      const fresh = await GanEvent.findById(ev._id);
      fresh.items = reconcileSlots(fresh.items.map((i) => i.toObject()), items);
      await fresh.save();
    }

    const instances = await loadGroup(ev.group_id);
    res.json({ event: campaignFromInstances(instances.map((i) => i.toObject())) });
  } catch (err) { next(err); }
}

// Add a branch to an existing campaign ("send to another branch"). The new
// instance starts from a fresh copy of the source list; every instance's
// member_branch_ids is updated so the new branch's manager sees the campaign.
async function addBranch(req, res, next) {
  try {
    const { branch_id } = req.body || {};
    if (!branch_id) return res.status(400).json({ error: 'בחר סניף' });
    const instances = await loadGroup(req.params.groupId);
    if (!instances.length) return res.status(404).json({ error: 'אירוע לא נמצא' });
    if (!canAccess(req, instances[0].member_branch_ids)) return res.status(403).json({ error: 'אין הרשאה' });

    const members = instances[0].member_branch_ids.map(String);
    if (members.includes(String(branch_id))) return res.status(400).json({ error: 'הסניף כבר משתתף באירוע' });
    const branch = await Branch.findById(branch_id).select('_id').lean();
    if (!branch) return res.status(400).json({ error: 'סניף לא תקין' });

    const source = instances[0];
    const newMembers = [...members, String(branch_id)];
    await GanEvent.create({
      group_id: source.group_id, branch_id, member_branch_ids: newMembers,
      name: source.name, event_date: source.event_date, event_time: source.event_time,
      description: source.description, status: source.status,
      allow_multiple_per_parent: source.allow_multiple_per_parent,
      items: freshSlotsFrom(source.items.map((i) => i.toObject())),
      access_token: generateAccessToken(), created_by: req.user?._id || req.user?.id || null,
    });
    await GanEvent.updateMany({ group_id: source.group_id }, { $set: { member_branch_ids: newMembers } });

    const refreshed = await loadGroup(source.group_id);
    res.json({ event: campaignFromInstances(refreshed.map((i) => i.toObject())) });
  } catch (err) { next(err); }
}

// Remove one branch instance from a campaign.
async function deleteInstance(req, res, next) {
  try {
    const ev = await GanEvent.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'אירוע לא נמצא' });
    if (!canAccess(req, ev.member_branch_ids)) return res.status(403).json({ error: 'אין הרשאה' });
    const groupId = ev.group_id;
    await ev.deleteOne();
    const remaining = await GanEvent.find({ group_id: groupId });
    if (remaining.length) {
      const newMembers = remaining.map((r) => String(r.branch_id));
      await GanEvent.updateMany({ group_id: groupId }, { $set: { member_branch_ids: newMembers } });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// Delete a whole campaign (all branch instances).
async function deleteGroup(req, res, next) {
  try {
    const instances = await loadGroup(req.params.groupId);
    if (!instances.length) return res.status(404).json({ error: 'אירוע לא נמצא' });
    if (!canAccess(req, instances[0].member_branch_ids)) return res.status(403).json({ error: 'אין הרשאה' });
    await GanEvent.deleteMany({ group_id: req.params.groupId });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * Parse an uploaded .xlsx/.csv (single column of item names, one per row) into
 * display groups [{ name, qty }], collapsing repeated names into a quantity.
 */
async function importItems(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return res.status(400).json({ error: 'הגיליון ריק' });
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    const order = [];
    const counts = new Map();
    for (const row of rows) {
      const cell = (row || []).map((c) => (c == null ? '' : String(c).trim())).find((c) => c !== '');
      if (!cell) continue;
      if (!counts.has(cell)) { counts.set(cell, 0); order.push(cell); }
      counts.set(cell, counts.get(cell) + 1);
    }
    const groups = order.map((name) => ({ name, qty: counts.get(name) }));
    if (!groups.length) return res.status(400).json({ error: 'לא נמצאו פריטים בקובץ' });
    res.json({ groups });
  } catch (err) { next(err); }
}

module.exports = {
  listEvents, getGroup, createEvent, updateEvent, addBranch, deleteInstance, deleteGroup, importItems,
};
