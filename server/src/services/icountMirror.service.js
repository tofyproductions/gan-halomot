/**
 * Read-only mirror of the gan's iCount expenses (port notes §5, §12).
 *
 * pullMirror reads every supplier's expenses (4 suppliers at a time, a short gap
 * between each) and upserts them into IcountExpense by icount_id. It never
 * writes to iCount and never creates ExpenseDocuments — Task 3 joins the mirror
 * to our documents.
 *
 * A pull may be partial (throttled, a supplier could not be read to the end).
 * Partial is reported, never hidden, and `gone_at` is applied PER SUPPLIER only
 * for suppliers read completely: a vanished row from a half-read supplier would
 * just be an unread page.
 */
const { IcountExpense, IcountPull } = require('../models');
const { getClient } = require('./ganIcount.client');
const { getStartDate } = require('./expenseCore.service');
const { METHODS, fetchPaged, listSuppliers, firstOf, digits } = require('./icountSuppliers.service');

const MAX_SUPPLIERS_PER_PULL = 5000;
const NOT_CONNECTED = 'לא מחובר';

// iCount mixes "false", "0" and "" for flags; all are truthy JS strings.
const flag = (v) => !['', '0', 'false', 'null', 'no', 'undefined'].includes(String(v ?? '').trim().toLowerCase());

/** Port notes §5 row mapping, field names as observed on this account. */
function mapExpenseRow(raw) {
  const date = String(firstOf(raw, ['expense_date', 'invoice_date', 'doc_date', 'date'])).slice(0, 10);
  return {
    icount_id: String(firstOf(raw, ['expense_id', 'docnum', 'id'])),
    doc_number: String(firstOf(raw, ['expense_docnum', 'invoice_number', 'supplier_docnum', 'doc_number', 'docnum'])),
    amount_total: Number(firstOf(raw, ['nis_sum', 'expense_sum', 'total', 'amount', 'sum'])) || 0,
    doc_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '1970-01-01',
    supplier_tax_id: digits(firstOf(raw, ['supplier_vat_id', 'vat_id', 'supplier_tax_id', 'tax_id'])),
    supplier_id: String(firstOf(raw, ['supplier_id'])),
    is_storno: flag(raw.is_storno) || flag(raw.is_stornoed),
  };
}

const envInt = (name, fallback, min) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
};
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const short = (e) => String(e?.message || e).slice(0, 120);

async function pullMirror({ client = getClient(), concurrency, gapMs, now = () => new Date() } = {}) {
  const conc = concurrency ?? envInt('ICOUNT_SUPPLIER_CONCURRENCY', 4, 1);
  const gap = gapMs ?? envInt('ICOUNT_SUPPLIER_GAP_MS', 50, 0);
  const result = { suppliers: 0, fetched: 0, upserted: 0, gone: 0, partial: false, errors: [] };

  if (!client.isConfigured()) return { ...result, partial: true, errors: [NOT_CONNECTED] };

  const dateFrom = await getStartDate();
  const pull = await IcountPull.create({ started_at: now(), date_from: dateFrom });
  const failures = [];
  let suppliersRead = 0;
  let aborted = false; // first THROTTLED stops the pull: retrying through a throttle lengthens it

  const finish = async (error = '') => {
    result.partial = Boolean(error) || failures.length > 0;
    result.errors = [...(error ? [error] : []), ...failures.map((f) => `${f.supplier}: ${f.reason}`)];
    await IcountPull.updateOne({ _id: pull._id }, { $set: {
      finished_at: now(), suppliers_total: result.suppliers, suppliers_read: suppliersRead,
      rows_seen: result.fetched, upserted: result.upserted, gone: result.gone,
      complete: !result.partial, failures, error,
    } });
    return result;
  };

  let list;
  try {
    list = await listSuppliers({ client, refresh: true });
  } catch (e) {
    return finish(`קריאת רשימת הספקים נכשלה: ${short(e)}`);
  }
  // A partial supplier list would make real documents look missing.
  if (!list.complete) return finish('רשימת הספקים לא נקראה במלואה');

  const toRead = list.suppliers.slice(0, MAX_SUPPLIERS_PER_PULL);
  result.suppliers = toRead.length;
  const capped = list.suppliers.length > toRead.length;

  async function readSupplier(s) {
    const label = s.name || s.id;
    let fetched;
    try {
      fetched = await fetchPaged(client, METHODS.search, { supplier_id: s.id });
    } catch (e) {
      if (e.code === 'THROTTLED') {
        if (!aborted) failures.push({ supplier: label, reason: short(e) }); // ONE named failure
        aborted = true;
        return;
      }
      failures.push({ supplier: label, reason: short(e) });
      return;
    }
    if (!fetched.complete) { failures.push({ supplier: label, reason: 'לא כל המסמכים נקראו' }); return; }
    suppliersRead++;

    const stamp = now();
    const seen = new Set();
    const ops = [];
    for (const raw of fetched.rows) {
      const m = mapExpenseRow(raw);
      if (!m.icount_id || m.doc_date < dateFrom) continue;
      seen.add(m.icount_id);
      ops.push({ updateOne: {
        filter: { icount_id: m.icount_id },
        update: {
          $set: {
            supplier_id: s.id, supplier_name: s.name, supplier_tax_id: m.supplier_tax_id || s.tax_id,
            doc_number: m.doc_number, doc_date: m.doc_date, amount_total: m.amount_total,
            is_storno: m.is_storno, last_seen_at: stamp, gone_at: null, // a returning doc un-gones
          },
          $setOnInsert: { first_seen_at: stamp },
        },
        upsert: true,
      } });
    }
    if (ops.length) await IcountExpense.bulkWrite(ops, { ordered: false });
    result.fetched += ops.length;
    result.upserted += ops.length;

    // An empty read only proves "nothing" if iCount itself said total_count 0.
    if (fetched.rows.length || fetched.total === 0) {
      const r = await IcountExpense.updateMany(
        { supplier_id: s.id, gone_at: null, doc_date: { $gte: dateFrom }, icount_id: { $nin: [...seen] } },
        { $set: { gone_at: stamp } },
      );
      result.gone += r.modifiedCount || 0;
    }
  }

  let next = 0;
  const worker = async () => {
    for (let i = next++; i < toRead.length && !aborted; i = next++) {
      await readSupplier(toRead[i]);
      if (gap && i < toRead.length - 1) await sleep(gap);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, toRead.length) }, worker));

  return finish(capped ? `יותר מ-${MAX_SUPPLIERS_PER_PULL} ספקים — נקראו הראשונים בלבד` : '');
}

module.exports = { pullMirror, mapExpenseRow, MAX_SUPPLIERS_PER_PULL };
