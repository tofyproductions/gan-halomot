import { createContext, useContext, useCallback, useMemo, useState, useEffect } from 'react';
import api from '../api/client';
import { useAuth } from './useAuth';

/**
 * Which interface this person sees — the old one or the redesigned one.
 *
 * The redesign is a large change to a system four gans run their day on, so
 * it does not arrive by being deployed. Every existing account stays on
 * `classic` until its owner says otherwise, is asked ONCE whether she wants to
 * try the new one, and can move back and forth afterwards from her own
 * settings. Nobody is moved for her.
 *
 * The answer lives on the USER RECORD, not in this browser. That is the whole
 * point of asking once: a manager who declined at the office desk must not be
 * asked again on her phone that evening, and one who accepted must not find
 * the old interface waiting when she opens the app somewhere else. The server
 * field is `User.ui_version` and the endpoint is PATCH /auth/ui-version.
 *
 * localStorage is used for one thing only: holding the answer across the
 * moment between the click and the server's reply, and carrying it if the
 * request fails outright. It is a cache of the person's choice, never the
 * record of it.
 */
const UiVersionContext = createContext(null);

const CACHE_KEY = 'ui_version';

function readCache() {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return v === 'new' || v === 'classic' ? v : null;
  } catch {
    // Private window, storage blocked. The server's answer is the real one
    // anyway; this only costs a flicker on a slow first load.
    return null;
  }
}

function writeCache(v) {
  try { localStorage.setItem(CACHE_KEY, v); } catch { /* see above */ }
}

export function UiVersionProvider({ children }) {
  const { user } = useAuth();

  /**
   * Three sources, in this order, and the order is the whole correctness
   * argument:
   *
   *   pending      what this person just clicked, in this session. It has to
   *                win, because `user` is fetched once at login and is not
   *                refetched when a preference is saved — so for the rest of
   *                the session the server's value as the client knows it is
   *                the OLD one, and letting it win would snap the interface
   *                straight back after the click.
   *   serverValue  the record. Beats the cache, which is what makes a switch
   *                made on the phone show up on the office PC instead of that
   *                browser's older answer overriding it.
   *   cache        only fills the gap before `user` has loaded, so a slow
   *                connection does not flash the wrong interface on the way in.
   *
   * `classic` last: somebody with no answer at all sees what they already know.
   */
  const serverValue = user?.ui_version || null;
  const [pending, setPending] = useState(null);
  const [cached] = useState(() => readCache());
  const version = pending || serverValue || cached || 'classic';

  // Once the server has spoken, the cache agrees with it.
  useEffect(() => {
    if (serverValue) writeCache(serverValue);
  }, [serverValue]);

  /**
   * Answered in THIS session, before the auth context has re-read the user.
   *
   * Same staleness as above, with a worse symptom: the offer dialog keys off
   * `ui_version_asked`, so without this it stayed on screen sitting on top of
   * the interface it had just switched to.
   */
  const [answeredHere, setAnsweredHere] = useState(false);

  const asked = answeredHere || !!user?.ui_version_asked;

  const persist = useCallback(async (body) => {
    try {
      await api.patch('/auth/ui-version', body);
      return true;
    } catch {
      /**
       * The switch still happens. A person who pressed "yes" and got a network
       * error should see the new interface — not an error about a preference —
       * and the cache carries it until the next successful save. The cost of
       * failing here is being asked again next time, which is the mild half of
       * the two ways this can be wrong.
       */
      return false;
    }
  }, []);

  const switchTo = useCallback(async (next) => {
    setPending(next);
    writeCache(next);
    setAnsweredHere(true);
    await persist({ version: next, asked: true });
  }, [persist]);

  /** Answered the offer without switching: stay classic, stop asking. */
  const declineOffer = useCallback(async () => {
    setPending('classic');
    writeCache('classic');
    setAnsweredHere(true);
    await persist({ version: 'classic', asked: true });
  }, [persist]);

  const value = useMemo(() => ({
    version,
    isNew: version === 'new',
    asked,
    /** Ask exactly once, and only somebody who is actually logged in. */
    shouldOffer: !!user && !asked,
    switchTo,
    declineOffer,
  }), [version, asked, user, switchTo, declineOffer]);

  return <UiVersionContext.Provider value={value}>{children}</UiVersionContext.Provider>;
}

export function useUiVersion() {
  const ctx = useContext(UiVersionContext);
  if (!ctx) throw new Error('useUiVersion must be used within UiVersionProvider');
  return ctx;
}
