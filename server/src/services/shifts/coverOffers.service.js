/**
 * Self-nomination for open gaps.
 *
 * The balance strip told the MANAGER where the week is short; this tells the
 * people who could fill it. An employee sees a gap only when all of it holds:
 *   - her own branch, a week the manager has actually opened;
 *   - the class is short of its tekken in that window (same arithmetic as
 *     the strip: ratios, pm caps, Friday has no afternoon);
 *   - the gap has NO internal surplus that day+window — when another class
 *     carries a spare, balancing is the manager's drag, not a hiring call;
 *   - she is FREE there: no entry of hers touching the window (home or
 *     another branch), no accepted constraint, not on maternity leave.
 * Her offer notifies the managers; acceptance writes the entry through
 * applyEntries — the same validated door every placement takes.
 */
const mongoose = require('mongoose');
const {
  ShiftWeek, ShiftCoverOffer, ShiftCoverBonus, Employee, EmployeeCommitment, Branch, Classroom,
} = require('../../models');
const notificationService = require('../notification.service');
const { ShiftError, assertEdit } = require('./access');
const { CATEGORY_KEY, effectiveRatios, pmNeededCaps } = require('./ratio');
const { blocksEntry } = require('./constraintRules');
const { onMaternityLeave } = require('./seed');

const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// The board's own window cuts (ShiftGrid): morning = starts before 13:00,
// afternoon = stays past 14:00.
const AM_STARTS_BEFORE = 13 * 60;
const PM_STAYS_PAST = 14 * 60;
const inWindow = (e, win) => {
  const a = mins(e.start_hhmm); const b = mins(e.end_hhmm);
  if (a == null || b == null) return true;
  return win === 'am' ? a < AM_STARTS_BEFORE : b > PM_STAYS_PAST;
};
const touchesWindow = (e, win) => {
  // For CONFLICTS the question is broader than cover: anything overlapping
  // the window's span makes her not-free there.
  const a = mins(e.start_hhmm); const b = mins(e.end_hhmm);
  if (a == null || b == null) return true;
  return win === 'am' ? a < 14 * 60 : b > 14 * 60;
};
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const todayIL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const sundayOf = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x.toISOString().slice(0, 10); };
const addDays = (ymd, n) => { const x = new Date(`${ymd}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** The open, unbalanceable gaps of one opened week. */
async function openGaps(branchId, weekStart) {
  const week = await ShiftWeek.findOne({ branch_id: branchId, week_start: weekStart }).lean();
  if (!week) return [];
  const branch = await Branch.findById(branchId).lean();
  if (!branch) return [];
  const ratios = effectiveRatios(branch);
  const pmCaps = pmNeededCaps(branch.name);
  const rooms = await Classroom.find({ branch_id: branchId, is_active: true }).select('name category academic_year').lean();
  const counts = await require('../../models').Child.aggregate([
    { $match: { classroom_id: { $in: rooms.map(r => r._id) }, is_active: true } },
    { $group: { _id: '$classroom_id', n: { $sum: 1 } } },
  ]);
  const enrolled = new Map(counts.map(c => [String(c._id), c.n]));
  const entries = week.entries || [];
  const closed = new Set(week.closed_days || []);
  const today = todayIL();

  const dates = [0, 1, 2, 3, 4, 5].map(i => addDays(weekStart, i));
  const gaps = [];
  for (const date of dates) {
    if (closed.has(date) || date < today) continue;
    const isFriday = weekdayOf(date) === 5;
    for (const win of isFriday ? ['am'] : ['am', 'pm']) {
      let surplusSomewhere = false;
      const dayGaps = [];
      for (const room of rooms) {
        const catKey = CATEGORY_KEY[room.category];
        const kids = enrolled.get(String(room._id)) || 0;
        if (!catKey || kids <= 0) continue;
        let needed = Math.ceil(kids / ratios[catKey]);
        if (win === 'pm') {
          const cap = Number(pmCaps && pmCaps[catKey]);
          if (cap > 0) needed = Math.min(needed, cap);
        }
        const staff = new Set(entries
          .filter(e => e.date === date && e.area === 'class' && String(e.classroom_id) === String(room._id) && inWindow(e, win))
          .map(e => String(e.employee_id))).size;
        if (staff > needed) surplusSomewhere = true;
        if (staff < needed) dayGaps.push({
          branch_id: String(branchId), week_start: weekStart, date, window: win,
          classroom_id: String(room._id), classroom_name: room.name, missing: needed - staff,
        });
      }
      // A spare elsewhere in the same window = the manager balances by drag.
      if (!surplusSomewhere) gaps.push(...dayGaps);
    }
  }
  return gaps;
}

/** Is this employee free for the gap, by the placements and the constraints? */
async function isFree(employee, gap) {
  if (onMaternityLeave(employee, gap.date)) return false;
  const weeks = await ShiftWeek.find({ week_start: gap.week_start, 'entries.employee_id': employee._id })
    .select('entries branch_id').lean();
  for (const w of weeks) {
    const hit = (w.entries || []).some(e =>
      String(e.employee_id) === String(employee._id) && e.date === gap.date && touchesWindow(e, gap.window));
    if (hit) return false;
  }
  const constraints = require('./constraints.service');
  const locked = await constraints.acceptedFor({ employeeIds: [String(employee._id)], dates: [gap.date] });
  const synthetic = {
    employee_id: employee._id, date: gap.date,
    start_hhmm: gap.window === 'am' ? '07:00' : '14:00',
    end_hhmm: gap.window === 'am' ? '14:00' : '16:00',
  };
  if (locked.some(c => blocksEntry(c, synthetic))) return false;
  return true;
}

/**
 * The gaps SHE may offer herself for — this week and next, HER branch first
 * and then every other active branch's opened weeks (09.10.2026: a gap in
 * הרצליה may be exactly the extra morning a קפלן worker wants).
 *
 * What crosses the branch line is ONLY the gap itself: branch name, class
 * name, date, window, how many missing. No entries, no names, no numbers of
 * another branch's staffing beyond "here is a hole" — the same four facts a
 * help-wanted note on a door would carry.
 */
async function listForEmployee({ employee }) {
  if (!employee.branch_id || employee.shift_area === 'none') return { gaps: [], offers: [] };
  const thisSunday = sundayOf(todayIL());
  const weeks = [thisSunday, addDays(thisSunday, 7)];
  const branches = await Branch.find({ is_active: { $ne: false } }).select('name').lean();
  const home = String(employee.branch_id);
  const ordered = [...branches].sort((a, b) =>
    (String(a._id) === home ? 0 : 1) - (String(b._id) === home ? 0 : 1));
  const all = [];
  const bonuses = await ShiftCoverBonus.find({ status: 'active', week_start: { $in: weeks } }).lean();
  const bonusOf = new Map(bonuses.map(x => [`${x.branch_id}|${x.date}|${x.window}|${x.classroom_id}`, x.amount]));
  for (const b of ordered) {
    for (const ws of weeks) {
      const gs = await openGaps(b._id, ws);
      for (const g of gs) {
        const foreign = String(b._id) !== home;
        all.push({
          ...g, branch_name: b.name, foreign,
          // The bounty is for TRAVELERS only: her own branch's gap carries
          // no prize — she is expected without one.
          bonus: foreign ? (bonusOf.get(`${g.branch_id}|${g.date}|${g.window}|${g.classroom_id}`) || null) : null,
        });
      }
    }
  }
  const free = [];
  for (const g of all) {
    if (await isFree(employee, g)) free.push(g);
  }
  const offers = await ShiftCoverOffer.find({
    employee_id: employee._id, week_start: { $in: weeks },
  }).sort({ created_at: -1 }).lean();
  const offered = new Set(offers.filter(o => o.status !== 'declined')
    .map(o => `${o.date}|${o.window}|${o.classroom_id}`));
  return {
    gaps: free.filter(g => !offered.has(`${g.date}|${g.window}|${g.classroom_id}`)),
    offers,
  };
}

async function createOffer({ employee, body }) {
  const b = body || {};
  if (!['am', 'pm'].includes(b.window)) throw new ShiftError(400, 'משמרת לא תקינה');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) throw new ShiftError(400, 'תאריך לא תקין');
  if (!mongoose.isValidObjectId(b.classroom_id)) throw new ShiftError(400, 'כיתה לא תקינה');
  // The gap's branch — hers by default, any active branch by request. The
  // probe reveals nothing: a wrong guess answers exactly like a filled slot.
  const targetBranch = b.branch_id && mongoose.isValidObjectId(b.branch_id) ? b.branch_id : employee.branch_id;
  const weekStart = sundayOf(b.date);
  // Revalidated server-side in full — the button is not the authority.
  const gaps = await openGaps(targetBranch, weekStart);
  const gap = gaps.find(g => g.date === b.date && g.window === b.window && g.classroom_id === String(b.classroom_id));
  if (!gap) throw new ShiftError(409, 'המשבצת כבר לא פתוחה — ייתכן שהסידור השתנה');
  if (!(await isFree(employee, gap))) throw new ShiftError(409, 'כבר יש לך שיבוץ או אילוץ בשעות האלה');
  if (await ShiftCoverOffer.exists({ employee_id: employee._id, date: gap.date, window: gap.window, classroom_id: gap.classroom_id, status: 'pending' })) {
    throw new ShiftError(409, 'כבר הצעת את עצמך למשבצת הזו');
  }
  const foreign = String(targetBranch) !== String(employee.branch_id);
  const offer = await ShiftCoverOffer.create({
    ...gap, employee_id: employee._id, employee_name: employee.full_name,
  });
  const { User } = require('../../models');
  const { branchManagerFilter } = require('../branch-recipients.service');
  const managers = await User.find({ ...branchManagerFilter(gap.branch_id), role: 'branch_manager' }).select('_id').lean();
  const [, m, d] = gap.date.split('-');
  await Promise.all(managers.map(u => notificationService.notifyOnce({
    type: 'cover_offer', ref_collection: 'ShiftCoverOffer', ref_id: offer._id, recipient_id: u._id,
    title: `${employee.full_name}${foreign ? ' (מסניף אחר)' : ''} מציעה את עצמה ל${gap.classroom_name}`,
    body: `${d}/${m} · משמרת ${gap.window === 'am' ? 'בוקר' : 'צהריים'} — אפשר לאשר מהסידור${foreign ? '; שיבוץ מסניף אחר יעבור גם אישור סניף הבית' : ''}`,
    url: '/shifts',
  }).catch(err => console.error('[cover-offers] notify failed:', err.message))));
  return offer;
}

/** The pending offers a manager sees on her board — marked foreign, with
 *  the bonus that would apply so the approve button says the whole truth. */
async function pendingFor(branchId, weekStart) {
  const offers = await ShiftCoverOffer.find({ branch_id: branchId, week_start: weekStart, status: 'pending' })
    .sort({ date: 1 }).lean();
  if (!offers.length) return offers;
  const emps = await Employee.find({ _id: { $in: offers.map(o => o.employee_id) } })
    .select('branch_id').lean();
  const homeOf = new Map(emps.map(e => [String(e._id), String(e.branch_id)]));
  const bonuses = await ShiftCoverBonus.find({ branch_id: branchId, week_start: weekStart, status: 'active' }).lean();
  const bonusOf = new Map(bonuses.map(x => [`${x.date}|${x.window}|${x.classroom_id}`, x.amount]));
  const homeBranches = await Branch.find({ _id: { $in: [...new Set([...homeOf.values()])] } }).select('name').lean();
  const branchName = new Map(homeBranches.map(b => [String(b._id), b.name]));
  return offers.map(o => {
    const home = homeOf.get(String(o.employee_id));
    const foreign = home && home !== String(branchId);
    return {
      ...o, foreign,
      home_branch_name: foreign ? (branchName.get(home) || '') : '',
      bonus: foreign ? (bonusOf.get(`${o.date}|${o.window}|${o.classroom_id}`) || null) : null,
    };
  });
}

/** Her hours for the window: her commitment for that weekday, clipped. */
function windowHours(commitment, date, win) {
  const day = (commitment?.days || []).find(d => d.day === weekdayOf(date) && !d.is_off && d.start_hhmm && d.end_hhmm);
  const start = day ? day.start_hhmm : '07:00';
  const end = day ? day.end_hhmm : '16:00';
  if (win === 'am') return { start_hhmm: start < '14:00' ? start : '07:00', end_hhmm: '14:00' };
  return { start_hhmm: '14:00', end_hhmm: end > '14:00' ? end : '16:00' };
}

async function decideOffer({ user, id, approve, reason }) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'הצעה לא נמצאה');
  const offer = await ShiftCoverOffer.findById(id);
  if (!offer) throw new ShiftError(404, 'הצעה לא נמצאה');
  assertEdit(user, offer.branch_id);
  if (offer.status !== 'pending') throw new ShiftError(409, 'ההצעה כבר טופלה');

  const emp = await Employee.findById(offer.employee_id).lean();
  if (!emp) throw new ShiftError(404, 'העובדת לא נמצאה');

  if (approve) {
    const week = await ShiftWeek.findOne({ branch_id: offer.branch_id, week_start: offer.week_start });
    if (!week) throw new ShiftError(409, 'הסידור לשבוע הזה כבר לא קיים');
    const commitment = await EmployeeCommitment.findOne({ employee_id: emp._id }).lean();
    const hours = windowHours(commitment, offer.date, offer.window);
    const entry = {
      employee_id: emp._id, employee_name: emp.full_name, date: offer.date,
      area: 'class', classroom_id: offer.classroom_id,
      start_hhmm: hours.start_hhmm, end_hhmm: hours.end_hhmm,
    };
    // The same validated door every placement takes: constraints, overlaps,
    // cross-branch rules all run. A conflict surfaces as the error it is.
    const shiftWeek = require('./shiftWeek.service');
    try {
      await shiftWeek.saveEntries({ user, weekId: week._id, entries: [...week.entries.map(e => e.toObject()), entry] });
    } catch (err) {
      // A foreign volunteer without a host rate: keep the offer pending and
      // tell the manager the one step that unblocks it.
      if (err && err.extra && err.extra.needs_rate) {
        throw new ShiftError(409, `ל${emp.full_name} אין עדיין תעריף בסניף — פתחי "בקשת תעריף" (התעריף הרגיל שלה מאושר מיד) ואז אשרי שוב`, err.extra);
      }
      throw err;
    }
    offer.status = 'accepted';
    /**
     * The bounty, paid by the rules: a FOREIGN taker of a slot that carries
     * an active bonus gets a pending money_add adjustment — the accountant
     * approves it like any other addition; nothing lands on a payslip on a
     * manager's word alone. Hers-branch takers never claim it.
     */
    if (String(emp.branch_id) !== String(offer.branch_id)) {
      const bonus = await ShiftCoverBonus.findOne({
        branch_id: offer.branch_id, date: offer.date, window: offer.window,
        classroom_id: offer.classroom_id, status: 'active',
      });
      if (bonus) {
        const { SalaryAdjustment, Branch: BranchModel } = require('../../models');
        const hostName = (await BranchModel.findById(offer.branch_id).select('name').lean())?.name || '';
        await SalaryAdjustment.create({
          employee_id: emp._id,
          branch_id: emp.branch_id,
          month: offer.date.slice(0, 7),
          type: 'money_add',
          amount: bonus.amount,
          reason: `בונוס כיסוי משמרת בסניף ${hostName} — ${offer.classroom_name}, ${offer.date}, משמרת ${offer.window === 'am' ? 'בוקר' : 'צהריים'}`,
          created_by: user.id,
          created_by_role: user.role || '',
          status: 'pending',
        });
        bonus.claimed_by_name = emp.full_name;
        bonus.claimed_at = new Date();
        await bonus.save();
      }
    }
  } else {
    if (!String(reason || '').trim()) throw new ShiftError(400, 'יש לכתוב סיבה לדחייה');
    offer.status = 'declined';
    offer.reject_reason = String(reason).trim().slice(0, 300);
  }
  offer.decided_by = user.id;
  await offer.save();

  if (emp.user_id) {
    const [, m, d] = offer.date.split('-');
    await notificationService.notifyOnce({
      type: 'cover_offer_decision', ref_collection: 'ShiftCoverOffer', ref_id: offer._id, recipient_id: emp.user_id,
      title: approve ? `שובצת ל${offer.classroom_name} ב-${d}/${m}` : 'ההצעה שלך לא אושרה',
      body: approve ? `משמרת ${offer.window === 'am' ? 'בוקר' : 'צהריים'} — תראי את זה בסידור` : (offer.reject_reason || ''),
      url: `/my-shifts?week=${offer.week_start}`,
    }).catch(err => console.error('[cover-offers] notify failed:', err.message));
  }
  return offer;
}

/** The manager puts a price on a slot — or takes it off. Host branch only. */
async function setBonus({ user, body }) {
  const b = body || {};
  if (!mongoose.isValidObjectId(b.branch_id)) throw new ShiftError(400, 'סניף לא תקין');
  assertEdit(user, b.branch_id);
  if (!['am', 'pm'].includes(b.window)) throw new ShiftError(400, 'משמרת לא תקינה');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) throw new ShiftError(400, 'תאריך לא תקין');
  if (!mongoose.isValidObjectId(b.classroom_id)) throw new ShiftError(400, 'כיתה לא תקינה');
  const amount = Math.round(Number(b.amount));
  if (!(amount >= 20 && amount <= 1000)) throw new ShiftError(400, 'סכום הבונוס: בין 20 ל-1,000 ₪');
  const weekStart = sundayOf(b.date);
  // Priced only while it is a real gap — a filled slot sells nothing.
  const gaps = await openGaps(b.branch_id, weekStart);
  const gap = gaps.find(g => g.date === b.date && g.window === b.window && g.classroom_id === String(b.classroom_id));
  if (!gap) throw new ShiftError(409, 'המשבצת כבר לא בחוסר');
  await ShiftCoverBonus.updateMany(
    { branch_id: b.branch_id, date: b.date, window: b.window, classroom_id: b.classroom_id, status: 'active' },
    { status: 'cancelled' },
  );
  return ShiftCoverBonus.create({
    ...gap, amount, created_by: user.id, created_by_name: user.full_name || '',
  });
}

async function cancelBonus({ user, id }) {
  if (!mongoose.isValidObjectId(id)) throw new ShiftError(404, 'בונוס לא נמצא');
  const bonus = await ShiftCoverBonus.findById(id);
  if (!bonus) throw new ShiftError(404, 'בונוס לא נמצא');
  assertEdit(user, bonus.branch_id);
  bonus.status = 'cancelled';
  await bonus.save();
  return bonus;
}

function activeBonuses(branchId, weekStart) {
  return ShiftCoverBonus.find({ branch_id: branchId, week_start: weekStart, status: 'active' }).lean();
}

module.exports = { openGaps, listForEmployee, createOffer, pendingFor, decideOffer, setBonus, cancelBonus, activeBonuses };
