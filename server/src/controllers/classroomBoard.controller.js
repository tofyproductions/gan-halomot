const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Classroom } = require('../models');
const env = require('../config/env');
const { CLASSROOM_BOARD } = require('../constants/roles');
const { resolveBranchScope } = require('../utils/branch-scope');
const nursery = require('../services/nursery.service');

/**
 * לוחות כיתה — the tablet on the wall of one room.
 *
 * Not a person. One account per classroom, opened from a link, unlocked with a
 * password the first time and with the tablet's own fingerprint after that,
 * and left signed in all day where anybody in the room can reach it. That is
 * the point of it and also the whole of the risk, so the account is narrowed
 * everywhere rather than trusted anywhere: it sees ONE room's daily board and
 * that room's photographs, and nothing else in this system.
 *
 * THE LINK IS NOT THE SECRET. `board_token` says WHICH board a tablet is, so
 * the screen opens on צעירים instead of asking somebody to pick from every
 * room in the network, and so a link pasted into the wrong room cannot quietly
 * work. The password is what authenticates, and it is set by an admin — a
 * board never chooses or changes its own.
 *
 * The session is deliberately long. A tablet that signs itself out overnight
 * is a tablet somebody has to re-authenticate every morning before the day can
 * be recorded, which is how a board stops being filled in.
 */

/** Long enough that a room is not re-authenticating at 07:00 every morning. */
const BOARD_SESSION_DAYS = 180;

const newToken = () => crypto.randomBytes(18).toString('hex');

/* ------------------------------------------------------------------ *
 *  Public — what the tablet talks to
 * ------------------------------------------------------------------ */

/**
 * GET /api/public/board/:token
 *
 * Which board this link is, so the sign-in screen can say so. Deliberately
 * says NOTHING about children, staff or the day — a link that leaked should
 * reveal the name of a room and no more, and the password is still in the way.
 */
