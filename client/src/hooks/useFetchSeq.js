import { useRef, useCallback, useMemo } from 'react';

/**
 * Guard against a SLOW OLD response landing after a FAST NEW one.
 *
 * The bug it kills: the accountant flips May→June while May (slow, whole
 * network) is still in flight; June's answer arrives first, then May's lands
 * and the table silently shows May's salaries under a header that says June.
 * It never self-corrects, and nothing looks wrong.
 *
 * Pattern (lifted from PhotosManager, where this class of bug first bit):
 *
 *   const { begin, isCurrent } = useFetchSeq();
 *   const load = () => {
 *     const seq = begin();                      // I am now the newest request
 *     api.get(...).then(res => {
 *       if (!isCurrent(seq)) return;            // a newer one exists — drop me
 *       setData(res.data);
 *     });
 *   };
 *
 * One instance guards one data stream. A component with two independent
 * fetches should call useFetchSeq twice.
 */
export default function useFetchSeq() {
  const seqRef = useRef(0);
  const begin = useCallback(() => ++seqRef.current, []);
  const isCurrent = useCallback((seq) => seqRef.current === seq, []);
  // MEMOIZED, and this is load-bearing: consumers put this object in their
  // useCallback deps, and their fetch runs from useEffect([fetchData]). A
  // fresh object every render gave fetchData a fresh identity every render —
  // which re-fired the effect, which set state, which rendered… an infinite
  // fetch loop that pinned the payroll table on its spinner in production.
  return useMemo(() => ({ begin, isCurrent }), [begin, isCurrent]);
}
