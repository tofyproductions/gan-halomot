const { ParentAccount, Contract, Registration, Child, DailyLog, DailyMenu } = require('../models');
const nursery = require('../services/nursery.service');
const { findParent, contactFromChild, normalizeIdNumber } = require('../services/parentDirectory.service');
const { EDITABLE, diffEditable, recordChange } = require('../services/parentChanges.service');
const { normalizePhone, sendSms } = require('../services/sms.service');
const otp = require('../services/parentOtp.service');

/**
 * Everything a parent may look at, and the one rule that keeps it theirs.
 *
 * Every handler here starts at `loadOwnChild`. It does not trust the child id
 * in the URL for anything except lookup: the parent's children are resolved
 * from the enrolment data on this request, and the id must be one of them. A
 * parent editing the number in the address bar gets a 404, not somebody
 * else's child — and it stays true when a family leaves, because the list is
 * rebuilt rather than remembered.
 *
 * The 404 is deliberate where a 403 would be more literal. "Forbidden" tells
 * whoever is trying that the id exists.
 */

/**
 * The child at :childId, if it belongs to the signed-in parent.
 *
 * Returns { parent, child } or null. Null means "not yours" and "no such
 * child" and the caller must not distinguish them.
 */
async function loadOwnChild(req) {
  const account = await ParentAccount.findById(req.parent.pid).lean();
  if (!account || !account.is_active) return null;

  const parent = await findParent(account.id_number);
  if (!parent) return null;

  // The id may be any year's row for the child — the portal shows the newest,
  // but a link kept from last term should still open the same child rather
  // than 404. The whole group comes back so the contracts of every year the
  // child was enrolled are reachable from one screen.
  const group = parent.groups.find(g =>
    g.years.some(y => String(y._id) === String(req.params.childId)));
  if (!group) return null;

  return { account, parent, child: group.current, group };
}

/**
 * The OTHER parent's name on this child, or null when there isn't one.
 *
 * "The one in the second slot" does not work. Most children carry no
 * parent_id_number at all (63 of 71), so a check for "am I the first parent?"
 * answers no for almost everyone and hands back the first parent's name —
 * which is this parent, listed under "הורה נוסף" as though the family had two
 * people with one name.
 *
 * So it works by elimination instead: collect the parent names the child
 * knows of, drop any that are this parent by ID or by name, and take what is
 * left. Comparing names is weak, and it is the only signal most of these
 * records have; the failure it can still produce — hiding a genuine second
 * parent who happens to share a name — is the harmless direction.
 */
function otherParentName(child, myId, myName) {
  const norm = (v) => String(v || '').replace(/\D/g, '');
  const clean = (v) => String(v || '').trim();
  const mine = clean(myName);

  const slots = [
    { id: norm(child.parent_id_number), name: clean(child.parent_name) },
    { id: norm(child.parent2_id_number), name: clean(child.parent2_name) },
  ];
  const reg = child.registration_id;
  if (reg && typeof reg === 'object') {
    slots.push({ id: norm(reg.parent_id_number), name: clean(reg.parent_name) });
  }

  for (const s of slots) {
    if (!s.name) continue;
    if (s.id && s.id === myId) continue;
    if (!s.id && mine && s.name === mine) continue;
    if (mine && s.name === mine) continue;
    return s.name;
  }
  return null;
}

/**
 * Everything the gan holds on one child, as the parent may see it.
 *
 * Explicitly listed field by field rather than spread from the record.
 * A child document carries internal notes and whatever a future migration
 * adds to it; a spread would publish each new field the day it appeared,
 * silently. Adding something here has to be a decision.
 */
async function childDetails(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { child, parent } = own;
  const me = contactFromChild(child, parent.id_number);
  const reg = child.registration_id && typeof child.registration_id === 'object'
    ? child.registration_id : null;

  return res.json({
    id: child._id,
    child: {
      name: child.child_name,
      id_number: child.child_id_number || '',
      birth_date: child.birth_date,
      classroom: child.classroom_id?.name || null,
      classroom_category: child.classroom_id?.category || null,
      academic_year: child.academic_year,
    },
    // The parent's own contact details — the ones they may ask to correct.
    contact: {
      parent_name: me.name || '',
      phone: me.phone || '',
      address: child.address || '',
      emergency_contact: child.emergency_contact || '',
      emergency_phone: child.emergency_phone || '',
    },
    // Health. Shown because a parent noticing an out-of-date allergy here is
    // the entire reason this screen is worth building.
    health: {
      allergies: child.allergies || '',
      medical_alerts: child.medical_alerts || '',
    },
    // The second parent, when the records know of one. Name only: the other
    // parent's ID number and phone are their details, not this parent's.
    second_parent: otherParentName(child, parent.id_number, me.name),
    registration: reg ? { start_date: reg.start_date, end_date: reg.end_date } : null,
    // Whether this child's screen should carry the daily board at all. Only
    // the infant rooms keep one; a three-year-old's parent has no bottle log
    // to read and should not be shown an empty one.
    is_nursery: nursery.isNurseryClassroom(child.classroom_id),
  });
}

