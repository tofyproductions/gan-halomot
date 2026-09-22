const mongoose = require('mongoose');
const {
  Employee, Branch, EmployeeDocument, EmploymentContract, EmployeeCourse,
  EmployeeRequest, EmployeeLetter, SavedPayslip, Punch,
} = require('../models');
const { resolveBranchScope } = require('../utils/branch-scope');
const { COURSE_TYPES } = require('../services/compliance');

/**
 * תיק העובד — every file that exists about one employee, on one screen.
 *
 * Nothing here is a new store. The contract already lived in
 * EmploymentContract, the 101 and the free uploads in EmployeeDocument, the
 * certificates in EmployeeCourse, the sick notes on the EmployeeRequest that
 * carried them, the issued letters in EmployeeLetter, the payslips and their
 * hours reports in SavedPayslip. Each was reachable from its own screen and
 * nowhere else, so "show me everything we hold about her" — the question asked
 * at a termination, a hearing, or a ministry audit — was six screens and a
 * memory of which ones exist.
 *
 * This controller only READS those six and hands back one list with a shelf
 * label on every row. The download link on each row is the source screen's own
 * endpoint, so permissions, scoping and file storage stay where they already
 * work, and nothing is copied into a second place that can drift.
 *
 * The one thing it does own is the upload: a document that belongs to no
 * existing flow (a recommendation, a ת"ז copy, a bank form) is filed as an
 * EmployeeDocument with a shelf label, which is what that model was for.
 */

// The shelves, in the order the screen shows them. `key` is what a row's
// doc_type/source resolves to; the labels live on the client.
const SHELVES = [
  'employment_contract', 'form_101', 'payslip', 'hours_report',
  'certificate', 'health', 'recommendation', 'id_document', 'bank_details',
  'letter', 'other',
];

/** How the client should fetch the bytes behind a row. */
const BINARY = 'binary';   // GET → the file itself (blob)
const BASE64 = 'base64';   // GET → { data, name, mimetype }

const CONTRACT_STATUS_HE = {
  draft: 'טיוטה', sent: 'נשלח לחתימה', signed: 'חתום',
  approved: 'אושר', waived: 'ויתור', uploaded: 'הועלה סרוק',
};

const REQUEST_LABEL = { sick: 'אישור מחלה', vacation: 'אישור חופשה' };

const LETTER_LABEL = {
  hearing_invite: 'זימון לשימוע',
  hearing_protocol: 'פרוטוקול שימוע',
  termination: 'מכתב סיום העסקה',
  employment_confirmation: 'אישור העסקה',
};

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * The employee, if this request may see her at all.
 *
 * A branch manager reaches everything in this file cabinet for her own staff —
 * payslips included, which is a deliberate widening over the salary screens:
 * she is the one a member of her team asks about a short month, and sending
 * her to the accountant for a document she is accountable for is the reason
 * things get photographed and mailed around instead.
 */
async function loadEmployee(req, employeeId) {
  const emp = await Employee.findById(employeeId)
    .select('full_name israeli_id branch_id position start_date is_active salary_type')
    .lean();
  if (!emp) return { error: { status: 404, message: 'עובד/ת לא נמצא/ה' } };
  const scope = await resolveBranchScope(req);
  if (scope && !scope.map(String).includes(String(emp.branch_id))) {
    return { error: { status: 403, message: 'העובד/ת אינו/ה בסניף שבאחריותך' } };
  }
  const branch = emp.branch_id
    ? await Branch.findById(emp.branch_id).select('name').lean()
    : null;
  return { emp, branch };
}

/** Contracts — digital and scanned alike. */
function contractItems(contracts) {
  return contracts
    .filter(c => c.html || c.uploaded_file?.data || c.uploaded_file?.storage_key)
    .map(c => ({
      id: String(c._id),
      shelf: 'employment_contract',
      source: 'employment_contract',
      title: c.variant === 'global' ? 'הסכם העסקה — שכר גלובלי' : 'הסכם העסקה — שכר שעתי',
      subtitle: CONTRACT_STATUS_HE[c.status] || c.status,
      date: iso(c.signed_at || c.uploaded_file?.uploaded_at || c.created_at),
      file_name: c.uploaded_file?.name || '',
      mimetype: c.uploaded_file?.mimetype || 'application/pdf',
      href: `/employment-contracts/${c._id}/file`,
      fetch_mode: BINARY,
      // The status is already the subtitle; a badge repeating it would render
      // "חתום · חתום" on the row.
      badges: [],
      deletable: false,
    }));
}

