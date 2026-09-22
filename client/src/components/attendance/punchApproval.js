/**
 * What a decision on a pending punch actually did — read from the server's
 * answer, not assumed from the click.
 *
 * Approving a manual punch is TWO decisions, not one. An employee's own report
 * starts at `pending_manager`; the branch manager's approval moves it to
 * `pending_accountant`, and only the accountant's approval makes it 'approved'
 * and therefore paid. The banner used to delete the row the moment the PATCH
 * resolved, whatever the PATCH said. For anyone holding both authorities — an
 * accountant, an admin — one click said "אושר", took the row off the screen,
 * and left the punch waiting at a stage that was now unreachable without
 * reloading the page. The hours were not in the salary and nothing on screen
 * said so.
 *
 * So the row's fate is decided HERE, from the punch the server sends back: it
 * leaves the list when it stops being pending, and not before. Kept as plain
 * functions with no React in them so the two-stage rule can be tested directly
 * (`server/scripts/punch-approval-stage.test.js`).
 */

/** Statuses that mean "not in the salary yet". Mirrors models/Punch.js. */
export const PENDING_STATUSES = ['pending', 'pending_manager', 'pending_accountant'];

/**
 * A correction parked on a punch that already counts. It normally waits for
 * the accountant while the punch keeps its own status, so the status alone
 * cannot tell you the row is still open — EXCEPT the one case a HOST
 * manager's correction on a GUEST employee produces (`cross_branch: true`):
 * that one is deliberately given a real status, `pending_manager`, because it
 * has to wait for a SPECIFIC manager (the employee's own) before Accounting
 * ever sees it. `isCrossBranchAwaitingManager` is that one case, checked
 * before the generic rule below assumes every pending_edit means "stage 2".
 */
export function hasPendingEdit(p) {
  return Boolean(p && p.pending_edit && p.pending_edit.timestamp);
}

export function isCrossBranchAwaitingManager(p) {
  return Boolean(hasPendingEdit(p) && p.pending_edit.cross_branch && !p.pending_edit.manager_approved);
}

export function isPending(p) {
  if (!p) return false;
  if (hasPendingEdit(p)) return true;
  return PENDING_STATUSES.includes(p.approval_status);
}

/**
 * Which desk the row is sitting on. 'pending' is the legacy single-stage value
 * and is treated as stage 1, exactly as the server treats it.
 */
export function stageOf(p) {
  if (!p) return null;
  if (isCrossBranchAwaitingManager(p)) return 'manager';
  if (hasPendingEdit(p)) return 'accountant';
  if (p.approval_status === 'pending_accountant') return 'accountant';
  if (p.approval_status === 'pending_manager' || p.approval_status === 'pending') return 'manager';
  return null;
}

export const STAGE_LABEL = {
  manager: 'ממתין לאישור מנהל/ת הסניף',
  accountant: 'ממתין לאישור הנהלת החשבונות',
};

/** The manager-stage label, specialized for the one case where it means a
 * SPECIFIC manager rather than "whoever runs this branch". */
export function stageLabelFor(p) {
  const stage = stageOf(p);
  if (stage === 'manager' && isCrossBranchAwaitingManager(p)) {
    return 'ממתין לאישור מנהל/ת הבית של העובד/ת';
  }
  return STAGE_LABEL[stage] || '';
}

export const STAGE_ORDER = ['manager', 'accountant'];

/**
 * Merge the server's punch back into the on-screen list, and drop the row only
 * if the punch stopped being pending.
 *
 * `updated` missing means the answer told us nothing — the list is returned
 * untouched and the caller reloads rather than guessing.
 */
export function applyDecision(list, id, updated) {
  const rows = Array.isArray(list) ? list : [];
  if (!updated) return rows;
  const key = String(id);
  return rows
    .map((row) => {
      if (String(row._id) !== key) return row;
      return {
        ...row,
        ...updated,
        // The PATCH answers with a raw punch: employee_id and created_by come
        // back as ids, not the populated documents this list was drawn from.
        // Letting them through blanks the name and loses the source chip.
        employee_id: row.employee_id,
        created_by: row.created_by,
        // A decision CLEARS the parked correction, and a spread cannot say
        // "this key is gone" — without stating it, a decided correction keeps
        // the old parked timestamp and the row never leaves stage 2.
        pending_edit: updated.pending_edit || null,
      };
    })
    .filter(isPending);
}

