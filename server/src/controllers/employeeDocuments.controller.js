const { EmployeeDocument, Employee, EmployeeRequest } = require('../models');
const storage = require('../services/storage.service');
const { resolveBranchScope } = require('../utils/branch-scope');

/**
 * Which shelf a document sits on in תיק העובד. Anything not on the list is
 * filed as 'other' rather than refused — a bad label must never lose a file.
 * 'form_101' keeps the meaning it always had: the tax form, filed per year.
 */
const DOC_TYPES = new Set([
  'form_101', 'employment_contract', 'recommendation', 'certificate',
  'id_document', 'bank_details', 'health', 'payslip', 'hours_report', 'other',
]);
const normalizeDocType = (t) => (DOC_TYPES.has(t) ? t : 'other');

// Same two ceilings as a scanned contract: the bucket is limited only by the
// connection, a document by MongoDB's 16MB (base64 inflates by a third).
const MAX_STORED_FILE_BYTES = 40 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES = 11 * 1024 * 1024;
const maxUploadBytes = () => (storage.isConfigured() ? MAX_STORED_FILE_BYTES : MAX_INLINE_FILE_BYTES);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const base64Bytes = (str) => {
  const body = String(str).replace(/^data:[^;]+;base64,/, '');
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
};

function oversizeMessage(bytes) {
  const max = maxUploadBytes();
  if (bytes <= max) return null;
  return storage.isConfigured()
    ? `הקובץ גדול מדי (${mb(bytes)}). המקסימום הוא ${mb(max)}.`
    : `הקובץ גדול מדי (${mb(bytes)}). המקסימום הוא ${mb(max)}, כי אחסון קבצים חיצוני אינו מוגדר בשרת והקובץ נשמר בתוך בסיס הנתונים. סרקו באיכות נמוכה יותר, או הגדירו אחסון כדי להסיר את המגבלה.`;
}

/**
 * May this request touch this employee's files?
 *
 * There was no check here at all: every route on this router admits a branch
 * manager, and every one of them was addressed by document id or employee id
 * with nothing asking which branch that person works in — so a manager who
 * guessed an id read, relabelled or deleted somebody else's staff's ת"ז scan.
 * Both directions are guarded now, because a document reaches a branch only
 * through its employee.
 */
async function employeeInScope(req, employeeId) {
  const scope = await resolveBranchScope(req);
  if (scope === null) return { ok: true };
  if (!employeeId) return { ok: false, status: 400, message: 'עובד/ת לא צוין/ה' };
  const emp = await Employee.findById(employeeId).select('branch_id').lean();
  if (!emp) return { ok: false, status: 404, message: 'עובד/ת לא נמצא/ה' };
  if (!scope.map(String).includes(String(emp.branch_id))) {
    return { ok: false, status: 403, message: 'העובד/ת אינו/ה בסניף שבאחריותך' };
  }
  return { ok: true };
}

/** The same check, starting from a document rather than an employee. */
async function docInScope(req, docId) {
  const doc = await EmployeeDocument.findById(docId).select('employee_id').lean();
  if (!doc) return { ok: false, status: 404, message: 'מסמך לא נמצא' };
  return employeeInScope(req, doc.employee_id);
}

/**
 * The filename as the person typed it, not as busboy guessed it.
 *
 * multipart field values arrive as bytes and busboy decodes them latin1 by
 * default, so "המלצה מהמנהלת.pdf" would be stored mojibake and shown that
 * way forever. Re-reading those bytes as UTF-8 restores it; guarded, because a
 * name that was already decoded correctly must not be mangled twice.
 */
function uploadedName(raw) {
  const name = String(raw || 'מסמך');
  const reread = Buffer.from(name, 'latin1').toString('utf8');
  return reread.includes('\uFFFD') ? name : reread;
}

