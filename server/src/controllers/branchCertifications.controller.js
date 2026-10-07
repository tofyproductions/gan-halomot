const { BranchCertification, Branch, Setting } = require('../models');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');
const { CERT_TYPES, WARN_DAYS, statusOf, daysLeft } = require('../services/compliance');
const driveCerts = require('../services/driveCerts.service');

/**
 * אישורי מעון — every paper a branch operates under, with the dates that
 * decide when somebody has to move.
 *
 * Scoped from the caller's record like recruitment, not from ?branch=: a
 * branch manager sees the certificates of the gans she holds, the office sees
 * all of them.
 */

const RECIPIENTS_KEY = 'compliance_alert_emails';

function shape(c, branchNames) {
  return {
    id: String(c._id),
    branch_id: String(c.branch_id),
    branch_name: branchNames.get(String(c.branch_id)) || '',
    cert_type: c.cert_type,
    type_label: c.cert_type === 'other'
      ? (c.label || CERT_TYPES.other)
      : CERT_TYPES[c.cert_type] || c.cert_type,
    label: c.label || '',
    issued_at: c.issued_at,
    expires_at: c.expires_at,
    status: statusOf(c.expires_at),
    days_left: daysLeft(c.expires_at),
    has_file: !!c.file_data,
    file_name: c.file_name || '',
    external_url: c.external_url || '',
    notes: c.notes || '',
    is_archived: !!c.is_archived,
    created_at: c.created_at,
  };
}

/**
 * GET /api/branch-certifications?include_archived=1
 * Everything in scope, grouped client-side. Metadata only — no base64.
 */
async function list(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const filter = {};
    if (scope !== null) filter.branch_id = { $in: scope };
    if (req.query.include_archived !== '1') filter.is_archived = false;

    const [rows, branches] = await Promise.all([
      BranchCertification.find(filter).select('-file_data').sort({ expires_at: 1 }).lean(),
      Branch.find(scope === null ? { is_active: true } : { _id: { $in: scope } })
        .select('name').sort({ name: 1 }).lean(),
    ]);
    const branchNames = new Map(branches.map(b => [String(b._id), b.name]));

    const shaped = rows.map(c => shape(c, branchNames));
    res.json({
      certifications: shaped,
      branches: branches.map(b => ({ id: String(b._id), name: b.name })),
      cert_types: CERT_TYPES,
      warn_days: WARN_DAYS,
      summary: {
        expired: shaped.filter(c => !c.is_archived && c.status === 'expired').length,
        expiring: shaped.filter(c => !c.is_archived && c.status === 'expiring').length,
        no_expiry: shaped.filter(c => !c.is_archived && c.status === 'no_expiry').length,
      },
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/branch-certifications
 * Body: { branch_id, cert_type, label?, issued_at?, expires_at?,
 *         file_data?, file_name?, file_mimetype?, external_url?, notes? }
 */
async function create(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.branch_id) return res.status(400).json({ error: 'יש לבחור סניף' });
    if (!CERT_TYPES[b.cert_type]) return res.status(400).json({ error: 'סוג אישור לא מוכר' });
    if (b.cert_type === 'other' && !String(b.label || '').trim()) {
      return res.status(400).json({ error: 'לאישור מסוג "אחר" יש לתת שם' });
    }
    if (!(await canAccessBranch(req, b.branch_id))) {
      return res.status(403).json({ error: 'אין לך הרשאה לסניף הזה' });
    }

    const doc = await BranchCertification.create({
      branch_id: b.branch_id,
      cert_type: b.cert_type,
      label: String(b.label || '').trim(),
      issued_at: b.issued_at ? new Date(b.issued_at) : null,
      expires_at: b.expires_at ? new Date(b.expires_at) : null,
      file_data: b.file_data || null,
      file_name: b.file_name || '',
      file_mimetype: b.file_mimetype || 'application/octet-stream',
      external_url: String(b.external_url || '').trim(),
      notes: b.notes || '',
      created_by: req.user?.id || null,
    });
    res.status(201).json({ id: String(doc._id) });
  } catch (err) { next(err); }
}

/** The row, if this caller may act on its branch. */
async function loadScoped(req, id) {
  const doc = await BranchCertification.findById(id);
  if (!doc) return { error: 'אישור לא נמצא', status: 404 };
  if (!(await canAccessBranch(req, doc.branch_id))) {
    return { error: 'אין לך הרשאה לסניף הזה', status: 403 };
  }
  return { doc };
}

/** PUT /api/branch-certifications/:id — dates, label, notes, link, or a replacement file. */
async function update(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const b = req.body || {};

    if (b.cert_type !== undefined) {
      if (!CERT_TYPES[b.cert_type]) return res.status(400).json({ error: 'סוג אישור לא מוכר' });
      doc.cert_type = b.cert_type;
    }
    if (b.label !== undefined) doc.label = String(b.label || '').trim();
    if (b.issued_at !== undefined) doc.issued_at = b.issued_at ? new Date(b.issued_at) : null;
    if (b.expires_at !== undefined) doc.expires_at = b.expires_at ? new Date(b.expires_at) : null;
    if (b.external_url !== undefined) doc.external_url = String(b.external_url || '').trim();
    if (b.notes !== undefined) doc.notes = b.notes;
    if (b.file_data) {
      doc.file_data = b.file_data;
      doc.file_name = b.file_name || '';
      doc.file_mimetype = b.file_mimetype || 'application/octet-stream';
    }
    await doc.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/branch-certifications/:id/renew
 * The new certificate arrives: the old row is archived (and kept — the
 * inspector asks for history), a fresh row takes its place.
 */
async function renew(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const b = req.body || {};

    const fresh = await BranchCertification.create({
      branch_id: doc.branch_id,
      cert_type: doc.cert_type,
      label: doc.label,
      issued_at: b.issued_at ? new Date(b.issued_at) : null,
      expires_at: b.expires_at ? new Date(b.expires_at) : null,
      file_data: b.file_data || null,
      file_name: b.file_name || '',
      file_mimetype: b.file_mimetype || 'application/octet-stream',
      external_url: String(b.external_url || '').trim(),
      notes: b.notes || '',
      created_by: req.user?.id || null,
    });
    doc.is_archived = true;
    doc.replaced_by = fresh._id;
    await doc.save();
    res.status(201).json({ id: String(fresh._id) });
  } catch (err) { next(err); }
}

/** DELETE /api/branch-certifications/:id — for rows entered by mistake. */
async function remove(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** GET /api/branch-certifications/:id/file — the base64 payload for viewing. */
async function getFile(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    if (!doc.file_data) return res.status(404).json({ error: 'אין קובץ — אולי יש קישור חיצוני' });
    res.json({
      data: doc.file_data,
      name: doc.file_name || `${CERT_TYPES[doc.cert_type] || 'אישור'}.pdf`,
      mimetype: doc.file_mimetype || '',
    });
  } catch (err) { next(err); }
}

/**
 * GET/PUT /api/branch-certifications/alert-recipients
 * Who the daily digest writes to, beyond the admins it always includes.
 * This is where עינת's address lives.
 */
// ============================ ייבוא מהדרייב ============================
/**
 * The folders to scan, remembered between visits.
 *
 * In a Setting rather than in the environment because the office adds a folder
 * for a new year and must not need a deploy to do it.
 */
const DRIVE_FOLDERS_KEY = 'drive_cert_folders';

/** Accepts a Drive URL or a bare id — nobody should have to extract the id. */
function folderIdOf(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{10,})$/);
  return m ? m[1] : null;
}

