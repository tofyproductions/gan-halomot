import { useState, useEffect } from 'react';
import {
  Stack, Card, CardContent, Typography, Alert, Box, CircularProgress, Chip,
} from '@mui/material';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * מה עושים השבוע בכיתה.
 *
 * Shown only when the gan published this week AND the month is approved. Both
 * gates are deliberate: a plan still being argued about is not something a
 * family should be reading, and "we never pressed publish" has to mean
 * something or the switch is decoration.
 *
 * When it is not published the screen says so plainly rather than showing an
 * empty grid — a parent looking at an empty week concludes the gan planned
 * nothing, which is the opposite of true.
 */

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

export default function ParentGantt({ childId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    parentApi.get(`/children/${childId}/gantt`)
      .then((res) => { if (alive) setData(res.data); })
      .catch((err) => { if (alive) setError(parentApiError(err, 'שגיאה בטעינה')); });
    return () => { alive = false; };
  }, [childId]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={28} /></Stack>;

  if (!data.visible) {
    return (
      <Stack spacing={2}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>התוכנית השבועית</Typography>
        <Alert severity="info">
          הגן טרם פרסם את התוכנית לשבוע הזה. היא תופיע כאן ברגע שתפורסם.
        </Alert>
      </Stack>
    );
  }

  const week = (data.weeks || [])[0];
  if (!week) {
    return (
      <Stack spacing={2}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>התוכנית השבועית</Typography>
        <Alert severity="info">אין תוכנית מאושרת לשבוע הזה.</Alert>
      </Stack>
    );
  }

  const rows = data.rows || [];
  const cellFor = (rowKey, dayIndex) =>
    (week.cells || []).find((c) => c.row_key === rowKey && c.day_index === dayIndex);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>התוכנית השבועית</Typography>
        {week.topic && (
          <Chip label={week.topic} color="primary" sx={{ fontWeight: 800, mt: 0.5 }} />
        )}
      </Box>

      {/* A day per card rather than a grid: a five-column table on a phone is
          a table nobody reads, and the parent's question is about one day. */}
      {DAYS.map((day, i) => {
        const filled = rows
          .map((r) => ({ label: r.label, cell: cellFor(r.key, i) }))
          .filter((x) => x.cell?.content);
        if (!filled.length) return null;
        return (
          <Card key={day} variant="outlined" sx={{ borderRadius: 3 }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Typography sx={{ fontWeight: 800, mb: 0.5 }}>יום {day}</Typography>
              <Stack spacing={0.5}>
                {filled.map(({ label, cell }) => (
                  <Stack key={label} direction="row" spacing={1} alignItems="baseline">
                    <Typography variant="caption" sx={{ minWidth: 64, color: 'text.secondary', fontWeight: 700 }}>
                      {label}
                    </Typography>
                    <Typography variant="body2" sx={{ color: cell.color || 'inherit' }}>
                      {cell.content}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
}
