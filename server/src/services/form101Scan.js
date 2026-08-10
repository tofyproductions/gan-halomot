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

/**
 * @param {string} fileDataBase64  base64 (no data: prefix)
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {Promise<object>} extracted fields (matches SCHEMA)
 */
async function scanForm101(fileDataBase64, fileName, mimeType) {
  if (!fileDataBase64) {
    const err = new Error('אין קובץ לסריקה');
    err.code = 'NO_FILE';
    throw err;
  }
  const mime = mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(fileName);
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  if (!isPdf && !isImage) {
    const err = new Error('סוג קובץ לא נתמך לסריקה (רק תמונה או PDF)');
    err.code = 'BAD_MIME';
    throw err;
  }

  const docBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileDataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: fileDataBase64 } };

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

module.exports = { scanForm101, mimeFromName, MODEL };