/** What to tell the user after an approval — the truth about where it now is. */
export function approvalMessage(updated) {
  const stage = stageOf(updated);
  if (stage === 'accountant') return 'אושר — ממתין כעת לאישור הנהלת החשבונות';
  if (stage === 'manager') return 'אושר — ממתין לאישור מנהל/ת הסניף';
  return 'אושר — נכנס לשכר';
}

/** Refusing a parked correction restores the original punch; it is not a rejection of the day. */
export function rejectionMessage(updated) {
  if (updated && updated.approval_status && updated.approval_status !== 'rejected') {
    return 'הבקשה נדחתה — ההחתמה המקורית נשארה כפי שהייתה';
  }
  return 'נדחה';
}

export const ROLE_LABEL = {
  system_admin: 'מנהל/ת מערכת',
  accountant: 'הנהלת חשבונות',
  branch_manager: 'מנהל/ת סניף',
  class_leader: 'גננת',
  teacher: 'גננת',
  assistant: 'סייעת',
  cook: 'טבח/ית',
};

const idOf = (v) => {
  if (!v) return '';
  if (typeof v === 'object') return v._id ? String(v._id) : '';
  return String(v);
};

/**
 * Who entered this manual punch: the employee reporting her own day, or
 * somebody above her.
 *
 * The screen used to state "עודכן ידנית ע״י הנה״ח" for every manual row, which
 * is a sentence about a person and was false whenever a branch manager or the
 * employee herself was the one who typed it. Punches written before the field
 * existed carry no creator, and those say so rather than being attributed to
 * whoever is most likely.
 */
export function manualSource(punch, employee) {
  const creator = punch && punch.created_by;
  const creatorId = idOf(creator);
  if (!creatorId) return { key: 'unknown', name: '', role: '', label: 'לא ידוע' };

  const employeeUserId = idOf(employee && employee.user_id);
  if (employeeUserId && creatorId === employeeUserId) {
    return {
      key: 'self',
      name: (creator && creator.full_name) || '',
      role: (creator && creator.role) || '',
      label: 'דיווח עצמי',
    };
  }

  const name = (creator && creator.full_name) || '';
  const rawRole = (creator && creator.role) || '';
  const role = ROLE_LABEL[rawRole] || '';
  if (!name) return { key: 'other', name: '', role, label: role || 'לא ידוע' };
  return { key: 'other', name, role, label: role ? `${name} · ${role}` : name };
}

/**
 * The same sentence for the attendance grid, from the `manual_by` the server
 * attaches to a day (see payroll.controller.js summarizeDay).
 */
export function formatManualBy(manualBy) {
  if (!manualBy) return 'לא ידוע';
  if (manualBy.self) return manualBy.name ? `דיווח עצמי · ${manualBy.name}` : 'דיווח עצמי';
  const role = ROLE_LABEL[manualBy.role] || '';
  if (!manualBy.name) return role || 'לא ידוע';
  return role ? `${manualBy.name} · ${role}` : manualBy.name;
}

/* ------------------------------------------------------------------ *
 *  ההתחייבות מול הדיווח
 *
 *  A pending punch is a bare time, and "16:05" only means something next to
 *  what she was contracted to work that weekday. Reading it off the
 *  commitments screen meant leaving the approval queue, so the approval was
 *  made against nothing. These functions answer the question in place.
 *
 *  Kept here, with no React in them, for the same reason as everything above:
 *  the rules (Saturday, a day off, an alternating week, a schedule that was
 *  never filled in) are all cases where the honest answer is "no target", and
 *  a screen that quietly showed 00:00 for any of them would be worse than one
 *  that shows nothing.
 * ------------------------------------------------------------------ */