/**
 * The child's day, as their parent sees it.
 *
 * One screen rather than the old system's two. That system had a "live" page
 * and a "daily report" page holding the same values, differing only in when
 * you opened them — so a parent who opened the wrong one at the wrong hour got
 * either a half-empty report or a live view they thought was final. Here it is
 * the same page all day: incomplete in the morning because the day is
 * incomplete, and finished by evening because the day is.
 *
 * Read-only, all of it. What the parent may write goes through updateChildDay
 * below, and it is four fields.
 */
async function childDay(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { child } = own;
  if (!nursery.isNurseryClassroom(child.classroom_id)) {
    return res.status(400).json({ error: 'הלוח היומי קיים לתינוקייה בלבד' });
  }

  const today = nursery.todayKey();
  const date = nursery.normalizeDateKey(req.query.date) || today;
  // A parent may look back, never forward: a future date would show an empty
  // day that reads as "the gan recorded nothing" rather than "it hasn't
  // happened".
  if (date > today) return res.status(400).json({ error: 'תאריך עתידי' });

  const branchId = child.classroom_id?.branch_id || null;
  const [log, menuDoc, menu] = await Promise.all([
    DailyLog.findOne({ child_id: child._id, date }).lean(),
    branchId ? DailyMenu.findOne({ branch_id: branchId, date }).lean() : null,
    nursery.getMenu(),
  ]);

  // Only the dishes actually chosen, resolved to their Hebrew labels. Handing
  // over the whole menu and letting the screen work out what was served would
  // publish every dish the gan has ever offered.
  const served = [];
  for (const [mealKey, meal] of Object.entries(menu)) {
    const categories = [];
    for (const category of Object.keys(meal.categories || {})) {
      const dishes = menuDoc?.selections?.[`${mealKey}.${category}`] || [];
      if (dishes.length) categories.push({ category, dishes });
    }
    if (categories.length) served.push({ meal: mealKey, label: meal.label, categories });
  }

  return res.json({
    date,
    today,
    is_today: date === today,
    child: { id: child._id, name: child.child_name },
    // Absent means nobody has recorded anything yet, which the screen must say
    // differently from "the child was marked away".
    log: log ? {
      attendance: log.attendance || '',
      home: log.home || {},
      meals: log.meals || {},
      sleep: log.sleep || {},
      diapers: log.diapers || '',
      missing: log.missing || [],
      staff_note: log.staff_note || '',
      updated_at: log.updated_at || null,
    } : null,
    menu: served,
  });
}

/**
 * What a parent may write about their child's day: how the morning went at
 * home, before the gan saw them.
 *
 * Four fields, and only today's. Yesterday has already been read by the staff
 * and acted on — a parent editing it changes a record of something that is
 * over, and the teacher who read "slept badly" this morning has no way to
 * learn it later said otherwise.
 *
 * Nothing the staff record is writable here. Not by omission — the whitelist
 * below is the entire surface, so a request naming meals or sleep writes
 * nothing rather than being trusted because it came from a logged-in parent.
 */
const PARENT_DAY_FIELDS = {
  'home.wake_time': (v) => {
    const s = String(v ?? '').trim().slice(0, 5);
    return s === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
  },
  'home.meal_time': (v) => {
    const s = String(v ?? '').trim().slice(0, 5);
    return s === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
  },
  'home.meal_amount': (v) => String(v ?? '').trim().slice(0, 60),
  'home.parent_note': (v) => String(v ?? '').trim().slice(0, 500),
};