async function getDriveFolders(req, res, next) {
  try {
    const row = await Setting.findOne({ key: DRIVE_FOLDERS_KEY }).lean();
    res.json({
      folders: Array.isArray(row?.value) ? row.value : [],
      configured: driveCerts.isConfigured(),
      service_account: driveCerts.serviceAccountEmail(),
    });
  } catch (err) { next(err); }
}

async function setDriveFolders(req, res, next) {
  try {
    const list = Array.isArray(req.body?.folders) ? req.body.folders : [];
    const folders = list
      .map(f => ({ id: folderIdOf(f.id || f.url || f), label: String(f.label || '').trim() }))
      .filter(f => f.id);
    await Setting.findOneAndUpdate(
      { key: DRIVE_FOLDERS_KEY }, { key: DRIVE_FOLDERS_KEY, value: folders },
      { upsert: true },
    );
    res.json({ folders });
  } catch (err) { next(err); }
}

/**
 * GET /branch-certifications/drive/scan
 *
 * Reads the folders and answers with PROPOSALS. Writes nothing. Every row
 * carries how sure it is and, where the branch cannot be derived, says so — a
 * certificate filed under the wrong branch is a branch that looks covered and
 * is not, which is the one mistake worth a screen to prevent.
 */
async function scanDrive(req, res, next) {
  try {
    if (!driveCerts.isConfigured()) {
      return res.status(503).json({
        error: 'גישת גוגל אינה מוגדרת במערכת.',
        code: 'DRIVE_NOT_CONFIGURED',
      });
    }
    const row = await Setting.findOne({ key: DRIVE_FOLDERS_KEY }).lean();
    const stored = Array.isArray(row?.value) ? row.value.map(f => f.id) : [];
    const asked = String(req.query.folders || '').split(',').map(folderIdOf).filter(Boolean);
    const ids = asked.length ? asked : stored;
    if (ids.length === 0) {
      return res.status(400).json({ error: 'לא הוגדרו תיקיות לסריקה', code: 'NO_FOLDERS' });
    }

    const proposals = await driveCerts.scan(ids);

    // Match the branch words to real branches, inside the caller's scope.
    const scope = await resolveBranchScope(req);
    const branches = await Branch.find(scope === null ? {} : { _id: { $in: scope } })
      .select('name').lean();
    const byWord = (word) => branches.find(b => String(b.name).includes(word)) || null;

    // What is already linked, so a second scan does not offer the same file
    // again. Keyed on the url, which is the only thing about a Drive file that
    // does not change when somebody renames it.
    const existing = await BranchCertification.find({ external_url: { $ne: '' } })
      .select('external_url').lean();
    const linked = new Set(existing.map(e => e.external_url));

    res.json({
      folders: ids,
      proposals: proposals.map(p => {
        const branch = p.branch_word ? byWord(p.branch_word) : null;
        return {
          ...p,
          branch_id: branch ? String(branch._id) : null,
          branch_name: branch ? branch.name : '',
          // Two branches wear the name כפר סבא; the folder cannot say which.
          needs_branch: p.needs_branch || !branch,
          already_imported: linked.has(p.url),
        };
      }),
    });
  } catch (err) { next(err); }
}

