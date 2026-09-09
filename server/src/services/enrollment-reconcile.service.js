/**
 * הצלבת תמ"ת מול קליקטאק — deciding who is actually enrolled next year.
 *
 * A child may join a gan under משרד התמ"ת only if two independent things are
 * true: the ministry approved them for THIS gan, and the family completed the
 * registration with us in ClickTac. Neither system knows about the other. A
 * family can be approved by the state and never register (they took their
 * first-choice gan, they moved, they changed their mind about the extra
 * services basket), and a family can register with us and never be approved.
 * Either way the child cannot be enrolled and the place has to go to the next
 * in line — which is a decision somebody has to make in July, from two
 * spreadsheets that share nothing but a ת"ז.
 *
 * This file is that comparison, and nothing else: it reads two lists and
 * returns findings. It writes nothing, so it can be run on every page load,
 * and re-run after each new upload, without deciding anything on its own.
 *
 * קפלן is not part of this. It is not under the ministry, its families
 * register directly with us and never appear in ClickTac, so a comparison
 * there would report every single child as an anomaly.
 */

const { normalizeChildName } = require('./academic-year.service');
const { normalizeId, normalizePhone, canonicalAgeGroup, ABSORBED_DECISION } = require('./tmt.service');
const { ageInMonths, ageGroupFor } = require('./clicktac.service');
const { paymentAlertFor, paymentMethodFor } = require('./paymentCheck');
const { tierFeeFor, tierFeesByGroup } = require('./tier-fee.service');

/** ClickTac's own wording for a registration the family withdrew. */
const CANCELLED = 'ביטל רישום';

/**
 * The verdicts, in the order a person deals with them.
 *
 * Order matters: it is the sort order of the screen and of the exported sheet,
 * so the rows that cost money and places sit at the top and the informational
 * ones at the bottom.
 */
const VERDICTS = {
  missing_registration: {
    label: 'אושר בתמ"ת — לא נרשם אצלנו',
    action: 'להתקשר להורים; אם לא ירשמו — המקום מתפנה',
    severity: 'critical',
    rank: 1,
  },
  missing_approval: {
    label: 'נרשם אצלנו — אין אישור תמ"ת',
    action: 'לא ניתן לקלוט. לבדוק מול ההורים ומול משרד התמ"ת',
    severity: 'critical',
    rank: 2,
  },
  withdrawn: {
    label: 'הוסר/ה מרשימת התמ"ת',
    action: 'האישור בוטל בקובץ תמ"ת מאוחר יותר — לוודא מול משרד העבודה',
    severity: 'critical',
    rank: 3,
  },
  cancelled: {
    label: 'ביטל/ה רישום בקליקטאק',
    action: 'לא נקלט/ת. אם היה אישור תמ"ת — המקום התפנה',
    severity: 'critical',
    rank: 4,
  },
  not_approved: {
    label: 'בקובץ תמ"ת ללא אישור',
    action: 'החלטת תמ"ת שאינה אישור — לבדוק מול משרד העבודה',
    severity: 'critical',
    rank: 5,
  },
  approved: {
    label: 'מאושר/ת לשנה הבאה',
    action: 'ניתן לקלוט למערכת',
    severity: 'ok',
    rank: 6,
  },
  /**
   * A person's override: in the gan WITHOUT the ministry.
   *
   * A child with no residency, a family paying in full — never going to be
   * on the ministry's list, and registered in ClickTac all the same. Without
   * this the row is "נרשם — אין אישור תמ"ת" forever and `apply` keeps dropping
   * it from the intake queue. Set from the child's card, kept in
   * ReconcileDecision, and it beats only the two verdicts that mean "the
   * ministry has not approved" — a cancelled or vanished registration is still
   * cancelled or vanished.
   */
  private: {
    label: 'בגן ללא תמ"ת',
    action: 'ילד/ה שלא במסגרת התמ"ת — נקלט/ת כרגיל, ללא סבסוד',
    severity: 'ok',
    rank: 6,
  },
  /**
   * Gone from EVERY list — the ministry's and both of ClickTac's exports.
   *
   * Not a finding: there is nobody left to argue with. The child left, or was
   * never really here (a row of another מעון filed against this branch by
   * mistake). Such rows leave the table and sit under "ארכיון" for thirty
   * days, and are then removed. Ranked last so a caller that does not filter
   * still sees them at the bottom.
   */
  gone: {
    label: 'הוסר/ה מכל הרשימות',
    action: 'לא מופיע/ה עוד באף קובץ — נמחק/ת מהארכיון אחרי 30 יום',
    severity: 'archived',
    rank: 7,
  },
};

/**
 * A finding on a child who exists on both sides but whose data disagrees.
 *
 * `color` is the chip's own colour on the screen, ONE PER CODE. The severity
 * used to decide the colour, which put "ילד רווחה", "שם חלקי" and "טלפון" in
 * the same blue and made a row of three chips unreadable at a glance. The
 * severity still decides the sort and the counters; the colour is the code's.
 */
