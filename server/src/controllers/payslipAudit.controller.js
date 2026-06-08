/**
 * Payslip audit controller — accepts uploaded xlsx (salary table) and PDF
 * (vendor-emitted payslips), returns a structured comparison report.
 *
 * No DB persistence — the audit is a stateless operation on the two input
 * files. (When the salary table is eventually generated from the system itself,
 * the xlsx upload will be replaced by reading the same data from MongoDB.)
 */

const fs = require('fs');
const path = require('path');
const { parseSalaryTable } = require('../services/payslipAudit/xlsxParser');
const { parsePayslipsPdf } = require('../services/payslipAudit/pdfParser');
const { comparePayslipsToTable } = require('../services/payslipAudit/comparator');
const { parseCibusReport } = require('../services/payslipAudit/cibusParser');
const { buildAuditEmailHtml, buildAuditEmailText } = require('../services/payslipAudit/emailBuilder');
const { dispatchEmail } = require('../services/email.service');

// Persisted payslip PDFs — needed by the per-employee preview endpoint so we
// can extract a single page from the original PDF on demand. Path layout:
//   <dataDir>/payslip-audits/<auditId>/<branchSlug>.pdf
const PDF_STORAGE_DIR = path.join(
  process.env.DATA_DIR || path.resolve(__dirname, '../../../data'),
  'payslip-audits'
);
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function branchSlug(s) {
  return (s || 'unknown').replace(/\s+/g, '_').replace(/[^\wא-ת._-]/g, '');
}
function pdfStoragePath(auditId, branch) {
  return path.join(PDF_STORAGE_DIR, String(auditId), `${branchSlug(branch)}.pdf`);
}
function approvedPdfStoragePath(auditId, branch) {
  return path.join(PDF_STORAGE_DIR, String(auditId), 'approved', `${branchSlug(branch)}.pdf`);
}
const { PayslipAuditRecord, Employee, PayrollMonth } = require('../models');
// Reused to build the "table" side from the in-system computed salary data,
// so the audit can run against the system table (payslips-only upload).
const { getMonth } = require('./payrollMonth.controller');

/**
 * After an audit run completes, copy vacation balance from each parsed
 * payslip into PayrollMonth.vacation_balance_from_payslip for the same
 * (employee, year_month). Matches by israeli_id first, falls back to
 * employee name token overlap on the same branch.
 *
 * Failure here is logged but never blocks the audit itself.
 */
async function syncVacationBalances(audit) {
  if (!audit || !audit.year_month) return;
  const month = audit.year_month;
  for (const r of audit.results || []) {
    try {
      const balance = r?.payslip?.vacation?.balance;
      if (balance == null) continue;
      const israeliId = r.payslip?.employee_id;
      let emp = null;
      if (israeliId) {
        emp = await Employee.findOne({ israeli_id: israeliId }).select('_id branch_id').lean();
      }
      if (!emp) continue; // skip ambiguous matches — only ID-grounded sync
      await PayrollMonth.findOneAndUpdate(
        { employee_id: emp._id, month },
        {
          $set: {
            vacation_balance_from_payslip: balance,
            vacation_balance_recorded_at: new Date(),
          },
          $setOnInsert: { branch_id: emp.branch_id, employee_id: emp._id, month },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error('syncVacationBalances row failed:', err.message);
    }
  }
}

const ACCOUNTANT_EMAIL = 'efraim@dy-cpa.co.il';
const OFFICE_EMAIL = 'tofy10.office@gmail.com';

/** Pre-aggregate severity counts so the history list doesn't need full_result. */
function summarizeAudit(audit) {
  let critical = 0, warning = 0;
  for (const r of audit.results || []) {
    for (const f of r.findings || []) {
      if (f.severity === 'critical') critical++;
      else if (f.severity === 'warning') warning++;
    }
  }
  return {
    rows_in_table: audit.rows_in_table || 0,
    payslips_in_pdf: audit.payslips_in_pdf || 0,
    critical_count: critical,
    warning_count: warning,
    missing_count: (audit.missing_payslips || []).length,
    orphan_count: (audit.orphan_payslips || []).length,
  };
}

/** Persist an audit run with metadata, return the saved doc. Best-effort —
 * never throws back to the request handler so a DB hiccup doesn't make the
 * audit itself fail. */
async function persistAudit({ audit, user, table_filename, payslip_files, branches }) {
  try {
    const doc = await PayslipAuditRecord.create({
      created_by: user?.id || null,
      created_by_name: user?.full_name || '',
      year_month: audit.year_month || null,
      table_sheet_name: audit.table_sheet_name || null,
      branches: branches || [],
      table_filename: table_filename || '',
      payslip_files: payslip_files || [],
      summary: summarizeAudit(audit),
      full_result: audit,
    });
    return doc;
  } catch (err) {
    console.error('persistAudit failed:', err.message);
    return null;
  }
}

function takeOptions(req) {
  return {
    sheetName: typeof req.body?.sheet_name === 'string' ? req.body.sheet_name : undefined,
    branchFilter:
      typeof req.body?.branch_filter === 'string' && req.body.branch_filter.trim()
        ? req.body.branch_filter.trim()
        : undefined,
  };
}

async function parseTable(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'לא נבחר קובץ' });
  }
  try {
    const opts = takeOptions(req);
    const result = parseSalaryTable(req.file.buffer, { sheetName: opts.sheetName, branchFilter: opts.branchFilter });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ אקסל' });
  }
}

async function parsePayslips(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'לא נבחר קובץ' });
  }
  try {
    const result = await parsePayslipsPdf(req.file.buffer);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ PDF' });
  }
}

