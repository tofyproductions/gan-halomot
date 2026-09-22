const { Child, Registration, Classroom, ClassroomMoveRequest } = require('../models');
const notificationService = require('../services/notification.service');
const { normalizeYear, getAcademicYears } = require('../services/academic-year.service');
const { registrationIdsInScope, canAccessRegistration } = require('../utils/branch-scope');

// Fields a child edit may NOT set from the request body. registration_id and
// branch belong to the enrollment, not the child form; is_active / hidden_*
// have their own guarded endpoints (hide/unhide/remove). Blocking them turns
// PUT /children/:id from a mass-assignment hole back into an edit of the child.
const CHILD_UPDATE_BLOCKLIST = [
  '_id', 'id', 'created_at', 'updated_at',
  'registration_id', 'is_active', 'hidden_at', 'hidden_by_name', 'hide_note',
];

async function getAll(req, res, next) {
  try {
    const { classroom_id, year } = req.query;
    const academicYears = getAcademicYears();

    const filter = { is_active: true };

    if (year) {
      filter.academic_year = normalizeYear(year);
    } else {
      filter.academic_year = academicYears.current.range;
    }

    if (classroom_id) {
      filter.classroom_id = classroom_id;
    }

    // The branch boundary: a child reaches a branch through its registration,
    // so scope by the registrations the caller may see. null = all branches.
    const regScope = await registrationIdsInScope(req);
    if (regScope !== null) {
      filter.registration_id = { $in: regScope };
    }

    // Paging, on the same terms as the employees list: only when asked for, so
    // a gan keeps getting its whole class and nothing is ever silently cut —
    // a child missing from a list reads as a child who left. `total` is
    // returned either way so a network's client can discover it should page.
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : null;
    const page = Math.max(1, Number(req.query.page) || 1);

    const q = String(req.query.q || '').trim();
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.child_name = { $regex: safe, $options: 'i' };
    }

    const total = await Child.countDocuments(filter);

    // Same ceiling as the employees list, and for the same reason: everything
    // is right for a gan and fatal for a network. Refusing names the number and
    // the way to ask again, rather than sending 80,000 rows to a browser that
    // cannot draw them.
    const MAX_UNPAGED = Number(process.env.LIST_MAX_UNPAGED || 5000);
    if (!limit && total > MAX_UNPAGED) {
      return res.status(413).json({
        error: `${total.toLocaleString('he-IL')} ילדים הם יותר מדי להצגה בבת אחת.`,
        hint: 'בחרו סניף או כיתה, חפשו, או בקשו עמוד (limit ו-page).',
        total,
        max_unpaged: MAX_UNPAGED,
      });
    }

    let query = Child.find(filter)
      .populate('classroom_id', 'name capacity')
      .sort({ child_name: 1 });
    if (limit) query = query.skip((page - 1) * limit).limit(limit);
    const children = await query.lean();

    const result = children.map(c => ({
      ...c,
      id: c._id,
      classroom_name: c.classroom_id?.name || null,
      classroom_capacity: c.classroom_id?.capacity || null,
      classroom_id: c.classroom_id?._id || c.classroom_id,
    }));

    res.json({
      children: result,
      total,
      page: limit ? page : 1,
      limit: limit || total,
      has_more: limit ? page * limit < total : false,
    });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;
    const child = await Child.findById(id).populate('classroom_id', 'name').lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }
    if (!(await canAccessRegistration(req, child.registration_id))) {
      return res.status(404).json({ error: 'Child not found' });
    }

    child.id = child._id;
    child.classroom_name = child.classroom_id?.name || null;
    child.classroom_id = child.classroom_id?._id || child.classroom_id;

    let registration = null;
    if (child.registration_id) {
      registration = await Registration.findById(child.registration_id).lean();
      if (registration) registration.id = registration._id;
    }

    res.json({ child, registration });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    for (const field of CHILD_UPDATE_BLOCKLIST) delete updates[field];

    const existing = await Child.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Child not found' });
    }
    if (!(await canAccessRegistration(req, existing.registration_id))) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const updated = await Child.findByIdAndUpdate(id, updates, { new: true })
      .populate('classroom_id', 'name').lean();

    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