/** Bytes for a document, from wherever they live. */
async function readBytes(doc) {
  if (doc.storage_key) {
    const signed = await storage.signedReadUrl(doc.storage_key);
    const upstream = await fetch(signed);
    if (!upstream.ok) throw new Error(`שליפת הקובץ מהאחסון נכשלה (${upstream.status})`);
    return Buffer.from(await upstream.arrayBuffer());
  }
  if (doc.file_data) return Buffer.from(doc.file_data, 'base64');
  return null;
}

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
    const scope = await employeeInScope(req, employee_id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });

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
      doc_type: d.doc_type || 'other',
      tax_year: d.tax_year || null,
      self_uploaded: !!d.self_uploaded,
      from_mail: d.source === 'mail',
    }));

    // Merge in medical certificates from the employee's sick/vacation requests.
    const emp = await Employee.findById(employee_id).select('user_id').lean();
    const ownerMatch = emp?.user_id
      ? { $or: [{ employee_id }, { user_id: emp.user_id }] }
      : { employee_id };
    const reqFilter = { ...ownerMatch, medical_file_data: { $ne: null } };
    if (month) reqFilter.from_date = { $regex: `^${month}` };
    const reqs = await EmployeeRequest.find(reqFilter)
      .select('type from_date to_date reason medical_file_name status created_at cert_acknowledged')
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
      acknowledged: !!r.cert_acknowledged,
    }));

    const documents = [...uploaded, ...certs].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    res.json({ documents });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-documents
 *
 * Two ways in: a multipart `file` field (what תיק העובד sends, because base64
 * inside JSON costs a third in transfer and is most of why the ceiling was
 * 11MB), or the legacy `file_data` base64 string every existing caller uses.
 *
 * Body: { employee_id, name, description?, doc_type?, tax_year?, month?,
 *         file_data?(base64), file_name?, file_mimetype? }
 */
