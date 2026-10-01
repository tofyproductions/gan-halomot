import { alpha } from '@mui/material/styles';
import { formatILS, formatDay } from '../bank/bankFormat';

export { formatILS, formatDay };

export const DOC_TYPE_LABEL = {
  tax_invoice: 'חשבונית מס',
  invoice_receipt: 'חשבונית מס/קבלה',
  receipt: 'קבלה',
  credit_note: 'חשבונית זיכוי',
  other: 'מסמך',
};

export const DOC_TYPES = Object.keys(DOC_TYPE_LABEL);

/** Lane names as the search results and pills read them. */
export const LANE_LABEL = {
  review: 'לבדיקה',
  open: 'לשייך',
  pair: 'לשייך',
  awaiting_fx: 'לשייך',
  receipt: 'קבלות',
  closed: 'סגור',
  unpaid_marked: 'סגור — עוד לא שולמה',
  no_invoice: 'לא צריך חשבונית',
};

/** Which tab a lane lives in (search rows jump there). */
export const LANE_TAB = {
  review: 'pair', open: 'pair', pair: 'pair', awaiting_fx: 'pair', no_invoice: 'pair', receipt: 'receipts', closed: 'closed', unpaid_marked: 'closed',
};

/** The branch filter value for "כללי" (no single branch). */
export const GENERAL = 'general';

/** Does a document pass the top branch filter? '' = all. */
export function matchesBranch(doc, filter) {
  if (!filter) return true;
  if (filter === GENERAL) return !!doc.is_general;
  return String(doc.branch_id || '') === String(filter);
}

export function branchLabel(doc, branches) {
  if (doc.is_general) return 'כללי';
  if (!doc.branch_id) return 'בלי סניף';
  return branches.find(b => String(b._id) === String(doc.branch_id))?.name || 'סניף';
}

/** The document's amount as it is shown: shekels, or the foreign figure while shekels are unknown. */
export function docAmountText(doc) {
  const cur = doc.currency || 'ILS';
  if (cur === 'ILS') return formatILS(doc.amount_ils ?? doc.amount_total);
  const original = doc.amount_original ?? doc.amount_total;
  const foreign = `${Number(original || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 })} ${cur}`;
  return doc.amount_ils != null ? `${foreign} · ${formatILS(doc.amount_ils)}` : foreign;
}

export const hasFile = (doc) => !!doc.file_id || (doc.mail_sorter_id != null);

export const txTitle = (tx) => (tx.counterparty ? `אל: ${tx.counterparty}` : tx.description || '—');

export function refLabel(ref) {
  const m = /^inst:(\d+)\/(\d+)$/.exec(ref || '');
  if (m) return `תשלום ${m[1]} מתוך ${m[2]}`;
  return ref ? `אסמכתא ${ref}` : '';
}

/**
 * Per-field verdict colour (server `fields`: ok / near / bad / none).
 * Theme palette only — the soft fill is the palette colour at low alpha.
 */
export function tintSx(verdict) {
  const key = { ok: 'success', near: 'warning', bad: 'error' }[verdict];
  if (!key) return {};
  return {
    bgcolor: (t) => alpha(t.palette[key].main, 0.14),
    color: `${key}.dark`,
    borderRadius: 1,
    px: 0.5,
  };
}

export const scoreColor = (score) => (score >= 85 ? 'success' : score >= 55 ? 'warning' : 'default');

/** Empty review form from a document (what the person may correct). */
export function reviewInit(doc) {
  const foreignUnknown = (doc.currency || 'ILS') !== 'ILS' && doc.amount_ils == null;
  return {
    vendor_name: doc.vendor_name || '',
    doc_number: doc.doc_number || '',
    supplier_tax_id: doc.supplier_tax_id || '',
    doc_date: doc.doc_date || '',
    amount_total: foreignUnknown ? '' : String(doc.amount_ils ?? doc.amount_total ?? ''),
    doc_type: doc.doc_type || 'tax_invoice',
  };
}

/** Only the fields the person changed; null when the amount typed is not a positive number. */
export function reviewPatchOf(doc, form) {
  if (!form) return {};
  const init = reviewInit(doc);
  const patch = {};
  for (const k of ['vendor_name', 'doc_number', 'supplier_tax_id', 'doc_date', 'doc_type']) {
    if (String(form[k] ?? '').trim() !== String(init[k] ?? '').trim()) patch[k] = String(form[k] ?? '').trim();
  }
  if (String(form.amount_total) !== String(init.amount_total) && String(form.amount_total).trim() !== '') {
    const n = Number(String(form.amount_total).replace(/[^\d.]/g, ''));
    if (!(n > 0)) return null;
    patch.amount_total = n;
  }
  return patch;
}
