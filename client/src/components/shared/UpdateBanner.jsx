import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Button, Typography, Stack } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { isNative, webUpdateAvailable, nativeUpdateAvailable } from '../../utils/appUpdate';

/**
 * "יש עדכון" — one strip across the top of the screen, everywhere.
 *
 * Mounted once at the root, so it appears in the management system, in the
 * parent portal and on the login screens alike. Its colours are written out
 * rather than taken from the theme for exactly that reason: it crosses the
 * boundary between two themes (the staff's cold grey and the portal's warm
 * paper) and has to look like itself on both.
 *
 * NOT dismissible, and that is deliberate. The people this exists for are the
 * ones who do not know what a hard refresh is; a banner they can close is a
 * banner they close. It goes away by being acted on — or, on the web, by the
 * page having been reloaded, which is the same thing.
 *
 * The check runs on a timer AND whenever the app comes back to the foreground.
 * The foreground one matters more: the realistic case is a phone in a pocket
 * for four days, and the moment it is unlocked is exactly when the answer has
 * changed.
 */

const CHECK_EVERY_MS = 5 * 60 * 1000;
// A returning tab must not re-ask on every flick between apps.
const MIN_GAP_MS = 60 * 1000;

export default function UpdateBanner() {
  // null = nothing to say. Otherwise { kind: 'web' } or { kind: 'store', url }.
  const [update, setUpdate] = useState(null);
  const lastCheck = useRef(0);

  const check = useCallback(async () => {
    const now = Date.now();
    if (now - lastCheck.current < MIN_GAP_MS) return;
    lastCheck.current = now;

    if (isNative()) {
      const store = await nativeUpdateAvailable();
      if (store) setUpdate({ kind: 'store', url: store.url, version: store.version });
      return;
    }
    if (await webUpdateAvailable()) setUpdate({ kind: 'web' });
  }, []);

  useEffect(() => {
    // Not on mount: the app has this instant loaded the build it is running,
    // and asking now can only produce a banner from a deploy that landed
    // between the HTML and this line. Give it the first interval.
    const timer = setInterval(check, CHECK_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [check]);

  return update ? <Banner update={update} /> : null;
}

/**
 * The strip itself, split out so the measuring effect below only ever runs
 * while it is on screen.
 *
 * It is `fixed`, which takes it out of the flow and would otherwise sit on top
 * of whatever the page draws at the top — a header, a nav bar, the first card.
 * So the body is padded by exactly the height this turns out to be, measured
 * rather than guessed: the safe-area inset on a notched phone is not a number
 * this file can know.
 */
function Banner({ update }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const previous = document.body.style.paddingTop;
    const apply = () => { document.body.style.paddingTop = `${el.offsetHeight}px`; };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.body.style.paddingTop = previous;
    };
  }, []);

  const store = update.kind === 'store';

  return (
    <Box
      ref={ref}
      role="status"
      sx={{
        position: 'fixed', top: 0, insetInline: 0, zIndex: 2000,
        bgcolor: 'info.main', color: 'info.contrastText',
        px: 2, pb: 1, pt: 'max(8px, env(safe-area-inset-top))',
        boxShadow: (t) => t.shadows[8],
      }}
    >
      <Stack
        direction="row" alignItems="center" spacing={1.5}
        sx={{ maxWidth: 900, mx: 'auto' }}
      >
        <Box sx={{ display: 'flex' }}>
          {store ? <SystemUpdateAltIcon fontSize="small" /> : <RefreshIcon fontSize="small" />}
        </Box>
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
          {store
            ? `יצאה גרסה חדשה (${update.version}) בחנות`
            : 'יש גרסה חדשה של המערכת'}
        </Typography>
        <Button
          size="small"
          variant="contained"
          onClick={() => {
            if (store) {
              if (update.url) window.open(update.url, '_blank');
              return;
            }
            // A plain reload is enough — there is no caching service worker in
            // this app, so the request goes to the server and comes back with
            // the build the banner is talking about.
            window.location.reload();
          }}
          sx={{
            flexShrink: 0, fontWeight: 800,
            bgcolor: 'background.paper', color: 'info.main',
            '&:hover': { bgcolor: 'info.soft' },
          }}
        >
          {store ? 'לעדכון בחנות' : 'רענון ועדכון'}
        </Button>
      </Stack>
    </Box>
  );
}