/** Free uploads and filed 101s — the only rows this screen itself creates. */
function documentItems(docs) {
  return docs.map(d => ({
    id: String(d._id),
    shelf: SHELVES.includes(d.doc_type) ? d.doc_type : 'other',
    source: 'employee_document',
    title: d.name,
    subtitle: [
      d.doc_type === 'form_101' && d.tax_year ? `שנת מס ${d.tax_year}` : '',
      d.description || '',
    ].filter(Boolean).join(' · '),
    date: iso(d.created_at),
    file_name: d.file_name || '',
    mimetype: d.file_mimetype || '',
    href: `/employee-documents/${d._id}/download`,
    fetch_mode: BINARY,
    delete_href: `/employee-documents/${d._id}`,
    badges: [
      d.self_uploaded ? 'הועלה ע״י העובד/ת' : null,
      d.source === 'mail' ? 'הגיע במייל' : null,
      // "לא נבדק" is the accountant's queue in the salary table's notes
      // column, and it only means anything for a document filed AGAINST a
      // month. A recommendation from 2023 is not waiting for anybody, and
      // flagging every upload here would make the flag mean nothing where it
      // does matter.
      d.month && !d.acknowledged ? 'לא נבדק' : null,
    ].filter(Boolean),
    uploaded_by: d.created_by?.full_name || '',
    deletable: true,
  }));
}

/** Course certificates. A course with only an external link has no file row. */
function courseItems(courses) {
  return courses
    .filter(c => c.file_data)
    .map(c => ({
      id: String(c._id),
      shelf: 'certificate',
      source: 'employee_course',
      title: `תעודה — ${c.label || COURSE_TYPES[c.course_type] || c.course_type || 'הסמכה'}`,
      subtitle: c.expires_at ? `בתוקף עד ${new Date(c.expires_at).toLocaleDateString('he-IL')}` : '',
      date: iso(c.completed_at || c.created_at),
      file_name: c.file_name || '',
      mimetype: c.file_mimetype || '',
      href: `/employee-courses/${c._id}/file`,
      fetch_mode: BASE64,
      badges: c.is_archived ? ['ארכיון'] : [],
      deletable: false,
    }));
}

/** Sick notes and the like, which live on the request that carried them. */
function requestItems(requests) {
  return requests.map(r => ({
    id: String(r._id),
    shelf: 'health',
    source: 'employee_request',
    title: `${REQUEST_LABEL[r.type] || 'אישור'} ${r.from_date || ''}${r.to_date && r.to_date !== r.from_date ? `–${r.to_date}` : ''}`.trim(),
    subtitle: r.reason || '',
    date: iso(r.created_at),
    file_name: r.medical_file_name || '',
    mimetype: '',
    href: `/employee-requests/${r._id}/medical-file`,
    fetch_mode: BASE64,
    badges: r.cert_acknowledged ? [] : ['לא נבדק'],
    deletable: false,
  }));
}

/** Letters this system issued. The PDF is rendered from the frozen HTML. */
function letterItems(letters) {
  return letters.map(l => ({
    id: String(l._id),
    shelf: 'letter',
    source: 'employee_letter',
    title: l.title || LETTER_LABEL[l.type] || 'מכתב',
    subtitle: l.signed_by_name ? `חתום: ${l.signed_by_name}` : '',
    date: iso(l.created_at),
    file_name: '',
    mimetype: 'application/pdf',
    href: `/employee-letters/${l._id}/pdf`,
    fetch_mode: BINARY,
    // The issued-letters table this screen replaced could delete a letter that
    // went out by mistake, and taking that away would be a regression dressed
    // as a redesign.
    delete_href: `/employee-letters/${l._id}`,
    badges: ['הונפק מהמערכת'],
    deletable: true,
  }));
}

/**
 * Payslips and hours reports, one row each per month.
 *
 * The payslip only exists once it was produced. The hours report is BOTH: a
 * stored PDF when one was already rendered, and a live render of the month
 * otherwise — the same endpoint does both and caches what it renders, so a row
 * with no snapshot still opens, and opening it creates the snapshot. Which of
 * the two a row is showing is on the badge, and `?refresh=1` re-renders a
 * stored one against today's punches.
 */
function payrollItems(employeeId, slips, punchMonths) {
  const byMonth = new Map();
  for (const s of slips) byMonth.set(s.year_month, s);
  const months = [...new Set([...byMonth.keys(), ...punchMonths])].sort().reverse();

  const out = [];
  for (const ym of months) {
    const s = byMonth.get(ym);
    if (s?.data) {
      out.push({
        id: `payslip-${ym}`,
        shelf: 'payslip',
        source: 'payslip',
        title: `תלוש שכר ${ym}`,
        subtitle: s.sent_at ? `נשלח ${new Date(s.sent_at).toLocaleDateString('he-IL')}` : '',
        date: iso(s.sent_at || `${ym}-01`),
        file_name: `payslip-${ym}.pdf`,
        mimetype: 'application/pdf',
        href: `/payroll/employees/${employeeId}/saved-payslips/${ym}/pdf`,
        fetch_mode: BINARY,
        badges: s.delivered_to_employee ? ['נמסר לעובד/ת'] : [],
        deletable: false,
      });
    }
    out.push({
      id: `hours-${ym}`,
      shelf: 'hours_report',
      source: 'hours_report',
      title: `דוח שעות ${ym}`,
      subtitle: '',
      date: iso(`${ym}-01`),
      file_name: `hours-${ym}.pdf`,
      mimetype: 'application/pdf',
      href: `/payroll/employees/${employeeId}/saved-payslips/${ym}/hours-report`,
      refresh_href: `/payroll/employees/${employeeId}/saved-payslips/${ym}/hours-report?refresh=1`,
      fetch_mode: BINARY,
      badges: s?.hours_report_data ? ['שמור בתיק'] : ['מחושב חי'],
      deletable: false,
    });
  }
  return out;
}

