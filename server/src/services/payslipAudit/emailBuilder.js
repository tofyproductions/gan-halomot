/**
 * Build the audit email body sent to the accountant.
 *
 * Groups findings by employee, lists critical first, then warnings, then info.
 * Returns both an HTML and a plain-text version (the latter as a fallback for
 * mail clients that strip HTML).
 */

const SEVERITY_LABEL = {
  critical: 'קריטי',
  warning: 'אזהרה',
  info: 'מידע',
  ok: 'תקין',
};

const SEVERITY_COLOR = {
  critical: '#d32f2f',
  warning: '#ed6c02',
  info: '#0288d1',
  ok: '#2e7d32',
};

const SEVERITY_BG = {
  critical: '#fdecea',
  warning: '#fff4e5',
  info: '#e5f6fd',
  ok: '#e8f5e9',
};

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/** Sort findings: critical → warning → info → ok */
function sortBySeverity(findings) {
  const order = { critical: 0, warning: 1, info: 2, ok: 3 };
  return [...findings].sort((a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99));
}

/** Label an employee the way the accountant looks them up: name · branch · מס׳ עובד. */
function employeeLabel(e) {
  const bits = [];
  if (e.branch) bits.push(e.branch);
  if (e.employee_no !== null && e.employee_no !== undefined && e.employee_no !== '') bits.push(`מס׳ עובד ${e.employee_no}`);
  if (e.employee_id) bits.push(`ת"ז ${e.employee_id}`);
  return { name: e.name || '—', meta: bits.join(' · ') };
}

/**
 * The "already checked — don't touch" block.
 *
 * The whole point of the email is to tell the accountant where NOT to spend
 * time. Sending only the problems left him re-checking all 27 payslips to see
 * whether a name's absence meant "fine" or "we forgot it". So the payslips the
 * manager ticked ✓ טופל are listed explicitly, and only the ones needing work
 * are attached as a PDF.
 */
