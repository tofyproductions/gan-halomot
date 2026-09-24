import { useState, useEffect, useMemo } from 'react';
import { useBranch } from '../../hooks/useBranch';

/**
 * הבחירה המשותפת של סניף וכיתה — לגלריה ולטאב "מי זה?" גם יחד.
 *
 * שני המסכים סבלו מאותה בעיה: בורר הכיתות הציג כל חדר של כל סניף
 * ("תל אביב — תינוקיה", כפילויות בין סניפים), גם כששורת העליון כבר נעולה על
 * סניף מסוים. הכלל הוא פשוט אבל צריך להיות זהה בשני המקומות:
 *
 * - כששורת העליון על סניף שבאמת יש בו כיתות למשתמש הזה: הבחירה נעולה
 *   לאותו סניף. `branchId` עוקב אחרי `selectedBranch` ואי אפשר לשנות אותו
 *   מכאן.
 * - אחרת — גם כששורת העליון על 'כל הסניפים', וגם כשהיא על סניף שהמשתמש
 *   הזה בכלל לא רואה בו כיתות (בדיוק התקלה עם `managed_branch_ids` שכבר
 *   קרתה: `branch_id` של גננת לא תואם לכיתה שהיא משוייכת אליה, ונעילה
 *   עיוורת הייתה מראה לה מסך ריק בלי דרך לצאת ממנו) — יש בורר סניף מפורש,
 *   מתוך הסניפים שבאמת יש להם כיתות ברשימה הזאת. גננת שהכיתות שלה פרוסות
 *   על שני סניפים רואה את שניהם.
 *
 * מעבר סניף — משורת העליון או מהבורר עצמו — מאפס את הכיתה לראשונה ברשימה
 * של הסניף החדש: כיתה מסניף קודם היא בחירה שכבר לא שייכת לכלום.
 *
 * `ready` הוא התנאי לשליחת בקשה: נטענה רשימת החדרים, ונבחרה עבורה ברירת
 * מחדל (סניף+כיתה) — לא לפני. בלעדיו מסך שמזמין תור ברגע הראשון, לפני
 * שידוע איזה סניף בכלל רלוונטי, שולח בקשה ל"כל הכיתות שהמשתמש רואה בכל
 * סניף" ומקבל תשובה שלא שייכת לכלום.
 */
export default function useRoomScope(rooms) {
  const { selectedBranch, isAllBranches, branches } = useBranch();
  const list = rooms || [];

  const branchOptions = useMemo(() => {
    const seen = new Map();
    list.forEach((r) => {
      const id = String(r.branch_id || '');
      if (id && !seen.has(id)) seen.set(id, { id, name: r.branch || '' });
    });
    return [...seen.values()];
  }, [list]);

  const selectedBranchStr = String(selectedBranch || '');
  const branchLocked = !isAllBranches
    && branchOptions.some((b) => b.id === selectedBranchStr);
  const lockedBranchId = branchLocked ? selectedBranchStr : '';

  const [freeBranchId, setFreeBranchId] = useState('');
  const branchId = branchLocked ? lockedBranchId : freeBranchId;

  // ברירת מחדל כשלא נעולים: הסניף של שורת העליון אם הוא בכלל אחת
  // האפשרויות (מקרה שממילא היה ננעל, אלא אם isAllBranches), אחרת הראשון
  // ברשימה. גם אם הבחירה הקודמת נעלמה (כיתה שהתבטלה, מעבר משתמש) — לא
  // נשארים תקועים על סניף שכבר לא קיים.
  useEffect(() => {
    if (branchLocked) return;
    if (freeBranchId && branchOptions.some((b) => b.id === freeBranchId)) return;
    const fallback = branchOptions.some((b) => b.id === selectedBranchStr)
      ? selectedBranchStr
      : (branchOptions[0]?.id || '');
    setFreeBranchId(fallback);
    /* eslint-disable-next-line */
  }, [branchLocked, branchOptions, selectedBranchStr]);

  const roomsOfBranch = useMemo(
    () => list.filter((r) => String(r.branch_id || '') === branchId),
    [list, branchId],
  );

  const [classroomId, setClassroomId] = useState('');
  // איזה branchId כבר קיבל בחירת-ברירת-מחדל לכיתה (state ולא ref: `ready`
  // למטה חייב להגיב לזה). בלי זה, כל טעינה מחדש של רשימת החדרים הייתה
  // דורסת בחירה מפורשת של "כל הכיתות של הסניף" (ערך '') בטאב "מי זה?"
  // בחזרה לחדר הראשון.
  const [readyBranch, setReadyBranch] = useState(null);

  useEffect(() => {
    if (!branchId) return;
    if (readyBranch === branchId) return;
    // עוד לא נטענה אף כיתה בכלל — עדיף לחכות לריצה הבאה מאשר לנעול '' כברירת
    // מחדל לפני שידוע אם יש לסניף הזה כיתות.
    if (!list.length) return;
    setReadyBranch(branchId);
    setClassroomId(roomsOfBranch.length ? String(roomsOfBranch[0].id) : '');
  }, [branchId, roomsOfBranch, list.length, readyBranch]);

  const ready = Boolean(branchId) && readyBranch === branchId;

  const branchName = (branchLocked
    ? branches.find((b) => String(b._id || b.id) === lockedBranchId)?.name
    : null)
    || branchOptions.find((b) => b.id === branchId)?.name
    || '';

  return {
    branchOptions,
    branchId,
    setBranchId: setFreeBranchId,
    classroomId,
    setClassroomId,
    roomsOfBranch,
    branchLocked,
    branchName,
    ready,
  };
}
