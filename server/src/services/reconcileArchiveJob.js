/**
 * ארכיון ההצלבה — removing the children nobody lists any more.
 *
 * A child gone from the ministry's list AND from both ClickTac exports is a
 * `gone` row on the comparison: off the table, under "ארכיון", for thirty
 * days. This job is the thirty days. It deletes the rows whose every "last
 * seen" flag has been false for longer than that, on both sides, so the
 * collections do not accumulate a year's worth of families who applied
 * elsewhere.
 *
 * WHAT IS NEVER DELETED. A ClickTac row that became a Registration
 * (`review.status === 'imported'`) — the child is in the gan whatever the
 * files say now — and any row a person wrote a decision about, because a
 * note is the office saying "this child matters to me".
 *
 * Runs daily; `DISABLE_JOBS` keeps it off in tests and in the demo.
 */

const { ExternalEnrollment, TmtApproval, ReconcileDecision } = require('../models');
const { normalizeId } = require('./tmt.service');

const DAYS = 30;

async function tick(now = new Date()) {
  const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);

  // Every decided child, so a note protects its row on either side.
  const decided = new Set((await ReconcileDecision.find({}).select('id_number academic_year').lean())
    .map(d => `${d.academic_year}|${d.id_number}`));

  /* ---- ClickTac: gone from BOTH exports it was ever in ---- */
  const ctCandidates = await ExternalEnrollment.find({
    'review.status': { $ne: 'imported' },
    $or: [
      { 'presence.is_present': false },
      { 'contract.present': false },
    ],
  }).select('child.id_number academic_year sources presence contract.present contract.missing_since branch_id').lean();

  const ctToDelete = [];
  const ctGoneIds = new Set();
  for (const d of ctCandidates) {
    const sources = d.sources?.length ? d.sources : ['registrations'];
    const regGone = !sources.includes('registrations') || d.presence?.is_present === false;
    const contractGone = !sources.includes('contracts') || d.contract?.present === false;
    if (!regGone || !contractGone) continue;
    const since = Math.max(
      d.presence?.missing_since ? new Date(d.presence.missing_since).getTime() : 0,
      d.contract?.missing_since ? new Date(d.contract.missing_since).getTime() : 0,
    );
    if (!since || since > cutoff.getTime()) continue;
    if (decided.has(`${d.academic_year}|${normalizeId(d.child?.id_number)}`)) continue;
    ctToDelete.push(d._id);
    ctGoneIds.add(`${d.academic_year}|${normalizeId(d.child?.id_number)}`);
  }

  /* ---- The ministry's list: dropped, and not still registered with us ---- */
  const tmtCandidates = await TmtApproval.find({ 'presence.is_present': false, 'presence.missing_since': { $lte: cutoff } })
    .select('child.id_number academic_year').lean();
  const stillHere = new Set((await ExternalEnrollment.find({
    academic_year: { $in: [...new Set(tmtCandidates.map(t => t.academic_year))] },
  }).select('child.id_number academic_year sources presence contract.present').lean())
    .filter((d) => {
      const sources = d.sources?.length ? d.sources : ['registrations'];
      const regLive = sources.includes('registrations') && d.presence?.is_present !== false;
      const contractLive = sources.includes('contracts') && d.contract?.present !== false;
      return regLive || contractLive;
    })
    .map(d => `${d.academic_year}|${normalizeId(d.child?.id_number)}`));
  const tmtToDelete = tmtCandidates
    .filter(t => !stillHere.has(`${t.academic_year}|${normalizeId(t.child?.id_number)}`))
    .filter(t => !decided.has(`${t.academic_year}|${normalizeId(t.child?.id_number)}`))
    .map(t => t._id);

  if (ctToDelete.length) await ExternalEnrollment.deleteMany({ _id: { $in: ctToDelete } });
  if (tmtToDelete.length) await TmtApproval.deleteMany({ _id: { $in: tmtToDelete } });
  return { clicktac: ctToDelete.length, tmt: tmtToDelete.length, cutoff };
}

module.exports = { tick, DAYS };
