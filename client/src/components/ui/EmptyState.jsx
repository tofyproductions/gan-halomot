import { Box, Typography, Button } from '@mui/material';

/**
 * What a table says when it has no rows.
 *
 * Every table in this app said it in one grey sentence in the middle of a cell,
 * and the sentence was the same one whether the branch genuinely has no
 * employees, the search matched nothing, or the request failed and the array
 * stayed at its initial `[]`. Those are three different situations and exactly
 * one of them means "there is nothing here" — a branch manager who reads "אין
 * עובדים בסניף זה" after a dropped request concludes her staff were deleted.
 *
 * So the state is named:
 *
 *   empty   nothing here yet, and that is fine. Often there is something to do
 *           about it, which is what `action` is for.
 *   filtered the data exists, the filter hides it. The way out is to clear the
 *           filter, not to add data — so that is the button.
 *   error   the request failed. Says so plainly, and offers a retry, because
 *           "try again" is the correct advice and the only one that works.
 *
 * Deliberately not a full-page illustration: this sits inside a table body,
 * under real column headers, and the columns are context worth keeping.
 */
export default function EmptyState({
  state = 'empty',
  title,
  hint,
  action,
  actionLabel,
  icon,
}) {
  const tone = state === 'error' ? 'error.main' : 'text.primary';

  return (
    <Box
      sx={{
        py: { xs: 4, md: 5 },
        px: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.75,
        textAlign: 'center',
      }}
    >
      {icon && (
        <Box sx={{ color: state === 'error' ? 'error.main' : 'text.disabled', display: 'flex', mb: 0.5 }}>
          {icon}
        </Box>
      )}

      <Typography sx={{ fontSize: '0.9375rem', fontWeight: 600, color: tone }}>
        {title}
      </Typography>

      {hint && (
        <Typography sx={{ fontSize: '0.8125rem', color: 'text.secondary', maxWidth: 420, lineHeight: 1.5 }}>
          {hint}
        </Typography>
      )}

      {action && actionLabel && (
        <Button
          size="small"
          variant={state === 'error' ? 'contained' : 'outlined'}
          onClick={action}
          sx={{ mt: 1 }}
        >
          {actionLabel}
        </Button>
      )}
    </Box>
  );
}
