/**
 * להכין תמונה לשליחה: להקטין, ולהמיר HEIC ל-JPEG — בלי לוותר על אף קובץ.
 *
 * שתי סיבות, ושתיהן נמדדו.
 *
 * 1. נפח. הטלפון שולח 955KB לתמונה והשרת מכווץ ל-318KB, כלומר שני שלישים
 *    מהבייטים עולים ברשת רק כדי להיזרק. על 50 תמונות זה 46MB במקום 15.
 *
 * 2. **HEIC — וזו הסיבה שבלעדיה אין פיצ'ר.** אייפון מצלם ב-HEIC, והספרייה
 *    שקוראת תמונות בשרת פשוט לא פותחת קובץ כזה מאייפון מודרני:
 *
 *        heif: Security limit exceeded:
 *        Number of references in iref box (45) exceeds the limit of 16
 *
 *    תמונה מאייפון נושאת מפת HDR, מפת עומק וגרסאות נגזרות. נבדקו שמונה
 *    קבצים אמיתיים — שמונה מתוך שמונה נכשלו. אין דרך להעלות את המגבלה
 *    מהשרת, ולכן ההמרה כאן היא לא אופטימיזציה: היא מה שמאפשר להעלות תמונה
 *    מאייפון בכלל.
 *
 * שני מסלולי פענוח, ולא במקרה:
 *
 *   `createImageBitmap` — מה שהדפדפן יודע לבד. בספארי, שזה מה שרץ בתוך
 *   האפליקציה, הוא פותח HEIC של 4284x5712 ב-221ms. מהיר, ובלי להוריד כלום.
 *
 *   `heic-to` — libheif מקומפל ל-WASM, שנטען **רק** כשהראשון נכשל. בכרום
 *   `createImageBitmap` לא מפענח HEIC בכלל, ושם זה ההבדל בין עובד ללא עובד:
 *   אותו קובץ, 2140ms, ויוצא תקין. נטען בייבוא עצל כדי שהמגה-בייטים שלו לא
 *   ייכנסו למסלול הקריטי של מי שלא נגע בתמונה.
 *
 * הגדלים חייבים להיות זהים ל-photo.service בשרת: גדול יותר כאן = דחיסה
 * כפולה, קטן יותר = איכות שאבדה ולא תחזור, כי המקור נזרק בכוונה.
 */
const MAX = 1600;
const QUALITY = 0.82;

// מתחת לזה אין מה להרוויח בנפח — אבל HEIC תמיד עובר המרה, בלי קשר לגודל,
// כי שם השאלה היא לא נפח אלא האם הקובץ קריא בשרת בכלל.
const SKIP_UNDER_BYTES = 400 * 1024;

const HEIC = /(^image\/(heic|heif))|(\.(heic|heif)$)/i;

/** קובץ שהשרת לא יוכל לקרוא בלי המרה. */
export function needsConversion(file) {
  return HEIC.test(file.type || '') || HEIC.test(file.name || '');
}

export function canCompress() {
  return typeof createImageBitmap === 'function'
    && typeof document !== 'undefined'
    && !!document.createElement('canvas').getContext;
}

/** קנבס -> JPEG בגודל היעד. */
async function encode(bitmap, name, lastModified) {
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((r) => { canvas.toBlob(r, 'image/jpeg', QUALITY); });
  if (!blob) throw new Error('canvas produced nothing');

  // הקנבס מוחק את כל המטא-דאטה, וזה רצוי: תמונה מהטלפון נושאת קואורדינטות
  // GPS, ואלה תמונות של ילדים בכתובת שהגן לא מפרסם.
  return new File([blob], `${name.replace(/\.[^.]+$/, '')}.jpg`, {
    type: 'image/jpeg',
    lastModified,
  });
}

/**
 * הדרך האיטית, שעובדת תמיד.
 *
 * מיובא עצלנית ורק כשצריך — הספרייה היא libheif ב-WASM, כמה מגה-בייטים,
 * ואין שום סיבה שמי שמעלה JPEG ישלם עליהם.
 */
async function decodeWithWasm(file) {
  const { heicTo } = await import('heic-to');
  // יוצא בגודל מלא; ההקטנה נעשית אחר כך באותו מסלול כמו כל תמונה אחרת.
  const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  return createImageBitmap(jpeg);
}

/**
 * מקבל File ומחזיר `{ file, converted, error }`.
 *
 * `error` נשאר ריק כמעט תמיד: בין שני מסלולי הפענוח, קובץ שבאמת לא ניתן
 * לפתיחה הוא קובץ פגום. אם בכל זאת — מחזירים את המקור עם הסבר, ולא זורקים
 * את התמונה של הגננת.
 */
export async function compressImage(file) {
  const must = needsConversion(file);

  if (!canCompress()) return { file };
  if (!must && !/^image\//.test(file.type)) return { file };
  if (!must && file.size <= SKIP_UNDER_BYTES) return { file };

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = null;
  }

  if (!bitmap && must) {
    try {
      bitmap = await decodeWithWasm(file);
    } catch (e) {
      return {
        file,
        error: `לא הצלחנו לקרוא את ${file.name}. ייתכן שהקובץ פגום.`,
      };
    }
  }
  if (!bitmap) return { file };

  try {
    const out = await encode(bitmap, file.name, file.lastModified);
    // לקובץ רגיל — אם לא הרווחנו, עדיף המקור. ל-HEIC אין ברירה: המקור לא
    // קריא בשרת בכלל.
    if (!must && out.size >= file.size) return { file };
    return { file: out, converted: true };
  } catch {
    return { file };
  }
}

export const COMPRESS_MAX = MAX;