const ISSUES = {
  id_mismatch: {
    label: 'ת"ז שונה בין הקבצים',
    severity: 'critical',
    color: '#b71c1c',
  },
  branch_mismatch: {
    label: 'אושר/ה בתמ"ת בסניף אחר',
    severity: 'critical',
    color: '#6a1b9a',
  },
  birth_date_mismatch: {
    label: 'תאריך לידה שונה',
    severity: 'warning',
    color: '#ef6c00',
  },
  name_mismatch: {
    label: 'שם שונה',
    severity: 'warning',
    color: '#f9a825',
  },
  name_partial: {
    label: 'שם חלקי (שם אמצעי או משפחה חסר בצד אחד)',
    severity: 'info',
    color: '#9e9d24',
  },
  /**
   * The one the owner wants shouted: a child the ministry funds as פעוט and
   * ClickTac has as תינוק is a child whose fee is wrong on one side, and it
   * is reported to the back office until somebody fixes it.
   */
  age_group_mismatch: {
    label: 'שכבת גיל שונה',
    severity: 'critical',
    color: '#d81b60',
    urgent: true,
  },
  age_group_computed_mismatch: {
    label: 'שכבת הגיל אינה תואמת את תאריך הלידה',
    severity: 'info',
    color: '#ad1457',
  },
  continuing_mismatch: {
    label: 'ילד ממשיך — סימון שונה',
    severity: 'info',
    color: '#0277bd',
  },
  welfare_mismatch: {
    label: 'ילד רווחה — סימון שונה',
    severity: 'info',
    color: '#00838f',
  },
  /**
   * `note` — the fourth, quietest severity: not a problem, a remark. The
   * ministry's contact phone is whatever the parent typed into the state's
   * form; the numbers this gan calls are ClickTac's, which the office can
   * edit. So a mismatch is worth a grey chip and nothing more.
   */
  tmt_contact_unknown: {
    label: 'טלפון תמ"ת שונה מטלפוני ההורים',
    severity: 'note',
    color: '#78909c',
  },
  place_freed: {
    label: 'מקום התפנה — יש אישור תמ"ת והרישום בוטל',
    severity: 'warning',
    color: '#2e7d32',
  },
  needs_absorption_date: {
    label: 'להזין תאריך כניסה לגן בפורטל התמ"ת',
    severity: 'warning',
    color: '#5d4037',
  },
  absorption_date_inconsistent: {
    label: 'החלטת התמ"ת אינה תואמת את תאריך הכניסה',
    severity: 'info',
    color: '#8d6e63',
  },
  tmt_removed: {
    label: 'ירד/ה מרשימת התמ"ת בקובץ מאוחר יותר',
    severity: 'critical',
    color: '#c62828',
  },
  clicktac_removed: {
    label: 'ירד/ה מייצוא הנרשמים של קליקטאק',
    severity: 'critical',
    color: '#e53935',
  },
  contract_removed: {
    label: 'ירד/ה מייצוא החוזים של קליקטאק',
    severity: 'critical',
    color: '#ff7043',
  },
  /**
   * Last year's ClickTac file, uploaded for exactly this: "ממשיך" is a box
   * somebody ticked, and the file from the year before is the fact.
   */
  prev_year_mismatch: {
    label: 'ממשיך — לא תואם לקובץ שנה שעברה',
    severity: 'info',
    color: '#3949ab',
  },
  prev_year_debt: {
    label: 'חוב משנה שעברה',
    severity: 'note',
    color: '#6d4c41',
  },
};

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, note: 3 };

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/**
 * How old the child will be on the day the year opens.
 *
 * The state's age group is a funding bracket, not a placement: a child the
 * ministry calls פעוט can be put in בוגרים if that is where they belong in
 * this gan, and that is the manager's call. But it cannot be made from a
 * birth date alone — "21/10/2024" does not tell anyone whether the child will
 * be walking in September. So the age is spelled out, in years and months and
 * in plain months, next to whatever the two files claim.
 *
 * 1 September, always. Not today, and not the import date: a comparison run in
 * July and again in August must not move a child between groups.
 */
function ageAtYearStart(birthDate, academicYear) {
  if (!birthDate) return null;
  const startYear = Number(String(academicYear).split('-')[0]);
  if (!Number.isFinite(startYear)) return null;
  const at = new Date(Date.UTC(startYear, 8, 1));
  const months = ageInMonths(new Date(birthDate), at);
  if (months == null) return null;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = years === 0 ? '' : years === 1 ? 'שנה' : years === 2 ? 'שנתיים' : `${years} שנים`;
  const monthPart = rest === 0 ? '' : rest === 1 ? 'חודש' : rest === 2 ? 'חודשיים' : `${rest} חודשים`;
  const label = [yearPart, monthPart].filter(Boolean).join(' ו־') || 'פחות מחודש';

  return {
    months,
    years,
    months_remainder: rest,
    // "שנה ו־3 חודשים (15 חודשים)" — the plain month count too, because the
    // group boundaries (15 and 24 months) are counted in months. Under a year
    // the label is already a month count, so it is not repeated.
    label: years > 0 ? `${label} (${months} חודשים)` : label,
    // What the boundaries alone would say. A suggestion, never a decision.
    suggested_group: ageGroupFor(months),
  };
}
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL', { timeZone: 'UTC' }) : '—');
const yesNo = (v) => (v == null ? '—' : (v ? 'כן' : 'לא'));

/**
 * Do two spellings describe the same child?
 *
 * 'same' — identical once punctuation and spacing are normalized.
 * 'partial' — every word of one appears in the other. This is the common case
 *   and it is not an error: the ministry holds "אורי ריצ'רד שידה" where the
 *   parents wrote "אורי שידה", and one of them simply omitted a middle name.
 * 'different' — anything else, which is worth a human's eyes.
 */
function compareNames(a, b) {
  const na = normalizeChildName(a);
  const nb = normalizeChildName(b);
  if (!na || !nb) return 'same';
  if (na === nb) return 'same';
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const contains = (big, small) => [...small].every(w => big.has(w));
  if (contains(wa, wb) || contains(wb, wa)) return 'partial';
  return 'different';
}

/** The child's ת"ז as ClickTac holds it, normalized to the ministry's shape. */
const ctId = (doc) => normalizeId(doc?.child?.id_number);

/**
 * Both parents' phones, for checking the ministry's contact against them —
 * including a phone the office corrected by hand (ReconcileDecision), since
 * "the number we actually call" is the one worth comparing to.
 */
function parentPhones(ct, decision = null) {
  const o = decision?.parent_overrides || {};
  return [ct?.parent1?.phone, ct?.parent2?.phone, o.parent1?.phone, o.parent2?.phone]
    .map(normalizePhone).filter(Boolean);
}

/**
 * What the files said about ONE finding, at this moment.
 *
 * Stored on the resolution when a person closes the finding, and compared
 * on every read: the same snapshot means the answer still holds and the
 * finding stays closed; a different one means a later upload moved the
 * ground and the question is put back in front of a person — marked, not
 * silently re-opened and not silently kept closed.
 *
 * Small on purpose — the two values that disagree, not the two records.
 */
