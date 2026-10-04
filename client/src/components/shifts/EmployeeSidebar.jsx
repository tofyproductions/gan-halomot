import { useMemo, useState } from 'react';
import { Box, Paper, TextField, Typography, Button, Tooltip } from '@mui/material';
import { startShiftDrag, endShiftDrag } from './ShiftGrid';
import { employeeHue, scheduledMinutes, toMin, fmtMin } from './shiftRows';

/**
 * The branch's people (and foreign ones with a rate here), to drag onto the
 * board. Beside the grid on a wide screen, above it on a phone.
 */
export default function EmployeeSidebar({ employees = [], entries = [], dates = [], onRequestRate }) {
  const [q, setQ] = useState('');
  const daysOf = useMemo(() => {
    const week = new Set(dates);
    const m = new Map();
    for (const e of entries) {
      if (!week.has(e.date)) continue;
      const id = String(e.employee_id);
      if (!m.has(id)) m.set(id, new Set());
      m.get(id).add(e.date);
    }
    return m;
  }, [entries, dates]);
  const minutesOf = useMemo(() => {
    const week = new Set(dates);
    const sched = scheduledMinutes(entries.filter(e => week.has(e.date)));
    const m = new Map();
    for (const [id, byDate] of sched) m.set(id, [...byDate.values()].reduce((a, b) => a + b, 0));
    return m;
  }, [entries, dates]);
  const committedOf = (emp) => Object.values(emp.commitment || {})
    .reduce((sum, c) => sum + Math.max(0, (toMin(c.end_hhmm) ?? 0) - (toMin(c.start_hhmm) ?? 0)), 0);
  const term = q.trim();
  const list = term ? employees.filter(e => String(e.full_name).includes(term)) : employees;

  return (
    <Paper sx={{ borderRadius: 3, p: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Typography variant="subtitle2" fontWeight={700}>עובדות</Typography>
      <TextField size="small" placeholder="חיפוש" value={q} onChange={(ev) => setQ(ev.target.value)} fullWidth />
      <Box sx={{ overflowY: 'auto', maxHeight: { xs: 200, md: 560 }, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {list.map((emp) => {
          const n = daysOf.get(String(emp._id))?.size || 0;
          const mins = minutesOf.get(String(emp._id)) || 0;
          const committed = committedOf(emp);
          const extra = mins - committed;
          const hue = employeeHue(emp._id);
          return (
            <Box
              key={emp._id}
              draggable
              onDragStart={(ev) => startShiftDrag(ev, { kind: 'employee', employee_id: String(emp._id) })}
              onDragEnd={endShiftDrag}
              sx={{
                cursor: 'grab', px: 1, py: 0.5, borderRadius: 1, bgcolor: 'background.sunken',
                borderInlineStart: '3px solid', borderInlineStartColor: `hsl(${hue} 55% 45%)`,
                fontSize: '0.85rem', lineHeight: 1.3, userSelect: 'none', overflowWrap: 'anywhere',
              }}
            >
              {emp.full_name}
              <Box component="span" sx={{ display: 'block', fontSize: '0.7rem', color: 'text.secondary' }}>
                {n} ימים · {fmtMin(mins)} שע׳
                {extra > 0 && committed > 0 && (
                  <Tooltip title={`משובצת ${fmtMin(mins)} מול התחייבות של ${fmtMin(committed)}`}>
                    <Box component="span" sx={{ color: 'warning.softOn', fontWeight: 700 }}> · ‎+{fmtMin(extra)}</Box>
                  </Tooltip>
                )}
              </Box>
            </Box>
          );
        })}
        {!list.length && <Typography variant="caption" color="text.secondary">לא נמצאו עובדות</Typography>}
      </Box>
      {onRequestRate && <Button size="small" onClick={onRequestRate}>עובדת מסניף אחר…</Button>}
    </Paper>
  );
}
