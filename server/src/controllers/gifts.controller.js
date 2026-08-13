const archiver = require('archiver');
const { GiftCampaign, GiftSelection, Child, Classroom, Photo } = require('../models');
const gifts = require('../services/gift.service');
const photoService = require('../services/photo.service');
const storage = require('../services/storage.service');
const nursery = require('../services/nursery.service');

/**
 * Gift rounds, staff side.
 *
 * The screen answers one question all the way through: which children still
 * have no photograph on their gift. Everything else — who chose, who didn't,
 * which of the family's two the staff took — exists to make that answerable at
 * a glance, because the deadline is real and the supplier needs a complete
 * file.
 */

/** The classrooms this user may act on. Same branch rule as everywhere else. */
async function visibleClassrooms(user) {
  const rooms = await Classroom.find({ is_active: true }).populate('branch_id', 'name').lean();
  if (user.role === 'system_admin' || user.role === 'accountant') return rooms;
  const managed = (user.managed_branch_ids || []).map(String);
  const own = user.branch_id ? [String(user.branch_id)] : [];
  const allowed = new Set([...managed, ...own].filter(Boolean));
  if (allowed.size === 0) return rooms;
  return rooms.filter(r => allowed.has(String(r.branch_id?._id || r.branch_id)));
}

async function listCampaigns(_req, res) {
  const rows = await GiftCampaign.find({}).sort({ closes_on: -1 }).limit(30).lean();
  const today = nursery.todayKey();
  return res.json({
    today,
    categories: Classroom.CATEGORIES || [],
    campaigns: rows.map(c => ({ ...c, open_for_parents: gifts.isOpenForParents(c, today) })),
  });
}

function readCampaignBody(body, current = {}) {
  const name = String(body?.name ?? current.name ?? '').trim().slice(0, 80);
  const opens = nursery.normalizeDateKey(body?.opens_on ?? current.opens_on);
  const closes = nursery.normalizeDateKey(body?.closes_on ?? current.closes_on);
  const errors = [];

  if (!name) errors.push('חסר שם למבצע');
  if (!opens || !closes) errors.push('תאריכים לא תקינים');
  else if (opens > closes) errors.push('תאריך הפתיחה מאוחר מתאריך הסגירה');

  // Product per room level, free text. An empty level is allowed — a round can
  // deliberately skip the babies.
  const products = {};
  const src = body?.products && typeof body.products === 'object' ? body.products : current.products || {};
  for (const [category, value] of Object.entries(src)) {
    const v = String(value ?? '').trim().slice(0, 80);
    if (v) products[String(category).slice(0, 30)] = v;
  }

  const picks = Number(body?.picks_required ?? current.picks_required ?? 2);
  if (!Number.isInteger(picks) || picks < 1 || picks > 5) errors.push('מספר התמונות לבחירה אינו תקין');

  return { name, opens, closes, products, picks, errors };
}

async function createCampaign(req, res) {
  const { name, opens, closes, products, picks, errors } = readCampaignBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  const campaign = await GiftCampaign.create({
    name, opens_on: opens, closes_on: closes, products, picks_required: picks,
    created_by: req.user.id, created_by_name: req.user.full_name || '',
  });
  return res.json({ ok: true, campaign });
}

async function updateCampaign(req, res) {
  const current = await GiftCampaign.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'לא נמצא' });

  const { name, opens, closes, products, picks, errors } = readCampaignBody(req.body, current.toObject());
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  Object.assign(current, {
    name, opens_on: opens, closes_on: closes, products, picks_required: picks,
  });
  if (typeof req.body?.is_open === 'boolean') current.is_open = req.body.is_open;
  await current.save();

  return res.json({ ok: true, campaign: current });
}

/**
 * Where the round stands, child by child.
 *
 * Built from the ROSTER rather than from the selections: a child nobody has
 * touched has no selection row, and those are precisely the ones this screen
 * exists to surface. Driven off the selections it would show only the children
 * already handled.
 */
