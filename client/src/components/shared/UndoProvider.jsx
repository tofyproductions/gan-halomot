import { createContext, useContext, useCallback, useRef, useState, useEffect } from 'react';
import { Snackbar, Alert, Button, LinearProgress, Box } from '@mui/material';

/**
 * "Are you sure?" is the wrong question for an action that isn't dangerous.
 *
 * Three bulk actions on the payroll month — apply holiday pay, apply the
 * vacation calendar, sync approved leave requests — asked for confirmation
 * every time and were the only three in the app that also offered "אל תשאל
 * שוב". That pairing is the app telling on itself: nobody wanted the question,
 * they wanted to not have made a mistake. Those are different needs, and only
 * one of them is served by a dialog that stops the work to ask something the
 * answer to is always yes.
 *
 * So: the action reports itself immediately and RUNS after a few seconds, with
 * "בטל" in reach the whole time. Deliberately delay-then-execute rather than
 * do-then-reverse:
 *
 * - Nothing has happened yet while the window is open, so undo cannot half-fail
 *   and leave the month in a state neither the person nor the server intended.
 *   Reversing a bulk write over forty employees needs the server to support it
 *   for every action, and it does not.
 * - It costs a few seconds of latency on an action nobody watches finish.
 *
 * The window is flushed, never dropped, if the person leaves: navigating away
 * or closing the screen RUNS the pending action rather than silently discarding
 * it. Somebody who pressed "החל דמי חגים" and moved on believes they did it —
 * the one outcome worse than doing it too slowly is not doing it at all while
 * showing a message that says you did.
 */
const UndoContext = createContext(null);

const DEFAULT_DELAY = 6000;

export function UndoProvider({ children }) {
  const [pending, setPending] = useState(null); // { label, id }
  const timerRef = useRef(null);
  const actionRef = useRef(null);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    actionRef.current = null;
    setPending(null);
  }, []);

  /** Run the pending action now, if there is one. */
  const flush = useCallback(() => {
    const fn = actionRef.current;
    clear();
    if (fn) fn();
  }, [clear]);

  /**
   * A second action while one is pending flushes the first. Two overlapping
   * undo windows would need two snackbars and two timers, and the second
   * action almost always assumes the first already happened.
   */
  const undoable = useCallback(({ label, run, delayMs = DEFAULT_DELAY }) => {
    if (actionRef.current) flush();
    actionRef.current = run;
    setPending({ label, id: Date.now() });
    timerRef.current = setTimeout(() => {
      const fn = actionRef.current;
      clear();
      if (fn) fn();
    }, delayMs);
  }, [clear, flush]);

  // The tab closing is the one case that cannot be flushed — a timer does not
  // survive it and an async request started here would be cancelled. Warning is
  // the honest thing to do; there is nothing to save.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!actionRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // The provider itself unmounting means the app is going away.
      if (actionRef.current) actionRef.current();
    };
  }, []);

  return (
    <UndoContext.Provider value={{ undoable, flush, hasPending: !!pending }}>
      {children}
      <Snackbar
        open={!!pending}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        // No autoHideDuration: the timer that runs the action owns the timing,
        // and a snackbar that vanished first would leave the window open with
        // nothing on screen offering the way out.
      >
        <Alert
          severity="info"
          variant="filled"
          icon={false}
          sx={{ alignItems: 'center', minWidth: 320, pb: 0 }}
          action={
            <Button color="inherit" size="small" onClick={clear} sx={{ fontWeight: 700 }}>
              בטל
            </Button>
          }
        >
          {pending?.label}
          {/* The window, drawn. A countdown somebody cannot see is a countdown
              they will miss. */}
          <Box sx={{ mt: 0.75, mx: -2, mb: 0 }}>
            <LinearProgress
              key={pending?.id}
              variant="determinate"
              value={100}
              sx={{
                height: 3,
                bgcolor: 'transparent',
                '& .MuiLinearProgress-bar': {
                  // The bar sits on a filled info Alert, so its colour is the
                  // text colour of that surface, slightly held back.
                  bgcolor: 'info.contrastText',
                  opacity: 0.85,
                  transformOrigin: 'right',
                  animation: `undo-window ${DEFAULT_DELAY}ms linear forwards`,
                },
                '@keyframes undo-window': {
                  from: { transform: 'translateX(0)' },
                  to: { transform: 'translateX(-100%)' },
                },
                // A person who asked for less motion still needs the window;
                // they just do not need it to slide.
                '@media (prefers-reduced-motion: reduce)': {
                  '& .MuiLinearProgress-bar': { animation: 'none' },
                },
              }}
            />
          </Box>
        </Alert>
      </Snackbar>
    </UndoContext.Provider>
  );
}

export function useUndoable() {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useUndoable must be used inside <UndoProvider>');
  return ctx;
}