function snapshotFor(issue, tmt, ct, { branchId } = {}) {
  switch (issue.code) {
    case 'name_mismatch':
    case 'name_partial':
      return { tmt: tmt?.child?.full_name || '', ct: ct?.child?.full_name || '' };
    case 'birth_date_mismatch':
      return { tmt: dayKey(tmt?.child?.birth_date), ct: dayKey(ct?.child?.birth_date) };
    case 'id_mismatch':
      return { tmt: tmt?.child?.id_number || '', ct: ct?.child?.id_number || '' };
    case 'age_group_mismatch':
      return { tmt: canonicalAgeGroup(tmt?.child?.age_group), ct: canonicalAgeGroup(ct?.child?.age_group) };
    case 'age_group_computed_mismatch':
      return { computed: ct?.computed?.age_group || '', ct: canonicalAgeGroup(ct?.child?.age_group) };
    case 'continuing_mismatch':
      return { tmt: tmt?.ministry?.continuing ?? null, ct: clicktacContinuing(ct) };
    case 'welfare_mismatch':
      return { tmt: tmt?.ministry?.welfare ?? null, ct: !!ct?.child?.welfare_referred };
    case 'tmt_contact_unknown':
      return { tmt: normalizePhone(tmt?.contact?.phone), parents: parentPhones(ct).sort() };
    case 'branch_mismatch':
      return { tmt_branch: String(tmt?.branch_id?._id || tmt?.branch_id || ''), branch: String(branchId || '') };
    default:
      // The absence findings and the ministry-portal to-dos: the detail text
      // carries the date or the decision, and either moving is a change.
      return { detail: issue.detail || '' };
  }
}

const sameSnapshot = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Findings that are the same QUESTION under two codes.
 *
 * "שם שונה" and "שם חלקי" are one question — whose spelling is right — asked
 * at two strengths, and a file that turns the one into the other has not
 * asked a new question. An answer given to either covers both; whether it
 * still holds is the snapshot's job.
 */
const RESOLUTION_FAMILY = { name_mismatch: 'name', name_partial: 'name' };
const familyOf = (code) => RESOLUTION_FAMILY[code] || code;

/** The two words of a name the office typed: first, and everything after. */
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') };
}

/**
 * The parent as the screen, the export and the promotion should show them:
 * the office's correction where there is one, else the file. `pending` says
 * the correction still differs from the latest file — the reminder to fix it
 * in ClickTac. An override the file has since caught up with is simply done.
 */
function partyWithOverride(party, override) {
  const fileName = `${party?.first_name || ''} ${party?.last_name || ''}`.trim();
  const filePhone = String(party?.phone || '').trim();
  if (!override || (!override.name && !override.phone)) {
    return { name: fileName, phone: filePhone, overridden: false, pending: false };
  }
  const name = override.name || fileName;
  const phone = override.phone || filePhone;
  const pending = (override.name && override.name !== fileName)
    || (override.phone && normalizePhone(override.phone) !== normalizePhone(filePhone));
  return { name, phone, overridden: true, pending: !!pending, file_name: fileName, file_phone: filePhone };
}

/**
 * Is the child still in ClickTac, as far as the LATEST uploads say?
 *
 * Two exports, two flags. `presence.is_present` is the registrations file's
 * ("was the child in the last registrations upload") and `contract.present`
 * is the contracts file's. A child current in EITHER is still registered:
 * the two files list different populations at different moments in the
 * summer, and one of them going quiet is a finding, not a departure. Gone
 * from both is gone.
 *
 * A row that has only ever been in one export is judged by that export alone.
 */
function clicktacLive(ct) {
  if (!ct) return false;
  /**
   * THE LATEST FILE IS THE TRUTH — that is the owner's rule, stated on
   * 09.09.2026 over two cancelled children who stayed "התקבל" because they
   * had only ever been in an older registrations export and the newer
   * contracts export "had nothing to say" about them. It does: the contracts
   * export is the roster of everyone with a signed agreement, and a child
   * not in it is not enrolled. So `presence.is_present` now means "in the
   * most recent ClickTac upload, whichever file", and it alone decides.
   * `contract.present` stays as the finer fact for the contracts half.
   */
  return ct.presence?.is_present !== false;
}

/** ClickTac's own "ממשיך" — the registrations file's flag, else the contract's. */
function clicktacContinuing(ct) {
  if (!ct) return null;
  const sources = ct.sources?.length ? ct.sources : ['registrations'];
  if (sources.includes('registrations')) return !!ct.enrollment?.continuing;
  if (ct.contract && ct.contract.continuing != null) return !!ct.contract.continuing;
  return null;
}

/**
 * תנאי התשלום — what the office reads before it phones a family, and nothing
 * a bank account could be emptied with.
 *
 * WHAT TRAVELS AND WHAT DOES NOT. The bank sub-document IS read on this path —
 * `paymentAlert` cannot tell a complete הו"ק from one still waiting on the
 * details without it — and it stops here: the standing order leaves as ONE
 * WORD, קיימת or חסרה. A list of sixty children is not a place an account
 * number belongs, and the single-record dialog fetches its own copy for the
 * one case where somebody actually has to file it. See the select() note in
 * tmtApproval.controller#buildReconciliation.
 *
 * WHY THE METHODS ARE CARRIED RAW. `payment_method_kind` is the colour and it
 * is deliberately coarse — five kinds over free text the vendor changes at
 * will. These two fields are what the file literally said, which is what the
 * office has to see when it disagrees with the colour, and דמי רישום has no
 * chip at all: it is a second, separate payment, usually on a different card.
 *
 * Null for a row that has only ever been in the contracts export. That file
 * has no payment columns, so "no terms" there is a fact about which upload has
 * happened and not about the family — the same rule paymentMethodFor applies,
 * and it is reused rather than restated.
 */
function paymentTermsFor(ct) {
  if (!ct || !paymentMethodFor(ct)) return null;
  const e = ct.enrollment || {};
  const so = ct.standing_order || {};
  // Both halves or nothing: a הו"ק cannot be filed with either one missing,
  // which is the same test paymentAlert makes.
  const hasBank = !!String(so.bank || '').trim() && !!String(so.account || '').trim();
  const wantsStandingOrder = paymentMethodFor(ct)?.kind === 'standing_order';
  return {
    // שכ"ל — the recurring money.
    tuition_method: String(e.tuition_method || '').trim(),
    tuition_card_last4: String(e.tuition_card_last4 || '').trim(),
    // דמי רישום — the one-off, with the receipt that proves it was taken.
    registration_fee_method: String(e.registration_fee_method || '').trim(),
    registration_fee_card_last4: String(e.registration_fee_card_last4 || '').trim(),
    // The file's generic "סכום תשלום" column — not necessarily דמי רישום.
    // ClickTac has no column that says which payment this amount belongs to,
    // so this is reported on its own line and never folded into the
    // registration-fee line above it.
    amount_in_file: Number(e.amount || 0) || 0,
    receipt_number: String(e.receipt_number || '').trim(),
    voucher_number: String(e.voucher_number || '').trim(),
    /**
     * 'complete' / 'missing' / '' — never the bank fields themselves.
     *
     * Empty for a family that is not on a standing order at all and never
     * filled the columns in: saying "חסרה" about them would read as a problem
     * with a family that does not have one and does not need one.
     */
    standing_order_status: (wantsStandingOrder || hasBank)
      ? (hasBank ? 'complete' : 'missing')
      : '',
    continuing: !!e.continuing,
    second_signer: String(e.second_signer || '').trim(),
  };
}

