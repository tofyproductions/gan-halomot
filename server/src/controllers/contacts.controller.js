const { Child, Employee } = require('../models');

/**
 * Everything on this page is a name somebody typed. A child called
 * "יעל <3" is not hostile and is not hypothetical, and interpolated raw it
 * silently eats the rest of the row.
 */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

async function generatePDF(req, res, next) {
  try {
    const { classroom } = req.query;

    const filter = { is_active: true };
    if (classroom) {
      filter.classroom_id = classroom;
    }

    const children = await Child.find(filter)
      .populate('classroom_id', 'name')
      .sort({ child_name: 1 })
      .lean();

    if (children.length === 0) {
      return res.status(404).json({ error: 'No children found for contact list' });
    }

    // Grouped by classroom ID rather than by its name: the staff have to be
    // looked up per room, and two rooms in different branches share a name
    // often enough ("בוגרים") that grouping on the name merges them.
    const grouped = {};
    for (const child of children) {
      const roomId = child.classroom_id?._id ? String(child.classroom_id._id) : 'none';
      const groupName = child.classroom_id?.name || 'ללא קבוצה';
      if (!grouped[roomId]) grouped[roomId] = { name: groupName, kids: [] };
      // Ensure phone starts with 0
      let phone = child.phone || '';
      if (phone && !phone.startsWith('0') && /^\d/.test(phone)) phone = '0' + phone;

      grouped[roomId].kids.push({
        child_name: child.child_name,
        parent_name: child.parent_name,
        phone,
        email: child.email,
        medical_alerts: child.medical_alerts,
      });
    }

    // Who is responsible for each room. The primary comes first and is what
    // somebody reading this page at the door needs; the additional staff are
    // listed after and marked, so "who do I ask about this child" has one
    // answer rather than three.
    const roomIds = Object.keys(grouped).filter((k) => k !== 'none');
    const staffByRoom = {};
    if (roomIds.length) {
      const staff = await Employee.find({
        is_active: true,
        $or: [
          { primary_classroom_id: { $in: roomIds } },
          { extra_classroom_ids: { $in: roomIds } },
        ],
      }).select('full_name position phone primary_classroom_id extra_classroom_ids').lean();

      for (const person of staff) {
        const primary = person.primary_classroom_id ? String(person.primary_classroom_id) : null;
        if (primary && grouped[primary]) {
          (staffByRoom[primary] ||= []).push({ ...person, primary: true });
        }
        for (const extra of person.extra_classroom_ids || []) {
          const id = String(extra);
          if (id !== primary && grouped[id]) (staffByRoom[id] ||= []).push({ ...person, primary: false });
        }
      }
      for (const list of Object.values(staffByRoom)) {
        list.sort((a, b) => (b.primary - a.primary) || a.full_name.localeCompare(b.full_name, 'he'));
      }
    }


    const today = new Date().toLocaleDateString('he-IL');
    let html = `
      <!DOCTYPE html>
      <html dir="rtl" lang="he">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Assistant', 'Heebo', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px; color: #0f172a; }
          h1 { text-align: center; color: #1e3a8a; font-size: 1.8rem; margin-bottom: 5px; }
          .date { text-align: center; color: #64748b; margin-bottom: 30px; }
          h2 { color: #1e3a8a; border-bottom: 2px solid #3b82f6; padding-bottom: 5px; margin-top: 30px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th { background: #1e3a8a; color: white; padding: 10px 8px; text-align: right; font-size: 0.9rem; }
          td { padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; }
          tr:nth-child(even) { background: #f8fafc; }
          .count { color: #64748b; font-size: 0.85rem; }
          .team { margin: 2px 0 8px; color: #334155; font-size: 0.85rem; }
          .team.empty { color: #b45309; }
          @page { size: A4; margin: 12mm; }
          @media print {
            body { padding: 0; max-width: none; }
            /* One classroom per sheet: the page on the wall is one room's
               page, and two rooms sharing a sheet means scissors. */
            .room { break-after: page; page-break-after: always; }
            .room:last-of-type { break-after: auto; page-break-after: auto; }
            /* A room too big for one sheet continues cleanly: whole rows,
               header repeated. */
            thead { display: table-header-group; }
            tr { break-inside: avoid; page-break-inside: avoid; }
            .room h2 { margin-top: 0; }
          }
        </style>
      </head>
      <body>
        <h1>רשימת אנשי קשר - גן החלומות</h1>
        <p class="date">תאריך הפקה: ${today}</p>
    `;

    // Alphabetical by room name — until now the order was whichever room's
    // child happened to sort first, which read as random on paper.
    const orderedRooms = Object.entries(grouped)
      .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'he'));

    for (const [roomId, group] of orderedRooms) {
      const { name: classroomName, kids } = group;
      const team = staffByRoom[roomId] || [];
      html += `
        <section class="room">
        <h2>${esc(classroomName)} <span class="count">(${kids.length} ילדים)</span></h2>
        ${team.length ? `<p class="team">${team.map(t =>
          `${esc(t.full_name)}${t.position ? ` (${esc(t.position)})` : ''}${t.primary ? '' : ' — נוספת'}${t.phone ? ` · ${esc(t.phone)}` : ''}`
        ).join(' | ')}</p>` : '<p class="team empty">לא שויכו אנשי צוות לכיתה זו</p>'}
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>שם הילד/ה</th>
              <th>שם ההורה</th>
              <th>טלפון</th>
              <th>אימייל</th>
            </tr>
          </thead>
          <tbody>
      `;

      kids.forEach((kid, idx) => {
        html += `
          <tr>
            <td>${idx + 1}</td>
            <td>${esc(kid.child_name)}</td>
            <td>${esc(kid.parent_name)}</td>
            <td>${esc(kid.phone) || '-'}</td>
            <td>${esc(kid.email) || '-'}</td>
          </tr>
        `;
      });

      html += `</tbody></table></section>`;
    }

    html += `</body></html>`;

    res.set({ 'Content-Type': 'text/html; charset=utf-8' });
    res.send(html);
  } catch (error) {
    next(error);
  }
}

module.exports = { generatePDF, generatePdf: generatePDF };