async function publicInfo(req, res, next) {
  try {
    const user = await User.findOne({
      board_token: String(req.params.token || ''), role: CLASSROOM_BOARD, is_active: true,
    }).select('_id full_name classroom_id branch_id webauthn_credentials').lean();
    if (!user) return res.status(404).json({ error: 'הקישור אינו תקין' });

    const room = user.classroom_id
      ? await Classroom.findById(user.classroom_id).populate('branch_id', 'name').select('name branch_id').lean()
      : null;

    res.json({
      // The id is needed to start a biometric unlock, and it is not a secret:
      // WebAuthn refuses anybody who cannot produce the device's own key.
      user_id: String(user._id),
      board_name: user.full_name,
      classroom: room?.name || '',
      branch: room?.branch_id?.name || '',
      has_biometric: (user.webauthn_credentials || []).length > 0,
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/public/board/:token/login  { password }
 *
 * The one way in that does not need a device key. Rate limited at the mount
 * point with the other public forms: a board password is short enough to be
 * typed by somebody holding a tablet, which is short enough to be guessed by
 * somebody who is not.
 */
async function publicLogin(req, res, next) {
  try {
    const user = await User.findOne({
      board_token: String(req.params.token || ''), role: CLASSROOM_BOARD, is_active: true,
    });
    if (!user) return res.status(404).json({ error: 'הקישור אינו תקין' });
    if (!user.password_hash) {
      return res.status(400).json({ error: 'לא הוגדרה סיסמה ללוח הזה. פנו למנהל המערכת.' });
    }
    const okPassword = await bcrypt.compare(String(req.body?.password || ''), user.password_hash);
    // The same refusal whether the board exists and the password is wrong or
    // the password is right and the board is off — neither is worth telling
    // somebody holding a link they should not have.
    if (!okPassword) return res.status(401).json({ error: 'סיסמה שגויה' });

    res.json(await issue(user));
  } catch (err) { next(err); }
}

/** The token and the facts the tablet needs to draw its screen. */
async function issue(user) {
  const room = user.classroom_id
    ? await Classroom.findById(user.classroom_id).populate('branch_id', 'name').select('name branch_id').lean()
    : null;
  // middleware/auth sets `req.user` to the DECODED TOKEN, so anything the
  // controllers read has to be signed in here. `classroom_id` in particular:
  // it is what narrows this account to one room, and a token without it would
  // be a board with no scope rather than a board that fails closed.
  const payload = {
    id: String(user._id),
    full_name: user.full_name,
    role: CLASSROOM_BOARD,
    classroom_id: user.classroom_id ? String(user.classroom_id) : null,
    branch_id: user.branch_id ? String(user.branch_id) : null,
    // A board manages no branches. Stated rather than left undefined, because
    // "no entry" and "every branch" are one careless `|| []` apart.
    managed_branch_ids: [],
    password_set: true,
    must_change_password: false,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: `${BOARD_SESSION_DAYS}d` });
  return {
    token,
    user: { ...payload, classroom: room?.name || '', branch: room?.branch_id?.name || '' },
  };
}

/* ------------------------------------------------------------------ *
 *  Management — an admin sets these up
 * ------------------------------------------------------------------ */

function shape(user, room) {
  return {
    id: String(user._id),
    full_name: user.full_name,
    classroom_id: user.classroom_id ? String(user.classroom_id) : null,
    classroom: room?.name || '',
    branch: room?.branch_id?.name || '',
    board_token: user.board_token,
    is_active: user.is_active !== false,
    has_password: !!user.password_hash,
    has_biometric: (user.webauthn_credentials || []).length > 0,
    last_login: user.last_login || null,
  };
}

/** GET /api/classroom-boards — the boards, and the rooms that have none. */
async function list(req, res, next) {
  try {
    const scope = await resolveBranchScope(req);
    const roomFilter = { is_active: true };
    if (scope !== null) roomFilter.branch_id = { $in: scope };

    // A room that keeps no daily board has nothing for a tablet to show, so
    // it is not offered one. בוגרים is that case: the screen would otherwise
    // invite somebody to hang a tablet that opens on an empty list, and the
    // first person to notice would be whoever was asked to fill it in.
    const rooms = (await Classroom.find(roomFilter)
      .populate('branch_id', 'name').select('name branch_id academic_year category').lean())
      .filter(r => nursery.boardKind(r) !== 'none');
    const byId = new Map(rooms.map(r => [String(r._id), r]));

    const boards = await User.find({
      role: CLASSROOM_BOARD,
      ...(scope === null ? {} : { branch_id: { $in: scope } }),
    }).select('full_name classroom_id branch_id board_token is_active password_hash webauthn_credentials last_login').lean();

    const covered = new Set(boards.map(b => String(b.classroom_id)));
    res.json({
      boards: boards
        .map(b => shape(b, byId.get(String(b.classroom_id))))
        .sort((a, b) => (a.branch || '').localeCompare(b.branch || '', 'he')
          || (a.classroom || '').localeCompare(b.classroom || '', 'he')),
      // The rooms with no board yet, so the screen is a to-do list rather than
      // a list of what already happens to exist.
      missing: rooms
        .filter(r => !covered.has(String(r._id)))
        .map(r => ({
          classroom_id: String(r._id),
          classroom: r.name,
          branch: r.branch_id?.name || '',
          academic_year: r.academic_year || '',
        }))
        .sort((a, b) => (a.branch || '').localeCompare(b.branch || '', 'he')
          || a.classroom.localeCompare(b.classroom, 'he')),
    });
  } catch (err) { next(err); }
}

/** POST /api/classroom-boards  { classroom_id, password } */
async function create(req, res, next) {
  try {
    const roomId = String(req.body?.classroom_id || '');
    const password = String(req.body?.password || '');
    if (!roomId) return res.status(400).json({ error: 'יש לבחור כיתה' });
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להיות באורך 6 תווים לפחות' });

    const room = await Classroom.findById(roomId)
      .populate('branch_id', 'name').select('name branch_id category').lean();
    if (!room) return res.status(404).json({ error: 'כיתה לא נמצאה' });
    // Refused here too, not only hidden from the list: a room id is a thing
    // somebody can send, and a board on a room with no day would look created
    // and then open on nothing.
    if (nursery.boardKind(room) === 'none') {
      return res.status(400).json({ error: 'לכיתה הזו אין לוח עדכונים, ולכן אין טעם להגדיר לה לוח.' });
    }

    const existing = await User.findOne({ role: CLASSROOM_BOARD, classroom_id: room._id }).select('_id').lean();
    if (existing) return res.status(409).json({ error: 'כבר קיים לוח לכיתה הזו' });

    const branchName = room.branch_id?.name || '';
    const boardToken = newToken();
    const user = await User.create({
      /**
       * A board has no mailbox, and User.email is required and unique.
       *
       * `.invalid` is reserved by RFC 2606 and can never resolve, so this is a
       * well-formed address that is guaranteed to bounce rather than a plausible
       * one that might one day reach a real person — and a board is on nobody's
       * notification list by role anyway. Built from the token so it is unique
       * without inventing a second identifier to keep in step.
       */
      email: `board.${boardToken}@classroom.invalid`,
      // A name somebody reading a user list can place immediately. The board
      // shows up in audit trails as itself, not as "tablet 4".
      full_name: `לוח ${room.name}${branchName ? ` — ${branchName}` : ''}`,
      role: CLASSROOM_BOARD,
      classroom_id: room._id,
      branch_id: room.branch_id?._id || room.branch_id || null,
      board_token: boardToken,
      password_hash: await bcrypt.hash(password, 10),
      password_set: true,
      is_active: true,
    });
    res.status(201).json({ board: shape(user, room) });
  } catch (err) { next(err); }
}

/** The board, if this caller may touch it. */
async function loadScoped(req, id) {
  const user = await User.findOne({ _id: id, role: CLASSROOM_BOARD });
  if (!user) return { error: 'לוח לא נמצא', status: 404 };
  const scope = await resolveBranchScope(req);
  if (scope !== null && !scope.map(String).includes(String(user.branch_id))) {
    return { error: 'הלוח שייך לסניף שאינו בניהולך', status: 403 };
  }
  return { user };
}

/** POST /api/classroom-boards/:id/password  { password } */
async function setPassword(req, res, next) {
  try {
    const { user, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    const password = String(req.body?.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להיות באורך 6 תווים לפחות' });
    user.password_hash = await bcrypt.hash(password, 10);
    user.password_set = true;
    await user.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /api/classroom-boards/:id/revoke
 *
 * The tablet was lost, or left the gan with somebody. A new token invalidates
 * every copy of the old link, and dropping the device keys means the
 * fingerprint on that tablet stops opening anything — which is the half a
 * password change alone would miss.
 */
async function revoke(req, res, next) {
  try {
    const { user, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    user.board_token = newToken();
    user.webauthn_credentials = [];
    await user.save();
    const room = user.classroom_id
      ? await Classroom.findById(user.classroom_id).populate('branch_id', 'name').select('name branch_id').lean()
      : null;
    res.json({ board: shape(user, room) });
  } catch (err) { next(err); }
}

/** PATCH /api/classroom-boards/:id  { is_active } */
async function update(req, res, next) {
  try {
    const { user, error, status } = await loadScoped(req, req.params.id);
    if (error) return res.status(status).json({ error });
    if (req.body?.is_active !== undefined) user.is_active = !!req.body.is_active;
    await user.save();
    const room = user.classroom_id
      ? await Classroom.findById(user.classroom_id).populate('branch_id', 'name').select('name branch_id').lean()
      : null;
    res.json({ board: shape(user, room) });
  } catch (err) { next(err); }
}

module.exports = {
  publicInfo, publicLogin, list, create, setPassword, revoke, update,
  BOARD_SESSION_DAYS,
};