async function progress(req, res) {
  const campaign = await GiftCampaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: 'לא נמצא' });

  const rooms = await visibleClassrooms(req.user);
  const roomById = new Map(rooms.map(r => [String(r._id), r]));

  const children = await Child.find({
    is_active: true,
    classroom_id: { $in: rooms.map(r => r._id) },
  }).select('child_name classroom_id').sort({ child_name: 1 }).lean();

  const selections = await GiftSelection.find({
    campaign_id: campaign._id,
    child_id: { $in: children.map(c => c._id) },
  }).lean();
  const byChild = new Map(selections.map(s => [String(s.child_id), s]));

  // Every photograph any of this round's decisions points at, fetched once.
  const photoIds = new Set();
  for (const s of selections) {
    (s.parent_photo_ids || []).forEach(id => photoIds.add(String(id)));
    if (s.final_photo_id) photoIds.add(String(s.final_photo_id));
  }
  const photos = photoIds.size
    ? await Photo.find({ _id: { $in: [...photoIds] } }).lean()
    : [];
  const withUrls = storage.isConfigured() ? await photoService.withUrls(photos) : photos;
  const photoById = new Map(withUrls.map(p => [String(p._id), p]));

  const shapePhoto = (id) => {
    const p = photoById.get(String(id));
    if (!p) return null;
    return {
      id: String(p._id),
      url: p.url,
      thumb_url: p.thumb_url,
      width: p.width,
      height: p.height,
      low_resolution: gifts.isLowResolution(p),
    };
  };

  const rows = children.map(c => {
    const room = roomById.get(String(c.classroom_id));
    const sel = byChild.get(String(c._id));
    // The level decides the product, and Classroom.category is filled in on one
    // room out of thirty-eight — so it is resolved, not read.
    const category = nursery.classroomCategory(room);
    return {
      child_id: c._id,
      child_name: c.child_name,
      classroom_id: room?._id || null,
      classroom: room?.name || '',
      classroom_category: category || '',
      branch: room?.branch_id?.name || '',
      product: category ? (campaign.products?.[category] || '') : '',
      parent_picks: (sel?.parent_photo_ids || []).map(shapePhoto).filter(Boolean),
      chosen_at: sel?.chosen_at || null,
      final: sel?.final_photo_id ? shapePhoto(sel.final_photo_id) : null,
      final_source: sel?.final_source || '',
    };
  });

  return res.json({
    campaign: { ...campaign, open_for_parents: gifts.isOpenForParents(campaign) },
    totals: {
      children: rows.length,
      parents_chose: rows.filter(r => r.chosen_at).length,
      finalised: rows.filter(r => r.final).length,
      missing: rows.filter(r => !r.final).length,
    },
    children: rows,
  });
}

/**
 * Set the photograph that actually goes on the gift.
 *
 * Any photograph of that child is allowed, not only the family's two: when
 * nobody chose, the staff pick from what the gan has, and refusing that would
 * leave a child without a gift for having a parent who never opened the app.
 * Which of the two happened is recorded, because the office gets asked.
 */
