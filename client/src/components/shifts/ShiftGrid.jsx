import { Box, Paper, Table, TableHead, TableBody, TableRow, TableCell, Typography, Tooltip, Chip } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { HEB_DAYS, fmtDate } from './shiftRows';

/**
 * The week as a table: a row per class (then kitchen, floaters, unplaced), a
 * column per day, people and hours in the cells. Wraps on a phone by
 * scrolling sideways inside its own box — the page itself never widens (see
 * PageHeader for what a wide page does to sticky cells on iOS).
 */
export default function ShiftGrid({ dates, rows, closedDates, warnings = [], switched, editable, onCellClick, onEntryClick, highlightEmployeeId }) {
  const warnOf = (row, date) => warnings.find(w => w.date === date && String(w.classroom_id) === String(row.classroom_id));
  return (
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
                return (
                  <TableCell
                    key={d}
                    onClick={editable && !closed ? () => onCellClick(row, d) : undefined}
                    sx={{
                      verticalAlign: 'top', minWidth: 110, p: 0.75,
                      cursor: editable && !closed ? 'pointer' : 'default',
                      bgcolor: closed ? 'action.disabledBackground' : (warn ? 'warning.soft' : undefined),
                      '&:hover': editable && !closed ? { bgcolor: 'action.hover' } : {},
                    }}
                  >
                    {(row.cells[d] || []).map(e => {
                      const isSwitch = switched.has(`${e.employee_id}|${e.date}`);
                      const mine = highlightEmployeeId && String(e.employee_id) === String(highlightEmployeeId);
                      return (
                        <Box
                          key={e._id || `${e.employee_id}-${e.start_hhmm}`}
                          onClick={editable ? (ev) => { ev.stopPropagation(); onEntryClick(e); } : undefined}
                          sx={{
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
  );
}
