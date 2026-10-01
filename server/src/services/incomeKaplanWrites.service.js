/**
 * Kaplan income writes — every one is a person's click, none is called from a
 * scan or a job. Spec §1 (2026-10-01-income-design).
 *
 * The only collections written here are IncomeAllocation, IncomeRejection and
 * IncomePayerAlias. Collection / Registration are never touched: the sheet
 * sync and the office's receipts own them (spec "הכרעה מרכזית").
 *
 * Writes to one transfer serialise on the lock `itx:<transactionId>` (the same
 * in-process mutex the expense writes use). Errors are `Error` with a Hebrew
 * message and `status`.
 */
const mongoose = require('mongoose');
const {
  BankAccount, BankTransaction, IncomeAllocation, IncomeRejection, IncomePayerAlias,
} = require('../models');
const { withLocks, atomically } = require('./expenseWrites.service');
const { COVERAGE_TOLERANCE_ILS } = require('./expenseCore.service');
const { ACADEMIC_MONTHS, CAMP_MONTH } = require('./academic-year.service');
const K = require('./incomeKaplan.service');

const TOLERANCE_ILS = 2;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
const oid = (v, what) => {
  if (!mongoose.isValidObjectId(v)) throw fail(400, `${what} לא תקין`);
  return String(v);
};
const lockKey = (txId) => `itx:${txId}`;

/** An incoming bank-account line — the only thing that can be income. */
async function loadTransaction(txId) {
  oid(txId, 'מזהה תנועה');
  const tx = await BankTransaction.findById(txId).lean();
  if (!tx) throw fail(404, 'התנועה לא נמצאה');
  const account = await BankAccount.findById(tx.account_id, 'type').lean();
  if (!(tx.amount > 0) || tx.is_internal_transfer || !account || account.type !== 'bank') {
    throw fail(400, 'התנועה אינה העברה נכנסת לחשבון הבנק');
  }
  return tx;
}

