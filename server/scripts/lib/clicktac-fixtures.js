/**
 * ClickTac export builders — one copy, used by the test and by the demo seed.
 *
 * WHY A SHARED FILE. These row builders were written inside
 * scripts/clicktac-contracts.test.js, where they earn their keep: they produce
 * the two real exports column-for-column, dates as bare Excel serials and all,
 * which is the only shape worth testing a parser against. The demo seed then
 * needed exactly the same thing — a demo built out of hand-written mongoose
 * documents proves nothing about the screen, because the screen reads fields
 * only the IMPORTER fills (sources, computed, content_hash, the payment alert)
 * and a document typed by hand gets them subtly wrong.
 *
 * So the builders moved here and both callers require them. There is no test
 * framework and no fixtures directory in this repo; scripts/lib is where the
 * one shared thing lives.
 *
 * EVERY FIELD IS OPTIONAL AND THE DEFAULTS ARE THE TEST'S OLD LITERALS. This
 * file was extracted, not rewritten: called the way the test called it, it
 * produces byte-identical sheets. The payment columns are new parameters with
 * blank defaults, which is what they were before — blank.
 */

const XLSX = require('xlsx');
const { COLUMNS, CONTRACT_COLUMNS } = require('../../src/services/clicktac.service');

/** The gan year the fixtures are written for, in the vendor's own spelling. */
const YEAR = 'תשפ"ז';

/** Excel's own day count for a date — what an unformatted date cell holds. */
function excelSerial(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) / 86400000) + 25569);
}

function sheetBuffer(header, rows, sheetName) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const CONTRACTS_HEADER = Object.values(CONTRACT_COLUMNS);
const REGISTRATIONS_HEADER = Object.values(COLUMNS);

/**
 * One contracts row. The dates go in as bare Excel serials, exactly as the
 * real export has them — that is the shape the parser has to survive.
 */
function contractRow({
  id, first, last, idNumber, idType = 'ת.ז.', birth, cls, tier,
  nickname = '', medicalNotes = '', ageGroup = 'פעוט', status = 'התקבל',
  year = YEAR, institution = 'הרצליה',
}) {
  const by = {
    [CONTRACT_COLUMNS.contract_id]: id,
    [CONTRACT_COLUMNS.child_first]: first,
    [CONTRACT_COLUMNS.child_last]: last,
    [CONTRACT_COLUMNS.nickname]: nickname,
    [CONTRACT_COLUMNS.birth_date]: excelSerial(...birth),
    [CONTRACT_COLUMNS.birth_date_hebrew]: 'ל׳ בשבט',
    [CONTRACT_COLUMNS.id_type]: idType,
    [CONTRACT_COLUMNS.id_number]: idNumber,
    [CONTRACT_COLUMNS.health_fund]: 'מכבי',
    [CONTRACT_COLUMNS.medical_notes]: medicalNotes,
    [CONTRACT_COLUMNS.registered_at]: excelSerial(2026, 5, 3),
    [CONTRACT_COLUMNS.status]: status,
    [CONTRACT_COLUMNS.age_group]: ageGroup,
    [CONTRACT_COLUMNS.admin_notes]: '',
    [CONTRACT_COLUMNS.institution]: institution,
    [CONTRACT_COLUMNS.year]: year,
    [CONTRACT_COLUMNS.class_name]: cls,
    [CONTRACT_COLUMNS.tuition_type]: 'מימון משרד הכלכלה',
    [CONTRACT_COLUMNS.tier]: tier,
    [CONTRACT_COLUMNS.start_date]: excelSerial(2026, 9, 1),
    [CONTRACT_COLUMNS.end_date]: excelSerial(2027, 8, 31),
    [CONTRACT_COLUMNS.tags]: 'ספטמבר',
    [CONTRACT_COLUMNS.created_by]: 'אלון',
    [CONTRACT_COLUMNS.created_at]: excelSerial(2026, 5, 3),
    [CONTRACT_COLUMNS.updated_by]: 'אלון',
    [CONTRACT_COLUMNS.updated_at]: excelSerial(2026, 5, 3),
  };
  return CONTRACTS_HEADER.map(h => by[h] ?? '');
}

/**
 * One registrations row.
 *
 * The payment half — דמי רישום, קבלה, שובר, סכום and the four הו"ק columns —
 * is parameterised because it is the half the screen now shows. Left out, the
 * row is what it always was: blank in all of them.
 */
function registrationRow({
  first, last, idNumber, birth, parentFirst, parentPhone, method = 'כרטיס אשראי',
  ageGroup = 'פעוט', status = 'התקבל', year = YEAR, institution = 'הרצליה',
  parent2First = '', parent2Phone = '', continuing = '', secondSigner = '',
  tuitionCard = '', regFeeMethod = '', regFeeCard = '', receipt = '',
  voucher = '', amount = '', soBank = '', soBranch = '', soAccount = '',
  soHolder = '', address = 'הרצל 1',
}) {
  const [y, m, d] = birth;
  const by = {
    [COLUMNS.institution]: institution,
    [COLUMNS.year]: year,
    [COLUMNS.child_first]: first,
    [COLUMNS.child_last]: last,
    [COLUMNS.child_id]: idNumber,
    [COLUMNS.birth_date]: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
    [COLUMNS.age_group]: ageGroup,
    [COLUMNS.gender]: 'זכר',
    [COLUMNS.health_fund]: 'כללית',
    [COLUMNS.p1_first]: parentFirst,
    [COLUMNS.p1_last]: last,
    [COLUMNS.p1_id]: '311111111',
    [COLUMNS.p1_relation]: 'אם',
    [COLUMNS.p1_phone]: parentPhone,
    [COLUMNS.p1_email]: 'a@b.co.il',
    [COLUMNS.p1_address]: address,
    [COLUMNS.status]: status,
    [COLUMNS.tuition_method]: method,
  };
  // Written only when asked for, so a call that passes none of them produces
  // the sheet this builder produced before the payment half existed.
  const optional = {
    [COLUMNS.p2_first]: parent2First,
    [COLUMNS.p2_last]: parent2First ? last : '',
    [COLUMNS.p2_relation]: parent2First ? 'אב' : '',
    [COLUMNS.p2_phone]: parent2Phone,
    [COLUMNS.continuing]: continuing,
    [COLUMNS.second_signer]: secondSigner,
    [COLUMNS.tuition_card]: tuitionCard,
    [COLUMNS.reg_fee_method]: regFeeMethod,
    [COLUMNS.reg_fee_card]: regFeeCard,
    [COLUMNS.receipt]: receipt,
    [COLUMNS.voucher]: voucher,
    [COLUMNS.amount]: amount,
    [COLUMNS.so_bank]: soBank,
    [COLUMNS.so_branch]: soBranch,
    [COLUMNS.so_account]: soAccount,
    [COLUMNS.so_holder]: soHolder,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== '' && v != null) by[k] = v;
  return REGISTRATIONS_HEADER.map(h => by[h] ?? '');
}

module.exports = {
  YEAR, excelSerial, sheetBuffer,
  CONTRACTS_HEADER, REGISTRATIONS_HEADER, contractRow, registrationRow,
};