/**
 * Compare one child's two records and list what disagrees.
 *
 * Only called when the child is on both sides — a child missing from one list
 * has one finding (the absence) and comparing fields would bury it.
 */
function issuesFor(tmt, ct, { branchId, matchedBy = 'id', decision = null } = {}) {
  const found = [];
  const add = (code, detail) => found.push({ code, detail, ...ISSUES[code] });

  // Joined by name and birth date because the two files carry two different
  // ת"ז — one of them is a typo, and it is the ministry's copy that will be
  // checked against the population registry. Reported first: it is the one
  // finding on this row that a re-upload cannot fix by itself.
  if (tmt && ct && matchedBy === 'name_birth') {
    add('id_mismatch', `תמ"ת ${tmt.child?.id_number || '—'} · קליקטאק ${ct.child?.id_number || '—'}`);
  }

  if (tmt && String(tmt.branch_id?._id || tmt.branch_id) !== String(branchId)) {
    add('branch_mismatch', `אישור התמ"ת רשום על סניף ${tmt.branch_name || 'אחר'}`);
  }
  if (tmt && tmt.presence?.is_present === false) {
    add('tmt_removed', `הופיע/ה ברשימה עד ${fmtDate(tmt.presence.missing_since)}, ואינו/ה בקובץ האחרון`);
  }
  // Each ClickTac export reports its own absence — and only for a row that
  // has been in it. Both together are not two findings on a child who left;
  // that child is `gone` and is not on the table at all (see reconcile()).
  if (ct) {
    const sources = ct.sources?.length ? ct.sources : ['registrations'];
    if (ct.presence?.is_present === false) {
      add('clicktac_removed', `הופיע/ה בקליקטאק עד ${fmtDate(ct.presence.missing_since)}, ואינו/ה בקובץ האחרון`);
    } else if (sources.includes('contracts') && ct.contract && ct.contract.present === false) {
      // Still in ClickTac (a newer registrations file lists the child) but
      // dropped from the contracts roster — the agreement went, not the family.
      add('contract_removed', `הופיע/ה בקובץ החוזים עד ${fmtDate(ct.contract.missing_since)}, ואינו/ה בקובץ החוזים האחרון`);
    }
  }

  if (tmt && ct) {
    const tb = dayKey(tmt.child?.birth_date);
    const cb = dayKey(ct.child?.birth_date);
    if (tb && cb && tb !== cb) {
      add('birth_date_mismatch', `תמ"ת ${fmtDate(tmt.child.birth_date)} · קליקטאק ${fmtDate(ct.child.birth_date)}`);
    }

    const nameVerdict = compareNames(tmt.child?.full_name, ct.child?.full_name);
    if (nameVerdict === 'different') {
      add('name_mismatch', `תמ"ת "${tmt.child.full_name}" · קליקטאק "${ct.child.full_name}"`);
    } else if (nameVerdict === 'partial') {
      add('name_partial', `תמ"ת "${tmt.child.full_name}" · קליקטאק "${ct.child.full_name}"`);
    }

    const tg = canonicalAgeGroup(tmt.child?.age_group);
    const cg = canonicalAgeGroup(ct.child?.age_group);
    if (tg && cg && tg !== cg) {
      add('age_group_mismatch', `תמ"ת ${tmt.child.source_age_group || tg} · קליקטאק ${cg}`);
    }

    // The computed group is the arithmetic on the birth date. It disagreeing
    // with both files usually means the birth date itself is wrong — which is
    // why it is reported next to the date mismatch rather than instead of it.
    const computed = ct.computed?.age_group;
    if (computed && cg && computed !== cg) {
      add('age_group_computed_mismatch', `לפי תאריך הלידה ${computed} · קליקטאק ${cg}`);
    }

    const ctContinuing = clicktacContinuing(ct);
    if (tmt.ministry?.continuing != null && ctContinuing != null
      && tmt.ministry.continuing !== ctContinuing) {
      add('continuing_mismatch', `תמ"ת ${yesNo(tmt.ministry.continuing)} · קליקטאק ${yesNo(ctContinuing)}`);
    }

    if (tmt.ministry?.welfare != null && tmt.ministry.welfare !== !!ct.child?.welfare_referred) {
      add('welfare_mismatch', `תמ"ת ${yesNo(tmt.ministry.welfare)} · קליקטאק ${yesNo(!!ct.child?.welfare_referred)}`);
    }

    // Only when there ARE parent phones to compare against. A row whose
    // family has not been uploaded yet has no phones, and "the ministry's
    // number belongs to nobody" would then be true of every child — which is
    // exactly what happened for the contracts-only rows of 09.2026.
    const phone = normalizePhone(tmt.contact?.phone);
    const known = parentPhones(ct, decision);
    if (phone && known.length && !known.includes(phone)) {
      add('tmt_contact_unknown', `${tmt.contact.name || 'איש קשר תמ"ת'} · ${tmt.contact.phone}`);
    }
  }


  /**
   * התקבל vs נקלט במעון.
   *
   * Both are approvals; the difference is a task of ours. A child is נקלט only
   * once somebody enters their תאריך כניסה לגן in the ministry's portal, and
   * until that is done the row reads התקבל with the date blank. So an approved
   * child with no entry date is a line on a to-do list, not an anomaly in the
   * data — and the wording disagreeing with the date is worth saying out loud,
   * because one of the two was then entered by hand somewhere.
   */
  if (tmt?.ministry?.is_approved && tmt.presence?.is_present !== false) {
    const hasDate = !!tmt.ministry.absorbed_at;
    const saysAbsorbed = tmt.ministry.decision === ABSORBED_DECISION;
    if (!hasDate) {
      add('needs_absorption_date', saysAbsorbed
        ? 'ההחלטה "נקלט במעון" אך תאריך הכניסה ריק'
        : 'אושר/ה בתמ"ת — נותר להזין תאריך כניסה לגן');
    } else if (!saysAbsorbed) {
      add('absorption_date_inconsistent',
        `יש תאריך כניסה ${fmtDate(tmt.ministry.absorbed_at)} אך ההחלטה "${tmt.ministry.decision}"`);
    }
  }

  // NOTE: a second signer still waiting on ClickTac used to raise an
  // 'unsigned' finding here. The owner does not consider it relevant — the
  // raw second_signer value still rides on the row (clicktac.second_signer,
  // and in payment_terms.second_signer) for anyone who wants to look, but it
  // is informational only and no longer surfaces as an anomaly, a chip, or a
  // counter.

  return found;
}

