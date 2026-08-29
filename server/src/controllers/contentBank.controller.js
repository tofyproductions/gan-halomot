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
const { isBankable, isPersonal, isFixedWeeklySlot } = require('../content-bank/privacy');

/**
 * Why this text may not be banked, in words the gananet can act on.
 *
 * The same three rules the extractor applies to the workbooks, applied here to
 * what she types — because the bank has two doors into it and only one of them
 * was ever guarded.
 */
function whyNotBankable(title) {
  const t = String(title || '').trim();
  if (isFixedWeeklySlot(t)) {
    return 'קבלת שבת נרשמת אוטומטית ביום שישי ואינה נשמרת בבנק';
  }
  if (isPersonal(t)) {
    return 'לא ניתן לשמור בבנק טקסט שמכיל שם של ילד/ה';
  }
  if (!isBankable(t)) {
    return 'הטקסט קצר או כללי מדי לשמירה בבנק';
  }
  return null;
}

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
    const refusal = whyNotBankable(title);
    if (refusal) return res.status(400).json({ error: refusal });

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

    if (bank.isSeedId(id)) {
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

/**
 * PUT /api/content-bank/:id   { theme?, category?, title?, materials?, notes? }
 *
 * Editing the gan's own item is an update. Editing a SHIPPED item cannot be —
 * it is the same object every other customer reads — so it becomes two rows in
 * this gan's database: the shipped one hidden, and the edited text stored as
 * theirs. To the gananet both are "I fixed it", which is the only thing she
 * should have to think about; the isolation is ours to keep, not hers.
 */
async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { theme, category, title, materials, notes, age_groups: ageGroups } = req.body || {};

    if (category && !bank.CATEGORY_ORDER.includes(category)) {
      return res.status(400).json({ error: 'שורה לא מוכרת' });
    }
    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ error: 'לא ניתן לשמור רעיון בלי טקסט' });
    }
    if (title !== undefined) {
      const refusal = whyNotBankable(title);
      if (refusal) return res.status(400).json({ error: refusal });
    }

    const cleanMaterials = Array.isArray(materials)
      ? materials.map(m => String(m).trim()).filter(Boolean)
      : undefined;

    if (bank.isSeedId(id)) {
      const original = bank.SEED_ITEMS.find(i => i.id === id);
      if (!original) return res.status(404).json({ error: 'הפריט לא נמצא' });

      await ContentBankItem.updateOne(
        { hides_seed_id: id },
        {
          $set: {
            hides_seed_id: id,
            theme: original.theme,
            category: original.category,
            title: original.title,
            created_by: req.user?.id || null,
          },
        },
        { upsert: true },
      );

      const replacement = await ContentBankItem.create({
        theme: (theme ?? original.theme).trim(),
        category: category || original.category,
        title: (title ?? original.title).trim(),
        notes: notes || '',
        materials: cleanMaterials ?? original.materials,
        age_groups: Array.isArray(ageGroups) ? ageGroups : original.age_groups,
        created_by: req.user?.id || null,
      });

      return res.json({
        item: { ...replacement.toObject(), id: replacement._id, origin: 'own' },
        replaced_seed: true,
      });
    }

    const item = await ContentBankItem.findById(id);
    if (!item) return res.status(404).json({ error: 'הפריט לא נמצא' });

    if (theme !== undefined) item.theme = String(theme).trim();
    if (category) item.category = category;
    if (title !== undefined) item.title = String(title).trim();
    if (notes !== undefined) item.notes = notes;
    if (cleanMaterials) item.materials = cleanMaterials;
    if (Array.isArray(ageGroups)) item.age_groups = ageGroups;
    await item.save();

    res.json({ item: { ...item.toObject(), id: item._id, origin: 'own' } });
  } catch (error) { next(error); }
}

/**
 * POST /api/content-bank/capture   { theme, age?, items: [{ category, title }] }
 *
 * Everything a gananet typed into the plan herself, kept.
 *
 * This is the half of the bank that makes it grow rather than age: the ideas
 * worth having next year are the ones she wrote this year, and asking her to
 * re-type them into a second screen means it never happens. So the gantt sends
 * what is new when she saves, and it lands under that week's subject.
 *
 * Three refusals, all silent by design — she pressed שמור on a work plan, not
 * on a bank form, and an error about the bank would be noise:
 *
 *   - no subject on the week, so there is nothing to file it under
 *   - the text names a child (birthdays and אבא של שבת live in this grid)
 *   - the bank already holds it, from the seed or from her
 *
 * The count of what was actually kept comes back so the screen can say so.
 */
async function capture(req, res, next) {
  try {
    const { theme, age, items } = req.body || {};
    const themeName = String(theme || '').trim();
    if (!themeName) return res.json({ added: 0, skipped: 0, reason: 'no_theme' });
    if (!Array.isArray(items) || !items.length) return res.json({ added: 0, skipped: 0 });

    const existing = new Set(
      (await bank.allItems()).map(i => `${i.category}|${i.title}`),
    );

    const seen = new Set();
    const toAdd = [];
    let skipped = 0;

    for (const raw of items.slice(0, 60)) {
      const category = raw?.category;
      const title = String(raw?.title || '').trim();
      if (!bank.CATEGORY_ORDER.includes(category) || !isBankable(title)) { skipped += 1; continue; }

      const key = `${category}|${title}`;
      if (existing.has(key) || seen.has(key)) { skipped += 1; continue; }
      seen.add(key);

      toAdd.push({
        theme: themeName,
        category,
        title,
        materials: [],
        age_groups: age ? [String(age)] : [],
        created_by: req.user?.id || null,
      });
    }

    if (toAdd.length) await ContentBankItem.insertMany(toAdd);
    res.json({ added: toAdd.length, skipped, theme: themeName });
  } catch (error) { next(error); }
}

/** POST /api/content-bank/:id/restore — un-hide a shipped item. */
async function restore(req, res, next) {
  try {
    await ContentBankItem.deleteOne({ hides_seed_id: req.params.id });
    res.json({ message: 'הפריט הוחזר' });
  } catch (error) { next(error); }
}

module.exports = { themes, browse, suggest, create, update, capture, remove, restore };