/** Drop the noisy `raw_text` field from every payslip — it's only useful for
 * server-side debugging and contains control characters that break JSON
 * round-tripping when the client posts the audit back to /email. */
function stripRawText(audit) {
  for (const r of audit.results || []) {
    if (r.payslip) delete r.payslip.raw_text;
  }
  for (const p of audit.orphan_payslips || []) {
    delete p.raw_text;
  }
}

/** List unique branches in the xlsx — used by the UI to populate the per-file
 * branch dropdown when uploading multiple PDFs. */
function listBranches(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'לא נבחר קובץ' });
  }
  try {
    const sheet = typeof req.body?.sheet_name === 'string' ? req.body.sheet_name : undefined;
    const result = parseSalaryTable(req.file.buffer, { sheetName: sheet });
    const branches = [...new Set(result.rows.map((r) => r.branch).filter(Boolean))];
    res.json({
      sheet_name: result.sheet_name,
      available_sheets: result.available_sheets,
      branches,
      total_rows: result.rows.length,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'שגיאה בקריאת קובץ אקסל' });
  }
}

/**
 * Multi-file audit: one xlsx + N PDFs, each PDF tagged with the branch it
 * belongs to. We parse the xlsx once, then run a per-branch audit for each PDF
 * and merge the results into a single AuditResult.
 *
 * Form fields:
 *   - table_file:        single xlsx
 *   - payslip_file_<i>:  one PDF per branch (i = 0..N-1)
 *   - branch_<i>:        branch name for that PDF (must match xlsx branch text)
 *   - sheet_name:        optional, defaults to last sheet
 *
 * The merged audit returns one combined results array; `branch_filter` becomes
 * a comma-separated list of branches processed.
 */