/**
 * POST /branch-certifications/drive/import
 *
 * Takes the rows a person approved — each with its branch settled — and links
 * them. The file stays in Drive: `external_url` is what the model has for the
 * back-catalogue, and re-uploading history nobody opens again is busywork.
 *
 * Refuses rather than guesses: no branch, no type, or a branch outside the
 * caller's scope is reported back by file name instead of being skipped in
 * silence.
 */
async function importFromDrive(req, res, next) {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'לא נשלחו שורות לייבוא' });

    const created = [];
    const refused = [];
    for (const it of items) {
      const name = it.file_name || it.url || '—';
      if (it.kind === 'course') {
        refused.push({ name, reason: 'תעודה של עובדת — מיובאת במסך הקורסים, לא כאן' });
        continue;
      }
      if (!it.type || !CERT_TYPES[it.type]) { refused.push({ name, reason: 'סוג אישור חסר' }); continue; }
      if (!it.branch_id) { refused.push({ name, reason: 'לא נבחר סניף' }); continue; }
      if (!await canAccessBranch(req, it.branch_id)) {
        refused.push({ name, reason: 'אין הרשאה לסניף הזה' });
        continue;
      }
      if (!it.url) { refused.push({ name, reason: 'אין קישור לקובץ' }); continue; }

      // Already linked — a second import of the same file would give the branch
      // two rows for one certificate and two expiry dates to disagree about.
      const dup = await BranchCertification.findOne({
        branch_id: it.branch_id, external_url: it.url, is_archived: false,
      }).lean();
      if (dup) { refused.push({ name, reason: 'כבר מקושר' }); continue; }

      const doc = await BranchCertification.create({
        branch_id: it.branch_id,
        cert_type: it.type,
        label: it.label || '',
        issued_at: it.issued_at ? new Date(it.issued_at) : null,
        expires_at: it.expires_at ? new Date(it.expires_at) : null,
        external_url: it.url,
        file_name: it.file_name || '',
        notes: it.notes || `יובא מהדרייב${it.folder_path ? ` · ${it.folder_path}` : ''}`,
        created_by: req.user?.id || null,
      });
      created.push(String(doc._id));
    }

    res.status(created.length ? 201 : 400).json({ created: created.length, refused });
  } catch (err) { next(err); }
}

async function getRecipients(req, res, next) {
  try {
    const s = await Setting.findOne({ key: RECIPIENTS_KEY }).lean();
    res.json({ emails: Array.isArray(s?.value) ? s.value : [] });
  } catch (err) { next(err); }
}

async function setRecipients(req, res, next) {
  try {
    const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : [])
      .map(e => String(e || '').trim().toLowerCase())
      .filter(e => e.includes('@')))];
    await Setting.findOneAndUpdate(
      { key: RECIPIENTS_KEY }, { $set: { value: emails } }, { upsert: true },
    );
    res.json({ ok: true, emails });
  } catch (err) { next(err); }
}

module.exports = {
  list, create, update, renew, remove, getFile, getRecipients, setRecipients,
  RECIPIENTS_KEY,
  getDriveFolders, setDriveFolders, scanDrive, importFromDrive,
}
