import api, { UPLOAD_TIMEOUT_MS } from '../api/client';
import { compressImage } from './imageCompress';

/**
 * תור העלאה שממשיך לבד — הדבר שהופך את "שלח" ל"נשלח".
 *
 * המתחרה של המסך הזה הוא ווטסאפ, ושם לחיצה על שתף מחזירה את המסך מיד. היום
 * הגננת מחכה מול פס התקדמות: 50 תמונות על וויפי של גן זה כ-75 שניות שבהן היא
 * לא יכולה לעשות שום דבר אחר. אחרי הכיווץ בטלפון זה 16 שניות — אבל 16 שניות
 * של המתנה מול מסך הן עדיין המתנה, ווטסאפ לא מבקש אפילו אחת.
 *
 * אז התור הזה:
 *   - מקבל את הקבצים, מחזיר את המסך מיד, ומעלה ברקע
 *   - שולח תמונה אחת בכל פעם, כך שכל אחת נוחתת בנפרד ולא הכול-או-כלום
 *   - **נשמר על המכשיר**, ולכן שורד סגירה של האפליקציה וחוזר לעבוד כשפותחים
 *   - חוזר על כישלון רשת עם המתנה גדלה, במקום למחוק את העבודה
 *
 * IndexedDB ולא localStorage: זה מחזיק קבצים, ו-localStorage מחזיק מחרוזות.
 * להמיר תמונה ל-base64 כדי לדחוס אותה לתוך מכסה של 5 מגה זה איך שמאבדים
 * בוקר שלם של צילומים.
 */

const DB = 'gan-uploads';
const STORE = 'pending';
const MAX_ATTEMPTS = 5;

let db = null;
const listeners = new Set();
let pumping = false;
// כמה נחסכו בגלל שכבר היו שם, מאז הפעם האחרונה שהמסך שאל.
let duplicateCount = 0;

function open() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode) {
  return open().then((d) => d.transaction(STORE, mode).objectStore(STORE));
}

const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function all() {
  return wrap((await tx('readonly')).getAll());
}

async function put(item) {
  return wrap((await tx('readwrite')).put(item));
}

async function remove(id) {
  return wrap((await tx('readwrite')).delete(id));
}

/** מה המסך צריך לדעת: כמה ממתינות, כמה נכשלו, והאם משהו קורה עכשיו. */
async function snapshot() {
  const rows = await all();
  return {
    pending: rows.filter((r) => r.attempts < MAX_ATTEMPTS).length,
    failed: rows.filter((r) => r.attempts >= MAX_ATTEMPTS).length,
    duplicates: duplicateCount,
    busy: pumping,
    rows,
  };
}

async function announce() {
  const snap = await snapshot();
  listeners.forEach((fn) => { try { fn(snap); } catch { /* a screen that went away */ } });
}

export function subscribe(fn) {
  listeners.add(fn);
  snapshot().then(fn).catch(() => {});
  return () => listeners.delete(fn);
}

/**
 * העלאה אחת. מחזיר true אם הפריט טופל (הצליח או ויתרנו עליו).
 *
 * 4xx אינו שגיאה זמנית: קובץ פגום או הרשאה שאין לא ישתפרו בניסיון עשירי,
 * והתור חייב להתרוקן ולא להיתקע על פריט אחד לנצח.
 */
async function sendOne(item) {
  const form = new FormData();
  form.append('photos', item.file, item.name);
  form.append('classroom_id', item.classroomId);
  if (item.date) form.append('date', item.date);

  try {
    const { data } = await api.post('/photos/upload', form, { timeout: UPLOAD_TIMEOUT_MS });
    await remove(item.id);
    // אותה תמונה שכבר קיימת בכיתה אינה שגיאה — היא פשוט לא נשמרת שוב.
    // הספירה חוזרת למסך כדי שהגננת תדע למה 50 תמונות הפכו ל-47.
    if (data && data.duplicates && data.duplicates.length) duplicateCount += 1;
    return true;
  } catch (err) {
    const status = err?.response?.status;
    const permanent = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const attempts = item.attempts + 1;
    await put({
      ...item,
      attempts: permanent ? MAX_ATTEMPTS : attempts,
      last_error: err?.response?.data?.error || err.message || 'שגיאה',
      // המתנה גדלה: רשת שנפלה לרגע חוזרת, ורשת שנפלה באמת לא תתוקן בכך
      // שנציף אותה בניסיונות.
      next_try: Date.now() + (permanent ? 0 : Math.min(60000, 2000 * 2 ** item.attempts)),
    });
    return false;
  }
}