async function create(req, res, next) {
  try {
    const { employee_id, name, description, file_data, file_name, file_mimetype, month, doc_type, tax_year } = req.body;
    const part = req.file;
    if (!employee_id || !name || (!part && !file_data)) {
      return res.status(400).json({ error: 'עובד, שם ומסמך נדרשים' });
    }
    const scope = await employeeInScope(req, employee_id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });
    const emp = await Employee.findById(employee_id).select('branch_id').lean();
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const buffer = part
      ? part.buffer
      : Buffer.from(String(file_data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    const oversize = oversizeMessage(part ? buffer.length : base64Bytes(file_data));
    if (oversize) return res.status(413).json({ error: oversize });

    const resolvedName = part ? uploadedName(part.originalname) : (file_name || '');
    const mimetype = part ? part.mimetype : (file_mimetype || 'application/octet-stream');
    const type = normalizeDocType(doc_type);

    const payload = {
      employee_id,
      branch_id: emp.branch_id || null,
      month: month || null,
      name: String(name).trim(),
      description: description || '',
      file_name: resolvedName,
      file_mimetype: mimetype,
      size_bytes: buffer.length,
      file_data: null,
      storage_key: null,
      created_by: req.user?.id || null,
      doc_type: type,
      // טופס 101 is filed per TAX YEAR and refiled every January, so "has one"
      // is always "has one for this year". Meaningless on every other shelf.
      tax_year: type === 'form_101' ? (Number(tax_year) || new Date().getFullYear()) : null,
    };

    if (storage.isConfigured()) {
      const ext = (resolvedName.split('.').pop() || 'pdf').toLowerCase();
      const key = storage.makeKey(`employee-docs/${emp.branch_id || 'misc'}`, ext);
      try {
        await storage.putObject({ key, body: buffer, contentType: mimetype });
        payload.storage_key = key;
      } catch (err) {
        // Falling back to the document would silently reinstate the 16MB
        // ceiling for a file that may be well past it. Say what broke.
        console.error('[employee-doc] storage put failed:', err.message);
        return res.status(502).json({
          error: `העלאת הקובץ לאחסון נכשלה: ${err.message}. בדקו את הגדרות האחסון.`,
        });
      }
    } else {
      payload.file_data = buffer.toString('base64');
    }

    const doc = await EmployeeDocument.create(payload);
    res.status(201).json({ id: String(doc._id) });
  } catch (err) { next(err); }
}

/**
 * GET /api/employee-documents/:id/file — the base64 payload, for the callers
 * that have always read it that way (the salary table's notes column, the
 * employee portal). A document that lives in the bucket is fetched and encoded
 * here rather than breaking them.
 */
async function getFile(req, res, next) {
  try {
    const scope = await docInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });
    const d = await EmployeeDocument.findById(req.params.id)
      .select('file_data storage_key file_name file_mimetype name').lean();
    if (!d) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const buf = await readBytes(d);
    if (!buf) return res.status(404).json({ error: 'אין קובץ' });
    res.json({
      data: buf.toString('base64'),
      name: d.file_name || d.name || 'מסמך',
      mimetype: d.file_mimetype || '',
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/employee-documents/:id/download — the file itself.
 *
 * Streamed back through the server rather than answered with a redirect to the
 * bucket: the screen fetches this as a blob with the bearer token, and a
 * cross-origin hop would need CORS on the bucket to work at all.
 */
async function download(req, res, next) {
  try {
    const scope = await docInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });
    const d = await EmployeeDocument.findById(req.params.id)
      .select('file_data storage_key file_name file_mimetype name').lean();
    if (!d) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const buf = await readBytes(d);
    if (!buf) return res.status(404).json({ error: 'אין קובץ' });
    const filename = d.file_name || `${d.name || 'מסמך'}`;
    res.setHeader('Content-Type', d.file_mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buf);
  } catch (err) { next(err); }
}

/**
 * PUT /api/employee-documents/:id — edit label / description (and optionally replace file).
 */
async function update(req, res, next) {
  try {
    const scope = await docInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });
    const doc = await EmployeeDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
    const { name, description, file_data, file_name, file_mimetype, doc_type, tax_year } = req.body;
    if (name !== undefined) doc.name = String(name).trim();
    if (description !== undefined) doc.description = description || '';
    if (doc_type !== undefined) {
      doc.doc_type = normalizeDocType(doc_type);
      doc.tax_year = doc.doc_type === 'form_101'
        ? (Number(tax_year) || doc.tax_year || new Date().getFullYear())
        : null;
    }
    if (file_data) {
      const oversize = oversizeMessage(base64Bytes(file_data));
      if (oversize) return res.status(413).json({ error: oversize });
      const buffer = Buffer.from(String(file_data).replace(/^data:[^;]+;base64,/, ''), 'base64');
      // A replaced file leaves the old bytes behind in the bucket; removing
      // them is deliberate here, because the document row is the only thing
      // that knows the key and it is about to stop pointing at it.
      const staleKey = doc.storage_key;
      if (storage.isConfigured()) {
        const ext = ((file_name || doc.file_name || 'pdf').split('.').pop() || 'pdf').toLowerCase();
        const key = storage.makeKey(`employee-docs/${doc.branch_id || 'misc'}`, ext);
        await storage.putObject({ key, body: buffer, contentType: file_mimetype || doc.file_mimetype });
        doc.storage_key = key;
        doc.file_data = null;
      } else {
        doc.file_data = buffer.toString('base64');
        doc.storage_key = null;
      }
      doc.size_bytes = buffer.length;
      doc.file_name = file_name || doc.file_name;
      doc.file_mimetype = file_mimetype || doc.file_mimetype;
      if (staleKey && staleKey !== doc.storage_key) {
        storage.deleteObject(staleKey).catch(e => console.error('[employee-doc] stale delete:', e.message));
      }
    }
    await doc.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/employee-documents/:id */
async function remove(req, res, next) {
  try {
    const scope = await docInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.message });
    const doc = await EmployeeDocument.findByIdAndDelete(req.params.id);
    if (doc?.storage_key) {
      storage.deleteObject(doc.storage_key)
        .catch(e => console.error('[employee-doc] delete from storage:', e.message));
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/employee-documents/:id/acknowledge  { acknowledged?: bool, source?: 'document'|'request' }
 * Mark an attached file as seen by the accountant (default true) so it stops
 * showing as "ממתין בקבצים" in the salary table. Pass acknowledged:false to
 * re-flag it as pending. `source:'request'` targets a sick/vacation certificate
 * (the id is then the EmployeeRequest's) rather than an uploaded document.
 */
async function acknowledge(req, res, next) {
  try {
    const ack = req.body?.acknowledged !== false;

    if (req.body?.source === 'request') {
      const owner = await EmployeeRequest.findById(req.params.id).select('employee_id').lean();
      const reqScope = await employeeInScope(req, owner?.employee_id);
      if (!reqScope.ok) return res.status(reqScope.status).json({ error: reqScope.message });
      const r = await EmployeeRequest.findByIdAndUpdate(
        req.params.id,
        ack
          ? { cert_acknowledged: true, cert_acknowledged_by: req.user?.id || null, cert_acknowledged_at: new Date() }
          : { cert_acknowledged: false, cert_acknowledged_by: null, cert_acknowledged_at: null },
        { new: true },
      ).lean();
      if (!r) return res.status(404).json({ error: 'אישור לא נמצא' });
      return res.json({ ok: true, acknowledged: !!r.cert_acknowledged });
    }

    const docScope = await docInScope(req, req.params.id);
    if (!docScope.ok) return res.status(docScope.status).json({ error: docScope.message });
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

module.exports = {
  list, create, getFile, download, update, remove, acknowledge,
  MAX_STORED_FILE_BYTES,
};
