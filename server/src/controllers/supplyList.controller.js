const { SupplyList } = require('../models');
const { htmlToPng } = require('../services/htmlPdf');
const { buildSupplyListPosterHtml } = require('../services/posterTemplates');

// Seeded into the singleton the first time anybody opens the editor — the
// starting list the office asked for. After that it's just whatever they saved.
const DEFAULT_ITEMS = [
  { name: 'חבילת טיטולים', note: 'הטיטולים לפי הצורך — צוות הגן יעדכן', emoji: '🧷', color: '#e8443b' },
  { name: 'משחת החתלה', note: '', emoji: '🧴', color: '#f5871f' },
  { name: '4 חבילות מגבונים כל חודש', note: '', emoji: '🧻', color: '#f0a500' },
  { name: 'תמ״ל', note: '', emoji: '📦', color: '#2bb673' },
  { name: 'מצעים — סדין + שמיכה עם שם הילד + סדין נקי במגירה', note: '', emoji: '🛏️', color: '#17a2b8' },
  { name: '2 מוצצים', note: '', emoji: '👶', color: '#2e7dd7' },
  { name: '2 בקבוקי חלב (במידה וצריך)', note: '', emoji: '🍼', color: '#5b57c9' },
  { name: 'בקבוק מים עם השם', note: '', emoji: '💧', color: '#8e44ad' },
  { name: '2 סטים של בגדי החלפה', note: '', emoji: '👕', color: '#e84393' },
  { name: 'חפץ מעבר (במידה ומשתמש)', note: '', emoji: '🧸', color: '#ff6f91' },
  { name: 'מד חום קשיח', note: '', emoji: '🌡️', color: '#00a8cc' },
];

async function getOrSeed() {
  let doc = await SupplyList.findOne({});
  if (!doc) doc = await SupplyList.create({ items: DEFAULT_ITEMS });
  return doc;
}

async function get(req, res, next) {
  try {
    const doc = await getOrSeed();
    res.json(doc.toObject());
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  try {
    const { title, subtitle, lead, callout, footer, items } = req.body || {};
    if (items !== undefined && !Array.isArray(items)) {
      return res.status(400).json({ error: 'items חייב להיות מערך' });
    }
    if (Array.isArray(items) && items.some(it => !it || !String(it.name || '').trim())) {
      return res.status(400).json({ error: 'לכל פריט חייב להיות שם' });
    }

    const doc = await getOrSeed();
    if (title !== undefined) doc.title = title;
    if (subtitle !== undefined) doc.subtitle = subtitle;
    if (lead !== undefined) doc.lead = lead;
    if (callout !== undefined) doc.callout = callout;
    if (footer !== undefined) doc.footer = footer;
    if (items !== undefined) {
      doc.items = items.map(it => ({
        name: String(it.name).trim(),
        note: it.note || '',
        emoji: it.emoji || '',
        color: it.color || '',
      }));
    }
    await doc.save();
    res.json(doc.toObject());
  } catch (error) { next(error); }
}

/** GET /api/parent-supply-list/poster — the current list as a PNG poster. */
async function posterImage(req, res, next) {
  try {
    const doc = await getOrSeed();
    const html = buildSupplyListPosterHtml({
      title: doc.title,
      subtitle: doc.subtitle,
      lead: doc.lead,
      callout: doc.callout,
      footer: doc.footer,
      items: doc.items,
    });
    const png = await htmlToPng(html);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'inline; filename="reshimat-tziud.png"');
    res.send(png);
  } catch (error) {
    console.error('[supply-list] poster render failed:', error.message);
    res.status(503).json({ error: error.message || 'הפקת התמונה נכשלה — נסו שוב בעוד רגע' });
  }
}

module.exports = { get, update, posterImage };
