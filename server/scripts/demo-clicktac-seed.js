/**
 * רישום חיצוני — a demo cohort for one branch, built by the real importers.
 *
 * WHY THE IMPORTERS AND NOT ExternalEnrollment.create(). The reconcile screen
 * reads a dozen fields no hand-written document has right: `sources` (which of
 * the two ClickTac exports this row has been in — the whole "חסר פרטי הורים"
 * story), `computed.age_group` and `computed.payment_alert`, `content_hash`,
 * the merge that happens when the registrations file lands on a row the
 * contracts file created. A seed that types those in by hand tests the typing,
 * not the screen: it would go green on a demo and be wrong about production.
 * So this builds the two real xlsx exports out of the same builders the parser
 * test uses (scripts/lib/clicktac-fixtures.js) and pushes them through
 * externalEnrollment.controller#importFile — the actual upload path, minus
 * express.
 *
 * WHAT IT COVERS. Every payment kind the colour column can paint, including
 * the two that are easy to get wrong: a הו"ק WITH bank details (green, no
 * alert) against one WITHOUT (green chip, red "ללא פרטי בנק"), and "לא רלוונטי"
 * which reads as לא הוגדר rather than as a method somebody chose. Plus two
 * contracts-only rows (class and דרגה, no parents, no payment column at all),
 * merged rows that have both halves, and one child whose file age group
 * disagrees with the birth date.
 *
 * THE MINISTRY SIDE IS WRITTEN DIRECTLY, and that is a deliberate difference:
 * the תמ"ת file is the ministry's own portal export and there is no builder for
 * it, while what the screen needs from it is four fields. Without any of it
 * every row would read "אין אישור תמ"ת" and the מסקנה column — the first thing
 * anybody looks at — would be one colour.
 *
 * Nothing here is production data. Every name is invented and every ת"ז is in
 * a 249xxxxxx block that no real child has.
 */

const {
  sheetBuffer, CONTRACTS_HEADER, REGISTRATIONS_HEADER, contractRow, registrationRow,
} = require('./lib/clicktac-fixtures');

/**
 * The state's own price table (PricingManager's TMT_5786), verbatim.
 *
 * The labels matter more than the numbers: "דרגה 3 (0–2,330)" is what the
 * pricing editor actually saves, income bracket and all, and matching a
 * contract's דרגה against it is the thing that was silently a no-op until
 * tier-fee.service started reading the FIRST run of digits. A demo seeded with
 * tidy "דרגה 3" labels would never catch that again.
 */
const TMT_TIERS = [
  { label: 'דרגה 3 (0–2,330)', prices: [1157, 938, 941] },
  { label: 'דרגה 4 (2,331–2,880)', prices: [1401, 1109, 1113] },
  { label: 'דרגה 5 (2,881–3,330)', prices: [1663, 1318, 1323] },
  { label: 'דרגה 6 (3,331–3,880)', prices: [1748, 1377, 1382] },
  { label: 'דרגה 7 (3,881–4,440)', prices: [2011, 1549, 1554] },
  { label: 'דרגה 8 (4,441–4,880)', prices: [2180, 1703, 1709] },
  { label: 'דרגה 9 (4,881–5,440)', prices: [2328, 1811, 1817] },
  { label: 'דרגה 10 (5,441–5,880)', prices: [2432, 1908, 1914] },
  { label: 'דרגה 11 (5,881–6,660)', prices: [3936, 2917, 2587] },
  { label: 'דרגה 12 (מעל 6,660)', prices: [3936, 2917, 2587] },
  { label: 'דרגה 14', prices: [1054, 835, 837] },
  { label: 'דרגה 15', prices: [952, 731, 734] },
];

const AGE_GROUPS = ['תינוק', 'פעוט', 'בוגר'];

