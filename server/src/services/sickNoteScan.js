/**
 * AI sick-note scanning — reads an uploaded medical certificate (image or PDF)
 * with Claude vision and extracts the sick period (dates + number of days) so
 * the accountant gets a pre-filled suggestion to confirm, instead of typing it.
 *
 * The result is ALWAYS a suggestion the accountant reviews — never auto-applied.
 * Requires ANTHROPIC_API_KEY in the environment (set in Render + local .env).
 */
const Anthropic = require('@anthropic-ai/sdk');

// Default to the most capable model; override via env for cost tuning.
const MODEL = process.env.SICK_SCAN_MODEL || 'claude-opus-4-8';

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

// Structured-output schema for the extraction. Kept to types the API supports
// (enum/string/integer/null + additionalProperties:false).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from_date: { type: ['string', 'null'], description: 'תחילת המחלה בפורמט YYYY-MM-DD, או null אם לא מופיע' },
    to_date: { type: ['string', 'null'], description: 'סוף המחלה בפורמט YYYY-MM-DD, או null אם לא מופיע' },
    total_days: { type: ['integer', 'null'], description: 'מספר ימי המחלה אם מצוין במפורש באישור, אחרת null' },
    employee_name: { type: ['string', 'null'], description: 'שם העובד/ת כפי שמופיע באישור, או null' },
    doctor_or_clinic: { type: ['string', 'null'], description: 'שם הרופא/ה או המרפאה, או null' },
    is_sick_note: { type: 'boolean', description: 'האם זהו אישור מחלה אמיתי' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'רמת הביטחון בחילוץ' },
    notes: { type: 'string', description: 'הערה קצרה בעברית על מה שזוהה / אי-ודאות' },
  },
  required: ['from_date', 'to_date', 'total_days', 'employee_name', 'doctor_or_clinic', 'is_sick_note', 'confidence', 'notes'],
};

const SYSTEM = [
  'את/ה עוזר/ת להנהלת חשבונות לקרוא אישורי מחלה (תעודת מחלה) של עובדים בישראל.',
  'חלץ/י מהמסמך את טווח תאריכי המחלה ומספר הימים. תאריכים בפורמט YYYY-MM-DD.',
  'אם באישור מצוין במפורש מספר ימים — החזר אותו ב-total_days. אם רק טווח תאריכים — השאר total_days כ-null (השרת יספור ימי עבודה).',
  'אם המסמך אינו אישור מחלה — סמן is_sick_note=false והשאר שדות כ-null.',
  'אל תמציא/י מידע. אם שדה לא מופיע בבירור — null. ציין/י אי-ודאות ב-confidence וב-notes.',
].join('\n');

/**
 * @param {string} fileDataBase64  base64 (no data: prefix)
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {Promise<object>} extracted fields (matches SCHEMA)
 */
async function scanSickNote(fileDataBase64, fileName, mimeType) {
  if (!fileDataBase64) {
    const err = new Error('אין קובץ לסריקה');
    err.code = 'NO_FILE';
    throw err;
  }
  const mime = mimeType || mimeFromName(fileName);
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
        { type: 'text', text: 'חלץ/י את פרטי אישור המחלה לפי הסכימה.' },
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
  return parsed;
}

module.exports = { scanSickNote, mimeFromName, MODEL };
