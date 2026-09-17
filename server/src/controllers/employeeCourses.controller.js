const { EmployeeCourse, Employee, Branch } = require('../models');
const { resolveBranchScope, canAccessBranch } = require('../utils/branch-scope');
const { COURSE_TYPES, WARN_DAYS, statusOf, daysLeft } = require('../services/compliance');
const { buildHtml: buildCourseReportHtml } = require('../services/course-report');
const { htmlToPdf } = require('../services/htmlPdf');

/**
 * קורסים והכשרות — the tracking sheet, moved in.
 *
 * The screen is a roster: every active employee in scope, whether or not she
 * has a single course on file — a worker with NO first-aid row is exactly who
 * this screen exists to expose, so the query starts from Employee and joins
 * courses on, never the other way around.
 */

function shapeCourse(c) {
  return {
    id: String(c._id),
    course_type: c.course_type,
    type_label: c.course_type === 'other'
      ? (c.label || COURSE_TYPES.other)
      : COURSE_TYPES[c.course_type] || c.course_type,
    label: c.label || '',
    completed_at: c.completed_at,
    expires_at: c.expires_at,
    // A course that never expires (קורס מטפלות) is complete the day the
    // certificate exists — 'no_expiry' there means done, not missing.
    status: statusOf(c.expires_at),
    days_left: daysLeft(c.expires_at),
    has_file: !!c.file_data,
    file_name: c.file_name || '',
    external_url: c.external_url || '',
    status_note: c.status_note || '',
    notes: c.notes || '',
  };
}

/**
 * GET /api/employee-courses
 * The whole matrix in one round trip: active employees in scope, each with
 * her live courses. Branch narrowing happens on the client — the payload is
 * ~70 rows of metadata, not worth a refetch per filter.
 */
async function list(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const empFilter = { is_active: true };
    if (scope !== null) empFilter.branch_id = { $in: scope };

    const employees = await Employee.find(empFilter)
      .select('full_name branch_id position israeli_id phone email')
      .sort({ full_name: 1 })
      .lean();

    const [courses, branches] = await Promise.all([
      EmployeeCourse.find({
        employee_id: { $in: employees.map(e => e._id) },
        is_archived: false,
      }).select('-file_data').lean(),
      Branch.find(scope === null ? {} : { _id: { $in: scope } }).select('name').lean(),
    ]);

    const byEmployee = new Map();
    for (const c of courses) {
      const k = String(c.employee_id);
      if (!byEmployee.has(k)) byEmployee.set(k, []);
      byEmployee.get(k).push(shapeCourse(c));
    }
    const branchNames = new Map(branches.map(b => [String(b._id), b.name]));

    res.json({
      employees: employees.map(e => ({
        id: String(e._id),
        full_name: e.full_name,
        position: e.position || '',
        phone: e.phone || '',
        email: e.email || '',
        branch_id: String(e.branch_id || ''),
        branch_name: branchNames.get(String(e.branch_id)) || '',
        courses: byEmployee.get(String(e._id)) || [],
      })),
      branches: branches.map(b => ({ id: String(b._id), name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'he')),
      course_types: COURSE_TYPES,
      warn_days: WARN_DAYS,
    });
  } catch (err) { next(err); }
}

/** The employee, if this caller may act on her branch. */
async function loadEmployeeScoped(req, employeeId) {
  const emp = await Employee.findById(employeeId).select('branch_id full_name').lean();
  if (!emp) return { error: 'עובד/ת לא נמצא/ה', status: 404 };
  if (!(await canAccessBranch(req, emp.branch_id))) {
    return { error: 'אין לך הרשאה לסניף של העובד/ת', status: 403 };
  }
  return { emp };
}

/**
 * POST /api/employee-courses
 * Body: { employee_id, course_type, label?, completed_at?, expires_at?,
 *         file_data?, file_name?, file_mimetype?, external_url?,
 *         status_note?, notes? }
 *
 * A new certificate of a type the employee already holds ARCHIVES the old
 * row — a renewal, not a duplicate. The old תעודה stays reachable under
 * "כולל ישנים".
 */