async function runAuditMulti(req, res) {
  const tableFile = req.files?.table_file?.[0];
  if (!tableFile) {
    return res.status(400).json({ error: 'נדרש קובץ טבלת שכר (xlsx)' });
  }
  // Collect all payslip_file_<i> entries paired with branch_<i>
  const payslipEntries = [];
  for (const key of Object.keys(req.files || {})) {
    const m = key.match(/^payslip_file_(\d+)$/);
    if (!m) continue;
    const idx = m[1];
    const file = req.files[key][0];
    const branch = (req.body[`branch_${idx}`] || '').trim();
    if (!branch) {
      return res.status(400).json({ error: `חסר שם סניף לקובץ ${file.originalname}` });
    }
    payslipEntries.push({ idx: Number(idx), file, branch });
  }
  payslipEntries.sort((a, b) => a.idx - b.idx);
  if (payslipEntries.length === 0) {
    return res.status(400).json({ error: 'נדרש לפחות קובץ תלושים אחד' });
  }

  try {
    const sheet = typeof req.body?.sheet_name === 'string' ? req.body.sheet_name : undefined;
    // Parse the table once, then filter per branch in the loop.
    const tableResult = parseSalaryTable(tableFile.buffer, { sheetName: sheet });

    // Optional Cibus monthly report — if present, parse once and pass into the
    // comparator. We pass the SAME rows to every branch's comparator; the
    // matcher consumes each row at most once across all branches.
    let cibusReport = null;
    const cibusFile = req.files?.cibus_file?.[0];
    if (cibusFile) {
      try {
        cibusReport = parseCibusReport(cibusFile.buffer, cibusFile.originalname);
      } catch (err) {
        console.error('Cibus parse failed:', err.message);
        cibusReport = { rows: [], detected_columns: {}, parse_error: err.message };
      }
    }
    // Shared pool of unused Cibus rows — comparator.findCibusForResult deletes
    // matched rows. We track them across all branches by passing the same
    // mutable Set indirectly: each branch's compare gets a fresh array slice
    // from the pool, but since we call sequentially we share the same source.
    const cibusPool = cibusReport ? [...cibusReport.rows] : [];

    const merged = {
      year_month: null,
      table_sheet_name: tableResult.sheet_name,
      branch_filter: payslipEntries.map((e) => e.branch).join(', '),
      rows_in_table: 0,
      payslips_in_pdf: 0,
      results: [],
      missing_payslips: [],
      orphan_payslips: [],
      orphan_cibus_rows: [],
      per_branch: [],
      cibus_report_meta: cibusReport ? {
        sheet_name: cibusReport.sheet_name,
        detected_columns: cibusReport.detected_columns,
        aggregated_employee_count: cibusReport.rows.length,
        transaction_count: cibusReport.transaction_count,
        warning: cibusReport.warning,
        parse_error: cibusReport.parse_error,
      } : null,
    };

    // Whitespace-insensitive branch match — the table column stores branch
    // names with embedded newlines / double spaces (e.g. "כפר סבא \nשאול המלך"),
    // but the user-entered branch tag from the FormData input collapses
    // newlines to single spaces. Without normalization, .includes() returns
    // false and the branch ends up with zero table rows.
    const normalizeWS = (s) => (s || '').replace(/\s+/g, ' ').trim();

    for (const entry of payslipEntries) {
      const entryNorm = normalizeWS(entry.branch);
      const branchRows = tableResult.rows.filter((r) => normalizeWS(r.branch).includes(entryNorm));
      const pdfResult = await parsePayslipsPdf(entry.file.buffer);
      const audit = comparePayslipsToTable(branchRows, pdfResult.payslips, cibusPool);
      // Drain matched cibus rows from the shared pool (comparator returns the unmatched ones)
      cibusPool.length = 0;
      cibusPool.push(...(audit.orphan_cibus_rows || []));
      stripRawText(audit);

      merged.rows_in_table += audit.rows_in_table;
      merged.payslips_in_pdf += audit.payslips_in_pdf;
      // Stamp the branch onto each result + missing/orphan entry so the UI can
      // group them later if needed.
      for (const r of audit.results) {
        if (r.table_row && !r.table_row.branch) r.table_row.branch = entry.branch;
        merged.results.push({ ...r, __source_branch: entry.branch });
      }
      for (const m of audit.missing_payslips) {
        merged.missing_payslips.push({ ...m, __source_branch: entry.branch });
      }
      for (const o of audit.orphan_payslips) {
        merged.orphan_payslips.push({ ...o, __source_branch: entry.branch });
      }
      if (!merged.year_month && audit.year_month) merged.year_month = audit.year_month;
      merged.per_branch.push({
        branch: entry.branch,
        rows: audit.rows_in_table,
        payslips: audit.payslips_in_pdf,
        critical: audit.results.reduce((s, r) => s + r.findings.filter((f) => f.severity === 'critical').length, 0),
        warning:  audit.results.reduce((s, r) => s + r.findings.filter((f) => f.severity === 'warning').length, 0),
        missing:  audit.missing_payslips.length,
        orphans:  audit.orphan_payslips.length,
        file_name: entry.file.originalname,
      });
    }

    // After all branches processed, the cibusPool holds rows that weren't
    // matched to any employee in the uploaded PDFs. They might still EXIST in
    // the salary table — just in a branch whose PDF wasn't uploaded. We enrich
    // each orphan with a `matched_table_row` lookup against the FULL table so
    // the UI can show "found in branch X (no PDF uploaded)" instead of just
    // "unknown employee".
    function normalizeNameForCross(name) {
      if (!name) return '';
      return String(name)
        .replace(/[()‘’“”"'.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ')
        .replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
    }
    // Fuzzy token equality — same logic as comparator (mirrored here so the
    // controller doesn't need to import internals). Catches:
    //   - missing/extra waw or yud:        אהרון ↔ אהרן
    //   - adjacent letter transposition:   אבודגה ↔ אבוגדה
    // Damerau-Levenshtein (optimal string alignment) — adjacent transposition
    // counts as ONE edit (אבודגה ↔ אבוגדה → 1, not 2).
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
            d[i - 1][j] + 1,
            d[i][j - 1] + 1,
            d[i - 1][j - 1] + cost,
          );
          if (i > 1 && j > 1
              && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
              && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
            d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
          }
        }
      }
      return d[m][n];
    }
    function tokensMatch(a, b) {
      if (a === b) return true;
      if (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1) {
        return levenshtein(a, b) <= 1;
      }
      return false;
    }
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
    function findRowInFullTable(cibusRow) {
      const allRows = tableResult.rows;
      const cName = normalizeNameForCross(cibusRow.name);
      if (!cName) return null;
      const cTokens = [...new Set(cName.split(' ').filter(Boolean))];

      // Pass 1 — strict: 1-token names need exact match; 2+-token need ≥2 common.
      let best = null;
      let bestCommon = 0;
      const candidates = [];
      for (const tableRow of allRows) {
        const tName = normalizeNameForCross(tableRow.employee_name);
        if (!tName) continue;
        const tTokens = tName.split(' ').filter(Boolean);
        const common = commonTokenCount(cTokens, tTokens);
        if (common >= 1) candidates.push({ tableRow, common });
        const required = cTokens.length === 1 ? 1 : 2;
        if (common >= required && common > bestCommon) {
          best = tableRow;
          bestCommon = common;
        }
      }
      if (best) return best;
      // Pass 2 — loose: single-token match if it's UNIQUE in the table.
      candidates.sort((a, b) => b.common - a.common);
      if (candidates.length === 1
          || (candidates.length > 1 && candidates[0].common > candidates[1].common)) {
        return candidates[0].tableRow;
      }
      return null;
    }

    merged.orphan_cibus_rows = cibusPool.map((row) => {
      const matchedTableRow = findRowInFullTable(row);
      return {
        ...row,
        matched_table_row: matchedTableRow ? {
          employee_name: matchedTableRow.employee_name,
          branch: matchedTableRow.branch,
          cibus_in_table: matchedTableRow.cibus,
        } : null,
      };
    });

    // Save run for the history panel — best-effort, doesn't block the response.
    const saved = await persistAudit({
      audit: merged,
      user: req.user,
      table_filename: tableFile.originalname,
      payslip_files: payslipEntries.map((e) => ({ branch: e.branch, filename: e.file.originalname })),
      branches: payslipEntries.map((e) => e.branch),
    });

    // Sync vacation balances from payslip → PayrollMonth (best-effort).
    syncVacationBalances(merged).catch(err => console.error('syncVacationBalances failed:', err.message));

    // Persist the original PDF buffers so the per-employee preview endpoint
    // can extract individual pages later. We do this AFTER persistAudit so
    // the file path is keyed by the saved audit id.
    if (saved?._id) {
      try {
        ensureDir(path.join(PDF_STORAGE_DIR, String(saved._id)));
        for (const entry of payslipEntries) {
          fs.writeFileSync(pdfStoragePath(saved._id, entry.branch), entry.file.buffer);
        }
      } catch (err) {
        console.error('Failed to persist payslip PDFs:', err.message);
      }
    }

    res.json({
      ...merged,
      available_sheets: tableResult.available_sheets,
      available_branches: [...new Set(tableResult.rows.map((r) => r.branch).filter(Boolean))],
      saved_audit_id: saved?._id || null,
      saved_at: saved?.created_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בהשוואה' });
  }
}