/** 'YYYY-MM-DD' → 0=Sunday … 6=Saturday, read at noon so no timezone can shift the day. */
export function weekdayOfISO(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

/** 'HH:MM' → minutes since midnight, or null. */
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * What the contract says about ONE date.
 *
 * kind:
 *   'no_commitment' — nobody ever filled in a weekly schedule for her
 *   'weekend'       — Saturday; there is no committed schedule to compare to
 *   'alternating'   — her חופש לסרוגין day. Which weeks she works it is not
 *                     recorded, so neither presence nor absence is a gap.
 *   'off'           — a declared day off
 *   'unset'         — a working day whose hours were never entered
 *   'window'        — start_hhmm..end_hhmm, plus `hours`
 */
export function commitmentForDate(commitment, isoDate) {
  const weekday = weekdayOfISO(isoDate);
  if (weekday === 6) return { kind: 'weekend', weekday };
  if (!commitment) return { kind: 'no_commitment', weekday };
  if (commitment.is_alternating_off && commitment.alternating_day === weekday) {
    return { kind: 'alternating', weekday };
  }
  const day = (commitment.days || []).find(d => d.day === weekday);
  if (!day || day.is_off) return { kind: 'off', weekday };
  const start = hhmmToMinutes(day.start_hhmm);
  const end = hhmmToMinutes(day.end_hhmm);
  if (start == null || end == null) return { kind: 'unset', weekday };
  return {
    kind: 'window',
    weekday,
    start_hhmm: day.start_hhmm,
    end_hhmm: day.end_hhmm,
    hours: (end - start) / 60,
  };
}

/**
 * How far a single reported punch sits from the edge it is claiming.
 *
 * A כניסה (state 0) is measured against the committed start and a יציאה
 * (state 1) against the committed end, in minutes, signed: positive is LATER
 * than committed. Null whenever there is no edge to measure against — see
 * `commitmentForDate` for the four ways that happens.
 */
export function punchDelta(window, punch) {
  if (!window || window.kind !== 'window' || !punch) return null;
  const t = new Date(punch.timestamp);
  if (Number.isNaN(t.getTime())) return null;
  const actual = t.getHours() * 60 + t.getMinutes();
  const target = hhmmToMinutes(punch.state === 0 ? window.start_hhmm : window.end_hhmm);
  if (target == null) return null;
  return { minutes: actual - target, edge: punch.state === 0 ? 'start' : 'end' };
}

/** "+12 דק׳ / −40 דק׳ / בדיוק", for a chip that has room for three words. */
export function formatDelta(delta) {
  if (!delta) return '';
  const m = delta.minutes;
  if (m === 0) return 'בדיוק';
  const sign = m > 0 ? '+' : '−';
  const abs = Math.abs(m);
  if (abs < 60) return `${sign}${abs} דק׳`;
  const h = Math.floor(abs / 60);
  const rem = abs % 60;
  return rem ? `${sign}${h}:${String(rem).padStart(2, '0')} ש׳` : `${sign}${h} ש׳`;
}

/**
 * Is this worth the manager's eye?
 *
 * A punch inside a quarter-hour of its committed edge is the ordinary noise of
 * a workday and colouring it makes the colour meaningless. Past that it is
 * marked — amber at a quarter of an hour, red at an hour — so a genuinely
 * short or long day is visible without reading the numbers.
 */
export function deltaSeverity(delta) {
  if (!delta) return 'none';
  const abs = Math.abs(delta.minutes);
  if (abs < 15) return 'none';
  if (abs < 60) return 'warn';
  return 'alert';
}

export const COMMITMENT_NOTE = {
  no_commitment: 'לא הוגדרה התחייבות שבועית',
  weekend: 'שבת — אין התחייבות',
  alternating: 'יום לסרוגין — לא ידוע אם השבוע עבדה',
  off: 'יום חופש לפי ההתחייבות',
  unset: 'יום עבודה בלי שעות מוגדרות',
};