function buildApprovedBlockHtml(approved) {
  if (!approved || approved.length === 0) return '';
  const cells = approved.map((e) => {
    const { name, meta } = employeeLabel(e);
    return `
      <td style="padding:4px 10px; border:1px solid #c8e6c9; background:#f1f8f4; border-radius:4px;">
        <span style="color:#1b5e20; font-size:12.5px; font-weight:700;">${escapeHtml(name)}</span>
        ${meta ? `<span style="color:#5b7a63; font-size:10.5px;"> · ${escapeHtml(meta)}</span>` : ''}
      </td>`;
  });
  // 2 per row — long employee names blow up a 3-column layout in Outlook.
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${cells.slice(i, i + 2).join('')}${cells.length % 2 && i + 2 > cells.length ? '<td></td>' : ''}</tr>`);
  }
  return `
    <div style="margin:18px 0 4px; padding:10px 12px; border:2px solid #2e7d32; border-radius:8px; background:#f7fcf8;">
      <p style="margin:0 0 6px; color:#1b5e20; font-size:14px; font-weight:800;">
        ✓ ${approved.length} תלושים נבדקו ואושרו — אין צורך לעבור עליהם
      </p>
      <p style="margin:0 0 8px; color:#446b4e; font-size:12px;">
        עברנו על התלושים האלה במלואם ולא נדרש בהם שינוי. הם אינם מצורפים לקובץ.
      </p>
      <table cellpadding="0" cellspacing="4" border="0" width="100%" style="border-collapse:separate;">${rows.join('')}</table>
    </div>`;
}

/** Build the HTML body of the audit email. */
function buildAuditEmailHtml(audit, options = {}) {
  const ym = audit.year_month || '';
  const branch = audit.branch_filter || 'כל הסניפים';
  const sheet = audit.table_sheet_name || '';

  // Bucket results: only those with critical or warning findings end up in the
  // "issues" section. Info-only and OK are appended as a quiet footer.
  const withIssues = audit.results.filter((r) =>
    r.findings.some((f) => f.severity === 'critical' || f.severity === 'warning')
  );

  const approved = options.approvedPayslips || [];
  const approvedCount = approved.length;
  const attachmentName = options.attachmentName || '';
  const fixUrl = options.fixUrl || '';

  let totalCritical = 0;
  let totalWarning = 0;
  for (const r of audit.results) {
    for (const f of r.findings) {
      if (f.severity === 'critical') totalCritical++;
      else if (f.severity === 'warning') totalWarning++;
    }
  }

  const headerStats = `
    <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; margin:8px 0 16px;">
      <tr>
        <td style="background:#f5f5f5; padding:6px 12px; border-radius:6px; margin-left:6px;">
          <span style="color:#666; font-size:12px;">חודש</span>
          <strong style="color:#222; font-size:14px; margin-right:6px;">${escapeHtml(ym)}</strong>
        </td>
        <td style="background:#f5f5f5; padding:6px 12px; border-radius:6px; margin-right:6px;">
          <span style="color:#666; font-size:12px;">סניף</span>
          <strong style="color:#222; font-size:14px; margin-right:6px;">${escapeHtml(branch)}</strong>
        </td>
        ${sheet ? `<td style="background:#f5f5f5; padding:6px 12px; border-radius:6px; margin-right:6px;">
          <span style="color:#666; font-size:12px;">גליון</span>
          <strong style="color:#222; font-size:14px; margin-right:6px;">${escapeHtml(sheet)}</strong>
        </td>` : ''}
      </tr>
    </table>
    <table cellpadding="0" cellspacing="6" border="0" style="margin:0 0 16px;">
      <tr>
        <td style="background:${SEVERITY_BG.critical}; color:${SEVERITY_COLOR.critical}; padding:6px 14px; border-radius:6px; font-weight:700;">
          ${totalCritical} קריטי
        </td>
        <td style="background:${SEVERITY_BG.warning}; color:${SEVERITY_COLOR.warning}; padding:6px 14px; border-radius:6px; font-weight:700;">
          ${totalWarning} אזהרה
        </td>
        <td style="background:#f5f5f5; color:#444; padding:6px 14px; border-radius:6px;">
          ${audit.payslips_in_pdf} תלושים נבדקו מתוך ${audit.rows_in_table} שורות בטבלה
        </td>
        ${approvedCount ? `<td style="background:${SEVERITY_BG.ok}; color:${SEVERITY_COLOR.ok}; padding:6px 14px; border-radius:6px; font-weight:700;">
          ✓ ${approvedCount} אושרו
        </td>` : ''}
      </tr>
    </table>
  `;

  // Per-employee blocks
  const blocks = withIssues.map((r) => {
    const name = (r.table_row && r.table_row.employee_name)
      || (r.payslip && r.payslip.employee_name) || '—';
    const empNo = r.payslip && r.payslip.employee_no != null ? ` · מס׳ עובד ${r.payslip.employee_no}` : '';
    const id = r.payslip && r.payslip.employee_id ? ` · ת"ז ${r.payslip.employee_id}` : '';
    const branchLabel = r.table_row && r.table_row.branch ? ` · ${r.table_row.branch}` : '';
    const findings = sortBySeverity(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'));
    const rows = findings.map((f) => `
      <tr>
        <td style="padding:6px 10px; border-bottom:1px solid #eee; vertical-align:top; width:80px;">
          <span style="background:${SEVERITY_BG[f.severity]}; color:${SEVERITY_COLOR[f.severity]}; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">
            ${SEVERITY_LABEL[f.severity]}
          </span>
        </td>
        <td style="padding:6px 10px; border-bottom:1px solid #eee; color:#222; font-size:13px;">
          ${escapeHtml(f.message)}
          ${(f.expected !== null || f.actual !== null) ? `
            <div style="color:#777; font-size:11px; margin-top:2px;">
              צפוי: <strong>${escapeHtml(fmtVal(f.expected))}</strong>
              · בפועל: <strong>${escapeHtml(fmtVal(f.actual))}</strong>
            </div>` : ''}
        </td>
      </tr>
    `).join('');
    return `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px; border:1px solid #ddd; border-radius:8px; overflow:hidden;">
        <tr>
          <td style="background:#fafafa; padding:8px 12px; border-bottom:1px solid #ddd;">
            <strong style="color:#222; font-size:14px;">${escapeHtml(name)}</strong>
            <span style="color:#888; font-size:12px;">${escapeHtml(branchLabel)}${escapeHtml(empNo)}${escapeHtml(id)}</span>
          </td>
        </tr>
        <tr><td style="padding:0;"><table cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr>
      </table>
    `;
  }).join('');

  const intro = options.introText || `שלום אפרים,

מצורפים תיקונים נדרשים בתלושי השכר לחודש ${ym} (${branch}).
נא לבצע את התיקונים ולשלוח לאישור.

תודה,
משרד גן החלומות`;

  // Footer: missing payslips + orphans
  const missing = audit.missing_payslips || [];
  const orphans = audit.orphan_payslips || [];
  const footerExtras = [];
  if (missing.length) {
    footerExtras.push(`
      <p style="margin:16px 0 4px; font-size:13px;">
        <strong style="color:${SEVERITY_COLOR.critical};">תלושים חסרים (${missing.length}):</strong>
        ${missing.map((r) => escapeHtml(r.employee_name)).join(', ')}
      </p>
    `);
  }
  if (orphans.length) {
    footerExtras.push(`
      <p style="margin:8px 0 4px; font-size:13px;">
        <strong style="color:${SEVERITY_COLOR.warning};">תלושים שלא תאמו לטבלה (${orphans.length}):</strong>
        ${orphans.map((p) => escapeHtml(p.employee_name)).join(', ')}
      </p>
    `);
  }

  // Say up front what the attachment is, so the accountant knows the PDF holds
  // ONLY the payslips needing work — not the whole month's bundle again.
  const attachmentNote = attachmentName ? `
    <p style="margin:0 0 14px; padding:8px 12px; border-right:4px solid #1976d2; background:#f3f8fd; font-size:13px; color:#0d47a1;">
      📎 מצורף <b>${escapeHtml(attachmentName)}</b> — ${withIssues.length} התלושים שדורשים תיקון בלבד.
      ${approvedCount ? `שאר ${approvedCount} התלושים אושרו על ידינו ומופיעים ברשימה למטה.` : ''}
    </p>` : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>תיקוני תלושים — ${escapeHtml(ym)}</title></head>
