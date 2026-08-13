const { ParentAccount, Contract, Registration } = require('../models');
const { findParent, contactFromChild } = require('../services/parentDirectory.service');

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
  });
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

module.exports = { childDetails, childContracts, contractFile };
