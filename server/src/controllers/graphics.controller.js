const { birthdays, childForCard } = require('../services/graphics.service');
const { buildBirthdayCardHtml, CARD_W } = require('../services/posterTemplates');
const { htmlToPng } = require('../services/htmlPdf');
const { canAccessBranch } = require('../utils/branch-scope');

/**
 * הגרפיקות שלנו — printables produced from the gan's own records.
 *
 * Read-only in the sense that matters: nothing here writes. The cards are
 * rendered on demand and not stored, because a stored card is a card that has
 * to be regenerated the day somebody fixes a spelling — and the render is a
 * second.
 *
 * `branch` narrows, it never widens: which branches the caller may see is
 * decided from their own scope, exactly as in parentSignups.controller.
 */

/** The caller's branches, after an explicit `?branch=` has been honoured. */
async function scopeFor(req) {
  const asked = req.query.branch && req.query.branch !== 'all' ? String(req.query.branch) : null;
  if (asked) {
    if (!(await canAccessBranch(req, asked))) return { error: 'אין לך הרשאה לסניף זה' };
    return { branchIds: [asked] };
  }
  const scope = req.branchScope; // null = every branch
  return { branchIds: Array.isArray(scope) ? scope.map(String) : null };
}

async function birthdayList(req, res, next) {
  try {
    const { branchIds, error } = await scopeFor(req);
    if (error) return res.status(403).json({ error });

    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();
    if (month < 1 || month > 12) return res.status(400).json({ error: 'חודש לא תקין' });

    const data = await birthdays({
      branchIds, month, year, classroom: req.query.classroom || '',
    });
    res.json(data);
  } catch (error) { next(error); }
}

/**
 * Hebrew cannot go in a bare `filename=`, so the ASCII fallback carries the
 * date and the real name rides in `filename*`. Browsers that understand the
 * second use it; the ones that do not still save a file that opens.
 */
function contentDisposition(hebrew) {
  const ascii = 'birthday-card.jpg';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(hebrew)}`;
}

/**
 * The card itself.
 *
 * `?child=<id>` prints that child's name; no `child` prints a blank line to
 * fill in by hand — the gan wanted both, because a card for a child who
 * started last week is wanted before the office has typed them in.
 *
 * `?name=first|full` because both are right in different rooms: a תינוקיה
 * card says "נועם", and a card for a room with two of them says which.
 */
async function birthdayCard(req, res) {
  try {
    const wantFull = req.query.name === 'full';
    let name = '';
    let gender = req.query.gender === 'girl' || req.query.gender === 'boy' ? req.query.gender : '';

    if (req.query.child) {
      const { branchIds, error } = await scopeFor(req);
      if (error) return res.status(403).json({ error });

      const child = await childForCard({ branchIds, childId: String(req.query.child) });
      // Out of scope and non-existent are the same answer on purpose: a
      // manager probing ids must not learn which ones are real.
      if (!child) return res.status(404).json({ error: 'הילד/ה לא נמצא' });

      name = wantFull ? child.full_name : child.first_name;
      gender = child.gender || gender;
    }

    const html = buildBirthdayCardHtml({ name, gender });
    const jpeg = await htmlToPng(html, { width: CARD_W, format: 'jpeg' });

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', contentDisposition(
      name ? `יום הולדת - ${name}.jpg` : 'יום הולדת.jpg',
    ));
    res.send(jpeg);
  } catch (error) {
    console.error('[graphics] birthday card render failed:', error.message);
    res.status(503).json({ error: error.message || 'הפקת הכרטיס נכשלה — נסו שוב בעוד רגע' });
  }
}

module.exports = { birthdayList, birthdayCard };
