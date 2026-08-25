const { ParentAccount, Contract, Registration, Child, DailyLog, DailyMenu, Photo, GiftSelection } = require('../models');
const vacationCalendar = require('../services/vacationCalendar');
const parentVisibility = require('../services/parentVisibility');
const nursery = require('../services/nursery.service');
const storage = require('../services/storage.service');
const photoService = require('../services/photo.service');
const giftService = require('../services/gift.service');
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
  const menuVisible = branchId
    ? (await parentVisibility.visibilityFor(branchId, parentVisibility.weekKey(date))).menu
    : true;
  const [log, menuDoc, menu] = await Promise.all([
    DailyLog.findOne({ child_id: child._id, date }).lean(),
    branchId ? DailyMenu.findOne({ branch_id: branchId, date }).lean() : null,
    nursery.getMenu(),
  ]);

  // Only the dishes actually chosen. Handing over the whole menu and letting
  // the screen work out what was served would publish every dish the gan has
  // ever offered.
  //
  // Built from what that DAY stored, not from the menu as it stands now. The
  // menu is configuration the gan edits — renaming a category or dropping a
  // dish is a Tuesday afternoon decision — and reading the day through the
  // current shape would quietly empty every past day that used the old one.
  // What was served in March does not change because the kitchen reorganised
  // in June.
  const byMeal = new Map();
  for (const [key, dishes] of Object.entries(menuDoc?.selections || {})) {
    if (!Array.isArray(dishes) || dishes.length === 0) continue;
    const sep = key.indexOf('.');
    if (sep < 1) continue;
    const mealKey = key.slice(0, sep);
    const category = key.slice(sep + 1);
    if (!byMeal.has(mealKey)) byMeal.set(mealKey, []);
    byMeal.get(mealKey).push({ category, dishes });
  }

  // Ordered by the menu the gan keeps, so breakfast comes before lunch; a meal
  // that has since been removed still appears, at the end, under its own key.
  const order = Object.keys(menu);
  const served = [...byMeal.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(([mealKey, categories]) => ({
      meal: mealKey,
      label: menu[mealKey]?.label || mealKey,
      categories,
    }));

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
    // The gan decides, week by week, whether the kitchen's day is published.
    // Default ON — parents see this today, and switching it off by default
    // would take something away without anybody choosing to.
    menu: menuVisible ? served : [],
    menu_hidden: !menuVisible,
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

/**
 * Add the child's other parent.
 *
 * A registration carries one parent — whoever filled the form — so most
 * children in this system know of only one, and the second is a person the
 * gan has a phone number for on paper and nothing for in the database. This
 * lets the parent who is already here fill that in.
 *
 * Two rules make it safe, and both are refusals rather than warnings.
 *
 * It only ADDS. A second parent already on the record cannot be edited or
 * replaced from here: changing their phone would redirect the one-time codes
 * for somebody else's account to a number this parent chose, which is the
 * takeover the whole login design exists to prevent. Corrections go through
 * the office.
 *
 * And it grants nothing. The details land immediately — the gan needs a second
 * contact for a child today, not after a queue is read — but the account is
 * created unapproved, so nobody can see a child's records until the staff say
 * so. One parent naming a second person is not the same as the gan agreeing to
 * it, and a separated family is exactly where the difference matters.
 */
async function addSecondParent(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const { account, parent, group } = own;

  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  const idNumber = normalizeIdNumber(req.body?.id_number);
  const phone = normalizePhone(req.body?.phone);

  if (!name) return res.status(400).json({ error: 'יש להזין שם' });
  if (idNumber.length < 8 || idNumber.length > 9) {
    return res.status(400).json({ error: 'מספר תעודת זהות אינו תקין' });
  }
  if (!phone) return res.status(400).json({ error: 'יש להזין מספר טלפון נייד תקין' });
  if (idNumber === normalizeIdNumber(account.id_number)) {
    return res.status(400).json({ error: 'זו תעודת הזהות שלך' });
  }

  // Already recorded — on any of the child's years, since they are one family
  // across all of them.
  const existing = group.years.find(y => normalizeIdNumber(y.parent2_id_number)
    || (normalizeIdNumber(y.parent_id_number) && normalizeIdNumber(y.parent_id_number) !== normalizeIdNumber(account.id_number)));
  if (existing) {
    return res.status(409).json({
      error: 'רשום כבר הורה נוסף לילד זה. לשינוי יש לפנות לגן.',
      code: 'ALREADY_SET',
    });
  }

  // Written onto every year of this child, so the record agrees with itself
  // and a login resolves the same family whichever year it lands on.
  await Child.updateMany(
    { _id: { $in: group.years.map(y => y._id) } },
    { $set: { parent2_name: name, parent2_id_number: idNumber, parent2_phone: phone } }
  );

  // Created unapproved — unless this person already has an account of their
  // own, in which case they are an existing parent here and downgrading them
  // would lock them out of a child they already have.
  let invited = await ParentAccount.findOne({ id_number: idNumber });
  if (!invited) {
    invited = await ParentAccount.create({
      id_number: idNumber,
      full_name: name,
      phone,
      access_approved: false,
      invited_by: account._id,
      invited_at: new Date(),
    });
  }

  await recordChange({
    account,
    child: group.current,
    category: 'second_parent',
    relatedAccountId: invited._id,
    changes: [{
      field: 'parent2',
      label: 'הורה נוסף',
      before: null,
      after: `${name} · ${idNumber} · ${phone}`,
    }],
  });

  return res.json({
    ok: true,
    second_parent: { name, phone },
    awaiting_approval: !invited.access_approved,
  });
}

/**
 * The photographs a parent may see.
 *
 * Two streams, and the difference between them is the whole design.
 *
 * `mine` — every photograph the staff tagged this child in, plus whatever the
 * parent uploaded themselves. This is the one they came for.
 *
 * `classroom` — the week the room had. The gan chose a class gallery, so a
 * parent sees what happened rather than only the frames their own child
 * happens to be in. Staff photographs only: a photograph another parent
 * uploaded is that family's, and this system cannot know who else is in it.
 *
 * `source: 'staff'` on the classroom query is therefore not a filter, it is
 * the rule. Written as part of the query rather than applied afterwards,
 * because a photograph that reaches the wrong family cannot be recalled.
 */
const CLASSROOM_WINDOW_DAYS = 7;
const MINE_LIMIT = 60;

async function childPhotos(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });
  if (!storage.isConfigured()) {
    return res.json({ mine: [], classroom: [], storage_ready: false });
  }

  const { group, child } = own;
  const childIds = group.years.map(y => y._id);
  const classroomId = child.classroom_id?._id || child.classroom_id || null;

  const since = new Date();
  since.setDate(since.getDate() - CLASSROOM_WINDOW_DAYS);
  const sinceKey = nursery.todayKey(since);

  const [mine, classroom] = await Promise.all([
    // Across every year of this child, so a photograph from last term does not
    // vanish the day the new year's row is created.
    Photo.find({
      $or: [
        { child_ids: { $in: childIds } },
        { source: 'parent', uploaded_by_parent: own.account._id, child_ids: { $in: childIds } },
      ],
    }).sort({ date: -1, created_at: -1 }).limit(MINE_LIMIT).lean(),

    classroomId
      ? Photo.find({ classroom_id: classroomId, source: 'staff', date: { $gte: sinceKey } })
        .sort({ date: -1, created_at: -1 }).limit(60).lean()
      : [],
  ]);

  const shape = (rows) => rows.map(r => ({
    id: r._id,
    date: r.date,
    caption: r.caption || '',
    source: r.source,
    width: r.width,
    height: r.height,
    url: r.url,
    thumb_url: r.thumb_url,
  }));

  return res.json({
    storage_ready: true,
    window_days: CLASSROOM_WINDOW_DAYS,
    mine: shape(await photoService.withUrls(mine)),
    classroom: shape(await photoService.withUrls(classroom)),
  });
}