async function updateClassroom(req, res, next) {
  try {
    const { id } = req.params;
    const { classroom_id } = req.body;

    if (!classroom_id) {
      return res.status(400).json({ error: 'classroom_id is required' });
    }

    const child = await Child.findById(id);
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }
    if (!(await canAccessRegistration(req, child.registration_id))) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const classroom = await Classroom.findById(classroom_id);
    if (!classroom) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    const fromRoom = child.classroom_id
      ? await Classroom.findById(child.classroom_id).select('name branch_id').lean()
      : null;
    await moveChild(child, classroom);

    // A direct move is the manager's own act, so the notification is a
    // record rather than a request: the branch's managers (and, when the
    // mover IS the manager, the admins behind her) see that it happened.
    notifyMoved(child, fromRoom, classroom, req.user)
      .catch(err => console.error('[children] move notify failed:', err.message));

    const updated = await Child.findById(id).populate('classroom_id', 'name').lean();
    updated.id = updated._id;
    updated.classroom_name = updated.classroom_id?.name || null;
    updated.classroom_id = updated.classroom_id?._id || updated.classroom_id;

    res.json({ child: updated });
  } catch (error) {
    next(error);
  }
}

/**
 * The one place a child changes room.
 *
 * Direct (a drag on the dashboard) and approved (a תינוקייה's request the
 * manager said yes to) both end here, so the two can never disagree about
 * what a move consists of: the child, the registration behind the child, and
 * an extension that no longer makes sense. A child moved INTO the room they
 * were being carried on does not need carrying any more.
 */
async function moveChild(child, classroom) {
  child.classroom_id = classroom._id;
  if (child.board_extension?.classroom_id
    && String(child.board_extension.classroom_id) === String(classroom._id)) {
    child.board_extension = { classroom_id: null, until: null, set_by: null, set_at: new Date() };
  }
  await child.save();
  if (child.registration_id) {
    await Registration.findByIdAndUpdate(child.registration_id, { classroom_id: classroom._id });
  }
}

async function notifyMoved(child, fromRoom, toRoom, actor) {
  const branchId = toRoom.branch_id || fromRoom?.branch_id || null;
  const ids = await notificationService.branchManagerIds(branchId);
  const body = `${child.child_name}: ${fromRoom?.name || 'ללא כיתה'} ← ${toRoom.name}`
    + (actor?.full_name ? ` (${actor.full_name})` : '');
  await Promise.all(ids
    // The person who dragged does not need to be told what she just did.
    .filter(id => String(id) !== String(actor?.id))
    .map(recipient_id => notificationService.createEvent({
      type: 'child_moved', ref_collection: 'Child', ref_id: child._id, recipient_id,
      title: 'ילד/ה הועבר/ה כיתה', body, url: '/',
    })));
  // Informational: nothing to act on, so it must not be re-sent hourly until
  // somebody "resolves" it. Closed the moment it is created.
  await notificationService.resolveEvents({ ref_collection: 'Child', ref_id: child._id });
}

/* ------------------------------------------------------------------ *
 *  מעברי כיתה ממתינים — the תינוקייה asked, the manager decides
 * ------------------------------------------------------------------ */

const decides = (req) => ['system_admin', 'branch_manager'].includes(req.user?.role);

/** GET /api/children/move-requests?status=pending */
async function listMoveRequests(req, res, next) {
  try {
    const status = String(req.query.status || 'pending');
    const filter = status === 'all' ? {} : { status };
    const { resolveBranchScope } = require('../utils/branch-scope');
    const scope = await resolveBranchScope(req);
    if (scope !== null) filter.branch_id = { $in: scope };
    const rows = await ClassroomMoveRequest.find(filter).sort({ created_at: 1 }).limit(200).lean();
    res.json({
      requests: rows.map(r => ({
        id: String(r._id),
        child_id: String(r.child_id),
        child_name: r.child_name,
        from: r.from_name,
        to: r.to_name,
        keep_on_board: !!r.keep_on_board,
        status: r.status,
        requested_by_name: r.requested_by_name,
        created_at: r.created_at,
        decided_by_name: r.decided_by_name,
        decided_at: r.decided_at,
        reject_reason: r.reject_reason,
      })),
      may_decide: decides(req),
    });
  } catch (error) { next(error); }
}

async function loadRequest(req, id) {
  const request = await ClassroomMoveRequest.findById(id);
  if (!request) return { error: 'הבקשה לא נמצאה', status: 404 };
  if (request.status !== 'pending') return { error: 'הבקשה כבר טופלה', status: 400 };
  if (!decides(req)) return { error: 'רק מנהלת סניף או מנהל מערכת מאשרים מעבר כיתה', status: 403 };
  const { resolveBranchScope } = require('../utils/branch-scope');
  const scope = await resolveBranchScope(req);
  if (scope !== null && !scope.map(String).includes(String(request.branch_id))) {
    return { error: 'הבקשה שייכת לסניף שאינו בניהולך', status: 403 };
  }
  return { request };
}

/**
 * POST /api/children/move-requests/:id/approve
 *
 * The move happens HERE and nowhere earlier. If the תינוקייה asked to keep
 * the child on its board, that starts now too: three months from the day of
 * approval, not the day of the request.
 */
