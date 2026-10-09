import { Box, Paper, Typography, Tooltip, Chip } from '@mui/material';
import { HEB_DAYS, fmtDate } from './shiftRows';
import { inWindow, CATEGORY_KEY } from './ShiftGrid';

/**
 * The week's staffing, balanced in one glance: per day, which group is SHORT
 * (red, bold — someone must be found) and which carries MORE than its tekken
 * (green — someone who can be moved). The same arithmetic as each row's own
 * summary line in the grid; this strip exists because that line lives at the
 * bottom of every class and the comparison the manager actually makes —
 * "take from here, give to there" — is ACROSS classes on one day.
 */
export default function StaffBalanceStrip({ rows, dates, closedDates, ratios, pmCaps }) {
  if (!ratios) return null;
  const classRows = rows.filter(r => r.area === 'class' && r.enrolled > 0 && CATEGORY_KEY[r.category]);
  if (!classRows.length) return null;

  const days = dates.map((d, i) => {
    if (closedDates.has(d)) return { d, i, closed: true, items: [] };
    const isFriday = new Date(`${d}T12:00:00Z`).getUTCDay() === 5;
    const items = [];
    for (const row of classRows) {
      const catKey = CATEGORY_KEY[row.category];
      const needed = Math.ceil(row.enrolled / ratios[catKey]);
      const pmCap = pmCaps ? Number(pmCaps[catKey]) : null;
      const pmNeeded = pmCap > 0 ? Math.min(needed, pmCap) : needed;
      const list = row.cells[d] || [];
      const uniq = (win) => new Set(list.filter(e => inWindow(e, win)).map(e => String(e.employee_id))).size;
      const am = uniq('am') - needed;
      const pm = isFriday ? 0 : uniq('pm') - pmNeeded;
      // The same gap in both windows is one person's whole day, not two
      // facts — one line, both icons. Different gaps stay two lines.
      if (am !== 0 && am === pm) {
        items.push({ label: row.label, winIcon: '☀️🌙', winName: 'בוקר וצהריים', diff: am });
      } else {
        if (am !== 0) items.push({ label: row.label, winIcon: '☀️', winName: 'בוקר', diff: am });
        if (pm !== 0) items.push({ label: row.label, winIcon: '🌙', winName: 'צהריים', diff: pm });
      }
    }
    return { d, i, closed: false, items };
  });

  const totalShort = days.reduce((t, x) => t + x.items.filter(it => it.diff < 0).reduce((s, it) => s - it.diff, 0), 0);
  const totalExtra = days.reduce((t, x) => t + x.items.filter(it => it.diff > 0).reduce((s, it) => s + it.diff, 0), 0);

  return (
    <Paper sx={{ p: 1.5, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 800 }}>⚖️ חוסרים ועודפים</Typography>
        {totalShort > 0 && <Chip size="small" color="error" sx={{ fontWeight: 700 }} label={`חסרות ${totalShort} השבוע`} />}
        {totalExtra > 0 && <Chip size="small" color="success" variant="outlined" sx={{ fontWeight: 700 }} label={`עודף ${totalExtra} השבוע`} />}
        {totalShort === 0 && totalExtra === 0 && <Chip size="small" color="success" label="הכול מאוזן ✓" />}
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {days.map(({ d, i, closed, items }) => {
          const short = items.filter(it => it.diff < 0);
          const extra = items.filter(it => it.diff > 0);
          // A day holding both a hole and a spare is THE reallocation moment.
          const canBalance = short.length > 0 && extra.length > 0;
          return (
            <Box key={d} sx={{
              flex: '1 1 140px', minWidth: 140, borderRadius: 1.5, p: 1,
              border: '1px solid', borderColor: canBalance ? 'warning.main' : 'divider',
              bgcolor: closed ? 'action.disabledBackground' : canBalance ? '#fff8e1' : 'background.paper',
            }}>
              <Typography sx={{ fontWeight: 700, fontSize: '0.8rem', mb: 0.5 }}>
                {HEB_DAYS[i]} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>{fmtDate(d)}</Box>
              </Typography>
              {closed ? (
                <Typography variant="caption" color="text.secondary">סגור</Typography>
              ) : items.length === 0 ? (
                <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600 }}>מאוזן ✓</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {short.map((it, k) => (
                    <Tooltip key={`s${k}`} title={`${it.label} · ${it.winName}: חסרות ${-it.diff} מול התקן`}>
                      <Chip size="small" color="error" sx={{ fontWeight: 800, justifyContent: 'flex-start' }}
                        label={`${it.winIcon} ${it.label} — חסרות ${-it.diff}`} />
                    </Tooltip>
                  ))}
                  {extra.map((it, k) => (
                    <Tooltip key={`e${k}`} title={`${it.label} · ${it.winName}: ${it.diff} מעל התקן — אפשר להעביר`}>
                      <Chip size="small" color="success" variant="outlined" sx={{ fontWeight: 700, justifyContent: 'flex-start' }}
                        label={`${it.winIcon} ${it.label} — עודף ${it.diff}`} />
                    </Tooltip>
                  ))}
                  {canBalance && (
                    <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 700 }}>
                      ↔ אפשר לאזן — לגרור מהעודף לחוסר
                    </Typography>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}