/**
 * The cohort. `so` present means the הו"ק columns are filled in.
 *
 * `only` says which export the child is in: 'both' is the ordinary case (a
 * contract AND a family), 'registrations' is the summer state before the
 * contracts file arrives, 'contracts' is the row with a דרגה and nobody to
 * phone. Birth dates are spread across the two boundaries (15 and 24 months at
 * 1 September) so all three age groups appear.
 *
 * PINNED AGAINST 1.9.2026. `academicYear` (viewer-demo-server.js) is
 * `enrollmentYear()` — today's calendar year, not a constant — so the "gan
 * year starts 1 September" arithmetic in computedFor() moves with the clock.
 * Every `ageGroup` below was chosen so the file's own age group matches what
 * the birth date computes to AGAINST 1.9.2026 specifically (this file was
 * written in 2026, i.e. the demo runs against academic year 2026-2027). Only
 * `age_disagreement` is deliberately wrong; every other row must stay
 * boundary-consistent or it starts throwing an unintended age mismatch of its
 * own, on top of whatever it was actually seeded to demonstrate. Re-check the
 * months-at-1.9.2026 math (ageInMonths/ageGroupFor in clicktac.service.js) if
 * this ever needs to keep working past 2027.
 */
const COHORT = [
  {
    key: 'so_ok', first: 'מאיה', last: 'ברקוביץ', idNumber: '249000011',
    birth: [2024, 6, 12], only: 'both', cls: 'בוגרים א', tier: 4, ageGroup: 'בוגר',
    method: 'הוראת קבע', so: { bank: '12', branch: '345', account: '11223344', holder: 'רוני ברקוביץ' },
    regFeeMethod: 'כרטיס אשראי', regFeeCard: '4242', receipt: 'RC-10011', amount: 350,
    tmt: 'approved',
  },
  {
    key: 'so_missing', first: 'איתמר', last: 'שגב', idNumber: '249000029',
    birth: [2024, 8, 3], only: 'both', cls: 'בוגרים א', tier: 7, ageGroup: 'בוגר',
    // A method the gan wants and the bank details never arrived — an alert,
    // and the one alert that is NOT the family's fault.
    method: 'הו"ק', regFeeMethod: 'העברה בנקאית', receipt: 'RC-10012', amount: 350,
    tmt: 'approved',
  },
  {
    key: 'credit', first: 'יהלי', last: 'אמסלם', idNumber: '249000037',
    birth: [2025, 1, 22], only: 'both', cls: 'פעוטות ב', tier: 3, ageGroup: 'פעוט',
    method: 'כרטיס אשראי', tuitionCard: '1234',
    regFeeMethod: 'כרטיס אשראי', regFeeCard: '1234', receipt: 'RC-10013', amount: 350,
    secondSigner: 'נחתם', parent2First: 'עומר', parent2Phone: '0521110001',
    tmt: 'approved',
  },
  {
    key: 'transfer', first: 'נעם', last: 'דואק', idNumber: '249000045',
    birth: [2025, 2, 9], only: 'registrations', ageGroup: 'פעוט',
    method: 'העברה בנקאית', receipt: 'RC-10014', regFeeMethod: 'העברה בנקאית', amount: 350,
    voucher: 'SH-7781', tmt: 'approved',
  },
  {
    key: 'cheque', first: 'תמר', last: 'חלבי', idNumber: '249000052',
    birth: [2025, 3, 30], only: 'both', cls: 'פעוטות א', tier: 9, ageGroup: 'פעוט',
    // Accepted, and the gan would rather not — a warning, never in the
    // "לטיפול" number.
    method: "צ'ק", regFeeMethod: "צ'ק", receipt: 'RC-10015', amount: 350,
    tmt: 'approved',
  },
  {
    key: 'cash', first: 'אליה', last: 'בן חמו', idNumber: '249000060',
    birth: [2025, 5, 17], only: 'registrations', ageGroup: 'פעוט',
    method: 'מזומן', regFeeMethod: 'מזומן', amount: 350,
    tmt: 'approved',
  },
  {
    key: 'none', first: 'שקד', last: 'טולדנו', idNumber: '249000078',
    birth: [2025, 6, 25], only: 'registrations', ageGroup: 'תינוק',
    // No method at all — the family that has to be phoned first.
    method: '', secondSigner: 'ממתין לחתימה',
    tmt: 'approved',
  },
  {
    key: 'not_applicable', first: 'ליאם', last: 'פרץ', idNumber: '249000086',
    birth: [2025, 4, 8], only: 'both', cls: 'תינוקות א', tier: 14, ageGroup: 'פעוט',
    // The vendor's dropdown for "somebody else pays". Reads as לא הוגדר, and
    // that is the point of seeding it.
    method: 'לא רלוונטי',
    tmt: 'approved',
  },
  {
    key: 'contract_only_a', first: 'רוני', last: 'אשכנזי', idNumber: '249000094',
    birth: [2024, 9, 14], only: 'contracts', cls: 'בוגרים ב', tier: 5, ageGroup: 'פעוט',
    tmt: 'approved',
  },
  {
    key: 'contract_only_b', first: 'עדן', last: 'סבן', idNumber: '249000102',
    birth: [2025, 2, 27], only: 'contracts', cls: 'פעוטות ב', tier: 11, ageGroup: 'פעוט',
    tmt: null,   // registered nowhere the ministry knows about
  },
  {
    key: 'age_disagreement', first: 'אורי', last: 'מלכה', idNumber: '249000110',
    birth: [2024, 7, 6], only: 'both', cls: 'פעוטות א', tier: 6,
    // Born in July 2024 — 25 months at 1.9.2026, so בוגר by the boundaries —
    // and both files say פעוט. That disagreement is the finding.
    ageGroup: 'פעוט',
    method: 'הוראת קבע', so: { bank: '20', branch: '512', account: '55667788', holder: 'שי מלכה' },
    tmt: 'approved',
  },
  {
    key: 'cancelled', first: 'יובל', last: 'זילברמן', idNumber: '249000128',
    birth: [2025, 1, 5], only: 'registrations', ageGroup: 'פעוט',
    status: 'ביטל רישום', method: 'כרטיס אשראי', tuitionCard: '9911',
    // Approved by the state and walked away — the one anomaly that is an
    // opportunity, and the row that puts a number on "מקומות התפנו".
    tmt: 'approved',
  },
];

