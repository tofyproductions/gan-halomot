/**
 * AI reading of a טופס 101 — who filed it, for which tax year, and whether it
 * is a 101 at all.
 *
 * The mail scan is only as good as this step. A mailbox that also carries
 * invoices, sick notes and holiday photos will hand this function all of them,
 * so `is_form_101` is the gate that keeps a supplier's PDF from being filed as
 * an employee's tax form. When it says false, nothing is attached.
 *
 * ת״ז is what makes an automatic attachment safe: the name on the form is a
 * string that two people can share, the id number is not. Everything the model
 * reads is stored on the document so a wrong attribution can be traced back to
 * what the machine actually saw, rather than re-derived by hand.
 *
 * Requires ANTHROPIC_API_KEY in the environment (set in Render + local .env) —
 * the same key the sick-note scan uses.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.FORM101_SCAN_MODEL || 'claude-opus-4-8';

/**
 * The gate model — the cheap half of a two-stage read.
 *
 * The job is two different questions wearing one coat. "Is this a form 101 at
 * all?" is easy, and it is the question almost every attachment in the mailbox
 * fails: payslips, invoices, signature pages, logos. "What ת״ז is written on
 * this scan?" is hard, and getting it wrong files a form under the wrong
 * employee.
 *
 * So the easy question is asked of a model that costs a fifth as much, and only
 * what survives it reaches the expensive one. The extraction nobody can afford
 * to get wrong is unchanged.
 *
 * Set FORM101_GATE_MODEL to '' to turn the gate off and send everything
 * straight to the full read.
 */
const GATE_MODEL = process.env.FORM101_GATE_MODEL === ''
  ? null
  : (process.env.FORM101_GATE_MODEL || 'claude-haiku-4-5');

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('סריקת AI אינה מוגדרת (חסר ANTHROPIC_API_KEY)');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

function mimeFromName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_form_101: { type: 'boolean', description: 'האם זהו טופס 101 (כרטיס עובד לצורכי מס הכנסה) — ולא מסמך אחר' },
    employee_name: { type: ['string', 'null'], description: 'שם העובד/ת המלא כפי שמופיע בטופס, או null' },
    israeli_id: { type: ['string', 'null'], description: 'מספר ת״ז של העובד/ת, ספרות בלבד, או null אם לא קריא' },
    tax_year: { type: ['integer', 'null'], description: 'שנת המס שהטופס מתייחס אליה (למשל 2026), או null אם לא מופיעה' },
    employer_name: { type: ['string', 'null'], description: 'שם המעסיק המופיע בטופס, או null' },
    signed: { type: 'boolean', description: 'האם הטופס חתום על ידי העובד/ת' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'רמת הביטחון בחילוץ' },
    notes: { type: 'string', description: 'הערה קצרה בעברית על מה שזוהה / אי-ודאות' },
  },
  required: ['is_form_101', 'employee_name', 'israeli_id', 'tax_year', 'employer_name', 'signed', 'confidence', 'notes'],
};

const SYSTEM = [
  'את/ה עוזר/ת להנהלת חשבונות לזהות טופס 101 (כרטיס עובד לצורכי מס הכנסה) של עובדים בישראל.',
  'חלץ/י מהמסמך: שם העובד/ת, מספר ת״ז (ספרות בלבד), שנת המס, שם המעסיק, והאם הטופס חתום.',
  'שנת המס היא השנה שהטופס מולא עבורה — לרוב מודפסת בראש הטופס ליד "שנת המס".',
  'אם המסמך אינו טופס 101 (חשבונית, אישור מחלה, חוזה, תמונה כלשהי) — סמן is_form_101=false והשאר את שאר השדות null.',
  'אל תמציא/י מידע. שדה שאינו מופיע בבירור — null. ת״ז חלקית או מטושטשת — null, ולא ניחוש.',
  'ציין/י אי-ודאות ב-confidence וב-notes.',
].join('\n');

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_form_101: { type: 'boolean', description: 'האם המסמך הוא טופס 101 (כרטיס עובד לצורכי מס הכנסה)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'רמת הביטחון' },
  },
  required: ['is_form_101', 'confidence'],
};

/**
 * The gate's instructions are deliberately lopsided.
 *
 * A false yes costs one extra call to the expensive model. A false no loses an
 * employee's tax form silently — it is recorded as "not a form" and never asked
 * about again. Those are not symmetric mistakes, so the gate is told to lean
 * yes whenever it is unsure.
 */