/**
 * Which verdict this pair of records adds up to.
 *
 * An approval belongs to one מעון. A child approved at משה דיין who registered
 * at כפר סבא has no approval HERE, so this branch cannot enroll them — the
 * verdict is the same as having no approval at all, and the branch_mismatch
 * issue is what says where the approval actually is.
 */
function verdictFor(tmt, ct, { branchId, decision = null } = {}) {
  const base = baseVerdictFor(tmt, ct, { branchId });
  // The office's override beats exactly the two verdicts that mean "the
  // ministry has not approved" — see VERDICTS.private.
  if (decision?.verdict_override?.kind === 'private'
    && (base === 'missing_approval' || base === 'not_approved')) return 'private';
  return base;
}

function baseVerdictFor(tmt, ct, { branchId } = {}) {
  const ownApproval = !!tmt && (!branchId
    || String(tmt.branch_id?._id || tmt.branch_id) === String(branchId));
  // A name the ministry dropped from a later file is not an approval any more,
  // whatever the decision on the row still says.
  const approvalLive = ownApproval && tmt.presence?.is_present !== false;
  // Same on our side: a row that vanished from BOTH later exports is not a
  // registration. It is NOT the same as ביטל רישום — a cancelled family is
  // still in the file, with a status. See clicktacLive.
  const registrationLive = clicktacLive(ct);

  // Nobody lists the child any more — the ministry dropped them (or never
  // had them) AND ClickTac dropped them (or never had them). One list still
  // naming the child keeps the row on the table, as the finding it is.
  const tmtLists = !!tmt && tmt.presence?.is_present !== false;
  if (!tmtLists && !registrationLive) return 'gone';

  if (ownApproval && !approvalLive) return 'withdrawn';
  if (ct?.enrollment?.status === CANCELLED) return 'cancelled';
  if (!approvalLive) return ct ? 'missing_approval' : 'missing_registration';
  if (!tmt.ministry?.is_approved) return 'not_approved';
  if (!registrationLive) return 'missing_registration';
  return 'approved';
}

/**
 * The whole comparison for one branch and one year.
 *
 * `tmtDocs` and `ctDocs` are plain objects straight out of Mongo. The branch
 * is passed separately because a TmtApproval from ANOTHER branch may be handed
 * in deliberately — that is how a child approved at משה דיין but registered at
 * כפר סבא is caught, and it is a real thing that happens when a family applies
 * to two of the network's gans.
 */