/** A fake express req/res pair, so the controller can be called without a server. */
function fakeUpload({ buffer, fileName, branchId, academicYear, user }) {
  return new Promise((resolve, reject) => {
    const req = {
      file: { buffer, originalname: fileName },
      body: { branch_id: String(branchId), academic_year: academicYear },
      user,
      method: 'POST',
      // The controller stamps the importer on EnrollmentImport; a demo with a
      // blank "מי העלה" column reads as a bug in the history dialog.
      get: () => '',
    };
    let code = 200;
    const res = {
      status(c) { code = c; return this; },
      json(payload) {
        if (code >= 400) reject(new Error(`${fileName}: ${code} ${JSON.stringify(payload)}`));
        else resolve(payload);
        return this;
      },
    };
    Promise.resolve(require('../src/controllers/externalEnrollment.controller')
      .importFile(req, res, reject)).catch(reject);
  });
}

/**
 * Seed one branch's רישום חיצוני cohort.
 *
 * `branch` and `user` are already-created documents; `academicYear` is the
 * intake year as the client asks for it (getEnrollmentYear() — "2026-2027").
 * Returns the counts to print at boot.
 */
async function seedClickTacDemo({ branch, user, academicYear }) {
  const { BranchPricing, TmtApproval } = require('../src/models');
  const branchId = branch._id;

  // The matrix, so `fee_by_tier` is a number on screen and not a blank.
  await BranchPricing.findOneAndUpdate(
    { branch_id: branchId, academic_year: academicYear },
    {
      $set: {
        branch_id: branchId,
        academic_year: academicYear,
        pricing_type: 'subsidized',
        age_groups: [...AGE_GROUPS],
        tiers: TMT_TIERS.map(t => ({ label: t.label, prices: [...t.prices] })),
        installments: 11,
        one_time: { insurance: 180, registration: 350 },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ---- ייצוא החוזים ----
  const contractRows = COHORT
    .filter(k => k.only !== 'registrations')
    .map((k, i) => contractRow({
      id: `55${String(i + 1).padStart(4, '0')}`,
      first: k.first, last: k.last, idNumber: k.idNumber, birth: k.birth,
      cls: k.cls, tier: k.tier, ageGroup: k.ageGroup, year: academicYear,
      institution: branch.name,
    }));

  // ---- ייצוא הנרשמים ----
  const registrationRows = COHORT
    .filter(k => k.only !== 'contracts')
    .map((k, i) => registrationRow({
      first: k.first, last: k.last, idNumber: k.idNumber, birth: k.birth,
      parentFirst: `הורה ${i + 1}`, parentPhone: `05${String(20000000 + i).slice(0, 8)}`,
      method: k.method ?? '', ageGroup: k.ageGroup, status: k.status || 'התקבל',
      year: academicYear, institution: branch.name,
      parent2First: k.parent2First || '', parent2Phone: k.parent2Phone || '',
      secondSigner: k.secondSigner || '', tuitionCard: k.tuitionCard || '',
      regFeeMethod: k.regFeeMethod || '', regFeeCard: k.regFeeCard || '',
      receipt: k.receipt || '', voucher: k.voucher || '', amount: k.amount || '',
      soBank: k.so?.bank || '', soBranch: k.so?.branch || '',
      soAccount: k.so?.account || '', soHolder: k.so?.holder || '',
      address: 'דיזנגוף 100, תל אביב',
    }));

  // CONTRACTS FIRST, ON PURPOSE. That is the order the office does it in most
  // years, and it is the order that exercises the merge: the registrations
  // file then lands on rows the contracts file created, which is the path that
  // fills `sources` with both and unlocks promotion.
  const contracts = await fakeUpload({
    buffer: sheetBuffer(CONTRACTS_HEADER, contractRows, 'Worksheet 1'),
    fileName: 'contracts_export_demo.xlsx',
    branchId, academicYear, user,
  });
  const registrations = await fakeUpload({
    buffer: sheetBuffer(REGISTRATIONS_HEADER, registrationRows, 'Sheet1'),
    fileName: 'Registrations Export demo.xlsx',
    branchId, academicYear, user,
  });

  // ---- רשימת האישורים של משרד התמ"ת ----
  const tmtDocs = COHORT.filter(k => k.tmt).map((k, i) => ({
    branch_id: branchId,
    academic_year: academicYear,
    source: 'tmt',
    source_file: 'tmt_demo.xlsx',
    imported_by: user.id,
    child: {
      first_name: k.first,
      last_name: k.last,
      full_name: `${k.first} ${k.last}`,
      id_number: k.idNumber,
      birth_date: new Date(Date.UTC(k.birth[0], k.birth[1] - 1, k.birth[2])),
      age_group: k.ageGroup,
      source_age_group: k.ageGroup,
    },
    contact: {
      name: `הורה ${i + 1}`,
      phone: `05${String(20000000 + i).slice(0, 8)}`,
      email: 'a@b.co.il',
    },
    ministry: {
      decision: 'נקלט במעון',
      is_approved: true,
      // Two children still waiting for an entry date in the portal, so the
      // "להזין תאריך כניסה" card is not a zero.
      absorbed_at: i % 5 === 0 ? null : new Date(Date.UTC(2026, 7, 20)),
      continuing: false,
      welfare: false,
    },
    content_hash: `demo-${k.idNumber}`,
  }));
  await TmtApproval.insertMany(tmtDocs);

  return {
    contracts: contracts.parsed ?? contractRows.length,
    registrations: registrations.parsed ?? registrationRows.length,
    tmt: tmtDocs.length,
    cohort: COHORT.length,
  };
}

module.exports = { seedClickTacDemo, COHORT, TMT_TIERS };