/**
 * A parent adds a photograph of their own child.
 *
 * Tagged to their child and to nobody else, and visible to them and the staff
 * alone. The system cannot know who is in a photograph a parent sends — a
 * birthday picture carries four other children whose families agreed to
 * nothing — so it is never shown to another family, whatever it turns out to
 * contain. Its purpose is choosing a photograph for a gift, and that needs no
 * audience.
 */
async function uploadChildPhoto(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'אחסון התמונות אינו זמין כרגע.' });
  }

  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'לא נבחרה תמונה' });

  const { child, account } = own;
  const date = nursery.todayKey();
  const prefix = `parent/${account._id}/${date}`;

  const saved = [];
  const failed = [];
  for (const file of files) {
    if (!photoService.isAcceptable(file)) {
      failed.push({ name: file.originalname, error: 'קובץ שאינו תמונה, או גדול מדי' });
      continue;
    }
    try {
      const stored = await photoService.storeUpload({ buffer: file.buffer, prefix });
      const row = await Photo.create({
        ...stored,
        source: 'parent',
        branch_id: child.classroom_id?.branch_id || null,
        classroom_id: child.classroom_id?._id || child.classroom_id || null,
        child_ids: [child._id],
        date,
        uploaded_by_parent: account._id,
        uploaded_by_name: account.full_name || '',
      });
      saved.push(row);
    } catch (err) {
      console.error('[parent-photos] upload failed:', err.message);
      failed.push({ name: file.originalname, error: 'לא הצלחנו לעבד את הקובץ' });
    }
  }

  return res.json({ ok: true, saved: saved.length, failed });
}

