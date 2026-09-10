import { Box, Typography, Tooltip } from '@mui/material';

/**
 * The numbers at the top of a screen, arranged by what they are for.
 *
 * This replaces a row of identical cards — fourteen of them on רישום חיצוני —
 * where the count of children safely approved, the count nobody has phoned yet,
 * and the count already filed all had the same size, the same weight and the
 * same grey. A wall like that has no reading order, so it gets skipped, and the
 * one red number in the middle of it gets skipped with the rest.
 *
 * Three bands, and the split is not cosmetic:
 *
 *   hero      the one figure that answers "how is this going" at a glance.
 *   attention things somebody has to DO something about. Coloured only while
 *             the count is non-zero — a screen where nothing is wrong should
 *             not have a red number sitting on it, or the colour stops meaning
 *             anything on the day it matters.
 *   facts     true, useful, and nobody's task. Small, quiet, one line.
 *
 * Every band is also a filter over the table below, which is what these numbers
 * always were — the old cards were already clickable, they just did not look
 * like controls.
 */

const TONE_FILL = {
  error: 'error',
  warning: 'warning',
  success: 'success',
  info: 'info',
  primary: 'primary',
};

/** A figure plus its label, in one of three sizes. */
function Figure({ value, label, hint, size = 'base', tone, muted, active }) {
  const role = TONE_FILL[tone] || 'primary';
  /**
   * On a soft background the figure has to use the soft foreground.
   * `success.main` on `success.soft` measures 4.20:1 — under AA — and it was
   * only drawn in the active state, which is exactly when somebody is looking
   * at it.
   */
  const colour = muted ? 'text.primary' : active ? `${role}.softOn` : `${role}.main`;
  return (
    <>
      <Typography
        component="div"
        className="num"
        sx={(t) => ({
          // theme.figure, not three sets of numbers retyped here. The scale was
          // defined in the theme and consumed by nothing.
          ...(t.figure[size === 'hero' ? 'hero' : size === 'small' ? 'small' : 'base']),
          color: colour,
          // No `direction` here: `.num` owns that, and setting it inline in a
          // stylesheet the RTL plugin rewrites is how it got inverted before.
          textAlign: 'inherit',
        })}
      >
        {value}
      </Typography>
      <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500, color: 'text.primary', mt: 0.25 }}>
        {label}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: '0.6875rem', color: 'text.muted', lineHeight: 1.35, mt: 0.125 }}>
          {hint}
        </Typography>
      )}
    </>
  );
}

/** Shared button behaviour for anything on the board that filters. */
const pressable = (onClick, active, tone, muted) => ({
  textAlign: 'inherit',
  fontFamily: 'inherit',
  cursor: onClick ? 'pointer' : 'default',
  border: '1px solid',
  borderColor: active ? `${TONE_FILL[tone] || 'primary'}.main` : 'divider',
  bgcolor: active ? (muted ? 'background.sunken' : `${TONE_FILL[tone] || 'primary'}.soft`) : 'background.paper',
  transition: (t) => `border-color ${t.motion.fast}, background-color ${t.motion.fast}, transform ${t.motion.fast}`,
  '&:hover': onClick ? {
    borderColor: active ? `${TONE_FILL[tone] || 'primary'}.main` : 'dividerStrong',
    transform: 'translateY(-1px)',
  } : {},
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
  // A lift with no press is half a gesture.
  '&:active': onClick ? { transform: 'scale(0.985)', transitionDuration: '60ms' } : {},
});

/**
 * A count, however it was formatted. `a.value > 0` is false for the string
 * "1,204" and for "₪3,900" — so a formatted problem count dropped into the
 * quiet row and the panel announced "הכל נקי" above it.
 */
