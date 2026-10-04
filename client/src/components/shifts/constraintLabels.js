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