<body style="font-family:Arial, 'Segoe UI', sans-serif; background:#fff; color:#222; padding:16px; max-width:760px; margin:auto;">
  <h2 style="margin:0 0 4px;">תיקוני תלושי שכר — ${escapeHtml(ym)}</h2>
  <p style="color:#666; margin:0 0 12px; white-space:pre-line;">${escapeHtml(intro)}</p>
  ${headerStats}
  ${attachmentNote}
  ${blocks || '<p style="color:#2e7d32; font-weight:700;">✓ לא נמצאו אי-התאמות הדורשות תיקון.</p>'}
  ${buildApprovedBlockHtml(approved)}
  ${footerExtras.join('')}
  ${fixUrl ? `
  <div style="margin:20px 0 4px; padding:14px; border:2px solid #1976d2; border-radius:8px; background:#f3f8fd; text-align:center;">
    <p style="margin:0 0 10px; font-size:14px; font-weight:800; color:#0d47a1;">אחרי התיקונים — העלה את התלושים המתוקנים כאן</p>
    <p style="margin:0 0 12px; font-size:12px; color:#33618f;">
      נבדוק כל הערה מול התלוש החדש ונחזור אליך רק אם משהו נשאר פתוח. אין צורך בחשבון.
    </p>
    <a href="${escapeHtml(fixUrl)}" style="display:inline-block; background:#1976d2; color:#fff; text-decoration:none; padding:10px 26px; border-radius:6px; font-weight:800; font-size:14px;">העלאת תלושים מתוקנים</a>
    <p style="margin:10px 0 0; font-size:10.5px; color:#7b93ad; direction:ltr;">${escapeHtml(fixUrl)}</p>
  </div>` : ''}
  <p style="color:#999; font-size:11px; margin-top:24px; border-top:1px solid #eee; padding-top:8px;">
    דו"ח זה נוצר אוטומטית ממערכת גן החלומות.
  </p>
</body>
</html>`;
}

/** Plain-text fallback for clients that strip HTML. */
function buildAuditEmailText(audit, options = {}) {
  const ym = audit.year_month || '';
  const branch = audit.branch_filter || 'כל הסניפים';
  const lines = [];
  lines.push(options.introText || `שלום אפרים,\n\nמצורפים תיקונים נדרשים בתלושי השכר לחודש ${ym} (${branch}).`);
  lines.push('');

  let totalCritical = 0;
  let totalWarning = 0;
  for (const r of audit.results) {
    for (const f of r.findings) {
      if (f.severity === 'critical') totalCritical++;
      else if (f.severity === 'warning') totalWarning++;
    }
  }
  lines.push(`סיכום: ${totalCritical} קריטיים, ${totalWarning} אזהרות. ${audit.payslips_in_pdf} תלושים מתוך ${audit.rows_in_table} שורות.`);
  if (options.attachmentName) {
    lines.push(`מצורף ${options.attachmentName} — התלושים שדורשים תיקון בלבד.`);
  }
  lines.push('');

  const withIssues = audit.results.filter((r) =>
    r.findings.some((f) => f.severity === 'critical' || f.severity === 'warning')
  );
  for (const r of withIssues) {
    const name = (r.table_row && r.table_row.employee_name)
      || (r.payslip && r.payslip.employee_name) || '—';
    const empNo = r.payslip && r.payslip.employee_no != null ? ` (מס׳ עובד ${r.payslip.employee_no})` : '';
    const id = r.payslip && r.payslip.employee_id ? ` (ת"ז ${r.payslip.employee_id})` : '';
    lines.push(`▸ ${name}${empNo}${id}`);
    const findings = sortBySeverity(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'));
    for (const f of findings) {
      lines.push(`  [${SEVERITY_LABEL[f.severity]}] ${f.message}`);
    }
    lines.push('');
  }

  const missing = audit.missing_payslips || [];
  if (missing.length) {
    lines.push(`תלושים חסרים: ${missing.map((r) => r.employee_name).join(', ')}`);
  }
  const orphans = audit.orphan_payslips || [];
  if (orphans.length) {
    lines.push(`תלושים שלא תאמו לטבלה: ${orphans.map((p) => p.employee_name).join(', ')}`);
  }

  const approved = options.approvedPayslips || [];
  if (approved.length) {
    lines.push('');
    lines.push(`✓ ${approved.length} תלושים נבדקו ואושרו — אין צורך לעבור עליהם:`);
    for (const e of approved) {
      const { name, meta } = employeeLabel(e);
      lines.push(`  - ${name}${meta ? ` (${meta})` : ''}`);
    }
  }

  if (options.fixUrl) {
    lines.push('');
    lines.push('להעלאת התלושים המתוקנים (ללא צורך בחשבון):');
    lines.push(options.fixUrl);
  }

  lines.push('');
  lines.push('— מערכת גן החלומות');
  return lines.join('\n');
}

module.exports = { buildAuditEmailHtml, buildAuditEmailText };
