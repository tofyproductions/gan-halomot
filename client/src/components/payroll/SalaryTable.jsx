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
  const { selectedBranch, selectedBranchName } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(() => {
    if (!selectedBranch) return;
    setLoading(true);
    api.get('/payroll/salary-summary', { params: { branch: selectedBranch, month } })
      .then(res => setData(res.data))
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת טבלת שכר');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch, month]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const exportCSV = () => {
    if (!data) return;
    const header = ['שם', 'ת״ז', 'סוג', 'שעות', 'ימים', 'שכר בסיס', 'תוספות', 'ניכויים', 'סה״כ מוערך', 'הערות'];
    const rows = data.rows.map(r => [
      r.full_name, r.israeli_id, r.salary_type === 'global' ? 'גלובלי' : 'שעתי',
      r.hours_total, r.days_worked, r.base_salary, r.extras, r.deductions, r.estimated_total,
      (r.warnings || []).join(' / '),
    ]);
    rows.push(['סה״כ', '', '', data.totals.hours, '', data.totals.base, data.totals.extras, data.totals.deductions, data.totals.total, '']);
    const csv = '\uFEFF' + [header, ...rows].map(r =>
      r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `salary-${selectedBranchName || 'branch'}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totals = data?.totals || {};

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
            <IconButton onClick={exportCSV} disabled={!data}><DownloadIcon /></IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* Summary cards */}
      {data && (
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

      <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
        <strong>חישוב אוטומטי — גרסה ראשונה.</strong> לא כולל ניכויי מס הכנסה, ביטוח לאומי, או פנסיה.
        שעות רגילות: 0–8/יום. שע״נ 125%: 8–10/יום. שע״נ 150%: מעל 10/יום. עובדים גלובליים מקבלים שכר מלא ללא קשר לשעות בפועל.
      </Alert>

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>שעות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>ימים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>שכר בסיס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>תוספות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>ניכויים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: 'primary.50' }}>סה״כ מוערך</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>טוען…</TableCell></TableRow>}
            {!loading && data && data.rows.map(r => (
              <TableRow key={r.employee_id} hover>
                <TableCell sx={{ fontWeight: 600 }}>
                  {r.full_name}
                  {!r.israeli_id && <Chip label="ללא ת״ז" size="small" color="warning" sx={{ ml: 1 }} />}
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
            ))}
            {!loading && data && data.rows.length === 0 && (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}>אין עובדים בסניף</TableCell></TableRow>
            )}
            {data && (
              <TableRow sx={{ bgcolor: 'grey.100', '& td': { fontWeight: 800, fontSize: '0.95rem' } }}>
                <TableCell>סה״כ</TableCell>
                <TableCell>{totals.employees} עובדים</TableCell>
                <TableCell align="center">{totals.hours}h</TableCell>
                <TableCell align="center">—</TableCell>
                <TableCell align="center">{formatCurrency(totals.base)}</TableCell>
                <TableCell align="center" sx={{ color: 'success.main' }}>+{formatCurrency(totals.extras)}</TableCell>
                <TableCell align="center" sx={{ color: 'error.main' }}>-{formatCurrency(totals.deductions)}</TableCell>
                <TableCell align="center" sx={{ bgcolor: 'primary.100' }}>{formatCurrency(totals.total)}</TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
