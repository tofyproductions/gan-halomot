/**
 * Payslip ↔ salary-table comparator.
 *
 * Matches every salary-table row to a payslip (by name, since the table doesn't
 * carry IDs), then runs a set of rule-based checks driven by:
 *   - structured columns (days, hours, transport, etc.)
 *   - directives parsed from the free-text "הערות" column
 *   - Israeli labour law (sick day deductions, etc.)
 *
 * Each finding has a severity:
 *   critical  — money/legal mistake the manager must fix
 *   warning   — likely mistake; needs human review
 *   info      — context the comparator can't auto-verify (transport, recuperation)
 *   ok        — explicit confirmation that a directive was applied correctly
 */

const FLOAT_TOL = 0.5;

function approxEq(a, b, tol = FLOAT_TOL) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

// Find a payslip line-item whose amount is the closest to `expected`, within
// a permissive tolerance. Used as a label-blind fallback when the parser
// couldn't categorize an item (Hebrew labels are often garbled by the vendor's
// embedded font). Returns the matched amount (the actual paid value), or null.
//   - tolerance: ±50% of the expected value, capped at ±200₪.
//   - tie-break: closest absolute diff wins; ties skipped (ambiguous).
function findClosestItemAmount(items, expected) {
  if (!Array.isArray(items) || !items.length || expected == null || expected <= 0) return null;
  const maxDelta = Math.min(Math.max(expected * 0.5, 50), 200);
  let best = null; let bestDiff = Infinity; let tied = false;
  for (const it of items) {
    const a = Number(it?.amount);
    if (!Number.isFinite(a)) continue;
    const diff = Math.abs(a - expected);
    if (diff > maxDelta) continue;
    if (diff < bestDiff) { best = a; bestDiff = diff; tied = false; }
    else if (diff === bestDiff) { tied = true; }
  }
  return tied ? null : best;
}

function normalizeName(name) {
  if (!name) return '';
  return name
    .replace(/[()‘’“”"'.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    // Hebrew final-form letters → medial form so "אהרן" matches "אהרון"-like
    // variants only at the spelling-form level (not waw/yud variants — those
    // are too risky to collapse without conflating distinct names).
    .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
}

// Damerau-Levenshtein edit distance (optimal string alignment variant).
// Counts adjacent transposition as ONE edit so אבודגה ↔ אבוגדה returns 1
// (plain Levenshtein returns 2 for the same pair). Small inputs only —
// Hebrew name tokens — full 2D matrix for clarity.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,         // deletion
        d[i][j - 1] + 1,         // insertion
        d[i - 1][j - 1] + cost,  // substitution
      );
      if (i > 1 && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

// Fuzzy token equality. Catches the two most common Hebrew name errors:
//   - missing/extra waw or yud:  אהרון ↔ אהרן
//   - adjacent letter transposition:  אבודגה ↔ אבוגדה
// Restricted to tokens of length ≥ 4 to avoid conflating short distinct
// tokens like "דן" / "נד".
function tokensMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1) {
    return levenshtein(a, b) <= 1;
  }
  return false;
}

// Count token overlap using fuzzy equality.
function commonTokenCount(candTokens, otherTokens) {
  let common = 0;
  const used = new Array(otherTokens.length).fill(false);
  for (const t of candTokens) {
    for (let i = 0; i < otherTokens.length; i++) {
      if (used[i]) continue;
      if (tokensMatch(t, otherTokens[i])) { common++; used[i] = true; break; }
    }
  }
  return common;
}

// Match a Cibus row to a result. Priority:
//   1. Israeli ID (most reliable — when both sides have it)
//   2. STRICT name match — 1-token names need exact full match; 2+-token
//      names need at least 2 common tokens. Picks the candidate with the
//      MOST overlapping tokens (so "לילך אבודגה" beats "לילך וקנין" when
//      the result is for אבודגה specifically). Without this rule we used to
//      mis-pair employees that share a first name (e.g. two "לילך"s in
//      different branches).
//
// Note: We deliberately DO NOT match by employee_no — the payslip uses the
// payroll-system numbering (e.g. "3" = third employee in the שאול המלך PDF)
// while Cibus uses Pluxee's own customer ID for that employee. The numbers
// are uncorrelated and an emp_no match would mis-pair people.
function findCibusForResult(result, cibusUnused) {
  if (!cibusUnused || cibusUnused.size === 0) return null;
  const employeeId = result.payslip?.employee_id;

  // 1) ID match
  if (employeeId) {
    for (const c of cibusUnused) {
      if (c.id && c.id === employeeId) {
        cibusUnused.delete(c);
        return c;
      }
    }
  }
  // 2) Strict name match — pick the candidate with the most token overlap
  const tName = normalizeName(result.table_row?.employee_name || '');
  const pName = normalizeName(result.payslip?.employee_name || '');
  const candTokensSet = new Set();
  for (const candidate of [tName, pName]) {
    if (!candidate) continue;
    for (const t of candidate.split(' ').filter(Boolean)) candTokensSet.add(t);
  }
  const candTokens = [...candTokensSet];
  let best = null;
  let bestCommon = 0;
  for (const c of cibusUnused) {
    const cName = normalizeName(c.name || '');
    if (!cName) continue;
    const cTokens = cName.split(' ').filter(Boolean);
    const common = commonTokenCount(candTokens, cTokens);
    const required = candTokens.length === 1 ? 1 : 2;
    if (common >= required && common > bestCommon) {
      best = c;
      bestCommon = common;
    }
  }
  if (best) { cibusUnused.delete(best); return best; }
  // 3) Loose fallback — single-token match if it's UNIQUE among the
  // remaining cibus rows. Catches spelling variants (e.g. waw-less surname
  // in cibus vs waw in table) without re-introducing collisions.
  const single = [];
  for (const c of cibusUnused) {
    const cName = normalizeName(c.name || '');
    if (!cName) continue;
    const cTokens = cName.split(' ').filter(Boolean);
    const common = commonTokenCount(candTokens, cTokens);
    if (common >= 1) single.push({ c, common });
  }
  single.sort((a, b) => b.common - a.common);
  if (single.length === 1 || (single.length > 1 && single[0].common > single[1].common)) {
    cibusUnused.delete(single[0].c);
    return single[0].c;
  }
  return null;
}

