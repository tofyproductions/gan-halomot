import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Stack, TextField, Paper, Table, TableBody, TableCell,
  TableHead, TableRow, TableContainer, Chip, Alert, Tooltip, IconButton,
  Card, CardContent, Grid,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { formatCurrency } from '../../utils/hebrewYear';
import EmployeeDetailDialog from './EmployeeDetailDialog';

/**
 * Monthly salary dashboard — for each employee in the selected branch,
 * shows hours worked, base salary from rate×hours (or global), extras
 * (travel / meal / recreation / bonuses), loan deductions, and the total
 * estimated gross. Totals row at the bottom. CSV export.
 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function SalaryTable() {
  const { selectedBranch, selectedBranchName, isAllBranches, branches } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [data, setData] = useState(null);            // single-branch payload from server
  const [perBranch, setPerBranch] = useState(null);  // [{ branch, data, error }] when isAllBranches
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState({ open: false, employeeId: null });

  const fetchData = useCallback(() => {
    if (!selectedBranch) return;
    setLoading(true);

    if (isAllBranches) {
      // Fan out: one request per branch, in parallel. Frontend aggregates.
      Promise.all(branches.map(b => {
        const id = b._id || b.id;
        return api.get('/payroll/salary-summary', { params: { branch: id, month } })
          .then(res => ({ branch: b, data: res.data }))
          .catch(err => ({ branch: b, error: err.message || 'שגיאה' }));
      }))
        .then(results => { setPerBranch(results); setData(null); })
        .catch(err => { console.error(err); toast.error('שגיאה בטעינת טבלת שכר'); })
        .finally(() => setLoading(false));
      return;
    }

    api.get('/payroll/salary-summary', { params: { branch: selectedBranch, month } })
      .then(res => { setData(res.data); setPerBranch(null); })
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת טבלת שכר');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches, branches, month]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // When in "all branches" mode, compute grand totals from per-branch data
  const allTotals = (() => {
    if (!perBranch) return null;
    const t = { employees: 0, hours: 0, base: 0, extras: 0, deductions: 0, total: 0 };
    for (const r of perBranch) {
      const x = r.data?.totals;
      if (!x) continue;
      t.employees   += x.employees   || 0;
      t.hours       += x.hours       || 0;
      t.base        += x.base        || 0;
      t.extras      += x.extras      || 0;
      t.deductions  += x.deductions  || 0;
      t.total       += x.total       || 0;
    }
    return t;
  })();

  const exportCSV = () => {
    const header = ['סניף', 'שם', 'ת״ז', 'סוג', 'שעות', 'ימים', 'שכר בסיס', 'תוספות', 'ניכויים', 'סה״כ מוערך', 'הערות'];
    const rows = [];
    if (isAllBranches && perBranch) {
      for (const grp of perBranch) {
        if (!grp.data) continue;
        for (const r of grp.data.rows) {
          rows.push([
            grp.branch.name, r.full_name, r.israeli_id, r.salary_type === 'global' ? 'גלובלי' : 'שעתי',
            r.hours_total, r.days_worked, r.base_salary, r.extras, r.deductions, r.estimated_total,
            (r.warnings || []).join(' / '),
          ]);
        }
        const t = grp.data.totals;
        rows.push([grp.branch.name + ' — סה״כ', '', '', '', t.hours, '', t.base, t.extras, t.deductions, t.total, '']);
      }
      if (allTotals) rows.push(['כל הסניפים — סה״כ', '', '', '', allTotals.hours, '', allTotals.base, allTotals.extras, allTotals.deductions, allTotals.total, '']);
    } else if (data) {
      for (const r of data.rows) {
        rows.push([
          selectedBranchName, r.full_name, r.israeli_id, r.salary_type === 'global' ? 'גלובלי' : 'שעתי',
          r.hours_total, r.days_worked, r.base_salary, r.extras, r.deductions, r.estimated_total,
          (r.warnings || []).join(' / '),
        ]);
      }
      const t = data.totals;
      rows.push([selectedBranchName + ' — סה״כ', '', '', '', t.hours, '', t.base, t.extras, t.deductions, t.total, '']);
    } else {
      return;
    }
    const csv = '\uFEFF' + [header, ...rows].map(r =>
      r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `salary-${(isAllBranches ? 'all-branches' : (selectedBranchName || 'branch'))}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // In single-branch mode use the API's totals; in all-branches mode use the
  // grand totals computed across branches above.
  const totals = perBranch ? (allTotals || {}) : (data?.totals || {});

  // Renderer for a single employee row — extracted so we can reuse it for
  // both the single-branch flow and per-branch sections in all-branches mode.
  const renderEmployeeRow = (r, keyPrefix = '') => (
    <TableRow
      key={`${keyPrefix}${r.employee_id}`}
      hover
      onClick={() => setDetail({ open: true, employeeId: r.employee_id })}
      sx={{ cursor: 'pointer' }}
    >
      <TableCell sx={{ fontWeight: 600 }}>
        {r.full_name}
        {!r.israeli_id && <Chip label="ללא ת״ז" size="small" color="warning" sx={{ ml: 1 }} />}
        {r.cross_branch && r.cross_branch.elsewhere?.length > 0 && (
          <Tooltip title={
            <Box sx={{ fontSize: '0.8rem' }}>
              <div>בסניף הבית: {r.cross_branch.home_punches} החתמות</div>
              {r.cross_branch.elsewhere.map(x => (
                <div key={x.branch_id}>בסניף {x.branch_name}: {x.punch_count} החתמות</div>
              ))}
              <div style={{ marginTop: 4, opacity: 0.8 }}>השעות נכללות בשכר זה (במחיר של הסניף שלהם).</div>
            </Box>
          }>
            <Chip
              label={`+ ${r.cross_branch.elsewhere.map(x => x.branch_name).join('+')}`}
              size="small"
              sx={{ ml: 0.5, height: 20, fontSize: '0.7rem', bgcolor: '#f3e8ff', color: '#6d28d9', fontWeight: 700 }}
            />
          </Tooltip>
        )}
      </TableCell>
      <TableCell>
        <Chip
          label={r.salary_type === 'global' ? 'גלובלי' : 'שעתי'}
          size="small"
          variant="outlined"
          color={r.salary_type === 'global' ? 'primary' : 'default'}
        />
      </TableCell>
      <TableCell align="center">{r.hours_total}h</TableCell>
      <TableCell align="center" sx={{ fontSize: '0.8rem', color: r.hours_ot125 > 0 ? 'warning.dark' : 'text.disabled' }}>
        {r.hours_ot125 > 0 ? `${r.hours_ot125}h` : '—'}
      </TableCell>
      <TableCell align="center" sx={{ fontSize: '0.8rem', color: r.hours_ot150 > 0 ? 'error.main' : 'text.disabled' }}>
        {r.hours_ot150 > 0 ? `${r.hours_ot150}h` : '—'}
      </TableCell>
      <TableCell align="center">{r.days_worked}</TableCell>
      <TableCell align="center">{formatCurrency(r.base_salary)}</TableCell>
      <TableCell align="center" sx={{ color: r.extras > 0 ? 'success.main' : 'text.disabled' }}>
        {r.extras > 0 ? `+${formatCurrency(r.extras)}` : '—'}
      </TableCell>
      <TableCell align="center" sx={{ color: r.deductions > 0 ? 'error.main' : 'text.disabled' }}>
        {r.deductions > 0 ? `-${formatCurrency(r.deductions)}` : '—'}
      </TableCell>
      <TableCell align="center" sx={{ fontWeight: 800, bgcolor: 'primary.50' }}>
        {formatCurrency(r.estimated_total)}
      </TableCell>
      <TableCell>
        {r.warnings && r.warnings.length > 0 && (
          <Tooltip title={r.warnings.join(' • ')}>
            <Chip
              icon={<WarningAmberIcon />}
              label={r.warnings.length}
              size="small"
              color="warning"
              variant="outlined"
            />
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );

  const renderTotalsRow = (t, label, key, accent = false) => (
    <TableRow key={key} sx={{ bgcolor: accent ? 'primary.50' : 'grey.100', '& td': { fontWeight: 800, fontSize: '0.95rem' } }}>
      <TableCell>{label}</TableCell>
      <TableCell>{t.employees ? t.employees + ' עובדים' : ''}</TableCell>
      <TableCell align="center">{t.hours}h</TableCell>
      <TableCell align="center" />
      <TableCell align="center" />
      <TableCell align="center">—</TableCell>
      <TableCell align="center">{formatCurrency(t.base)}</TableCell>
      <TableCell align="center" sx={{ color: 'success.main' }}>+{formatCurrency(t.extras)}</TableCell>
      <TableCell align="center" sx={{ color: 'error.main' }}>-{formatCurrency(t.deductions)}</TableCell>
      <TableCell align="center" sx={{ bgcolor: accent ? 'primary.100' : undefined }}>{formatCurrency(t.total)}</TableCell>
      <TableCell />
    </TableRow>
  );

  return (
    <Box dir="rtl" sx={{ maxWidth: 1400, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>טבלת שכר חודשית</Typography>
          <Typography variant="caption" color="text.secondary">
            {selectedBranchName} • חישוב אוטומטי משעות ההחתמה ומנתוני העובד
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
            <IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton>
          </Tooltip>
          <Tooltip title="ייצא CSV">
            <IconButton onClick={exportCSV} disabled={!data && !perBranch}><DownloadIcon /></IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* Summary cards */}
      {(data || perBranch) && (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid size={{ xs: 6, md: 3 }}>
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">סה״כ עובדים</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{totals.employees || 0}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">שעות עבודה</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{totals.hours || 0}h</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">שכר בסיס</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>{formatCurrency(totals.base || 0)}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <Card sx={{ borderRadius: 3, background: 'linear-gradient(135deg,#fbbf24,#fb923c)', color: 'white' }}>
              <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                <Typography variant="caption">סה״כ מוערך</Typography>
                <Typography variant="h5" sx={{ fontWeight: 900 }}>{formatCurrency(totals.total || 0)}</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      <Alert severity="info" icon={false} sx={{ mb: 2, py: 0.5, bgcolor: 'info.light', color: 'info.dark', fontSize: '0.78rem' }}>
        שעות רגילות: 0–8/יום • שע״נ 125%: 8–10 • 150%: מעל 10 • גלובליים: שכר יחסי אם לא הגיעו לשעות חובה • לחץ על שורה לפרטים
      </Alert>

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>שעות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, color: 'text.secondary', fontSize: '0.75rem' }}>125%</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, color: 'text.secondary', fontSize: '0.75rem' }}>150%</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>ימים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>שכר בסיס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>תוספות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>ניכויים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: 'primary.50' }}>סה״כ מוערך</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4 }}>טוען…</TableCell></TableRow>}

            {/* Single-branch mode */}
            {!loading && data && data.rows.map(r => renderEmployeeRow(r))}
            {!loading && data && data.rows.length === 0 && (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4 }}>אין עובדים בסניף</TableCell></TableRow>
            )}
            {!loading && data && renderTotalsRow(data.totals, 'סה״כ', 'totals-single', true)}

            {/* All-branches mode: per-branch sections + grand total */}
            {!loading && perBranch && perBranch.flatMap((grp) => {
              const branchKey = grp.branch._id || grp.branch.id;
              const out = [];
              out.push(
                <TableRow key={`hdr-${branchKey}`} sx={{ bgcolor: 'grey.200' }}>
                  <TableCell colSpan={11} sx={{ fontWeight: 900, fontSize: '0.95rem', py: 1 }}>
                    🏠 {grp.branch.name}
                    {grp.error && <Chip size="small" color="error" label={'שגיאה: ' + grp.error} sx={{ ml: 1 }} />}
                  </TableCell>
                </TableRow>
              );
              if (grp.data) {
                if (grp.data.rows.length === 0) {
                  out.push(<TableRow key={`empty-${branchKey}`}><TableCell colSpan={11} align="center" sx={{ py: 2, color: 'text.secondary' }}>אין עובדים בחודש זה</TableCell></TableRow>);
                } else {
                  for (const r of grp.data.rows) out.push(renderEmployeeRow(r, `${branchKey}-`));
                  out.push(renderTotalsRow(grp.data.totals, `${grp.branch.name} — סה״כ`, `totals-${branchKey}`, false));
                }
              }
              return out;
            })}
            {!loading && perBranch && allTotals && renderTotalsRow(allTotals, 'כל הסניפים — סה״כ', 'grand-totals', true)}
          </TableBody>
        </Table>
      </TableContainer>

      <EmployeeDetailDialog
        open={detail.open}
        employeeId={detail.employeeId}
        initialMonth={month}
        onClose={() => setDetail({ open: false, employeeId: null })}
        onChanged={fetchData}
      />
    </Box>
  );
}