/**
 * The gift round, as the family sees it.
 *
 * Returns the round, what they have already chosen, and the photographs they
 * may choose from — which is their child's stream and never the classroom
 * gallery. A gift is the child's, and letting a parent pick a group photograph
 * would put other people's children on a mug they never agreed to.
 *
 * A closed round still returns what was chosen. The deadline stops the
 * choosing, not the family's ability to see what they picked.
 */
async function childGift(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const campaign = await giftService.currentCampaign();
  if (!campaign) return res.json({ campaign: null });

  const { group, child, account } = own;
  const childIds = group.years.map(y => y._id);

  const [selection, photos] = await Promise.all([
    GiftSelection.findOne({ campaign_id: campaign._id, child_id: { $in: childIds } }).lean(),
    storage.isConfigured() ? giftService.selectablePhotos(childIds, account._id) : [],
  ]);

  const withUrls = photos.length ? await photoService.withUrls(photos) : [];
  const open = giftService.isOpenForParents(campaign);

  return res.json({
    campaign: {
      id: campaign._id,
      name: campaign.name,
      closes_on: campaign.closes_on,
      picks_required: campaign.picks_required,
      open,
      // Resolved rather than read: Classroom.category is set on one room in
      // thirty-eight, so reading it would tell almost every family the gan has
      // no gift for them.
      product: (() => {
        const category = nursery.classroomCategory(child.classroom_id);
        return category ? (campaign.products?.[category] || '') : '';
      })(),
    },
    chosen: (selection?.parent_photo_ids || []).map(String),
    chosen_at: selection?.chosen_at || null,
    // Whether the gan has already settled on one. Shown so a family that
    // missed the deadline can see their child was not forgotten.
    finalised: Boolean(selection?.final_photo_id),
    photos: withUrls.map(p => ({
      id: String(p._id),
      url: p.url,
      thumb_url: p.thumb_url,
      date: p.date,
      source: p.source,
    })),
  });
}

/**
 * The family's choice.
 *
 * Replaces the whole set rather than adding one at a time: choosing is "these
 * two", and a per-photo toggle would let a half-finished pair sit in the
 * record looking like a decision.
 *
 * Every id is checked against the child's own photographs. A parent sending an
 * id from the classroom gallery — or from nowhere — writes nothing.
 */
async function setChildGift(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'לא נמצא' });

  const campaign = await giftService.currentCampaign();
  if (!campaign) return res.status(400).json({ error: 'אין כרגע מבצע מתנות' });
  if (!giftService.isOpenForParents(campaign)) {
    return res.status(400).json({ error: 'מועד הבחירה הסתיים. לבירור יש לפנות לגן.' });
  }

  const { group, child, account } = own;
  const childIds = group.years.map(y => y._id);

  const allowed = await giftService.selectablePhotos(childIds, account._id);
  const allowedIds = new Set(allowed.map(p => String(p._id)));

  const requested = Array.isArray(req.body?.photo_ids) ? req.body.photo_ids.map(String) : [];
  const picks = [...new Set(requested)].filter(id => allowedIds.has(id));

  if (picks.length > campaign.picks_required) {
    return res.status(400).json({
      error: `אפשר לבחור עד ${campaign.picks_required} תמונות`,
    });
  }
  if (requested.length !== picks.length) {
    return res.status(400).json({ error: 'אחת התמונות אינה של הילד' });
  }

  const room = child.classroom_id;
  await GiftSelection.findOneAndUpdate(
    { campaign_id: campaign._id, child_id: child._id },
    {
      $set: {
        parent_photo_ids: picks,
        chosen_at: picks.length ? new Date() : null,
        chosen_by_parent: account._id,
        child_name: child.child_name,
        classroom_id: room?._id || room || null,
        classroom_name: room?.name || '',
        classroom_category: nursery.classroomCategory(room) || '',
        branch_id: room?.branch_id || null,
      },
      $setOnInsert: { campaign_id: campaign._id, child_id: child._id },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return res.json({ ok: true, chosen: picks });
}

/** Which fields a parent may edit, so the screen is built from the same list. */
function editableFields(_req, res) {
  return res.json({ editable: EDITABLE });
}


/**
 * GET /api/parent/children/:childId/vacations
 *
 * The year, as this child's branch will actually run it. Read through the same
 * function the office screen uses, so the two can never tell a family different
 * things about whether the gan is open.
 *
 * Only rows from today onwards: a parent opening this in June does not need
 * last September, and burying the next closure under nine past ones is how it
 * gets missed.
 */
async function childVacations(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });

  const branchId = own.child?.branch_id?._id || own.child?.branch_id;
  if (!branchId) return res.json({ entries: [], footer: '' });

  const year = own.child?.academic_year || vacationCalendar.YEAR_5787;
  const calendar = await vacationCalendar.readCalendar(branchId, year);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const upcoming = calendar.entries.filter((e) => e.end >= today);

  res.json({
    academic_year: calendar.academic_year,
    footer: calendar.footer,
    entries: upcoming,
    // Kept so a parent can still reach the whole year deliberately.
    past_count: calendar.entries.length - upcoming.length,
    all: calendar.entries,
  });
}


