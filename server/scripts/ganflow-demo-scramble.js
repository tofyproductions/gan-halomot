#!/usr/bin/env node
/**
 * GanFlow demo scrambler.
 *
 * Takes a RESTORED COPY of the production database and removes every fact that
 * could point at a real child, parent, employee or branch — while leaving the
 * shape, the volumes and the history intact, because an empty demo sells
 * nothing and a demo with 42 children and a year of collections sells itself.
 *
 * WHAT THIS IS NOT: it is not an export, not a filter, not a view. It REWRITES
 * the database it is pointed at, in place, destructively. Point it at
 * production and the gan loses its records. Every guard below exists because
 * that mistake is unrecoverable, and all of them refuse rather than warn.
 *
 *   1. --uri is required and must differ from MONGODB_URI in the environment.
 *   2. The database name must contain "demo".
 *   3. Writing requires --yes. Without it the script only reports.
 *
 * DETERMINISTIC, NOT RANDOM. "מיכל לוי" becomes the same invented name in the
 * children collection, in the payroll table and in a two-year-old note. Random
 * per-field values would break every join the screens rely on and the demo
 * would read as broken data rather than as a working gan.
 *
 * Usage:
 *   node scripts/ganflow-demo-scramble.js --uri "mongodb+srv://.../ganflow_demo"            # report only
 *   node scripts/ganflow-demo-scramble.js --uri "mongodb+srv://.../ganflow_demo" --yes      # write
 *   ... --yes --scramble-money        # also shift every shekel figure (see MONEY below)
 *   ... --unknown                     # list string fields no rule touched — read this
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const URI = opt('uri');
const WRITE = flag('yes');
const MONEY = flag('scramble-money');
const SHOW_UNKNOWN = flag('unknown');

// A fixed salt, not a secret. It is here so that two runs of this script over
// two restores produce the SAME invented people — otherwise a demo rebuilt the
// night before the event is a different gan than the one that was rehearsed.
const SALT = 'ganflow-demo-v1';

// ------------------------------------------------------------------- guards

function die(msg) {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

if (!URI) die('חסר --uri. צריך כתובת של מסד ההדגמה.');

if (process.env.MONGODB_URI && URI.trim() === process.env.MONGODB_URI.trim()) {
  die('ה-uri שנתת זהה ל-MONGODB_URI של הייצור. זה המסד האמיתי של גן החלומות.');
}

const dbNameFromUri = (() => {
  // mongodb+srv://user:pass@host/DBNAME?opts
  const m = URI.match(/\/([^/?]+)(\?|$)/);
  return m ? m[1] : null;
})();

if (!dbNameFromUri) die('לא הצלחתי לקרוא שם מסד מה-uri. הוסף שם מסד בסוף הכתובת.');
if (!/demo/i.test(dbNameFromUri)) {
  die(`שם המסד הוא "${dbNameFromUri}" ואינו מכיל "demo". מסרב לרוץ.`);
}

// ------------------------------------------------------ deterministic values

function h(input, mod) {
  const digest = crypto.createHmac('sha256', SALT).update(String(input)).digest();
  return digest.readUInt32BE(0) % mod;
}

const MALE = ['אורי','איתי','נועם','יהונתן','דניאל','עידו','אלון','רועי','גיא','עמית','שחר','ליאור','תומר','ניר','יובל','אריאל','מתן','עומר','איתן','אדם','רון','שי','ברק','אסף','יוסי','משה','אבי','דוד','חיים','יעקב'];
const FEMALE = ['נועה','מאיה','שירה','תמר','יעל','אביגיל','ליאן','רוני','אלה','הילה','דנה','מירי','אורית','גלית','סיון','עדי','רותם','נטע','אורלי','ליבי','טליה','שקד','אמה','אריאל','לוטם','אגם','יערה','כרמל','שני','מיכל'];
const SURNAME = ['לביא','ברקת','שדות','אלמוג','נחשון','גלעדי','רימון','אשכול','תדהר','ניצן','שוהם','אביב','ברנע','דגן','זהבי','חורש','טללים','יערי','כרמלי','לוטן','מרום','נבון','סלעי','עומרי','פלגי','צורי','קדם','רהב','שחם','תמרי','ארבל','בן־חורין','גפני','דורי','הראל','ורדי','זמיר','חלד','יגאל','כנרתי'];
const STREET = ['הזית','האלון','התאנה','הרימון','הדקל','הברוש','האורן','הכלנית','הרקפת','הנרקיס','הגפן','השקד','התמר','הדולב','הערבה'];
const CITY = ['רמת שדה','כפר אלון','גבעת תמר','נווה ברוש','מעלה רימון','תל אשכול','הר נחשון'];

/**
 * `gender` is the sibling field on the same document when there is one. A gan
 * screen that reads "יהונתן ורדי — נקבה" is a screen a manager notices in the
 * first thirty seconds of a demo, and once she notices it she stops believing
 * the rest of the numbers.
 */
