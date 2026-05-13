import { createContext, useContext, useState, useCallback, useRef } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography,
  FormControlLabel, Checkbox, Stack,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

/**
 * App-wide confirm replacement.
 *
 * Why not window.confirm? Browsers (Chrome, Safari) show a native "Don't show
 * this again" checkbox; once dismissed it blocks every future confirm dialog
 * from this origin until the user resets site permissions — and people click
 * it by accident. This custom version keeps the "don't show again" feature
 * but scopes it per-action and stores the choice in localStorage so the user
 * can clear it.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!(await confirm({
 *     title: 'מחיקת עמודה',
 *     message: 'הנתונים יישמרו אבל לא יוצגו עוד',
 *     danger: true,
 *     remember_key: 'remove-payroll-column',   // optional
 *   }))) return;
 *
 * If remember_key is provided AND the user previously checked
 * "don't ask again" for that key, the confirm resolves immediately to true.
 */
const ConfirmContext = createContext(null);
const SKIP_PREFIX = 'confirm_skip:';

function readSkip(key) {
  if (!key) return false;
  try { return localStorage.getItem(SKIP_PREFIX + key) === '1'; }
  catch { return false; }
}
function writeSkip(key) {
  if (!key) return;
  try { localStorage.setItem(SKIP_PREFIX + key, '1'); } catch {}
}

export function ConfirmProvider({ children }) {
  const [state, setState] = useState({ open: false, opts: null });
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const resolveRef = useRef(null);

  const confirm = useCallback((opts = {}) => {
    if (opts.remember_key && readSkip(opts.remember_key)) {
      return Promise.resolve(true);
    }
    setDontAskAgain(false);
    return new Promise(resolve => {
      resolveRef.current = resolve;
      setState({ open: true, opts });
    });
  }, []);

  const close = (result) => {
    if (result && state.opts?.remember_key && dontAskAgain) {
      writeSkip(state.opts.remember_key);
    }
    setState({ open: false, opts: null });
    const r = resolveRef.current;
    resolveRef.current = null;
    if (r) r(result);
  };

  const opts = state.opts || {};
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state.open}
        onClose={() => close(false)}
        dir="rtl"
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
          {opts.danger && <WarningAmberIcon color="error" />}
          {opts.title || 'אישור פעולה'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography variant="body1">
              {opts.message || 'האם להמשיך?'}
            </Typography>
            {opts.remember_key && (
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={dontAskAgain}
                    onChange={e => setDontAskAgain(e.target.checked)}
                  />
                }
                label="אל תשאל שוב על פעולה זו"
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => close(false)}>ביטול</Button>
          <Button
            onClick={() => close(true)}
            variant="contained"
            color={opts.danger ? 'error' : 'primary'}
            autoFocus
          >
            {opts.confirm_label || 'אישור'}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}

/** Imperative escape hatch for non-React code paths. Falls back to native
 *  confirm when the provider isn't mounted. */
export function resetAllRememberedConfirms() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SKIP_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    return keys.length;
  } catch { return 0; }
}