/**
 * GET /api/parent/children/:childId/supplies
 *
 * What the gan is waiting for. Read-only on purpose: a parent ticking "brought
 * it" from home would leave the shelf empty and the list clean, and the person
 * who can see the shelf is the one in the room.
 */
async function childSupplies(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });

  const { ChildSupplies } = require('../models');
  const suppliesService = require('../services/supplies');

  const row = await ChildSupplies.findOne({ child_id: own.child?._id || req.params.childId }).lean();
  res.json({
    missing: (row?.missing || []).map(suppliesService.decorate),
    note: suppliesService.CATALOGUE_NOTE,
    updated_at: row?.updated_at || null,
  });
}


/**
 * GET /api/parent/children/:childId/gantt
 *
 * The room's plan for a week, and only when the gan has published that week.
 * Default is hidden: these plans were written on the assumption nobody outside
 * the room reads them, and publishing them all at once because a feature
 * shipped is not the gan's decision to have made for it.
 */
async function childGantt(req, res) {
  const own = await loadOwnChild(req);
  if (!own) return res.status(404).json({ error: 'ילד/ה לא נמצא/ה' });

  const { GanttMonth } = require('../models');
  const room = own.child?.classroom_id;
  const branchId = room?.branch_id?._id || room?.branch_id;
  const roomId = room?._id || room;
  if (!branchId || !roomId) return res.json({ visible: false, weeks: [] });

  const date = parentVisibility.normalizeRequestedDate(req.query.date);
  const week = parentVisibility.weekKey(date);
  const state = await parentVisibility.visibilityFor(branchId, week);
  if (!state.gantt) return res.json({ visible: false, week, weeks: [] });

  const [yy, mm] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const doc = await GanttMonth.findOne({
    branch_id: branchId, classroom_id: roomId, year: yy, month: mm,
  }).lean();

  // Only an APPROVED month. A draft is a plan somebody is still arguing about.
  if (!doc || doc.status !== 'approved') return res.json({ visible: true, week, weeks: [] });

  const dates = parentVisibility.weekDates(date);
  const inWeek = (doc.weeks || []).filter((w) => {
    const start = new Date(w.start_date).toISOString().slice(0, 10);
    return dates.includes(start);
  });

  res.json({
    visible: true,
    week,
    dates,
    rows: doc.row_definitions || [],
    weeks: inWeek.map((w) => ({
      topic: w.topic || '',
      cells: (w.cells || []).map((c) => ({
        row_key: c.row_key, day_index: c.day_index, content: c.content || '', color: c.color || '',
      })),
    })),
  });
}

module.exports = {
  // Exported for controllers/parentPayments, which must apply the same
  // ownership test: the child id in the URL is only ever a lookup, and the
  // parent's children are resolved fresh from the enrolment data on every
  // request. A second implementation of that check is a second place for it
  // to be wrong.
  loadOwnChild,
  childDetails, childContracts, contractFile,
  updateChild, startPhoneChange, confirmPhoneChange, editableFields,
  childDay, updateChildDay, addSecondParent,
  childPhotos, uploadChildPhoto,
  childGift, setChildGift,
  childVacations, childSupplies, childGantt,
};
