/* Stand-in for api/parentClient. Aliased in by .preview/vite.config.js so
   the REAL components run against fixed data instead of the live database. */
const DAY = {
  date: '2026-08-17', is_today: true,
  log: {
    attendance: 'הגיע',
    meals: { breakfast: { amount: 'הכל' }, lunch: { amount: 'חצי מנה' }, snack: { amount: '' } },
    sleep: { morning: { start: '09:20', end: '09:55' }, noon: { start: '12:40', end: '13:45' } },
    diapers: '3',
    missing: ['חיתולים'],
    staff_note: 'יום מצוין, שיחקה הרבה בחצר.',
    updated_at: '2026-08-17T13:20:00+03:00',
  },
  menu: [],
};

const MONTHS = [
  [9, 'ספטמבר', 2400, 'paid', '5001'], [10, 'אוקטובר', 2400, 'paid', '5002'],
  [11, 'נובמבר', 2400, 'paid', '5003'], [12, 'דצמבר', 2400, 'paid', '-5210'],
  [1, 'ינואר', 2400, 'paid', '5104'], [2, 'פברואר', 2160, 'paid', '5105'],
  [3, 'מרץ', 2400, 'paid', '5106'], [4, 'אפריל', 2400, 'overdue', null],
  [5, 'מאי', 2400, 'expected', null], [6, 'יוני', 2400, 'expected', null],
  [7, 'יולי', 2400, 'expected', null], [8, 'אוגוסט', 2400, 'expected', null],
].map(([month, label, expected, status, receipt]) => ({
  month, label, expected, paid: status === 'paid' ? expected : 0,
  discount: month === 2 ? 240 : 0, status,
  paid_at: status === 'paid' ? '2026-09-05' : null,
  is_prorated: false, is_before_start: false, is_current: month === 8,
  receipt: receipt ? receipt.replace('-', '') : null,
  shared_with_sibling: !!receipt && receipt.startsWith('-'),
}));

const PAYMENTS = {
  available: true,
  academic_year: '2026-2027', year_label: '2026-2027 תשפ״ז', year_short: 'תשפ״ז',
  current_month: 8,
  summary: { expected: 30360, paid: 16560, remaining: 13800, months_paid: 7, months_billable: 13 },
  months: MONTHS,
  camp: {
    month: 13, label: 'קייטנת אוגוסט', expected: 1500, paid: 0, discount: 0,
    status: 'expected', paid_at: null, enrolled: true,
    is_prorated: false, is_before_start: false, is_current: false,
    receipt: null, shared_with_sibling: false,
  },
  registration_fee: { amount: 500, receipt: '4400', shared_with_sibling: true },
  has_shared_receipts: true,
};

const parentApi = {
  get: async (url) => {
    if (url.endsWith('/day')) return { data: DAY };
    if (url.endsWith('/payments')) return { data: PAYMENTS };
    return { data: {} };
  },
  patch: async () => ({ data: {} }),
};

export const PARENT_TOKEN_KEY = 'gan_parent_token';
export const UPLOAD_TIMEOUT_MS = 180000;
export function parentApiError(_e, fallback = 'שגיאה') { return fallback; }
export async function openParentFile() {}
export default parentApi;
