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
const { PayslipAuditRecord, PayslipAuditPdf, Employee, PayrollMonth, Branch, User, Setting, SavedPayslip } = require('../models');

// Persist payslip PDF bytes to Mongo (durable) so the per-page preview survives
// host restarts that wipe the ephemeral local disk. Best-effort.
async function storePayslipPdfDb(auditId, branch, buffer, kind = 'original') {
  try {
    await PayslipAuditPdf.findOneAndUpdate(
      { audit_id: auditId, branch, kind },
      { $set: { data: buffer } },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error('storePayslipPdfDb failed:', err.message);
  }
}
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
      // Durable copy in Mongo (disk is ephemeral on the host).
      for (const entry of payslipEntries) {
        await storePayslipPdfDb(saved._id, entry.branch, entry.file.buffer);
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
 *     subject:    string    (optional),    // override the default subject
 *     approved_payslips: [{ name, branch, employee_no, employee_id }] (optional),
 *                                          // ticked ✓ טופל — listed as "don't touch"
 *     attach_payslips:   boolean (optional, default true)
 *                                          // attach a PDF holding ONLY the pages
 *                                          // of the payslips that need a fix
 *   }
 */
/**
 * Build exactly what would be sent, without sending it.
 *
 * Shared by the send and the preview so what the user is shown is the message
 * itself and not a second rendering of it that can drift.
 */
async function buildAuditEmail(body) {
  const audit = body.audit;
  const ym = audit.year_month || '';
  const branch = audit.branch_filter || 'כל הסניפים';
  const subject = body.subject || `תיקוני תלושי שכר — ${ym}${audit.branch_filter ? ` — ${audit.branch_filter}` : ''}`;
  const introText = typeof body.intro_text === 'string' && body.intro_text.trim()
    ? body.intro_text.trim() : undefined;
  const approvedPayslips = Array.isArray(body.approved_payslips) ? body.approved_payslips : [];
  const fixUrl = typeof body.fix_url === 'string' && /^https?:\/\//.test(body.fix_url.trim())
    ? body.fix_url.trim() : '';

  // Attach ONLY the pages of the payslips that need work. The accountant was
  // getting the corrections in prose while the payslips themselves sat in the
  // full month bundle he had to hunt through — so the fix list and the pages
  // now travel together, and the approved ones are named but not attached.
  const wantAttachment = body.attach_payslips !== false;
  const fileAttachments = [];
  let attachmentName = '';
  let attachmentPages = 0;
  if (wantAttachment && audit.saved_audit_id) {
    const pageEntries = audit.results
      .map((r) => ({
        has_page: true,
        page: r.payslip?.page_index || null,
        source_branch: (r.__source_branch || r.table_row?.branch || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((e) => e.page && e.source_branch);
    if (pageEntries.length) {
      try {
        const merged = await mergeGroupPages({ _id: audit.saved_audit_id }, pageEntries, new Map());
        if (merged) {
          attachmentName = `תלושים לתיקון — ${ym || 'שכר'}.pdf`;
          attachmentPages = pageEntries.length;
          fileAttachments.push({
            filename: attachmentName,
            contentBase64: merged.toString('base64'),
            contentType: 'application/pdf',
          });
        }
      } catch (err) {
        // A missing/corrupt source PDF must not block the corrections email —
        // the findings are the payload, the attachment is the convenience.
        console.error('audit email attachment failed:', err.message);
      }
    }
  }

  return {
    subject,
    html: buildAuditEmailHtml(audit, { introText, approvedPayslips, attachmentName, fixUrl }),
    text: buildAuditEmailText(audit, { introText, approvedPayslips, attachmentName, fixUrl }),
    fileAttachments,
    attachmentName,
    attachmentPages,
    approvedCount: approvedPayslips.length,
    branch,
  };
}

/**
 * POST /payslip-audit/email/preview
 * The rendered message, so it can be read before it goes out. The PDF is built
 * too — its page count is reported — but the bytes are not returned.
 */
async function previewAuditEmail(req, res) {
  const audit = req.body && req.body.audit;
  if (!audit || !Array.isArray(audit.results)) {
    return res.status(400).json({ error: 'נדרש אובייקט audit עם תוצאות' });
  }
  try {
    const built = await buildAuditEmail(req.body);
    res.json({
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachment_name: built.attachmentName || null,
      attachment_pages: built.attachmentPages,
      approved_count: built.approvedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בבניית התצוגה המקדימה' });
  }
}

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
    const built = await buildAuditEmail(req.body);
    const result = await dispatchEmail({
      to,
      cc: cc.length ? cc : undefined,
      subject: built.subject,
      html: built.html,
      text: built.text,
      fileAttachments: built.fileAttachments.length ? built.fileAttachments : undefined,
    });
    res.json({
      success: true,
      message_id: result.messageId,
      provider: result.provider,
      sent_to: to,
      cc,
      attached: built.attachmentName || null,
      approved_count: built.approvedCount,
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
    // 'original' | 'approved' | 'fix_<n>' — a correction round's re-submission,
    // so the review screen can show the page the accountant actually sent back.
    const raw = String(req.query.kind || '');
    const kind = raw === 'approved' || /^fix_\d+$/.test(raw) ? raw : 'original';
    // Prefer the durable Mongo copy (disk is ephemeral and wiped on restart);
    // fall back to disk for audits saved before Mongo storage existed.
    let srcBytes = null;
    const dbDoc = await PayslipAuditPdf.findOne({ audit_id: auditId, branch, kind }).lean();
    if (dbDoc?.data) {
      srcBytes = dbDoc.data.buffer ? Buffer.from(dbDoc.data.buffer) : Buffer.from(dbDoc.data);
    } else if (kind === 'original') {
      // Disk only ever held the original upload — falling back to it for a
      // round would quietly serve the pre-correction payslip as the corrected
      // one, which is the exact comparison the reviewer is trying to make.
      const filePath = pdfStoragePath(auditId, branch);
      if (fs.existsSync(filePath)) srcBytes = fs.readFileSync(filePath);
    }
    if (!srcBytes) {
      return res.status(404).json({ error: 'קובץ תלושים לא נשמר עבור ביקורת זו' });
    }
    // Lazy-load pdf-lib so test setups without it don't crash on import
    const { PDFDocument } = require('pdf-lib');
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
    const { editor_verifications, reviewed_payslips } = req.body || {};
    const hasV = editor_verifications && typeof editor_verifications === 'object';
    const hasR = reviewed_payslips && typeof reviewed_payslips === 'object';
    if (!hasV && !hasR) {
      return res.status(400).json({ error: 'נדרש editor_verifications או reviewed_payslips' });
    }
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    // Mutate full_result and mark Mixed type as modified so Mongoose persists.
    // editor_verifications = per-finding decisions; reviewed_payslips = the
    // "נבדק" checkmark per payslip (keyed by a stable employee id).
    const next = { ...doc.full_result };
    if (hasV) next.editor_verifications = editor_verifications;
    if (hasR) next.reviewed_payslips = reviewed_payslips;
    doc.full_result = next;
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
        await storePayslipPdfDb(doc._id, entry.branch, entry.file.buffer, 'approved'); // durable
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

// ── Correction rounds ──────────────────────────────────────────────────────
//
// The office sends the accountant a list of notes. He fixes the payslips and
// sends them back. The only question then is whether each note was acted on —
// but answering it meant deleting the audit and re-running everything from the
// salary table, which threw away the notes along with the answer. A round
// keeps the audit intact: it re-reads ONLY the employees that had notes, and
// grades note by note.

/**
 * The employees + notes that went to the accountant, exactly as the email
 * decided them: a payslip travels if it still carries at least one live
 * correction. Rejected findings are dropped.
 *
 * The ✓ נבדק tick deliberately plays NO part here. It is a progress marker the
 * reviewer puts on every payslip as they work through the list, so treating it
 * as "approved, don't send" meant a completed review excluded everything and
 * left nothing to verify — 29 of 29 ticked, zero open notes, while the audit
 * still held 8 critical findings. What decides is the corrections themselves.
 *
 * If a result has no saved verification entry (the manager never touched it in
 * the editor) we fall back to its critical/warning findings — the email treats
 * an untouched finding as "send it", so the round has to grade it too.
 */
function fixTargetsFrom(doc) {
  const full = doc.full_result || {};
  const results = full.results || [];
  const verifications = full.editor_verifications || {};
  const targets = [];
  results.forEach((r, idx) => {
    const saved = verifications[idx];
    const notes = (saved
      ? saved
      : (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'warning')
    ).filter((n) => n.status !== 'rejected' && n.message && String(n.message).trim());
    if (!notes.length) return;
    targets.push({ audit_idx: idx, result: r, notes });
  });
  return targets;
}

function targetKey(r) {
  const id = r.payslip?.employee_id || r.table_row?.employee_id;
  if (id) return `id:${id}`;
  const name = (r.table_row?.employee_name || r.payslip?.employee_name || '').trim();
  const branch = (r.table_row?.branch || r.__source_branch || '').replace(/\s+/g, ' ').trim();
  return `nm:${name}::${branch}`;
}

/**
 * Re-check one round of corrected payslips against the notes that were sent.
 *
 * `entries` is [{ branch, file }] — the same per-branch shape the original run
 * uses. The salary table is NOT re-uploaded: the table rows stored with the
 * audit are the reference, which is the whole point (the accountant corrected
 * the payslips, not the table).
 */
async function runFixRound(doc, entries, { source = 'internal', user = null, note = '' } = {}) {
  const targets = fixTargetsFrom(doc);
  if (targets.length === 0) {
    const err = new Error('אין הערות פתוחות בביקורת הזו — אין מה לאמת');
    err.status = 400;
    throw err;
  }

  const roundNo = (doc.fix_rounds?.length || 0) + 1;

  // Parse each uploaded PDF and tag every payslip with the branch it came from,
  // so the round's per-employee preview knows which file holds its page.
  const freshPayslips = [];
  for (const entry of entries) {
    const parsed = await parsePayslipsPdf(entry.file.buffer);
    for (const p of parsed.payslips || []) {
      delete p.raw_text;                 // never persist the full page text
      p.__round_branch = entry.branch;
      freshPayslips.push(p);
    }
    await storePayslipPdfDb(doc._id, entry.branch, entry.file.buffer, `fix_${roundNo}`);
  }

  // Compare the NEW payslips against the SAVED table rows of the flagged
  // employees only. The comparator returns the very table_row objects we
  // passed in, so results map back to targets by reference — no re-matching.
  const tableRows = targets.map((t) => t.result.table_row).filter(Boolean);
  const fresh = comparePayslipsToTable(tableRows, freshPayslips);
  const byRow = new Map();
  for (const fr of fresh.results) if (fr.table_row) byRow.set(fr.table_row, fr);

  const items = [];
  const summary = { employees: 0, notes: 0, fixed: 0, not_fixed: 0, manual: 0, unmatched: 0, new_issues: 0 };

  for (const t of targets) {
    const fr = t.result.table_row ? byRow.get(t.result.table_row) : null;
    const matched = !!(fr && fr.payslip);

    // Live problems in the new payslip, indexed by field.
    const stillByField = new Map();
    if (matched) {
      for (const f of fr.findings || []) {
        if (f.severity === 'critical' || f.severity === 'warning') stillByField.set(f.field, f);
      }
    }

    const noteFields = new Set();
    const notes = t.notes.map((n) => {
      if (n.field) noteFields.add(n.field);
      // A note with no machine field behind it — one the manager typed by hand —
      // cannot be graded automatically. It goes to the user as a question, not
      // as a wrong answer.
      if (!matched || !n.field || n.field === 'manual') {
        return {
          field: n.field || 'manual',
          severity: n.severity || 'critical',
          message: n.message,
          auto_verdict: 'manual',
          manual_verdict: null,
          still_expected: null,
          still_actual: null,
          reply: '',
        };
      }
      const still = stillByField.get(n.field);
      return {
        field: n.field,
        severity: n.severity || 'critical',
        message: n.message,
        auto_verdict: still ? 'not_fixed' : 'fixed',
        manual_verdict: null,
        still_expected: still ? still.expected : null,
        still_actual: still ? still.actual : null,
        reply: '',
      };
    });

    // A correction that broke something else — flagged separately so it never
    // hides inside a "fixed" row.
    const newFindings = matched
      ? (fr.findings || [])
          .filter((f) => (f.severity === 'critical' || f.severity === 'warning') && !noteFields.has(f.field))
          .map((f) => ({ field: f.field, severity: f.severity, message: f.message, expected: f.expected, actual: f.actual }))
      : [];

    summary.employees += 1;
    summary.notes += notes.length;
    for (const n of notes) summary[n.auto_verdict === 'fixed' ? 'fixed' : n.auto_verdict === 'not_fixed' ? 'not_fixed' : 'manual'] += 1;
    if (!matched) summary.unmatched += 1;
    summary.new_issues += newFindings.length;

    items.push({
      key: targetKey(t.result),
      audit_idx: t.audit_idx,
      employee_name: t.result.table_row?.employee_name || t.result.payslip?.employee_name || '—',
      branch: (t.result.__source_branch || t.result.table_row?.branch || '').replace(/\s+/g, ' ').trim(),
      employee_no: fr?.payslip?.employee_no ?? t.result.payslip?.employee_no ?? null,
      employee_id: fr?.payslip?.employee_id || t.result.payslip?.employee_id || '',
      page_index: fr?.payslip?.page_index || null,
      round_branch: fr?.payslip?.__round_branch || null,
      matched,
      notes,
      new_findings: newFindings,
    });
  }

  // Keep the re-check in ordinary audit shape too. The verdict list answers
  // "was it fixed"; seeing the corrected payslip next to the numbers is a
  // different question, and the review screen already does that well.
  const auditView = {
    year_month: doc.year_month || null,
    table_sheet_name: doc.table_sheet_name || null,
    branch_filter: entries.map((e) => e.branch).join(', '),
    rows_in_table: tableRows.length,
    payslips_in_pdf: freshPayslips.length,
    results: (fresh.results || []).map((r) => ({
      ...r,
      __source_branch: r.payslip?.__round_branch || entries[0]?.branch || null,
    })),
    missing_payslips: fresh.missing_payslips || [],
    orphan_payslips: fresh.orphan_payslips || [],
  };

  doc.fix_rounds.push({
    round_no: roundNo,
    audit_view: auditView,
    created_at: new Date(),
    created_by: user?.id || null,
    created_by_name: source === 'accountant' ? 'רו״ח (העלאה חיצונית)' : (user?.full_name || ''),
    source,
    note: String(note || '').slice(0, 2000),
    uploaded_files: entries.map((e) => ({ branch: e.branch, filename: e.file.originalname })),
    items,
    summary,
  });
  await doc.save();
  return doc.fix_rounds[doc.fix_rounds.length - 1];
}

/** Pull the per-branch payslip uploads out of a multipart request. */
function payslipEntriesFrom(req) {
  const entries = [];
  for (const key of Object.keys(req.files || {})) {
    const m = key.match(/^payslip_file_(\d+)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const file = req.files[key][0];
    const branch = (req.body[`branch_${idx}`] || '').trim();
    if (!branch) {
      const err = new Error(`חסר שם סניף לקובץ ${file.originalname}`);
      err.status = 400;
      throw err;
    }
    entries.push({ idx, file, branch });
  }
  entries.sort((a, b) => a.idx - b.idx);
  return entries;
}

/**
 * POST /payslip-audit/history/:id/fix-round   (multipart)
 * Fields: payslip_file_<i> + branch_<i>, optional `note`.
 */
async function createFixRound(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const entries = payslipEntriesFrom(req);
    if (entries.length === 0) return res.status(400).json({ error: 'נדרש לפחות קובץ תלושים אחד' });
    const round = await runFixRound(doc, entries, { source: 'internal', user: req.user, note: req.body.note });
    res.json({ success: true, round });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'שגיאה בהרצת סבב תיקון' });
  }
}

/**
 * GET /payslip-audit/history/:id/fix-rounds
 * The rounds so far plus the notes still waiting — what the accountant owes us.
 */
async function listFixRounds(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const targets = fixTargetsFrom(doc);
    res.json({
      year_month: doc.year_month,
      open_targets: targets.length,
      open_notes: targets.reduce((s, t) => s + t.notes.length, 0),
      branches: (doc.payslip_files || []).map((f) => f.branch),
      rounds: doc.fix_rounds || [],
      fix_token: doc.fix_token || null,
      fix_token_expires: doc.fix_token_expires || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת סבבי תיקון' });
  }
}

/**
 * PATCH /payslip-audit/history/:id/fix-rounds/:roundNo/verdict
 * Body: { key, note_index, manual_verdict: 'fixed'|'not_fixed'|null, reply }
 * Lets a human settle the notes the re-check couldn't grade, or overrule it.
 */
async function setFixVerdict(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const round = (doc.fix_rounds || []).find((r) => r.round_no === Number(req.params.roundNo));
    if (!round) return res.status(404).json({ error: 'סבב לא נמצא' });
    const item = round.items.find((i) => i.key === req.body.key);
    if (!item) return res.status(404).json({ error: 'עובד לא נמצא בסבב' });
    const note = item.notes[Number(req.body.note_index)];
    if (!note) return res.status(404).json({ error: 'הערה לא נמצאה' });

    const v = req.body.manual_verdict;
    if (v !== undefined) note.manual_verdict = (v === 'fixed' || v === 'not_fixed') ? v : null;
    if (typeof req.body.reply === 'string') note.reply = req.body.reply.slice(0, 1000);

    // Keep the headline counts honest — they drive the "can we close this
    // month" call, so a manual decision has to move them.
    const s = { employees: round.items.length, notes: 0, fixed: 0, not_fixed: 0, manual: 0, unmatched: 0, new_issues: 0 };
    for (const it of round.items) {
      s.notes += it.notes.length;
      if (!it.matched) s.unmatched += 1;
      s.new_issues += it.new_findings.length;
      for (const n of it.notes) {
        const eff = n.manual_verdict || n.auto_verdict;
        s[eff === 'fixed' ? 'fixed' : eff === 'not_fixed' ? 'not_fixed' : 'manual'] += 1;
      }
    }
    round.summary = s;
    doc.markModified('fix_rounds');
    await doc.save();
    res.json({ success: true, summary: s });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בעדכון הכרעה' });
  }
}

/**
 * POST /payslip-audit/history/:id/notes
 * Body: { key | audit_idx, message, severity? }
 *
 * Append ONE correction to an employee on this audit.
 *
 * A payslip signed off in round 1 turns out to have a problem in round 2. The
 * whole review does not need redoing — the employee just has to carry a live
 * correction again, which is what puts them in the next round. This appends
 * surgically rather than through the editor's whole-audit save, because the
 * screen the user is on when they notice is showing the ROUND's results, and
 * saving that set over the origin would wipe the notes it was graded against.
 */
async function addAuditNote(req, res) {
  try {
    const { key, audit_idx, message, severity = 'critical' } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'נדרש תוכן לתיקון' });
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });

    const full = { ...(doc.full_result || {}) };
    const results = full.results || [];
    let idx = Number.isInteger(audit_idx) ? audit_idx : -1;
    if (idx < 0 && key) idx = results.findIndex((r) => targetKey(r) === key);
    if (idx < 0 || idx >= results.length) return res.status(404).json({ error: 'עובד לא נמצא בביקורת' });

    const ver = { ...(full.editor_verifications || {}) };
    const list = [...(ver[idx] || [])];
    if (list.some((n) => n.message === String(message).trim() && n.status !== 'rejected')) {
      return res.status(409).json({ error: 'התיקון הזה כבר קיים לעובד/ת' });
    }
    list.push({
      field: 'manual',
      severity: severity === 'warning' ? 'warning' : 'critical',
      message: String(message).trim(),
      status: 'approved',
      note: '',
    });
    ver[idx] = list;
    full.editor_verifications = ver;
    doc.full_result = full;
    doc.markModified('full_result');
    await doc.save();

    const r = results[idx];
    res.json({
      success: true,
      employee: r.table_row?.employee_name || r.payslip?.employee_name || '—',
      open_notes: fixTargetsFrom(doc).reduce((s, t) => s + t.notes.length, 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בהוספת התיקון' });
  }
}

/**
 * POST /payslip-audit/history/:id/fix-rounds/:roundNo/approve
 * Body: { force?: boolean, note?: string }
 *
 * Close the cycle on a round. Every note has to be settled — a note still
 * reading ✗ לא תוקן or ? להכרעה blocks it, because approving is what releases
 * the payslips to the branch managers and to the employees themselves, and
 * that is not a step to take over an open question. `force` overrides with the
 * override recorded on the round.
 *
 * The round's PDFs are copied into the audit's 'approved' slot. Every
 * distribution path reads through loadBranchPdf, which prefers 'approved' —
 * so this is what makes the send deliver the CORRECTED payslips instead of the
 * file the month started with.
 */
async function approveFixRound(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const round = (doc.fix_rounds || []).find((r) => r.round_no === Number(req.params.roundNo));
    if (!round) return res.status(404).json({ error: 'סבב לא נמצא' });

    const open = [];
    for (const it of round.items || []) {
      for (const n of it.notes || []) {
        const eff = n.manual_verdict || n.auto_verdict;
        if (eff !== 'fixed') open.push({ employee: it.employee_name, message: n.message, verdict: eff });
      }
    }
    const force = req.body?.force === true;
    if (open.length && !force) {
      return res.status(409).json({
        error: `${open.length} הערות עדיין לא סגורות — אשר אותן או השתמש ב"אשר בכל זאת"`,
        open_notes: open,
      });
    }

    // Promote this round's uploads to the approved copy.
    const kind = `fix_${round.round_no}`;
    const pdfs = await PayslipAuditPdf.find({ audit_id: doc._id, kind }).lean();
    for (const p of pdfs) {
      const bytes = p.data?.buffer ? Buffer.from(p.data.buffer) : Buffer.from(p.data);
      await storePayslipPdfDb(doc._id, p.branch, bytes, 'approved');
      try {
        ensureDir(path.join(PDF_STORAGE_DIR, String(doc._id), 'approved'));
        fs.writeFileSync(approvedPdfStoragePath(doc._id, p.branch), bytes);
      } catch (e) { /* disk is a convenience; Mongo is the durable copy */ }
    }

    round.approved = true;
    round.approved_at = new Date();
    round.approved_by_name = req.user?.full_name || '';
    round.approved_forced = !!open.length;

    doc.approved = true;
    doc.approved_at = new Date();
    doc.approved_by = req.user?.id || null;
    doc.approved_by_name = req.user?.full_name || '';
    if (round.uploaded_files?.length) doc.approved_payslip_files = round.uploaded_files;
    if (typeof req.body?.note === 'string' && req.body.note.trim()) doc.approved_note = req.body.note.trim();
    doc.markModified('fix_rounds');
    await doc.save();

    res.json({
      success: true,
      round_no: round.round_no,
      forced: !!open.length,
      open_notes: open.length,
      pdfs_promoted: pdfs.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה באישור הסבב' });
  }
}

/**
 * GET /payslip-audit/history/:id/fix-rounds/:roundNo/page?branch=&page=
 * One page out of a round's PDF, for the old-vs-new preview.
 */
async function getFixRoundPage(req, res) {
  try {
    const roundNo = Number(req.params.roundNo);
    const branch = (req.query.branch || '').toString();
    const page = Number(req.query.page);
    if (!branch || !page) return res.status(400).json({ error: 'נדרש branch ו-page' });
    const rec = await PayslipAuditPdf.findOne({ audit_id: req.params.id, branch, kind: `fix_${roundNo}` }).lean();
    if (!rec?.data) return res.status(404).json({ error: 'קובץ הסבב לא נמצא' });
    const bytes = rec.data.buffer ? Buffer.from(rec.data.buffer) : Buffer.from(rec.data);
    const out = await extractPage(bytes, page);
    if (!out) return res.status(404).json({ error: 'עמוד לא נמצא' });
    res.setHeader('Content-Type', 'application/pdf');
    res.send(out);
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת עמוד' });
  }
}

/**
 * GET /payslip-audit/prior-notes?year_month=YYYY-MM&exclude_audit_id=...
 *
 * Every note already sent to the accountant this month, keyed by employee.
 *
 * Checking a payslip means asking "did he do what I asked" — but the ask lived
 * in an email and in a previous audit, so the reviewer was comparing numbers
 * with no memory of what was requested. A note that was silently ignored looked
 * identical to one that never existed. This hands the reviewer their own words
 * back, with the correction round's verdict attached when there is one.
 */
async function getPriorNotes(req, res) {
  const ym = (req.query.year_month || '').toString().trim();
  if (!ym) return res.status(400).json({ error: 'נדרש year_month' });
  const exclude = (req.query.exclude_audit_id || '').toString();
  try {
    const docs = await PayslipAuditRecord.find({ year_month: ym })
      .sort({ created_at: 1 })
      .limit(20)
      .lean();

    const items = {};
    for (const d of docs) {
      if (exclude && String(d._id) === exclude) continue;
      // The verdict the last correction round reached for each note, so a note
      // that came back ✗ לא תוקן is visible as such while re-checking.
      const verdicts = new Map();
      for (const round of d.fix_rounds || []) {
        for (const it of round.items || []) {
          for (const n of it.notes || []) {
            verdicts.set(`${it.key}::${n.message}`, {
              verdict: n.manual_verdict || n.auto_verdict,
              round_no: round.round_no,
            });
          }
        }
      }
      for (const t of fixTargetsFrom(d)) {
        const key = targetKey(t.result);
        if (!items[key]) items[key] = [];
        for (const n of t.notes) {
          const v = verdicts.get(`${key}::${n.message}`);
          items[key].push({
            audit_id: String(d._id),
            created_at: d.created_at,
            severity: n.severity || 'critical',
            message: n.message,
            verdict: v ? v.verdict : null,
            verdict_round: v ? v.round_no : null,
          });
        }
      }
    }
    res.json({ year_month: ym, items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בטעינת הערות קודמות' });
  }
}

// ── Accountant upload link ─────────────────────────────────────────────────
//
// The accountant has no account here. Rather than make the office the only
// route in — mail arrives, someone downloads, someone re-uploads — he gets a
// tokenised page that accepts his corrected PDFs straight into a round. The
// page exposes only what we already emailed him: the month and his own notes.

const FIX_TOKEN_TTL_DAYS = 30;

/** POST /payslip-audit/history/:id/fix-token → mint (or re-mint) the link. */
async function createFixToken(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || FIX_TOKEN_TTL_DAYS, 1), 180);
    doc.fix_token = require('crypto').randomBytes(24).toString('hex');
    doc.fix_token_created_at = new Date();
    doc.fix_token_expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await doc.save();
    res.json({ success: true, token: doc.fix_token, expires: doc.fix_token_expires });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה ביצירת קישור' });
  }
}

/** DELETE /payslip-audit/history/:id/fix-token → kill the link. */
async function revokeFixToken(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    doc.fix_token = null;
    doc.fix_token_expires = null;
    await doc.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה בביטול הקישור' });
  }
}

async function auditByFixToken(token) {
  if (!token || String(token).length < 20) return null;
  const doc = await PayslipAuditRecord.findOne({ fix_token: String(token) });
  if (!doc) return null;
  if (doc.fix_token_expires && doc.fix_token_expires.getTime() < Date.now()) return null;
  return doc;
}

/**
 * GET /public/payslip-fix/:token
 * What the accountant sees before uploading: the month, the branches we expect
 * files for, and his own notes grouped by employee. No salary figures beyond
 * the ones already in the notes he received.
 */
async function publicFixInfo(req, res) {
  try {
    const doc = await auditByFixToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'הקישור אינו תקף או שפג תוקפו' });
    const targets = fixTargetsFrom(doc);
    res.json({
      year_month: doc.year_month || '',
      branches: [...new Set((doc.payslip_files || []).map((f) => f.branch).filter(Boolean))],
      rounds_so_far: (doc.fix_rounds || []).length,
      employees: targets.map((t) => ({
        name: t.result.table_row?.employee_name || t.result.payslip?.employee_name || '—',
        branch: (t.result.__source_branch || t.result.table_row?.branch || '').replace(/\s+/g, ' ').trim(),
        employee_no: t.result.payslip?.employee_no ?? null,
        notes: t.notes.map((n) => ({ severity: n.severity, message: n.message })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'שגיאה' });
  }
}

/** POST /public/payslip-fix/:token/upload  (multipart, same fields as a round) */
async function publicFixUpload(req, res) {
  try {
    const doc = await auditByFixToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'הקישור אינו תקף או שפג תוקפו' });
    const entries = payslipEntriesFrom(req);
    if (entries.length === 0) return res.status(400).json({ error: 'נדרש לפחות קובץ תלושים אחד' });
    const round = await runFixRound(doc, entries, { source: 'accountant', note: req.body.note });
    // The uploader gets a receipt, not the verdicts — grading the office's own
    // notes is the office's call to look at first.
    res.json({
      success: true,
      round_no: round.round_no,
      employees_checked: round.summary.employees,
      received: entries.map((e) => e.file.originalname),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'שגיאה בהעלאה' });
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
  // "שכר בסיס" = pay for REGULAR hours only (matches the on-screen table column).
  // For a global employee that's the teken regular_pay; otherwise the computed base.
  const baseRegular = isGlobal
    ? (tb?.regular_pay != null ? Math.round(tb.regular_pay) : (gsal != null ? Math.round(gsal) : null))
    : rnd(comp.base_salary);
  // Absence breakdown for the auditor: the number of DAYS and/or HOURS to offset
  // (not just the ₪ amount), plus any hours worked BEYOND the commitment that
  // were approved for payment. ded.absence = whole-day deduction; the partial
  // (hours) shortfall deduction lives on r.partial_absence.
  const abs = r.absence || {};
  const pa = r.partial_absence || {};
  const n1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const ddmm = (ymd) => { const p = String(ymd).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : ymd; };
  const absDatesStr = (abs.deductible_dates || []).map(ddmm).join(', ');
  const totalAbsenceDed = rnd((_num(ded.absence) || 0) + (_num(pa.deduction) || 0));
  const absenceDetail = [
    { label: 'ימי היעדרות לקיזוז', value: abs.deductible_days ? `${abs.deductible_days} ${abs.deductible_days === 1 ? 'יום' : 'ימים'}${absDatesStr ? ` (${absDatesStr})` : ''}` : '' },
    { label: 'שעות חוסר לקיזוז', value: pa.effective_hours ? `${n1(pa.effective_hours)} ש׳` : '' },
    { label: 'שעות מעבר להתחייבות (אושרו לתשלום)', value: pa.extra_approved_hours ? `${n1(pa.extra_approved_hours)} ש׳${pa.extra_pay ? ` · ₪${Math.round(pa.extra_pay).toLocaleString('he-IL')}` : ''}` : '' },
    { label: 'סה״כ ניכוי היעדרות', value: totalAbsenceDed || null, currency: true },
  ];

  // Full, ordered detail of every column shown in the system salary table, so the
  // preview can list each value the accountant was given (not just the compared ones).
  const system_detail = [
    { label: 'ימי עבודה', value: _num(bd.hours?.days_worked) },
    { label: 'שעות רגילות', value: _num(bd.hours?.regular) },
    { label: 'שע"נ 125%', value: _num(bd.hours?.ot_125) },
    { label: 'שע"נ 150%', value: _num(bd.hours?.ot_150) },
    { label: 'תעריף לשעה', value: perHour, currency: true },
    { label: 'שכר תקן (מוסכם)', value: gsal, currency: true },
    { label: 'שכר בסיס', value: baseRegular, currency: true },
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
    ...absenceDetail,
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
    // The payslip "שכר יסוד" is compared to OUR regular base (שכר בסיס), not the
    // agreed teken — the teken absorbs OT/completion while the payslip pays base
    // + OT separately, so base↔base is the meaningful comparison. Only for global
    // employees; hourly stay null so they're compared on hours, not base.
    global_salary_amount: isGlobal ? baseRegular : null,
    agreed_salary: gsal,
    global_ot_amount: null,
    emuna_ks_global: null, emuna_ks_global_ot: null, emuna_hz_global: null, emuna_hz_global_ot: null,
    transport: _num(comp.travel),
    sick_days: _num(r.manual?.sick_days),
    absence: null,
    vacation_days: _num(r.vacation_eff_days) ?? _num(r.manual?.vacation_days),
    holiday_days: _num(r.holiday_pay_auto?.total_days),
    holiday_pay_expected: rnd(r.holiday_pay_auto?.total_pay), // for amount-based payslip match
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

  // All-branches mode: one PDF holding payslips of every branch. We compare it
  // against the WHOLE month (no per-file branch); ת"ז matching routes each
  // payslip to its employee regardless of branch.
  const allBranchesMode = req.body?.all_branches === 'true' || req.body?.all_branches === true;
  const payslipEntries = [];
  for (const key of Object.keys(req.files || {})) {
    const m = key.match(/^payslip_file_(\d+)$/);
    if (!m) continue;
    const idx = m[1];
    const file = req.files[key][0];
    const branch = (req.body[`branch_${idx}`] || '').trim() || (allBranchesMode ? 'כל הסניפים' : '');
    if (!branch) return res.status(400).json({ error: `חסר שם סניף לקובץ ${file.originalname}` });
    payslipEntries.push({ idx: Number(idx), file, branch });
  }
  payslipEntries.sort((a, b) => a.idx - b.idx);
  if (payslipEntries.length === 0) return res.status(400).json({ error: 'נדרש לפחות קובץ תלושים אחד' });

  try {
    const monthData = await fetchSystemMonth(req.user, month);
    // Freelancers issue an invoice, not a payslip — exclude them from the audit.
    const allRows = (monthData.rows || []).filter((r) => !r.is_freelancer).map(systemRowToTableRow);

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
      // All-branches mode compares against every system row; otherwise filter to
      // the file's branch.
      const branchRows = allBranchesMode ? allRows : allRows.filter((r) => {
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
      // Durable copy in Mongo (disk is ephemeral on the host).
      for (const entry of payslipEntries) {
        await storePayslipPdfDb(saved._id, entry.branch, entry.file.buffer);
      }
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

// ─── Payslip distribution ──────────────────────────────────────────────────
// Load a branch's stored payslip PDF bytes (prefer the approved copy).
async function loadBranchPdf(auditId, branch) {
  for (const kind of ['approved', 'original']) {
    const dbDoc = await PayslipAuditPdf.findOne({ audit_id: auditId, branch, kind }).lean();
    if (dbDoc?.data) return dbDoc.data.buffer ? Buffer.from(dbDoc.data.buffer) : Buffer.from(dbDoc.data);
    const fp = kind === 'approved' ? approvedPdfStoragePath(auditId, branch) : pdfStoragePath(auditId, branch);
    if (fs.existsSync(fp)) return fs.readFileSync(fp);
  }
  return null;
}

// Extract a single 1-based page from PDF bytes → a one-page PDF Buffer.
async function extractPage(srcBytes, pageNum) {
  const { PDFDocument } = require('pdf-lib');
  const srcDoc = await PDFDocument.load(srcBytes);
  if (!pageNum || pageNum < 1 || pageNum > srcDoc.getPageCount()) return null;
  const outDoc = await PDFDocument.create();
  const [copied] = await outDoc.copyPages(srcDoc, [pageNum - 1]);
  outDoc.addPage(copied);
  return Buffer.from(await outDoc.save());
}

// Merge the payslip pages of a set of grouped employees (each carries its page +
// the source PDF that holds it) into one PDF Buffer. Used to build a branch's
// bundle when there's no dedicated per-branch PDF (all-in-one audits).
async function mergeGroupPages(doc, employees, pdfCache) {
  const { PDFDocument } = require('pdf-lib');
  const chosen = (employees || []).filter(e => e.has_page && e.page);
  if (chosen.length === 0) return null;
  const bySource = new Map();
  for (const e of chosen) { if (!bySource.has(e.source_branch)) bySource.set(e.source_branch, []); bySource.get(e.source_branch).push(e.page); }
  const merged = await PDFDocument.create();
  for (const [src, pages] of bySource) {
    let bytes;
    if (pdfCache) { if (!pdfCache.has(src)) pdfCache.set(src, await loadBranchPdf(doc._id, src)); bytes = pdfCache.get(src); }
    else bytes = await loadBranchPdf(doc._id, src);
    if (!bytes) continue;
    const srcDoc = await PDFDocument.load(bytes);
    const total = srcDoc.getPageCount();
    const idx = [...new Set(pages)].filter(p => p >= 1 && p <= total).map(p => p - 1);
    const cp = await merged.copyPages(srcDoc, idx);
    cp.forEach(pg => merged.addPage(pg));
  }
  if (merged.getPageCount() === 0) return null;
  return Buffer.from(await merged.save());
}

// Extract several 1-based pages (in the given order) → one merged PDF Buffer.
async function extractPages(srcBytes, pageNums) {
  const { PDFDocument } = require('pdf-lib');
  const srcDoc = await PDFDocument.load(srcBytes);
  const total = srcDoc.getPageCount();
  const idx = [...new Set(pageNums)].filter(p => p >= 1 && p <= total).map(p => p - 1);
  if (idx.length === 0) return null;
  const outDoc = await PDFDocument.create();
  const copied = await outDoc.copyPages(srcDoc, idx);
  copied.forEach(pg => outDoc.addPage(pg));
  return Buffer.from(await outDoc.save());
}

const BRANCH_MGR_EMAILS_KEY = 'branch_manager_emails';
async function readBranchManagerEmails() {
  const doc = await Setting.findOne({ key: BRANCH_MGR_EMAILS_KEY }).lean();
  return (doc && doc.value && typeof doc.value === 'object') ? doc.value : {};
}

// GET /payslip-audit/branch-manager-emails → { branches: [{ id, name, email }] }
async function getBranchManagerEmails(req, res) {
  try {
    const stored = await readBranchManagerEmails();
    const branches = await Branch.find({ is_active: true }).select('_id name').sort({ name: 1 }).lean();
    res.json({ branches: branches.map(b => ({ id: String(b._id), name: b.name, email: stored[String(b._id)] || '' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// PUT /payslip-audit/branch-manager-emails { emails: { [branchId]: email } }
async function setBranchManagerEmails(req, res) {
  try {
    const incoming = (req.body && typeof req.body.emails === 'object' && req.body.emails) ? req.body.emails : {};
    const clean = {};
    for (const [bid, email] of Object.entries(incoming)) {
      const e = String(email || '').trim();
      if (e) clean[bid] = e;
    }
    await Setting.findOneAndUpdate({ key: BRANCH_MGR_EMAILS_KEY }, { value: clean }, { upsert: true });
    res.json({ ok: true, emails: clean });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Persist a send log onto the audit record so the client can show what happened.
// A "real" employee email — synthetic app-login addresses (<ת"ז>@gan-halomot.local
// and the like) are NOT inboxes; falling back to them silently sent payslips
// into the void. Returns null when the employee has no genuine address.
function realEmployeeEmail(emp) {
  for (const cand of [emp?.email, emp?.user_id?.email]) {
    const e = String(cand || '').trim();
    if (!e) continue;
    if (/@gan-halomot\.local$/i.test(e) || /@ganhalomot\.co\.il$/i.test(e)) continue;
    return e;
  }
  return null;
}

async function saveDistributionLog(auditId, key, payload) {
  try {
    const doc = await PayslipAuditRecord.findById(auditId);
    if (!doc) return;
    const fr = { ...doc.full_result };
    fr.distribution = { ...(fr.distribution || {}), [key]: payload };
    doc.full_result = fr;
    doc.markModified('full_result');
    await doc.save();
  } catch (e) { console.error('saveDistributionLog failed:', e.message); }
}

// On boot, close out distribution logs left in "running" state — the process
// died mid-job (OOM/restart) and would otherwise show "בתהליך..." forever.
// Partial results (the per-branch progress trail) are preserved.
async function finalizeStaleDistributionLogs() {
  try {
    const keys = ['managers', 'employees'];
    const or = keys.map(k => ({ [`full_result.distribution.${k}.running`]: true }));
    const docs = await PayslipAuditRecord.find({ $or: or }).select('_id full_result.distribution').lean();
    for (const d of docs) {
      for (const k of keys) {
        const entry = d.full_result?.distribution?.[k];
        if (!entry?.running) continue;
        await PayslipAuditRecord.updateOne({ _id: d._id }, {
          $set: { [`full_result.distribution.${k}.running`]: false },
          $push: { [`full_result.distribution.${k}.results`]: { branch: '—', name: '—', status: 'error', error: 'השליחה נקטעה — השרת אותחל באמצע. מה שסומן "נשלח" נשלח; נסה/י שוב עבור השאר.' } },
        });
        console.error(`finalized stale ${k} distribution log on audit ${d._id}`);
      }
    }
    // Same for the month-based hours-distribution logs.
    const { HoursDistributionLog } = require('../models');
    const stale = await HoursDistributionLog.find({ running: true }).lean();
    for (const s of stale) {
      await HoursDistributionLog.updateOne({ _id: s._id }, {
        $set: { running: false },
        $push: { results: { branch: '—', name: '—', status: 'error', error: 'השליחה נקטעה — השרת אותחל באמצע. מה שסומן "נשלח" נשלח; נסה/י שוב עבור השאר.' } },
      });
      console.error(`finalized stale hours ${s.kind} log for ${s.month}`);
    }
  } catch (e) { console.error('finalizeStaleDistributionLogs:', e.message); }
}

// ── Month-based log for the HOURS distribution (no audit doc to hang it on) ──
async function saveHoursLog(month, kind, payload) {
  try {
    const { HoursDistributionLog } = require('../models');
    await HoursDistributionLog.findOneAndUpdate({ month, kind }, { month, kind, ...payload }, { upsert: true });
  } catch (e) { console.error('saveHoursLog failed:', e.message); }
}

// Hours-distribution twin of runDistributionJob: durable "running" entry on
// accept, fatal-error entry instead of a silent death, and the post-job
// memory recycle for the 512MB tier.
function runHoursJob(month, kind, userId, job) {
  void (async () => {
    try {
      await saveHoursLog(month, kind, { at: new Date(), by: userId, running: true, results: [] });
      const results = await job();
      await saveHoursLog(month, kind, { at: new Date(), by: userId, running: false, results: results || [] });
    } catch (e) {
      console.error(`hours distribution ${kind} fatal:`, e);
      await saveHoursLog(month, kind, { at: new Date(), by: userId, running: false, results: [{ branch: '—', name: '—', status: 'error', error: `תקלה כללית: ${e.message}` }] });
    }
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > 300) {
      console.error(`recycling instance after hours ${kind} distribution (rss ${Math.round(rssMb)}MB)`);
      setTimeout(() => process.exit(0), 3000);
    }
  })();
}

// Run a background distribution job with a durable trail: an immediate
// "running" entry makes every accepted send visible in the log right away, and
// a fatal error (thrown outside the per-item try/catch, or the process's last
// words before an OOM kill would leave nothing) is logged instead of the job
// silently vanishing — "clicked and nothing happened" becomes diagnosable.
function runDistributionJob(auditId, key, userId, job) {
  void (async () => {
    try {
      await saveDistributionLog(auditId, key, { at: new Date(), by: userId, running: true, results: [] });
      const results = await job();
      await saveDistributionLog(auditId, key, { at: new Date(), by: userId, results: results || [] });
    } catch (e) {
      console.error(`distribution ${key} fatal:`, e);
      await saveDistributionLog(auditId, key, { at: new Date(), by: userId, results: [{ branch: '—', name: '—', status: 'error', error: `תקלה כללית: ${e.message}` }] });
    }
    // Memory hygiene on the 512MB tier: V8 doesn't return a heavy job's heap
    // to the OS (no --expose-gc available), so a SECOND job would start near
    // the ceiling and get OOM-killed. The job is done and its log saved —
    // recycle the process while idle; Render restarts it fresh in ~15s.
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > 300) {
      console.error(`recycling instance after ${key} distribution (rss ${Math.round(rssMb)}MB)`);
      setTimeout(() => process.exit(0), 3000);
    }
  })();
}

// POST /payslip-audit/history/:id/send-employees — each matched employee gets
// their own payslip page + their hours report. Runs in the background (many
// emails + PDF work exceed the 30s HTTP timeout); the log is saved on the record.
async function sendPayslipsToEmployees(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const month = doc.year_month;
    if (!month) return res.status(400).json({ error: 'לביקורת אין חודש (year_month)' });
    const results = doc.full_result?.results || [];
    if (results.length === 0) return res.status(400).json({ error: 'אין תלושים בביקורת' });
    // Optional selection: send only to these employee _ids. Absent → send to all.
    const selectedIds = (Array.isArray(req.body?.employee_ids) && req.body.employee_ids.length)
      ? new Set(req.body.employee_ids.map(String)) : null;
    const includeHours = req.body?.include_hours !== false; // default: attach hours report
    // Test mode: `to` reroutes EVERY employee's email to one address and skips
    // the side effects (no archiving, no marking the month paid) — for
    // verifying content/matching before a real send.
    const toOverride = String(req.body?.to || '').trim();
    const userId = req.user?.id || null;
    res.json({ ok: true, queued: true, count: selectedIds ? selectedIds.size : results.length });

    runDistributionJob(doc._id, 'employees', userId, async () => {
      const { hoursReportEmailAttachments, renderHoursPdfPerEmployee } = require('./payroll.controller');
      const pdfCache = new Map();
      const out = [];
      // Pre-render every selected employee's hours PDF in ONE browser pass —
      // a Chromium launch per employee costs minutes across a big send.
      let hoursPdfByEmp = new Map();
      if (includeHours) {
        try {
          const ids = [];
          for (const r of results) {
            const iid = String(r.payslip?.employee_id || r.table_row?.israeli_id || '').trim();
            if (!iid) continue;
            const emp = await Employee.findOne({ israeli_id: iid }).select('_id').lean();
            if (emp && (!selectedIds || selectedIds.has(String(emp._id)))) ids.push(emp._id);
          }
          if (ids.length) hoursPdfByEmp = await renderHoursPdfPerEmployee(ids, month, { role: 'system_admin' });
        } catch (e) { console.error('hours pre-render failed (per-employee fallback):', e.message); }
      }
      let sinceLog = 0;
      for (const r of results) {
        const dispName = r.payslip?.employee_name || r.table_row?.employee_name || 'עובד';
        const israeliId = String(r.payslip?.employee_id || r.table_row?.israeli_id || '').trim();
        const branch = (r.__source_branch || r.table_row?.branch || '').replace(/\s+/g, ' ').trim();
        const page = r.payslip?.page_index || null;
        try {
          const emp = israeliId ? await Employee.findOne({ israeli_id: israeliId }).populate('user_id', 'email').lean() : null;
          if (!emp) { out.push({ name: dispName, status: 'no_match' }); continue; }
          if (selectedIds && !selectedIds.has(String(emp._id))) continue; // not selected for this send
          const email = toOverride || realEmployeeEmail(emp);
          if (!email) { out.push({ name: emp.full_name, status: 'no_email' }); continue; }
          if (!page || !branch) { out.push({ name: emp.full_name, status: 'no_page' }); continue; }
          if (!pdfCache.has(branch)) pdfCache.set(branch, await loadBranchPdf(doc._id, branch));
          const bytes = pdfCache.get(branch);
          if (!bytes) { out.push({ name: emp.full_name, status: 'no_pdf' }); continue; }
          const pageBuf = await extractPage(bytes, page);
          if (!pageBuf) { out.push({ name: emp.full_name, status: 'no_page' }); continue; }
          const fileAttachments = [{ filename: `payslip-${month}.pdf`, contentBase64: pageBuf.toString('base64'), contentType: 'application/pdf' }];
          const attachments = [];
          if (includeHours) {
            const pre = hoursPdfByEmp.get(String(emp._id));
            if (pre) fileAttachments.push({ filename: `hours-report-${month}.pdf`, contentBase64: pre.toString('base64'), contentType: 'application/pdf' });
            else {
              const att = await hoursReportEmailAttachments([emp._id], month, { role: 'system_admin' }, `hours-report-${month}`);
              if (att.fileAttachments) fileAttachments.push(...att.fileAttachments); else attachments.push(...att.attachments);
            }
          }
          const introBody = includeHours
            ? `<p>מצורפים תלוש השכר שלך ודוח השעות שלך לחודש ${month}.</p>`
            : `<p>מצורף תלוש השכר שלך לחודש ${month}.</p>`;
          const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום ${emp.full_name},</p>${introBody}<p>בברכה,<br>הנהלת גן החלומות</p></div>`;
          await dispatchEmail({
            to: email,
            subject: `${includeHours ? 'תלוש שכר ודוח שעות' : 'תלוש שכר'} — ${month}${toOverride ? ` — ${emp.full_name} (בדיקה)` : ''}`,
            html: intro,
            fileAttachments,
            attachments,
          });
          // Archive the payslip to the employee's file + mark the month paid —
          // but NOT in test mode (`to` override).
          if (!toOverride) {
            try {
              await SavedPayslip.findOneAndUpdate(
                { employee_id: emp._id, year_month: month },
                { employee_id: emp._id, israeli_id: emp.israeli_id || israeliId, year_month: month, branch,
                  data: pageBuf, audit_id: doc._id, page, sent_to: email, sent_at: new Date(), sent_by: userId },
                { upsert: true },
              );
              await PayrollMonth.findOneAndUpdate(
                { employee_id: emp._id, month },
                { payslip_paid: true, payslip_paid_at: new Date(), payslip_sent_to: email },
              );
            } catch (se) { console.error('archive payslip failed:', emp.full_name, se.message); }
          }
          out.push({ name: emp.full_name, email, status: 'sent' });
        } catch (e) {
          out.push({ name: dispName, status: 'error', error: e.message });
        }
        // Progress trail every few employees so the UI shows where the job stands.
        if (++sinceLog >= 5) { sinceLog = 0; await saveDistributionLog(doc._id, 'employees', { at: new Date(), by: userId, running: true, results: out }); require('../services/htmlPdf').tryGc(); }
      }
      return out;
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Group an audit's payslips by each employee's REAL branch (from their employee
// record), NOT the payslip's PDF tag. This makes a single "all branches" PDF
// (tag "כל הסניפים") split correctly per branch for the manager send. Each
// employee keeps its `source_branch` — the stored PDF its page physically lives
// in — separate from its real branch (for email + grouping).
const OFFICE_KEY = '__office__';
const OFFICE_NAME = 'כל הסניפים';
// OFFICE_EMAIL is declared once near the top of this file (accountant section).

async function buildManagerBranchGroups(doc) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const results = doc.full_result?.results || [];
  const allBranches = await Branch.find({}).select('_id name').lean();
  const byId = new Map(allBranches.map(b => [String(b._id), b]));
  const havePdf = new Set((await PayslipAuditPdf.find({ audit_id: doc._id }).select('branch').lean()).map(p => norm(p.branch)));
  const groups = new Map();
  // Office master copy — the FULL set of payslips, sent to the office email.
  // Kept first (insertion order) and holds every payslip.
  groups.set(OFFICE_KEY, { name: OFFICE_NAME, br: null, isOffice: true, employees: [], hasPdfSource: false });
  const office = groups.get(OFFICE_KEY);
  for (const r of results) {
    const page = r.payslip?.page_index || null;
    // Only actual payslip PAGES are distributable. Skip salary-table rows that
    // have no payslip in the PDF (they'd otherwise show as false "לא מותאם").
    if (!page) continue;
    const sourceBranch = norm(r.__source_branch || r.table_row?.branch || '');
    const iid = String(r.payslip?.employee_id || r.table_row?.israeli_id || '').trim();
    const emp = iid ? await Employee.findOne({ israeli_id: iid }).select('_id full_name branch_id').lean() : null;
    const entry = {
      employee_id: emp ? String(emp._id) : null,
      name: emp ? emp.full_name : (r.payslip?.employee_name || r.table_row?.employee_name || '—'),
      israeli_id: iid, page, has_page: !!page, matched: !!emp, source_branch: sourceBranch,
    };
    // Every payslip goes into the office master copy…
    office.employees.push(entry);
    if (havePdf.has(sourceBranch)) office.hasPdfSource = true;
    // …and matched ones also into their real branch group.
    if (emp && emp.branch_id && byId.has(String(emp.branch_id))) {
      const br = byId.get(String(emp.branch_id));
      const key = norm(br.name);
      if (!groups.has(key)) groups.set(key, { name: br.name, br, employees: [], hasPdfSource: false });
      const g = groups.get(key);
      g.employees.push(entry);
      if (havePdf.has(sourceBranch)) g.hasPdfSource = true;
    }
  }
  return groups;
}

async function managerBranchEmails(group, stored) {
  if (group && group.isOffice) return [OFFICE_EMAIL];
  const br = group && group.br;
  if (!br) return [];
  if (stored[String(br._id)]) return [stored[String(br._id)]];
  const mgrs = await User.find({ role: 'branch_manager', $or: [{ managed_branch_ids: br._id }, { branch_id: br._id }] }).select('email').lean();
  return [...new Set(mgrs.map(m => m.email).filter(Boolean))];
}

// POST /payslip-audit/history/:id/send-managers — each branch manager gets the
// payslip pages of THEIR branch's employees (built from the audit's PDFs) + a
// hours report. Employees are grouped by their real branch; an optional
// branch_employees selection trims which employees are included.
async function sendPayslipsToManagers(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const month = doc.year_month;
    if (!month) return res.status(400).json({ error: 'לביקורת אין חודש (year_month)' });
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const groups = await buildManagerBranchGroups(doc);
    if (groups.size === 0) return res.status(400).json({ error: 'אין סניפים בביקורת' });
    let branchKeys = [...groups.keys()];
    if (Array.isArray(req.body?.branches) && req.body.branches.length) {
      const sel = new Set(req.body.branches.map(norm));
      branchKeys = branchKeys.filter(k => sel.has(norm(groups.get(k).name)));
      if (branchKeys.length === 0) return res.status(400).json({ error: 'לא נבחרו סניפים תקפים' });
    }
    const includeHours = req.body?.include_hours !== false;
    const toOverride = String(req.body?.to || '').trim(); // send all to one specific address
    const rawSel = (req.body?.branch_employees && typeof req.body.branch_employees === 'object') ? req.body.branch_employees : {};
    const branchSel = new Map();
    for (const [b, ids] of Object.entries(rawSel)) {
      if (Array.isArray(ids)) branchSel.set(norm(b), new Set(ids.map(String)));
    }
    const userId = req.user?.id || null;
    res.json({ ok: true, queued: true, count: branchKeys.length });

    runDistributionJob(doc._id, 'managers', userId, async () => {
      const { hoursReportEmailAttachments, buildRichHoursHtml } = require('./payroll.controller');
      const { PDFDocument } = require('pdf-lib');
      const stored = await readBranchManagerEmails();
      const pdfCache = new Map();
      const out = [];

      // Per-job hours-PDF cache (key: sorted employee ids), filled by the
      // single-pass render below. The office copy is the UNION of the branches
      // — merged from the cached branch PDFs, never re-rendered. Cache-only on
      // purpose: the send loop must NOT launch Chromium (see phase 2).
      const hoursCache = new Map();
      const hoursKeyOf = ids => ids.map(String).sort().join(',');
      const getHoursPdf = async (ids) => {
        const key = hoursKeyOf(ids);
        if (hoursCache.has(key)) return hoursCache.get(key);
        if (hoursCache.size > 0) {
          const target = new Set(key.split(','));
          const union = new Set([...hoursCache.keys()].flatMap(k => k.split(',')));
          if (target.size === union.size && [...target].every(x => union.has(x))) {
            const merged = await PDFDocument.create();
            for (const buf of hoursCache.values()) {
              const src = await PDFDocument.load(buf);
              (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
            }
            const outBuf = Buffer.from(await merged.save());
            hoursCache.set(key, outBuf);
            return outBuf;
          }
        }
        return null;
      };

      // Specific email → ONE consolidated bundle of ALL selected employees, sent
      // only to that address (not per-branch, not to managers).
      if (toOverride) {
        try {
          const seen = new Set(); const chosen = [];
          for (const key of branchKeys) {
            const g = groups.get(key);
            const sel = branchSel.get(norm(g.name));
            for (const e of g.employees) {
              if (!e.employee_id || !e.has_page || (sel && !sel.has(e.employee_id)) || seen.has(e.employee_id)) continue;
              seen.add(e.employee_id); chosen.push(e);
            }
          }
          if (chosen.length === 0) { out.push({ branch: toOverride, status: 'no_selection' }); }
          else {
            const bySource = new Map();
            for (const e of chosen) { if (!bySource.has(e.source_branch)) bySource.set(e.source_branch, []); bySource.get(e.source_branch).push(e.page); }
            const merged = await PDFDocument.create();
            for (const [src, pages] of bySource) {
              if (!pdfCache.has(src)) pdfCache.set(src, await loadBranchPdf(doc._id, src));
              const bytes = pdfCache.get(src); if (!bytes) continue;
              const srcDoc = await PDFDocument.load(bytes);
              const total = srcDoc.getPageCount();
              const idx = [...new Set(pages)].filter(p => p >= 1 && p <= total).map(p => p - 1);
              (await merged.copyPages(srcDoc, idx)).forEach(pg => merged.addPage(pg));
            }
            const pdfBuf = Buffer.from(await merged.save());
            const fileAttachments = [{ filename: `payslips-${month}.pdf`, contentBase64: pdfBuf.toString('base64'), contentType: 'application/pdf' }];
            const attachments = [];
            if (includeHours) {
              const att = await hoursReportEmailAttachments(chosen.map(e => e.employee_id), month, { role: 'system_admin' }, `hours-reports-${month}`);
              if (att.fileAttachments) fileAttachments.push(...att.fileAttachments); else attachments.push(...att.attachments);
            }
            const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p><p>מצורפים ${chosen.length} תלושי שכר${includeHours ? ' + דוחות שעות' : ''} לחודש ${month}.</p><p>בברכה,<br>הנהלת גן החלומות</p></div>`;
            await dispatchEmail({ to: [toOverride], subject: `תלושי שכר — ${month}`, html: intro, fileAttachments, attachments });
            out.push({ branch: toOverride, emails: [toOverride], status: 'sent' });
          }
        } catch (e) { out.push({ branch: toOverride, status: 'error', error: e.message }); }
        return out;
      }

      // ── Phase 1: resolve every group's recipients + chosen employees (no
      // heavy work), so all rendering can be batched into ONE Chromium pass.
      // Office last: its union copy merges from the branch PDFs.
      const orderedKeys = [...branchKeys].sort((a, b) => (groups.get(a)?.isOffice ? 1 : 0) - (groups.get(b)?.isOffice ? 1 : 0));
      const plan = [];
      for (const key of orderedKeys) {
        const g = groups.get(key);
        if (!g.br && !g.isOffice) { out.push({ branch: g.name, status: 'no_branch' }); continue; }
        const emails = await managerBranchEmails(g, stored);
        if (emails.length === 0) { out.push({ branch: g.name, status: 'no_manager' }); continue; }
        const sel = branchSel.get(norm(g.name));
        const chosen = g.employees.filter(e => e.employee_id && e.has_page && (!sel || sel.has(e.employee_id)));
        if (chosen.length === 0) { out.push({ branch: g.name, status: 'no_selection' }); continue; }
        plan.push({ g, label: g.br ? g.br.name : g.name, emails, chosen });
      }

      // ── Phase 2: render ALL hours PDFs in a SINGLE Chromium session. A
      // second browser launch later in the job — on top of an already-grown
      // heap — is exactly what OOM-killed the 512MB instance after branch #1.
      // Office copies whose set equals the union of the branches are merged
      // from the branch PDFs (no render at all); any other set renders here.
      if (includeHours && plan.length) {
        try {
          const { buildHoursChunkHtmls } = require('./payroll.controller');
          const nonOffice = plan.filter(p => !p.g.isOffice);
          const union = new Set(nonOffice.flatMap(p => p.chosen.map(e => String(e.employee_id))));
          const renderTargets = plan.filter(p => {
            if (!p.g.isOffice) return true;
            const ids = p.chosen.map(e => String(e.employee_id));
            return !(ids.length === union.size && ids.every(x => union.has(x)));
          });
          const metas = []; const chunkHtmls = [];
          for (const p of renderTargets) {
            const htmls = await buildHoursChunkHtmls(p.chosen.map(e => e.employee_id), month, { role: 'system_admin' });
            metas.push({ p, start: chunkHtmls.length, count: htmls.length });
            chunkHtmls.push(...htmls);
          }
          require('../services/htmlPdf').tryGc();
          const pdfs = chunkHtmls.length ? await require('../services/htmlPdf').htmlToPdfBatch(chunkHtmls) : [];
          for (const m of metas) {
            const slice = pdfs.slice(m.start, m.start + m.count);
            if (!slice.length) continue;
            let buf = slice[0];
            if (slice.length > 1) {
              const merged = await PDFDocument.create();
              for (const b of slice) {
                const src = await PDFDocument.load(b);
                (await merged.copyPages(src, src.getPageIndices())).forEach(pg => merged.addPage(pg));
              }
              buf = Buffer.from(await merged.save());
            }
            hoursCache.set(hoursKeyOf(m.p.chosen.map(e => e.employee_id)), buf);
          }
        } catch (e) { console.error('hours batch render failed (HTML fallback in loop):', e.message); }
        require('../services/htmlPdf').tryGc();
      }

      // ── Phase 3: build payslip bundles + send. No Chromium from here on —
      // hours PDFs come from the cache (office = union merge); if one is
      // missing, fall back to the GAS HTML conversion (no browser needed).
      for (const { g, label, emails, chosen } of plan) {
        try {
          // Extract each chosen employee's page from whichever stored PDF holds it.
          const bySource = new Map();
          for (const e of chosen) { if (!bySource.has(e.source_branch)) bySource.set(e.source_branch, []); bySource.get(e.source_branch).push(e.page); }
          const merged = await PDFDocument.create();
          for (const [src, pages] of bySource) {
            if (!pdfCache.has(src)) pdfCache.set(src, await loadBranchPdf(doc._id, src));
            const bytes = pdfCache.get(src);
            if (!bytes) continue;
            const srcDoc = await PDFDocument.load(bytes);
            const total = srcDoc.getPageCount();
            const idx = [...new Set(pages)].filter(p => p >= 1 && p <= total).map(p => p - 1);
            const cp = await merged.copyPages(srcDoc, idx);
            cp.forEach(pg => merged.addPage(pg));
          }
          if (merged.getPageCount() === 0) { out.push({ branch: g.name, status: 'no_pdf' }); continue; }
          const pdfBuf = Buffer.from(await merged.save());
          const fileAttachments = [{ filename: `payslips-${month}.pdf`, contentBase64: pdfBuf.toString('base64'), contentType: 'application/pdf' }];
          const attachments = [];
          if (includeHours) {
            const ids = chosen.map(e => e.employee_id);
            let hoursPdf = null;
            try { hoursPdf = await getHoursPdf(ids); } catch (e) { console.error('hours PDF for', label, e.message); }
            if (hoursPdf) fileAttachments.push({ filename: `hours-report-${month}.pdf`, contentBase64: hoursPdf.toString('base64'), contentType: 'application/pdf' });
            else {
              // Batch render missed this group — GAS HTML conversion fallback
              // (server-side, no local Chromium in the send loop).
              attachments.push({ name: `hours-report-${month}`, html: await buildRichHoursHtml(ids, month, { role: 'system_admin' }) });
            }
          }
          const scopeTxt = g.isOffice ? 'כל הסניפים' : `סניף <b>${label}</b>`;
          const introBody = includeHours
            ? `<p>מצורפים תלושי השכר של ${scopeTxt} לחודש ${month}, וכן דוח שעות.</p>`
            : `<p>מצורפים תלושי השכר של ${scopeTxt} לחודש ${month}.</p>`;
          const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p>${introBody}<p>בברכה,<br>הנהלת גן החלומות</p></div>`;
          await dispatchEmail({
            to: emails,
            subject: includeHours ? `תלושי שכר ודוח שעות — ${label} — ${month}` : `תלושי שכר — ${label} — ${month}`,
            html: intro,
            fileAttachments,
            attachments,
          });
          out.push({ branch: label, emails, status: 'sent' });
        } catch (e) {
          out.push({ branch: g.name, status: 'error', error: e.message });
        }
        // Progress trail: update the running log after every branch so the UI
        // shows exactly where the job stands (and where it died, if it dies).
        await saveDistributionLog(doc._id, 'managers', { at: new Date(), by: userId, running: true, results: out });
        // Return the branch's render memory to the OS before the next
        // Chromium launch — accumulated heap + Chromium together OOM'd the
        // 512MB instance mid-job.
        require('../services/htmlPdf').tryGc();
      }
      return out;
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /payslip-audit/history/:id/distribution-preview — per-payslip review
// before sending: match each payslip to an employee (by ת"ז), surface the email
// + ת"ז-verification status, and the last send log for display.
async function distributionPreview(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const results = doc.full_result?.results || [];
    const items = [];
    for (const r of results) {
      const payslipName = r.payslip?.employee_name || r.table_row?.employee_name || '';
      const israeliId = String(r.payslip?.employee_id || r.table_row?.israeli_id || '').trim();
      const branch = (r.__source_branch || r.table_row?.branch || '').replace(/\s+/g, ' ').trim();
      const page = r.payslip?.page_index || null;
      const emp = israeliId ? await Employee.findOne({ israeli_id: israeliId }).populate('user_id', 'email').lean() : null;
      const email = emp ? (realEmployeeEmail(emp) || '') : '';
      items.push({
        payslip_name: payslipName,
        payslip_id: israeliId,
        branch, page,
        matched: !!emp,
        id_verified: !!(emp && israeliId && String(emp.israeli_id).trim() === israeliId),
        employee_id: emp ? String(emp._id) : null,
        employee_name: emp ? emp.full_name : null,
        email,
        email_from_employee: !!(emp && emp.email && emp.email.trim()),
        has_page: !!page,
      });
    }
    res.json({ month: doc.year_month, items, distribution: doc.full_result?.distribution || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// PATCH /payslip-audit/history/:id/month { year_month } — correct the month an
// audit belongs to (e.g. June payslips uploaded in July). Everything that reads
// the month (hours reports, saved payslips, distribution) follows.
async function updateAuditMonth(req, res) {
  try {
    const ym = String(req.body?.year_month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'חודש לא תקין (YYYY-MM)' });
    const doc = await PayslipAuditRecord.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    doc.year_month = ym;
    await doc.save();
    res.json({ ok: true, year_month: ym });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// PUT /payslip-audit/employees/emails { updates: [{ employee_id, email }] } —
// persist each employee's email so it's reused on future sends.
async function updateEmployeeEmails(req, res) {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    let saved = 0;
    for (const u of updates) {
      if (!u || !u.employee_id) continue;
      await Employee.findByIdAndUpdate(u.employee_id, { email: String(u.email || '').trim() });
      saved++;
    }
    res.json({ ok: true, saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /payslip-audit/history/:id/hours-preview?scope=employee&employee_id=..
//   OR ?scope=branch&branch=.. — the exact hours-report HTML that WILL be sent,
// so the user can preview it before distributing.
async function hoursReportPreview(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).send('ביקורת לא נמצאה');
    const month = doc.year_month;
    const { buildRichHoursHtml } = require('./payroll.controller');
    let ids = [];
    if (req.query.scope === 'branch') {
      // Hours for exactly the employees in this branch's audit bundle (matches
      // the payslip PDF + the actual send) — NOT the full is_active roster.
      const bname = String(req.query.branch || '').replace(/\s+/g, ' ').trim();
      const groups = await buildManagerBranchGroups(doc);
      let g = null;
      for (const [, gg] of groups) { if (gg.name.replace(/\s+/g, ' ').trim() === bname) { g = gg; break; } }
      if (!g) return res.status(404).send('סניף לא נמצא');
      ids = [...new Set(g.employees.filter(e => e.employee_id).map(e => String(e.employee_id)))];
    } else {
      if (!req.query.employee_id) return res.status(404).send('עובד לא נמצא');
      ids = [String(req.query.employee_id)];
    }
    // Same rich format as the system's "ייצא PDF" hours report.
    const html = await buildRichHoursHtml(ids, month, req.user || { role: 'system_admin' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
}

// GET /payslip-audit/history/:id/branch-pdf?branch=.. — the full consolidated
// branch payslip PDF (what the branch manager receives), for preview.
async function branchPdfPreview(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const wanted = norm(req.query.branch);
    // Direct stored PDF (per-branch upload, or the combined "כל הסניפים" PDF).
    let bytes = await loadBranchPdf(doc._id, wanted);
    if (!bytes) {
      // No dedicated PDF — build the branch bundle from its employees' pages.
      const groups = await buildManagerBranchGroups(doc);
      let g = null;
      for (const [, gg] of groups) { if (norm(gg.name) === wanted) { g = gg; break; } }
      if (g) bytes = await mergeGroupPages(doc, g.employees, null);
    }
    if (!bytes) return res.status(404).json({ error: 'אין קובץ לסניף זה' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="branch.pdf"');
    res.send(bytes);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /payslip-audit/history/:id/manager-preview — per-branch review before the
// manager send. Groups payslips by each employee's REAL branch (so an all-in-one
// PDF still splits per branch), with the manager email + per-employee list.
async function managerDistributionPreview(req, res) {
  try {
    const doc = await PayslipAuditRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'ביקורת לא נמצאה' });
    const stored = await readBranchManagerEmails();
    const groups = await buildManagerBranchGroups(doc);
    const items = [];
    for (const [, g] of groups) {
      const email = (await managerBranchEmails(g, stored)).join(', ');
      const employees = g.employees.slice().sort((a, b) => a.name.localeCompare(b.name, 'he'));
      items.push({ branch: g.name, payslip_count: employees.length, email, has_pdf: g.hasPdfSource, employees, is_office: !!g.isOffice });
    }
    // Office master copy ("כל הסניפים") pinned first; real branches alphabetically.
    items.sort((a, b) => (b.is_office - a.is_office) || a.branch.localeCompare(b.branch, 'he'));
    res.json({ month: doc.year_month, items, distribution: doc.full_result?.distribution?.managers || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /employees/:id/saved-payslips — list an employee's archived payslips.
async function listSavedPayslips(req, res) {
  try {
    const list = await SavedPayslip.find({ employee_id: req.params.id })
      .select('year_month branch sent_to sent_at page').sort({ year_month: -1 }).lean();
    res.json({ payslips: list.map(p => ({
      year_month: p.year_month, branch: p.branch, sent_to: p.sent_to, sent_at: p.sent_at,
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /employees/:id/saved-payslips/:ym.pdf — download one archived payslip.
async function downloadSavedPayslip(req, res) {
  try {
    const p = await SavedPayslip.findOne({ employee_id: req.params.id, year_month: req.params.ym }).lean();
    if (!p || !p.data) return res.status(404).json({ error: 'תלוש לא נמצא' });
    const emp = await Employee.findById(req.params.id).select('full_name').lean();
    const bytes = p.data.buffer ? Buffer.from(p.data.buffer) : Buffer.from(p.data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${req.params.ym}.pdf"`);
    res.send(bytes);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// POST /employees/:id/saved-payslips/export { months: ['YYYY-MM', ...] } — merge
// the selected archived payslips into a single PDF (chronological).
async function exportSavedPayslips(req, res) {
  try {
    const months = Array.isArray(req.body?.months) ? req.body.months : [];
    const q = { employee_id: req.params.id };
    if (months.length) q.year_month = { $in: months };
    const list = await SavedPayslip.find(q).sort({ year_month: 1 }).lean();
    if (list.length === 0) return res.status(404).json({ error: 'אין תלושים שמורים לייצוא' });
    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.create();
    for (const p of list) {
      if (!p.data) continue;
      const bytes = p.data.buffer ? Buffer.from(p.data.buffer) : Buffer.from(p.data);
      try {
        const src = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(pg => merged.addPage(pg));
      } catch (e) { /* skip a corrupt page */ }
    }
    const outBytes = Buffer.from(await merged.save());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="payslips.pdf"');
    res.send(outBytes);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─── Monthly hours-report distribution (not audit-based) ────────────────────
// Group all active employees by real branch + an office master group. Each
// employee carries the email their report would go to.
async function buildHoursBranchGroups(month, user) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const allBranches = await Branch.find({}).select('_id name').lean();
  const byId = new Map(allBranches.map(b => [String(b._id), b]));
  const employees = await Employee.find({ is_active: true })
    .populate('user_id', 'email').select('full_name israeli_id email branch_id user_id salary_type')
    .sort({ full_name: 1 }).lean();
  const groups = new Map();
  groups.set(OFFICE_KEY, { name: OFFICE_NAME, br: null, isOffice: true, employees: [] });
  const office = groups.get(OFFICE_KEY);
  for (const e of employees) {
    const email = realEmployeeEmail(e) || '';
    const entry = { employee_id: String(e._id), name: e.full_name, israeli_id: e.israeli_id || '', email, matched: true, has_page: true };
    office.employees.push(entry);
    const br = byId.get(String(e.branch_id));
    if (br) {
      const key = norm(br.name);
      if (!groups.has(key)) groups.set(key, { name: br.name, br, employees: [] });
      groups.get(key).employees.push(entry);
    }
  }
  return groups;
}

// GET /payroll/hours-distribution/preview?month=YYYY-MM — branches (office first)
// with their employees + emails, for the send UI.
async function hoursDistributionPreview(req, res) {
  try {
    const month = String(req.query.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'חודש לא תקין' });
    const stored = await readBranchManagerEmails();
    const groups = await buildHoursBranchGroups(month, req.user);
    const items = [];
    for (const [, g] of groups) {
      const email = (await managerBranchEmails(g, stored)).join(', ');
      items.push({ branch: g.name, employees: g.employees, email, is_office: !!g.isOffice, has_pdf: true });
    }
    items.sort((a, b) => (b.is_office - a.is_office) || a.branch.localeCompare(b.branch, 'he'));
    const { HoursDistributionLog } = require('../models');
    const logs = await HoursDistributionLog.find({ month }).lean();
    const distribution = {};
    for (const l of logs) distribution[l.kind] = { at: l.at, running: l.running, results: l.results || [] };
    res.json({ month, items, distribution });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// GET /payroll/hours-distribution/preview-html?month=&scope=employee|branch&employee_id=|branch=
async function hoursDistributionPreviewHtml(req, res) {
  try {
    const { buildRichHoursHtml } = require('./payroll.controller');
    const month = String(req.query.month || '').trim();
    let ids = [];
    if (req.query.scope === 'employee') {
      if (!req.query.employee_id) return res.status(404).send('עובד לא נמצא');
      ids = [String(req.query.employee_id)];
    } else {
      const groups = await buildHoursBranchGroups(month, req.user);
      const bname = String(req.query.branch || '').replace(/\s+/g, ' ').trim();
      let g = null;
      for (const [, gg] of groups) { if (gg.name.replace(/\s+/g, ' ').trim() === bname) { g = gg; break; } }
      if (!g) return res.status(404).send('סניף לא נמצא');
      ids = g.employees.map(e => e.employee_id);
    }
    const html = await buildRichHoursHtml(ids, month, req.user || { role: 'system_admin' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
}

// POST /payroll/hours-distribution/send-employees { month, employee_ids, to? }
// Each employee gets their own rich hours report (or all to `to` if given).
async function sendHoursToEmployees(req, res) {
  try {
    const month = String(req.body?.month || '').trim();
    const ids = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids.map(String) : [];
    const toOverride = String(req.body?.to || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month) || ids.length === 0) return res.status(400).json({ error: 'חסר חודש או עובדים' });
    const userId = req.user?.id || null;
    res.json({ ok: true, queued: true, count: ids.length });
    runHoursJob(month, 'employees', userId, async () => {
      const { hoursReportEmailAttachments, renderHoursPdfPerEmployee } = require('./payroll.controller');
      const out = [];
      // Specific email → ONE bundle with all selected reports, to that address only.
      if (toOverride) {
        try {
          const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p><p>מצורפים דוחות שעות של ${ids.length} עובדים לחודש ${month}.</p><p>בברכה,<br>הנהלת גן החלומות</p></div>`;
          await dispatchEmail({ to: [toOverride], subject: `דוחות שעות — ${month}`, html: intro, ...(await hoursReportEmailAttachments(ids, month, { role: 'system_admin' }, `hours-reports-${month}`)) });
          out.push({ name: toOverride, email: toOverride, status: 'sent' });
        } catch (e) { out.push({ name: toOverride, status: 'error', error: e.message }); }
        return out;
      }
      // Pre-render every employee's report in ONE browser pass — a Chromium
      // launch per employee took minutes and crept the tier into OOM.
      let pdfByEmp = new Map();
      try { pdfByEmp = await renderHoursPdfPerEmployee(ids, month, { role: 'system_admin' }); }
      catch (e) { console.error('hours pre-render failed (per-employee fallback):', e.message); }
      let sinceLog = 0;
      for (const id of ids) {
        try {
          const emp = await Employee.findById(id).populate('user_id', 'email').lean();
          if (!emp) { out.push({ name: String(id), status: 'no_match' }); continue; }
          const email = realEmployeeEmail(emp);
          if (!email) { out.push({ name: emp.full_name, status: 'no_email' }); continue; }
          const fileAttachments = []; const attachments = [];
          const pre = pdfByEmp.get(String(emp._id));
          if (pre) fileAttachments.push({ filename: `hours-report-${month}.pdf`, contentBase64: pre.toString('base64'), contentType: 'application/pdf' });
          else {
            const att = await hoursReportEmailAttachments([emp._id], month, { role: 'system_admin' }, `hours-report-${month}`);
            if (att.fileAttachments) fileAttachments.push(...att.fileAttachments); else attachments.push(...att.attachments);
          }
          const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום ${emp.full_name},</p><p>מצורף דוח השעות שלך לחודש ${month}.</p><p>בברכה,<br>הנהלת גן החלומות</p></div>`;
          await dispatchEmail({ to: email, subject: `דוח שעות — ${month}`, html: intro, fileAttachments, attachments });
          out.push({ name: emp.full_name, email, status: 'sent' });
        } catch (e) { out.push({ name: String(id), status: 'error', error: e.message }); }
        if (++sinceLog >= 5) { sinceLog = 0; await saveHoursLog(month, 'employees', { at: new Date(), by: userId, running: true, results: out }); require('../services/htmlPdf').tryGc(); }
      }
      return out;
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// POST /payroll/hours-distribution/send-managers { month, branches?, branch_employees?, to? }
// Each branch manager (or the office) gets a consolidated rich hours report of
// the selected employees. `to` overrides all recipients with one address.
async function sendHoursToManagers(req, res) {
  try {
    const month = String(req.body?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'חודש לא תקין' });
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const groups = await buildHoursBranchGroups(month, req.user);
    let branchKeys = [...groups.keys()];
    if (Array.isArray(req.body?.branches) && req.body.branches.length) {
      const sel = new Set(req.body.branches.map(norm));
      branchKeys = branchKeys.filter(k => sel.has(norm(groups.get(k).name)));
    }
    const rawSel = (req.body?.branch_employees && typeof req.body.branch_employees === 'object') ? req.body.branch_employees : {};
    const branchSel = new Map();
    for (const [b, ids] of Object.entries(rawSel)) if (Array.isArray(ids)) branchSel.set(norm(b), new Set(ids.map(String)));
    const toOverride = String(req.body?.to || '').trim();
    const userId = req.user?.id || null;
    res.json({ ok: true, queued: true, count: branchKeys.length });
    runHoursJob(month, 'managers', userId, async () => {
      const { buildRichHoursHtml, hoursReportEmailAttachments, buildHoursChunkHtmls } = require('./payroll.controller');
      const { PDFDocument } = require('pdf-lib');
      const stored = await readBranchManagerEmails();
      const out = [];

      // Specific email → ONE consolidated hours report of ALL selected employees.
      if (toOverride) {
        try {
          const seen = new Set();
          for (const key of branchKeys) {
            const g = groups.get(key);
            const sel = branchSel.get(norm(g.name));
            g.employees.filter(e => e.employee_id && (!sel || sel.has(e.employee_id))).forEach(e => seen.add(e.employee_id));
          }
          if (!seen.size) { out.push({ branch: toOverride, status: 'no_selection' }); }
          else {
            const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p><p>מצורפים דוחות שעות של ${seen.size} עובדים לחודש ${month}.</p><p>בברכה,<br>הנהלת גן החלומות</p></div>`;
            await dispatchEmail({ to: [toOverride], subject: `דוחות שעות — ${month}`, html: intro, ...(await hoursReportEmailAttachments([...seen], month, { role: 'system_admin' }, `hours-reports-${month}`)) });
            out.push({ branch: toOverride, emails: [toOverride], status: 'sent' });
          }
        } catch (e) { out.push({ branch: toOverride, status: 'error', error: e.message }); }
        return out;
      }

      // ── Phase 1: resolve recipients + selections (office last — its PDF is
      // merged from the branch PDFs instead of re-rendering everyone). ──
      const orderedKeys = [...branchKeys].sort((a, b) => (groups.get(a)?.isOffice ? 1 : 0) - (groups.get(b)?.isOffice ? 1 : 0));
      const plan = [];
      for (const key of orderedKeys) {
        const g = groups.get(key);
        const label = g.br ? g.br.name : g.name;
        const emails = await managerBranchEmails(g, stored);
        if (emails.length === 0) { out.push({ branch: g.name, status: 'no_manager' }); continue; }
        const sel = branchSel.get(norm(g.name));
        const chosen = g.employees.filter(e => e.employee_id && (!sel || sel.has(e.employee_id)));
        if (chosen.length === 0) { out.push({ branch: g.name, status: 'no_selection' }); continue; }
        plan.push({ g, label, emails, chosen });
      }

      // ── Phase 2: render ALL hours PDFs in a SINGLE Chromium session — a
      // second browser launch on a grown heap is what OOM-killed the payslip
      // sends on the 512MB tier (same architecture as sendPayslipsToManagers).
      const hoursCache = new Map();
      const keyOf = ids => ids.map(String).sort().join(',');
      if (plan.length) {
        try {
          const nonOffice = plan.filter(p => !p.g.isOffice);
          const union = new Set(nonOffice.flatMap(p => p.chosen.map(e => String(e.employee_id))));
          const renderTargets = plan.filter(p => {
            if (!p.g.isOffice) return true;
            const ids = p.chosen.map(e => String(e.employee_id));
            return !(ids.length === union.size && ids.every(x => union.has(x)));
          });
          const metas = []; const chunkHtmls = [];
          for (const p of renderTargets) {
            const htmls = await buildHoursChunkHtmls(p.chosen.map(e => e.employee_id), month, { role: 'system_admin' });
            metas.push({ p, start: chunkHtmls.length, count: htmls.length });
            chunkHtmls.push(...htmls);
          }
          require('../services/htmlPdf').tryGc();
          const pdfs = chunkHtmls.length ? await require('../services/htmlPdf').htmlToPdfBatch(chunkHtmls) : [];
          for (const m of metas) {
            const slice = pdfs.slice(m.start, m.start + m.count).filter(Boolean);
            if (!slice.length) continue;
            let buf = slice[0];
            if (slice.length > 1) {
              const merged = await PDFDocument.create();
              for (const b of slice) {
                const src = await PDFDocument.load(b);
                (await merged.copyPages(src, src.getPageIndices())).forEach(pg => merged.addPage(pg));
              }
              buf = Buffer.from(await merged.save());
            }
            hoursCache.set(keyOf(m.p.chosen.map(e => e.employee_id)), buf);
          }
          // Office = union of the branches → merge their cached PDFs.
          for (const p of plan.filter(x => x.g.isOffice)) {
            const key = keyOf(p.chosen.map(e => e.employee_id));
            if (hoursCache.has(key) || hoursCache.size === 0) continue;
            const target = new Set(key.split(','));
            const have = new Set([...hoursCache.keys()].flatMap(k => k.split(',')));
            if (target.size === have.size && [...target].every(x => have.has(x))) {
              const merged = await PDFDocument.create();
              for (const buf of hoursCache.values()) {
                const src = await PDFDocument.load(buf);
                (await merged.copyPages(src, src.getPageIndices())).forEach(pg => merged.addPage(pg));
              }
              hoursCache.set(key, Buffer.from(await merged.save()));
            }
          }
        } catch (e) { console.error('hours batch render failed (HTML fallback in loop):', e.message); }
        require('../services/htmlPdf').tryGc();
      }

      // ── Phase 3: send loop — no Chromium from here on. ──
      for (const { g, label, emails, chosen } of plan) {
        try {
          const ids = chosen.map(e => e.employee_id);
          const fileAttachments = []; const attachments = [];
          const pdf = hoursCache.get(keyOf(ids));
          if (pdf) fileAttachments.push({ filename: `hours-report-${month}.pdf`, contentBase64: pdf.toString('base64'), contentType: 'application/pdf' });
          else attachments.push({ name: `hours-report-${month}`, html: await buildRichHoursHtml(ids, month, { role: 'system_admin' }) });
          const intro = `<div dir="rtl" style="font-family:Arial,sans-serif"><p>שלום,</p><p>מצורף דוח שעות מרוכז של ${g.isOffice ? 'כל הסניפים' : `סניף <b>${label}</b>`} לחודש ${month}.</p><p>בברכה,<br>הנהלת גן החלומות</p></div>`;
          await dispatchEmail({ to: emails, subject: `דוח שעות — ${label} — ${month}`, html: intro, fileAttachments, attachments });
          out.push({ branch: label, emails, status: 'sent' });
        } catch (e) {
          out.push({ branch: g.name, status: 'error', error: e.message });
        }
        await saveHoursLog(month, 'managers', { at: new Date(), by: userId, running: true, results: out });
        require('../services/htmlPdf').tryGc();
      }
      return out;
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

module.exports = {
  parseTable,
  parsePayslips,
  getBranchManagerEmails,
  setBranchManagerEmails,
  hoursDistributionPreview,
  hoursDistributionPreviewHtml,
  sendHoursToEmployees,
  sendHoursToManagers,
  distributionPreview,
  managerDistributionPreview,
  updateAuditMonth,
  hoursReportPreview,
  branchPdfPreview,
  listSavedPayslips,
  downloadSavedPayslip,
  exportSavedPayslips,
  updateEmployeeEmails,
  distributionPreview,
  managerDistributionPreview,
  updateAuditMonth,
  hoursReportPreview,
  branchPdfPreview,
  listSavedPayslips,
  downloadSavedPayslip,
  exportSavedPayslips,
  updateEmployeeEmails,
  sendPayslipsToEmployees,
  sendPayslipsToManagers,
  finalizeStaleDistributionLogs,
  runAudit,
  runAuditMulti,
  runAuditSystem,
  listBranches,
  emailAudit,
  previewAuditEmail,
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
  getPriorNotes,
  createFixRound,
  listFixRounds,
  setFixVerdict,
  approveFixRound,
  addAuditNote,
  getFixRoundPage,
  createFixToken,
  revokeFixToken,
  publicFixInfo,
  publicFixUpload,
};
