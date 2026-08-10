import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, Stack, Chip, TextField, InputAdornment, Button,
  Table, TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip,
  MenuItem, CircularProgress, Alert, Checkbox,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import VisibilityIcon from '@mui/icons-material/Visibility';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * תלושי העובדים — a branch manager's view of the payslips her staff received.
 *
 * The salary table is accountant-only on purpose: filing a bonus does not
 * require seeing everyone's rate and net. A payslip that has already been SENT
 * to the employee is a different document — it is the one her staff bring to
 * her when they think a month is wrong, and until now the only answer she
 * could give was "I'll ask the accountant".
 *
 * Employees with no payslip at all are listed too, in amber. A screen that
 * shows only the payslips that exist cannot show the one that was never sent,
 * which is the failure worth catching before the employee does.
 */

const monthLabel = (ym) => {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  return `${names[Number(m) - 1] || m} ${y}`;
};

export default function BranchPayslips() {
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [months, setMonths] = useState([]);
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState('');

  const fetchData = useCallback(() => {
    setLoading(true);
    const branch = localStorage.getItem('selectedBranch');
    api.get('/payroll/branch-payslips', { params: branch ? { branch } : {} })
      .then(res => {
        setEmployees(res.data.employees || []);
        setMonths(res.data.months || []);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת התלושים'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openPayslip = async (emp, ym, { download } = {}) => {
    setBusy(`${emp.id}-${ym}`);
    try {
      const res = await api.get(`/payroll/employees/${emp.id}/saved-payslips/${ym}/pdf`,
        { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      if (download) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `תלוש-${emp.full_name}-${ym}.pdf`;
        a.click();
      } else {
        window.open(url, '_blank', 'noopener');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בפתיחת התלוש');
    } finally { setBusy(''); }
  };

  /** All of one employee's payslips, or just the filtered month, in one PDF. */
  const exportEmployee = async (emp) => {
    const list = month ? emp.payslips.filter(p => p.year_month === month) : emp.payslips;
    if (!list.length) return;
    setBusy(`export-${emp.id}`);
    try {
      const res = await api.post(`/payroll/employees/${emp.id}/saved-payslips/export`,
        { months: list.map(p => p.year_month) }, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `תלושים-${emp.full_name}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בייצוא');
    } finally { setBusy(''); }
  };

  const visible = employees.filter(e => {
    const q = search.trim().toLowerCase();
    if (q && !e.full_name?.toLowerCase().includes(q) && !String(e.israeli_id).includes(q)) return false;
    if (month && !e.payslips.some(p => p.year_month === month)) return !missingOnly ? false : true;
    if (missingOnly) {
      return month ? !e.payslips.some(p => p.year_month === month) : e.payslips.length === 0;
    }
    return true;
  });

  const withoutAny = employees.filter(e => e.payslips.length === 0).length;
  const missingThisMonth = month
    ? employees.filter(e => !e.payslips.some(p => p.year_month === month)).length
    : 0;

  const selectedEmployees = visible.filter(e => selected[e.id] && e.payslips.length);

  /** One PDF for the whole branch — what a manager prints for a staff meeting. */
  const exportSelected = async () => {
    const list = selectedEmployees.length ? selectedEmployees : visible.filter(e => e.payslips.length);
    if (!list.length) return toast.info('אין תלושים לייצוא');
    setBusy('export-all');
    try {
      // Sequential on purpose: each export renders a PDF server-side, and the
      // free Render tier has 512MB — a burst of parallel merges is what would
      // take the whole instance down mid-list.
      for (const emp of list) {
        const months2 = month
          ? emp.payslips.filter(p => p.year_month === month).map(p => p.year_month)
          : emp.payslips.map(p => p.year_month);
        if (!months2.length) continue;
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post(`/payroll/employees/${emp.id}/saved-payslips/export`,
          { months: months2 }, { responseType: 'blob' });
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `תלושים-${emp.full_name}${month ? `-${month}` : ''}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      toast.success(`הורדו תלושים ל-${list.length} עובדים`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בייצוא');
    } finally { setBusy(''); }
  };

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>תלושי העובדים</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${employees.length} עובדים`} />
            {withoutAny > 0 && (
              <Tooltip title="עובדים שלא נשלח אליהם אף תלוש">
                <Chip
                  size="small" color="warning" icon={<WarningAmberIcon />}
                  label={`${withoutAny} ללא תלושים`}
                  variant={missingOnly && !month ? 'filled' : 'outlined'}
                  onClick={() => { setMonth(''); setMissingOnly(v => !v); }}
                  sx={{ cursor: 'pointer', fontWeight: 700 }}
                />
              </Tooltip>
            )}
            {month && missingThisMonth > 0 && (
              <Chip
                size="small" color="warning" icon={<WarningAmberIcon />}
                label={`${missingThisMonth} ללא תלוש ל${monthLabel(month)}`}
                variant={missingOnly ? 'filled' : 'outlined'}
                onClick={() => setMissingOnly(v => !v)}
                sx={{ cursor: 'pointer', fontWeight: 700 }}
              />
            )}
          </Stack>
        </Box>
        <Button
          variant="outlined" startIcon={<DownloadIcon />}
          disabled={!!busy || loading}
          onClick={exportSelected}
        >
          {busy === 'export-all' ? 'מוריד…'
            : selectedEmployees.length ? `הורד ${selectedEmployees.length} נבחרים` : 'הורד הכל'}
        </Button>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small" placeholder="חיפוש לפי שם או ת.ז…"
          value={search} onChange={e => setSearch(e.target.value)}
          sx={{ width: 280 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField
          select size="small" label="חודש" sx={{ minWidth: 180 }}
          value={month} onChange={e => setMonth(e.target.value)}
        >
          <MenuItem value="">כל החודשים</MenuItem>
          {months.map(m => <MenuItem key={m} value={m}>{monthLabel(m)}</MenuItem>)}
        </TextField>
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : employees.length === 0 ? (
        <Alert severity="info">
          לא משויכים אליך סניפים לניהול, או שאין עובדים פעילים בסניף.
          אם ההרשאה ניתנה זה עתה — יש להתנתק ולהתחבר מחדש.
        </Alert>
      ) : (
        <Card>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell padding="checkbox" />
                <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תפקיד</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תלושים</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700 }}>ייצוא</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map(emp => {
                const slips = month
                  ? emp.payslips.filter(p => p.year_month === month)
                  : emp.payslips;
                return (
                  <TableRow key={emp.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small" disabled={!emp.payslips.length}
                        checked={!!selected[emp.id]}
                        onChange={() => setSelected(s => ({ ...s, [emp.id]: !s[emp.id] }))}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {emp.full_name}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} dir="ltr">
                        {emp.israeli_id}
                      </Typography>
                    </TableCell>
                    <TableCell>{emp.position || '—'}</TableCell>
                    <TableCell>{emp.branch_name || '—'}</TableCell>
                    <TableCell>
                      {slips.length === 0 ? (
                        <Chip size="small" color="warning" variant="outlined"
                          label={month ? 'לא נשלח תלוש לחודש זה' : 'אין תלושים'} />
                      ) : (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {slips.map(p => (
                            <Tooltip
                              key={p.year_month}
                              title={p.delivered_to_employee
                                ? `נשלח לעובד/ת ${p.sent_at ? new Date(p.sent_at).toLocaleDateString('he-IL') : ''}${p.sent_to ? ` אל ${p.sent_to}` : ''}`
                                : `טרם נשלח לעובד/ת — הגיע לניהול${p.manager_sent_at ? ` ב-${new Date(p.manager_sent_at).toLocaleDateString('he-IL')}` : ''}`}
                            >
                              <Chip
                                size="small"
                                icon={<DescriptionIcon />}
                                label={monthLabel(p.year_month)}
                                // Filled = the employee has it. Outlined = only
                                // this screen does. A manager asked "did she
                                // get her payslip?" needs to see the difference
                                // without opening anything.
                                variant={p.delivered_to_employee ? 'filled' : 'outlined'}
                                color={p.delivered_to_employee ? 'success' : 'default'}
                                onClick={() => openPayslip(emp, p.year_month)}
                                disabled={busy === `${emp.id}-${p.year_month}`}
                                sx={{ cursor: 'pointer', fontWeight: 600 }}
                              />
                            </Tooltip>
                          ))}
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title={month ? 'הורדת התלוש' : 'הורדת כל התלושים כקובץ אחד'}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={!slips.length || busy === `export-${emp.id}`}
                            onClick={() => (month && slips.length === 1
                              ? openPayslip(emp, slips[0].year_month, { download: true })
                              : exportEmployee(emp))}
                          >
                            {busy === `export-${emp.id}`
                              ? <CircularProgress size={16} />
                              : <DownloadIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="צפייה בתלוש האחרון">
                        <span>
                          <IconButton
                            size="small"
                            disabled={!slips.length}
                            onClick={() => openPayslip(emp, slips[0].year_month)}
                          >
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    אין תוצאות
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </Box>
  );
}
