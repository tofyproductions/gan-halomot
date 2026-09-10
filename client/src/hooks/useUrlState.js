import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A piece of screen state that lives in the address bar.
 *
 * Filters, searches and the selected month were held in `useState` on every
 * screen, and the cost of that is not mainly the reload. It is that "the eleven
 * employees missing a bank account" or "September, כפר סבא, the four with a
 * missing punch-out" was a thing you could see and not a thing you could send:
 * a colleague had to be told in words which boxes to tick. A URL is the one
 * format everybody in the office already knows how to forward.
 *
 * Deliberate choices:
 *
 * - `replace: true`. Typing seven characters in a search box must not become
 *   seven presses of the back button before you can leave the screen. A filter
 *   is where you are, not somewhere you went.
 * - An empty value deletes the parameter. `?q=&archived=0` is a URL that says
 *   nothing while looking like it says something, and it is what gets pasted
 *   into a chat.
 * - The setter takes a value, never an updater function. `setX(v => !v)` would
 *   be written into the URL as the literal function — silently, since a URL
 *   parameter accepts any string. Callers pass `!current`.
 *
 * Returns [value, setValue] so it reads like the useState it replaces.
 */
export function useUrlState(key, fallback = '') {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw == null ? fallback : raw;

  const setValue = useCallback((next) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === '' || next == null || next === fallback) p.delete(key);
      else p.set(key, String(next));
      return p;
    }, { replace: true });
  }, [key, fallback, setParams]);

  return [value, setValue];
}

/**
 * The same, for a checkbox. Present and '1' is on; absent is off — so an
 * untouched filter leaves no trace in the URL at all.
 */
export function useUrlFlag(key) {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) === '1';

  const setValue = useCallback((next) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set(key, '1');
      else p.delete(key);
      return p;
    }, { replace: true });
  }, [key, setParams]);

  return [value, setValue];
}
