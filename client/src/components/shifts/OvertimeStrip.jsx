import { useMemo, useState } from 'react';
import { Box, Paper, Stack, Chip, Typography, Collapse, Button, Tooltip } from '@mui/material';
import { overtimeOf, fmtMin, fmtDate, HEB_DAYS } from './shiftRows';

/**
 * What this week pays beyond the commitments: a weekly total, a chip per day,
 * and on demand the per-employee breakdown. Hidden when there is nothing —
 * a clean week needs no banner.
 */
export default function OvertimeStrip({ employees, entries, dates }) {
  const ot = useMemo(() => overtimeOf({ entries, employees, dates }), [entries, employees, dates]);
  const [open, setOpen] = useState(false);
  if (!ot.total) return null;
  return (
    <Paper sx={{ borderRadius: 3, p: 1, mb: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" fontWeight={700}>שעות מעבר להתחייבות</Typography>
        <Chip size="small" color="warning" label={`סה״כ ${fmtMin(ot.total)} שע׳ בשבוע`} />
        {dates.map((d, i) => ot.perDay[d] > 0 && (
          <Chip key={d} size="small" variant="outlined" label={`${HEB_DAYS[i]} ${fmtMin(ot.perDay[d])}`} />
        ))}
        <Button size="small" onClick={() => setOpen(o => !o)}>{open ? 'סגירת הפירוט' : 'פירוט לפי עובדת'}</Button>
      </Stack>
      <Collapse in={open}>
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {ot.perEmp.map(p => (
            <Box key={p.employee_id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ minWidth: 140, fontWeight: 600 }}>{p.full_name}</Typography>
              <Typography variant="body2" color="warning.softOn" fontWeight={700}>‎+{fmtMin(p.total)}</Typography>
              {p.days.map(d => (
                <Tooltip key={d.date} title={`משובצת ${fmtMin(d.scheduled)}, בהתחייבות ${d.committed ? fmtMin(d.committed) : 'אין יום כזה'}`}>
                  <Chip size="small" variant="outlined"
                    label={`${HEB_DAYS[d.weekday]} ${fmtDate(d.date)} ‎+${fmtMin(d.extra)}`} />
                </Tooltip>
              ))}
            </Box>
          ))}
        </Stack>
      </Collapse>
    </Paper>
  );
}
