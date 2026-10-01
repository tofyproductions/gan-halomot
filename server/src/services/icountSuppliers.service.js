/**
 * iCount suppliers (port notes §4). Read-only: this app never creates a supplier
 * in iCount. A supplier we cannot find there blocks filing instead.
 *
 * Joining ours to theirs: ח.פ digits first; else the normalised name
 * (expenseCore.vendorKey). A name shared by two iCount cards is AMBIGUOUS and
 * decides nothing; a card carrying a DIFFERENT ח.פ is a different company.
 */
const { getClient } = require('./ganIcount.client');
const { vendorKey } = require('./expenseCore.service');
const { isValidIsraeliID } = require('../utils/id-generator');

const METHODS = Object.freeze({
  search: '/expense/search',
  create: '/expense/create',
  update: '/expense/update',
  suppliers: '/supplier/get_list',
});

const PAGE_SIZE = 500;
const MAX_PAGES = 40;          // 20,000 rows for one query means something is wrong
const CACHE_MS = 5 * 60 * 1000;

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const firstOf = (row, keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
  return '';
};

function rowsOf(data) {
  if (Array.isArray(data?.results_list)) return data.results_list;
  for (const [k, v] of Object.entries(data || {})) {
    if (k === 'status' || k === 'sid') continue;
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && Object.values(v).every((x) => x && typeof x === 'object')) return Object.values(v);
  }
  return [];
}

/**
 * Read every page of a list method. `complete` is false when we gave up early or
 * iCount reported more rows than we got, so callers never mistake a short read
 * for "nothing else exists". Errors (including THROTTLED) propagate.
 */
async function fetchPaged(client, method, params = {}) {
  const rows = [];
  let total = null;
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await client.post(method, { ...params, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (page === 0 && data?.total_count !== undefined && data?.total_count !== null && data.total_count !== '') {
      const t = Number(data.total_count);
      total = Number.isFinite(t) ? t : null;
    }
    const batch = rowsOf(data);
    rows.push(...batch);
    if (!batch.length || (total !== null && rows.length >= total) || batch.length < PAGE_SIZE) { exhausted = true; break; }
  }
  return { rows, total, complete: exhausted && (total === null || rows.length >= total) };
}

let cache = null; // { at, value }
const clearSupplierCache = () => { cache = null; };

function normaliseSupplier(raw) {
  return {
    id: String(firstOf(raw, ['supplier_id', 'id'])),
    name: String(firstOf(raw, ['supplier_name', 'company_name', 'name'])).trim(),
    tax_id: digits(firstOf(raw, ['vat_id', 'supplier_vat_id', 'tax_id'])),
  };
}

/** → { suppliers: [{id,name,tax_id}], complete }. An incomplete read is never cached. */
async function listSuppliers({ refresh = false, client = getClient(), now = Date.now } = {}) {
  if (!refresh && cache && now() - cache.at < CACHE_MS) return cache.value;
  const { rows, complete } = await fetchPaged(client, METHODS.suppliers);
  const value = { suppliers: rows.map(normaliseSupplier).filter((s) => s.id), complete };
  cache = complete ? { at: now(), value } : null;
  return value;
}

/**
 * Port notes §4 trustedTaxId: a number longer than 9 digits, or failing the
 * Israeli check digit, is a misread and is IGNORED so the name decides
 * (incident 30.09: 510298946 read as 516298946 made a supplier look different).
 */
function trustedTaxId(v) {
  const d = digits(v);
  return d.length >= 1 && d.length <= 9 && isValidIsraeliID(d) ? d.padStart(9, '0') : '';
}

/** Build the lookup maps (port notes §4). */
function buildIndex(suppliers) {
  const byId = new Map();
  const idByVat = new Map();
  const idByName = new Map();
  const ambiguous = new Set();
  for (const s of suppliers) {
    byId.set(s.id, s);
    const tax = trustedTaxId(s.tax_id);
    if (tax && !idByVat.has(tax)) idByVat.set(tax, s.id); // first wins: stable
    const key = vendorKey(s.name);
    if (!key || ambiguous.has(key)) continue;
    if (idByName.has(key) && idByName.get(key) !== s.id) { idByName.delete(key); ambiguous.add(key); } else idByName.set(key, s.id);
  }
  return { byId, idByVat, idByName };
}

/** Pure resolver over an already-read list. → { id, name } | null */
function resolveIn(suppliers, { tax_id, name } = {}) {
  const { byId, idByVat, idByName } = buildIndex(suppliers);
  const vat = trustedTaxId(tax_id);
  if (vat && idByVat.has(vat)) { const s = byId.get(idByVat.get(vat)); return { id: s.id, name: s.name }; }
  const key = vendorKey(name);
  const hit = key ? idByName.get(key) : null;
  if (!hit) return null;
  const card = byId.get(hit);
  if (trustedTaxId(card.tax_id) && vat) return null; // the card carries a different ח.פ: another company
  return { id: card.id, name: card.name };
}

/** → { id, name } | null. null also when the list could not be read completely. */
async function resolveSupplier({ tax_id, name } = {}, opts = {}) {
  const { suppliers, complete } = await listSuppliers(opts);
  if (!complete) return null;
  return resolveIn(suppliers, { tax_id, name });
}

module.exports = {
  METHODS, PAGE_SIZE, fetchPaged, rowsOf, firstOf, digits,
  listSuppliers, resolveSupplier, resolveIn, trustedTaxId, clearSupplierCache,
};