async function create(req, res, next) {
  try {
    const b = req.body || {};
    if (!b.employee_id) return res.status(400).json({ error: 'יש לבחור עובד/ת' });
    if (!COURSE_TYPES[b.course_type]) return res.status(400).json({ error: 'סוג קורס לא מוכר' });
    const { error, status } = await loadEmployeeScoped(req, b.employee_id);
    if (error) return res.status(status).json({ error });

    if (b.course_type !== 'other') {
      await EmployeeCourse.updateMany(
        { employee_id: b.employee_id, course_type: b.course_type, is_archived: false },
        { $set: { is_archived: true } },
      );
    }

    const doc = await EmployeeCourse.create({
      employee_id: b.employee_id,
      course_type: b.course_type,
      label: String(b.label || '').trim(),
      completed_at: b.completed_at ? new Date(b.completed_at) : null,
      expires_at: b.expires_at ? new Date(b.expires_at) : null,
      file_data: b.file_data || null,
      file_name: b.file_name || '',
      file_mimetype: b.file_mimetype || 'application/octet-stream',
      external_url: String(b.external_url || '').trim(),
      status_note: String(b.status_note || '').trim(),
      notes: b.notes || '',
      source: 'manual',
      created_by: req.user?.id || null,
    });
    res.status(201).json({ id: String(doc._id) });
  } catch (err) { next(err); }
}

/** The course row, if this caller may act on its employee's branch. */
async function loadScoped(req, id) {
  const doc = await EmployeeCourse.findById(id);
  if (!doc) return { error: 'רשומת קורס לא נמצאה', status: 404 };
  const { error, status } = await loadEmployeeScoped(req, doc.employee_id);
  if (error) return { error, status };
  return { doc };
}