async function runAudit(req, res) {
  const tableFile = req.files?.table_file?.[0];
  const payslipFile = req.files?.payslip_file?.[0];
  if (!tableFile || !payslipFile) {
    return res.status(400).json({ error: 'נדרשים שני קבצים: טבלת שכר (xlsx) ותלושים (PDF)' });
  }
  try {
    const opts = takeOptions(req);
    const tableResult = parseSalaryTable(tableFile.buffer, { sheetName: opts.sheetName, branchFilter: opts.branchFilter });
    const pdfResult = await parsePayslipsPdf(payslipFile.buffer);
    const audit = comparePayslipsToTable(tableResult.rows, pdfResult.payslips);
    audit.table_sheet_name = tableResult.sheet_name;
    audit.branch_filter = opts.branchFilter || null;
    stripRawText(audit);

    // Save run for the history panel — best-effort, doesn't block the response.
    const saved = await persistAudit({
      audit,
      user: req.user,
      table_filename: tableFile.originalname,
      payslip_files: [{ branch: opts.branchFilter || '', filename: payslipFile.originalname }],
      branches: opts.branchFilter ? [opts.branchFilter] : [],
    });

    syncVacationBalances(audit).catch(err => console.error('syncVacationBalances failed:', err.message));

    res.json({
      ...audit,
      available_sheets: tableResult.available_sheets,
      saved_audit_id: saved?._id || null,
      saved_at: saved?.created_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בהשוואה' });
  }
}

// Basic email-shape check. We accept anything with a single @ and at least one
// dot in the host part — strict RFC validation isn't worth the false-positive
// risk on Hebrew/edge-case addresses.
function isEmailish(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  const at = t.indexOf('@');
  return at > 0 && at < t.length - 3 && t.indexOf('.', at) > 0;
}

function dedup(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v.trim());
  }
  return out;
}

/**
 * Send the audit findings as a formatted email.
 *
 * Recipients are fully controlled by the client. If the client omits them, we
 * fall back to the office defaults so a quick "send" still works.
 *
 * Body shape:
 *   {
 *     audit:      AuditResult,             // result returned by /payslip-audit/run
 *     to:         string[]  (optional),    // primary recipients — defaults to [ACCOUNTANT_EMAIL]
 *     cc:         string[]  (optional),    // CC recipients      — defaults to [OFFICE_EMAIL]
 *     intro_text: string    (optional),    // Hebrew greeting, defaults to a template
 *     subject:    string    (optional)     // override the default subject
 *   }
 */
