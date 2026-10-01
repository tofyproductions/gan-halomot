/** Money as the office reads it: grouped digits, ₪ after the number, minus for money out. */
export const formatILS = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}${s} ₪`;
};

/** 2026-09-05 → 05.09.26 */
export const formatDay = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${y.slice(2)}`;
};

export const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const monthLabel = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
};
