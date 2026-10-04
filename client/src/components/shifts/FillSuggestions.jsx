import { useMemo } from 'react';
import { Paper, Stack, Typography, Chip, Box } from '@mui/material';
import { HEB_DAYS, fmtDate } from './shiftRows';

const weekdayOf = (ymd) => new Date(`${ymd}T12:00`).getDay();

/**
 * One click fills a gap: for every ratio shortage, up to three free
 * candidates — committed to that weekday, not placed yet, no constraint —
 * ranked by how well her card fits the class (per-day map, then her own
 * classes, then a floater). Clicking adds the shift with her committed hours.
 */
export default function FillSuggestions({ board, entries, closed, onAdd }) {
  const suggestions = useMemo(() => {
    if (!board?.week || !board.can_edit) return [];
    const placed = new Map(); // date -> Set(employee_id)
    for (const e of entries || []) {
      if (!placed.has(e.date)) placed.set(e.date, new Set());
      placed.get(e.date).add(String(e.employee_id));
    }
    const constrained = new Set();
    for (const c of board.constraints || []) {
      if (['open', 'accepted', 'pending_broadcast', 'broadcast'].includes(c.status)) constrained.add(`${c.employee_id}|${c.date}`);
    }
    const roomName = new Map(board.classrooms.map(c => [String(c._id), c.name]));
    const out = [];
    for (const w of board.warnings || []) {
      if (closed.has(w.date)) continue;
      const wd = weekdayOf(w.date);
      const roomId = String(w.classroom_id);
      const candidates = board.employees
        .filter(emp => !emp.foreign && emp.shift_area !== 'none' && emp.commitment && emp.commitment[wd])
        .filter(emp => !placed.get(w.date)?.has(String(emp._id)))
        .filter(emp => !constrained.has(`${emp._id}|${w.date}`))
        .map(emp => {
          const mapHit = (emp.shift_day_classrooms || []).some(m => m.day === wd && String(m.classroom_id) === roomId);
          const cardHit = String(emp.primary_classroom_id) === roomId || (emp.extra_classroom_ids || []).includes(roomId);
          return { emp, score: mapHit ? 3 : cardHit ? 2 : emp.shift_area === 'floater' ? 1 : 0 };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      if (candidates.length) out.push({ ...w, room_name: roomName.get(roomId) || 'כיתה', weekday: wd, candidates });
    }
    return out;
  }, [board, entries, closed]);

  if (!suggestions.length) return null;
  return (
    <Paper sx={{ borderRadius: 3, p: 1, mb: 1 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>הצעות להשלמת חוסרים</Typography>
      <Stack spacing={0.5}>
        {suggestions.map(s => (
          <Box key={`${s.classroom_id}|${s.date}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ minWidth: 210 }}>
              {s.room_name} · {HEB_DAYS[s.weekday]} {fmtDate(s.date)} — חסרות {s.needed - s.staff}:
            </Typography>
            {s.candidates.map(({ emp }) => (
              <Chip
                key={emp._id} size="small" variant="outlined" clickable color="primary"
                label={`+ ${emp.full_name} ${emp.commitment[s.weekday].start_hhmm}–${emp.commitment[s.weekday].end_hhmm}`}
                onClick={() => onAdd(emp, s.date, roomIdOf(s))}
              />
            ))}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

const roomIdOf = (s) => String(s.classroom_id);