async function emailAudit(req, res) {
  const audit = req.body && req.body.audit;
  if (!audit || !Array.isArray(audit.results)) {
    return res.status(400).json({ error: 'נדרש אובייקט audit עם תוצאות' });
  }

  const rawTo = Array.isArray(req.body.to) ? req.body.to : null;
  const rawCc = Array.isArray(req.body.cc) ? req.body.cc : null;

  const to = dedup((rawTo || [ACCOUNTANT_EMAIL]).filter(isEmailish));
  const cc = dedup((rawCc || [OFFICE_EMAIL]).filter(isEmailish));

  if (to.length === 0) {
    return res.status(400).json({ error: 'נדרש לפחות נמען אחד תקין בשדה "אל"' });
  }

  try {
    const ym = audit.year_month || '';
    const branch = audit.branch_filter || 'כל הסניפים';
    const subject = req.body.subject || `תיקוני תלושי שכר — ${ym}${branch ? ` — ${branch}` : ''}`;
    const introText = typeof req.body.intro_text === 'string' && req.body.intro_text.trim()
      ? req.body.intro_text.trim() : undefined;
    const html = buildAuditEmailHtml(audit, { introText });
    const text = buildAuditEmailText(audit, { introText });

    const result = await dispatchEmail({
      to,
      cc: cc.length ? cc : undefined,
      subject,
      html,
      text,
    });
    res.json({
      success: true,
      message_id: result.messageId,
      provider: result.provider,
      sent_to: to,
      cc,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בשליחת המייל', code: err.code, detail: err.detail });
  }
}

// Default recipients exposed to the UI so it can pre-populate the form.
function getDefaultRecipients(_req, res) {
  res.json({ to: [ACCOUNTANT_EMAIL], cc: [OFFICE_EMAIL] });
}

// ── Audit history (saved runs) ──

/**
 * GET /payslip-audit/history?limit=20
 * Returns lightweight metadata for the N most recent saved audits, without the
 * heavy `full_result` payload — that's loaded on demand via /history/:id.
 */
async function listAuditHistory(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const docs = await PayslipAuditRecord
      .find({}, { full_result: 0 })  // exclude full_result for the list view
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
    res.json({ items: docs });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת היסטוריה' });
  }
}

/**
 * GET /payslip-audit/history/:id
 * Returns the full saved audit so the UI can re-open it.
 */
async function getAuditFromHistory(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    // Return the full_result with the saved metadata stamped on top so the UI
    // can show "saved at ...".
    res.json({
      ...doc.full_result,
      saved_audit_id: doc._id,
      saved_at: doc.created_at,
      created_by_name: doc.created_by_name,
      table_filename: doc.table_filename,
      payslip_files: doc.payslip_files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת ביקורת' });
  }
}

/**
 * GET /payslip-audit/employee-history?id=...&name=...
 * Find an employee across ALL saved audits and return per-month occurrences.
 *
 * Match strategy:
 *   - If `id` (Israeli ID) is provided, exact match on payslip.employee_id.
 *   - Otherwise fall back to name token overlap (>= 50% common, 2+ tokens
 *     when both names have multiple words — same rule as the cross-branch
 *     matcher).
 *
 * Returns:
 *   [{
 *     audit_id, created_at, year_month, branches,
 *     branch, page_index,
 *     finding_count, critical_count, warning_count, approved
 *   }]
 *   sorted newest-first.
 */
async function getEmployeeHistory(req, res) {
  const queryId = (req.query.id || '').toString().trim();
  const queryName = (req.query.name || '').toString().trim();
  if (!queryId && !queryName) {
    return res.status(400).json({ error: 'נדרש id (ת״ז) או name (שם)' });
  }
  const normalizeName = (s) => (s || '').replace(/[()‘’“”"'.,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const queryNameNorm = normalizeName(queryName);
  const queryNameTokens = queryNameNorm ? queryNameNorm.split(' ').filter(Boolean) : [];

  function nameMatches(candidateName) {
    const cName = normalizeName(candidateName);
    if (!cName || queryNameTokens.length === 0) return false;
    const cTokens = new Set(cName.split(' ').filter(Boolean));
    let common = 0;
    for (const t of queryNameTokens) if (cTokens.has(t)) common++;
    const required = queryNameTokens.length === 1 ? 1 : 2;
    return common >= required;
  }

  try {
    // Pull recent audits — limit to 50 most recent to bound scan cost
    const audits = await PayslipAuditRecord.find({})
      .sort({ created_at: -1 })
      .limit(50)
      .lean();

    const occurrences = [];
    for (const a of audits) {
      const results = a.full_result?.results || [];
      for (const r of results) {
        // ID match takes priority
        if (queryId && r.payslip?.employee_id === queryId) {
          // ok
        } else if (!queryId && nameMatches(r.table_row?.employee_name) || nameMatches(r.payslip?.employee_name)) {
          // name match — but skip if queryId was provided and we didn't match by id
          if (queryId) continue;
        } else {
          continue;
        }
        const findings = r.findings || [];
        const branchRaw = r.__source_branch || r.table_row?.branch || '';
        occurrences.push({
          audit_id: a._id,
          created_at: a.created_at,
          year_month: a.year_month,
          branches: a.branches || [],
          branch: branchRaw,
          page_index: r.payslip?.page_index || null,
          employee_name: r.table_row?.employee_name || r.payslip?.employee_name,
          employee_id: r.payslip?.employee_id || null,
          finding_count: findings.length,
          critical_count: findings.filter((f) => f.severity === 'critical').length,
          warning_count: findings.filter((f) => f.severity === 'warning').length,
          approved: !!a.approved,
        });
        // Each audit can only contain the employee once per branch — break to avoid dupes
        break;
      }
    }
    res.json({ occurrences });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בשליפת היסטוריית עובד' });
  }
}

/**
 * GET /payslip-audit/history/:id/payslip-page?branch=...&page=N
 * Extracts a single page from the stored payslip PDF for the given branch
 * and streams it back as application/pdf. The client embeds it in an iframe
 * inside the per-employee preview dialog.
 *
 * `page` is 1-based to match the human-facing payslip numbering (page 1 = first
 * employee in that branch's PDF). Out-of-range pages return 404.
 */
async function getPayslipPage(req, res) {
  try {
    const auditId = req.params.id;
    const branch = (req.query.branch || '').toString();
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!branch) return res.status(400).json({ error: 'נדרש שם סניף' });
    const filePath = pdfStoragePath(auditId, branch);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'קובץ תלושים לא נשמר עבור ביקורת זו' });
    }
    // Lazy-load pdf-lib so test setups without it don't crash on import
    const { PDFDocument } = require('pdf-lib');
    const srcBytes = fs.readFileSync(filePath);
    const srcDoc = await PDFDocument.load(srcBytes);
    if (pageNum > srcDoc.getPageCount()) {
      return res.status(404).json({ error: `עמוד ${pageNum} מחוץ לטווח (יש ${srcDoc.getPageCount()} עמודים)` });
    }
    const outDoc = await PDFDocument.create();
    const [copied] = await outDoc.copyPages(srcDoc, [pageNum - 1]);
    outDoc.addPage(copied);
    const outBytes = await outDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-page-${pageNum}.pdf"`);
    res.send(Buffer.from(outBytes));
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בחילוץ עמוד' });
  }
}

/**
 * PATCH /payslip-audit/history/:id/edits
 * Save the user's per-finding verifications (approve/reject/pending) so they
 * can be restored when the audit is opened later. Body shape:
 *   { editor_verifications: { <auditIdx>: [{ field, message, status, note, severity }] } }
 *
 * The verifications are stored on full_result.editor_verifications so they ship
 * back with the audit on `/history/:id`.
 */
