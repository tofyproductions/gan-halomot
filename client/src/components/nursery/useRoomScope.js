import { useState, useEffect, useMemo, useRef } from 'react';
import { useBranch } from '../../hooks/useBranch';

/**
 * הבחירה המשותפת של סניף וכיתה — לגלריה ולטאב "מי זה?" גם יחד.
 *
 * שני המסכים סבלו מאותה בעיה: בורר הכיתות הציג כל חדר של כל סניף
 * ("תל אביב — תינוקיה", כפילויות בין סניפים), גם כששורת העליון כבר נעולה על
 * סניף מסוים. הכלל הוא פשוט אבל צריך להיות זהה בשני המקומות:
 *
 * - כששורת העליון על סניף (`!isAllBranches`): הבחירה נעולה לאותו סניף.
 *   `branchId` עוקב אחרי `selectedBranch` ואי אפשר לשנות אותו מכאן.
 * - כששורת העליון על 'כל הסניפים': יש לבחור סניף במפורש, מתוך הסניפים
 *   שבאמת מופיעים ברשימת הכיתות (לא כל סניף שקיים במערכת — רק כאלה שיש
 *   להם כיתות שהמשתמש רואה).
 *
 * מעבר סניף — משורת העליון או מהבורר עצמו — מאפס את הכיתה לראשונה ברשימה
 * של הסניף החדש: כיתה מסניף קודם היא בחירה שכבר לא שייכת לכלום.
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

  const branchLocked = !isAllBranches;
  const lockedBranchId = branchLocked ? String(selectedBranch || '') : '';

  const [freeBranchId, setFreeBranchId] = useState('');
  const branchId = branchLocked ? lockedBranchId : freeBranchId;

  // ב'כל הסניפים' צריך ברירת מחדל: הסניף הראשון שיש לו כיתות ברשימה. גם אם
  // הבחירה הקודמת נעלמה (כיתה שהתבטלה, מעבר משתמש) — לא נשארים תקועים על
  // סניף ריק.
  useEffect(() => {
    if (branchLocked) return;
    if (!freeBranchId || !branchOptions.some((b) => b.id === freeBranchId)) {
      setFreeBranchId(branchOptions[0]?.id || '');
    }
    /* eslint-disable-next-line */
  }, [branchLocked, branchOptions]);

  const roomsOfBranch = useMemo(
    () => list.filter((r) => String(r.branch_id || '') === branchId),
    [list, branchId],
  );

  const [classroomId, setClassroomId] = useState('');
  // איזה branchId כבר קיבל בחירת-ברירת-מחדל לכיתה. בלי זה, כל טעינה מחדש של
  // רשימת החדרים הייתה דורסת בחירה מפורשת של "כל הכיתות של הסניף" (ערך '')
  // בטאב "מי זה?" בחזרה לחדר הראשון.
  const initializedBranch = useRef(null);

  useEffect(() => {
    if (!branchId) return;
    if (initializedBranch.current === branchId) return;
    // עוד לא נטענה אף כיתה בכלל — עדיף לחכות לריצה הבאה מאשר לנעול '' כברירת
    // מחדל לפני שידוע אם יש לסניף הזה כיתות.
    if (!list.length) return;
    initializedBranch.current = branchId;
    setClassroomId(roomsOfBranch.length ? String(roomsOfBranch[0].id) : '');
  }, [branchId, roomsOfBranch, list.length]);

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
  };
}
