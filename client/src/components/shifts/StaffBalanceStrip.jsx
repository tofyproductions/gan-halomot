import { Box, Paper, Typography, Tooltip } from '@mui/material';
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

  /**
   * One pill per imbalance, in the board's own design language (StaffPill):
   * rounded chip, window icon, the group's name — and the gap OFF the text,
   * in its own white circle with a red or green ring. Same glyph, same
   * meaning, wherever the planner looks.
   */
  const GapPill = ({ it }) => {
    const short = it.diff < 0;
    const tone = short ? 'error' : 'success';
    return (
      <Tooltip title={`${it.label} · ${it.winName}: ${short ? `חסרות ${-it.diff} מול התקן` : `${it.diff} מעל התקן — אפשר להעביר`}`}>
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.6, px: 1, py: 0.5,
          borderRadius: 999, fontSize: '0.72rem', fontWeight: 700, lineHeight: 1,
          bgcolor: `${tone}.soft`, color: `${tone}.softOn`,
          border: '1px solid', borderColor: `${tone}.main`,
          boxShadow: short ? '0 1px 4px rgba(220,38,38,0.25)' : '0 1px 4px rgba(22,163,74,0.3)',
        }}>
          <Box component="span" aria-hidden sx={{ fontSize: '0.8rem', lineHeight: 1 }}>{it.winIcon}</Box>
          <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.label}
          </Box>
          <Box component="span" dir="ltr" sx={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 18, height: 18, px: 0.4, borderRadius: '50%',
            bgcolor: 'background.paper', border: '1.5px solid',
            borderColor: `${tone}.main`, color: short ? 'error.main' : 'success.dark',
            fontSize: '0.66rem', fontWeight: 800,
          }}>
            {it.diff > 0 ? `+${it.diff}` : it.diff}
          </Box>
        </Box>
      </Tooltip>
    );
  };

  return (
    <Paper sx={{ p: 1.5, mb: 2, borderRadius: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 800 }}>⚖️ חוסרים ועודפים</Typography>
        {totalShort > 0 && (
          <Box sx={{ px: 1.25, py: 0.4, borderRadius: 999, fontSize: '0.72rem', fontWeight: 800,
            bgcolor: 'error.soft', color: 'error.softOn', border: '1px solid', borderColor: 'error.main' }}>
            חסרות {totalShort} השבוע
          </Box>
        )}
        {totalExtra > 0 && (
          <Box sx={{ px: 1.25, py: 0.4, borderRadius: 999, fontSize: '0.72rem', fontWeight: 800,
            bgcolor: 'success.soft', color: 'success.softOn', border: '1px solid', borderColor: 'success.main' }}>
            עודף {totalExtra} השבוע
          </Box>
        )}
        {totalShort === 0 && totalExtra === 0 && (
          <Box sx={{ px: 1.25, py: 0.4, borderRadius: 999, fontSize: '0.72rem', fontWeight: 800,
            bgcolor: 'success.soft', color: 'success.softOn' }}>
            הכול מאוזן ✓
          </Box>
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap' }}>
        {days.map(({ d, i, closed, items }) => {
          const short = items.filter(it => it.diff < 0);
          const extra = items.filter(it => it.diff > 0);
          // A day holding both a hole and a spare is THE reallocation moment.
          const canBalance = short.length > 0 && extra.length > 0;
          return (
            <Box key={d} sx={{
              flex: '1 1 150px', minWidth: 150, borderRadius: 2.5, p: 1.25,
              border: '1px solid',
              borderColor: canBalance ? 'warning.main' : 'divider',
              bgcolor: closed ? 'action.disabledBackground' : 'background.paper',
              boxShadow: canBalance ? '0 2px 10px rgba(217,119,6,0.18)' : '0 1px 3px rgba(0,0,0,0.05)',
              transition: 'box-shadow .15s ease',
            }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mb: 0.75,
                pb: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ fontWeight: 800, fontSize: '0.82rem' }}>{HEB_DAYS[i]}</Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem' }}>{fmtDate(d)}</Typography>
                {canBalance && (
                  <Tooltip title="יש גם חוסר וגם עודף — אפשר לגרור עובדת מהעודף לחוסר">
                    <Box component="span" sx={{ mr: 'auto', fontSize: '0.72rem', fontWeight: 800, color: 'warning.dark' }}>↔ לאזן</Box>
                  </Tooltip>
                )}
              </Box>
              {closed ? (
                <Typography variant="caption" color="text.secondary">סגור</Typography>
              ) : items.length === 0 ? (
                <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 700 }}>מאוזן ✓</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                  {short.map((it, k) => <GapPill key={`s${k}`} it={it} />)}
                  {extra.map((it, k) => <GapPill key={`e${k}`} it={it} />)}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}
