const { Lead, Branch, User } = require('../models');
const { dispatchEmail } = require('../services/email.service');

const STATUSES = ['new', 'contacted', 'tour_scheduled', 'converted', 'closed'];

// Branch scope a manager may see (system_admin/accountant → all).
function managedBranchIds(req) {
  const role = req.user?.role;
  if (role === 'system_admin' || role === 'accountant') return null;
  const managed = (req.user?.managed_branch_ids || []).map(String);
  const fallback = req.user?.branch_id ? [String(req.user.branch_id)] : [];
  return managed.length ? managed : fallback;
}

// ── Manager side ──────────────────────────────────────────────────────────
// GET /api/leads?status=&branch=
async function list(req, res, next) {
  try {
    const filter = {};
    if (req.query.status && STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const scope = managedBranchIds(req);
    if (scope) {
      // Managers see their branches' leads AND unassigned ones (branch_id null),
      // so "not sure yet" inquiries aren't lost.
      filter.$or = [{ branch_id: { $in: scope } }, { branch_id: null }];
    } else if (req.query.branch && req.query.branch !== 'all') {
      filter.branch_id = req.query.branch;
    }
    const leads = await Lead.find(filter)
      .populate('branch_id', 'name')
      .sort({ created_at: -1 })
      .lean();
    res.json({
      leads: leads.map(l => ({ ...l, id: String(l._id), branch_name: l.branch_id?.name || '' })),
    });
  } catch (err) { next(err); }
}

// GET /api/leads/counts — new-lead badge for the nav/page.
async function counts(req, res, next) {
  try {
    const filter = { status: 'new' };
    const scope = managedBranchIds(req);
    if (scope) filter.$or = [{ branch_id: { $in: scope } }, { branch_id: null }];
    const count = await Lead.countDocuments(filter);
    res.json({ new: count });
  } catch (err) { next(err); }
}

// PUT /api/leads/:id — edit details / status / manager note.
async function update(req, res, next) {
  try {
    const fields = ['parent_name', 'parent_phone', 'parent_email', 'child_name',
      'child_birth_date', 'message', 'manager_note', 'branch_id'];
    const setObj = {};
    for (const f of fields) if (req.body[f] !== undefined) setObj[f] = req.body[f] || (f === 'branch_id' ? null : '');
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'סטטוס לא תקין' });
      setObj.status = req.body.status;
      setObj.handled_by = req.user?.id || null;
    }
    const lead = await Lead.findByIdAndUpdate(req.params.id, setObj, { new: true })
      .populate('branch_id', 'name').lean();
    if (!lead) return res.status(404).json({ error: 'פנייה לא נמצאה' });
    res.json({ lead: { ...lead, id: String(lead._id), branch_name: lead.branch_id?.name || '' } });
  } catch (err) { next(err); }
}

// DELETE /api/leads/:id
async function remove(req, res, next) {
  try {
    await Lead.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// ── Public side (no auth) ─────────────────────────────────────────────────
// GET /api/public/lead-branches — active branch list for the general form.
async function publicBranches(req, res, next) {
  try {
    const branches = await Branch.find({ is_active: { $ne: false } }).select('name').sort({ name: 1 }).lean();
    res.json({ branches: branches.map(b => ({ id: String(b._id), name: b.name })) });
  } catch (err) { next(err); }
}

// POST /api/public/lead  { parent_name, parent_phone, parent_email?, child_name?,
//                          child_birth_date?, message?, branch_id?, source? }
async function publicSubmit(req, res, next) {
  try {
    const b = req.body || {};
    const parent_name = String(b.parent_name || '').trim();
    const parent_phone = String(b.parent_phone || '').replace(/[^\d+]/g, '').trim();
    if (!parent_name || !parent_phone) {
      return res.status(400).json({ error: 'שם וטלפון נדרשים' });
    }
    if (parent_phone.replace(/\D/g, '').length < 9) {
      return res.status(400).json({ error: 'מספר טלפון לא תקין' });
    }
    // Only accept a branch_id that is a real, active branch.
    let branch_id = null;
    let branch = null;
    if (b.branch_id) {
      branch = await Branch.findById(b.branch_id).select('name').lean().catch(() => null);
      if (branch) branch_id = branch._id;
    }
    const lead = await Lead.create({
      branch_id,
      parent_name,
      parent_phone,
      parent_email: String(b.parent_email || '').trim(),
      child_name: String(b.child_name || '').trim(),
      child_birth_date: String(b.child_birth_date || '').trim(),
      message: String(b.message || '').trim(),
      source: String(b.source || '').trim().slice(0, 120),
      status: 'new',
    });

    // Notify the branch manager (best-effort — never fail the parent's submit).
    notifyNewLead(lead, branch).catch(err => console.error('lead notify failed:', err.message));

    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
}

async function notifyNewLead(lead, branch) {
  let recipients = [];
  if (lead.branch_id) {
    const managers = await User.find({
      role: 'branch_manager',
      $or: [{ managed_branch_ids: lead.branch_id }, { branch_id: lead.branch_id }],
    }).select('email').lean();
    recipients = managers.map(m => m.email).filter(Boolean);
  }
  // No branch (or no manager on it) → fall back to system admins.
  if (recipients.length === 0) {
    const admins = await User.find({ role: 'system_admin' }).select('email').lean();
    recipients = admins.map(a => a.email).filter(Boolean);
  }
  if (recipients.length === 0) return;
  const branchName = branch?.name || 'לא נבחר סניף';
  await dispatchEmail({
    to: [...new Set(recipients)],
    subject: `פנייה חדשה מהורה — ${lead.parent_name}`,
    html: `<div dir="rtl" style="font-family:Arial">
      <h2>פנייה חדשה מהורה 🎈</h2>
      <p><b>סניף:</b> ${branchName}</p>
      <p><b>שם:</b> ${lead.parent_name}</p>
      <p><b>טלפון:</b> ${lead.parent_phone}</p>
      ${lead.parent_email ? `<p><b>אימייל:</b> ${lead.parent_email}</p>` : ''}
      ${lead.child_name ? `<p><b>שם הילד/ה:</b> ${lead.child_name}</p>` : ''}
      ${lead.child_birth_date ? `<p><b>תאריך לידה:</b> ${lead.child_birth_date}</p>` : ''}
      ${lead.message ? `<p><b>הודעה:</b> ${lead.message}</p>` : ''}
      <p style="color:#888">ניתן לצפות ולטפל בפנייה בעמוד "פניות הורים" במערכת.</p>
    </div>`,
    text: `פנייה חדשה: ${lead.parent_name}, ${lead.parent_phone}, סניף: ${branchName}`,
  });
}

module.exports = { list, counts, update, remove, publicBranches, publicSubmit };
