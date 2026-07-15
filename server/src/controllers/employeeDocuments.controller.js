const { EmployeeDocument, Employee, EmployeeRequest } = require('../models');

/**
 * GET /api/employee-documents?employee_id=X[&month=YYYY-MM]
 * Lists an employee's attached documents (metadata only — no base64 payload).
 * Unified view: uploaded EmployeeDocuments PLUS any medical certificate attached
 * to the employee's sick/vacation requests, so every file is accessible in one
 * place (source distinguishes them; cert files are viewed via employee-requests).
 */
async function list(req, res, next) {
  try {
    const { employee_id, month } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

    const filter = { employee_id };
    if (month) filter.month = month;
    const docs = await EmployeeDocument.find(filter)
      .populate('created_by', 'full_name')
      .sort({ created_at: -1 })
      .lean();

    const uploaded = docs.map(d => ({
      id: String(d._id),
      source: 'document',
      name: d.name,
      description: d.description || '',
      file_name: d.file_name || '',
      file_mimetype: d.file_mimetype || '',
      month: d.month || null,
      created_at: d.created_at,
      created_by_name: d.created_by?.full_name || '',
      acknowledged: !!d.acknowledged,
    }));

    // Merge in medical certificates from the employee's sick/vacation requests.
    const emp = await Employee.findById(employee_id).select('user_id').lean();
    const ownerMatch = emp?.user_id
      ? { $or: [{ employee_id }, { user_id: emp.user_id }] }
      : { employee_id };
    const reqFilter = { ...ownerMatch, medical_file_data: { $ne: null } };
    if (month) reqFilter.from_date = { $regex: `^${month}` };
    const reqs = await EmployeeRequest.find(reqFilter)
      .select('type from_date to_date reason medical_file_name status created_at')
      .sort({ from_date: -1 })
      .lean();
    const TYPE_HE = { sick: 'אישור מחלה', vacation: 'אישור חופשה' };
    const certs = reqs.map(r => ({
      id: String(r._id),
      source: 'request', // viewed via /employee-requests/:id/medical-file
      name: `${TYPE_HE[r.type] || 'אישור'} ${r.from_date}${r.to_date && r.to_date !== r.from_date ? `–${r.to_date}` : ''}`,
      description: r.reason || '',
      file_name: r.medical_file_name || '',
      file_mimetype: '',
      month: (r.from_date || '').slice(0, 7) || null,
      created_at: r.created_at,
      created_by_name: '',
      request_type: r.type,
      status: r.status,
    }));

    const documents = [...uploaded, ...certs].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    res.json({ documents });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-documents
 * Body: { employee_id, name, description?, file_data(base64), file_name?, file_mimetype?, month? }
 */
async function create(req, res, next) {
  try {
    const { employee_id, name, description, file_data, file_name, file_mimetype, month } = req.body;
    if (!employee_id || !name || !file_data) {
      return res.status(400).json({ error: 'עובד, שם ומסמך נדרשים' });
    }
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const doc = await EmployeeDocument.create({
      employee_id,
      branch_id: emp.branch_id || null,
      month: month || null,
      name: String(name).trim(),
      description: description || '',
      file_data,
      file_name: file_name || '',
      file_mimetype: file_mimetype || 'application/octet-stream',
      created_by: req.user?.id || null,
    });
    res.status(201).json({ id: String(doc._id) });
  } catch (err) { next(err); }
}

/**
 * GET /api/employee-documents/:id/file — returns the base64 payload for preview.
 */
async function getFile(req, res, next) {
  try {
    const d = await EmployeeDocument.findById(req.params.id)
      .select('file_data file_name file_mimetype').lean();
    if (!d || !d.file_data) return res.status(404).json({ error: 'אין קובץ' });
    res.json({ data: d.file_data, name: d.file_name || d.name || 'מסמך', mimetype: d.file_mimetype || '' });
  } catch (err) { next(err); }
}

/**
 * PUT /api/employee-documents/:id — edit label / description (and optionally replace file).
 */
async function update(req, res, next) {
  try {
    const doc = await EmployeeDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const { name, description, file_data, file_name, file_mimetype } = req.body;
    if (name !== undefined) doc.name = String(name).trim();
    if (description !== undefined) doc.description = description || '';
    if (file_data) {
      doc.file_data = file_data;
      doc.file_name = file_name || doc.file_name;
      doc.file_mimetype = file_mimetype || doc.file_mimetype;
    }
    await doc.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/employee-documents/:id */
async function remove(req, res, next) {
  try {
    await EmployeeDocument.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-documents/:id/acknowledge  { acknowledged?: bool }
 * Mark an uploaded document as seen by the accountant (default true) so it
 * stops showing as "ממתין בקבצים" in the salary table. Pass acknowledged:false
 * to re-flag it as pending.
 */
async function acknowledge(req, res, next) {
  try {
    const ack = req.body?.acknowledged !== false;
    const doc = await EmployeeDocument.findByIdAndUpdate(
      req.params.id,
      ack
        ? { acknowledged: true, acknowledged_by: req.user?.id || null, acknowledged_at: new Date() }
        : { acknowledged: false, acknowledged_by: null, acknowledged_at: null },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
    res.json({ ok: true, acknowledged: !!doc.acknowledged });
  } catch (err) { next(err); }
}

module.exports = { list, create, getFile, update, remove, acknowledge };
