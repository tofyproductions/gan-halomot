/**
 * לכווץ את התמונה בטלפון, לפני שהיא עוזבת אותו.
 *
 * היום הטלפון שולח 955KB לתמונה והשרת מכווץ אותה ל-318KB — כלומר שני שלישים
 * מהבייטים עולים ברשת רק כדי להיזרק בצד השני. על 50 תמונות זה 46MB במקום
 * 15MB, ועל וויפי של גן זו ההפרש בין 47 שניות ל-16.
 *
 * הגדלים כאן חייבים להיות זהים ל-photo.service בשרת. הם לא "בערך אותו דבר":
 * אם הלקוח שולח משהו גדול יותר, השרת יכווץ שוב ונקבל דחיסה כפולה — ואם קטן
 * יותר, איבדנו איכות שאי אפשר להחזיר, כי המקור נזרק בכוונה.
 */
const MAX = 1600;
const QUALITY = 0.82;

// מתחת לזה אין מה להרוויח: הקובץ כבר קטן מהתוצאה של הכיווץ, וכל מעבר נוסף
// רק יאבד איכות.
const SKIP_UNDER_BYTES = 400 * 1024;

/** האם הדפדפן הזה יודע לעשות את זה בכלל. */
export function canCompress() {
  return typeof createImageBitmap === 'function'
    && typeof document !== 'undefined'
    && !!document.createElement('canvas').getContext;
}

/**
 * מקבל File ומחזיר File מכווץ — או את המקור, אם אין מה לשפר.
 *
 * לעולם לא זורק. כישלון בכיווץ הוא לא סיבה שלא להעלות תמונה; במקרה הגרוע
 * היא פשוט תעלה בגודל המקורי והשרת יכווץ אותה כמו קודם.
 */
export async function compressImage(file) {
  if (!canCompress()) return file;
  if (!/^image\//.test(file.type)) return file;
  if (file.size <= SKIP_UNDER_BYTES) return file;

  try {
    // `from-image` מחיל את תג הסיבוב של EXIF. בלעדיו תמונה שצולמה לאורך
    // נשלחת שוכבת על הצד — וזו בדיוק הבעיה ש-photo.service מטפל בה בשרת
    // עם rotate(), ושם אנחנו כבר לא יכולים לתקן כי המידע נמחק.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', QUALITY);
    });
    if (!blob || blob.size >= file.size) return file;

    // הקנבס מוחק את כל המטא-דאטה, וזה רצוי: תמונה מהטלפון נושאת קואורדינטות
    // GPS, ואלה תמונות של ילדים בכתובת שהגן לא מפרסם.
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

export const COMPRESS_MAX = MAX;