/** PUT /api/employee-courses/:id */
async function update(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const b = req.body || {};

    if (b.completed_at !== undefined) doc.completed_at = b.completed_at ? new Date(b.completed_at) : null;
    if (b.expires_at !== undefined) doc.expires_at = b.expires_at ? new Date(b.expires_at) : null;
    if (b.label !== undefined) doc.label = String(b.label || '').trim();
    if (b.external_url !== undefined) doc.external_url = String(b.external_url || '').trim();
    if (b.status_note !== undefined) doc.status_note = String(b.status_note || '').trim();
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

/** DELETE /api/employee-courses/:id — for rows entered by mistake. */
async function remove(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** GET /api/employee-courses/:id/file — the base64 payload for viewing. */
async function getFile(req, res, next) {
  try {
    const { doc, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    if (!doc.file_data) return res.status(404).json({ error: 'אין קובץ — אולי יש קישור חיצוני' });
    res.json({
      data: doc.file_data,
      name: doc.file_name || `${COURSE_TYPES[doc.course_type] || 'תעודה'}.pdf`,
      mimetype: doc.file_mimetype || '',
    });
  } catch (err) { next(err); }
}


/**
 * The same question the screen answers, as a document somebody can carry.
 *
 * Only what is wrong: expired, and missing. A page per course type, because
 * the ask is usually "who is due for עזרה ראשונה" rather than the whole list,
 * and because `types` then narrows it to exactly that page.
 *
 * Scope is `resolveBranchScope`, the same as the screen: a branch manager gets
 * her branches and management gets all of them. It matters more here than on
 * the screen — the file carries ת"ז and a phone number for every row, and a
 * manager has no business holding those for another branch's staff.
 *
 *   GET /employee-courses/report.pdf?branch=<id|all>&types=first_aid,safe_conduct
 */

/**
 * The courses a missing row actually means something for.
 *
 * The same two the screen calls "לטיפול" (client CoursesPage `worstOf`), and
 * for the same reason: these are the ones every member of staff is expected to
 * hold and to renew. Extending it to the caregiver courses was tried and
 * produced 50 and 72 "חסרות" against the live roster — a cook and a branch
 * manager are not short of קורס מטפלות מתקדמות, and a page of people who were
 * never expected to hold a certificate is a page nobody reads twice.
 *
 * The other types still appear in the report; they simply contribute rows only
 * when a certificate actually expired, which is the only shortfall the data
 * can evidence on its own. Making "who owes a caregiver course" answerable
 * needs a rule about which positions require it, and that is the gan's rule to
 * state, not one to infer from a roster.
 */
const REQUIRED_TYPES = ['first_aid', 'safe_conduct'];

/**
 * Of several rows of one type, the one that decides her standing.
 *
 * Latest expiry wins, because that is the certificate that is still good (or
 * least stale). A row with no expiry is a course that does not expire, and it
 * beats any dated one — she has done it, permanently.
 */
function latestOfType(courses, type) {
  const of = courses.filter(c => c.course_type === type);
  if (of.length === 0) return null;
  const permanent = of.find(c => !c.expires_at);
  if (permanent) return permanent;
  return of.slice().sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0];
}

async function reportPdf(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const empFilter = { is_active: true };
    if (scope !== null) {
      if (!scope.length) return res.status(403).json({ error: 'אין לך סניפים בניהול' });
      empFilter.branch_id = { $in: scope };
    }
    if (req.query.branch && req.query.branch !== 'all') {
      if (scope !== null && !scope.map(String).includes(String(req.query.branch))) {
        return res.status(403).json({ error: 'הסניף המבוקש אינו בניהולך' });
      }
      empFilter.branch_id = req.query.branch;
    }

    const wanted = String(req.query.types || '').split(',').map(s => s.trim()).filter(Boolean);
    const types = (wanted.length ? wanted : Object.keys(COURSE_TYPES))
      .filter(t => COURSE_TYPES[t]);
    if (!types.length) return res.status(400).json({ error: 'לא נבחר סוג קורס תקין' });

    const employees = await Employee.find(empFilter)
      .select('full_name branch_id israeli_id phone')
      .sort({ full_name: 1 })
      .lean();
    const [courses, branches] = await Promise.all([
      EmployeeCourse.find({ employee_id: { $in: employees.map(e => e._id) }, is_archived: false })
        .select('-file_data').lean(),
      Branch.find(scope === null ? {} : { _id: { $in: scope } }).select('name').lean(),
    ]);
    const branchNames = new Map(branches.map(b => [String(b._id), b.name]));
    const byEmployee = new Map();
    for (const c of courses) {
      const k = String(c.employee_id);
      byEmployee.set(k, [...(byEmployee.get(k) || []), c]);
    }

    const sections = types.map(type => ({
      key: type,
      label: COURSE_TYPES[type],
      rows: employees.map(e => {
        const mine = byEmployee.get(String(e._id)) || [];
        const latest = latestOfType(mine, type);
        // No row at all is "missing" only where a certificate is expected.
        if (!latest) {
          if (!REQUIRED_TYPES.includes(type)) return null;
          return { employee: e, status: 'missing', course: null };
        }
        return statusOf(latest.expires_at) === 'expired'
          ? { employee: e, status: 'expired', course: latest }
          : null;
      }).filter(Boolean).map(r => ({
        full_name: r.employee.full_name,
        israeli_id: r.employee.israeli_id || '',
        phone: r.employee.phone || '',
        branch_name: branchNames.get(String(r.employee.branch_id)) || '',
        status: r.status,
        course: r.course && {
          expires_at: r.course.expires_at,
          external_url: r.course.external_url || '',
          has_file: !!r.course.file_name,
        },
      })),
    }));

    const branchLabel = empFilter.branch_id && !empFilter.branch_id.$in
      ? (branchNames.get(String(empFilter.branch_id)) || 'סניף')
      : 'כל הסניפים';
    const html = buildCourseReportHtml({
      sections,
      title: 'קורסים והכשרות — פג תוקף וחסרים',
      subtitle: branchLabel,
      generatedAt: new Intl.DateTimeFormat('he-IL', {
        timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
      }).format(new Date()),
      appUrl: process.env.CLIENT_URL || '',
    });

    const pdf = await htmlToPdf(html);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="courses-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(`קורסים-${branchLabel}-${stamp}.pdf`)}`,
    );
    res.send(pdf);
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, getFile, reportPdf, latestOfType, REQUIRED_TYPES };
