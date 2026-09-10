import { Box, Skeleton } from '@mui/material';

/**
 * What a screen looks like while its code is still arriving.
 *
 * A centred spinner would be easier and is what the app does everywhere else,
 * and it is worse: it throws away the layout, so the page collapses to nothing
 * and then snaps back, and the eye has to find its place again every time.
 * This holds the shape a screen is about to have — a title, a line of context,
 * a row of figures, a table — so the arrival is a fill rather than a jump.
 *
 * Deliberately not animated beyond MUI's own wave. Most of these resolve in
 * well under a second on a warm cache; something pulsing hard for 200ms reads
 * as a fault.
 */
export default function ScreenSkeleton() {
  return (
    <Box aria-busy="true" aria-live="polite">
      {/* The header: title, context line, and the actions on the far side. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 2,
          pb: 1.75,
          mb: 2.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ flex: 1 }}>
          <Skeleton variant="text" width={190} height={30} />
          <Skeleton variant="text" width={260} height={18} />
        </Box>
        <Skeleton variant="rounded" width={104} height={38} />
        <Skeleton variant="rounded" width={132} height={38} />
      </Box>

      {/* The figures. */}
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(200px, 260px) 1fr' },
          mb: 2.5,
        }}
      >
        <Skeleton variant="rounded" height={116} />
        <Skeleton variant="rounded" height={116} />
      </Box>

      {/* The table. */}
      <Skeleton variant="rounded" height={38} sx={{ mb: 0.5 }} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton
          key={i}
          variant="rounded"
          height={40}
          sx={{ mb: 0.5, opacity: 1 - i * 0.13 }}
        />
      ))}
    </Box>
  );
}
