import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box, Typography, Stack, TextField, Paper, Table, TableBody, TableCell,
  TableHead, TableRow, TableContainer, Chip, Alert, Button, Tooltip, IconButton,
} from '@mui/material';
import ScheduleIcon from '@mui/icons-material/Schedule';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningIcon from '@mui/icons-material/Warning';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import html2pdf from 'html2pdf.js';
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
  const [exporting, setExporting] = useState(false);

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

  const exportPDF = async () => {
    if (!data && !perBranch) return;
    setExporting(true);
    try {
      const monthLabel = (() => {
        const [y, m] = month.split('-');
        return `${m}/${y}`;
      })();
      const dayHeaders = days.map(d => `<th style="padding:2px;font-size:7pt">${d.slice(-2)}</th>`).join('');
      const buildRow = (block, kind) => {
        const cells = days.map(d => {
          const day = block.days[d];
          if (!day) return '<td></td>';
          const bg = day.incomplete ? '#fef3c7' : '#d1fae5';
          const fg = day.incomplete ? '#92400e' : '#065f46';
          const range = `${day.first_in || '?'}–${day.last_out || '?'}`;
          return `<td style="padding:1px"><div style="background:${bg};color:${fg};padding:2px 1px;border-radius:3px;line-height:1.1"><div style="font-weight:800;font-size:7pt">${day.total_hours}h</div><div dir="ltr" style="font-size:5pt;opacity:0.8">${range}</div></div></td>`;
        }).join('');
        const nameBg = kind === 'unlinked' ? '#fff7ed' : (kind === 'guest' ? '#f3e8ff' : '#fff');
        const guestBadge = kind === 'guest' && block.home_branch_name
          ? `<div style="font-size:6pt;color:#6d28d9;font-weight:700">אורח/ת מסניף ${block.home_branch_name}</div>` : '';
        const awayBadge = block.away_total_hours > 0
          ? `<div style="font-size:6pt;color:#92400e">+${block.away_total_hours}h בסניף אחר</div>` : '';
        const nameCell = `<td style="text-align:right;font-weight:700;padding:4px 6px;background:${nameBg};border-left:1px solid #ddd">${block.full_name}${guestBadge}${awayBadge}${block.israeli_id ? `<div dir="ltr" style="font-size:6pt;color:#666;font-family:monospace">${block.israeli_id}</div>` : ''}</td>`;
        const totalCell = `<td style="font-weight:800;background:#dbeafe;text-align:center;padding:4px;font-size:8pt">${block.month_total_hours}h</td>`;
        return `<tr>${nameCell}${cells}${totalCell}</tr>`;
      };
      const colspan = days.length + 2;
      const sectionHeader = (label, bg, color) =>
        `<tr><td colspan="${colspan}" style="background:${bg};color:${color || '#111'};font-weight:800;padding:5px 6px;text-align:right;font-size:9pt">${label}</td></tr>`;
      const buildBranchSection = (branchName, branchData) => {
        const grpActive = (branchData.employees || []).filter(hasAnyActivity);
        const grpGuests = (branchData.guests || []).filter(b => b.month_total_hours > 0 || Object.keys(b.days).length > 0);
        const grpUnlinked = branchData.unlinked || [];
        let rows = '';
        if (grpActive.length === 0 && grpGuests.length === 0 && grpUnlinked.length === 0) {
          rows = `<tr><td colspan="${colspan}" style="text-align:center;padding:8px;color:#888">אין החתמות בסניף זה החודש</td></tr>`;
        } else {
          rows += grpActive.map(b => buildRow(b, 'home')).join('');
          if (grpGuests.length > 0) {
            rows += sectionHeader(`🟣 אורחים מסניפים אחרים (${branchName})`, '#ede9fe', '#6d28d9');
            rows += grpGuests.map(b => buildRow(b, 'guest')).join('');
          }
          if (grpUnlinked.length > 0) {
            rows += sectionHeader(`החתמות לא מזוהות (${branchName})`, '#fef3c7', '#92400e');
            rows += grpUnlinked.map(b => buildRow(b, 'unlinked')).join('');
          }
        }
        const banner = sectionHeader(`🏠 ${branchName} · ${branchData.totals?.total_punches || 0} החתמות · ${branchData.totals?.matched_punches || 0} משויכות`, '#e5e7eb');
        return banner + rows;
      };
      let bodyRows = '';
      let headerLabel = '';
      let headerStats = '';
      if (perBranch) {
        headerLabel = 'כל הסניפים';
        headerStats = `${allTotals?.total_punches || 0} החתמות · ${allTotals?.matched_punches || 0} משויכות · ${perBranch.length} סניפים`;
        bodyRows = perBranch
          .filter(grp => grp.data)
          .map(grp => buildBranchSection(grp.branch.name, grp.data))
          .join('');
      } else if (data) {
        headerLabel = selectedBranchName || '';
        headerStats = `${data.totals.total_punches} החתמות · ${data.totals.matched_punches} משויכות · ${activeEmployees.length} עובדים`;
        bodyRows += activeEmployees.map(b => buildRow(b, 'home')).join('');
        if (guestEmployees.length > 0) {
          bodyRows += sectionHeader('🟣 אורחים מסניפים אחרים', '#ede9fe', '#6d28d9');
          bodyRows += guestEmployees.map(b => buildRow(b, 'guest')).join('');
        }
        if ((data.unlinked || []).length > 0) {
          bodyRows += sectionHeader('החתמות לא מזוהות', '#fef3c7', '#92400e');
          bodyRows += data.unlinked.map(b => buildRow(b, 'unlinked')).join('');
        }
      }
      const html = `
        <div dir="rtl" style="font-family:Arial,sans-serif;color:#111">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px">
            <div>
              <div style="font-size:18pt;font-weight:800">דוח החתמות חודשי</div>
              <div style="font-size:10pt;color:#555">${headerLabel} · ${monthLabel}</div>
            </div>
            <div style="font-size:9pt;color:#555">${headerStats}</div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:7pt;table-layout:fixed">
            <thead>
              <tr style="background:#f3f4f6">
                <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #999">עובד</th>
                ${dayHeaders}
                <th style="background:#dbeafe;padding:4px;border-bottom:1px solid #999">סה״כ</th>
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`;
      // Open a new window with the report HTML and trigger the browser's
      // native print dialog. The user picks "Save as PDF" (or Ctrl+P) and gets
      // a clean A4-landscape PDF rendered by the browser itself — Hebrew/RTL
      // and table layout Just Work, no html2canvas quirks. The earlier
      // html2pdf.js approach produced an empty PDF on macOS Safari/Chrome.
      const printable = `<!doctype html>
<html dir="rtl" lang="he">
  <head>
    <meta charset="utf-8">
    <title>${`attendance-${perBranch ? 'all' : (selectedBranchName || 'branch')}-${month}`}</title>
    <style>
      @page { size: A4 landscape; margin: 8mm; }
      * { box-sizing: border-box; }
      body { font-family: Arial, "Segoe UI", "Helvetica Neue", sans-serif; color: #111; margin: 0; padding: 12px; background: #fff; }
      .head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; }
      .head .title { font-size: 18pt; font-weight: 800; }
      .head .sub { font-size: 10pt; color: #555; }
      .head .stats { font-size: 9pt; color: #555; text-align: left; }
      table { width: 100%; border-collapse: collapse; font-size: 7pt; table-layout: fixed; }
      thead th { background: #f3f4f6; padding: 4px 6px; border-bottom: 1px solid #999; text-align: center; }
      thead th:first-child { text-align: right; }
      thead th.total-col { background: #dbeafe; }
      td { padding: 1px; vertical-align: middle; }
      td.name { text-align: right; font-weight: 700; padding: 4px 6px; border-left: 1px solid #ddd; }
      td.total { font-weight: 800; background: #dbeafe; text-align: center; padding: 4px; font-size: 8pt; }
      .day-cell { padding: 2px 1px; border-radius: 3px; line-height: 1.1; text-align: center; }
      .day-cell .h { font-weight: 800; font-size: 7pt; }
      .day-cell .r { font-size: 5pt; opacity: 0.8; direction: ltr; }
      .ok { background: #d1fae5; color: #065f46; }
      .warn { background: #fef3c7; color: #92400e; }
      .badge-guest { font-size: 6pt; color: #6d28d9; font-weight: 700; }
      .badge-away { font-size: 6pt; color: #92400e; }
      .iid { direction: ltr; font-size: 6pt; color: #666; font-family: monospace; }
      .section-row td { padding: 5px 6px; text-align: right; font-size: 9pt; font-weight: 800; }
      .section-banner td { background: #e5e7eb; }
      .section-guests td { background: #ede9fe; color: #6d28d9; }
      .section-unlinked td { background: #fef3c7; color: #92400e; }
      tr.guest td.name { background: #f3e8ff; }
      tr.unlinked td.name { background: #fff7ed; }
      .empty-row td { text-align: center; padding: 8px; color: #888; }
      @media print { body { padding: 0; } .no-print { display: none !important; } }
      .toolbar { position: fixed; top: 8px; left: 8px; background: #fbbf24; color: #111; padding: 6px 12px; border-radius: 6px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    </style>
  </head>
  <body>
    <button class="toolbar no-print" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
    ${html}
  </body>
</html>`;
      const win = window.open('', '_blank', 'width=1200,height=850');
      if (!win) {
        toast.error('הדפדפן חסם את חלון ההדפסה — אפשר חלונות קופצים ונסה שוב');
        return;
      }
      win.document.open();
      win.document.write(printable);
      win.document.close();
      // Give the browser a moment to lay out, then auto-trigger the print dialog.
      setTimeout(() => { try { win.focus(); win.print(); } catch(e) { /* user can click the toolbar button */ } }, 400);
    } catch (e) {
      console.error('PDF export failed:', e);
      toast.error('שגיאה בייצוא: ' + (e?.message || 'לא ידוע'));
    } finally {
      setExporting(false);
    }
  };

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
          <Button
            size="small"
            variant="outlined"
            startIcon={<PictureAsPdfIcon />}
            onClick={exportPDF}
            disabled={(!data && !perBranch) || loading || exporting}
          >
            {exporting ? 'מייצא…' : 'ייצא PDF'}
          </Button>
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