async function approveMoveRequest(req, res, next) {
  try {
    const { request, error, status } = await loadRequest(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const child = await Child.findById(request.child_id);
    const room = await Classroom.findById(request.to_classroom_id).select('name branch_id').lean();
    if (!child || !room) return res.status(404).json({ error: 'הילד/ה או הכיתה כבר לא קיימים' });

    const fromRoom = request.from_classroom_id
      ? await Classroom.findById(request.from_classroom_id).select('name branch_id').lean()
      : null;
    await moveChild(child, room);
    if (request.keep_on_board && request.from_classroom_id) {
      const until = new Date();
      until.setMonth(until.getMonth() + 3);
      until.setHours(23, 59, 59, 999);
      child.board_extension = {
        classroom_id: request.from_classroom_id, until, set_by: req.user?.id || null, set_at: new Date(),
      };
      await child.save();
    }

    request.status = 'approved';
    request.decided_by = req.user?.id || null;
    request.decided_by_name = req.user?.full_name || '';
    request.decided_at = new Date();
    await request.save();

    await notificationService.resolveEvents({ ref_collection: 'ClassroomMoveRequest', ref_id: request._id });
    notifyMoved(child, fromRoom, room, req.user).catch(() => {});
    res.json({ ok: true });
  } catch (error) { next(error); }
}

/** POST /api/children/move-requests/:id/reject  { reason } */
async function rejectMoveRequest(req, res, next) {
  try {
    const { request, error, status } = await loadRequest(req, req.params.id);
    if (error) return res.status(status).json({ error });
    request.status = 'rejected';
    request.reject_reason = String(req.body?.reason || '').slice(0, 300);
    request.decided_by = req.user?.id || null;
    request.decided_by_name = req.user?.full_name || '';
    request.decided_at = new Date();
    await request.save();
    await notificationService.resolveEvents({ ref_collection: 'ClassroomMoveRequest', ref_id: request._id });
    res.json({ ok: true });
  } catch (error) { next(error); }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const child = await Child.findById(id);
    if (!child) {
      return res.status(404).json({ error: 'Child not found' });
    }
    if (!(await canAccessRegistration(req, child.registration_id))) {
      return res.status(404).json({ error: 'Child not found' });
    }

    child.is_active = false;
    await child.save();

    res.json({ message: 'Child deactivated successfully', id });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/children/:id/hide  { note }
 *
 * הסרה זמנית: the child left the ClickTac/תמ"ת list before the next file
 * upload says so. Off the contact page and every roster now; the next file
 * import restores them automatically if their ת"ז reappears.
 */
async function hide(req, res, next) {
  try {
    const child = await Child.findById(req.params.id);
    if (!child) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });
    if (!(await canAccessRegistration(req, child.registration_id))) {
      return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });
    }
    child.is_active = false;
    child.hidden_at = new Date();
    child.hidden_by_name = req.user?.full_name || req.user?.username || '';
    child.hide_note = String(req.body?.note || '').trim();
    await child.save();
    res.json({ ok: true });
  } catch (error) { next(error); }
}

/** POST /api/children/:id/unhide — the manager puts the child back herself. */
async function unhide(req, res, next) {
  try {
    const child = await Child.findById(req.params.id);
    if (!child) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });
    if (!(await canAccessRegistration(req, child.registration_id))) {
      return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });
    }
    child.is_active = true;
    child.hidden_at = null;
    child.hidden_by_name = '';
    child.hide_note = '';
    await child.save();
    res.json({ ok: true });
  } catch (error) { next(error); }
}

/** GET /api/children/hidden — the temporarily-removed, so they can be restored. */
async function listHidden(req, res, next) {
  try {
    const hiddenFilter = { hidden_at: { $ne: null }, is_active: false };
    const regScope = await registrationIdsInScope(req);
    if (regScope !== null) {
      hiddenFilter.registration_id = { $in: regScope };
    }
    const rows = await Child.find(hiddenFilter)
      .populate('classroom_id', 'name')
      .sort({ hidden_at: -1 })
      .lean();
    res.json({
      children: rows.map(c => ({
        id: String(c._id),
        child_name: c.child_name,
        classroom_name: c.classroom_id?.name || '',
        academic_year: c.academic_year,
        hidden_at: c.hidden_at,
        hidden_by_name: c.hidden_by_name,
        hide_note: c.hide_note,
      })),
    });
  } catch (error) { next(error); }
}

module.exports = {
  getAll, getById, update, updateClassroom, remove, hide, unhide, listHidden,
  listMoveRequests, approveMoveRequest, rejectMoveRequest,
};