/** מרוקן את התור, אחת-אחת. בטוח לקרוא לזה כמה פעמים. */
export async function pump() {
  if (pumping) return;
  pumping = true;
  await announce();
  try {
    for (;;) {
      const rows = (await all())
        .filter((r) => r.attempts < MAX_ATTEMPTS && (!r.next_try || r.next_try <= Date.now()))
        .sort((a, b) => a.id - b.id);
      if (!rows.length) break;
      await sendOne(rows[0]);
      await announce();
    }
  } finally {
    pumping = false;
    await announce();
  }
}

/**
 * הגננת לחצה שלח.
 *
 * מכווץ, שומר, ומחזיר מיד — ההעלאה עצמה קורית אחר כך. הכיווץ הוא מה שהופך
 * 46 מגה ל-15, והוא רץ לפני השמירה כדי שגם מה שיושב בתור יהיה כבר קטן.
 */
export async function enqueue(files, { classroomId, date }) {
  duplicateCount = 0;
  const accepted = [];
  const rejected = [];

  for (const raw of files) {
    const { file, error } = await compressImage(raw);

    /**
     * קובץ שחייב המרה ולא הומר לא נכנס לתור.
     *
     * להעלות אותו בכל זאת היה מייצר שלוש נסיעות רשת שנגמרות ב"לא הצלחנו
     * לעבד את הקובץ" — הודעה שלא אומרת לגננת שהבעיה היא HEIC ושיש לה פתרון
     * בהגדרות המצלמה. עדיף להגיד לה עכשיו, לפני שהיא מחכה.
     */
    if (error) {
      rejected.push({ name: raw.name, error });
      continue;
    }

    const id = await put({
      file,
      name: file.name,
      size: file.size,
      classroomId,
      date,
      attempts: 0,
      next_try: 0,
      queued_at: Date.now(),
    });
    accepted.push(id);
  }

  await announce();
  pump().catch(() => {});
  return { queued: accepted.length, rejected };
}

/** ניסיון חוזר ידני למה שוויתרנו עליו. */
export async function retryFailed() {
  const rows = await all();
  for (const r of rows.filter((x) => x.attempts >= MAX_ATTEMPTS)) {
    await put({ ...r, attempts: 0, next_try: 0 });
  }
  await announce();
  return pump();
}

export async function discardFailed() {
  const rows = await all();
  for (const r of rows.filter((x) => x.attempts >= MAX_ATTEMPTS)) await remove(r.id);
  await announce();
}

/**
 * מה שגורם לזה להתנהג כמו ווטסאפ.
 *
 * באפליקציה: כשהיא עוברת לרקע מבקשים מהמערכת חלון זמן קצר כדי לסיים את מה
 * שבאוויר — זה מה שמכסה את "לחצתי שלח והכנסתי לכיס". כשהיא חוזרת, ממשיכים.
 * בדפדפן: ממשיכים כשהלשונית חוזרת וכשהרשת חוזרת.
 *
 * זה לא זהה לווטסאפ, שהוא אפליקציה נייטיבית עם הרשאת העלאה מתמשכת. זה מכסה
 * את המקרה שקורה בפועל — 16 שניות של העלאה — ולא מאבד כלום כשזה לא מספיק,
 * כי התור שמור על המכשיר וימשיך בפתיחה הבאה.
 */
export function startAutoResume() {
  const kick = () => { pump().catch(() => {}); };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
  }

  import('@capacitor/core').then(({ Capacitor }) => {
    if (!Capacitor?.isNativePlatform?.()) return;
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', async ({ isActive }) => {
        if (isActive) { kick(); return; }
        // ברקע: לבקש מהמערכת זמן לסיים, ולשחרר אותו ברגע שהתור התרוקן.
        try {
          const { BackgroundTask } = await import('@capawesome/capacitor-background-task');
          const taskId = await BackgroundTask.beforeExit(async () => {
            await pump().catch(() => {});
            BackgroundTask.finish({ taskId });
          });
        } catch { /* the plugin is not in this build; the queue simply waits */ }
      });
    }).catch(() => {});
  }).catch(() => {});

  kick();
}
