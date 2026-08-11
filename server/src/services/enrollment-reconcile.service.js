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
};

/** A finding on a child who exists on both sides but whose data disagrees. */
const ISSUES = {
  branch_mismatch: {
    label: 'אושר/ה בתמ"ת בסניף אחר',
    severity: 'critical',
  },
  birth_date_mismatch: {
    label: 'תאריך לידה שונה',
    severity: 'warning',
  },
  name_mismatch: {
    label: 'שם שונה',
    severity: 'warning',
  },
  name_partial: {
    label: 'שם חלקי (שם אמצעי או משפחה חסר בצד אחד)',
    severity: 'info',
  },
  age_group_mismatch: {
    label: 'שכבת גיל שונה',
    severity: 'warning',
  },
  age_group_computed_mismatch: {
    label: 'שכבת הגיל אינה תואמת את תאריך הלידה',
    severity: 'info',
  },
  continuing_mismatch: {
    label: 'ילד ממשיך — סימון שונה',
    severity: 'info',
  },
  welfare_mismatch: {
    label: 'ילד רווחה — סימון שונה',
    severity: 'info',
  },
  unsigned: {
    label: 'טרם נחתם בקליקטאק',
    severity: 'warning',
  },
  tmt_contact_unknown: {
    label: 'טלפון תמ"ת אינו של אף אחד מההורים',
    severity: 'info',
  },
  place_freed: {
    label: 'מקום התפנה — יש אישור תמ"ת והרישום בוטל',
    severity: 'warning',
  },
  needs_absorption_date: {
    label: 'להזין תאריך כניסה לגן בפורטל התמ"ת',
    severity: 'warning',
  },
  absorption_date_inconsistent: {
    label: 'החלטת התמ"ת אינה תואמת את תאריך הכניסה',
    severity: 'info',
  },
  tmt_removed: {
    label: 'ירד/ה מרשימת התמ"ת בקובץ מאוחר יותר',
    severity: 'critical',
  },
  clicktac_removed: {
    label: 'ירד/ה מקובץ הקליקטאק',
    severity: 'critical',
  },
};

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

/** Both parents' phones, for checking the ministry's contact against them. */
function parentPhones(ct) {
  return [ct?.parent1?.phone, ct?.parent2?.phone].map(normalizePhone).filter(Boolean);
}

/**
 * Compare one child's two records and list what disagrees.
 *
 * Only called when the child is on both sides — a child missing from one list
 * has one finding (the absence) and comparing fields would bury it.
 */
