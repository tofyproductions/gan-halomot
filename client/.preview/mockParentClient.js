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


const swatch = (a, b) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/><circle cx="86" cy="84" r="32" fill="rgba(255,255,255,.5)"/><circle cx="160" cy="150" r="46" fill="rgba(255,255,255,.28)"/></svg>`
)}`;

const PHOTOS = [
  ['#E9A860', '#C4682C'], ['#8FBF9E', '#4A7C59'],
  ['#B9A7D6', '#6C63B5'], ['#F3C86A', '#DC8B3A'],
].map(([a, b], i) => ({ id: String(i + 1), url: swatch(a, b), thumb_url: swatch(a, b), taken_at: '2026-08-17' }));

const ME = {
  full_name: 'מיכל כהן לוי',
  children: [{ id: 'c1', name: 'יהלי' }, { id: 'c2', name: 'אורי' }],
};

const DETAILS = {
  id: 'c1',
  child: { name: 'יהלי כהן', id_number: '312345678', birth_date: '2025-02-11',
           classroom: 'פעוטות א׳', classroom_category: 'nursery', academic_year: '2026-2027' },
  contact: { parent_name: 'מיכל כהן לוי', phone: '054-448-7880', address: 'הרצל 14, כפר סבא',
             emergency_contact: 'דנה כהן', emergency_phone: '052-1112233' },
  health: { allergies: 'אגוזים', medical_alerts: '' },
  second_parent: 'יואב לוי',
  registration: { start_date: '2026-09-01', end_date: '2027-08-31' },
  is_nursery: true,
};

const GIFT = { campaign: null, selection: null, photos: PHOTOS };

const ANNOUNCEMENTS = [
  { id: 'a1', title: 'מחר הגן סגור — תקלת מים', is_urgent: true, for_my_class: false,
    published_at: new Date().toISOString(),
    body: 'התגלתה נזילה בצנרת הראשית והתיקון יימשך את כל היום.\nהגן ייפתח כרגיל ביום רביעי.' },
  { id: 'a2', title: 'טיול לחוות החי — יום חמישי', is_urgent: false, for_my_class: true,
    published_at: '2026-08-15T09:00:00+03:00',
    body: 'יוצאים ב-9:00 וחוזרים ב-13:00.\nלהביא: כובע, בקבוק מים, נעליים סגורות.\nמי שלא שלח אישור — נא לשלוח עד מחר.' },
  { id: 'a3', title: 'שינוי בשעות האיסוף בחודש אוגוסט', is_urgent: false, for_my_class: false,
    published_at: '2026-08-03T16:30:00+03:00',
    body: 'במהלך אוגוסט הגן נסגר ב-16:00 במקום ב-16:30.' },
];

const day = (off) => {
  const d = new Date(); d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
let ABSENCES = [{ id: 'x1', date: day(2), reason: 'ביקור רופא' }];
let PICKUP = [
  { id: 'p1', name: 'רותי כהן', phone: '0521112233', relation: 'סבתא', status: 'approved', reject_reason: '' },
  { id: 'p2', name: 'נועה ברק', phone: '0549998877', relation: 'שכנה', status: 'pending', reject_reason: '' },
  { id: 'p3', name: 'אבי לוי', phone: '', relation: 'דוד', status: 'rejected', reject_reason: 'לא הוצגה תעודה בגן' },
];

const parentApi = {
  get: async (url) => {
    if (url === '/me') return { data: ME };
    if (url.endsWith('/day')) return { data: DAY };
    if (url.endsWith('/payments')) return { data: PAYMENTS };
    if (url.endsWith('/announcements')) return { data: { announcements: ANNOUNCEMENTS } };
    if (url.endsWith('/absences')) return { data: { today: day(0), max_date: day(14), absences: ABSENCES } };
    if (url.endsWith('/pickup')) return { data: { people: PICKUP } };
    if (url.endsWith('/photos')) return { data: { mine: PHOTOS, classroom: [] } };
    if (url.endsWith('/contracts')) return { data: { contracts: [] } };
    if (url.endsWith('/gift')) return { data: GIFT };
    if (url === '/editable-fields') return { data: { editable: [] } };
    if (/\/children\/[^/]+$/.test(url)) return { data: DETAILS };
    return { data: {} };
  },
  post: async (url, payload) => {
    if (url.endsWith('/pickup')) {
      PICKUP = [{ id: 'n' + PICKUP.length, ...payload, status: 'pending', reject_reason: '' }, ...PICKUP];
      return { data: { people: PICKUP } };
    }
    if (url.endsWith('/absences')) {
      for (const d of payload.dates || []) {
        if (!ABSENCES.some(a => a.date === d)) ABSENCES.push({ id: d, date: d, reason: payload.reason || '' });
      }
      ABSENCES.sort((a, b) => a.date.localeCompare(b.date));
      return { data: { today: day(0), max_date: day(14), absences: ABSENCES } };
    }
    return { data: {} };
  },
  delete: async (url) => {
    if (url.includes('/pickup/')) {
      const id = url.split('/').pop();
      PICKUP = PICKUP.filter(p => p.id !== id);
      return { data: { people: PICKUP } };
    }
    const d = url.split('/').pop();
    ABSENCES = ABSENCES.filter(a => a.date !== d);
    return { data: { today: day(0), max_date: day(14), absences: ABSENCES } };
  },
  put: async () => ({ data: {} }),
  patch: async () => ({ data: {} }),
};

export const PARENT_TOKEN_KEY = 'gan_parent_token';
export const UPLOAD_TIMEOUT_MS = 180000;
export function parentApiError(_e, fallback = 'שגיאה') { return fallback; }
export async function openParentFile() {}
export default parentApi;
