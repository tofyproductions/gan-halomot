import { useEffect, useRef } from 'react';

/**
 * Warn before the tab closes/refreshes while unsaved work exists.
 *
 * `isDirty` is a FUNCTION evaluated at close time (kept in a ref so the
 * listener is registered once and always reads fresh state). If it returns
 * true, the browser shows its "leave site?" dialog.
 *
 * Honest limits: this catches close/refresh/back-out-of-app. It cannot catch
 * the OS killing a background tab — only a real draft autosave can — but the
 * common loss ("closed the tab, everything gone, no warning") is covered.
 */
export default function useUnsavedChangesWarning(isDirty) {
  const fnRef = useRef(isDirty);
  fnRef.current = isDirty;
  useEffect(() => {
    const handler = (e) => {
      let dirty = false;
      try { dirty = !!fnRef.current(); } catch { dirty = false; }
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = ''; // Chrome still requires returnValue to show the dialog
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}
