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
  const parts = [TYPE_LABEL[c.type] || c.type, fmtDate(c.date)];
  if (c.type === 'partial') parts.push(`${c.from_hhmm}–${c.to_hhmm}`);
  if (c.target_date) parts.push(`במקום: ${fmtDate(c.target_date)}`);
  if (c.type === 'swap') parts.push(c.swap_mode === 'mutual' ? 'החלפה הדדית' : 'מסירת משמרת');
  return parts.join(' · ');
}

/** Attachments are behind auth, so they are fetched with the token and opened as a blob. */
export async function openConstraintFile(id, index) {
  const win = window.open('', '_blank');
  try {
    const res = await api.get(`/shifts/constraints/${id}/files/${index}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    if (win) win.location.href = url; else window.location.href = url;
  } catch {
    if (win) win.close();
    alert('לא הצלחנו לפתוח את הקובץ');
  }
}
