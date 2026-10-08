import { toast } from 'react-toastify';
import api from '../../api/client';
import { fmtDate } from './shiftRows';

export const TYPE_LABEL = {
  day_off: 'בקשת יום חופש', partial: 'היעדרות זמנית', sick_expected: 'יום מחלה צפוי',
  other: 'אחר', move_day: 'העברת יום עבודה', swap: 'החלפה עם עובדת',
};
export const STATUS_LABEL = {
  pending_colleague: 'ממתין לעובדת השנייה', pending_broadcast: 'ממתין לאישור שליחה', broadcast: 'נשלח לכל הסניף',
  open: 'ממתין למנהלת', accepted: 'התקבל', rejected: 'לא התקבל', declined: 'העובדת סירבה', cancelled: 'בוטל',
};
export const STATUS_COLOR = {
  pending_colleague: 'warning', pending_broadcast: 'warning', broadcast: 'info', open: 'warning',
  accepted: 'success', rejected: 'error', declined: 'default', cancelled: 'default',
};

export function describe(c) {
  const parts = [TYPE_LABEL[c.type] || c.type, `⁦${fmtDate(c.date)}⁩`];
  if (c.type === 'partial') parts.push(`⁦${c.from_hhmm}–${c.to_hhmm}⁩`);
  if (c.target_date) parts.push(`במקום: ⁦${fmtDate(c.target_date)}⁩`);
  if (c.type === 'swap') parts.push(c.swap_mode === 'mutual' ? 'החלפה הדדית' : 'מסירת משמרת');
  return parts.join(' · ');
}

// ── Does the board actually honor a constraint? ────────────────────────────
// Mirrors the server's constraintRules (respected / blocksEntry): one answer
// for the green "בוצע" chip and for which entries deserve the red outline.
const mins = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const overlaps = (s1, e1, s2, e2) => s1 !== null && e1 !== null && s2 !== null && e2 !== null && s1 < e2 && s2 < e1;
const on = (entries, empId, date) => (entries || []).filter(e => String(e.employee_id) === String(empId) && e.date === date);

/** Does THIS entry stand in the constraint's way? (a morning shift does not conflict with a 14:00–16:00 window) */
export function conflictsEntry(c, entry) {
  if (String(c.employee_id) !== String(entry.employee_id) || c.date !== entry.date) return false;
  if (c.type === 'partial') return overlaps(mins(entry.start_hhmm), mins(entry.end_hhmm), mins(c.from_hhmm), mins(c.to_hhmm));
  return ['day_off', 'sick_expected', 'move_day', 'swap'].includes(c.type);
}

/** Is an ACCEPTED constraint fully honored by the board as it stands now? null = not checkable ('other'). */
export function isDone(c, entries) {
  const me = String(c.employee_id);
  switch (c.type) {
    case 'day_off':
    case 'sick_expected':
      return on(entries, me, c.date).length === 0;
    case 'partial': {
      const s = mins(c.from_hhmm); const t = mins(c.to_hhmm);
      return !on(entries, me, c.date).some(e => overlaps(mins(e.start_hhmm), mins(e.end_hhmm), s, t));
    }
    case 'move_day':
      return on(entries, me, c.date).length === 0 && on(entries, me, c.target_date).length > 0;
    case 'swap': {
      if (!c.colleague_id) return false;
      const handover = on(entries, me, c.date).length === 0 && on(entries, c.colleague_id, c.date).length > 0;
      if (c.swap_mode !== 'mutual') return handover;
      return handover && on(entries, me, c.target_date).length > 0 && on(entries, c.colleague_id, c.target_date).length === 0;
    }
    default:
      return null;
  }
}

/** Attachments are behind auth, so they are fetched with the token and opened as a blob. */
export async function openConstraintFile(id, index, name) {
  const win = window.open('', '_blank'); // opened synchronously so the popup is allowed
  let url;
  try {
    const res = await api.get(`/shifts/constraints/${id}/files/${index}`, { responseType: 'blob' });
    url = URL.createObjectURL(res.data);
  } catch {
    if (win) win.close();
    toast.error('לא הצלחנו לפתוח את הקובץ');
    return;
  }
  if (win) {
    win.location.href = url;
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file';
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