/** The last two years of months this employee has any punch in. */
async function monthsWithPunches(employeeId, israeliId) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 2);
  const or = [{ employee_id: employeeId }];
  if (israeliId) or.push({ employee_id: null, israeli_id: israeliId });
  const rows = await Punch.aggregate([
    { $match: { $or: or, timestamp: { $gte: since }, ignored: { $ne: true } } },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m', date: '$timestamp', timezone: 'Asia/Jerusalem' },
        },
      },
    },
  ]);
  return rows.map(r => r._id).filter(Boolean);
}

/**
 * GET /api/employee-file/:employeeId
 */
async function get(req, res, next) {
  try {
    const { emp, branch, error } = await loadEmployee(req, req.params.employeeId);
    if (error) return res.status(error.status).json({ error: error.message });
    const id = String(emp._id);

    // The employee's own user account owns some requests instead of the
    // employee row — the same split employeeDocuments.controller handles.
    const withUser = await Employee.findById(id).select('user_id').lean();
    const requestOwner = withUser?.user_id
      ? { $or: [{ employee_id: id }, { user_id: withUser.user_id }] }
      : { employee_id: id };

    const [contracts, docs, courses, requests, letters, slips, punchMonths] = await Promise.all([
      // `html` is the frozen contract text and `uploaded_file.data` a whole
      // scan — neither belongs in a listing. But whether they EXIST is exactly
      // what decides if a contract has a document to open at all, so they are
      // reduced to booleans by the database rather than excluded and then
      // asked about (which silently hid every digitally signed contract).
      EmploymentContract.aggregate([
        { $match: { employee_id: new mongoose.Types.ObjectId(id) } },
        { $sort: { created_at: -1 } },
        {
          $project: {
            variant: 1, status: 1, signed_at: 1, created_at: 1,
            'uploaded_file.name': 1, 'uploaded_file.mimetype': 1,
            'uploaded_file.uploaded_at': 1,
            'uploaded_file.storage_key': 1,
            html: { $toBool: { $ifNull: ['$html', false] } },
            'uploaded_file.data': { $toBool: { $ifNull: ['$uploaded_file.data', false] } },
          },
        },
      ]),
      EmployeeDocument.find({ employee_id: id })
        .select('-file_data')
        .populate('created_by', 'full_name')
        .sort({ created_at: -1 }).lean(),
      // `file_data` only decides whether a row HAS a file — a certificate scan
      // is megabytes and nothing here renders it, so it is reduced to a
      // boolean by the database rather than pulled across and thrown away.
      EmployeeCourse.aggregate([
        { $match: { employee_id: new mongoose.Types.ObjectId(id) } },
        {
          $project: {
            course_type: 1, label: 1, completed_at: 1, expires_at: 1,
            file_name: 1, file_mimetype: 1, is_archived: 1, created_at: 1,
            file_data: { $toBool: { $ifNull: ['$file_data', false] } },
          },
        },
      ]),
      EmployeeRequest.find({ ...requestOwner, medical_file_data: { $ne: null } })
        .select('type from_date to_date reason medical_file_name created_at cert_acknowledged')
        .sort({ from_date: -1 }).lean(),
      EmployeeLetter.find({ employee_id: id })
        .select('type title signed_by_name created_at')
        .sort({ created_at: -1 }).lean(),
      SavedPayslip.find({ employee_id: id })
        // Buffers are never sent here — only whether one exists.
        .select('year_month sent_at delivered_to_employee data hours_report_data')
        .lean()
        .then(rows => rows.map(r => ({
          year_month: r.year_month,
          sent_at: r.sent_at,
          delivered_to_employee: r.delivered_to_employee,
          data: !!r.data,
          hours_report_data: !!r.hours_report_data,
        }))),
      monthsWithPunches(id, emp.israeli_id),
    ]);

    const items = [
      ...contractItems(contracts),
      ...documentItems(docs),
      ...courseItems(courses),
      ...requestItems(requests),
      ...letterItems(letters),
      ...payrollItems(id, slips, punchMonths),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    res.json({
      employee: {
        id,
        full_name: emp.full_name,
        israeli_id: emp.israeli_id || '',
        position: emp.position || '',
        branch_name: branch?.name || '',
        start_date: emp.start_date || null,
        is_active: emp.is_active !== false,
      },
      shelves: SHELVES,
      items,
    });
  } catch (err) { next(err); }
}

module.exports = { get, SHELVES };