function reconcile({
  tmtDocs = [], ctDocs = [], branchId, academicYear, branchName = '',
  // The branch's price matrix, when the caller loaded one. Optional on
  // purpose: this function is pure and the fee is one more derived column, so
  // a caller that has no matrix (or does not care) gets rows with a null
  // `fee_by_tier` rather than an exception.
  pricing = null,
  /**
   * What people decided about these children — ReconcileDecision rows for
   * the branch and year, as a Map keyed by the ministry-shaped ת"ז. Optional
   * like `pricing`: without it every finding is open and every verdict is
   * the files' own.
   */
  decisions = null,
  /**
   * Last year's ClickTac rows for the same branch, when that file has been
   * uploaded — ExternalEnrollment docs of `academic_year` = the year before.
   * `null` when no such upload exists; then nothing is said about last year.
   */
  prevYearDocs = null,
  prevYear = '',
}) {
  const prevById = new Map();
  for (const p of prevYearDocs || []) {
    const id = ctId(p);
    if (id) prevById.set(id, p);
  }
  const prevLoaded = Array.isArray(prevYearDocs) && prevYearDocs.length > 0;
  const decisionFor = (...ids) => {
    if (!decisions) return null;
    for (const id of ids) if (id && decisions.get(id)) return decisions.get(id);
    return null;
  };
  const tmtById = new Map();
  for (const t of tmtDocs) {
    const id = normalizeId(t.child?.id_number);
    if (id) tmtById.set(id, t);
  }
  const ctById = new Map();
  for (const c of ctDocs) {
    const id = ctId(c);
    if (id) ctById.set(id, c);
  }

  /**
   * THE SECOND PASS — name and birth date, over whoever the ת"ז did not join.
   *
   * אלי רדומסקי, 09.2026: 241037043 in the ministry's list, 041291725 in
   * ClickTac, born 12.04.2024 in both. One of the two numbers is a typo. The
   * ת"ז-only join produced two red rows — "approved, not registered" and
   * "registered, not approved" — and `apply` then dropped the ClickTac row
   * from the intake queue on the strength of the second. So the leftovers of
   * the first pass are joined by the child's name and birthday, and the pair
   * is reported ONCE with an id_mismatch finding that says which number is
   * which.
   *
   * Name+birth is the same rule the importer uses to merge the two ClickTac
   * exports (findMergeTarget), and for the same reason it is a fallback and
   * not the rule: two children can share both. Here the ids are known to
   * differ by construction, so the guard is the exact name, not the partial
   * one — a middle name dropped on one side is common, but a different ת"ז
   * AND a looser name is too much doubt to merge on.
   */
  const pairs = [];
  const joined = new Set();
  for (const id of tmtById.keys()) {
    if (ctById.has(id)) { pairs.push({ id, tmt: tmtById.get(id), ct: ctById.get(id), by: 'id' }); joined.add(id); }
  }
  const nameKey = (child) => `${normalizeChildName(child?.full_name || '')}|${dayKey(child?.birth_date)}`;
  const looseCt = new Map();
  for (const [id, c] of ctById) {
    if (joined.has(id)) continue;
    const key = nameKey(c.child);
    if (!c.child?.full_name || !c.child?.birth_date) continue;
    // Two ClickTac rows with the same name and birthday are twins or a
    // duplicate — either way not a safe target. Mark the key ambiguous.
    looseCt.set(key, looseCt.has(key) ? null : { id, ct: c });
  }
  for (const [id, t] of tmtById) {
    if (joined.has(id)) continue;
    const hit = t.child?.full_name && t.child?.birth_date ? looseCt.get(nameKey(t.child)) : null;
    if (hit && !joined.has(hit.id)) {
      // The row is keyed by the ministry's ת"ז: it is the state's number and
      // the one the export sheets are checked against.
      pairs.push({ id, tmt: t, ct: hit.ct, by: 'name_birth' });
      joined.add(id);
      joined.add(hit.id);
    } else {
      pairs.push({ id, tmt: t, ct: null, by: 'id' });
      joined.add(id);
    }
  }
  for (const [id, c] of ctById) {
    if (joined.has(id)) continue;
    pairs.push({ id, tmt: null, ct: c, by: 'id' });
    joined.add(id);
  }

  const rows = [];
  const archived = [];

  for (const { id, tmt, ct, by } of pairs) {
    // A decision is keyed by the row's own id; a row joined by name+birth
    // may have been decided under ClickTac's number before the join existed.
    const decision = decisionFor(id, ct ? ctId(ct) : null);
    const verdict = verdictFor(tmt, ct, { branchId, decision });
    let issues = issuesFor(tmt, ct, { branchId, matchedBy: by, decision });

    /**
     * LAST YEAR, when its file is here. Was the child with us, and did they
     * leave money on the table. Matched by ת"ז against last year's rows —
     * the same key as everything else.
     */
    const prev = prevLoaded ? (prevById.get(id) || (ct ? prevById.get(ctId(ct)) : null) || null) : null;
    const prevYearInfo = prevLoaded ? {
      year: prevYear,
      present: !!prev,
      status: prev?.enrollment?.status || prev?.contract?.status || '',
      class_name: prev?.contract?.class_name || '',
      balance: prev?.contract?.balance ?? null,
      family_balance: prev?.contract?.family_balance ?? null,
    } : null;
    if (prevYearInfo && ct) {
      const says = clicktacContinuing(ct);
      if (says != null && says !== prevYearInfo.present) {
        issues.push({
          code: 'prev_year_mismatch', ...ISSUES.prev_year_mismatch,
          detail: `קליקטאק: ${says ? 'ממשיך/ה' : 'רישום חדש'} · בקובץ ${prevYear}: ${prevYearInfo.present ? 'היה/תה' : 'לא היה/תה'}`,
        });
      }
      if (typeof prevYearInfo.balance === 'number' && prevYearInfo.balance < 0) {
        issues.push({
          code: 'prev_year_debt', ...ISSUES.prev_year_debt,
          detail: `₪${(-prevYearInfo.balance).toLocaleString('he-IL')} לפי קובץ ${prevYear}`,
        });
      }
    }
    for (const i of issues) i.snapshot = snapshotFor(i, tmt, ct, { branchId });

    /**
     * FINDINGS A PERSON CLOSED. Hidden while the files still say what they
     * said when the answer was given; back on the table — marked — the moment
     * a later upload changes the underlying values. See snapshotFor.
     */
    const resolved = [];
    if (decision?.resolutions?.length) {
      const byCode = new Map(decision.resolutions.map(r => [familyOf(r.code), r]));
      issues = issues.filter((i) => {
        const r = byCode.get(familyOf(i.code));
        if (!r) return true;
        const brief = { choice: r.choice, value: r.value, note: r.note, by_name: r.by_name, at: r.at };
        if (sameSnapshot(i.snapshot, r.snapshot)) {
          resolved.push({ ...i, resolution: brief });
          return false;
        }
        i.resolution = brief;
        i.changed_since_resolved = true;
        i.detail = `השתנה מאז שנסגר ב־${fmtDate(r.at)} · ${i.detail || ''}`.trim();
        return true;
      });
    }

    // The name a person chose, where the two files disagreed.
    const nameChoice = decision?.resolutions?.find(r => (r.code === 'name_mismatch' || r.code === 'name_partial') && r.choice !== 'ok');
    const chosenName = !nameChoice ? ''
      : nameChoice.choice === 'tmt' ? (tmt?.child?.full_name || '')
        : nameChoice.choice === 'clicktac' ? (ct?.child?.full_name || '')
          : (nameChoice.value || '');
    const parent1 = ct ? partyWithOverride(ct.parent1, decision?.parent_overrides?.parent1) : null;
    const parent2 = ct ? partyWithOverride(ct.parent2, decision?.parent_overrides?.parent2) : null;

    // A cancelled registration whose ministry approval still stands is the one
    // case where the anomaly is an opportunity: the state has allocated a place
    // to this gan and the family walked away from it.
    if (verdict === 'cancelled' && tmt?.ministry?.is_approved && tmt.presence?.is_present !== false) {
      issues.unshift({ code: 'place_freed', detail: `אישור תמ"ת מ־${fmtDate(tmt.ministry.absorbed_at) !== '—' ? fmtDate(tmt.ministry.absorbed_at) : tmt.ministry.decision}`, ...ISSUES.place_freed });
    }

    issues.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    const worst = issues.some(i => i.severity === 'critical') ? 'critical'
      : issues.some(i => i.severity === 'warning') ? 'warning'
        : issues.some(i => i.severity === 'info') ? 'info'
          : issues.length ? 'note' : 'ok';

    // When the child left every list, the ONLY thing worth knowing is when.
    // The latest "gone" date of the lists they were on.
    const goneSince = verdict === 'gone'
      ? [tmt?.presence?.missing_since, ct?.presence?.missing_since, ct?.contract?.missing_since]
        .filter(Boolean).map(d => new Date(d).getTime()).reduce((a, b) => Math.max(a, b), 0) || null
      : null;

    (verdict === 'gone' ? archived : rows).push({
      id_number: id,
      matched_by: by,
      // For the archive filter and the 30-day purge.
      gone_since: goneSince ? new Date(goneSince) : null,
      urgent: issues.some(i => i.urgent),
      child_name: chosenName || ct?.child?.full_name || tmt?.child?.full_name || '',
      name_source: chosenName ? nameChoice.choice : '',
      // Findings closed by a person — off the table, listed on the card.
      resolved_issues: resolved,
      /**
       * What the office decided about this child, for the card. Never the
       * whole document: the ids of who decided are not the screen's business,
       * the names are.
       */
      decision: decision ? {
        note: decision.note || '',
        verdict_override: decision.verdict_override?.kind ? {
          kind: decision.verdict_override.kind,
          reason: decision.verdict_override.reason || '',
          by_name: decision.verdict_override.by_name || '',
          at: decision.verdict_override.at || null,
        } : null,
        parent_overrides: (parent1?.overridden || parent2?.overridden) ? {
          by_name: decision.parent_overrides?.by_name || '',
          at: decision.parent_overrides?.at || null,
          pending: !!(parent1?.pending || parent2?.pending),
        } : null,
      } : null,
      has_note: !!decision?.note,
      // Null until last year's file is uploaded. See prevYearDocs.
      prev_year: prevYearInfo,
      // ClickTac first, on every identity field: it is the file the office can
      // CORRECT, and a correction made there has to show up here at once —
      // the ministry's copy is the comparison, reported as a finding where it
      // still disagrees. (It used to be the other way round, on the argument
      // that the state's record is the state's own; the owner overruled that
      // on 09.09.2026 when a birth date fixed in ClickTac did not move.)
      birth_date: ct?.child?.birth_date || tmt?.child?.birth_date || null,
      age_group: canonicalAgeGroup(ct?.child?.age_group || tmt?.child?.age_group || ''),
      computed_age_group: ct?.computed?.age_group || '',
      // Same rule as birth_date above: ClickTac's date, the ministry's as the
      // comparison.
      age_at_year_start: ageAtYearStart(
        ct?.child?.birth_date || tmt?.child?.birth_date, academicYear,
      ),
      age_source: ct?.child?.birth_date ? 'קליקטאק' : (tmt?.child?.birth_date ? 'תמ"ת' : ''),
      // The manager's own decision, when one has been made. It beats both files.
      age_group_override: ct?.placement?.age_group_override || '',
      verdict,
      verdict_label: VERDICTS[verdict].label,
      verdict_action: VERDICTS[verdict].action,
      verdict_severity: VERDICTS[verdict].severity,
      rank: VERDICTS[verdict].rank,
      issue_severity: worst,
      issues,

      in_tmt: !!tmt,
      in_clicktac: !!ct,

      tmt: tmt ? {
        id: tmt._id,
        full_name: tmt.child?.full_name || '',
        birth_date: tmt.child?.birth_date || null,
        age_group: tmt.child?.source_age_group || tmt.child?.age_group || '',
        decision: tmt.ministry?.decision || '',
        is_approved: !!tmt.ministry?.is_approved,
        continuing: tmt.ministry?.continuing,
        welfare: tmt.ministry?.welfare,
        absorbed_at: tmt.ministry?.absorbed_at || null,
        contact_name: tmt.contact?.name || '',
        contact_phone: tmt.contact?.phone || '',
        contact_email: tmt.contact?.email || '',
        branch_name: tmt.branch_name || branchName,
        is_present: tmt.presence?.is_present !== false,
        missing_since: tmt.presence?.missing_since || null,
        changes: tmt.changes || [],
      } : null,

      clicktac: ct ? {
        id: ct._id,
        // ClickTac's own number, as stored — the row is keyed by the
        // ministry's when the two differ (see the second pass).
        id_number_raw: ct.child?.id_number || '',
        full_name: ct.child?.full_name || '',
        birth_date: ct.child?.birth_date || null,
        age_group: ct.child?.age_group || '',
        status: ct.enrollment?.status || '',
        second_signer: ct.enrollment?.second_signer || '',
        continuing: !!ct.enrollment?.continuing,
        registered_at: ct.enrollment?.registered_at || null,
        review_status: ct.review?.status || 'pending',
        classroom_id: ct.placement?.classroom_id || null,
        imported_registration_id: ct.review?.imported_registration_id || null,
        // The office's correction where there is one — see partyWithOverride.
        parent1_name: parent1.name,
        parent1_phone: parent1.phone,
        parent1_email: ct.parent1?.email || '',
        parent1_override: parent1.overridden ? parent1 : null,
        parent2_name: parent2.name,
        parent2_phone: parent2.phone,
        parent2_email: ct.parent2?.email || '',
        parent2_override: parent2.overridden ? parent2 : null,
        address: ct.parent1?.address || ct.parent2?.address || '',
        is_present: ct.presence?.is_present !== false,
        missing_since: ct.presence?.missing_since || null,
        // The contracts file's own presence — see clicktacLive.
        contract_present: !ct.contract || ct.contract.present !== false,
        contract_missing_since: ct.contract?.missing_since || null,
        live: clicktacLive(ct),
        /**
         * The child's account in ClickTac, from the wider contracts export.
         * Negative is a debt. Null when the file did not carry it.
         */
        balance: ct.contract?.balance ?? null,
        family_balance: ct.contract?.family_balance ?? null,
        tuition_amount: ct.contract?.tuition_amount ?? null,
        continuing_contract: ct.contract?.continuing ?? null,

        /**
         * WHICH ClickTac export this child has actually been in, and what the
         * contracts export said.
         *
         * `missing_parents` is the one the screen acts on: a row that has only
         * ever been in the contracts export has a class and a דרגה and not one
         * parent, cannot be promoted, and looks identical to a complete row
         * until somebody tries. Rows written before the contracts export was
         * supported have no `sources` at all and are registrations rows by
         * construction — an empty list therefore reads as ['registrations'],
         * the same reading the importer applies.
         */
        sources: ct.sources?.length ? ct.sources : ['registrations'],
        // The same test `hasParents` applies in externalEnrollment.controller:
        // been in the registrations export, OR a parent phone arrived with the
        // (wider, September 2026) contracts export.
        missing_parents: !(ct.sources?.length ? ct.sources : ['registrations']).includes('registrations')
          && !String(ct.parent1?.phone || ct.parent2?.phone || '').trim(),
        /**
         * איך המשפחה משלמת — ומה צריך טיפול.
         *
         * `payment_method` is ClickTac's own free text, carried raw so the
         * screen can show WHAT the file said rather than only that something
         * is wrong with it. `payment_alert` is the verdict on it — cash (which
         * the gan does not accept), no method at all, or a הו"ק the bank
         * details never arrived for.
         *
         * Recomputed here rather than read from `computed.payment_alert`: the
         * stored copy is an index for counting, and rows imported before the
         * check existed do not have one. See services/paymentCheck.js.
         */
        payment_method: String(ct.enrollment?.tuition_method || '').trim(),
        /**
         * The method NAMED — `{ kind, label }`, or null for a row that has
         * only ever been in the contracts export and therefore has no payment
         * column behind it at all.
         *
         * This is what the screen colours by. `payment_alert` below is still
         * only the families to chase; most rows have no alert and every row
         * has a method, and "how does this family pay" is a question the
         * office reads off the table rather than opens a record for.
         */
        payment_method_kind: paymentMethodFor(ct),
        payment_alert: paymentAlertFor(ct),
        /**
         * תנאי התשלום, in full — שכ"ל, דמי רישום, קבלה, שובר, הו"ק כן/לא.
         *
         * The chip above is one colour and it answers one question. This is
         * what the office actually has to know before it calls: which card the
         * שכ"ל sits on, whether the registration fee was taken and against what
         * receipt, and whether the standing order exists at all. It was in the
         * file from the first upload and no screen ever showed it. Bank fields
         * excluded by construction — see paymentTermsFor.
         */
        payment_terms: paymentTermsFor(ct),
        class_name: ct.contract?.class_name || '',
        // The subsidy bracket the whole fee hangs on — the number that was in
        // neither file until the contracts export was accepted.
        tier: ct.contract?.tier || '',
        /**
         * What that bracket actually costs this child, off the branch's matrix.
         *
         * The tier alone is a number nobody can act on; "דרגה 4" means nothing
         * without the matrix in front of you. This is the fee the child will
         * be billed when they are promoted (promoteOne prices from the same
         * two functions), shown here so the office sees it before it commits
         * rather than after. Null when there is no tier, no matrix, or no cell
         * — all three of which mean a person still has to choose.
         */
        fee_by_tier: tierFeeFor({
          pricing,
          tier: ct.contract?.tier,
          ageGroup: ct.placement?.age_group_override || ct.computed?.age_group || ct.child?.age_group,
        })?.fee ?? null,
        /**
         * The SAME tier priced in all three age groups.
         *
         * `fee_by_tier` above is one number, worked out from the group this
         * child is in right now — and on the placement board the manager can
         * move the child into a room of another group, at which point the
         * confirm bills the new group and the number on screen was a promise
         * about the old one. The whole line travels instead, so the screen can
         * re-read it from whichever room is selected and show what will
         * actually be charged. Nulls where the matrix has no cell.
         */
        fees_by_group: tierFeesByGroup({ pricing, tier: ct.contract?.tier }),
        tuition_type: ct.contract?.tuition_type || '',
        contract_start: ct.contract?.start_date || null,
        contract_end: ct.contract?.end_date || null,
      } : null,
    });
  }

  // Anomalies first, then by name — the screen is a work queue, not a register.
  rows.sort((a, b) => a.rank - b.rank
    || a.child_name.localeCompare(b.child_name, 'he'));
  archived.sort((a, b) => (b.gone_since?.getTime() || 0) - (a.gone_since?.getTime() || 0));

  const by = (fn) => rows.filter(fn).length;
  const issueCounts = {};
  for (const r of rows) {
    for (const i of r.issues) issueCounts[i.code] = (issueCounts[i.code] || 0) + 1;
  }

  return {
    academic_year: academicYear,
    branch_id: branchId,
    branch_name: branchName,
    rows,
    // Children gone from every list — off the table, kept for thirty days.
    archived,
    summary: {
      total: rows.length,
      archived: archived.length,
      urgent: by(r => r.urgent),
      balance_due: by(r => typeof r.clicktac?.balance === 'number' && r.clicktac.balance < 0),
      private: by(r => r.verdict === 'private'),
      with_notes: by(r => r.has_note),
      resolved: rows.reduce((n, r) => n + (r.resolved_issues?.length || 0), 0),
      // Findings a person closed and a later file reopened — the ones to look at first.
      reopened: by(r => r.issues.some(i => i.changed_since_resolved)),
      parent_fixes_pending: by(r => r.decision?.parent_overrides?.pending),
      // Last year's file: whether it is here, and who still owes from it.
      prev_year_loaded: prevLoaded,
      prev_year: prevYear,
      prev_year_rows: prevLoaded ? prevYearDocs.length : 0,
      prev_year_debtors: by(r => typeof r.prev_year?.balance === 'number' && r.prev_year.balance < 0),
      prev_year_returning: by(r => r.prev_year?.present),
      approved: by(r => r.verdict === 'approved'),
      missing_registration: by(r => r.verdict === 'missing_registration'),
      missing_approval: by(r => r.verdict === 'missing_approval'),
      cancelled: by(r => r.verdict === 'cancelled'),
      not_approved: by(r => r.verdict === 'not_approved'),
      withdrawn: by(r => r.verdict === 'withdrawn'),
      // Approved AND clean — the number that can be imported without a decision.
      clean: by(r => r.verdict === 'approved' && r.issue_severity === 'ok'),
      with_issues: by(r => r.verdict === 'approved' && r.issue_severity !== 'ok'),
      places_freed: by(r => r.issues.some(i => i.code === 'place_freed')),
      // Approved children still waiting for an entry date in the ministry's
      // portal — a work list rather than a problem.
      needs_absorption_date: by(r => r.issues.some(i => i.code === 'needs_absorption_date')),
      absorbed: by(r => r.tmt?.is_approved && r.tmt?.absorbed_at),
      in_tmt: by(r => r.in_tmt),
      in_clicktac: by(r => r.in_clicktac),
      already_imported: by(r => r.clicktac?.review_status === 'imported'),
      placed_by_hand: by(r => !!r.age_group_override),
      // Registered in ClickTac's contracts export and nowhere else — the work
      // list that says "upload the registrations export too", not "call these
      // families", because there is nobody to call yet.
      missing_parents: by(r => !!r.clicktac?.missing_parents),
      // מזומן / לא הוגדר / הו"ק ללא בנק — families to call before September.
      // Counted over the same rows as every other counter here, so the card
      // and the chip agree with what filtering on it actually shows.
      //
      // ERRORS ONLY. A cheque is now an alert as well, and a soft one: the gan
      // accepts cheques and would simply rather not. Counting it here would
      // grow the "לטיפול" number by families nobody has to phone, which is how
      // a work list stops being worked.
      payment_alerts: by(r => r.clicktac?.payment_alert?.severity === 'error'),
      // The soft half, on its own number — today that is the cheques.
      payment_warnings: by(r => r.clicktac?.payment_alert?.severity === 'warning'),
      with_contract: by(r => !!r.clicktac?.class_name || !!r.clicktac?.tier),
      issues: issueCounts,
    },
  };
}

module.exports = {
  reconcile, compareNames, issuesFor, verdictFor, ageAtYearStart, paymentTermsFor,
  clicktacLive, clicktacContinuing, snapshotFor, partyWithOverride, splitName, familyOf,
  VERDICTS, ISSUES, CANCELLED,
};
