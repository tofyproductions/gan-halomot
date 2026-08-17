import { useCallback, useEffect, useMemo, useState } from 'react';
import { createParentTheme } from './parentTheme';

/**
 * Light or dark, and who decided.
 *
 * Three states, not two. "Auto" is the default and means the phone decides —
 * which is what almost everyone wants, because a parent who has set their
 * phone to turn dark at sunset has already answered this question and should
 * not be asked again by every app they open. The explicit choices exist for
 * the minority who want this one app to differ, and they are remembered.
 *
 * The preference is stored under its own key next to the parent token, and it
 * is deliberately NOT on the server: it belongs to the phone, not to the
 * person. The same parent on a laptop at work and a phone in bed wants
 * different answers.
 */

export const PARENT_THEME_KEY = 'gan_parent_theme';
const QUERY = '(prefers-color-scheme: dark)';

/** 'auto' | 'light' | 'dark' — anything else stored is treated as auto. */
function storedPreference() {
  try {
    const v = localStorage.getItem(PARENT_THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    // Private browsing on iOS throws rather than returning null.
    return 'auto';
  }
}

export default function useParentColorMode() {
  const [preference, setPreferenceState] = useState(storedPreference);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true,
  );

  // The phone can change its mind while the app is open — at sunset, or when
  // the battery saver flips it. Without this listener the portal would stay
  // light until the next reload, which on a phone can be days.
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setPreference = useCallback((next) => {
    const clean = next === 'light' || next === 'dark' ? next : 'auto';
    setPreferenceState(clean);
    try {
      if (clean === 'auto') localStorage.removeItem(PARENT_THEME_KEY);
      else localStorage.setItem(PARENT_THEME_KEY, clean);
    } catch {
      // Nothing to do — the choice still holds for this session.
    }
  }, []);

  const mode = preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference;

  // Rebuilt only when the light actually changes. createTheme is not cheap and
  // a new theme object on every render remounts every styled component below.
  const theme = useMemo(() => createParentTheme(mode), [mode]);

  return { theme, mode, preference, setPreference };
}