const GATE_SYSTEM = [
  'עליך להחליט דבר אחד בלבד: האם המסמך שלפניך הוא טופס 101 (כרטיס עובד לצורכי מס הכנסה) של עובד בישראל.',
  'טופס 101 הוא טופס ממשלתי עם הכותרת "כרטיס עובד" או "טופס 101", ובו פרטי עובד, ת״ז, שנת מס והצהרה חתומה.',
  'מסמכים שאינם טופס 101: תלוש שכר, חשבונית, אישור מחלה, חוזה, צילום מסך, לוגו, תמונה כלשהי.',
  'חשוב: אם אינך בטוח/ה — ענה/י is_form_101=true. טעות לכיוון "כן" עולה בדיקה נוספת בלבד;',
  'טעות לכיוון "לא" גורמת לכך שטופס אמיתי של עובד/ת ייזרק ולא ייבדק שוב לעולם.',
  'אל תחלץ/י שום פרט מהמסמך — רק ההחלטה הזו.',
].join('\n');

/**
 * Stage one: is this a form 101 at all?
 *
 * Returns null when the gate is disabled or the file type is one it cannot
 * judge — the caller then goes straight to the full read.
 *
 * @returns {Promise<{is_form_101: boolean, confidence: string, model: string}|null>}
 */
async function gateIsForm101(fileDataBase64, fileName, mimeType, { onUsage } = {}) {
  if (!GATE_MODEL) return null;
  const block = docBlockFor(fileDataBase64, fileName, mimeType);

  const response = await getClient().messages.create({
    model: GATE_MODEL,
    max_tokens: 128,
    system: GATE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: GATE_SCHEMA } },
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: 'האם זהו טופס 101?' }],
    }],
  });

  // A refusal or an unreadable answer is not a "no" — hand it to the full read
  // rather than discarding a file on a failed cheap check.
  // A refused or unreadable call still consumed tokens — report the usage even
  // when the answer is unusable, or the run's cost silently understates itself.
  onUsage?.(GATE_MODEL, response.usage);

  if (response.stop_reason === 'refusal') return null;
  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) return null;
  try {
    const parsed = JSON.parse(textBlock.text);
    return {
      is_form_101: !!parsed.is_form_101,
      confidence: parsed.confidence || '',
      model: GATE_MODEL,
      usage: response.usage,
    };
  } catch {
    return null;
  }
}

/** The document/image content block for a file — shared by both stages. */
function docBlockFor(fileDataBase64, fileName, mimeType) {
  const mime = mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(fileName);
  const isPdf = mime === 'application/pdf';
  if (!isPdf && !mime.startsWith('image/')) {
    const err = new Error('סוג קובץ לא נתמך לסריקה (רק תמונה או PDF)');
    err.code = 'BAD_MIME';
    throw err;
  }
  return isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileDataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: fileDataBase64 } };
}

/**
 * @param {string} fileDataBase64  base64 (no data: prefix)
 * @param {string} fileName
 * @param {string} [mimeType]
 * @param {object} [opts]
 * @param {(model: string, usage: object) => void} [opts.onUsage]  called with the
 *   response's token usage, so a caller can price the run. Fired even when the
 *   response is unusable — those tokens were spent too.
 * @returns {Promise<object>} extracted fields (matches SCHEMA)
 */
async function scanForm101(fileDataBase64, fileName, mimeType, { onUsage } = {}) {
  if (!fileDataBase64) {
    const err = new Error('אין קובץ לסריקה');
    err.code = 'NO_FILE';
    throw err;
  }
  const docBlock = docBlockFor(fileDataBase64, fileName, mimeType);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        docBlock,
        { type: 'text', text: 'זהה/י האם זהו טופס 101 וחלץ/י את הפרטים לפי הסכימה.' },
      ],
    }],
  });

  onUsage?.(MODEL, response.usage);

  if (response.stop_reason === 'refusal') {
    const err = new Error('הסריקה נדחתה על ידי המודל');
    err.code = 'REFUSAL';
    throw err;
  }

  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock?.text) {
    const err = new Error('לא התקבל פלט מהסריקה');
    err.code = 'EMPTY';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    const err = new Error('פלט הסריקה אינו תקין');
    err.code = 'PARSE';
    throw err;
  }
  // Normalise here rather than at every call site: the id is compared against
  // Employee.israeli_id, which is stored zero-padded to 9 digits.
  if (parsed.israeli_id) {
    const digits = String(parsed.israeli_id).replace(/\D/g, '');
    parsed.israeli_id = digits.length > 0 && digits.length <= 9 ? digits.padStart(9, '0') : digits;
  }
  return parsed;
}

module.exports = { scanForm101, gateIsForm101, mimeFromName, MODEL, GATE_MODEL };
