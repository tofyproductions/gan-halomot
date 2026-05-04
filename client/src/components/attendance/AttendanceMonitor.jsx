import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box, Typography, Stack, TextField, Paper, Table, TableBody, TableCell,
  TableHead, TableRow, TableContainer, Chip, Alert, Button, Tooltip, IconButton,
} from '@mui/material';
import ScheduleIcon from '@mui/icons-material/Schedule';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningIcon from '@mui/icons-material/Warning';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import HoursReportDialog from '../employees/HoursReportDialog';

/**
 * Monthly attendance monitor. Columns: employee, day-by-day hours, monthly total.
 * Days with missing punches are flagged. Unlinked punches (no matching
 * employee by israeli_id) are shown in a separate section so the admin can
 * see them and update the corresponding employee's israeli_id.
 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function formatHours(h) {
  if (!h || h === 0) return '—';
  return `${h}h`;
}

export default function AttendanceMonitor() {
  const { selectedBranch, selectedBranchName, isAllBranches, branches } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [data, setData] = useState(null);            // single-branch payload
  const [perBranch, setPerBranch] = useState(null);  // [{ branch, data, error }] in all-branches mode
  const [loading, setLoading] = useState(false);
  const [hoursDialog, setHoursDialog] = useState({ open: false, employee: null });

  const fetchAttendance = useCallback(() => {
    if (!selectedBranch) return;
    setLoading(true);
    if (isAllBranches) {
      Promise.all(branches.map(b => {
        const id = b._id || b.id;
        return api.get('/payroll/attendance', { params: { branch: id, month } })
          .then(res => ({ branch: b, data: res.data }))
          .catch(err => ({ branch: b, error: err.message || 'שגיאה' }));
      }))
        .then(results => { setPerBranch(results); setData(null); })
        .catch(err => { console.error(err); toast.error('שגיאה בטעינת מעקב החתמות'); })
        .finally(() => setLoading(false));
      return;
    }
    api.get('/payroll/attendance', { params: { branch: selectedBranch, month } })
      .then(res => { setData(res.data); setPerBranch(null); })
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת מעקב החתמות');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches, branches, month]);

  useEffect(() => { fetchAttendance(); }, [fetchAttendance]);

  const days = useMemo(() => {
    const n = daysInMonth(month);
    return Array.from({ length: n }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      return `${month}-${d}`;
    });
  }, [month]);

  const hasAnyActivity = (block) => block.month_total_hours > 0 || Object.keys(block.days).length > 0;

  const renderEmployeeRow = (block, key) => {
    // Visual treatment per row state:
    //  - unlinked  → warning.50 (existing)
    //  - guest     → soft purple — clearly NOT a home employee
    //  - has away  → no special bg, but a chip in the name cell
    const rowBg = block.unlinked ? 'warning.50' : (block.is_guest ? '#f3e8ff' : undefined);
    return (
    <TableRow key={key} hover sx={rowBg ? { bgcolor: rowBg } : undefined}>
      <TableCell sx={{
        fontWeight: 600,
        position: 'sticky', right: 0,
        bgcolor: rowBg || 'background.paper', zIndex: 1,
        borderLeft: '1px solid', borderColor: 'divider',
        minWidth: 200,
        cursor: block.employee_id && !block.unlinked ? 'pointer' : 'default',
        '&:hover': block.employee_id && !block.unlinked ? { bgcolor: rowBg || '#f1f5f9' } : {},
      }}
      onClick={() => {
        if (block.employee_id && !block.unlinked) {
          setHoursDialog({
            open: true,
            employee: { _id: block.employee_id, full_name: block.full_name, israeli_id: block.israeli_id },
          });
        }
      }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {block.full_name}
            {block.is_guest && block.home_branch_name && (
              <Chip
                label={`אורח/ת מסניף ${block.home_branch_name}`}
                size="small"
                sx={{ ml: 0.5, height: 18, fontSize: '0.65rem', bgcolor: '#a855f7', color: 'white', fontWeight: 700 }}
              />
            )}
            {block.away_total_hours > 0 && (
              <Chip
                label={`עבד/ה גם בסניף אחר: ${block.away_total_hours}h`}
                size="small"
                sx={{ ml: 0.5, height: 18, fontSize: '0.65rem', bgcolor: '#fef3c7', color: '#92400e', fontWeight: 700 }}
              />
            )}
            {block.israeli_id && !block.unlinked && (
              <Typography variant="caption" display="block" dir="ltr" sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: '0.65rem' }}>
                {block.israeli_id}
              </Typography>
            )}
          </Box>
          {block.employee_id && !block.unlinked && (
            <ScheduleIcon sx={{ fontSize: 14, color: 'text.disabled', ml: 'auto' }} />
          )}
        </Box>
      </TableCell>
      {days.map(d => {
        const day = block.days[d];
        if (!day) return <TableCell key={d} align="center" sx={{ p: 0.3 }}>
          <Box sx={{ width: 52, height: 42, mx: 'auto' }} />
        </TableCell>;
        // Green = complete (has pairs, no trailing). Amber = incomplete.
        const isComplete = !day.incomplete;
        const bgColor = isComplete ? '#d1fae5' : '#fef3c7';
        const textColor = isComplete ? '#065f46' : '#92400e';
        const timeRange = `${day.first_in || '?'}–${day.last_out || '?'}`;
        return (
          <Tooltip key={d} title={
            <Box dir="ltr" sx={{ textAlign: 'center', fontSize: '0.8rem' }}>
              {day.sessions.map((s, i) => (
                <div key={i}>{s.in_hhmm} → {s.out_hhmm} ({Math.round(s.minutes/60*100)/100}h)</div>
              ))}
              {day.trailing_punch && <div style={{color:'#fbbf24'}}>חסרה יציאה: {day.trailing_punch.hhmm}</div>}
              <div style={{marginTop:4,opacity:0.7}}>{day.punch_count} החתמות</div>
            </Box>
          }>
            <TableCell align="center" sx={{ p: 0.3, cursor: 'pointer' }}>
              <Box sx={{
                width: 54, mx: 'auto', py: 0.3, px: 0.3, borderRadius: 1.5,
                bgcolor: bgColor, color: textColor,
                textAlign: 'center', lineHeight: 1.2,
              }}>
                <Box sx={{ fontWeight: 800, fontSize: '0.75rem' }}>{day.total_hours}h</Box>
                <Box dir="ltr" sx={{ fontSize: '0.55rem', fontWeight: 600, opacity: 0.75, letterSpacing: '-0.02em' }}>
                  {timeRange}
                </Box>
              </Box>
            </TableCell>
          </Tooltip>
        );
      })}
      <TableCell align="center" sx={{
        fontWeight: 800, bgcolor: 'primary.50', position: 'sticky', left: 0,
        borderRight: '1px solid', borderColor: 'divider',
      }}>
        {block.month_total_hours}h
      </TableCell>
      <TableCell align="center" sx={{ position: 'sticky', left: 60 }}>
        {!block.unlinked && block.employee_id && (
          <IconButton size="small" onClick={() => setHoursDialog({
            open: true,
            employee: { _id: block.employee_id, full_name: block.full_name, israeli_id: block.israeli_id },
          })}>
            <ScheduleIcon fontSize="small" />
          </IconButton>
        )}
      </TableCell>
    </TableRow>
    );
  };

  const activeEmployees = (data?.employees || []).filter(hasAnyActivity);
  const inactiveCount = (data?.employees || []).length - activeEmployees.length;
  const guestEmployees = (data?.guests || []).filter(b => b.month_total_hours > 0 || Object.keys(b.days).length > 0);

  // Aggregate totals across branches in all-branches mode
  const allTotals = perBranch ? perBranch.reduce((acc, grp) => {
    if (!grp.data?.totals) return acc;
    acc.total_punches   += grp.data.totals.total_punches   || 0;
    acc.matched_punches += grp.data.totals.matched_punches || 0;
    return acc;
  }, { total_punches: 0, matched_punches: 0 }) : null;

  return (
    <Box dir="rtl" sx={{ maxWidth: 1400, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב החתמות</Typography>
          <Typography variant="caption" color="text.secondary">
            {selectedBranchName}
            {data && ` • ${data.totals.total_punches} החתמות בחודש • ${data.totals.matched_punches} משויכות`}
            {allTotals && ` • ${allTotals.total_punches} החתמות סה״כ • ${allTotals.matched_punches} משויכות`}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            label="חודש"
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            size="small"
            sx={{ width: 180 }}
            InputLabelProps={{ shrink: true }}
          />
          <Tooltip title="רענן">
            <IconButton onClick={fetchAttendance} disabled={loading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {data && data.unlinked && data.unlinked.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          יש {data.unlinked.length} קבוצות החתמות שלא מזוהות (ת״ז לא נמצא אצל עובד פעיל). עדכן את ה-ת״ז בדף העובדים כדי לקשר אותן.
        </Alert>
      )}

      <TableContainer component={Paper} sx={{ borderRadius: 3, maxHeight: '75vh' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{
                fontWeight: 700, position: 'sticky', right: 0, zIndex: 3,
                bgcolor: 'background.paper', minWidth: 180,
                borderLeft: '1px solid', borderColor: 'divider',
              }}>
                עובד
              </TableCell>
              {days.map(d => (
                <TableCell key={d} align="center" sx={{ fontWeight: 700, fontSize: '0.7rem', minWidth: 40 }}>
                  {d.slice(-2)}
                </TableCell>
              ))}
              <TableCell align="center" sx={{ fontWeight: 800, position: 'sticky', left: 0, bgcolor: 'primary.50', zIndex: 2 }}>
                סה״כ
              </TableCell>
              <TableCell sx={{ position: 'sticky', left: 60, bgcolor: 'background.paper', zIndex: 2 }}>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={days.length + 3} align="center" sx={{ py: 4 }}>טוען…</TableCell></TableRow>
            )}

            {/* Single-branch mode */}
            {!loading && data && activeEmployees.map(block => renderEmployeeRow(block, block.employee_id))}
            {!loading && data && guestEmployees.length > 0 && (
              <>
                <TableRow>
                  <TableCell colSpan={days.length + 3} sx={{ bgcolor: '#ede9fe', fontWeight: 700, py: 1, color: '#6d28d9' }}>
                    🟣 אורחים מסניפים אחרים — החתימו פה אך משויכים לסניף אחר (השעות נספרות בשכר של סניף הבית שלהם)
                  </TableCell>
                </TableRow>
                {guestEmployees.map(block => renderEmployeeRow(block, `guest-${block.employee_id}`))}
              </>
            )}
            {!loading && data && data.unlinked && data.unlinked.length > 0 && (
              <>
                <TableRow>
                  <TableCell colSpan={days.length + 3} sx={{ bgcolor: 'warning.100', fontWeight: 700, py: 1 }}>
                    החתמות לא מזוהות
                  </TableCell>
                </TableRow>
                {data.unlinked.map(block => renderEmployeeRow(block, `unlinked-${block.israeli_id}`))}
              </>
            )}
            {!loading && data && activeEmployees.length === 0 && (!data.unlinked || data.unlinked.length === 0) && (
              <TableRow><TableCell colSpan={days.length + 3} align="center" sx={{ py: 4 }}>אין החתמות בחודש הזה</TableCell></TableRow>
            )}

            {/* All-branches mode: per-branch sections */}
            {!loading && perBranch && perBranch.flatMap((grp) => {
              const branchKey = grp.branch._id || grp.branch.id;
              const out = [];
              const grpActive = (grp.data?.employees || []).filter(hasAnyActivity);
              const grpGuests = (grp.data?.guests || []).filter(b => b.month_total_hours > 0 || Object.keys(b.days).length > 0);
              const grpUnlinked = grp.data?.unlinked || [];
              out.push(
                <TableRow key={`hdr-${branchKey}`} sx={{ bgcolor: 'grey.200' }}>
                  <TableCell colSpan={days.length + 3} sx={{ fontWeight: 900, fontSize: '0.95rem', py: 1, position: 'sticky', right: 0, bgcolor: 'grey.200', zIndex: 2 }}>
                    🏠 {grp.branch.name}
                    {grp.error
                      ? <Chip size="small" color="error" label={'שגיאה: ' + grp.error} sx={{ ml: 1 }} />
                      : grp.data && <Chip size="small" variant="outlined" label={`${grp.data.totals.total_punches} החתמות, ${grp.data.totals.matched_punches} משויכות`} sx={{ ml: 1 }} />
                    }
                  </TableCell>
                </TableRow>
              );
              if (grp.data) {
                if (grpActive.length === 0 && grpGuests.length === 0 && grpUnlinked.length === 0) {
                  out.push(<TableRow key={`empty-${branchKey}`}><TableCell colSpan={days.length + 3} align="center" sx={{ py: 2, color: 'text.secondary' }}>אין החתמות בסניף זה החודש</TableCell></TableRow>);
                } else {
                  for (const b of grpActive) out.push(renderEmployeeRow(b, `${branchKey}-${b.employee_id}`));
                  if (grpGuests.length > 0) {
                    out.push(
                      <TableRow key={`gst-hdr-${branchKey}`}>
                        <TableCell colSpan={days.length + 3} sx={{ bgcolor: '#ede9fe', fontWeight: 700, py: 0.5, fontSize: '0.8rem', color: '#6d28d9' }}>
                          🟣 אורחים מסניפים אחרים ({grp.branch.name})
                        </TableCell>
                      </TableRow>
                    );
                    for (const b of grpGuests) out.push(renderEmployeeRow(b, `${branchKey}-guest-${b.employee_id}`));
                  }
                  if (grpUnlinked.length > 0) {
                    out.push(
                      <TableRow key={`unl-hdr-${branchKey}`}>
                        <TableCell colSpan={days.length + 3} sx={{ bgcolor: 'warning.50', fontWeight: 700, py: 0.5, fontSize: '0.85rem' }}>
                          החתמות לא מזוהות ({grp.branch.name})
                        </TableCell>
                      </TableRow>
                    );
                    for (const b of grpUnlinked) out.push(renderEmployeeRow(b, `${branchKey}-unl-${b.israeli_id}`));
                  }
                }
              }
              return out;
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {inactiveCount > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {inactiveCount} עובדים נוספים ללא החתמות בחודש זה הוסתרו מהטבלה
        </Typography>
      )}

      <HoursReportDialog
        open={hoursDialog.open}
        employee={hoursDialog.employee}
        onClose={() => setHoursDialog({ open: false, employee: null })}
      />
    </Box>
  );
}
