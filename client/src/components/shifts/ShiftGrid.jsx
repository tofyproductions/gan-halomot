import { useMemo, useState } from 'react';
import { Box, Paper, Table, TableHead, TableBody, TableRow, TableCell, Typography, Tooltip, Chip } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { HEB_DAYS, fmtDate, employeeHue, toMin } from './shiftRows';

/** Her chip's colors — one stable pastel per employee, readable in both themes. */
const chipColors = (employeeId) => {
  const hue = employeeHue(employeeId);
  return {
    bgcolor: (t) => (t.palette.mode === 'dark' ? `hsl(${hue} 32% 23%)` : `hsl(${hue} 68% 91%)`),
    accent: `hsl(${hue} 55% 45%)`,
  };
};

const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

const DND_TYPE = 'application/x-shift';
// What is being dragged right now. Some browsers refuse getData() during
// dragover, so the drop reads this first and falls back to the dataTransfer.
const dragging = { current: null };

/** Start a drag of `payload` ({ kind: 'entry', key } | { kind: 'employee', employee_id }). */
export function startShiftDrag(ev, payload) {
  dragging.current = payload;
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData(DND_TYPE, JSON.stringify(payload)); } catch { /* the ref above is enough */ }
}
export function endShiftDrag() { dragging.current = null; }
function readDrag(ev) {
  if (dragging.current) return dragging.current;
  try { const raw = ev.dataTransfer.getData(DND_TYPE); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/**
 * The week as a table: a row per class (then kitchen, floaters, unplaced), a
 * column per day, people and hours in the cells. Wraps on a phone by
 * scrolling sideways inside its own box — the page itself never widens (see
 * PageHeader for what a wide page does to sticky cells on iOS).
 */
export default function ShiftGrid({ dates, rows, closedDates, warnings = [], switched, editable, onCellClick, onEntryClick, onDropToCell, highlightEmployeeId, alerts, actual = {} }) {
  const warnOf = (row, date) => warnings.find(w => w.date === date && String(w.classroom_id) === String(row.classroom_id));
  const [over, setOver] = useState(null); // `${row.key}|${date}` under the dragged item
  const canDrop = !!(editable && onDropToCell);
  const today = todayYmd();
  // How many people are on the floor each day — the away row doesn't count.
  const staffPerDay = useMemo(() => {
    const m = Object.fromEntries(dates.map(d => [d, new Set()]));
    for (const row of rows) {
      if (row.area === 'away') continue;
      for (const d of dates) for (const e of (row.cells[d] || [])) m[d].add(String(e.employee_id));
    }
    return Object.fromEntries(dates.map(d => [d, m[d].size]));
  }, [rows, dates]);
  const stickyCol = {
    position: 'sticky', insetInlineStart: 0, zIndex: 1,
    bgcolor: 'background.paper', borderInlineEnd: '1px solid', borderInlineEndColor: 'divider',
  };
  return (
    <Box>
    {canDrop && (
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
        גררו עובדת לתא כדי לשבץ או להזיז. Shift בזמן השחרור = כל השבוע לשורה הזו.
      </Typography>
    )}
    <Box component={Paper} sx={{ overflowX: 'auto', borderRadius: 3 }}>
      <Table size="small" sx={{ minWidth: 760 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 130, fontWeight: 700, ...stickyCol, zIndex: 2 }}>כיתה</TableCell>
            {dates.map((d, i) => {
              const isToday = d === today;
              const closed = closedDates.has(d);
              return (
                <TableCell key={d} align="center" sx={{
                  fontWeight: 700,
                  bgcolor: closed ? 'action.disabledBackground' : (isToday ? 'primary.soft' : undefined),
                  borderBlockEnd: '2px solid', borderBlockEndColor: isToday ? 'primary.main' : 'divider',
                }}>
                  {HEB_DAYS[i]} <Typography component="span" variant="caption" color="text.secondary">{fmtDate(d)}</Typography>
                  {closed
                    ? <Typography variant="caption" display="block" color="text.secondary">הגן סגור</Typography>
                    : <Typography variant="caption" display="block" color="text.secondary">{staffPerDay[d] || 0} עובדות</Typography>}
                </TableCell>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.flatMap(row => {
            // One line per employee, kept the same all week, so the eye can
            // follow a person across the days (sorted by earliest start, then name).
            const first = new Map(); const names = new Map();
            for (const d of dates) {
              for (const e of (row.cells[d] || [])) {
                const id = String(e.employee_id);
                if (!names.has(id)) names.set(id, e.employee_name);
                const s = e.start_hhmm || '99:99';
                if (!first.has(id) || s < first.get(id)) first.set(id, s);
              }
            }
            const slots = [...names.keys()].sort((a, b) => (first.get(a) || '').localeCompare(first.get(b) || '')
              || String(names.get(a)).localeCompare(String(names.get(b)), 'he'));
            if (!slots.length) slots.push(null);
            return slots.map((slotId, si) => {
              const last = si === slots.length - 1;
              return (
            <TableRow key={`${row.key}:${slotId || 'empty'}`}>
              {si === 0 && (
                <TableCell rowSpan={slots.length} sx={{ fontWeight: 700, verticalAlign: 'top', ...stickyCol }}>
                  {row.label}
                  {row.enrolled != null && (
                    <Typography variant="caption" display="block" color="text.secondary" fontWeight={400}>
                      {row.enrolled} ילדים
                    </Typography>
                  )}
                </TableCell>
              )}
              {dates.map(d => {
                const closed = closedDates.has(d);
                const warn = row.area === 'class' && warnOf(row, d);
                const cellEntries = slotId ? (row.cells[d] || []).filter(e => String(e.employee_id) === slotId) : [];
                const clickable = editable && !closed && row.area !== 'away';
                const droppable = canDrop && clickable;
                const cellKey = `${row.key}|${d}`;
                const isOver = droppable && over === cellKey;
                return (
                  <TableCell
                    key={d}
                    onClick={clickable ? () => onCellClick(row, d) : undefined}
                    onDragOver={droppable ? (ev) => {
                      ev.preventDefault();
                      ev.dataTransfer.dropEffect = 'move';
                      if (over !== cellKey) setOver(cellKey);
                    } : undefined}
                    onDragLeave={droppable ? (ev) => {
                      if (ev.currentTarget.contains(ev.relatedTarget)) return; // moving onto a child
                      setOver(o => (o === cellKey ? null : o));
                    } : undefined}
                    onDrop={droppable ? (ev) => {
                      ev.preventDefault();
                      setOver(null);
                      const payload = readDrag(ev);
                      endShiftDrag();
                      if (payload) onDropToCell(row, d, payload, { shiftKey: ev.shiftKey });
                    } : undefined}
                    sx={{
                      verticalAlign: 'top', minWidth: 110, p: 0.5,
                      // The class's lines read as one block — only its last line draws the divider.
                      borderBottom: last ? undefined : 'none',
                      cursor: clickable ? 'pointer' : 'default',
                      bgcolor: closed ? 'action.disabledBackground' : (isOver ? 'primary.soft' : (warn ? 'warning.soft' : undefined)),
                      outline: isOver ? '2px solid' : 'none', outlineColor: 'primary.main', outlineOffset: -2,
                      '&:hover': clickable ? { bgcolor: isOver ? 'primary.soft' : 'action.hover' } : {},
                    }}
                  >
                    {cellEntries.map(e => {
                      const isSwitch = switched.has(`${e.employee_id}|${e.date}`);
                      const mine = highlightEmployeeId && String(e.employee_id) === String(highlightEmployeeId);
                      const draggable = droppable && !!(e._id || e.tmp);
                      const colors = chipColors(e.employee_id);
                      return (
                        <Box
                          key={e._id || `${e.employee_id}-${e.start_hhmm}`}
                          draggable={draggable || undefined}
                          onDragStart={draggable ? (ev) => { ev.stopPropagation(); startShiftDrag(ev, { kind: 'entry', key: String(e._id || e.tmp) }); } : undefined}
                          onDragEnd={draggable ? () => { endShiftDrag(); setOver(null); } : undefined}
                          onClick={editable && row.area !== 'away' ? (ev) => { ev.stopPropagation(); onEntryClick(e); } : undefined}
                          sx={{
                            cursor: draggable ? 'grab' : undefined,
                            mb: 0.5, px: 0.75, py: 0.25, borderRadius: 1,
                            bgcolor: colors.bgcolor,
                            borderInlineStart: '3px solid', borderInlineStartColor: colors.accent,
                            // Her own shift / a mid-day room switch keep their markers as outlines.
                            outline: mine ? '2px solid' : (isSwitch ? '1px dashed' : 'none'),
                            outlineColor: mine ? 'primary.main' : 'info.main',
                            outlineOffset: -1,
                            fontWeight: mine ? 700 : 500, fontSize: '0.8rem', lineHeight: 1.3,
                          }}
                        >
                          {e.employee_name}
                          <Box component="span" dir="ltr" sx={{ display: 'block', fontSize: '0.7rem', color: 'text.secondary' }}>
                            {e.start_hhmm && e.end_hhmm ? `${e.start_hhmm}–${e.end_hhmm}` : 'חסרות שעות'}
                          </Box>
                          {(() => {
                            const act = actual[String(e.employee_id)]?.[e.date];
                            if (!act || !act.in) return null;
                            const worked = act.out != null ? (toMin(act.out) ?? 0) - (toMin(act.in) ?? 0) : null;
                            const planned = (toMin(e.end_hhmm) ?? 0) - (toMin(e.start_hhmm) ?? 0);
                            const overWorked = worked != null && planned > 0 && worked > planned + 15;
                            return (
                              <Tooltip title={act.out ? 'לפי שעון הנוכחות' : 'לפי שעון הנוכחות — אין עדיין החתמת יציאה'}>
                                <Box component="span" dir="ltr" sx={{
                                  display: 'block', fontSize: '0.7rem', fontWeight: 600,
                                  color: overWorked ? 'warning.softOn' : 'text.secondary',
                                }}>
                                  ⏱ {act.in}–{act.out || '…'}
                                </Box>
                              </Tooltip>
                            );
                          })()}
                          {editable && e.new_class && <Chip size="small" label="כיתה חדשה לה" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />}
                          {editable && e.alternating && <Chip size="small" label="יום מתחלף" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />}
                          {e.cross_status === 'pending' && <Chip size="small" color="info" label="ממתין לאישור סניף הבית" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />}
                          {row.area !== 'away' && alerts && alerts.get(`${e.employee_id}|${e.date}`) && (
                            <Tooltip title={alerts.get(`${e.employee_id}|${e.date}`).join(' · ')}>
                              <Chip size="small" color="warning" label="⚠ אילוץ" sx={{ height: 16, fontSize: '0.6rem', mt: 0.25 }} />
                            </Tooltip>
                          )}
                        </Box>
                      );
                    })}
                    {warn && last && (
                      <Tooltip title={`${warn.enrolled} ילדים — צריך ${warn.needed} עובדות, משובצות ${warn.staff}`}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: 'warning.softOn', fontSize: '0.7rem' }}>
                          <WarningAmberIcon sx={{ fontSize: 14 }} /> חסרות {warn.needed - warn.staff}
                        </Box>
                      </Tooltip>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
              );
            });
          })}
        </TableBody>
      </Table>
    </Box>
    </Box>
  );
}