async function allocatedTotal(txId) {
  const [row] = await IncomeAllocation.aggregate([
    { $match: { transaction_id: new mongoose.Types.ObjectId(String(txId)) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return round2(row ? row.total : 0);
}

/** Alias upsert; the unique index can race between two transfers of one payer — the loser retries as an update. */
async function rememberPayer(payer, householdKey, by) {
  if (!payer) return;
  const set = { household_key: householdKey, created_by: by || null };
  try {
    await IncomePayerAlias.updateOne({ payer_key: payer }, { $set: set }, { upsert: true });
  } catch (e) {
    if (e && e.code === 11000) await IncomePayerAlias.updateOne({ payer_key: payer }, { $set: set });
    else throw e;
  }
}

/**
 * Attribute (part of) a transfer to a family's children and months.
 * Σ allocations of the transfer stays ≤ amount + 2 ₪. Without `split` the
 * earliest open months across the family's children are used.
 */
async function acceptIncome({ transaction_id, household_key, split, by = null }) {
  oid(transaction_id, 'מזהה תנועה');
  if (!household_key) throw fail(400, 'חסרה משפחה');
  return withLocks([lockKey(transaction_id)], async () => {
    const tx = await loadTransaction(transaction_id);
    const year = K.academicYearOfDate(tx.date);
    if (!year) throw fail(400, 'לתנועה אין תאריך תקין');
    const households = await K.kaplanHouseholds(year);
    const household = households.find(h => K.householdMatchesKey(h, household_key));
    if (!household) throw fail(404, 'המשפחה לא נמצאה בשנת הלימודים של ההעברה');

    const remaining = round2(tx.amount - await allocatedTotal(tx._id));
    if (remaining <= COVERAGE_TOLERANCE_ILS) throw fail(409, 'ההעברה כבר הוקצתה במלואה');

    let slices;
    if (Array.isArray(split) && split.length) {
      slices = split.map((s) => {
        const child = household.children.find(c => String(c.registration_id) === String(s.registration_id));
        if (!child) throw fail(400, 'הילד אינו שייך למשפחה שנבחרה');
        const month = Number(s.month_number);
        if (!(ACADEMIC_MONTHS.includes(month) || month === CAMP_MONTH) || !child.months.some(m => m.month_number === month)) {
          throw fail(400, 'חודש לא תקין לילד');
        }
        const amount = round2(s.amount);
        if (!(amount > 0)) throw fail(400, 'סכום ההקצאה חייב להיות חיובי');
        return { registration_id: child.registration_id, month_number: month, amount };
      });
    } else {
      slices = K.splitInto(K.ledgerOf(household), remaining)
        .map(({ registration_id, month_number, amount }) => ({ registration_id, month_number, amount }));
      if (!slices.length) throw fail(409, 'אין חודשים פתוחים לשיוך');
    }
    const sum = round2(slices.reduce((s, x) => s + x.amount, 0));
    if (sum > remaining + TOLERANCE_ILS) throw fail(400, 'סכום ההקצאות גדול מיתרת ההעברה');

    const allocations = await atomically(async ({ session, undo }) => {
      const docs = slices.map(s => ({
        transaction_id: tx._id,
        registration_id: s.registration_id,
        household_key: household.household_key,
        academic_year: year,
        month_number: s.month_number,
        amount: s.amount,
        created_by: by || null,
      }));
      const created = await IncomeAllocation.insertMany(docs, session ? { session } : {});
      undo(() => IncomeAllocation.deleteMany({ _id: { $in: created.map(c => c._id) } }));
      await rememberPayer(K.payerKey(tx), household.household_key, by);
      return created.map(c => c.toObject());
    }, { transaction_id: String(tx._id) });
    return { allocations };
  });
}

/** "✗ לא זה" — rule a family out for a transfer. Idempotent. */
async function rejectIncome({ transaction_id, household_key }) {
  oid(transaction_id, 'מזהה תנועה');
  if (!household_key) throw fail(400, 'חסרה משפחה');
  return withLocks([lockKey(transaction_id)], async () => {
    await loadTransaction(transaction_id);
    await IncomeRejection.updateOne(
      { transaction_id, household_key },
      { $setOnInsert: { transaction_id, household_key } },
      { upsert: true },
    );
    return { ok: true };
  });
}

/** Take all of a transfer's allocations back; the transfer returns to the open pool. Idempotent. */
async function unallocate(transaction_id) {
  oid(transaction_id, 'מזהה תנועה');
  return withLocks([lockKey(transaction_id)], async () => {
    const r = await IncomeAllocation.deleteMany({ transaction_id });
    return { removed: r.deletedCount || 0 };
  });
}

/**
 * Per gan month: expected (collections screen), paid by receipt (receipt
 * number or status paid, sibling receipts included), found in the bank
 * (allocations) — plus the two cross-check lists, per child and month.
 */
async function kaplanMonthReport(academicYear) {
  const households = await K.kaplanHouseholds(academicYear);
  const byMonth = new Map([...ACADEMIC_MONTHS, CAMP_MONTH].map(m => [m, { month_number: m, expected: 0, by_receipt: 0, in_bank: 0 }]));
  const receipt_no_bank = [];
  const bank_no_receipt = [];
  for (const h of households) {
    for (const c of h.children) {
      for (const m of c.months) {
        const row = byMonth.get(m.month_number);
        if (!row) continue;
        const hasReceipt = !!m.receipt || !!m.paid;
        row.expected = round2(row.expected + m.expected);
        row.in_bank = round2(row.in_bank + m.allocated);
        if (hasReceipt) row.by_receipt = round2(row.by_receipt + m.expected);
        const base = {
          household_key: h.household_key, registration_id: c.registration_id, child_name: c.child_name,
          month_number: m.month_number, expected: m.expected, allocated: m.allocated, receipt: m.receipt || null,
        };
        if (hasReceipt && m.expected > 0 && m.allocated + TOLERANCE_ILS < m.expected) receipt_no_bank.push(base);
        if (!hasReceipt && m.allocated > 0) bank_no_receipt.push(base);
      }
    }
  }
  const months = [...byMonth.values()].filter(r => r.month_number !== CAMP_MONTH || r.expected || r.in_bank);
  return { academic_year: academicYear, months, receipt_no_bank, bank_no_receipt };
}

module.exports = { acceptIncome, rejectIncome, unallocate, kaplanMonthReport };