function personName(orig, gender) {
  const g = String(gender || '').toLowerCase();
  const female = g === 'female' || g === 'נקבה' ? true
               : g === 'male' || g === 'זכר' ? false
               : Boolean(h(`g:${orig}`, 2));
  const pool = female ? FEMALE : MALE;
  return `${pool[h(`f:${orig}`, pool.length)]} ${SURNAME[h(`s:${orig}`, SURNAME.length)]}`;
}

function phone(orig) {
  const prefix = ['050','052','053','054','055','058'][h(`p:${orig}`, 6)];
  const rest = String(h(`pn:${orig}`, 10000000)).padStart(7, '0');
  return `${prefix}${rest}`;
}

/** A 9-digit number that passes the Israeli ID check digit, so validation
 *  screens behave exactly as they do in production. */
function israeliId(orig) {
  const base = String(h(`id:${orig}`, 100000000)).padStart(8, '0');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(base[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

function email(orig) {
  return `demo${h(`e:${orig}`, 100000)}@example.invalid`;
}

function address(orig) {
  return `${STREET[h(`st:${orig}`, STREET.length)]} ${h(`no:${orig}`, 80) + 1}, ${CITY[h(`ct:${orig}`, CITY.length)]}`;
}

function bankNumber(orig) {
  return String(h(`b:${orig}`, 1000000)).padStart(6, '0');
}

/** Same month and year, different day. Age, birthday-month reports and school
 *  year placement all stay correct; the exact date stops matching a person. */
function birthDate(orig) {
  const d = new Date(orig);
  if (isNaN(d.getTime())) return orig;
  const day = h(`bd:${d.toISOString()}`, 28) + 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
}

// Branch and amuta labels are assigned in order of first sighting, so the
// screens read "סניף מרכז" rather than a hash.
const BRANCH_LABELS = ['סניף מרכז','סניף צפון','סניף דרום','סניף מזרח','סניף מערב','סניף הפארק','סניף הגבעה','סניף הנחל','סניף הכרם','סניף השדות'];
const AMUTA_LABELS  = ['עמותת אלף','עמותת בית','עמותת גימל','עמותת דלת'];
const seenBranches = new Map();
const seenAmutot = new Map();

function branchLabel(orig) {
  if (!seenBranches.has(orig)) {
    const i = seenBranches.size;
    seenBranches.set(orig, BRANCH_LABELS[i] || `סניף ${i + 1}`);
  }
  return seenBranches.get(orig);
}
function amutaLabel(orig) {
  if (!seenAmutot.has(orig)) {
    const i = seenAmutot.size;
    seenAmutot.set(orig, AMUTA_LABELS[i] || `עמותה ${i + 1}`);
  }
  return seenAmutot.get(orig);
}

// ------------------------------------------------------------------- rules

const PERSON_NAME = new Set([
  'child_name','parent_name','parent2_name','employee_name','full_name','first_name','last_name',
  'name_on_payslip','aide_name','instructor_name','holder_name','bank_account_holder','signer_name',
  'signed_by_name','contact_name','delivery_contact_name','emergency_contact','customer_name',
  'clock_name','author_name','approved_by_name','created_by_name','updated_by_name','uploaded_by_name',
  'decided_by_name','requested_by_name','reported_by_name','seen_by_name','received_by_name',
  'waived_by_name','issued_by_name','final_by_name','added_by_name','by_name','proposed_by_name',
  'second_signer','employer_name',
]);

// Fields that end in _name but are not a person.
const NOT_A_PERSON = new Set([
  'branch_name','classroom_name','file_name','photo_name','medical_file_name','sheet_name',
  'table_sheet_name','field_name','short_name','table_filename','product_name','supplier_name',
]);

const PHONE = new Set(['phone','parent_phone','parent2_phone','emergency_phone','aide_phone','delivery_contact_phone','new_phone','phone_raw','sms_recipients']);
const ID_NUM = new Set(['id_number','child_id_number','parent_id_number','parent2_id_number','israeli_id','tax_id','signer_id_last4','device_user_id','unique_id','employee_id','user_id','customer_id','parent1_id','parent2_id']);
const EMAIL = new Set(['email','parent_email','parent2_email','contact_email','mail_from','payslip_sent_to','sent_to','manager_sent_to','mailbox']);
const ADDRESS = new Set(['address','location','work_addr','work_address','zip','postal_code','city','street']);
const BANK = new Set(['bank_account','bank_branch','bank_number','account','receipt_number','voucher_number','registration_fee_receipt','order_number']);
const BIRTH = new Set(['birth_date','child_birth_date','gave_birth_date']);
const CARD4 = new Set(['tuition_card_last4','registration_fee_card_last4']);

// Secrets and credentials. Never carried into a demo, and reset so the demo
// can actually be logged into.
const SECRET_NULL = new Set([
  'password_hash','otp_hash','agent_secret','access_token','fix_token','webauthn_challenge',
  'public_key','credential_id','signature_data','signed_ip','hash','content_hash',
]);

// Embedded file bytes. A base64 PDF of a real employment contract or a real
// medical note is the single largest leak in this database.
const BLOB_NULL = new Set([
  'b64','file_data','photo_data','medical_file_data','raw','payload','original_data','full_result','html','thumb_key',
]);

// Free text written by staff about real people. Cannot be scrambled, only removed.
const FREE_TEXT = new Set([
  'notes','note','staff_note','parent_note','manual_note','permanent_note','manager_note','travel_note',
  'reason','close_reason','inactive_reason','reject_reason','rejected_reason','no_show_reason',
  'fee_override_reason','extra_reason','waived_reason','ignored_reason','decision_note','approved_note',
  'decided_note','completed_note','review_note','scan_notes','message','body','content','subject',
  'raw_subject','mail_subject','caption','description','medical_alerts','allergies','allergy_detail','text',
  'job','occupation','work_place','workplace',
  // An audit trail records the OLD and NEW value of anything at all —
  // a telephone number, a manager's name inside a sentence. There is no
  // shape to match, so a demo does not carry them.
  'before','after','actual','expected','old_value','new_value','was','now',
  'hearing_before','hearing_by','present','findings_text',
]);

const MONEY_FIELDS = new Set([
  'salary','current_salary','new_salary','global_salary','hourly_rate','default_rate','amount',
  'total_amount','monthly_fee','new_monthly_fee','previous_monthly_fee','fixed_monthly_fee',
  'registration_fee','paid_amount','expected_amount','installment_amount','override_amount',
  'unit_price','price_before_vat','price_with_vat','travel_per_day','travel_monthly_flat',
  'meal_amount','budget','total',
]);
const MONEY_FACTOR = 0.93; // one factor everywhere, so every sum still adds up

// Collections whose `name` field is a person; everywhere else `name` is left alone.
const NAME_IS_PERSON = new Set(['users','employees','candidates','leads','parentaccounts']);

// ---------------------------------------------- field names in two spellings
//
// The rule sets above are written in snake_case, because that is how the
// mongoose schemas are written. The registration card is NOT: it is the raw
// form body, stored as the parent's browser sent it, and it spells everything
// camelCase — childName, parentEmail, parentId, firstName, workAddr.
//
// Matching on the literal key therefore missed the single richest source of
// personal data in the database: 171 real names, 72 identity numbers and 7
// handwritten signatures walked into the demo untouched. Normalising the key
// before every lookup is what closes it, and it closes the whole class rather
// than the instances that happened to be noticed.
function norm(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')   // childName  -> child_Name
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

const NAME_IS_BRANCH = new Set(['branches']);
const NAME_IS_AMUTA = new Set(['amutas','amutot']);

// Dropped wholesale. Photographs of real children live in object storage and
// these rows are the keys to them — a demo that keeps them serves real faces.
const DROP_COLLECTIONS = new Set([
  'photos','giftselections','scannedattachments','documents','employeedocuments',
  'payslipauditpdfs','savedpayslips','directpayslipbatches','form101inboxes','archives',
]);

// --------------------------------------------------------------- the walker

const touched = new Map();   // "collection.path" -> {count, before, after}
const unknown = new Map();   // "collection.path" -> sample

function record(map, key, before, after) {
  const e = map.get(key) || { count: 0, before, after };
  e.count++;
  map.set(key, e);
}

function transform(collection, key, value, path, ctx) {
  const k = norm(key);
  const P = String(path);

  // A bare `id` or `name` means nothing on its own. Inside the registration
  // card it is a child's identity number and a parent's name; inside a list of
  // attendees it is a member of staff. The path is what tells them apart.
  const inCard   = /registration_?card|configuration/i.test(P);
  const personAt = /(attendees|updated|contact|result|signer|guardian|pickup)\b/i.test(P);

  if (SECRET_NULL.has(k)) return { v: null };
  if (BLOB_NULL.has(k)) return { v: null };
  if (k === 'signature' || k === 'contract_pdf_path') return { v: null };
  // A Drive file id is a working link to the real signed contract.
  if (k === 'id' && /\bfiles\b/i.test(P)) return { v: null };

  if (typeof value === 'number') {
    if (MONEY && MONEY_FIELDS.has(k)) return { v: Math.round(value * MONEY_FACTOR * 100) / 100 };
    // An identity number stored as a NUMBER rather than a string used to walk
    // straight out of here: every test below is a string test. punches held
    // 50,000 of them under device_user_id.
    if (ID_NUM.has(k) || /^\d{9}$/.test(String(value))) {
      return { v: Number(israeliId(String(value)).slice(0, 9)) };
    }
    return null;
  }

  if (value instanceof Date || (BIRTH.has(k) && typeof value === 'string')) {
    if (BIRTH.has(k)) return { v: birthDate(value) };
    return null;
  }

  if (typeof value !== 'string' || !value.trim()) return null;

  if (PERSON_NAME.has(k) || (k.endsWith('_name') && !NOT_A_PERSON.has(k))) return { v: personName(value, ctx) };
  if (k === 'name' && (NAME_IS_PERSON.has(collection) || inCard || personAt)) return { v: personName(value, ctx) };
  if ((k === 'id' || k === 'parent_id' || k === 'child_id') && inCard) {
    return { v: israeliId(value).slice(0, 9) };
  }
  // A filename carries the name it was saved under — a child, a branch, the
  // amuta. Nothing in a demo needs the original, so none of them keep it.
  // Every spelling of it: file_name, filename, medical_file_name, table_filename.
  // A sick note is saved under the name of the person who was ill.
  if (k.endsWith('file_name') || k.endsWith('filename')) {
    const ext = (String(value).match(/\.[a-z0-9]{2,5}$/i) || [''])[0];
    return { v: `מסמך-${h(`f:${value}`, 900) + 100}${ext}` };
  }
  if (k.endsWith('_address')) return { v: address(value) };
  if (k === 'name' && NAME_IS_BRANCH.has(collection)) return { v: branchLabel(value) };
  if (k === 'name' && NAME_IS_AMUTA.has(collection)) return { v: amutaLabel(value) };
  // Every spelling a branch is written under — branch, branch_name,
  // requested_branch, round_branch, __source_branch, branch_filter. A branch
  // named after a real street in a small town is a puzzle a local solves in
  // one move, so none of them may keep the original.
  // Never an id (that would break the join) and never a bank branch (a number).
  if (/branch/.test(k) && !k.endsWith('_id') && !BANK.has(k) && /[֐-׿]/.test(value)) {
    return { v: branchLabel(value) };
  }
  if (PHONE.has(k)) return { v: phone(value) };
  if (ID_NUM.has(k)) return { v: israeliId(value).slice(0, value.length <= 4 ? 4 : 9) };
  if (CARD4.has(k)) return { v: String(h(`c:${value}`, 10000)).padStart(4, '0') };
  if (EMAIL.has(k)) return { v: email(value) };
  if (ADDRESS.has(k)) return { v: address(value) };
  if (BANK.has(k)) return { v: bankNumber(value) };
  if (FREE_TEXT.has(k)) return { v: '' };

  // A composite key glues real values together to match rows across two
  // sources — "nm:<employee>::<branch>". It is not a name field and no name
  // rule looks at it, so the name rode into the demo inside the join.
  if ((k === 'key' || k === 'row_key' || k === 'match_key') && /[֐-׿]/.test(value)) {
    return { v: `k:${h(`k:${value}`, 1e6)}` };
  }

  // ------------------------------------------------------------ safety net
  //
  // Rules keyed on a field name can only cover the fields somebody thought of,
  // and the fields nobody thought of are exactly where a telephone number was
  // found hiding. These last four tests read the VALUE and ignore what it is
  // called, so a new field added next year is covered before anyone edits this
  // file. They run last: a field with a real rule never reaches them.
  // Values arrive wrapped in invisible right-to-left marks. A telephone number
  // that reads as one on screen did not match any test until they came off.
  const clean = value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const flat = clean.replace(/[\s-]/g, '');
  if (/^0(5\d|[2-4,8-9])-?\d{7}$/.test(flat)) return { v: phone(clean) };
  if (/^\d{9}$/.test(flat)) return { v: israeliId(clean).slice(0, 9) };
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(clean.trim())) return { v: email(clean) };
  if (/^data:[^;]+;base64,/.test(clean)) return { v: null };

  // An identity number does not always sit alone in its field. "id:024073124"
  // is a key built by joining, and the digits are just as real inside it.
  if (/\d{9}/.test(clean) && !/^\d[\d.,]*$/.test(clean)) {
    const swapped = clean.replace(/\d{9}/g, (m) => israeliId(m).slice(0, 9));
    if (swapped !== clean) return { v: swapped };
  }

  if (SHOW_UNKNOWN && value.length > 1 && !unknown.has(`${collection}.${path}`)) {
    unknown.set(`${collection}.${path}`, value.slice(0, 40));
  }
  return null;
}

function walk(collection, node, path = '') {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(collection, item, `${path}[]`));
    return;
  }
  if (!node || typeof node !== 'object' || node instanceof Date || node._bsontype) return;

  const ctx = node.gender;

  for (const key of Object.keys(node)) {
    if (key === '_id' || key.endsWith('_id') && node[key] && node[key]._bsontype) continue;
    const p = path ? `${path}.${key}` : key;
    const out = transform(collection, key, node[key], p, ctx);
    if (out) {
      record(touched, `${collection}.${p}`, node[key], out.v);
      node[key] = out.v;
    } else {
      walk(collection, node[key], p);
    }
  }
}

// ----------------------------------------------------------------- the run

(async function main() {
  console.log(`\n\u{1F5C4}️  מסד: ${dbNameFromUri}`);
  console.log(WRITE ? '⚠️   מצב כתיבה — המסד ישוכתב\n' : '\u{1F441}️   מצב דיווח בלבד — לא נכתב כלום\n');

  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();

  let scanned = 0;
  let dropped = 0;

  for (const name of collections) {
    if (DROP_COLLECTIONS.has(name)) {
      const n = await db.collection(name).countDocuments();
      dropped += n;
      console.log(`  \u{1F5D1}️  ${name}: ${n} מסמכים יימחקו`);
      if (WRITE) await db.collection(name).deleteMany({});
      continue;
    }

    const col = db.collection(name);
    const docs = await col.find({}).toArray();
    if (!docs.length) continue;
    scanned += docs.length;

    const ops = [];
    for (const doc of docs) {
      const before = JSON.stringify(doc);
      walk(name, doc);
      if (JSON.stringify(doc) !== before) {
        const { _id, ...rest } = doc;
        ops.push({ replaceOne: { filter: { _id }, replacement: { _id, ...rest } } });
      }
    }
    if (ops.length) {
      console.log(`  ✏️  ${name}: ${ops.length}/${docs.length} מסמכים משובשים`);
      if (WRITE) {
        for (let i = 0; i < ops.length; i += 500) {
          await col.bulkWrite(ops.slice(i, i + 500));
        }
      }
    }
  }

  // Every account gets the same known password, so the demo can be logged into.
  if (WRITE) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('Demo2026!', 10);
    const r = await db.collection('users').updateMany({}, {
      $set: { password_hash: hash, password_set: true },
      $unset: { webauthn_credentials: '' },
    });
    console.log(`\n  \u{1F511} ${r.modifiedCount} משתמשים אופסו לסיסמה: Demo2026!`);
  }

  console.log(`\n─── סיכום ───`);
  console.log(`נסרקו ${scanned} מסמכים, ${dropped} נמחקו, ${touched.size} סוגי שדות שובשו.\n`);

  const rows = [...touched.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [k, v] of rows.slice(0, 60)) {
    const b = String(v.before).slice(0, 26);
    const a = String(v.after).slice(0, 26);
    console.log(`  ${String(v.count).padStart(6)}  ${k.padEnd(48)} ${b}  →  ${a}`);
  }
  if (rows.length > 60) console.log(`  ... ועוד ${rows.length - 60} שדות`);

  if (SHOW_UNKNOWN) {
    console.log(`\n─── שדות טקסט שלא נגענו בהם (${unknown.size}) ───`);
    console.log('קרא את הרשימה. אם יש כאן משהו שמזהה אדם — תגיד לי ואוסיף חוק.\n');
    for (const [k, v] of [...unknown.entries()].sort()) {
      console.log(`  ${k.padEnd(56)} ${v}`);
    }
  }

  if (!WRITE) console.log('\n\u{1F449} לא נכתב כלום. להרצה אמיתית הוסף --yes\n');

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
