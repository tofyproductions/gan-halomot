const { ChildFaceReference } = require('../models');

/**
 * מחיקת תמונה מוחקת גם את מה שנלמד ממנה.
 *
 * לאורך כל הפיצ'ר הקו הוא שהתמונה היא תמונה והטביעה היא המידע הרגיש — 512
 * מספרים שמתארים את הפנים של קטין, ושנשמרים רק משום שהורה סימן תיבה. ובכל
 * זאת עד כאן הטביעה שרדה את התמונה שיצרה אותה: היא ירדה רק כשהילד עצמו עזב
 * את הגן, כלומר עד שנתיים אחרי שמישהו לחץ "מחק".
 *
 * זה סותר את מה שכל מי שלוחץ מניח. גננת שמוחקת תמונה, והורה שמבקש שתימחק,
 * שניהם מתכוונים גם לזה — ודווקא כאן זה החלק שבאמת חשוב.
 *
 * אז כל מקום שמוחק תמונה קורא לכאן. הטביעה כבר נושאת `source_photo`, אז זו
 * שאילתה אחת, ואין לה בייטים באחסון להשאיר מאחור: השורה היא הנתון.
 */
async function forgetPhotos(photoIds) {
  const ids = (photoIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const res = await ChildFaceReference.deleteMany({ source_photo: { $in: ids } });
  return res.deletedCount || 0;
}

module.exports = { forgetPhotos };
