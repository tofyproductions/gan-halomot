const { MaintenanceItem } = require('../models');

// GET /maintenance?branch_id=&category=
async function list(req, res, next) {
  try {
    const filter = { is_active: true };
    if (req.query.branch_id && req.query.branch_id !== 'all') filter.branch_id = req.query.branch_id;
    if (req.query.category) filter.category = req.query.category;
    const items = await MaintenanceItem.find(filter).sort({ category: 1, name: 1 }).lean();
    // Strip fault photo blobs from the list (fetched on demand); keep a flag.
    const out = items.map(it => ({
      ...it,
      faults: (it.faults || []).map(f => ({ ...f, has_photo: !!f.photo_data, photo_data: undefined })),
      open_faults: (it.faults || []).filter(f => f.status === 'open').length,
    }));
    res.json({ items: out });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.branch_id || !b.category || !b.name) {
      return res.status(400).json({ error: 'סניף, קטגוריה ושם נדרשים' });
    }
    const item = await MaintenanceItem.create({
      branch_id: b.branch_id,
      category: b.category,
      name: String(b.name).trim(),
      model: b.model || '',
      location: b.location || '',
      quantity: Number(b.quantity) || 1,
      last_service_at: b.last_service_at || null,
      service_cycle_days: b.service_cycle_days ? Number(b.service_cycle_days) : null,
      specs: b.specs || {},
      notes: b.notes || '',
    });
    res.status(201).json({ item });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const fields = ['category', 'name', 'model', 'location', 'quantity', 'last_service_at',
      'service_cycle_days', 'specs', 'notes', 'is_active'];
    const update = {};
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    const item = await MaintenanceItem.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    res.json({ item });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    await MaintenanceItem.findByIdAndUpdate(req.params.id, { is_active: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// POST /maintenance/:id/faults  { description, photo_data?, photo_name? }
async function addFault(req, res, next) {
  try {
    const item = await MaintenanceItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    const { description, photo_data, photo_name } = req.body || {};
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'תיאור התקלה נדרש' });
    item.faults.push({
      description: String(description).trim(),
      photo_data: photo_data || null,
      photo_name: photo_name || '',
      status: 'open',
      created_by: req.user?.id || null,
    });
    await item.save();
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
}

// PUT /maintenance/:id/faults/:faultId  { status: 'resolved'|'open' }
async function updateFault(req, res, next) {
  try {
    const item = await MaintenanceItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    const fault = item.faults.id(req.params.faultId);
    if (!fault) return res.status(404).json({ error: 'תקלה לא נמצאה' });
    if (req.body.status === 'resolved') {
      fault.status = 'resolved';
      fault.resolved_at = new Date();
      fault.resolved_by = req.user?.id || null;
    } else if (req.body.status === 'open') {
      fault.status = 'open';
      fault.resolved_at = null;
      fault.resolved_by = null;
    }
    await item.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// GET /maintenance/:id/faults/:faultId/photo
async function faultPhoto(req, res, next) {
  try {
    const item = await MaintenanceItem.findById(req.params.id).select('faults').lean();
    const fault = (item?.faults || []).find(f => String(f._id) === String(req.params.faultId));
    if (!fault || !fault.photo_data) return res.status(404).json({ error: 'אין תמונה' });
    res.json({ data: fault.photo_data, name: fault.photo_name || 'תמונה' });
  } catch (err) { next(err); }
}

// DELETE /maintenance/:id/faults/:faultId
async function removeFault(req, res, next) {
  try {
    const item = await MaintenanceItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    const fault = item.faults.id(req.params.faultId);
    if (fault) { fault.deleteOne(); await item.save(); }
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, addFault, updateFault, faultPhoto, removeFault };