// Match each table row to its best payslip by name. Two safety nets against
// name collisions (e.g. two "X כהן" employees in the same branch):
//   - 1-token names need an exact full-name match (i.e. all tokens shared)
//   - 2+-token names need at least 2 common tokens
//   - Among candidates that pass the threshold, pick the one with the MOST
//     common tokens — so "לירון כהן" matches its own payslip, not "ליז כהן"
//     even though both share "כהן". Without this, the previous "≥50% match"
//     rule mis-paired "X כהן" employees, swapping their cibus/findings.
// Match each table row to its best payslip by name, in two passes.
//
// Pass 1 — STRICT: 1-token names need exact match; 2+-token names need ≥2
// common tokens. Picks the candidate with MOST overlap. This protects against
// false positives like "X כהן" / "Y כהן".
//
// Pass 2 — LOOSE FALLBACK for unmatched: when the PDF font garbles part of a
// name (e.g. "אסתר רסקאי" rendered as "טרפלש אסצר רסקאי"), the surname often
// survives intact. Allow a single-token match BETWEEN unmatched-only candidates,
// AND only if the match is UNIQUE (no other unmatched payslip shares that
// token). This catches the garbled cases without re-introducing collisions.
function matchRows(tableRows, payslips) {
  const out = [];
  const used = new Set();

  // Pass 1: strict
  const strictMatched = []; // index into out, for unmatched filling later
  for (const tableRow of tableRows) {
    const tName = normalizeName(tableRow.employee_name);
    const tTokens = [...new Set(tName.split(' ').filter(Boolean))];
    let bestIdx = -1;
    let bestCommon = 0;
    for (let i = 0; i < payslips.length; i++) {
      if (used.has(i)) continue;
      const pName = normalizeName(payslips[i].employee_name);
      if (!pName) continue;
      const pTokens = pName.split(' ').filter(Boolean);
      const common = commonTokenCount(tTokens, pTokens);
      const required = tTokens.length === 1 ? 1 : 2;
      if (common >= required && common > bestCommon) {
        bestIdx = i;
        bestCommon = common;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      out.push({ table: tableRow, payslip: payslips[bestIdx], method: 'name' });
    } else {
      out.push({ table: tableRow, payslip: null, method: 'none' });
      strictMatched.push({ outIdx: out.length - 1, tableRow });
    }
  }

  // Pass 2: loose fallback — single-token match across unmatched only, with
  // a uniqueness check so we don't accidentally pair the wrong "רסקאי".
  for (const { outIdx, tableRow } of strictMatched) {
    const tName = normalizeName(tableRow.employee_name);
    const tTokens = [...new Set(tName.split(' ').filter(Boolean))];
    if (tTokens.length === 0) continue;

    // For each remaining unmatched payslip, count token overlap >= 1.
    const candidates = [];
    for (let i = 0; i < payslips.length; i++) {
      if (used.has(i)) continue;
      const pName = normalizeName(payslips[i].employee_name);
      if (!pName) continue;
      const pTokens = pName.split(' ').filter(Boolean);
      const common = commonTokenCount(tTokens, pTokens);
      if (common >= 1) candidates.push({ idx: i, common });
    }
    // Take the unique single best match; if there's a tie, skip (ambiguous).
    candidates.sort((a, b) => b.common - a.common);
    if (candidates.length === 1 || (candidates.length > 1 && candidates[0].common > candidates[1].common)) {
      const idx = candidates[0].idx;
      used.add(idx);
      out[outIdx] = { table: tableRow, payslip: payslips[idx], method: 'loose' };
    }
  }

  for (let i = 0; i < payslips.length; i++) {
    if (!used.has(i)) out.push({ table: null, payslip: payslips[i], method: 'none' });
  }
  return out;
}

// ── Notes parser ──

const RE_LOAN = /תשלום\s*(\d+)\s*מתוך\s*(\d+)\s*על\s*סך\s*([\d,]+)/;
const RE_BONUS_PER_HOUR = /בונוס\s*(\d+(?:\.\d+)?)\s*(?:ש[״\."]?ח)?\s*\*?\s*(?:כפול)?\s*(?:מספר\s*)?שעות/;
const RE_BONUS_FIXED = /בונוס\s*(?:הובלת\s*קבוצה\s*-)?\s*([\d,]+)\s*ש[״\."]?ח/;
const RE_COMPLETION = /השלמת\s*שכר\s*(\d+(?:\.\d+)?)\s*שעות/;
const RE_NET_TARGET_FULL = /סה"?כ\s*לתשלום\s*-?\s*([\d,]+)\s*₪?\s*נטו(?:\s*כולל\s*נסיעות)?/;
const RE_REQUIRED_HOURS = /מחו?י?י?בת\s*ל-?\s*(\d+(?:\.\d+)?)\s*שעות/;

// Managers who use the Cibus card for kindergarten-operational expenses
// (food for staff/kids), not personal meals. Their payslips intentionally
// omit שווי ארוחות and the Pluxee charge shouldn't be flagged. Identified
// by the normalized full name — Israeli IDs may change between hires/rehires
// but the names are stable. Add new managers here.
const CIBUS_EXEMPT_MANAGERS = [
  'לידור כהן',
  'אורלי מור',
];
function isCibusExemptByName(name) {
  if (!name) return false;
  const n = normalizeName(name);
  const tokens = new Set(n.split(' ').filter(Boolean));
  for (const mgr of CIBUS_EXEMPT_MANAGERS) {
    const mgrTokens = normalizeName(mgr).split(' ').filter(Boolean);
    let common = 0;
    for (const t of mgrTokens) if (tokens.has(t)) common++;
    if (common >= 2) return true;
  }
  return false;
}

function parseNotes(notes) {
  const raw = notes || '';
  const out = {
    zero_vacation: /לאפס\s*ימי?\s*חופשה/.test(raw),
    deduct_8_vacation: /להוריד\s*8\s*ימי?\s*חופשה.*שכר\s*גלובלי/s.test(raw),
    pay_full_no_advance: /להפקיד\s*שכר\s*מלא.*קיזוז.*חודש\s*הבא/s.test(raw),
    // Manager exemption — these employees use the Cibus card for kindergarten
    // operational expenses (food for staff/kids), not personal meals, so the
    // Pluxee charge should NOT appear as שווי ארוחות in their payslip and
    // shouldn't be flagged as missing/mismatch. Trigger phrases (any one):
    //   "סיבוס לצרכי הגן" / "סיבוס לגן" / "סיבוס מנהלת" / "פטור.*סיבוס" / "סיבוס.*פטור"
    cibus_exempt:
      /סיבוס\s*ל?צ?רכ?י?\s*הגן/.test(raw) ||
      /סיבוס\s*לגן/.test(raw) ||
      /סיבוס\s*מנהל/.test(raw) ||
      /פטור.*סיבוס/.test(raw) ||
      /סיבוס.*פטור/.test(raw),
    loan_payment_amount: null,
    loan_payment_index: null,
    loan_payment_total: null,
    bonus_per_hour: null,
    bonus_fixed: null,
    salary_completion_hours: null,
    net_target: null,
    net_target_includes_transport: false,
    required_hours: null,
    raw,
  };
  const loan = raw.match(RE_LOAN);
  if (loan) {
    out.loan_payment_index = Number(loan[1]);
    out.loan_payment_total = Number(loan[2]);
    out.loan_payment_amount = Number(loan[3].replace(/,/g, ''));
  }
  const bh = raw.match(RE_BONUS_PER_HOUR);
  if (bh) out.bonus_per_hour = Number(bh[1]);
  const bf = raw.match(RE_BONUS_FIXED);
  if (bf) out.bonus_fixed = Number(bf[1].replace(/,/g, ''));
  const c = raw.match(RE_COMPLETION);
  if (c) out.salary_completion_hours = Number(c[1]);
  const nf = raw.match(RE_NET_TARGET_FULL);
  if (nf) {
    out.net_target = Number(nf[1].replace(/,/g, ''));
    out.net_target_includes_transport = /כולל\s*נסיעות/.test(raw);
  }
  const rh = raw.match(RE_REQUIRED_HOURS);
  if (rh) out.required_hours = Number(rh[1]);
  return out;
}

// ── One-employee comparison ──

function compareOne(table, payslip, method) {
  const findings = [];
  if (!table || !payslip) {
    return { matched: false, match_method: method, table_row: table, payslip, findings };
  }
  const d = parseNotes(table.notes);

  // Days
  if (table.days != null && payslip.paid_days != null) {
    if (Math.abs(table.days - payslip.paid_days) > 0.5) {
      findings.push({
        field: 'days',
        severity: 'warning',
        expected: table.days,
        actual: payslip.paid_days,
        message: `ימי עבודה: טבלה ${table.days} | תלוש ${payslip.paid_days}`,
      });
    }
  }

  // Hours.
  //   Hourly employees: show 0/0 in the header — sum the item-level qty
  //     columns instead. Compare against the table.
  //   Global-salary employees: hours are not paid per-unit. Skip the
  //     comparison entirely UNLESS the notes carry a "מחויבת ל-N שעות"
  //     directive AND the actual hours fell short — then it's a critical.
  const isGlobalEmployee =
    (table.global_salary_amount != null && table.global_salary_amount > 0) ||
    (table.global_salary != null && table.global_salary > 0);
  if (isGlobalEmployee) {
    if (d.required_hours != null) {
      const itemTotal =
        (payslip.item_regular_hours || 0) +
        (payslip.item_ot_125_hours || 0) +
        (payslip.item_ot_150_hours || 0);
      const slipTotal = payslip.paid_hours && payslip.paid_hours > 0 ? payslip.paid_hours : itemTotal;
      if (slipTotal > 0 && slipTotal < d.required_hours - 1) {
        findings.push({
          field: 'hours.shortfall',
          severity: 'critical',
          expected: d.required_hours,
          actual: slipTotal,
          message: `הוראה: מחויבת ל-${d.required_hours} שעות — בתלוש ${slipTotal.toFixed(2)} (חוסר ${(d.required_hours - slipTotal).toFixed(2)})`,
        });
      }
    }
    // No directive → no hours finding for global employees.
  } else if (table.hours_regular != null) {
    // Per-category findings — regular / 125% / 150% — so the auditor sees
    // exactly which bucket has the discrepancy, not just an aggregate.
    const cats = [
      { name: 'שעות רגילות',          tableKey: 'hours_regular', slipKey: 'item_regular_hours', tol: 1 },
      { name: 'שעות נוספות 125%',     tableKey: 'ot_125',        slipKey: 'item_ot_125_hours',  tol: 0.5 },
      { name: 'שעות נוספות 150%',     tableKey: 'ot_150',        slipKey: 'item_ot_150_hours',  tol: 0.5 },
    ];
    for (const cat of cats) {
      const tVal = table[cat.tableKey];
      const sVal = payslip[cat.slipKey];
      if (tVal == null && (sVal == null || sVal === 0)) continue;
      // Skip when the payslip side wasn't extracted at all — emitting a
      // "תלוש 0.00" finding here is misleading (parser couldn't read it,
      // doesn't necessarily mean the value IS zero). The diff panel will
      // surface "לא חולץ אוטומטית" visually instead.
      if (sVal == null) continue;
      const t = Number(tVal) || 0;
      const s = Number(sVal) || 0;
      if (Math.abs(t - s) <= cat.tol) continue;
      findings.push({
        field: `hours.${cat.tableKey}`,
        severity: 'warning',
        expected: t,
        actual: s,
        message: `${cat.name}: טבלה ${t.toFixed(2)}h | תלוש ${s.toFixed(2)}h — סטייה ${(s - t).toFixed(2)}h`,
      });
    }
    // Aggregate sanity check — only emit when the per-category checks couldn't
    // (e.g. payslip extracted a header total but no item-level breakdown).
    const itemTotal =
      (payslip.item_regular_hours || 0) +
      (payslip.item_ot_125_hours || 0) +
      (payslip.item_ot_150_hours || 0);
    if (itemTotal === 0 && payslip.paid_hours != null) {
      const tableTotal = (table.hours_regular || 0) + (table.ot_125 || 0) + (table.ot_150 || 0);
      if (Math.abs(tableTotal - payslip.paid_hours) > 1) {
        findings.push({
          field: 'hours.total',
          severity: 'warning',
          expected: tableTotal,
          actual: payslip.paid_hours,
          message: `סה"כ שעות: טבלה ${tableTotal.toFixed(2)} | תלוש ${payslip.paid_hours.toFixed(2)} (אין פירוט לפי קטגוריה)`,
        });
      }
    }
  }

  // Global salary check — for global employees, base_salary (תלוש) must
  // match global_salary_amount (טבלה), and global_ot_amount must match too.
  // Both are critical because they're direct money mismatches.
  if (isGlobalEmployee) {
    const tableGlobal = table.global_salary_amount;
    // When the table value is a NET target (kind = 'net') the payslip shows
    // the GROSS amount after gross-up — direct comparison is invalid (the
    // gap equals the tax burden). Compare only when both sides are gross.
    const isNetTarget = table.global_salary_kind === 'net';
    if (tableGlobal != null && payslip.base_salary != null && !isNetTarget) {
      // The payslip שכר-יסוד line has several money columns (סכום התשלום /
      // נטו לגילום / שכר לקופ"ג). Our "שכר בסיס" matches the נטו-לגילום column,
      // which isn't always the one parsed as base_salary — so accept a match if
      // our value ≈ ANY amount on that line.
      // Our "שכר בסיס" should equal the payslip שכר-יסוד (סכום-לתשלום column).
      // The base line has several money columns; accept a match if our value ≈
      // ANY of them. Flag only when the line WAS parsed but none matches.
      const candidates = Array.isArray(payslip.base_salary_candidates) && payslip.base_salary_candidates.length
        ? payslip.base_salary_candidates
        : [];
      if (candidates.length) {
        const matched = candidates.some((c) => Math.abs(tableGlobal - c) <= 2);
        if (!matched) {
          const closest = candidates.reduce((b, c) => (Math.abs(c - tableGlobal) < Math.abs(b - tableGlobal) ? c : b), candidates[0]);
          findings.push({
            field: 'global_salary',
            severity: 'critical',
            expected: tableGlobal,
            actual: closest,
            message: `שכר בסיס: טבלה ₪${tableGlobal} | בתלוש (שכר יסוד) ₪${closest} — סטייה ₪${(closest - tableGlobal).toFixed(2)}`,
          });
        }
      }
    } else if (tableGlobal != null && payslip.base_salary != null && isNetTarget) {
      // Net target: surface the comparison as info (not a bug) so the user
      // can sanity-check the gross-up if they want.
      findings.push({
        field: 'global_salary.net_target',
        severity: 'info',
        expected: `${tableGlobal} נטו`,
        actual: payslip.base_salary,
        message: `שכר גלובלי (יעד נטו): טבלה ₪${tableGlobal} נטו → בתלוש ברוטו ₪${payslip.base_salary} — לאמת חישוב גילום`,
      });
    }
    // Global OT: prefer the labelled extraction; fall back to amount-search
    // in payslip.items[] when the label was garbled (vendor font issue).
    if (table.global_ot_amount != null && table.global_ot_amount > 0) {
      let payslipOt = payslip.global_ot_amount;
      let usedFallback = false;
      if (payslipOt == null) {
        payslipOt = findClosestItemAmount(payslip.items, table.global_ot_amount);
        usedFallback = payslipOt != null;
      }
      if (payslipOt != null) {
        if (Math.abs(table.global_ot_amount - payslipOt) > 1) {
          findings.push({
            field: 'global_ot',
            severity: 'critical',
            expected: table.global_ot_amount,
            actual: payslipOt,
            message: `שעות נוספות גלובלי: טבלה ₪${table.global_ot_amount} | תלוש ₪${payslipOt} — סטייה ₪${(payslipOt - table.global_ot_amount).toFixed(2)}`,
          });
        }
        // expose the resolved value so the client diff can show it as matched
        if (usedFallback) payslip.global_ot_amount = payslipOt;
      } else {
        findings.push({
          field: 'global_ot.missing',
          severity: 'warning',
          expected: table.global_ot_amount,
          actual: null,
          message: `שעות נוספות גלובלי: בטבלה ₪${table.global_ot_amount} — לא נמצא בתלוש`,
        });
      }
    }
  }

  // Transport check — prefer labelled extraction; fall back to item-amount
  // search the same way as global_ot above.
  if (table.transport != null && table.transport > 0) {
    let payslipTransport = payslip.transport_value;
    let usedFallback = false;
    if (payslipTransport == null) {
      payslipTransport = findClosestItemAmount(payslip.items, table.transport);
      usedFallback = payslipTransport != null;
    }
    if (payslipTransport != null) {
      if (Math.abs(table.transport - payslipTransport) > 0.5) {
        findings.push({
          field: 'transport.mismatch',
          severity: 'critical',
          expected: table.transport,
          actual: payslipTransport,
          message: `נסיעות: טבלה ₪${table.transport} | תלוש ₪${payslipTransport} — סטייה ₪${(payslipTransport - table.transport).toFixed(2)}`,
        });
      }
      if (usedFallback) payslip.transport_value = payslipTransport;
    }
  }

  // Vacation directives
  if (d.zero_vacation) {
    // Single finding for the "לאפס חופשה" directive — combine the balance
    // and the usage checks so we don't surface the same problem twice.
    const bal = payslip.vacation.balance;
    const used = payslip.vacation.used;
    const balanceLeft = bal != null && bal > 1;
    const noZeroApplied = used != null && used <= 0;
    if (balanceLeft || noZeroApplied) {
      const parts = [];
      if (balanceLeft) parts.push(`יתרה בתלוש ${bal}`);
      if (noZeroApplied) parts.push(`ניצול בתלוש ${used == null ? '—' : used} (לא בוצע איפוס)`);
      findings.push({
        field: 'vacation.zero',
        severity: 'critical',
        expected: 0,
        actual: bal != null ? bal : used,
        message: `הוראה: לאפס חופשה — ${parts.join(' · ')}`,
      });
    }
  } else if (d.deduct_8_vacation) {
    if (payslip.vacation.used == null) {
      findings.push({
        field: 'vacation.deduct_8',
        severity: 'warning',
        expected: 8,
        actual: null,
        message: 'הוראה: להוריד 8 ימי חופשה — אך לא מצאתי ניצול בתלוש',
      });
    } else if (Math.abs(Math.abs(payslip.vacation.used) - 8) > 1) {
      findings.push({
        field: 'vacation.deduct_8',
        severity: 'critical',
        expected: 8,
        actual: payslip.vacation.used,
        message: `הוראה: להוריד 8 ימי חופשה — בתלוש נוצלו ${payslip.vacation.used}`,
      });
    } else {
      findings.push({
        field: 'vacation.deduct_8',
        severity: 'ok',
        expected: 8,
        actual: payslip.vacation.used,
        message: `הוראה: 8 ימי חופשה — נוצלו ${payslip.vacation.used} ✓`,
      });
    }
  }

  // Vacation column (table.vacation_days) — for hourly rows where leave is paid out
  if (table.vacation_days != null && payslip.vacation.used != null) {
    if (Math.abs(table.vacation_days - Math.abs(payslip.vacation.used)) > 1) {
      findings.push({
        field: 'vacation.days_col',
        severity: 'warning',
        expected: table.vacation_days,
        actual: payslip.vacation.used,
        message: `חופשה (עמודה): טבלה ${table.vacation_days} | תלוש ניצול ${payslip.vacation.used}`,
      });
    }
  }

  // Sick days
  if (table.sick_days != null && payslip.sick.used != null) {
    if (Math.abs(table.sick_days - payslip.sick.used) > 0.5) {
      findings.push({
        field: 'sick.days',
        severity: 'warning',
        expected: table.sick_days,
        actual: payslip.sick.used,
        message: `מחלה: טבלה ${table.sick_days} | תלוש ${payslip.sick.used}`,
      });
    }
    if (table.sick_days > 0) {
      const isGlobal = table.global_salary != null;
      findings.push({
        field: 'sick.payment_rule',
        severity: 'info',
        expected: isGlobal
          ? 'גלובלי: יום1 -100%, יום2 -50%, יום3 -50%'
          : 'שעתי: יום1 0%, ימים 2-3 50%, יום4+ 100%',
        actual: payslip.sick.used,
        message: `${table.sick_days} ימי מחלה — לוודא שורת תשלום/קיזוז מחלה לפי החוק (${isGlobal ? 'גלובלי' : 'שעתי'})`,
      });
    }
  }

  // Holiday pay (דמי חגים / "ימי חג"). The payslip item label is garbled in the
  // PDF text layer, so we match by AMOUNT — look for a payslip line whose amount
  // ≈ the expected holiday pay (days × daily value). Only runs when the system
  // supplies an expected amount (run-system mode); amount matching may not be
  // 100% precise (a same-amount line could be mistaken).
  if (table.holiday_pay_expected != null && table.holiday_pay_expected > 0) {
    const matchedHoliday = findClosestItemAmount(payslip.items, table.holiday_pay_expected);
    const daysTxt = table.holiday_days ? `, ${table.holiday_days} ימי חג` : '';
    if (matchedHoliday != null) {
      findings.push({
        field: 'holiday_pay',
        severity: 'ok',
        expected: table.holiday_pay_expected,
        actual: matchedHoliday,
        message: `דמי חגים: זוהה תשלום ≈ ₪${Math.round(matchedHoliday)} בתלוש (צפוי ₪${Math.round(table.holiday_pay_expected)}${daysTxt})`,
      });
    } else {
      findings.push({
        field: 'holiday_pay',
        severity: 'warning',
        expected: table.holiday_pay_expected,
        actual: null,
        message: `דמי חגים: צפוי ₪${Math.round(table.holiday_pay_expected)}${daysTxt} — לא זוהה תשלום תואם בתלוש (זיהוי לפי סכום)`,
      });
    }
  }

  // Transport — only emit the info-only "verify in payslip" finding when the
  // payslip side is missing (parser didn't extract). The actual mismatch
  // check above already covers the both-populated case.
  if (table.transport != null && table.transport > 0 && payslip.transport_value == null) {
    findings.push({
      field: 'transport',
      severity: 'info',
      expected: table.transport,
      actual: null,
      message: `נסיעות בטבלה: ${table.transport} — לאמת בתלוש`,
    });
  }

  // Cibus / recuperation
  if (table.cibus != null && table.cibus > 0) {
    findings.push({
      field: 'cibus',
      severity: 'info',
      expected: table.cibus,
      actual: null,
      message: `סיבוס/שווי ארוחות בטבלה: ${table.cibus}`,
    });
  }
  if (table.recuperation != null && table.recuperation > 0) {
    findings.push({
      field: 'recuperation',
      severity: 'info',
      expected: table.recuperation,
      actual: null,
      message: `הבראה בטבלה: ${table.recuperation}`,
    });
  }

  // Loan
  if (d.loan_payment_amount != null) {
    const matched = (payslip.voluntary_deductions || []).some((v) => approxEq(v.amount, d.loan_payment_amount, 1));
    const totalVol = (payslip.voluntary_deductions || []).reduce((s, v) => s + (v.amount || 0), 0);
    if (!matched) {
      findings.push({
        field: 'loan',
        severity: 'critical',
        expected: d.loan_payment_amount,
        actual: totalVol || null,
        message: `הוראה: החזר הלוואה ${d.loan_payment_amount} ש"ח (תשלום ${d.loan_payment_index}/${d.loan_payment_total}) — לא נמצא בניכויי רשות`,
      });
    } else {
      findings.push({
        field: 'loan',
        severity: 'ok',
        expected: d.loan_payment_amount,
        actual: d.loan_payment_amount,
        message: `החזר הלוואה ${d.loan_payment_amount} ש"ח — נוכה ✓`,
      });
    }
  }

  // Salary completion (השלמת שכר) — table notes specify how many hours of
  // completion are owed; the payslip should carry a "השלמת שכר" line with
  // matching qty. Critical if missing or short.
  if (d.salary_completion_hours != null) {
    const slip = payslip.salary_completion_hours;
    if (slip == null) {
      findings.push({
        field: 'salary_completion',
        severity: 'critical',
        expected: d.salary_completion_hours,
        actual: null,
        message: `הוראה: השלמת שכר ${d.salary_completion_hours} שעות — לא נמצא בתלוש`,
      });
    } else if (Math.abs(slip - d.salary_completion_hours) > 0.5) {
      findings.push({
        field: 'salary_completion',
        severity: 'critical',
        expected: d.salary_completion_hours,
        actual: slip,
        message: `הוראה: השלמת שכר ${d.salary_completion_hours} שעות — בתלוש ${slip.toFixed(2)} (חוסר ${(d.salary_completion_hours - slip).toFixed(2)})`,
      });
    } else {
      findings.push({
        field: 'salary_completion',
        severity: 'ok',
        expected: d.salary_completion_hours,
        actual: slip,
        message: `השלמת שכר ${d.salary_completion_hours} שעות — שולם בתלוש ✓`,
      });
    }
  }

  // Bonuses — verify against payslip line items. If a qty=1 lump-sum row
  // matches the expected bonus amount → ✓ ok; otherwise → critical (the
  // bonus was instructed but never paid).
  if (d.bonus_fixed != null) {
    const matched = findClosestItemAmount(payslip.items, d.bonus_fixed);
    if (matched != null && Math.abs(matched - d.bonus_fixed) <= 1) {
      findings.push({
        field: 'bonus.fixed',
        severity: 'ok',
        expected: d.bonus_fixed,
        actual: matched,
        message: `בונוס ${d.bonus_fixed} ש"ח — שולם בתלוש ✓`,
      });
    } else if (matched != null) {
      findings.push({
        field: 'bonus.fixed',
        severity: 'critical',
        expected: d.bonus_fixed,
        actual: matched,
        message: `הוראה: בונוס ${d.bonus_fixed} ש"ח — בתלוש ₪${matched} (סטייה ₪${(matched - d.bonus_fixed).toFixed(2)})`,
      });
    } else {
      findings.push({
        field: 'bonus.fixed',
        severity: 'critical',
        expected: d.bonus_fixed,
        actual: null,
        message: `הוראה: בונוס ${d.bonus_fixed} ש"ח — לא נמצא בתלוש`,
      });
    }
  }
  if (d.bonus_per_hour != null) {
    findings.push({
      field: 'bonus.per_hour',
      severity: 'info',
      expected: `${d.bonus_per_hour} × שעות`,
      actual: null,
      message: `הוראה: בונוס ${d.bonus_per_hour} ש"ח × שעות עבודה — לאמת בתלוש`,
    });
  }

  // Net target
  if (d.net_target != null && payslip.net_to_pay != null) {
    findings.push({
      field: 'net.target',
      severity: 'info',
      expected: `${d.net_target} נטו${d.net_target_includes_transport ? ' (כולל נסיעות)' : ''}`,
      actual: payslip.net_salary,
      message: `יעד נטו לפי טבלה: ${d.net_target}${d.net_target_includes_transport ? ' כולל נסיעות' : ''} — שכר נטו בתלוש: ${payslip.net_salary}`,
    });
  }

  // Pay-full-no-advance
  if (d.pay_full_no_advance) {
    const advance = (payslip.voluntary_deductions || []).find(
      (v) => v.description.includes('מקדמה') || v.description.includes('מפרעה')
    );
    if (advance && (advance.amount || 0) > 0) {
      findings.push({
        field: 'advance.should_not_deduct',
        severity: 'critical',
        expected: 0,
        actual: advance.amount,
        message: `הוראה: להפקיד שכר מלא, ללא קיזוז מקדמה — אך נוכה ${advance.amount}`,
      });
    } else {
      findings.push({
        field: 'advance.full_pay',
        severity: 'ok',
        expected: 0,
        actual: 0,
        message: 'שכר מלא ללא קיזוז מקדמה ✓',
      });
    }
  }

  return { matched: true, match_method: method, table_row: table, payslip, findings };
}

function comparePayslipsToTable(tableRows, payslips, cibusRows = []) {
  const matches = matchRows(tableRows, payslips);
  const cibusUnused = new Set(cibusRows || []);
  const results = [];
  const missing = [];
  const orphans = [];
  for (const m of matches) {
    if (m.table && m.payslip) {
      const result = compareOne(m.table, m.payslip, m.method);
      // Cibus cross-check — only if table column has a value AND we have a
      // matched Cibus row. Compare the Cibus monthly charge against the table
      // value; flag any difference.
      if (cibusUnused.size > 0) {
        const cibusRow = findCibusForResult(result, cibusUnused);
        if (cibusRow) {
          result.cibus_row = cibusRow;
          const tableCibus = m.table.cibus;
          const payslipMeal = m.payslip?.meal_value;

          // ── A. Cibus report ↔ table ──
          if (tableCibus != null && cibusRow.amount != null) {
            if (Math.abs(tableCibus - cibusRow.amount) > 0.5) {
              result.findings.push({
                field: 'cibus.report_vs_table',
                severity: 'critical',
                expected: cibusRow.amount,
                actual: tableCibus,
                message: `סיבוס (טבלה ↔ Pluxee): בדוח Pluxee ₪${cibusRow.amount}, בטבלה רשום ₪${tableCibus} — סטייה ₪${(cibusRow.amount - tableCibus).toFixed(2)}`,
              });
            } else {
              result.findings.push({
                field: 'cibus.report_vs_table',
                severity: 'ok',
                expected: cibusRow.amount,
                actual: tableCibus,
                message: `סיבוס: טבלה תואמת לדוח Pluxee (₪${cibusRow.amount}) ✓`,
              });
            }
          } else if (tableCibus == null && cibusRow.amount > 0) {
            // Skip the warning for hard-coded exempt managers — they intentionally
            // don't carry a cibus column in the table either.
            const exemptByNameForTable =
              isCibusExemptByName(m.table.employee_name) ||
              isCibusExemptByName(m.payslip.employee_name) ||
              parseNotes(m.table.notes).cibus_exempt;
            if (!exemptByNameForTable) {
              result.findings.push({
                field: 'cibus.missing_in_table',
                severity: 'warning',
                expected: cibusRow.amount,
                actual: null,
                message: `סיבוס: בדוח Pluxee חוייב ₪${cibusRow.amount} — לא נכלל בטבלה לרו"ח`,
              });
            }
          }

          // ── B. Cibus report ↔ payslip ──
          // The most important check — did the accountant actually pay the
          // cibus charge through the payslip? If Pluxee charged but the
          // payslip didn't include it, the employer paid but the employee
          // wasn't taxed/reimbursed correctly.
          // Manager exemption (notes carry "סיבוס לגן" / "סיבוס פטור" etc.):
          // managers use the Cibus card for kindergarten-operational expenses,
          // so the payslip should NOT carry שווי ארוחות. Surface as info-ok.
          // Re-derive directives from notes here — `d` from compareOne() is
          // not in this function's scope. Also check the hardcoded manager
          // exempt list so the user doesn't have to add a note every cycle.
          const cibusDirectives = parseNotes(m.table.notes);
          const exemptByName =
            isCibusExemptByName(m.table.employee_name) ||
            isCibusExemptByName(m.payslip.employee_name);
          if (cibusRow.amount != null) {
            if (cibusDirectives.cibus_exempt || exemptByName) {
              result.findings.push({
                field: 'cibus.manager_exempt',
                severity: 'ok',
                expected: cibusRow.amount,
                actual: payslipMeal,
                message: `סיבוס: בדוח Pluxee ₪${cibusRow.amount} — פטור (שימוש לצרכי הגן, ללא שווי ארוחות בתלוש) ✓`,
              });
            } else if (payslipMeal == null) {
              result.findings.push({
                field: 'cibus.missing_in_payslip',
                severity: 'critical',
                expected: cibusRow.amount,
                actual: null,
                message: `סיבוס: בדוח Pluxee חוייב ₪${cibusRow.amount} — אך אין שורת "שווי ארוחות" בתלוש`,
              });
            } else if (Math.abs(payslipMeal - cibusRow.amount) > 0.5) {
              result.findings.push({
                field: 'cibus.report_vs_payslip',
                severity: 'critical',
                expected: cibusRow.amount,
                actual: payslipMeal,
                message: `סיבוס (תלוש ↔ Pluxee): בתלוש ₪${payslipMeal}, בדוח Pluxee ₪${cibusRow.amount} — סטייה ₪${(cibusRow.amount - payslipMeal).toFixed(2)}`,
              });
            } else {
              result.findings.push({
                field: 'cibus.report_vs_payslip',
                severity: 'ok',
                expected: cibusRow.amount,
                actual: payslipMeal,
                message: `סיבוס: תלוש תואם לדוח Pluxee (₪${cibusRow.amount}) ✓`,
              });
            }
          }
        }
      }

      // ── C. Even without a Cibus report — if the table says cibus and the
      // payslip says meal_value, compare those two directly. This is the
      // basic "did the rate get to the slip" check that doesn't require
      // uploading the Pluxee report.
      if (m.payslip?.meal_value != null && m.table.cibus != null) {
        // Skip if we already added a Cibus-driven cibus.* finding (avoid duplication)
        const alreadyHaveCibusFinding = result.findings.some((f) => f.field?.startsWith('cibus.report_vs'));
        if (!alreadyHaveCibusFinding) {
          if (Math.abs(m.payslip.meal_value - m.table.cibus) > 0.5) {
            result.findings.push({
              field: 'cibus.table_vs_payslip',
              severity: 'critical',
              expected: m.table.cibus,
              actual: m.payslip.meal_value,
              message: `סיבוס (טבלה ↔ תלוש): בטבלה ₪${m.table.cibus}, בתלוש ₪${m.payslip.meal_value} — סטייה ₪${(m.payslip.meal_value - m.table.cibus).toFixed(2)}`,
            });
          }
        }
      }
      results.push(result);
    } else if (m.table && !m.payslip) {
      missing.push(m.table);
      results.push({
        matched: false,
        match_method: 'none',
        table_row: m.table,
        payslip: null,
        findings: [{
          field: 'missing_payslip',
          severity: 'critical',
          expected: 'תלוש',
          actual: null,
          message: 'תלוש חסר עבור עובד זה',
        }],
      });
    } else if (!m.table && m.payslip) {
      orphans.push(m.payslip);
      results.push({
        matched: false,
        match_method: 'none',
        table_row: null,
        payslip: m.payslip,
        findings: [{
          field: 'orphan_payslip',
          severity: 'warning',
          expected: null,
          actual: m.payslip.employee_name,
          message: 'תלוש קיים — אך אין שורה תואמת בטבלה',
        }],
      });
    }
  }
  const ymPayslip = payslips.find((p) => p.year_month);
  return {
    year_month: ymPayslip ? ymPayslip.year_month : null,
    table_sheet_name: null,
    branch_filter: null,
    rows_in_table: tableRows.length,
    payslips_in_pdf: payslips.length,
    results,
    missing_payslips: missing,
    orphan_payslips: orphans,
    // Cibus rows that didn't match any employee — surfaced as orphans so the
    // user knows about charges Pluxee made for people not in the table at all.
    orphan_cibus_rows: [...cibusUnused],
  };
}

module.exports = { comparePayslipsToTable, parseNotes };
