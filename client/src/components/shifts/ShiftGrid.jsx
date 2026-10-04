import { useState } from 'react';
import { Box, Paper, Table, TableHead, TableBody, TableRow, TableCell, Typography, Tooltip, Chip } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { HEB_DAYS, fmtDate } from './shiftRows';

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
export default function ShiftGrid({ dates, rows, closedDates, warnings = [], switched, editable, onCellClick, onEntryClick, onDropToCell, highlightEmployeeId, alerts }) {
  const warnOf = (row, date) => warnings.find(w => w.date === date && String(w.classroom_id) === String(row.classroom_id));
  const [over, setOver] = useState(null); // `${row.key}|${date}` under the dragged item
  const canDrop = !!(editable && onDropToCell);
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
            <TableCell sx={{ width: 130, fontWeight: 700 }}>כיתה</TableCell>
            {dates.map((d, i) => (
              <TableCell key={d} align="center" sx={{ fontWeight: 700, bgcolor: closedDates.has(d) ? 'action.disabledBackground' : undefined }}>
                {HEB_DAYS[i]} <Typography component="span" variant="caption" color="text.secondary">{fmtDate(d)}</Typography>
                {closedDates.has(d) && <Typography variant="caption" display="block" color="text.secondary">הגן סגור</Typography>}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.key}>
              <TableCell sx={{ fontWeight: 700, verticalAlign: 'top' }}>{row.label}</TableCell>
              {dates.map(d => {
                const closed = closedDates.has(d);
                const warn = row.area === 'class' && warnOf(row, d);
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
                      verticalAlign: 'top', minWidth: 110, p: 0.75,
                      cursor: clickable ? 'pointer' : 'default',
                      bgcolor: closed ? 'action.disabledBackground' : (isOver ? 'primary.soft' : (warn ? 'warning.soft' : undefined)),
                      outline: isOver ? '2px solid' : 'none', outlineColor: 'primary.main', outlineOffset: -2,
                      '&:hover': clickable ? { bgcolor: isOver ? 'primary.soft' : 'action.hover' } : {},
                    }}
                  >
                    {(row.cells[d] || []).map(e => {
                      const isSwitch = switched.has(`${e.employee_id}|${e.date}`);
                      const mine = highlightEmployeeId && String(e.employee_id) === String(highlightEmployeeId);
                      const draggable = droppable && !!(e._id || e.tmp);
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
                            bgcolor: mine ? 'primary.soft' : (isSwitch ? 'info.soft' : 'background.sunken'),
                            fontWeight: mine ? 700 : 500, fontSize: '0.8rem', lineHeight: 1.3,
                          }}
                        >
                          {e.employee_name}
                          <Box component="span" dir="ltr" sx={{ display: 'block', fontSize: '0.7rem', color: 'text.secondary' }}>
                            {e.start_hhmm && e.end_hhmm ? `${e.start_hhmm}–${e.end_hhmm}` : 'חסרות שעות'}
                          </Box>
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
                    {warn && (
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
          ))}
        </TableBody>
      </Table>
    </Box>
    </Box>
  );
}
