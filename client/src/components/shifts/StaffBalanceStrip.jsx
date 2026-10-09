import { useState } from 'react';
import { Box, Paper, Typography, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
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
export default function StaffBalanceStrip({ rows, dates, closedDates, ratios, pmCaps, branchId, bonuses, canEdit, onChanged }) {
  // The price of a slot is the OWNER's call: only system_admin sets or
  // cancels a bonus. Managers still SEE an active one on the strip —
  // view-as safe, since useAuth hands the effective role.
  const { user } = useAuth();
  const canBonus = user?.role === 'system_admin';
  /**
   * The bounty dialog: a shortage the branch cannot fill from inside can be
   * priced — the bonus is shown ONLY to other branches' staff beside the
   * gap on their own screen, and is paid through a pending salary
   * adjustment the accountant approves. Here the manager sets or removes
   * the price.
   */
  const [bonusDlg, setBonusDlg] = useState(null); // { gap, amount }
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
      const base = { label: row.label, classroom_id: row.classroom_id };
      if (am !== 0 && am === pm) {
        // One line, both windows — the bonus anchor stays the morning slot.
        items.push({ ...base, winIcon: '☀️🌙', winName: 'בוקר וצהריים', win: 'am', diff: am });
      } else {
        if (am !== 0) items.push({ ...base, winIcon: '☀️', winName: 'בוקר', win: 'am', diff: am });
        if (pm !== 0) items.push({ ...base, winIcon: '🌙', winName: 'צהריים', win: 'pm', diff: pm });
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
  const bonusOf = (it, d) => (bonuses || []).find(x =>
    x.status === 'active' && x.date === d && x.window === it.win && String(x.classroom_id) === String(it.classroom_id));

  const GapPill = ({ it, date }) => {
    const short = it.diff < 0;
    const tone = short ? 'error' : 'success';
    const bonus = short && it.classroom_id ? bonusOf(it, date) : null;
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
          {bonus && (
            <Tooltip title={`בונוס פעיל לעובדות מסניפים אחרים · ${bonus.claimed_by_name ? `נתפס על ידי ${bonus.claimed_by_name}` : canBonus ? 'לחיצה מבטלת' : 'נקבע על ידי מנהל המערכת'}`}>
              <Box component="span" dir="ltr"
                onClick={canBonus ? async (e) => {
                  e.stopPropagation();
                  if (!window.confirm(`לבטל את הבונוס של ₪${bonus.amount}?`)) return;
                  try { await api.delete(`/shifts/cover-bonuses/${bonus._id}`); toast.success('הבונוס בוטל'); onChanged?.(); }
                  catch (err) { toast.error(err.response?.data?.error || 'הביטול נכשל'); }
                } : undefined}
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.25,
                  px: 0.75, py: 0.2, borderRadius: 999, cursor: canBonus ? 'pointer' : 'default',
                  bgcolor: '#FEF3C7', color: '#92400E', border: '1.5px solid #F59E0B',
                  fontSize: '0.66rem', fontWeight: 800, boxShadow: '0 1px 4px rgba(245,158,11,0.35)',
                }}>
                🎁 ₪{bonus.amount}
              </Box>
            </Tooltip>
          )}
          {canBonus && short && !bonus && it.classroom_id && (
            <Tooltip title="הצעת בונוס לעובדת מסניף אחר שתיקח את המשמרת">
              <Box component="span"
                onClick={(e) => { e.stopPropagation(); setBonusDlg({ gap: { ...it, date }, amount: '' }); }}
                sx={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 18, height: 18, borderRadius: '50%', cursor: 'pointer',
                  border: '1.5px dashed #F59E0B', color: '#B45309', fontSize: '0.7rem', fontWeight: 800,
                  '&:hover': { bgcolor: '#FEF3C7' },
                }}>
                🎁
              </Box>
            </Tooltip>
          )}
        </Box>
      </Tooltip>
    );
  };

  const saveBonus = async () => {
    const { gap, amount } = bonusDlg;
    try {
      await api.post('/shifts/cover-bonuses', {
        branch_id: branchId, date: gap.date, window: gap.win,
        classroom_id: gap.classroom_id, amount: Number(amount),
      });
      toast.success('הבונוס פורסם — עובדות פנויות מסניפים אחרים יראו אותו');
      setBonusDlg(null);
      onChanged?.();
    } catch (err) { toast.error(err.response?.data?.error || 'הפרסום נכשל'); }
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
              /**
               * A day that is SHORT is the loudest thing on the strip: red
               * frame, red wash, red glow — before any other accent. The
               * amber ↔ cue still marks a fixable day in the header, but
               * the card itself says "כאן חסר" from across the room. A day
               * with only spares keeps the quiet white card.
               */
              border: short.length ? '2px solid' : '1px solid',
              borderColor: short.length ? 'error.main' : canBalance ? 'warning.main' : 'divider',
              bgcolor: closed ? 'action.disabledBackground' : short.length ? '#FEF6F5' : 'background.paper',
              boxShadow: short.length ? '0 3px 14px rgba(220,38,38,0.28)'
                : canBalance ? '0 2px 10px rgba(217,119,6,0.18)' : '0 1px 3px rgba(0,0,0,0.05)',
              transition: 'box-shadow .15s ease',
            }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mb: 0.75,
                pb: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ fontWeight: 800, fontSize: '0.82rem' }}>{HEB_DAYS[i]}</Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem' }}>{fmtDate(d)}</Typography>
                {short.length > 0 && (
                  <Box component="span" sx={{
                    px: 0.75, py: 0.2, borderRadius: 999, fontSize: '0.66rem', fontWeight: 800,
                    bgcolor: 'error.main', color: '#fff', lineHeight: 1.4,
                  }}>
                    חסר
                  </Box>
                )}
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
                  {short.map((it, k) => <GapPill key={`s${k}`} it={it} date={d} />)}
                  {extra.map((it, k) => <GapPill key={`e${k}`} it={it} date={d} />)}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Dialog open={!!bonusDlg} onClose={() => setBonusDlg(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>🎁 בונוס למשמרת חסרה</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            קביעת בונוס היא סמכות מנהל המערכת. הבונוס יוצג רק לעובדות פנויות <b>מסניפים אחרים</b> לצד
            המשבצת החסרה — המשמרת מוצעת להן גם בלי בונוס; הבונוס רק מדגיש אותה.
            כשעובדת כזו תשובץ, הבונוס יוגש אוטומטית כתוספת שכר לאישור הנהלת חשבונות — לפי הנהלים.
          </Typography>
          {bonusDlg && (
            <Typography sx={{ fontWeight: 700, mb: 2 }}>
              {bonusDlg.gap.label} · {fmtDate(bonusDlg.gap.date)} · {bonusDlg.gap.winName}
            </Typography>
          )}
          <TextField
            autoFocus fullWidth type="number" label="סכום הבונוס (₪)"
            value={bonusDlg?.amount || ''}
            onChange={e => setBonusDlg(s => ({ ...s, amount: e.target.value }))}
            helperText="בין 20 ל-1,000 ₪ · תשלום חד-פעמי על המשמרת"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBonusDlg(null)}>ביטול</Button>
          <Button variant="contained" disabled={!(Number(bonusDlg?.amount) >= 20)} onClick={saveBonus}>
            פרסום הבונוס
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
