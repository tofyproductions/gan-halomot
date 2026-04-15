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
  const { selectedBranch, selectedBranchName } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hoursDialog, setHoursDialog] = useState({ open: false, employee: null });

  const fetchAttendance = useCallback(() => {
    if (!selectedBranch) return;
    setLoading(true);
    api.get('/payroll/attendance', { params: { branch: selectedBranch, month } })
      .then(res => setData(res.data))
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת מעקב החתמות');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch, month]);

  useEffect(() => { fetchAttendance(); }, [fetchAttendance]);

  const days = useMemo(() => {
    const n = daysInMonth(month);
    return Array.from({ length: n }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      return `${month}-${d}`;
    });
  }, [month]);

  const hasAnyActivity = (block) => block.month_total_hours > 0 || Object.keys(block.days).length > 0;

  const renderEmployeeRow = (block, key) => (
    <TableRow key={key} hover sx={block.unlinked ? { bgcolor: 'warning.50' } : undefined}>
      <TableCell sx={{
        fontWeight: 600,
        position: 'sticky', right: 0, bgcolor: 'background.paper', zIndex: 1,
        borderLeft: '1px solid', borderColor: 'divider',
        minWidth: 180,
      }}>
        {block.full_name}
        {block.israeli_id && !block.unlinked && (
          <Typography variant="caption" display="block" dir="ltr" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
            {block.israeli_id}
          </Typography>
        )}
      </TableCell>
      {days.map(d => {
        const day = block.days[d];
        if (!day) return <TableCell key={d} align="center" sx={{ color: 'text.disabled', fontSize: '0.75rem' }}>—</TableCell>;
        return (
          <TableCell key={d} align="center" sx={{ fontSize: '0.8rem', position: 'relative' }}>
            <Tooltip title={`${day.first_in || '?'} — ${day.last_out || '?'} (${day.punch_count} החתמות)`}>
              <Box sx={{ fontWeight: 700, color: day.incomplete ? 'warning.main' : 'success.dark' }}>
                {day.total_hours || '?'}
                {day.incomplete && <WarningIcon sx={{ fontSize: 12, ml: 0.3 }} />}
              </Box>
            </Tooltip>
          </TableCell>
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

  const activeEmployees = (data?.employees || []).filter(hasAnyActivity);
  const inactiveCount = (data?.employees || []).length - activeEmployees.length;

  return (
    <Box dir="rtl" sx={{ maxWidth: 1400, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב החתמות</Typography>
          <Typography variant="caption" color="text.secondary">
            {selectedBranchName}
            {data && ` • ${data.totals.total_punches} החתמות בחודש • ${data.totals.matched_punches} משויכות`}
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
            {!loading && data && activeEmployees.map(block => renderEmployeeRow(block, block.employee_id))}
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
