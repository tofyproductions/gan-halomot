/**
 * לכווץ את התמונה בטלפון, לפני שהיא עוזבת אותו — ולהמיר HEIC ל-JPEG.
 *
 * שתי סיבות, ושתיהן נמדדו:
 *
 * 1. נפח. הטלפון שולח 955KB לתמונה והשרת מכווץ ל-318KB, כלומר שני שלישים
 *    מהבייטים עולים ברשת רק כדי להיזרק בצד השני. על 50 תמונות זה 46MB במקום
 *    15MB, ועל וויפי של גן זה ההפרש בין 47 שניות ל-16.
 *
 * 2. **HEIC.** זו הסיבה החשובה יותר. אייפון מצלם ב-HEIC, והספרייה שקוראת
 *    תמונות בשרת פשוט **לא מצליחה לפתוח** קובץ HEIC של אייפון מודרני:
 *
 *        heif: Security limit exceeded:
 *        Number of references in iref box (45) exceeds the limit of 16
 *
 *    תמונה מאייפון נושאת מפת HDR, מפת עומק וגרסאות נגזרות — יותר הפניות ממה
 *    שהמגבלה בספרייה מרשה. נבדקו שמונה קבצים מאייפון אמיתי: **שמונה מתוך
 *    שמונה נכשלו.** כלומר כל העלאה של תמונה מאייפון שלא הומרה בדרך פשוט
 *    נכשלת, עם "לא הצלחנו לעבד את הקובץ" ובלי שום רמז למה.
 *
 *    אין דרך להעלות את המגבלה מהשרת. לכן ההמרה כאן היא לא אופטימיזציה — היא
 *    מה שמאפשר לגננת עם אייפון להעלות תמונה בכלל.
 *
 * הגדלים חייבים להיות זהים ל-photo.service בשרת: גדול יותר כאן = דחיסה
 * כפולה, קטן יותר = איכות שאבדה ולא תחזור, כי המקור נזרק בכוונה.
 */
const MAX = 1600;
const QUALITY = 0.82;

// מתחת לזה אין מה להרוויח בנפח — אבל HEIC תמיד עובר המרה, בלי קשר לגודל,
// כי שם זה לא נפח אלא האם הקובץ קריא בכלל.
const SKIP_UNDER_BYTES = 400 * 1024;

const HEIC = /(^image\/(heic|heif))|(\.(heic|heif)$)/i;

/** האם זו תמונה שהשרת לא יוכל לקרוא בלי המרה. */
export function needsConversion(file) {
  return HEIC.test(file.type || '') || HEIC.test(file.name || '');
}

/** האם הדפדפן הזה יודע לעשות את זה בכלל. */
export function canCompress() {
  return typeof createImageBitmap === 'function'
    && typeof document !== 'undefined'
    && !!document.createElement('canvas').getContext;
}

async function toJpeg(file) {
  // `from-image` מחיל את תג הסיבוב של EXIF. בלעדיו תמונה שצולמה לאורך נשלחת
  // שוכבת על הצד — וזו בדיוק הבעיה ש-photo.service מטפל בה בשרת עם rotate(),
  // ושם כבר אי אפשר לתקן כי המידע נמחק.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', QUALITY);
  });
  if (!blob) throw new Error('canvas produced nothing');

  // הקנבס מוחק את כל המטא-דאטה, וזה רצוי: תמונה מהטלפון נושאת קואורדינטות
  // GPS, ואלה תמונות של ילדים בכתובת שהגן לא מפרסם.
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

/**
 * מקבל File ומחזיר `{ file, converted, error }`.
 *
 * `error` מלא רק כשהקובץ **חייב** המרה ולא הצלחנו — HEIC בדפדפן שלא יודע
 * לפענח אותו, למשל כרום במחשב. במקרה הזה אסור להעלות אותו בשקט: השרת ידחה
 * אותו בכל מקרה, והגננת תראה "לא הצלחנו לעבד את הקובץ" בלי להבין שהבעיה היא
 * סוג הקובץ ושיש לה פתרון.
 */
export async function compressImage(file) {
  const must = needsConversion(file);

  if (!canCompress()) {
    return must
      ? { file, error: 'הדפדפן הזה לא יודע להמיר קובצי HEIC' }
      : { file };
  }
  if (!must && !/^image\//.test(file.type)) return { file };
  if (!must && file.size <= SKIP_UNDER_BYTES) return { file };

  try {
    const out = await toJpeg(file);
    // לקובץ רגיל — אם ההמרה לא הקטינה, עדיף המקור. ל-HEIC אין ברירה: המקור
    // לא קריא בשרת בכלל, אז הגרסה החדשה עדיפה תמיד.
    if (!must && out.size >= file.size) return { file };
    return { file: out, converted: true };
  } catch (e) {
    if (must) {
      return {
        file,
        error: 'לא הצלחנו להמיר את הקובץ מ-HEIC. אפשר להעביר את הצילום ל-JPEG '
          + 'בהגדרות המצלמה (מצלמה ← פורמטים ← תואם ביותר) ולנסות שוב.',
      };
    }
    return { file };
  }
}

export const COMPRESS_MAX = MAX;
