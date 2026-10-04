import { useMemo, useSyncExternalStore } from 'react';
import { createTheme } from '@mui/material/styles';
import { createParentTheme } from './parentTheme';
import { TYPE } from './tokens';

/**
 * Night mode for לוח יומי, and only for it.
 *
 * The staff asked for it in the room: the board stays open on a tablet all
 * day, the infant rooms are dimmed for the naps, and a white screen is the
 * brightest thing in a dark room. The rest of the staff app is office work in
 * daylight and has no such ask, so the dark theme is scoped to this screen
 * rather than added to every theme the app ships.
 *
 * The palette is the parent portal's dark one, which was already designed and
 * measured — no second set of dark colours to drift apart from the first. What
 * the board needs on top of it is the staff `soft` / `softOn` pairs its cards
 * are written against, and the staff typeface, so the screen does not change
 * font when the light goes out.
 *
 * The choice is per device, not per person: the classroom tablet is shared
 * and stays dark for whoever picks it up; the office computer stays light.
 * Two states only — "follow the system" means nothing on a kiosk tablet whose
 * system setting nobody in the room has ever seen.
 */
export const BOARD_THEME_KEY = 'gan_board_theme';
const EVENT = 'gan-board-theme';

function read() {
  try {
    return localStorage.getItem(BOARD_THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // Private browsing on iOS throws rather than returning null.
    return 'light';
  }
}

// One store, several readers: the kiosk page paints its own background and
// the board inside it holds the switch, and both must flip together.
function subscribe(cb) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function setBoardMode(mode) {
  try { localStorage.setItem(BOARD_THEME_KEY, mode === 'dark' ? 'dark' : 'light'); } catch { /* not saved — still flips for this visit */ }
  window.dispatchEvent(new Event(EVENT));
}

let darkTheme = null;
function boardDarkTheme() {
  if (darkTheme) return darkTheme;
  const base = createParentTheme('dark');
  const p = base.palette;
  const heading = { fontFamily: TYPE.fontFamily };
  darkTheme = createTheme(base, {
    palette: {
      // Tinted ground + light ink: the dark-mode reading of a soft pair.
      primary: { soft: '#2E2014', softOn: '#F7B674' },
      success: { soft: p.success.light, softOn: '#A9D8B8' },
      warning: { soft: p.warning.light, softOn: '#F0C98A' },
      error: { soft: p.error.light, softOn: '#F5B5AF', light: '#8C4A44' },
      info: { soft: p.info.light, softOn: '#B5D0EC' },
    },
    typography: {
      fontFamily: TYPE.fontFamily,
      h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
    },
  });
  return darkTheme;
}

/** { mode, dark, theme, toggle } — `theme` is null in light mode: keep the app's own. */
export function useBoardColorMode() {
  const mode = useSyncExternalStore(subscribe, read, () => 'light');
  const dark = mode === 'dark';
  return useMemo(() => ({
    mode,
    dark,
    theme: dark ? boardDarkTheme() : null,
    toggle: () => setBoardMode(dark ? 'light' : 'dark'),
  }), [mode, dark]);
}
