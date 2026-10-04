'use strict';

/**
 * What each employee's שקלולית file contained, month by month — the memory the
 * switch-off rows are built from.
 *
 * שקלולית copies last month's payslip into this month's and then applies our
 * file on top, so a component we do not mention is paid again at last month's
 * value. To zero it we have to know what LAST month held. Not "the last file we
 * happened to produce": a snapshot that kept only the latest file forgot August
 * the moment September was downloaded once — the 28.09 trial import did exactly
 * that — and every later September export then took September itself for "the
 * previous month" and switched nothing off. אסתר הרוניאן's August bonus and
 * August הבראה were both paid again on her September payslip that way.
 *
 * So the history is kept per month, and only the entry for the month directly
 * before the one being filed counts.
 */

const KEEP_MONTHS = 12;

const keyOf = (c) => `${Number(c.table) || 1}:${Number(c.code)}`;

function cleanComponents(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const code = Number(c?.code);
    if (!Number.isFinite(code) || code <= 0) continue;
    const entry = { code, table: Number(c.table) || 1 };
    const k = keyOf(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  return out;
}

/**
 * A stored snapshot as a month-sorted history. Snapshots written before the
 * history existed carry one `{month, components}` pair; that pair still counts
 * for its month. One with no month cannot be placed and is ignored — guessing
 * which month it describes is how September got mistaken for August.
 */
function historyOf(snap) {
  const byMonth = new Map();
  if (snap?.month && Array.isArray(snap.components)) {
    byMonth.set(snap.month, { components: cleanComponents(snap.components), sent: [] });
  }
  for (const h of snap?.history || []) {
    if (h?.month) byMonth.set(h.month, { components: cleanComponents(h.components), sent: cleanComponents(h.sent) });
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, e]) => ({ month, components: e.components, sent: e.sent }));
}

/**
 * The history with `month`'s entry replaced by `components`, newest kept.
 *
 * `sent` remembers every component ANY file for that month carried, not just
 * the latest one. שקלולית applies each file on top of the payslip it already
 * holds, so a component an earlier September file put there stays there when
 * a later September file simply leaves it out. גלאם רות, 09.2026: the first
 * file paid 2 ימי חופשה, the system was corrected, the second file had no
 * vacation row — and her payslip still paid the 2 days. A re-export has to
 * zero what the earlier one sent, and so has to remember it.
 */
function withMonth(snap, month, components, keep = KEEP_MONTHS) {
  const all = historyOf(snap);
  const prior = all.find((h) => h.month === month);
  const sent = union(prior ? union(prior.sent, prior.components) : [], components);
  const others = all.filter((h) => h.month !== month);
  return [...others, { month, components: cleanComponents(components), sent }]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-keep);
}

/** Everything any file for exactly `month` carried, or null when none was made. */
function sentIn(snap, month) {
  const hit = historyOf(snap).find((h) => h.month === month);
  return hit ? union(hit.sent, hit.components) : null;
}

/** What was filed for exactly `month`, or null when we never filed it. */
function filedIn(snap, month) {
  const hit = historyOf(snap).find((h) => h.month === month);
  return hit ? hit.components : null;
}

/** Two component lists as one, each (table, code) once. */
function union(a, b) {
  return cleanComponents([...(a || []), ...(b || [])]);
}

/**
 * The set to switch off this month, per employee: everything that was on the
 * PREVIOUS month's payslip as far as we can know it.
 *
 * Two sources, and both are taken, not one or the other:
 *
 *   FILED — what our file for that month actually carried, when we made one.
 *
 *   DERIVED — the previous month rebuilt from our own payroll data through
 *   the same adapter: the file we WOULD have sent. For a month nobody exported
 *   (August 2026, keyed entirely by hand at the accountant's) this is the only
 *   source there is; and even after a real file it catches what that file left
 *   to the accountant's hand — הבראה — or what an older adapter did not yet
 *   send (שעות משולמות, until 29.09.2026).
 *
 * The union can only ADD zero rows, and only for codes we are not filing this
 * month. Zeroing a code that turns out not to be on the payslip changes
 * nothing; missing one pays it twice.
 *
 * @param {object}   args
 * @param {string[]} args.numbers    employee numbers in this month's file
 * @param {object[]} args.snapshots  ShkulitMovementSnapshot documents
 * @param {string}   args.prevMonth  'YYYY-MM' — the month directly before
 * @param {object[]|null} args.prevRows  that month's payroll rows, or null
 *                                    when they could not be fetched
 */
function previousMonthComponents({ numbers, snapshots, prevMonth, prevRows, month = null }) {
  const wanted = new Set((numbers || []).map(String));
  const out = new Map();
  if (!prevMonth) return out;

  for (const snap of snapshots || []) {
    const no = String(snap.employee_number);
    if (!wanted.has(no)) continue;
    // Every file for that month, not just the last: each one reached the payslip.
    const filed = sentIn(snap, prevMonth);
    if (filed && filed.length) out.set(no, filed);
  }

  if (Array.isArray(prevRows) && prevRows.length) {
    // Required here, not at the top: the adapter and the source layer are the
    // two things this module exists to serve, and neither needs it back.
    const { toCanonicalEmployee } = require('./sourceLayer');
    const { buildMovements } = require('./shkulitAdapter');
    // Canonical rows directly, NOT buildExportSource: that one drops whoever
    // fails the audit (a missing bank account), and a payslip she still got
    // last month is still carried forward into this one.
    const ready = prevRows
      .filter((r) => wanted.has(String(r.employee_number || '').trim()) && !r.is_freelancer)
      .map((r) => toCanonicalEmployee({ ...r, month: r.month || prevMonth }));
    const { filed } = buildMovements({ month: prevMonth, ready });
    for (const [no, comps] of filed) {
      const key = String(no);
      out.set(key, union(out.get(key), comps));
    }
  }
  // An earlier file for THIS month already reached the payslip — whatever it
  // carried that this file no longer does has to be switched off too.
  if (month) {
    for (const snap of snapshots || []) {
      const no = String(snap.employee_number);
      if (!wanted.has(no)) continue;
      const earlier = sentIn(snap, month);
      if (earlier && earlier.length) out.set(no, union(out.get(no), earlier));
    }
  }
  return out;
}

module.exports = { KEEP_MONTHS, historyOf, withMonth, filedIn, sentIn, union, previousMonthComponents };