async function saveAuditEdits(req, res) {
  try {
    const verifications = req.body?.editor_verifications;
    if (!verifications || typeof verifications !== 'object') {
      return res.status(400).json({ error: 'נדרש שדה editor_verifications (אובייקט)' });
    }
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    // Mutate full_result and mark Mixed type as modified so Mongoose persists
    doc.full_result = { ...doc.full_result, editor_verifications: verifications };
    doc.markModified('full_result');
    await doc.save();
    res.json({ success: true, saved_at: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בשמירת עריכות' });
  }
}

/**
 * PATCH /payslip-audit/history/:id/approve
 * Mark a saved audit as a "closed cycle" — the accountant has returned the
 * corrected payslips and we accept this as the final version for that month.
 *
 * Optional multipart fields `approved_payslip_<i>` + `approved_branch_<i>`
 * carry the corrected PDFs (one per branch). If omitted, we only flip the
 * approved flag — the original payslips remain as the reference.
 *
 * Body / form fields:
 *   approved_note   string  (optional)  — admin remarks
 *   approved_payslip_<i>     file       — corrected PDF
 *   approved_branch_<i>      string     — matching branch tag
 */
async function approveAudit(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });

    // Collect any approved PDFs from the multipart fields
    const approvedFiles = [];
    for (const key of Object.keys(req.files || {})) {
      const m = key.match(/^approved_payslip_(\d+)$/);
      if (!m) continue;
      const idx = m[1];
      const file = req.files[key][0];
      const branch = (req.body[`approved_branch_${idx}`] || '').trim();
      if (!branch) continue;
      approvedFiles.push({ idx: Number(idx), file, branch });
    }

    if (approvedFiles.length > 0) {
      ensureDir(path.join(PDF_STORAGE_DIR, String(doc._id), 'approved'));
      for (const entry of approvedFiles) {
        fs.writeFileSync(approvedPdfStoragePath(doc._id, entry.branch), entry.file.buffer);
      }
      doc.approved_payslip_files = approvedFiles.map((e) => ({
        branch: e.branch,
        filename: e.file.originalname,
      }));
    }

    doc.approved = true;
    doc.approved_at = new Date();
    doc.approved_by = req.user?.id || null;
    doc.approved_by_name = req.user?.full_name || '';
    if (typeof req.body.approved_note === 'string') doc.approved_note = req.body.approved_note;
    await doc.save();
    res.json({
      success: true,
      approved_at: doc.approved_at,
      approved_payslip_files: doc.approved_payslip_files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה באישור ביקורת' });
  }
}

/**
 * PATCH /payslip-audit/history/:id/unapprove
 * Reverse a previous approval (e.g. if the accountant sent another revision).
 * Doesn't delete the approved PDFs — just clears the flags.
 */
async function unapproveAudit(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    doc.approved = false;
    doc.approved_at = null;
    doc.approved_by = null;
    doc.approved_by_name = '';
    await doc.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה' });
  }
}

/**
 * DELETE /payslip-audit/history/:id
 * Remove a saved audit from history.
 */
async function deleteAuditFromHistory(req, res) {
  try {
    const doc = await PayslipAuditRecord.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה במחיקת ביקורת' });
  }
}

/**
 * GET /payslip-audit/cycle-progression?year_month=YYYY-MM
 * Returns the round-by-round status of every employee for one salary cycle.
 *
 * Response shape:
 * {
 *   year_month,
 *   rounds: [{ audit_id, round_no, created_at, approved, summary }],
 *   employees: [{
 *     name, id, branch,
 *     rounds: { <audit_id>: { critical, warning, finding_messages: [...] } },
 *     status: 'open' | 'resolved' | 'new'
 *   }]
 * }
 */
