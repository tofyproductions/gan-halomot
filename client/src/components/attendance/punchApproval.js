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
 * A correction parked on a punch that already counts. It waits for the
 * accountant while the punch keeps its own status, so the status alone cannot
 * tell you the row is still open.
 */
export function hasPendingEdit(p) {
  return Boolean(p && p.pending_edit && p.pending_edit.timestamp);
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
  if (hasPendingEdit(p)) return 'accountant';
  if (p.approval_status === 'pending_accountant') return 'accountant';
  if (p.approval_status === 'pending_manager' || p.approval_status === 'pending') return 'manager';
  return null;
}

export const STAGE_LABEL = {
  manager: 'ממתין לאישור מנהל/ת הסניף',
  accountant: 'ממתין לאישור הנהלת החשבונות',
};

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
