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
function Figure({ value, label, hint, size = 'base', tone, muted }) {
  const colour = muted ? 'text.primary' : `${TONE_FILL[tone] || 'primary'}.main`;
  return (
    <>
      <Typography
        component="div"
        className="num"
        sx={{
          ...(size === 'hero' ? { fontSize: '2.5rem', lineHeight: 1.05, letterSpacing: '-0.03em' }
            : size === 'small' ? { fontSize: '1.25rem', lineHeight: 1.15, letterSpacing: '-0.01em' }
            : { fontSize: '1.75rem', lineHeight: 1.1, letterSpacing: '-0.02em' }),
          fontWeight: 600,
          color: colour,
          direction: 'ltr',
          textAlign: 'inherit',
        }}
      >
        {value}
      </Typography>
      <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500, color: 'text.primary', mt: 0.25 }}>
        {label}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: '0.6875rem', color: 'text.disabled', lineHeight: 1.35, mt: 0.125 }}>
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
  transition: 'border-color 140ms, background-color 140ms, transform 140ms',
  '&:hover': onClick ? {
    borderColor: active ? `${TONE_FILL[tone] || 'primary'}.main` : 'dividerStrong',
    transform: 'translateY(-1px)',
  } : {},
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
});

export default function StatBoard({ hero, attention = [], facts = [] }) {
  const live = attention.filter((a) => a && a.value > 0);
  const quiet = attention.filter((a) => a && !(a.value > 0));

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
            <Figure {...hero} size="hero" tone={hero.tone || 'success'} />
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
                color: live.length ? 'error.main' : 'text.disabled', flexShrink: 0,
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
                  <Figure {...a} size="base" tone={a.tone || 'error'} />
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
                    <Box component="span" className="num" sx={{ fontWeight: 700, color: 'text.disabled' }}>
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
