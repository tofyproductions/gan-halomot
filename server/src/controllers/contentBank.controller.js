/**
 * בנק תוכן — read the bank, add to it, hide what does not suit this gan.
 *
 * Read is open to any logged-in member of staff: the gananet writing the plan
 * is the person who needs it, and she is not a manager. Writing to the bank is
 * open to the same people on purpose — an idea that worked is worth keeping
 * the day it worked, not the day a manager gets round to approving it. What
 * she cannot do is touch the shipped bank; hiding a shipped item writes a row
 * in HER gan's database and leaves everyone else's alone.
 */
const { ContentBankItem } = require('../models');
const bank = require('../services/contentBank.service');

/** GET /api/content-bank/themes */
async function themes(req, res, next) {
  try {
    res.json({ themes: await bank.themes() });
  } catch (error) { next(error); }
}

/** GET /api/content-bank?theme=פסח&q=&age=בוגרים */
async function browse(req, res, next) {
  try {
    const result = await bank.browse({
      theme: req.query.theme || '',
      q: req.query.q || '',
      ageGroup: req.query.age || '',
    });
    res.json(result);
  } catch (error) { next(error); }
}

/**
 * POST /api/content-bank/suggest   { theme, age?, days?, offset?, rows? }
 * Proposes a week. Saves nothing — the editor holds it until the gananet saves
 * the gantt, which is also what lets her change a box before committing.
 */
async function suggest(req, res, next) {
  try {
    const { theme, age, days, offset, rows } = req.body || {};
    if (!theme) return res.status(400).json({ error: 'יש לבחור נושא' });

    res.json(await bank.suggestWeek({
      theme,
      ageGroup: age || '',
      days: Math.min(Math.max(Number(days) || 5, 1), 5),
      offset: Math.max(Number(offset) || 0, 0),
      rows: Array.isArray(rows) ? rows : null,
    }));
  } catch (error) { next(error); }
}

/** POST /api/content-bank   { theme, category, title, materials?, age_groups?, notes? } */
async function create(req, res, next) {
  try {
    const { theme, category, title, materials, age_groups: ageGroups, notes } = req.body || {};
    if (!theme || !category || !title) {
      return res.status(400).json({ error: 'נושא, שורה וכותרת הם שדות חובה' });
    }
    if (!bank.CATEGORY_ORDER.includes(category)) {
      return res.status(400).json({ error: 'שורה לא מוכרת' });
    }

    const item = await ContentBankItem.create({
      theme: String(theme).trim(),
      category,
      title: String(title).trim(),
      notes: notes || '',
      materials: Array.isArray(materials) ? materials.map(m => String(m).trim()).filter(Boolean) : [],
      age_groups: Array.isArray(ageGroups) ? ageGroups : [],
      created_by: req.user?.id || null,
    });

    res.status(201).json({ item: { ...item.toObject(), id: item._id, origin: 'own' } });
  } catch (error) { next(error); }
}

/**
 * DELETE /api/content-bank/:id
 *
 * The gan's own item is deleted. A shipped item cannot be — it is not in any
 * database to delete — so it is hidden instead, which is a row saying "not for
 * us" and is reversible. Both answer the same button on the screen.
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;

    if (id.startsWith('s')) {
      const known = bank.SEED_THEMES.length > 0;
      if (!known) return res.status(404).json({ error: 'הפריט לא נמצא' });
      await ContentBankItem.findOneAndUpdate(
        { hides_seed_id: id },
        {
          $set: {
            hides_seed_id: id,
            theme: req.query.theme || 'הוסתר',
            category: req.query.category && bank.CATEGORY_ORDER.includes(req.query.category)
              ? req.query.category : 'misc',
            title: req.query.title || id,
            created_by: req.user?.id || null,
          },
        },
        { upsert: true },
      );
      return res.json({ message: 'הפריט הוסתר מהבנק של הגן' });
    }

    const deleted = await ContentBankItem.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'הפריט לא נמצא' });
    res.json({ message: 'הפריט נמחק' });
  } catch (error) { next(error); }
}

/** POST /api/content-bank/:id/restore — un-hide a shipped item. */
async function restore(req, res, next) {
  try {
    await ContentBankItem.deleteOne({ hides_seed_id: req.params.id });
    res.json({ message: 'הפריט הוחזר' });
  } catch (error) { next(error); }
}

module.exports = { themes, browse, suggest, create, remove, restore };
