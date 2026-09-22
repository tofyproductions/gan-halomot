/**
 * The words and the colours on דף הדרושים.
 *
 * Copy lifted verbatim from the page the Facebook campaign has been running
 * against — it was written for those ads and changing it while moving the
 * page would make the move impossible to judge.
 *
 * The branch cards are CONTENT rather than a fetch. They carry a manager's
 * name and her mobile number, and a public endpoint that lists those is a
 * staff directory anyone can scrape; the page has published them for a year,
 * which is not the same thing as building an API for them. They change about
 * once a year, and the branch DROPDOWN in the form is read from the database,
 * so a new branch can take applications the day it opens either way.
 */

/** The brand's palette. Deliberately not theme/tokens.js — see CareersPage. */
export const BRANDS = {
  primary: '#6c5ce7',
  ink: '#2d3436',
  muted: '#5b6668',
  pageBg: 'linear-gradient(180deg, #ffffff 0%, #fdf7fb 45%, #fff4f1 100%)',
  tintBg: 'linear-gradient(180deg, rgba(108,92,231,.05), rgba(253,121,168,.05))',
  hero: 'linear-gradient(135deg, #6c5ce7 0%, #a55eea 42%, #fd79a8 74%, #ff7675 100%)',
  rule: 'linear-gradient(90deg, #6c5ce7, #fd79a8, #ff7675)',
  ribbonBg: 'rgba(255,255,255,.82)',
  glass: 'rgba(255,255,255,.72)',
  glassEdge: 'rgba(255,255,255,.55)',
  shadow: '0 8px 32px 0 rgba(31,38,135,.10)',
  waBtn: 'linear-gradient(135deg, #25d366, #128c7e)',
  officeBtn: 'linear-gradient(135deg, #0984e3, #6c5ce7)',
  footer: 'linear-gradient(135deg, #6c5ce7, #fd79a8)',
};

export const PERKS = [
  {
    icon: '🛡️', title: 'ביטחון ויציבות',
    body: 'סביבת עבודה בטוחה, תנאים סוציאליים מלאים ושכר מתגמל.',
  },
  {
    icon: '❤️', title: 'משפחה חמה',
    body: 'צוות תומך ומגובש, יחס אישי ואווירה של בית אמיתי לצוות ולילדים.',
  },
  {
    icon: '🌱', title: 'צמיחה והתפתחות',
    body: 'הדרכות מקצועיות, ליווי פדגוגי צמוד ואפשרויות קידום למתאימות.',
  },
  {
    icon: '✨', title: 'שליחות אמיתית',
    body: 'הזדמנות להשפיע ולעצב את עולמם של הקטנטנים בגילאים הכי משמעותיים (0-3).',
  },
];

export const ROLES = [
  {
    icon: '👑', title: 'מובילת כיתה',
    body: 'גננת או מטפלת מוסמכת עם ניסיון, יכולת הובלה, ראש גדול ויחסי אנוש מעולים. '
      + 'אם את יודעת לנהל כיתה באהבה ובמקצועיות — מקומך איתנו.',
  },
  {
    icon: '🤗', title: 'מטפלת / סייעת',
    body: 'חמה, אוהבת ומסורה שרוצה להעניק חום ואהבה לקטנטנים. סבלנות, רגישות ויכולת '
      + 'עבודה בצוות הן מילות המפתח. הניסיון יתרון, הלב חובה!',
  },
];

export const GALLERY = [
  { src: '/careers/team.webp', alt: 'צוות גן החלומות בפעילות עם הילדים', caption: 'הנבחרת שלנו – משפחה אחת גדולה' },
  { src: '/careers/activity.webp', alt: 'ילד בפעילות חושית בגן', caption: 'לומדים ונהנים מכל רגע' },
  { src: '/careers/space.webp', alt: 'חגיגה בגן', caption: 'חוגגים ביחד כל רגע' },
];

/** wa.me wants a country-code number and a pre-written first message. */
const wa = (num, text) => `https://wa.me/${num}?text=${encodeURIComponent(text)}`;

export const CONTACTS = [
  {
    name: 'סניף כפר סבא',
    manager: 'מנהלת: לידור כהן',
    phone: '054-3599422',
    tel: '+972543599422',
    address: 'משה דיין 9 / שאול המלך 5',
    cta: 'דברו איתי בוואטסאפ',
    whatsapp: wa('972543599422', 'הי לידור, אני מתעניין/ת במשרת גיוס לסניף כפר סבא'),
  },
  {
    name: 'סניף הרצליה',
    manager: 'מנהלת: טובה אהרון',
    phone: '050-7227800',
    tel: '+972507227800',
    address: 'הרצוג 5, הרצליה',
    cta: 'דברו איתי בוואטסאפ',
    whatsapp: wa('972507227800', 'הי טובה, אני מתעניין/ת במשרת גיוס לסניף הרצליה'),
  },
  {
    name: 'סניף תל אביב',
    manager: 'מנהל: אלעד בורקוב',
    phone: '054-5243288',
    tel: '+972545243288',
    address: 'אייזיק חריף 21, תל אביב',
    cta: 'דברו איתי בוואטסאפ',
    whatsapp: wa('972545243288', 'הי אלעד, אני מתעניין/ת במשרת גיוס לסניף תל אביב'),
  },
  {
    name: 'המשרד הראשי',
    manager: 'מנהלת: אורלי',
    phone: '052-9480580',
    tel: '+972529480580',
    address: 'מענה כללי ומידע נוסף',
    cta: 'צרו קשר עם המשרד',
    office: true,
    whatsapp: wa('972529480580', 'הי אורלי, אני מתעניין/ת במשרת גיוס לגן החלומות'),
  },
];
