/**
 * The salary-adjustment vocabulary, in one place.
 *
 * The per-row dialog in the salary table and the branch manager's own screen
 * both render these, and a label that says one thing in one screen and another
 * elsewhere is how two people end up describing the same row differently to
 * the accountant.
 *
 * גיפט קארד / מילואים / הבראה / סיבוס are deliberately absent: those are
 * columns on the salary table itself, filed through the change-request flow.
 */
export const ADJUSTMENT_TYPES = [
  { value: 'money_add',          label: 'תוספת כספית',           field: 'amount', positive: true  },
  { value: 'money_deduct',       label: 'ניכוי כספי',             field: 'amount', positive: false },
  { value: 'hours_add',          label: 'תוספת שעות',             field: 'hours',  positive: true  },
  { value: 'hours_deduct',       label: 'הורדת שעות',             field: 'hours',  positive: false },
  { value: 'hour_correction',    label: 'תיקון דיווח שעות',       field: 'hours',  positive: null  },
  { value: 'travel_add',         label: 'תוספת נסיעות',           field: 'amount', positive: true  },
  { value: 'purchase_reimburse', label: 'החזר קניות עבור הגן',    field: 'amount', positive: true  },
  { value: 'advance_request',    label: 'בקשת מקדמה',             field: 'amount', positive: false },
  { value: 'loan_request',       label: 'בקשת הלוואה',            field: 'amount', positive: false },
  { value: 'other',              label: 'אחר',                    field: 'amount', positive: null  },
];

export const TYPE_LABEL = Object.fromEntries(ADJUSTMENT_TYPES.map(t => [t.value, t.label]));

export function typeColor(t) {
  switch (t) {
    case 'money_add': case 'travel_add': case 'purchase_reimburse': case 'hours_add': return 'success';
    case 'money_deduct': case 'hours_deduct': case 'advance_request': case 'loan_request': return 'error';
    case 'hour_correction': return 'warning';
    default: return 'default';
  }
}

export const STATUS_META = {
  pending:  { label: 'ממתין לאישור הנה״ח', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

/** Only an accountant or admin decides what reaches a salary. */
export function canDecidePayroll(user) {
  return user?.role === 'system_admin' || user?.role === 'accountant';
}

/** The signed value of an adjustment, as text. */
export function adjustmentValue(adj) {
  if (adj.amount) return `${adj.amount > 0 ? '+' : ''}${Number(adj.amount).toLocaleString('he-IL')} ₪`;
  if (adj.hours) return `${adj.hours > 0 ? '+' : ''}${adj.hours}h`;
  return '—';
}