async function setFinal(req, res) {
  const campaign = await GiftCampaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: 'לא נמצא' });

  const rooms = await visibleClassrooms(req.user);
  const child = await Child.findOne({ _id: req.params.childId, is_active: true })
    .populate('classroom_id', 'name category branch_id').lean();
  if (!child) return res.status(404).json({ error: 'לא נמצא' });
  if (!rooms.some(r => String(r._id) === String(child.classroom_id?._id))) {
    return res.status(403).json({ error: 'אין לך הרשאה לכיתה זו' });
  }

  const photo = await Photo.findById(req.body?.photo_id).lean();
  if (!photo) return res.status(404).json({ error: 'התמונה לא נמצאה' });
  if (!(photo.child_ids || []).some(id => String(id) === String(child._id))) {
    return res.status(400).json({ error: 'התמונה אינה מסומנת לילד זה' });
  }

  const existing = await GiftSelection.findOne({ campaign_id: campaign._id, child_id: child._id });
  const fromParent = (existing?.parent_photo_ids || []).some(id => String(id) === String(photo._id));

  const room = rooms.find(r => String(r._id) === String(child.classroom_id?._id));
  await GiftSelection.findOneAndUpdate(
    { campaign_id: campaign._id, child_id: child._id },
    {
      $set: {
        final_photo_id: photo._id,
        final_source: fromParent ? 'from_parent_picks' : 'staff_only',
        final_by: req.user.id,
        final_by_name: req.user.full_name || '',
        final_at: new Date(),
        child_name: child.child_name,
        classroom_id: room?._id || null,
        classroom_name: room?.name || '',
        classroom_category: nursery.classroomCategory(room) || '',
        branch_id: room?.branch_id?._id || room?.branch_id || null,
        branch_name: room?.branch_id?.name || '',
      },
      $setOnInsert: { campaign_id: campaign._id, child_id: child._id },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return res.json({ ok: true, final_source: fromParent ? 'from_parent_picks' : 'staff_only' });
}

/**
 * The file that goes to the supplier.
 *
 * A zip streamed as it is built rather than assembled in memory: a hundred
 * photographs at a megabyte each is a hundred megabytes, and holding that on a
 * small instance to hand over in one piece is how a deploy runs out of memory.
 *
 * Filenames carry the branch, the room and the child, because the supplier
 * prints from the filename and "IMG_4471.jpg" tells them nothing. A manifest
 * rides along for whoever checks the box against the list.
 */
async function exportCampaign(req, res) {
  const campaign = await GiftCampaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: 'לא נמצא' });
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'אחסון התמונות אינו מוגדר' });
  }

  const rooms = await visibleClassrooms(req.user);
  const selections = await GiftSelection.find({
    campaign_id: campaign._id,
    final_photo_id: { $ne: null },
    classroom_id: { $in: rooms.map(r => r._id) },
  }).sort({ branch_name: 1, classroom_name: 1, child_name: 1 }).lean();

  if (selections.length === 0) {
    return res.status(400).json({ error: 'אין עדיין תמונות סופיות לייצוא' });
  }

  const photos = await Photo.find({ _id: { $in: selections.map(s => s.final_photo_id) } }).lean();
  const photoById = new Map(photos.map(p => [String(p._id), p]));

  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'ללא';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${campaign.name}.zip`)}`
  );

  const zip = archiver('zip', { zlib: { level: 0 } }); // JPEGs do not compress
  zip.on('error', (err) => {
    console.error('[gifts] zip failed:', err.message);
    res.destroy();
  });
  zip.pipe(res);

  const manifest = ['סניף,כיתה,ילד,מוצר,קובץ,נבחר על ידי'];

  for (const sel of selections) {
    const photo = photoById.get(String(sel.final_photo_id));
    if (!photo) continue;

    const product = campaign.products?.[sel.classroom_category] || '';
    const fileName = `${safe(sel.branch_name)}/${safe(sel.classroom_name)}/${safe(sel.child_name)}.jpg`;

    try {
      const url = await storage.signedReadUrl(photo.key, 60 * 20);
      const upstream = await fetch(url);
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      zip.append(Buffer.from(await upstream.arrayBuffer()), { name: fileName });
      manifest.push([
        safe(sel.branch_name), safe(sel.classroom_name), safe(sel.child_name),
        safe(product), fileName,
        sel.final_source === 'from_parent_picks' ? 'ההורה' : 'הצוות',
      ].join(','));
    } catch (err) {
      console.error(`[gifts] export skipped ${sel.child_name}:`, err.message);
      manifest.push([safe(sel.branch_name), safe(sel.classroom_name), safe(sel.child_name), safe(product), 'שגיאה בהורדה', ''].join(','));
    }
  }

  // BOM so Excel opens the Hebrew correctly rather than as mojibake.
  zip.append(Buffer.from('﻿' + manifest.join('\n'), 'utf8'), { name: 'רשימה.csv' });
  await zip.finalize();
}

module.exports = {
  listCampaigns, createCampaign, updateCampaign, progress, setFinal, exportCampaign,
};
