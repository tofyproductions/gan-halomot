/**
 * One way into the archive, used by three doors:
 *   - the archive screen's own button (the manual act, unchanged);
 *   - cancelling a registration with "המשפחה לא חייבת דבר";
 *   - closing a cancelled registration's debt (settle-billing).
 * The last two are the automatic promise: a parent marked as cancelled is
 * billed through the chosen month, and the moment nothing more is owed the
 * record walks itself to the archive instead of sitting in the tracker as
 * "בוטל — ממתין לגבייה" forever. The snapshot (original_data) and restore
 * behave exactly as a manual archive always did.
 */
const { Archive, Registration, Child, Collection } = require('../models');
const { academicYearOf } = require('./academic-year.service');
const { cleanupChildrenOfRegistration } = require('./childCleanup');

async function archiveRegistration({ registrationId, userId }) {
  const registration = await Registration.findById(registrationId)
    .populate('classroom_id', 'name').lean();
  if (!registration) return null;

  const archiveRecord = await Archive.create({
    registration_id: registration._id,
    archive_type: registration.agreement_signed ? 'signed' : 'unsigned',
    original_data: registration,
    child_name: registration.child_name,
    classroom_name: registration.classroom_id?.name || null,
    academic_year: academicYearOf(registration) || '',
    archived_by: userId || null,
  });

  // Referencing docs first — see services/childCleanup.js.
  const cleaned = await cleanupChildrenOfRegistration(registrationId);
  await Child.deleteMany({ registration_id: registrationId });
  await Collection.deleteMany({ registration_id: registrationId });
  await Registration.findByIdAndDelete(registrationId);
  console.log('[archive] cleaned refs for registration', String(registrationId), cleaned);
  return { archiveRecord, registration };
}

module.exports = { archiveRegistration };
