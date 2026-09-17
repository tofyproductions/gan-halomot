/**
 * "מי פג לה התוקף ומי חסרה" as a document somebody can carry.
 *
 * The screen answers this already, but the answer lives behind a login on a
 * wide table, and the person who has to act on it is standing in a branch with
 * a phone, or sitting opposite an inspector. So the same question becomes a
 * page per course type: every employee who needs one and does not have a valid
 * one, with the number to call her on and a link to whatever certificate she
 * last had.
 *
 * A page per type because the ask is usually narrower than the whole list —
 * עזרה ראשונה came due, so only that page is wanted — and because a page break
 * between types is what makes printing one of them possible at all.
 *
 * Pure: HTML in, no database, no network. The controller gathers the rows and
 * this decides what the document says, which is the part worth testing.
 */

const STATUS_LABEL = {
  expired: 'פג תוקף',
  missing: 'אין תעודה',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** DD.MM.YYYY, or a dash. The report is read in Hebrew, not in ISO. */
function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(x.getDate())}.${p(x.getMonth() + 1)}.${x.getFullYear()}`;
}

/** 0501234567 → 050-1234567. A number on paper is a number to dial. */
function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return raw || '—';
}

/**
 * Where the last certificate can be opened, and what to call that place.
 *
 * Three cases, and they are genuinely different to the reader:
 *  - a link the gan already had (the whole back-catalogue is in Drive) opens
 *    from the page itself;
 *  - a file uploaded into the system opens only after a login, so the link
 *    goes to the screen rather than pretending to be the file;
 *  - nothing at all, which is most of the "אין תעודה" rows and must not look
 *    like a broken link.
 */
function certificateLink(course, appUrl) {
  if (!course) return { text: '—', href: '' };
  if (course.external_url) return { text: 'פתיחת התעודה', href: course.external_url };
  if (course.has_file) {
    return { text: 'שמורה במערכת', href: appUrl ? `${appUrl.replace(/\/$/, '')}/courses` : '' };
  }
  return { text: '—', href: '' };
}

/**
 * One row per employee per course type she is short of.
 *
 * `rows` arrive already scoped and already filtered to what is missing or
 * expired — deciding who is in scope is the controller's job, because it is a
 * permission question.
 */
function buildHtml({ sections, title, subtitle, generatedAt, appUrl }) {
  const head = `
    <meta charset="utf-8" />
    <style>
      @page { size: A4 landscape; margin: 10mm; }
      * { box-sizing: border-box; }
      body {
        font-family: "Heebo", "Arial", sans-serif; direction: rtl; margin: 0;
        color: #1f2937; font-size: 11pt;
      }
      .type { page-break-after: always; }
      .type:last-child { page-break-after: auto; }
      h1 { font-size: 16pt; margin: 0 0 2mm; }
      h2 { font-size: 13pt; margin: 0 0 1mm; color: #92400e; }
      .meta { font-size: 9pt; color: #6b7280; margin-bottom: 4mm; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #d1d5db; padding: 2mm 2.5mm; text-align: right; }
      th { background: #f3f4f6; font-weight: 700; font-size: 10pt; }
      td { font-size: 10pt; }
      /* Latin digits inside a right-to-left line reorder unless the cell is
         told which way it runs. A ת"ז printed backwards is worse than absent. */
      .ltr { direction: ltr; text-align: right; unicode-bidi: embed; }
      .expired { color: #b91c1c; font-weight: 700; }
      .missing { color: #6b7280; }
      a { color: #1d4ed8; }
      .none { color: #6b7280; font-style: italic; padding: 3mm 0; }
    </style>`;

  const body = sections.map(sec => `
    <div class="type">
      <h1>${esc(title)}</h1>
      <div class="meta">${esc(subtitle)} · הופק ${esc(generatedAt)}</div>
      <h2>${esc(sec.label)} — ${sec.rows.length} עובדות</h2>
      ${sec.rows.length === 0 ? '<div class="none">אין חוסרים בקורס זה.</div>' : `
      <table>
        <thead>
          <tr>
            <th style="width:22%">שם העובדת</th>
            <th style="width:12%">ת"ז</th>
            <th style="width:13%">טלפון</th>
            <th style="width:17%">סניף</th>
            <th style="width:12%">מצב</th>
            <th style="width:12%">בתוקף עד</th>
            <th style="width:12%">התעודה האחרונה</th>
          </tr>
        </thead>
        <tbody>
          ${sec.rows.map(r => {
            const link = certificateLink(r.course, appUrl);
            return `
          <tr>
            <td>${esc(r.full_name)}</td>
            <td class="ltr">${esc(r.israeli_id || '—')}</td>
            <td class="ltr">${esc(fmtPhone(r.phone))}</td>
            <td>${esc(r.branch_name || '—')}</td>
            <td class="${r.status === 'expired' ? 'expired' : 'missing'}">${esc(STATUS_LABEL[r.status] || r.status)}</td>
            <td class="ltr">${esc(fmtDate(r.course?.expires_at))}</td>
            <td>${link.href ? `<a href="${esc(link.href)}">${esc(link.text)}</a>` : esc(link.text)}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>`}
    </div>`).join('');

  return `<!doctype html><html lang="he" dir="rtl"><head>${head}</head><body>${body}</body></html>`;
}

module.exports = { buildHtml, certificateLink, fmtDate, fmtPhone, STATUS_LABEL };