async function updateChildDay(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { child } = own;
  if (!nursery.isNurseryClassroom(child.classroom_id)) {
    return res.status(400).json({ error: 'הלוח היומי קיים לתינוקייה בלבד' });
  }

  const today = nursery.todayKey();
  const date = nursery.normalizeDateKey(req.body?.date) || today;
  if (date !== today) {
    return res.status(400).json({ error: 'אפשר לעדכן רק את היום הנוכחי' });
  }

  const set = {};
  for (const [path, parse] of Object.entries(PARENT_DAY_FIELDS)) {
    if (!(path in (req.body || {}))) continue;
    const value = parse(req.body[path]);
    if (value === null) return res.status(400).json({ error: 'שעה לא תקינה' });
    set[path] = value;
  }
  if (Object.keys(set).length === 0) return res.json({ ok: true, changed: 0 });

  // Written on insert only. A parent's first update of the morning may well
  // create the row before any teacher has touched it, and the row still has to
  // know which child and which room it belongs to for the staff board to find
  // it.
  const log = await DailyLog.findOneAndUpdate(
    { child_id: child._id, date },
    {
      $set: set,
      $setOnInsert: {
        child_id: child._id,
        date,
        child_name: child.child_name,
        classroom_id: child.classroom_id?._id || null,
        branch_id: child.classroom_id?.branch_id || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({ ok: true, changed: Object.keys(set).length, home: log.home || {} });
}

/**
 * The signed enrolment contracts for one child, newest first.
 *
 * Two places hold them and both are read. A Contract row carries the PDF
 * itself, base64 in the database; a registration may instead carry a link to
 * Google Drive, which is where the older ones went. Only signed documents are
 * listed — a draft is the gan's working copy and showing it would invite
 * questions about a version nobody agreed to.
 *
 * Drive links are handed over as links rather than proxied. The alternative
 * is fetching somebody else's host on a parent's behalf, which turns a slow
 * Google into a slow portal.
 */
async function childContracts(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  // Every year the child was enrolled, not just the current one — "the
  // contract and the previous years'" is one list, and each year is a separate
  // registration behind a separate Child row.
  const rows = own.group.years;
  const regIds = rows
    .map(r => r.registration_id?._id || r.registration_id)
    .filter(Boolean);

  const yearOfReg = new Map(rows.map(r =>
    [String(r.registration_id?._id || r.registration_id), r.academic_year]));

  const out = [];

  const stored = await Contract.find({
    registration_id: { $in: regIds },
    type: 'enrollment',
    status: 'signed',
  }).select('_id file_name signed_at created_at registration_id')
    .sort({ created_at: -1 }).lean();

  for (const c of stored) {
    out.push({
      id: String(c._id),
      source: 'file',
      file_name: c.file_name,
      signed_at: c.signed_at || c.created_at,
      academic_year: yearOfReg.get(String(c.registration_id)) || null,
    });
  }

  // A year with no stored file may still have a Drive link on its
  // registration. Checked per year, so a year that has a real file is not
  // shadowed by a link and a year that has only a link is not lost.
  const yearsWithFile = new Set(out.map(c => c.academic_year));
  const regs = await Registration.find({ _id: { $in: regIds } })
    .select('contract_pdf_path agreement_signed academic_year updated_at').lean();

  for (const reg of regs) {
    const year = yearOfReg.get(String(reg._id)) || reg.academic_year || null;
    if (yearsWithFile.has(year)) continue;
    if (!reg.agreement_signed) continue;
    if (!reg.contract_pdf_path || !/^https?:\/\//i.test(reg.contract_pdf_path)) continue;
    out.push({
      id: `reg:${reg._id}`,
      source: 'link',
      url: reg.contract_pdf_path,
      file_name: 'חוזה רישום',
      signed_at: reg.updated_at || null,
      academic_year: year,
    });
  }

  out.sort((a, b) => String(b.academic_year || '').localeCompare(String(a.academic_year || '')));
  return res.json({ contracts: out });
}

/**
 * The bytes of one stored contract.
 *
 * Ownership is checked through the child, exactly as everywhere else, and
 * then the contract is checked to belong to that child's registration — the
 * contract id in the URL is never enough on its own.
 */
async function contractFile(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  // Any of the child's own enrolments, since the list spans every year.
  const regIds = new Set(own.group.years
    .map(r => String(r.registration_id?._id || r.registration_id || ''))
    .filter(Boolean));
  const contract = await Contract.findById(req.params.contractId).lean();

  if (!contract
      || contract.type !== 'enrollment'
      || contract.status !== 'signed'
      || !regIds.has(String(contract.registration_id))) {
    return res.status(404).json({ error: 'לא נמצא' });
  }

  const buf = Buffer.from(contract.file_data, 'base64');
  res.setHeader('Content-Type', contract.file_mimetype || 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(contract.file_name || 'contract.pdf')}`
  );
  return res.send(buf);
}

/**
 * Apply a parent's corrections to their child's record.
 *
 * Written to the CURRENT year's row only. The older rows are what the gan
 * agreed to at the time; rewriting them would quietly restate history, and
 * nobody reads them anyway — the staff work from this year.
 *
 * The record of the change is written FIRST. If that write fails the edit does
 * not happen, which is the correct order for the one field where the record is
 * the safety mechanism rather than an audit trail.
 */
async function updateChild(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { account, child } = own;
  const { updates, byCategory, errors } = diffEditable(req.body, child);

  if (errors.length) return res.status(400).json({ error: errors.join('. ') });
  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, changed: 0 });
  }

  for (const [category, changes] of Object.entries(byCategory)) {
    await recordChange({ account, child, category, changes });
  }
  await Child.updateOne({ _id: child._id }, { $set: updates });

  return res.json({ ok: true, changed: Object.keys(updates).length });
}

/**
 * Step 1 of changing the phone: send a code to the NEW number.
 *
 * Sending it to the old one would prove nothing — whoever is asking is
 * already inside the session. Sending it to the new one proves they hold the
 * phone they are about to redirect every future login code to, which is the
 * only thing that makes this safe to expose at all.
 *
 * Nothing is written to the enrolment records here. Until the code comes back
 * the new number is a claim.
 */
async function startPhoneChange(req, res) {
  const account = await ParentAccount.findById(req.parent.pid);
  if (!account || !account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  const next = normalizePhone(req.body?.phone);
  if (!next) return res.status(400).json({ error: 'יש להזין מספר טלפון נייד תקין' });
  if (next === normalizePhone(account.phone)) {
    return res.status(400).json({ error: 'זה המספר הרשום כבר' });
  }

  account.phone_change = account.phone_change || {};
  const gate = otp.canSend(account.phone_change);
  if (!gate.ok) {
    return res.status(429).json({
      error: 'נשלח כבר קוד. יש להמתין לפני שליחה נוספת.',
      retry_after_seconds: gate.retryAfterSeconds,
    });
  }

  account.phone_change.new_phone = next;
  const code = otp.issueCode(account.phone_change);

  try {
    await sendSms({
      to: next,
      text: `קוד לאישור מספר הטלפון החדש שלך ב״גן החלומות״: ${code}`,
    });
  } catch (err) {
    console.error('[parent-portal] phone-change SMS failed:', err.message);
    return res.status(502).json({ error: 'שליחת הקוד נכשלה. נסו שוב בעוד רגע.' });
  }

  account.markModified('phone_change');
  await account.save();
  return res.json({ ok: true });
}

/**
 * Step 2: the code came back, so the number is theirs.
 *
 * The phone is written wherever this parent's number lives — every child row
 * and registration where this ID is the parent — because that is where
 * parentDirectory reads it from when the next login code is sent. Writing it
 * only onto the account would leave the account saying one thing and the
 * records another, and the records would win.
 */
async function confirmPhoneChange(req, res) {
  const account = await ParentAccount.findById(req.parent.pid);
  if (!account || !account.is_active) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  const pending = account.phone_change || {};
  if (!pending.new_phone) {
    return res.status(400).json({ error: 'לא התחלת שינוי מספר. יש להתחיל מחדש.' });
  }

  const result = otp.verifyCode(pending, req.body?.code);
  account.markModified('phone_change');

  if (!result.ok) {
    await account.save();
    const messages = {
      no_code: 'לא נשלח קוד. יש להתחיל מחדש.',
      expired: 'הקוד פג תוקף. יש לבקש קוד חדש.',
      too_many_attempts: 'יותר מדי ניסיונות. יש לבקש קוד חדש.',
      wrong: 'הקוד שגוי.',
    };
    return res.status(400).json({ error: messages[result.reason] || 'הקוד שגוי.', code: result.reason });
  }

  const parent = await findParent(account.id_number);
  if (!parent) {
    return res.status(403).json({ error: 'החשבון סגור. לבירור יש לפנות לגן.' });
  }

  const before = normalizePhone(account.phone) || '';
  const next = pending.new_phone;
  const id = normalizeIdNumber(account.id_number);

  // Every place this parent's number is stored. Which slot they occupy differs
  // per child — see parentDirectory.contactFromChild for why all three exist.
  for (const child of parent.children) {
    const set = {};
    if (normalizeIdNumber(child.parent_id_number) === id) set.phone = next;
    if (normalizeIdNumber(child.parent2_id_number) === id) set.parent2_phone = next;
    if (Object.keys(set).length) await Child.updateOne({ _id: child._id }, { $set: set });

    const reg = child.registration_id;
    if (reg && typeof reg === 'object' && normalizeIdNumber(reg.parent_id_number) === id) {
      await Registration.updateOne({ _id: reg._id }, { $set: { parent_phone: next } });
    }
  }

  await recordChange({
    account,
    child: parent.groups[0]?.current || null,
    category: 'phone',
    changes: [{ field: 'phone', label: 'טלפון', before: before || null, after: next }],
  });

  account.phone = next;
  account.phone_change = { new_phone: null };
  account.markModified('phone_change');
  await account.save();

  return res.json({ ok: true, phone: next });
}

/** Which fields a parent may edit, so the screen is built from the same list. */
function editableFields(_req, res) {
  return res.json({ editable: EDITABLE });
}

module.exports = {
  childDetails, childContracts, contractFile,
  updateChild, startPhoneChange, confirmPhoneChange, editableFields,
  childDay, updateChildDay,
};
