const crypto = require('crypto');
const { Setting } = require('../models');

/**
 * Custom distribution links — the office's own additions to the built-in
 * addresses on the קישורים להפצה screen: a Google form, a payment page, a
 * waze link to the gan. Each carries a title and an optional description so
 * the person copying it knows what they are sending without opening it.
 *
 * Stored as one Setting row ('custom_share_links') — a list, not a
 * collection: tens of links at most, read as a whole every time.
 */
const KEY = 'custom_share_links';

async function readLinks() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  return Array.isArray(doc?.value) ? doc.value : [];
}

async function writeLinks(links) {
  await Setting.findOneAndUpdate({ key: KEY }, { value: links }, { upsert: true });
}

const clean = (b = {}) => ({
  title: String(b.title || '').trim().slice(0, 120),
  url: String(b.url || '').trim().slice(0, 2000),
  description: String(b.description || '').trim().slice(0, 500),
});

const validUrl = (u) => /^https?:\/\/\S+$/i.test(u);

async function list(req, res, next) {
  try {
    res.json({ links: await readLinks() });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    const { title, url, description } = clean(req.body);
    if (!title) return res.status(400).json({ error: 'חסר שם לקישור' });
    if (!validUrl(url)) return res.status(400).json({ error: 'כתובת לא תקינה — חייבת להתחיל ב-http או https' });
    const links = await readLinks();
    links.push({ id: crypto.randomUUID(), title, url, description });
    await writeLinks(links);
    res.status(201).json({ links });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const links = await readLinks();
    const hit = links.find((l) => l.id === req.params.id);
    if (!hit) return res.status(404).json({ error: 'הקישור לא נמצא' });
    const { title, url, description } = clean({ ...hit, ...req.body });
    if (!title) return res.status(400).json({ error: 'חסר שם לקישור' });
    if (!validUrl(url)) return res.status(400).json({ error: 'כתובת לא תקינה — חייבת להתחיל ב-http או https' });
    Object.assign(hit, { title, url, description });
    await writeLinks(links);
    res.json({ links });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const links = await readLinks();
    const next_ = links.filter((l) => l.id !== req.params.id);
    if (next_.length === links.length) return res.status(404).json({ error: 'הקישור לא נמצא' });
    await writeLinks(next_);
    res.json({ links: next_ });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove };
