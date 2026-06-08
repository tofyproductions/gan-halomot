/**
 * Payslip PDF parser.
 *
 * The Israeli payroll vendor (ט.מ.ל.) emits PDFs whose Hebrew labels are
 * partially garbled by the embedded font (e.g. `¬"ª»` instead of `ניכויי רשות`),
 * but numbers and a handful of un-encoded Hebrew anchors survive. We slice
 * each page on those anchors and pull out the fields we need.
 *
 * Returns one ParsedPayslip per page.
 */

let _PDFParse = null;
async function loadPDFParse() {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = mod.PDFParse || mod.default;
  if (!_PDFParse) throw new Error('pdf-parse: missing PDFParse export');
  return _PDFParse;
}

const COMPANY_TAX_ID = '924687999'; // עמותת גן החלומות — exclude from employee-id matching

function num(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parsePage(rawText, pageIndex) {
  const text = rawText;
  const result = {
    page_index: pageIndex + 1,
    employee_no: null,
    employee_name: null,
    employee_id: null,
    year_month: null,
    branch_address: null,
    paid_days: null,
    actual_days: null,
    paid_hours: null,
    actual_hours: null,
    daily_rate: null,
    hourly_rate: null,
    base_salary: null,
    items: [],
    mandatory_deductions: [],
    voluntary_deductions: [],
    // Specific extracted line items — pulled out so the comparator doesn't
    // have to re-search the raw text. Both are nullable when not present.
    meal_value: null,        // שווי ארוחות / סיבוס — what the payslip actually paid
    vehicle_value: null,     // שווי שימוש ברכב
    transport_value: null,   // נסיעות — travel reimbursement
    // Hours worked from line-item qty (more reliable than the header for
    // hourly employees — those show 0/0 in the header but qty in items).
    item_regular_hours: null,    // שכר יסוד qty
    item_ot_125_hours: null,     // שעות נוספות 125% qty
    item_ot_150_hours: null,     // שעות נוספות 150% qty
    item_base_amount: null,      // שכר יסוד amount (fallback for base_salary)
    global_ot_amount: null,      // שעות נוספות (גלובלי) amount — qty=1 row
    salary_completion_hours: null, // השלמת שכר qty — hours added as completion
    total_payments: null,
    total_deductions: null,
    net_salary: null,
    net_to_pay: null,
    vacation: { prev_balance: null, used: null, balance: null },
    sick: { prev_balance: null, used: null, balance: null },
    raw_text: text,
  };

  // 1. Year/month: "4/2026"
  const ym = text.match(/(\d{1,2})\/(\d{4})/);
  if (ym) result.year_month = `${ym[2]}-${ym[1].padStart(2, '0')}`;

  // 2. Employee ID: pick first 9-digit ID that isn't the company tax file
  const ids = text.match(/\b\d{9}\b/g) || [];
  result.employee_id = ids.find((id) => id !== COMPANY_TAX_ID) || ids[0] || null;

  // 3. Employee name: between the "ש ח י " marker and the next digit
  const nameLine = text.match(/ש\s*ח\s*י\s+([^\n\t\d]{1,40}?)\s+\d/);
  if (nameLine) result.employee_name = nameLine[1].replace(/\s+/g, ' ').trim();

  // 4. Employee number — the small index after name, before tab+ID
  const empNo = text.match(/ש\s*ח\s*י\s+[^\n\t\d]{1,40}?\s+\d+\s+(\d+)\s*\t/);
  if (empNo) result.employee_no = num(empNo[1]);

  // 5. Branch address line
  const addr = text.match(/(\d+\/\d{4})\s+([^\n]+(?:כפר סבא|הרצליה|תל אביב|ראשון|רעננה|נתניה)[^\n]*)/);
  if (addr) {
    result.branch_address = addr[2].trim();
  } else {
    const fb = text.match(/([^\n]*(?:כפר סבא|הרצליה|תל אביב|ראשון|רעננה|נתניה)[^\n]*)/);
    if (fb) result.branch_address = fb[1].replace(/\s+/g, ' ').trim();
  }

  // 6. Header row: "<account> <branch_no> <bank> <hours_a>[/<hours_b>] <days_a>[/<days_b>] <hourly> <daily> <base>"
  const headerRe = /(\d{2,8})\s+(\d{1,4})\s+(\d{1,3})\s+(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?\s+(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/;
  const h = text.match(headerRe);
  if (h) {
    const hoursA = num(h[4]);
    const hoursB = num(h[5]);
    const daysA = num(h[6]);
    const daysB = num(h[7]);
    if (hoursB != null) {
      result.paid_hours = hoursA;
      result.actual_hours = hoursB;
    } else {
      result.paid_hours = hoursA;
    }
    if (daysB != null) {
      result.paid_days = daysA;
      result.actual_days = daysB;
    } else {
      result.paid_days = daysA;
    }
    result.hourly_rate = num(h[8]);
    result.daily_rate = num(h[9]);
    result.base_salary = num(h[10]);
  }

  // 7. Six totals (חייב מ.ה. / חייב ב.ל. / סה"כ תשלומים / סה"כ ניכויים / נטו / נטו לתשלום)
  // appear as a sequence of numeric lines just above the "באמצעות שיקלולית" footer.
  const footerAt = text.indexOf('באמצעות שיקלולית');
  if (footerAt > 0) {
    const window = text.slice(Math.max(0, footerAt - 800), footerAt);
    const lines = window.split('\n').map((l) => l.trim()).filter(Boolean);
    const numericLines = [];
    for (let i = 0; i < lines.length; i++) {
      // Leading number with optional trailing text on same line
      const m = lines[i].match(/^([\d,]+(?:\.\d+)?)(?=\s|$)/);
      if (m) {
        const v = num(m[1]);
        if (v !== null) numericLines.push({ num: v, idx: i });
      }
    }
    // First 6 numeric lines after the "ל" marker (מצב משפחתי flag)
    const lamedIdx = lines.findIndex((l) => l === 'ל');
    const startIdx = lamedIdx >= 0 ? lamedIdx + 1 : 0;
    const filtered = numericLines.filter((nl) => nl.idx >= startIdx);
    if (filtered.length >= 6) {
      const six = filtered.slice(0, 6).map((x) => x.num);
      result.total_payments = six[2] ?? null;
      result.total_deductions = six[3] ?? null;
      result.net_salary = six[4] ?? null;
      result.net_to_pay = six[5] ?? null;
    }
  }

  // 8. Voluntary deductions (מקדמה / מפרעה). Best-effort: capture the first
  // numeric token after each label marker. The two label markers are garbled
  // but stable: ª≈∫œ≈ = מקדמה, ª…–Ã≈ = מפרעה.
  const voluntary = [];
  const ruchotMarker = '¬"ª»';
  const advanceMarker = 'ª≈∫œ≈';
  const mifraaMarker = 'ª…–Ã≈';
  const ruchotIdx = text.indexOf(ruchotMarker);
  if (ruchotIdx >= 0) {
    const before = text.slice(Math.max(0, ruchotIdx - 200), ruchotIdx);
    const lines = before.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    const m = last && last.match(/^([\d,]+(?:\.\d+)?)/);
    if (m) voluntary.push({ description: 'סה"כ ניכויי רשות', amount: num(m[1]) });
  }
  const mifraaAt = text.indexOf(mifraaMarker);
  if (mifraaAt > 0) {
    const after = text.slice(mifraaAt, mifraaAt + 80);
    const m = after.match(/[\t\s]([\d,]+(?:\.\d+)?)/);
    if (m) voluntary.push({ description: 'מפרעה', amount: num(m[1]) });
  }
  const advanceAt = text.indexOf(advanceMarker);
  if (advanceAt > 0) {
    const after = text.slice(advanceAt, advanceAt + 80);
    const m = after.match(/[\t\s]([\d,]+(?:\.\d+)?)/);
    if (m) voluntary.push({ description: 'מקדמה', amount: num(m[1]) });
  }
  result.voluntary_deductions = voluntary;

  // 8b. Specific item lines — meal value (שווי ארוחות) and vehicle value
  //     (שווי שימוש ברכב). The Hebrew labels are garbled by the embedded font
  //     but the byte sequences are stable across all payslips from this vendor.
  //     We also fall back to clean Hebrew if a future export decodes properly.
  //
  //     Format observed on every payslip:
  //         <amount> 1.00 <garbled-prefix> ¿ºº—
  //     where ¿ºº— is the consistent suffix for "שווי" and the prefix
  //     identifies the specific benefit:
  //         "ºæº–∑ ¿ºº—  → שווי ארוחות / סיבוס
  //         —º≈¿— ¿ºº—  → שווי שימוש ברכב
  const MEAL_GARBLED   = '“ºæº–∑ ¿ºº—';
  const VEHICLE_GARBLED = '—º≈¿— ¿ºº—';

  // The same item appears in TWO column orientations across payslips:
  //   format A:  "<amount> 1.00 <label>"           (amount-first)
  //   format B:  "<label>\t1.00\t<amount>"          (amount-last, tab-separated)
  // For format B, the trailing currency may also include trailing chars
  // (e.g. ".00" or whole-number). We try both and prefer the explicit "1.00"
  // anchor so we don't pick up unrelated numbers from neighboring text.
  function findValueForLabel(label) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.includes(label)) continue;
      // A: amount before "1.00 <label>"
      const a = line.match(/([\d,]+\.\d+)\s+1\.00\s+/);
      if (a) return num(a[1]);
      // B: "<label>\t1.00\t<amount>"
      const b = line.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[\\t\\s]+1\\.00\\s*[\\t\\s]+([\\d,]+(?:\\.\\d+)?)'));
      if (b) return num(b[1]);
      // Last resort: any decimal number on the same line
      const c = line.match(/([\d,]+\.\d+)/);
      if (c) return num(c[1]);
    }
    return null;
  }
  result.meal_value =
    findValueForLabel(MEAL_GARBLED) ??
    findValueForLabel('שווי ארוחות') ??
    findValueForLabel('סיבוס');
  result.vehicle_value =
    findValueForLabel(VEHICLE_GARBLED) ??
    findValueForLabel('שווי שימוש ברכב');

  // Transport (נסיעות) appears as either an item line or — more commonly for
  // this vendor — a row of three identical money columns:
  //     "<amount> 1.00 <amount> <amount> <garbled-נסיעות>"
  // The label survives partially as plain Hebrew "נסיעות" on some pages, so
  // we try the clean label first, then a numeric-pattern fallback.
  function findTransport() {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    // Plain Hebrew label preserved
    for (const line of lines) {
      if (!line.includes('נסיעות')) continue;
      // Try amount-first: "<amount> 1.00 ... נסיעות"
      const a = line.match(/([\d,]+\.\d+)\s+1\.00/);
      if (a) return num(a[1]);
      // Try amount-last: "נסיעות ... <amount>"
      const b = line.match(/נסיעות\s*[\t\s]+.*?([\d,]+(?:\.\d+)?)/);
      if (b) return num(b[1]);
    }
    return null;
  }
  result.transport_value = findTransport();

  // 8c. Hourly line-items (qty column). Hourly employees show 0/0 in the
  //     header — their actual hours live in the line items:
  //         שכר יסוד    →  "<amount> <rate> <qty> <garbled-label>"     (format A)
  //         שעות 125%   →  "125% <garbled>\t<qty>\t<rate>\t<amount>"   (format B)
  //         שעות 150%   →  "150% <garbled>\t<qty>\t<rate>\t<amount>"   (format B)
  //     Identity that lets us trust the parse: amount ≈ rate * qty.
  function extractItemHours() {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let regHours = null;
    let regAmount = null;
    let ot125Hours = null;
    let ot150Hours = null;
    let globalOtAmount = null;

    // Helper — extract every decimal number from a line, in order.
    function extractNumbers(line) {
      const out = [];
      const re = /([\d,]+\.\d+)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const n = num(m[1]);
        if (n != null) out.push(n);
      }
      return out;
    }
    // For an item line, find the (rate, qty, amount) triple by anchoring on
    // a known rate (header.hourly_rate or per-OT rate). The PDF can include
    // an extra "נטו לגילום" column making the line have 4 numbers instead
    // of 3 — anchoring on the rate handles either case.
    function findRateQtyAmount(line, expectedRate) {
      const nums = extractNumbers(line);
      if (nums.length < 3) return null;
      // Find rate position; the qty is the number AFTER it. The amount is
      // typically the LAST number on the line (gross/total payment column).
      for (let i = 0; i < nums.length; i++) {
        if (Math.abs(nums[i] - expectedRate) < 0.5) {
          const q = nums[i + 1];
          if (q == null || q <= 0) continue;
          const a = nums[nums.length - 1];
          return { rate: nums[i], qty: q, amount: a };
        }
      }
      return null;
    }

    // OT 125% / 150% — explicit ASCII anchors at line start.
    for (const line of lines) {
      const m125Prefix = line.match(/^125%[^\d]*?([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)/);
      if (m125Prefix && ot125Hours == null) {
        const q = num(m125Prefix[1]); const r = num(m125Prefix[2]); const a = num(m125Prefix[3]);
        if (q != null && r != null && a != null && Math.abs(q * r - a) < 1) ot125Hours = q;
      }
      const m150Prefix = line.match(/^150%[^\d]*?([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)/);
      if (m150Prefix && ot150Hours == null) {
        const q = num(m150Prefix[1]); const r = num(m150Prefix[2]); const a = num(m150Prefix[3]);
        if (q != null && r != null && a != null && Math.abs(q * r - a) < 1) ot150Hours = q;
      }
    }

    // שכר יסוד — anchor on header.hourly_rate. The line can have 3 or 4
    // numbers depending on whether the "נטו לגילום" gross-up column is
    // populated. We do NOT require amount ≈ rate * qty: gross-up legitimately
    // breaks that identity (לימור: amount=3943 vs 60·60=3600).
    for (const line of lines) {
      if (/^(125%|150%)/.test(line)) continue;
      // Hourly case — anchor on header rate
      if (result.hourly_rate != null && result.hourly_rate > 0) {
        const hit = findRateQtyAmount(line, result.hourly_rate);
        if (hit && hit.qty > 0) {
          regHours = hit.qty;
          regAmount = hit.amount;
          break;
        }
      } else {
        // Global lump-sum case — qty=1 and rate=amount (identity holds).
        const m = line.match(/^([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\b/);
        if (!m) continue;
        const a = num(m[1]); const r = num(m[2]); const q = num(m[3]);
        if (a == null || r == null || q == null) continue;
        if (Math.abs(q - 1) < 0.01 && Math.abs(a - r) < 1) {
          regHours = q;
          regAmount = a;
          break;
        }
      }
    }

    // Re-attempt OT 125% / 150% with an ORDER-INDEPENDENT matcher. The OT line
    // can appear either "125% <qty> <rate> <amount>" (label first) OR
    // "<amount> <rate> <qty> 150%" (numbers first) — different vendors / pages
    // emit different orders. We find the (qty, rate, amount) triple where
    // qty*rate ≈ amount, then disambiguate qty-vs-rate using the expected OT
    // rate (base hourly × multiplier); the smaller value is the qty otherwise.
    const otHoursFromLines = (mult) => {
      const tag = mult === 1.25 ? '125%' : '150%';
      const expRate = (result.hourly_rate && result.hourly_rate > 0) ? result.hourly_rate * mult : null;
      for (const line of lines) {
        if (!line.includes(tag)) continue;
        const nums = extractNumbers(line);
        if (nums.length < 2) continue;
        const amount = Math.max(...nums);
        for (let i = 0; i < nums.length; i++) {
          for (let j = 0; j < nums.length; j++) {
            if (i === j) continue;
            const q = nums[i], r = nums[j];
            if (q > 0 && r > 0 && q < 400 && Math.abs(q * r - amount) < 1.5) {
              if (expRate != null) {
                if (Math.abs(r - expRate) < 2) return q;
                if (Math.abs(q - expRate) < 2) return r;
              }
              return Math.min(q, r); // hours are usually the smaller of the two
            }
          }
        }
      }
      return null;
    };
    if (ot125Hours == null) ot125Hours = otHoursFromLines(1.25);
    if (ot150Hours == null) ot150Hours = otHoursFromLines(1.50);

    // Global שעות נוספות — for global employees this is a lump-sum row with
    // qty=1, e.g. "<amount> 1.00 <amount>" or amount-last variant. Different
    // from per-hour OT (125%/150%). We detect by looking for plain Hebrew
    // "שעות נוספות" label OR a remaining unmatched qty=1 row whose amount
    // isn't already accounted for by שכר יסוד / שווי / נסיעות.
    for (const line of lines) {
      if (!line.includes('שעות נוספות')) continue;
      // Skip per-hour OT (those start with 125%/150%)
      if (/^(125%|150%)/.test(line)) continue;
      // amount-first: "<amount> <rate> <qty>"  with qty == 1
      const a = line.match(/([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+1\.00\b/);
      if (a) { globalOtAmount = num(a[1]); break; }
      // amount-last: "שעות נוספות 1.00 <rate> <amount>"
      const b = line.match(/שעות\s*נוספות\s*[\t\s]+1\.00\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)/);
      if (b) { globalOtAmount = num(b[2]); break; }
    }

    // השלמת שכר — separate line, same rate as שכר יסוד. Qty = hours added.
    // Detect by the plain Hebrew label when present (rate alone could match
    // multiple lines).
    let completionHours = null;
    for (const line of lines) {
      if (!/השלמת\s*שכר/.test(line)) continue;
      // Try the rate-anchored matcher (handles 3- and 4-number layouts)
      if (result.hourly_rate != null && result.hourly_rate > 0) {
        const hit = findRateQtyAmount(line, result.hourly_rate);
        if (hit && hit.qty > 0) { completionHours = hit.qty; break; }
      }
      // Fallback — last numeric token before the label is usually qty
      const nums = (line.match(/[\d,]+\.\d+/g) || []).map((s) => Number(s.replace(/,/g, '')));
      if (nums.length >= 1) { completionHours = nums[nums.length - 1]; break; }
    }

    return { regHours, regAmount, ot125Hours, ot150Hours, globalOtAmount, completionHours };
  }

  // Generic lump-sum item extractor — captures EVERY qty=1.00 line in the
  // payments table, even when the Hebrew label is garbled by the embedded
  // font. Each item is just { amount, rate }. The comparator uses this list
  // to find a payslip amount matching a table-expected value (e.g. when the
  // label-based "transport" / "global_ot" extractors miss because the label
  // garbles to something we don't recognise).
  function extractAllLumpSumItems() {
    const items = [];
    const seen = new Set();
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Skip per-hour OT (those have qty != 1.00 typically)
      if (/^(125%|150%)/.test(line)) continue;
      // Pattern A — amount-first: "<amount> <rate> 1.00 [label]"
      const a = line.match(/(?<![\d.])([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+1\.00\b/);
      if (a) {
        const amount = num(a[1]); const rate = num(a[2]);
        if (amount != null && rate != null && Math.abs(amount - rate) < 1 && amount > 0) {
          const key = `${amount.toFixed(2)}`;
          if (!seen.has(key)) { items.push({ amount, rate }); seen.add(key); }
        }
      }
      // Pattern B — amount-last: "[label] 1.00 <rate> <amount>"
      const b = line.match(/(?:^|\s)1\.00\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)(?![\d.])/);
      if (b) {
        const rate = num(b[1]); const amount = num(b[2]);
        if (amount != null && rate != null && Math.abs(amount - rate) < 1 && amount > 0) {
          const key = `${amount.toFixed(2)}`;
          if (!seen.has(key)) { items.push({ amount, rate }); seen.add(key); }
        }
      }
    }
    return items;
  }
  const itemHours = extractItemHours();
  result.item_regular_hours = itemHours.regHours;
  result.item_ot_125_hours = itemHours.ot125Hours;
  result.item_ot_150_hours = itemHours.ot150Hours;
  result.item_base_amount = itemHours.regAmount;
  result.global_ot_amount = itemHours.globalOtAmount;
  result.salary_completion_hours = itemHours.completionHours;
  result.items = extractAllLumpSumItems();
  // If the header parser didn't find a base_salary (some PDF layouts), fall
  // back to the שכר יסוד line-item amount.
  if (result.base_salary == null && result.item_base_amount != null) {
    result.base_salary = result.item_base_amount;
  }

  // Base-salary candidate amounts. The שכר-יסוד line carries several money
  // columns (סכום התשלום, נטו לגילום, שכר לקופ"ג). The system's "שכר בסיס"
  // (regular pay) matches the נטו-לגילום column, NOT necessarily the one we
  // pick as base_salary — so expose every big number on that line and let the
  // comparator match against any. The line is identified by the garbled
  // "שכר יסוד" signature this vendor emits ("—¬–").
  // The base line is identified STRUCTURALLY (the garbled "שכר יסוד" label
  // varies between PDF text engines): it carries 2+ big money columns
  // (סכום התשלום / נטו-לגילום / שכר-לקופ"ג) and ENDS with the small אחוז-משרה
  // decimal (0 < x ≤ 1.5), e.g. "7,238.00 6,369.00 8,500.00 0.75". We expose all
  // big numbers so the comparator can match our שכר בסיס against any column.
  result.base_salary_candidates = [];
  for (const line of text.split('\n')) {
    const nums = (line.match(/[\d,]+\.\d+/g) || []).map((s) => num(s)).filter((n) => n != null);
    if (nums.length < 3) continue;
    const last = nums[nums.length - 1];
    const bigs = nums.filter((n) => n >= 100);
    if (last > 0 && last <= 1.5 && bigs.length >= 2) {
      result.base_salary_candidates = [...new Set(bigs)];
      break;
    }
  }
  if (result.base_salary != null && !result.base_salary_candidates.includes(result.base_salary)) {
    result.base_salary_candidates.push(result.base_salary);
  }

  // 9. Vacation/sick balances. Empirical layout immediately before "חופש\n":
  //    <vacation.balance> <sick.used> <vacation.used> <accrual>
  // Then later: "<sick.prev>\n:\n<vacation.prev>" near the "צבירת חופש" anchor.
  // Vacation.used loses its sign in the PDF text — we recover it via:
  //   used = prev + accrual − balance
  let accrual = null;
  // Match "חופש" not followed by another Hebrew letter so we don't capture
  // the substring inside "חופשה" (תמורת חופשה appears earlier in items). Some
  // pages put space/tab/CRLF after the label rather than a bare "\n", so the
  // old `text.indexOf('חופש\n')` missed valid pages (e.g. טניה אהרון).
  const vacAnchorMatch = text.match(/חופש(?![א-ת])/);
  const vacAnchor = vacAnchorMatch ? vacAnchorMatch.index : -1;
  if (vacAnchor > 0) {
    const before = text.slice(Math.max(0, vacAnchor - 200), vacAnchor);
    const tokens = before.split('\n').map((l) => l.trim()).filter(Boolean);
    const numericTokens = [];
    for (let i = tokens.length - 1; i >= 0 && numericTokens.length < 8; i--) {
      const t = tokens[i];
      if (/^-?[\d,]+(?:\.\d+)?$/.test(t)) numericTokens.unshift(num(t));
    }
    if (numericTokens.length >= 4) {
      const last4 = numericTokens.slice(-4);
      result.vacation.balance = last4[0];
      result.sick.used = last4[1];
      result.vacation.used = last4[2];
      accrual = last4[3];
    }
  }
  const colonAt = text.indexOf('צבירת חופש');
  if (colonAt > 0) {
    const after = text.slice(colonAt, colonAt + 200);
    // Allow negative prev_balance (e.g. טניה אהרון: vacation prev = -1).
    const m = after.match(/(-?\d+(?:\.\d+)?)\s*\n\s*:\s*\n\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      result.sick.prev_balance = num(m[1]);
      result.vacation.prev_balance = num(m[2]);
    }
  }
  // Sign-recovery: the PDF font intermittently drops minus signs from
  // vacation values. We have one constant we trust:
  //   accrual is monthly accrual, always ≥ 0.
  // And the identity:  prev + accrual − balance = used  always holds.
  //
  // Each of prev / balance / used can independently be negative:
  //   - prev negative  → over-used employee (deficit balance carried over).
  //   - balance negative → still in deficit after this month's accrual.
  //   - used negative  → correction REVERSING a prior month's deduction
  //                      (e.g. אורלי מור: 32.33+1.17-67=-33.5).
  //
  // Strategy:
  //   1. If prev + balance + used + accrual all extracted → try all 8 sign
  //      combos of (prev, balance, used) and accept the one matching the
  //      identity. This covers every real-world case without per-employee
  //      tweaks (negative prev, negative balance, negative-correction used).
  //   2. If prev is missing (no "צבירת חופש" anchor) we can't run the
  //      identity — keep raw extracted values (caller relies on the 60-day
  //      sanity guard below to drop garbage).
  //   3. If the identity doesn't resolve in any combo, the parser grabbed
  //      wrong numbers — null out balance (don't trust) and keep |used| as
  //      best-effort, since the comparator usually compares against |used|.
  const round2 = (n) => Math.round(n * 100) / 100;
  if (result.vacation.used != null) {
    const prev = result.vacation.prev_balance;
    const balanceRaw = result.vacation.balance;
    const usedRaw = result.vacation.used;
    let resolved = false;
    if (prev != null && balanceRaw != null && accrual != null) {
      const prevMag = Math.abs(prev);
      const balanceMag = Math.abs(balanceRaw);
      const usedMag = Math.abs(usedRaw);
      const signs = [+1, -1];
      for (const sP of signs) {
        for (const sB of signs) {
          for (const sU of signs) {
            const p = sP * prevMag;
            const b = sB * balanceMag;
            const u = sU * usedMag;
            if (Math.abs((p + accrual - b) - u) < 0.5) {
              result.vacation.prev_balance = round2(p);
              result.vacation.balance = round2(b);
              result.vacation.used = round2(u);
              resolved = true;
              break;
            }
          }
          if (resolved) break;
        }
        if (resolved) break;
      }
    }
    if (!resolved && prev != null && balanceRaw != null && accrual != null) {
      // Identity ran but no combo matched → wrong extraction. Trust |used|
      // (commonly compared as Math.abs in the comparator) and null balance.
      result.vacation.used = round2(Math.abs(usedRaw));
      result.vacation.balance = null;
    }
    // If prev was missing, leave raw values alone — better than nothing.
  }
  // Final sanity guard: vacation days can't realistically exceed ~60 in any
  // direction (max accrual is ~26 days/year). Out-of-range = parser grabbed
  // a number from elsewhere in the PDF — drop it rather than report garbage.
  if (result.vacation.used != null && Math.abs(result.vacation.used) > 60) {
    result.vacation.used = null;
  }
  if (result.vacation.balance != null && Math.abs(result.vacation.balance) > 60) {
    result.vacation.balance = null;
  }

  return result;
}

/**
 * Parse a payslip PDF.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ payslips: ParsedPayslip[], total_pages: number }>}
 */
async function parsePayslipsPdf(buffer) {
  const PDFParse = await loadPDFParse();
  const parser = new PDFParse({ data: buffer });
  const r = await parser.getText();
  const payslips = [];
  for (let i = 0; i < r.pages.length; i++) {
    const page = r.pages[i];
    const text = typeof page === 'string' ? page : page.text || '';
    if (!text) continue;
    payslips.push(parsePage(text, i));
  }
  return { payslips, total_pages: r.pages.length };
}

module.exports = { parsePayslipsPdf };