const countOf = (v) => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export default function StatBoard({ hero, attention = [], facts = [] }) {
  const withCounts = attention.filter(Boolean).map((a) => ({ ...a, _n: countOf(a.value) }));
  /**
   * At most five loud figures. TmtReconcile passes eleven, eight of them with
   * no `tone` and therefore red by default — which turned a wall of fourteen
   * identical tiles into a wall of eleven red ones. The rest stay reachable as
   * filters in the quiet row; they simply stop competing.
   */
  const live = withCounts
    .filter((a) => a._n > 0)
    .sort((a, b) => (a.tone === 'warning') - (b.tone === 'warning') || b._n - a._n)
    .slice(0, 5);
  const quiet = withCounts.filter((a) => !live.includes(a));

  return (
    <Box sx={{ mb: 2.5 }}>
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(200px, 260px) 1fr' },
          alignItems: 'stretch',
          mb: 1.5,
        }}
      >
        {/* The headline. Bigger than everything else on the page on purpose. */}
        {hero && (
          <Box
            component={hero.onClick ? 'button' : 'div'}
            type={hero.onClick ? 'button' : undefined}
            onClick={hero.onClick}
            aria-pressed={hero.onClick ? !!hero.active : undefined}
            sx={{
              ...pressable(hero.onClick, hero.active, hero.tone || 'success'),
              borderRadius: 2,
              p: 2.25,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <Figure {...hero} size="hero" tone={hero.tone || 'success'} active={hero.active} />
          </Box>
        )}

        {/* Things somebody has to do. */}
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
            bgcolor: 'background.paper',
            p: 1.75,
            minWidth: 0,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <Typography
              sx={{
                fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.06em',
                color: live.length ? 'error.main' : 'text.muted', flexShrink: 0,
              }}
            >
              דורש טיפול
            </Typography>
            <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
            {!live.length && (
              <Typography sx={{ fontSize: '0.75rem', color: 'success.main', fontWeight: 600 }}>
                הכל נקי
              </Typography>
            )}
          </Box>

          {live.length > 0 && (
            <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}>
              {live.map((a) => (
                <Box
                  key={a.id}
                  component={a.onClick ? 'button' : 'div'}
                  type={a.onClick ? 'button' : undefined}
                  onClick={a.onClick}
                  aria-pressed={a.onClick ? !!a.active : undefined}
                  sx={{ ...pressable(a.onClick, a.active, a.tone || 'error'), borderRadius: 1.5, p: 1.25 }}
                >
                  <Figure {...a} size="base" tone={a.tone || 'error'} active={a.active} />
                </Box>
              ))}
            </Box>
          )}

          {/* Zero-valued problems still have to be reachable as filters — they
              just stop being the thing your eye lands on. */}
          {quiet.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: live.length ? 1.5 : 0 }}>
              {quiet.map((a) => (
                <Tooltip key={a.id} title={a.hint || ''} disableHoverListener={!a.hint}>
                  <Box
                    component={a.onClick ? 'button' : 'div'}
                    type={a.onClick ? 'button' : undefined}
                    onClick={a.onClick}
                    aria-pressed={a.onClick ? !!a.active : undefined}
                    sx={{
                      ...pressable(a.onClick, a.active, a.tone, true),
                      borderRadius: 999,
                      px: 1.25,
                      py: 0.375,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.75,
                      fontSize: '0.75rem',
                      color: 'text.secondary',
                    }}
                  >
                    <Box component="span" className="num" sx={{ fontWeight: 700, color: 'text.muted' }}>
                      {a.value}
                    </Box>
                    {a.label}
                  </Box>
                </Tooltip>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {/* True, useful, nobody's task. One line, deliberately undersized. */}
      {facts.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: { xs: 1, sm: 2.5 },
            px: 1.75,
            py: 1.25,
            borderRadius: 2,
            bgcolor: 'background.sunken',
          }}
        >
          {facts.map((f) => (
            <Box
              key={f.id}
              component={f.onClick ? 'button' : 'div'}
              type={f.onClick ? 'button' : undefined}
              onClick={f.onClick}
              aria-pressed={f.onClick ? !!f.active : undefined}
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 0.75,
                border: 0,
                bgcolor: 'transparent',
                p: 0,
                fontFamily: 'inherit',
                textAlign: 'inherit',
                cursor: f.onClick ? 'pointer' : 'default',
                color: f.active ? 'primary.main' : 'text.secondary',
                '&:hover': f.onClick ? { color: 'text.primary' } : {},
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
              }}
            >
              <Box
                component="span"
                className="num"
                sx={{ fontSize: '1.0625rem', fontWeight: 700, color: f.active ? 'primary.main' : 'text.primary' }}
              >
                {f.value}
              </Box>
              <Box component="span" sx={{ fontSize: '0.8125rem' }}>{f.label}</Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