function issuesFor(tmt, ct, { branchId }) {
  const found = [];
  const add = (code, detail) => found.push({ code, detail, ...ISSUES[code] });

  if (tmt && String(tmt.branch_id?._id || tmt.branch_id) !== String(branchId)) {
    add('branch_mismatch', `אישור התמ"ת רשום על סניף ${tmt.branch_name || 'אחר'}`);
  }
  if (tmt && tmt.presence?.is_present === false) {
    add('tmt_removed', `הופיע/ה ברשימה עד ${fmtDate(tmt.presence.missing_since)}, ואינו/ה בקובץ האחרון`);
  }
  if (ct && ct.presence?.is_present === false) {
    add('clicktac_removed', `הופיע/ה בקובץ עד ${fmtDate(ct.presence.missing_since)}, ואינו/ה בקובץ האחרון`);
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

    if (tmt.ministry?.continuing != null && ct.enrollment?.continuing != null
      && tmt.ministry.continuing !== !!ct.enrollment.continuing) {
      add('continuing_mismatch', `תמ"ת ${yesNo(tmt.ministry.continuing)} · קליקטאק ${yesNo(!!ct.enrollment.continuing)}`);
    }

    if (tmt.ministry?.welfare != null && tmt.ministry.welfare !== !!ct.child?.welfare_referred) {
      add('welfare_mismatch', `תמ"ת ${yesNo(tmt.ministry.welfare)} · קליקטאק ${yesNo(!!ct.child?.welfare_referred)}`);
    }

    const phone = normalizePhone(tmt.contact?.phone);
    if (phone && !parentPhones(ct).includes(phone)) {
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

  if (ct && ct.enrollment?.second_signer === 'ממתין לחתימה') {
    add('unsigned', 'חותם שני טרם חתם — הרישום אינו שלם');
  }

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
function verdictFor(tmt, ct, { branchId } = {}) {
  const ownApproval = !!tmt && (!branchId
    || String(tmt.branch_id?._id || tmt.branch_id) === String(branchId));
  // A name the ministry dropped from a later file is not an approval any more,
  // whatever the decision on the row still says.
  const approvalLive = ownApproval && tmt.presence?.is_present !== false;
  // Same on our side: a row that vanished from a later export is not a
  // registration. It is NOT the same as ביטל רישום — a cancelled family is
  // still in the file, with a status.
  const registrationLive = !!ct && ct.presence?.is_present !== false;

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
function reconcile({ tmtDocs = [], ctDocs = [], branchId, academicYear, branchName = '' }) {
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

  const ids = new Set([...tmtById.keys(), ...ctById.keys()]);
  const rows = [];

  for (const id of ids) {
    const tmt = tmtById.get(id) || null;
    const ct = ctById.get(id) || null;
    const verdict = verdictFor(tmt, ct, { branchId });
    const issues = issuesFor(tmt, ct, { branchId });

    // A cancelled registration whose ministry approval still stands is the one
    // case where the anomaly is an opportunity: the state has allocated a place
    // to this gan and the family walked away from it.
    if (verdict === 'cancelled' && tmt?.ministry?.is_approved && tmt.presence?.is_present !== false) {
      issues.unshift({ code: 'place_freed', detail: `אישור תמ"ת מ־${fmtDate(tmt.ministry.absorbed_at) !== '—' ? fmtDate(tmt.ministry.absorbed_at) : tmt.ministry.decision}`, ...ISSUES.place_freed });
    }

    const worst = issues.some(i => i.severity === 'critical') ? 'critical'
      : issues.some(i => i.severity === 'warning') ? 'warning'
        : issues.length ? 'info' : 'ok';

    rows.push({
      id_number: id,
      child_name: ct?.child?.full_name || tmt?.child?.full_name || '',
      birth_date: ct?.child?.birth_date || tmt?.child?.birth_date || null,
      age_group: canonicalAgeGroup(ct?.child?.age_group || tmt?.child?.age_group || ''),
      computed_age_group: ct?.computed?.age_group || '',
      // תמ"ת first: on identity — the name, the ת"ז, the birth date — the
      // ministry's record is the state's own and wins over a form a parent
      // filled in. Where they disagree it is reported as a finding as well.
      age_at_year_start: ageAtYearStart(
        tmt?.child?.birth_date || ct?.child?.birth_date, academicYear,
      ),
      age_source: tmt?.child?.birth_date ? 'תמ"ת' : (ct?.child?.birth_date ? 'קליקטאק' : ''),
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
        parent1_name: `${ct.parent1?.first_name || ''} ${ct.parent1?.last_name || ''}`.trim(),
        parent1_phone: ct.parent1?.phone || '',
        parent1_email: ct.parent1?.email || '',
        parent2_name: `${ct.parent2?.first_name || ''} ${ct.parent2?.last_name || ''}`.trim(),
        parent2_phone: ct.parent2?.phone || '',
        parent2_email: ct.parent2?.email || '',
        address: ct.parent1?.address || ct.parent2?.address || '',
        is_present: ct.presence?.is_present !== false,
        missing_since: ct.presence?.missing_since || null,
      } : null,
    });
  }

  // Anomalies first, then by name — the screen is a work queue, not a register.
  rows.sort((a, b) => a.rank - b.rank
    || a.child_name.localeCompare(b.child_name, 'he'));

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
    summary: {
      total: rows.length,
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
      issues: issueCounts,
    },
  };
}

module.exports = {
  reconcile, compareNames, issuesFor, verdictFor, ageAtYearStart,
  VERDICTS, ISSUES, CANCELLED,
};