async function getCycleProgression(req, res) {
  const ym = (req.query.year_month || '').toString().trim();
  if (!ym) return res.status(400).json({ error: 'נדרש year_month' });
  try {
    // Pull all audits for this month, oldest first (so round_no = chronological order).
    const docs = await PayslipAuditRecord
      .find({ year_month: ym })
      .sort({ created_at: 1 })
      .lean();
    if (!docs.length) return res.json({ year_month: ym, rounds: [], employees: [] });

    const rounds = docs.map((d, i) => ({
      audit_id: String(d._id),
      round_no: i + 1,
      created_at: d.created_at,
      approved: !!d.approved,
      approved_at: d.approved_at,
      summary: d.summary,
    }));

    // Build a per-employee map keyed by employee_id (or normalised name fallback).
    const employees = new Map();
    const keyFor = (r) => {
      const id = r.payslip?.employee_id || r.table_row?.employee_id;
      if (id) return `id:${id}`;
      const name = (r.table_row?.employee_name || r.payslip?.employee_name || '').trim();
      const branch = (r.table_row?.branch || r.__source_branch || '').replace(/\s+/g, ' ').trim();
      return `nm:${name}::${branch}`;
    };
    for (const d of docs) {
      const auditId = String(d._id);
      const results = (d.full_result && d.full_result.results) || [];
      for (const r of results) {
        const k = keyFor(r);
        if (!employees.has(k)) {
          employees.set(k, {
            key: k,
            name: r.table_row?.employee_name || r.payslip?.employee_name || '—',
            id: r.payslip?.employee_id || null,
            employee_no: r.payslip?.employee_no ?? null,
            branch: (r.table_row?.branch || r.__source_branch || '').replace(/\s+/g, ' ').trim(),
            rounds: {},
          });
        }
        const counts = { critical: 0, warning: 0, info: 0, ok: 0 };
        const messages = [];
        for (const f of (r.findings || [])) {
          counts[f.severity] = (counts[f.severity] || 0) + 1;
          if (f.severity === 'critical' || f.severity === 'warning') {
            messages.push({ severity: f.severity, message: f.message, field: f.field });
          }
        }
        employees.get(k).rounds[auditId] = {
          critical: counts.critical,
          warning: counts.warning,
          messages,
        };
      }
    }
    // Compute per-employee status: 'resolved' if last round has 0 critical+warning,
    // 'open' if it still has issues, 'new' if employee only appears in latest round.
    const lastAuditId = rounds[rounds.length - 1].audit_id;
    const firstAuditId = rounds[0].audit_id;
    for (const emp of employees.values()) {
      const lastRound = emp.rounds[lastAuditId];
      const firstRound = emp.rounds[firstAuditId];
      if (!lastRound) {
        emp.status = 'dropped'; // appeared in earlier rounds, not in latest
      } else if (lastRound.critical === 0 && lastRound.warning === 0) {
        emp.status = 'resolved';
      } else {
        emp.status = !firstRound ? 'new' : 'open';
      }
    }
    res.json({
      year_month: ym,
      rounds,
      employees: [...employees.values()].sort((a, b) => a.name.localeCompare(b.name, 'he')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת השוואת סבבים' });
  }
}

// Fetch the in-system computed salary rows for a month by reusing getMonth.
function fetchSystemMonth(user, month) {
  return new Promise((resolve, reject) => {
    const mockReq = { query: { month, branch: 'all' }, user };
    const mockRes = {
      json: (data) => resolve(data),
      status: (code) => ({ json: (body) => reject(new Error(body?.error || `getMonth failed (${code})`)) }),
    };
    Promise.resolve(getMonth(mockReq, mockRes, (e) => reject(e))).catch(reject);
  });
}

const _num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

// Convert a getMonth row → the SalaryTableRow shape the comparator expects, so
// the in-system table is compared against payslips exactly like the xlsx was.
function systemRowToTableRow(r) {
  const bd = r.breakdown || {};
  const comp = bd.components || {};
  const tb = comp.teken_breakdown || null;
  const ded = bd.deductions || {};
  const isGlobal = r.salary_type === 'global';
  const gsal = isGlobal ? _num(bd.rates?.global_salary) : null;
  const numKind = (o) => (o && o.kind === 'number' ? _num(o.amount) : null);
  const rnd = (n) => (n == null || n === '' || isNaN(Number(n)) ? null : Math.round(Number(n)));
  const perHour = isGlobal
    ? (tb?.hourly_value != null ? Math.round(tb.hourly_value * 100) / 100 : null)
    : _num(bd.rates?.hourly_rate);
  // Full, ordered detail of every column shown in the system salary table, so the
  // preview can list each value the accountant was given (not just the compared ones).
  const system_detail = [
    { label: 'ימי עבודה', value: _num(bd.hours?.days_worked) },
    { label: 'שעות רגילות', value: _num(bd.hours?.regular) },
    { label: 'שע"נ 125%', value: _num(bd.hours?.ot_125) },
    { label: 'שע"נ 150%', value: _num(bd.hours?.ot_150) },
    { label: 'תעריף לשעה', value: perHour, currency: true },
    { label: 'שכר תקן (מוסכם)', value: gsal, currency: true },
    { label: 'שכר בסיס', value: rnd(comp.base_salary), currency: true },
    { label: 'השלמת שכר', value: rnd(tb?.completion), currency: true },
    { label: 'תוספת שכר', value: rnd(tb?.supplement_applied), currency: true },
    { label: 'נסיעות', value: rnd(comp.travel), currency: true },
    { label: 'מחלה (ימים)', value: _num(r.manual?.sick_days) },
    { label: 'חופשה (ימים)', value: _num(r.vacation_eff_days) ?? _num(r.manual?.vacation_days) },
    { label: 'דמי חגים (ימים)', value: _num(r.holiday_pay_auto?.total_days) },
    { label: 'סיבוס', value: numKind(r.manual?.cibus), currency: true },
    { label: 'הבראה', value: numKind(r.manual?.recreation), currency: true },
    { label: 'כרטיס מתנה', value: numKind(r.manual?.gift_card), currency: true },
    { label: 'מילואים', value: numKind(r.manual?.miluim), currency: true },
    { label: 'בונוס', value: rnd(r.bonus?.effective), currency: true },
    { label: 'הלוואות (ניכוי)', value: rnd(ded.loans), currency: true },
    { label: 'ניכוי היעדרות', value: rnd(ded.absence), currency: true },
    { label: 'קיזוז מקדמה', value: r.manual?.advance_deduction_text || r.manual?.advance_deduction_preset?.label || '' },
    { label: 'שכר משוער (ברוטו)', value: rnd(bd.estimated_total), currency: true, strong: true },
  ].filter((d) => d.value != null && d.value !== '');

  return {
    branch: r.branch_name || '',
    employee_name: r.full_name || '',
    israeli_id: r.israeli_id || '',
    days: _num(bd.hours?.days_worked),
    hours_regular: _num(bd.hours?.regular),
    ot_125: _num(bd.hours?.ot_125),
    ot_150: _num(bd.hours?.ot_150),
    hourly_rate: isGlobal ? null : _num(bd.rates?.hourly_rate),
    global_salary: gsal,
    global_ot: null,
    global_salary_kind: isGlobal ? (r.salary_is_net ? 'net' : 'gross') : 'unknown',
    global_salary_amount: gsal,
    global_ot_amount: null,
    emuna_ks_global: null, emuna_ks_global_ot: null, emuna_hz_global: null, emuna_hz_global_ot: null,
    transport: _num(comp.travel),
    sick_days: _num(r.manual?.sick_days),
    absence: null,
    vacation_days: _num(r.vacation_eff_days) ?? _num(r.manual?.vacation_days),
    holiday_days: _num(r.holiday_pay_auto?.total_days),
    advance_directive: r.manual?.advance_deduction_text || r.manual?.advance_deduction_preset?.label || null,
    gift_card: numKind(r.manual?.gift_card),
    recuperation: numKind(r.manual?.recreation),
    cibus: numKind(r.manual?.cibus),
    reserve_duty: numKind(r.manual?.miluim),
    notes: r.manual?.notes || null,
    system_detail,
  };
}

// Audit payslips against the IN-SYSTEM salary table (no xlsx upload). Needs only
// payslip PDFs + month + per-file branch.
async function runAuditSystem(req, res) {
  const month = (req.body?.month || '').trim();
  if (!month) return res.status(400).json({ error: 'נדרש חודש (YYYY-MM)' });

  const payslipEntries = [];
  for (const key of Object.keys(req.files || {})) {
    const m = key.match(/^payslip_file_(\d+)$/);
    if (!m) continue;
    const idx = m[1];
    const file = req.files[key][0];
    const branch = (req.body[`branch_${idx}`] || '').trim();
    if (!branch) return res.status(400).json({ error: `חסר שם סניף לקובץ ${file.originalname}` });
    payslipEntries.push({ idx: Number(idx), file, branch });
  }
  payslipEntries.sort((a, b) => a.idx - b.idx);
  if (payslipEntries.length === 0) return res.status(400).json({ error: 'נדרש לפחות קובץ תלושים אחד' });

  try {
    const monthData = await fetchSystemMonth(req.user, month);
    const allRows = (monthData.rows || []).map(systemRowToTableRow);

    let cibusReport = null;
    const cibusFile = req.files?.cibus_file?.[0];
    if (cibusFile) {
      try { cibusReport = parseCibusReport(cibusFile.buffer, cibusFile.originalname); }
      catch (err) { cibusReport = { rows: [], detected_columns: {}, parse_error: err.message }; }
    }
    const cibusPool = cibusReport ? [...cibusReport.rows] : [];

    const merged = {
      year_month: month,
      table_sheet_name: 'מערכת',
      branch_filter: payslipEntries.map((e) => e.branch).join(', '),
      rows_in_table: 0,
      payslips_in_pdf: 0,
      results: [], missing_payslips: [], orphan_payslips: [], orphan_cibus_rows: [], per_branch: [],
      cibus_report_meta: cibusReport ? {
        sheet_name: cibusReport.sheet_name,
        detected_columns: cibusReport.detected_columns,
        aggregated_employee_count: cibusReport.rows.length,
        transaction_count: cibusReport.transaction_count,
        warning: cibusReport.warning,
        parse_error: cibusReport.parse_error,
      } : null,
    };
    const normalizeWS = (s) => (s || '').replace(/\s+/g, ' ').trim();

    for (const entry of payslipEntries) {
      const entryNorm = normalizeWS(entry.branch);
      const branchRows = allRows.filter((r) => {
        const rb = normalizeWS(r.branch);
        return rb.includes(entryNorm) || entryNorm.includes(rb);
      });
      const pdfResult = await parsePayslipsPdf(entry.file.buffer);
      const audit = comparePayslipsToTable(branchRows, pdfResult.payslips, cibusPool);
      cibusPool.length = 0;
      cibusPool.push(...(audit.orphan_cibus_rows || []));
      stripRawText(audit);

      merged.rows_in_table += audit.rows_in_table;
      merged.payslips_in_pdf += audit.payslips_in_pdf;
      for (const r of audit.results) {
        if (r.table_row && !r.table_row.branch) r.table_row.branch = entry.branch;
        merged.results.push({ ...r, __source_branch: entry.branch });
      }
      for (const mm of audit.missing_payslips) merged.missing_payslips.push({ ...mm, __source_branch: entry.branch });
      for (const o of audit.orphan_payslips) merged.orphan_payslips.push({ ...o, __source_branch: entry.branch });
      merged.per_branch.push({
        branch: entry.branch,
        rows: audit.rows_in_table,
        payslips: audit.payslips_in_pdf,
        critical: audit.results.reduce((s, r) => s + r.findings.filter((f) => f.severity === 'critical').length, 0),
        warning: audit.results.reduce((s, r) => s + r.findings.filter((f) => f.severity === 'warning').length, 0),
        missing: audit.missing_payslips.length,
        orphans: audit.orphan_payslips.length,
        file_name: entry.file.originalname,
      });
    }
    merged.orphan_cibus_rows = cibusPool.map((row) => ({ ...row, matched_table_row: null }));

    const saved = await persistAudit({
      audit: merged,
      user: req.user,
      table_filename: `מערכת — ${month}`,
      payslip_files: payslipEntries.map((e) => ({ branch: e.branch, filename: e.file.originalname })),
      branches: payslipEntries.map((e) => e.branch),
    });
    syncVacationBalances(merged).catch((err) => console.error('syncVacationBalances failed:', err.message));
    if (saved?._id) {
      try {
        ensureDir(path.join(PDF_STORAGE_DIR, String(saved._id)));
        for (const entry of payslipEntries) fs.writeFileSync(pdfStoragePath(saved._id, entry.branch), entry.file.buffer);
      } catch (err) { console.error('Failed to persist payslip PDFs:', err.message); }
    }

    res.json({
      ...merged,
      from_system_table: true,
      available_sheets: [],
      available_branches: [...new Set(allRows.map((r) => r.branch).filter(Boolean))],
      saved_audit_id: saved?._id || null,
      saved_at: saved?.created_at || null,
    });
  } catch (err) {
    console.error('runAuditSystem failed:', err);
    res.status(500).json({ error: err.message || 'שגיאה בהשוואה מול המערכת' });
  }
}

module.exports = {
  parseTable,
  parsePayslips,
  runAudit,
  runAuditMulti,
  runAuditSystem,
  listBranches,
  emailAudit,
  getDefaultRecipients,
  listAuditHistory,
  getAuditFromHistory,
  deleteAuditFromHistory,
  saveAuditEdits,
  getPayslipPage,
  getEmployeeHistory,
  approveAudit,
  unapproveAudit,
  getCycleProgression,
};
