const { Child, ParentAccount } = require('../models');

/**
 * מי הסכים שנזהה את הילד שלו.
 *
 * זו לא בדיקה פורמלית — היא הגבול של כל הפיצ'ר. טביעת פנים היא מידע ביומטרי
 * של קטין, והדבר היחיד שמצדיק את שמירתה הוא שההורה סימן תיבה שכתוב לידה מה
 * היא עושה. ילד שההורים שלו לא סימנו פשוט לא נכנס לחישוב: לא נוצרת עבורו
 * טביעה, הוא לא מועמד להתאמה, והגלריה שלו עובדת בדיוק כמו של כולם — רק בלי
 * הסינון האוטומטי.
 *
 * ההצלבה היא דרך תעודת הזהות, כמו כל שאר הפורטל: כרטיס הילד נושא את ת"ז של
 * ההורה (ולפעמים של השני), וחשבון ההורה נושא את שלו.
 */

/** תעודות הזהות של ההורים שהסכימו. */
async function consentingIdNumbers() {
  const rows = await ParentAccount.find({ 'face_consent.given': true })
    .select('id_number').lean();
  return new Set(rows.map((r) => String(r.id_number || '').trim()).filter(Boolean));
}

/**
 * מסנן רשימת ילדים למי שמותר לזהות.
 *
 * די בהורה אחד מהשניים — הם הורים לאותו ילד, ודרישה ששניהם יסמנו הייתה
 * משביתה את הפיצ'ר עבור רוב המשפחות שבהן רק אחד פתח את האפליקציה.
 */
async function filterConsenting(childIds) {
  if (!childIds || !childIds.length) return [];
  const ids = await consentingIdNumbers();
  if (!ids.size) return [];

  const kids = await Child.find({ _id: { $in: childIds } })
    .select('_id parent_id_number parent2_id_number').lean();

  return kids
    .filter((c) => ids.has(String(c.parent_id_number || '').trim())
      || ids.has(String(c.parent2_id_number || '').trim()))
    .map((c) => c._id);
}

/** האם מותר לשמור טביעה עבור הילד הזה. */
async function mayStoreReference(childId) {
  const allowed = await filterConsenting([childId]);
  return allowed.length > 0;
}

module.exports = { consentingIdNumbers, filterConsenting, mayStoreReference };
