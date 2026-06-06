import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Tabs, Tab, Box, Chip, Alert, IconButton, TextField, Divider, Tooltip,
  InputAdornment, MenuItem, Card, CardContent, Grid,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DownloadIcon from '@mui/icons-material/Download';
import DescriptionIcon from '@mui/icons-material/Description';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatCurrency } from '../../utils/hebrewYear';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * EmployeeDetailDialog — the "zoom into one employee" view. Tabs:
 *   1. סיכום      — salary breakdown + rates + warnings
 *   2. שעות יומיות — daily hours + delete individual punches + add manual pair
 *   3. הלוואות     — list + add/delete, saved as a batch via PUT /employees/:id
 *   4. בונוסים     — same
 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function formatDate(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const [y, m, d] = yyyyMmDd.split('-');
  return `${d}/${m}/${y}`;
}
function emptyLoan() {
  return { total_amount: '', installment_amount: '', installments_total: '', installments_paid: '', started_at: '', notes: '' };
}
function emptyBonus() {
  return { type: 'fixed', amount: '', reason: '', active: true };
}

export default function EmployeeDetailDialog({ open, employeeId, initialMonth, initialTab, onClose, onChanged }) {
  const { branches } = useBranch();
  const confirm = useConfirm();
  const [tab, setTab] = useState(initialTab ?? 0);
  const [month, setMonth] = useState(initialMonth || currentYearMonth());
  const [employee, setEmployee] = useState(null);
  const [branchRates, setBranchRates] = useState([]);
  const [breakdown, setBreakdown] = useState(null);
  const [hoursReport, setHoursReport] = useState(null);
  const [forceFullGlobal, setForceFullGlobal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Local edit state for loans/bonuses
  const [loans, setLoans] = useState([]);
  const [bonuses, setBonuses] = useState([]);
  // Local edit state for personal/payroll basic details (Tab 4)
  const [details, setDetails] = useState({});
  const [savingDetails, setSavingDetails] = useState(false);
  // Manual punch form
  const [manualForm, setManualForm] = useState({ open: false, date: '', in_time: '08:00', out_time: '16:00', note: '' });

  const refresh = useCallback(() => {
    if (!employeeId) return;
    setLoading(true);
    Promise.all([
      api.get(`/payroll/employees/${employeeId}`),
      api.get(`/payroll/employees/${employeeId}/salary`, { params: { month, force_full_global: forceFullGlobal } }),
      api.get(`/payroll/employees/${employeeId}/hours-report`, { params: { month } }),
    ])
      .then(([empRes, salaryRes, hoursRes]) => {
        const emp = empRes.data.employee;
        setEmployee(emp);
        setLoans(emp.loans || []);
        setBonuses(emp.bonuses || []);
        setBranchRates((emp.branch_rates || []).map(br => ({
          branch_id: String(br.branch_id?._id || br.branch_id),
          hourly_rate: br.hourly_rate ?? '',
          global_salary: br.global_salary ?? '',
          global_ot_rate: br.global_ot_rate ?? '',
          required_hours: br.required_hours ?? '',
        })));
        const firstAmuta = emp.amuta_distribution?.[0] || {};
        setDetails({
          start_date: emp.start_date ? new Date(emp.start_date).toISOString().slice(0, 10) : '',
          position: emp.position || '',
          phone: emp.phone || '',
          email: emp.email || '',
          address: emp.address || '',
          salary_type: emp.salary_type || 'hourly',
          hourly_rate: firstAmuta.hourly_rate || '',
          global_salary: firstAmuta.global_salary || '',
          global_ot_rate: firstAmuta.global_ot_rate || '',
          required_hours: firstAmuta.required_hours || '',
          travel_mode: emp.travel_mode || 'per_day',
          travel_per_day: emp.travel_per_day ?? 16,
          travel_monthly_flat: emp.travel_monthly_flat || 0,
          meal_vouchers: emp.meal_vouchers || 0,
          recreation_annual: emp.recreation_annual || 0,
          pension_exempt: !!emp.pension_exempt,
          bituach_leumi_exempt: !!emp.bituach_leumi_exempt,
        });
        setBreakdown(salaryRes.data.breakdown);
        setHoursReport(hoursRes.data);
      })
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת נתוני העובד');
      })
      .finally(() => setLoading(false));
  }, [employeeId, month, forceFullGlobal]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);
  // When opened with an explicit initialTab, jump there (and only there) once per open cycle.
  useEffect(() => {
    if (open && initialTab != null) setTab(initialTab);
  }, [open, initialTab]);

  // --- Loans / bonuses local editing ---
  const saveLoansBonuses = async () => {
    setSaving(true);
    try {
      const cleanLoans = loans
        .map(l => ({
          total_amount: Number(l.total_amount) || 0,
          installment_amount: Number(l.installment_amount) || 0,
          installments_total: Number(l.installments_total) || 0,
          installments_paid: Number(l.installments_paid) || 0,
          // Preserve the per-month schedule model managed in LoansDialog.
          start_month: l.start_month || '',
          payments: Array.isArray(l.payments) ? l.payments : [],
          started_at: l.started_at || null,
          notes: l.notes || '',
        }))
        .filter(l => l.total_amount > 0 && l.installments_total > 0);
      const cleanBonuses = bonuses
        .map(b => ({
          type: b.type || 'fixed',
          amount: Number(b.amount) || 0,
          reason: b.reason || '',
          effective_from: b.effective_from || null,
          effective_to: b.effective_to || null,
          active: b.active !== false,
        }))
        .filter(b => b.amount !== 0);
      await api.put(`/payroll/employees/${employeeId}`, { loans: cleanLoans, bonuses: cleanBonuses });
      toast.success('עודכן');
      refresh();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  };

  const saveDetails = async () => {
    setSavingDetails(true);
    try {
      const firstAmuta = employee?.amuta_distribution?.[0] || {};
      const updatedAmuta = [
        {
          ...firstAmuta,
          amuta_id: firstAmuta.amuta_id?._id || firstAmuta.amuta_id,
          hourly_rate: Number(details.hourly_rate) || null,
          global_salary: Number(details.global_salary) || null,
          global_ot_rate: Number(details.global_ot_rate) || null,
          required_hours: Number(details.required_hours) || null,
        },
        ...(employee?.amuta_distribution || []).slice(1),
      ];
      const cleanBranchRates = branchRates
        .filter(br => br.branch_id && (br.hourly_rate || br.global_salary))
        .map(br => ({
          branch_id: br.branch_id,
          hourly_rate: br.hourly_rate === '' ? null : Number(br.hourly_rate),
          global_salary: br.global_salary === '' ? null : Number(br.global_salary),
          global_ot_rate: br.global_ot_rate === '' ? null : Number(br.global_ot_rate),
          required_hours: br.required_hours === '' ? null : Number(br.required_hours),
        }));
      await api.put(`/payroll/employees/${employeeId}`, {
        start_date: details.start_date || null,
        position: details.position,
        phone: details.phone,
        email: details.email,
        address: details.address,
        salary_type: details.salary_type,
        amuta_distribution: updatedAmuta,
        branch_rates: cleanBranchRates,
        travel_mode: details.travel_mode,
        travel_per_day: Number(details.travel_per_day) || 0,
        travel_monthly_flat: Number(details.travel_monthly_flat) || 0,
        meal_vouchers: Number(details.meal_vouchers) || 0,
        recreation_annual: Number(details.recreation_annual) || 0,
        pension_exempt: details.pension_exempt,
        bituach_leumi_exempt: details.bituach_leumi_exempt,
      });
      toast.success('פרטי העובד נשמרו');
      refresh();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSavingDetails(false);
    }
  };

  // --- Manual punch creation ---
  const submitManualPunch = async () => {
    const { date, in_time, out_time, note } = manualForm;
    if (!date) return toast.error('בחר תאריך');
    if (!in_time && !out_time) return toast.error('הזן לפחות שעת כניסה או יציאה');
    try {
      await api.post('/payroll/manual-punches', { employee_id: employeeId, date, in_time, out_time, note });
      toast.success('ההחתמה הידנית נוספה');
      setManualForm({ open: false, date: '', in_time: '08:00', out_time: '16:00', note: '' });
      refresh();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהוספה');
    }
  };

  // --- Delete a single punch ---
  const deletePunch = async (punchId) => {
    if (!(await confirm({ title: 'מחיקת החתמה', message: 'למחוק את ההחתמה? (לא ניתן לשחזר)', danger: true, remember_key: 'delete-punch' }))) return;
    try {
      await api.delete(`/payroll/punches/${punchId}`);
      toast.success('נמחק');
      refresh();
      onChanged?.();
    } catch (err) {
      toast.error('שגיאה במחיקה');
    }
  };

  const exportHoursCSV = () => {
    if (!hoursReport) return;
    const header = ['תאריך', 'כניסה', 'יציאה', 'שעות', 'הערה'];
    const rows = hoursReport.days.map(d => [
      formatDate(d.date), d.first_in || '', d.last_out || '',
      d.total_hours || 0, d.incomplete ? 'חסרה החתמה' : '',
    ]);
    rows.push(['', '', 'סה״כ', hoursReport.totals.total_hours, `${hoursReport.totals.days_worked} ימים`]);
    const csv = '\uFEFF' + [header, ...rows].map(r =>
      r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-${employee?.full_name}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            {employee?.full_name || 'טוען…'}
            {employee?.israeli_id && (
              <Chip label={employee.israeli_id} size="small" dir="ltr" sx={{ ml: 1, fontFamily: 'monospace' }} />
            )}
            <Chip
              label={employee?.salary_type === 'global' ? 'תקן' : 'שעתי'}
              size="small"
              color={employee?.salary_type === 'global' ? 'primary' : 'default'}
              sx={{ ml: 1 }}
            />
          </Box>
          <TextField
            label="חודש"
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            size="small"
            sx={{ width: 160 }}
            InputLabelProps={{ shrink: true }}
          />
        </Stack>
      </DialogTitle>

      <Tabs value={tab} onChange={(e, v) => setTab(v)} dir="rtl" sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="סיכום" />
        <Tab label={`שעות יומיות (${hoursReport?.totals.days_worked || 0})`} />
        <Tab label={`הלוואות (${loans.length})`} />
        <Tab label={`בונוסים (${bonuses.length})`} />
        <Tab label="פרטים אישיים ושכר" />
      </Tabs>

      <DialogContent sx={{ minHeight: 420 }}>
        {loading && <Typography sx={{ py: 4, textAlign: 'center' }}>טוען…</Typography>}

        {/* --- TAB 0: SUMMARY --- */}
        {!loading && tab === 0 && breakdown && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Grid container spacing={2}>
              <Grid size={{ xs: 6, md: 3 }}>
                <Card variant="outlined" sx={{ borderRadius: 3 }}>
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <Typography variant="caption" color="text.secondary">שעות סה״כ</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 800 }}>{breakdown.hours.total}h</Typography>
                    <Typography variant="caption" color="text.secondary">{breakdown.hours.days_worked} ימים</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 6, md: 3 }}>
                <Card variant="outlined" sx={{ borderRadius: 3 }}>
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <Typography variant="caption" color="text.secondary">רגיל / שע״נ</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>
                      {breakdown.hours.regular}h / {breakdown.hours.ot_125 + breakdown.hours.ot_150}h
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      125%: {breakdown.hours.ot_125}h  •  150%: {breakdown.hours.ot_150}h
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 6, md: 3 }}>
                <Card variant="outlined" sx={{ borderRadius: 3 }}>
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <Typography variant="caption" color="text.secondary">שכר בסיס</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>{formatCurrency(breakdown.components.base_salary)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {breakdown.salary_type === 'hourly'
                        ? `₪${breakdown.rates.hourly_rate}/שעה`
                        : `גלובלי ₪${breakdown.rates.global_salary}`}
                    </Typography>
                    <Box sx={{ mt: 0.3 }}>
                      <Chip size="small" color={breakdown.salary_is_net ? 'success' : 'info'}
                        label={breakdown.salary_is_net ? 'נטו' : 'ברוטו'}
                        sx={{ height: 18, fontWeight: 800, fontSize: '0.65rem' }} />
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 6, md: 3 }}>
                <Card sx={{ borderRadius: 3, background: 'linear-gradient(135deg,#fbbf24,#fb923c)', color: 'white' }}>
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <Typography variant="caption">סה״כ מוערך</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 900 }}>{formatCurrency(breakdown.estimated_total)}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {breakdown.warnings.length > 0 && (
              <Alert severity="warning" sx={{ borderRadius: 2 }}>
                {breakdown.warnings.join(' • ')}
              </Alert>
            )}

            {/* "Force full global" toggle — only for global employees with required_hours */}
            {breakdown.salary_type === 'global' && breakdown.rates.required_hours > 0 && (
              <Alert
                severity={forceFullGlobal ? 'success' : 'warning'}
                sx={{ borderRadius: 2 }}
                action={
                  <Button
                    size="small"
                    variant="contained"
                    color={forceFullGlobal ? 'warning' : 'success'}
                    onClick={() => setForceFullGlobal(!forceFullGlobal)}
                  >
                    {forceFullGlobal ? 'חזור לחישוב יחסי' : 'השלם לשכר תקן מלא'}
                  </Button>
                }
              >
                {forceFullGlobal
                  ? `שכר תקן מלא: ₪${breakdown.rates.global_salary} (מנהל השלים ידנית)`
                  : `שכר יחסי: עבד/ה ${breakdown.hours.total}h מתוך ${breakdown.rates.required_hours}h נדרשות`
                }
              </Alert>
            )}

            <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1 }}>פירוט רכיבים</Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
              <Table size="small">
                <TableBody>
                  {(() => {
                    const tb = breakdown.components.teken_breakdown;
                    if (breakdown.salary_type !== 'global' || !tb) {
                      return (
                        <TableRow>
                          <TableCell>שכר בסיס</TableCell>
                          <TableCell align="left" sx={{ fontWeight: 700 }}>{formatCurrency(breakdown.components.base_salary)}</TableCell>
                        </TableRow>
                      );
                    }
                    return (
                      <>
                        <TableRow>
                          <TableCell>שכר יסוד <Typography component="span" variant="caption" color="text.secondary">({breakdown.hours.regular}h × ₪{tb.hourly_value})</Typography></TableCell>
                          <TableCell align="left" sx={{ fontWeight: 700 }}>{formatCurrency(tb.regular_pay)}</TableCell>
                        </TableRow>
                        {tb.ot_pay > 0 && (
                          <TableRow>
                            <TableCell>גמול שעות נוספות <Typography component="span" variant="caption" color="text.secondary">(125%/150%)</Typography></TableCell>
                            <TableCell align="left" sx={{ fontWeight: 700, color: 'success.dark' }}>{formatCurrency(tb.ot_pay)}</TableCell>
                          </TableRow>
                        )}
                        {tb.completion > 0 && (
                          <TableRow>
                            <TableCell>השלמת שכר <Typography component="span" variant="caption" color="text.secondary">(עד השכר המוסכם)</Typography></TableCell>
                            <TableCell align="left" sx={{ fontWeight: 700, color: 'warning.dark' }}>{formatCurrency(tb.completion)}</TableCell>
                          </TableRow>
                        )}
                        <TableRow sx={{ bgcolor: 'grey.50' }}>
                          <TableCell sx={{ fontWeight: 700 }}>שכר מוסכם <Typography component="span" variant="caption" color="text.secondary">(יסוד + שע״נ + השלמה)</Typography></TableCell>
                          <TableCell align="left" sx={{ fontWeight: 800 }}>{formatCurrency(tb.regular_pay + tb.ot_pay + tb.completion)}</TableCell>
                        </TableRow>
                        {tb.excess_pay > 0 && (
                          <TableRow>
                            <TableCell sx={{ color: tb.supplement_applied > 0 ? 'inherit' : 'text.disabled' }}>
                              תוספת מעבר להתחייבות {tb.supplement_applied > 0 ? '(מאושר)' : '(ממתין לאישור)'}
                              {tb.excess_ot > 0 && <Typography component="span" variant="caption" color="text.secondary"> · כולל שע״נ {formatCurrency(tb.excess_ot)}</Typography>}
                            </TableCell>
                            <TableCell align="left" sx={{ fontWeight: 700, textDecoration: tb.supplement_applied > 0 ? 'none' : 'line-through' }}>+{formatCurrency(tb.excess_pay)}</TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })()}
                  <TableRow>
                    <TableCell>נסיעות</TableCell>
                    <TableCell align="left">{formatCurrency(breakdown.components.travel)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>סיבוס</TableCell>
                    <TableCell align="left">{formatCurrency(breakdown.components.meal_vouchers)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>הבראה (1/12 שנתי)</TableCell>
                    <TableCell align="left">{formatCurrency(breakdown.components.recreation_monthly)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>בונוסים</TableCell>
                    <TableCell align="left" sx={{ color: 'success.main' }}>+{formatCurrency(breakdown.components.bonuses)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>ניכוי הלוואות</TableCell>
                    <TableCell align="left" sx={{ color: 'error.main' }}>-{formatCurrency(breakdown.deductions.loans)}</TableCell>
                  </TableRow>
                  {breakdown.deductions.absence > 0 && (
                    <TableRow>
                      <TableCell>ניכוי היעדרות <Typography component="span" variant="caption" color="text.secondary">(ימי היעדרות מאושרים)</Typography></TableCell>
                      <TableCell align="left" sx={{ color: 'error.main' }}>-{formatCurrency(breakdown.deductions.absence)}</TableCell>
                    </TableRow>
                  )}
                  <TableRow sx={{ bgcolor: 'primary.50' }}>
                    <TableCell sx={{ fontWeight: 800 }}>סה״כ מוערך</TableCell>
                    <TableCell align="left" sx={{ fontWeight: 900, fontSize: '1.1rem' }}>{formatCurrency(breakdown.estimated_total)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        )}

        {/* --- TAB 1: DAILY HOURS --- */}
        {!loading && tab === 1 && hoursReport && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1}>
              <Button
                startIcon={<AddIcon />}
                variant="contained"
                size="small"
                onClick={() => setManualForm({ open: true, date: `${month}-01`, in_time: '08:00', out_time: '16:00', note: '' })}
              >
                הוסף שעות ידנית
              </Button>
              <Button startIcon={<DownloadIcon />} size="small" onClick={exportHoursCSV}>
                ייצא CSV
              </Button>
              <Box sx={{ flex: 1 }} />
              <Chip label={`${hoursReport.totals.total_hours}h בחודש`} color="primary" />
            </Stack>

            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>סשנים</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>שעות</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {hoursReport.days.length === 0 && (
                    <TableRow><TableCell colSpan={4} align="center" sx={{ py: 3 }}>אין ימי עבודה בחודש זה</TableCell></TableRow>
                  )}
                  {hoursReport.days.map(day => (
                    <TableRow key={day.date} hover>
                      <TableCell sx={{ fontWeight: 600 }}>{formatDate(day.date)}</TableCell>
                      <TableCell>
                        <Stack spacing={0.5}>
                          {day.sessions.map((s, i) => (
                            <Stack key={i} direction="row" spacing={1} alignItems="center">
                              <Chip
                                label={`${s.in_hhmm} → ${s.out_hhmm}`}
                                size="small"
                                variant="outlined"
                                dir="ltr"
                                color={s.is_manual ? 'warning' : 'default'}
                              />
                              <Typography variant="caption" color="text.secondary">
                                ({Math.round(s.minutes / 60 * 100) / 100}h)
                              </Typography>
                              <IconButton size="small" onClick={() => deletePunch(s.in_id)} title="מחק כניסה">
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                              <IconButton size="small" onClick={() => deletePunch(s.out_id)} title="מחק יציאה">
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Stack>
                          ))}
                          {day.trailing_punch && (
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Chip
                                icon={<WarningAmberIcon />}
                                label={`${day.trailing_punch.hhmm} (חסר)`}
                                size="small"
                                color="warning"
                                dir="ltr"
                              />
                              <IconButton size="small" onClick={() => deletePunch(day.trailing_punch.id)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Stack>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="center" sx={{ fontWeight: 700 }}>{day.total_hours}h</TableCell>
                      <TableCell align="center">
                        {day.incomplete
                          ? <Chip label="חסרה החתמה" size="small" color="warning" />
                          : <Chip label="תקין" size="small" variant="outlined" />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        )}

        {/* --- TAB 2: LOANS --- */}
        {!loading && tab === 2 && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1}>
              <Button startIcon={<AddIcon />} variant="contained" size="small"
                onClick={() => setLoans([...loans, emptyLoan()])}>
                הוסף הלוואה
              </Button>
              <Box sx={{ flex: 1 }} />
              <Chip label={`ניכוי חודשי: ${formatCurrency(loans.reduce((s, l) => s + (Number(l.installment_amount) || 0), 0))}`} color="warning" />
            </Stack>
            {loans.length === 0 && (
              <Alert severity="info">אין הלוואות פעילות. לחץ "הוסף הלוואה" להוספה.</Alert>
            )}
            {loans.map((loan, i) => (
              <Paper key={i} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                  <TextField label="סכום כולל" type="number" size="small" fullWidth
                    value={loan.total_amount} onChange={e => {
                      const arr = [...loans]; arr[i].total_amount = e.target.value; setLoans(arr);
                    }}
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                  <TextField label="תשלום חודשי" type="number" size="small" fullWidth
                    value={loan.installment_amount} onChange={e => {
                      const arr = [...loans]; arr[i].installment_amount = e.target.value; setLoans(arr);
                    }}
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                  <TextField label="תשלומים (סה״כ)" type="number" size="small" sx={{ width: 130 }}
                    value={loan.installments_total} onChange={e => {
                      const arr = [...loans]; arr[i].installments_total = e.target.value; setLoans(arr);
                    }}
                  />
                  <TextField label="שולמו" type="number" size="small" sx={{ width: 100 }}
                    value={loan.installments_paid} onChange={e => {
                      const arr = [...loans]; arr[i].installments_paid = e.target.value; setLoans(arr);
                    }}
                  />
                  <IconButton color="error" onClick={() => setLoans(loans.filter((_, idx) => idx !== i))}>
                    <DeleteIcon />
                  </IconButton>
                </Stack>
                <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
                  <TextField
                    label="תאריך התחלת תשלום"
                    type="date"
                    size="small"
                    sx={{ width: 200 }}
                    value={loan.started_at ? new Date(loan.started_at).toISOString().slice(0, 10) : ''}
                    onChange={e => {
                      const arr = [...loans]; arr[i].started_at = e.target.value; setLoans(arr);
                    }}
                    InputLabelProps={{ shrink: true }}
                  />
                  <TextField label="הערות (סיבה, תנאים מיוחדים)" size="small" fullWidth
                    value={loan.notes || ''} onChange={e => {
                      const arr = [...loans]; arr[i].notes = e.target.value; setLoans(arr);
                    }}
                  />
                </Stack>
                {Number(loan.installments_total) > 0 && Number(loan.installments_paid) >= 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                    נותרו {Math.max(0, Number(loan.installments_total) - Number(loan.installments_paid))} תשלומים •
                    {' '}סה״כ שולם ₪{(Number(loan.installment_amount) * Number(loan.installments_paid)).toLocaleString()} מתוך ₪{Number(loan.total_amount).toLocaleString()}
                  </Typography>
                )}
              </Paper>
            ))}
            <Button variant="contained" onClick={saveLoansBonuses} disabled={saving}>
              {saving ? 'שומר…' : 'שמור הלוואות'}
            </Button>
          </Stack>
        )}

        {/* --- TAB 3: BONUSES --- */}
        {!loading && tab === 3 && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={1}>
              <Button startIcon={<AddIcon />} variant="contained" size="small"
                onClick={() => setBonuses([...bonuses, emptyBonus()])}>
                הוסף בונוס
              </Button>
              <Box sx={{ flex: 1 }} />
            </Stack>
            {bonuses.length === 0 && (
              <Alert severity="info">אין בונוסים פעילים.</Alert>
            )}
            {bonuses.map((bonus, i) => (
              <Paper key={i} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center">
                  <TextField label="סוג" select size="small" sx={{ width: 140 }}
                    value={bonus.type || 'fixed'} onChange={e => {
                      const arr = [...bonuses]; arr[i].type = e.target.value; setBonuses(arr);
                    }}
                  >
                    <MenuItem value="fixed">קבוע</MenuItem>
                    <MenuItem value="per_hour">לפי שעה</MenuItem>
                    <MenuItem value="per_day">לפי יום</MenuItem>
                  </TextField>
                  <TextField label="סכום" type="number" size="small" sx={{ width: 150 }}
                    value={bonus.amount} onChange={e => {
                      const arr = [...bonuses]; arr[i].amount = e.target.value; setBonuses(arr);
                    }}
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                  <TextField label="סיבה" size="small" fullWidth
                    value={bonus.reason || ''} onChange={e => {
                      const arr = [...bonuses]; arr[i].reason = e.target.value; setBonuses(arr);
                    }}
                  />
                  <IconButton color="error" onClick={() => setBonuses(bonuses.filter((_, idx) => idx !== i))}>
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              </Paper>
            ))}
            <Button variant="contained" onClick={saveLoansBonuses} disabled={saving}>
              {saving ? 'שומר…' : 'שמור בונוסים'}
            </Button>
          </Stack>
        )}

        {/* --- TAB 4: PERSONAL DETAILS + PAYROLL CONFIG --- */}
        {!loading && tab === 4 && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              שינוי הפרטים כאן ישפיע על כל החישובים הבאים (דמי חגים תלוי בתאריך תחילת עבודה).
            </Alert>

            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>פרטים אישיים</Typography>
            <Stack direction="row" spacing={2}>
              <TextField
                label="תאריך תחילת עבודה" type="date" fullWidth
                value={details.start_date || ''}
                onChange={e => setDetails({ ...details, start_date: e.target.value })}
                InputLabelProps={{ shrink: true }}
                helperText="קובע זכאות לדמי חגים (3 חודשים ותק מינימום)"
              />
              <TextField
                label="תפקיד" fullWidth
                value={details.position || ''}
                onChange={e => setDetails({ ...details, position: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="טלפון" fullWidth dir="ltr"
                value={details.phone || ''}
                onChange={e => setDetails({ ...details, phone: e.target.value })}
              />
              <TextField label="אימייל" fullWidth dir="ltr"
                value={details.email || ''}
                onChange={e => setDetails({ ...details, email: e.target.value })}
              />
            </Stack>
            <TextField label="כתובת" fullWidth
              value={details.address || ''}
              onChange={e => setDetails({ ...details, address: e.target.value })}
            />

            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הגדרות שכר</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="סוג העסקה" select sx={{ width: 200 }}
                value={details.salary_type || 'hourly'}
                onChange={e => setDetails({ ...details, salary_type: e.target.value })}
              >
                <MenuItem value="hourly">שעתי</MenuItem>
                <MenuItem value="global">תקן</MenuItem>
              </TextField>
              {details.salary_type === 'hourly' ? (
                <TextField label="תעריף שעתי (₪)" type="number" fullWidth
                  value={details.hourly_rate || ''}
                  onChange={e => setDetails({ ...details, hourly_rate: e.target.value })}
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                />
              ) : (
                <>
                  <TextField label="שכר תקן (₪)" type="number" fullWidth
                    value={details.global_salary || ''}
                    onChange={e => setDetails({ ...details, global_salary: e.target.value })}
                  />
                  <TextField label="שעות נדרשות" type="number" sx={{ width: 160 }}
                    value={details.required_hours || ''}
                    onChange={e => setDetails({ ...details, required_hours: e.target.value })}
                  />
                  <TextField label="שע״נ תקן" type="number" sx={{ width: 160 }}
                    value={details.global_ot_rate || ''}
                    onChange={e => setDetails({ ...details, global_ot_rate: e.target.value })}
                  />
                </>
              )}
            </Stack>

            <Divider sx={{ my: 1 }} />
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>תעריפים פר־סניף (עבודה רב-סניפית)</Typography>
              <Chip size="small" label="אופציונלי" variant="outlined" />
            </Stack>
            <Alert severity="info" sx={{ borderRadius: 2, py: 0.5 }}>
              עובדת שעובדת בכמה סניפים — הוסף שורה לכל סניף נוסף עם התעריף שלה שם.
              שעות שהיא תחתום שם יחושבו לפי התעריף הזה. אם לא הוגדר — השעות משולמות בתעריף הראשי.
            </Alert>
            {branchRates.map((br, i) => (
              <Stack key={i} direction="row" spacing={1} alignItems="center">
                <TextField select label="סניף" size="small" sx={{ width: 200 }}
                  value={br.branch_id || ''}
                  onChange={e => {
                    const arr = [...branchRates]; arr[i].branch_id = e.target.value; setBranchRates(arr);
                  }}
                >
                  {(branches || []).map(b => (
                    <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
                  ))}
                </TextField>
                {details.salary_type === 'hourly' ? (
                  <TextField label="תעריף שעתי" type="number" size="small" sx={{ width: 140 }}
                    value={br.hourly_rate} onChange={e => {
                      const arr = [...branchRates]; arr[i].hourly_rate = e.target.value; setBranchRates(arr);
                    }}
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                ) : (
                  <>
                    <TextField label="שכר תקן" type="number" size="small" sx={{ width: 140 }}
                      value={br.global_salary} onChange={e => {
                        const arr = [...branchRates]; arr[i].global_salary = e.target.value; setBranchRates(arr);
                      }}
                    />
                    <TextField label="שעות נדרשות" type="number" size="small" sx={{ width: 130 }}
                      value={br.required_hours} onChange={e => {
                        const arr = [...branchRates]; arr[i].required_hours = e.target.value; setBranchRates(arr);
                      }}
                    />
                  </>
                )}
                <IconButton color="error" onClick={() => setBranchRates(branchRates.filter((_, idx) => idx !== i))}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button
              startIcon={<AddIcon />}
              size="small"
              variant="outlined"
              onClick={() => setBranchRates([...branchRates, { branch_id: '', hourly_rate: '', global_salary: '', global_ot_rate: '', required_hours: '' }])}
            >
              הוסף תעריף לסניף נוסף
            </Button>

            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>נסיעות ותוספות</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="מצב נסיעות" select sx={{ width: 200 }}
                value={details.travel_mode || 'per_day'}
                onChange={e => setDetails({ ...details, travel_mode: e.target.value })}
              >
                <MenuItem value="per_day">לפי יום</MenuItem>
                <MenuItem value="monthly_flat">קבוע חודשי</MenuItem>
              </TextField>
              {details.travel_mode === 'per_day' ? (
                <TextField label="נסיעות ליום (₪)" type="number" fullWidth
                  value={details.travel_per_day ?? 16}
                  onChange={e => setDetails({ ...details, travel_per_day: e.target.value })}
                />
              ) : (
                <TextField label="נסיעות חודשי (₪)" type="number" fullWidth
                  value={details.travel_monthly_flat || 0}
                  onChange={e => setDetails({ ...details, travel_monthly_flat: e.target.value })}
                />
              )}
              <TextField label="סיבוס חודשי קבוע (₪)" type="number" fullWidth
                value={details.meal_vouchers || 0}
                onChange={e => setDetails({ ...details, meal_vouchers: e.target.value })}
              />
              <TextField label="הבראה שנתי (₪)" type="number" fullWidth
                value={details.recreation_annual || 0}
                onChange={e => setDetails({ ...details, recreation_annual: e.target.value })}
              />
            </Stack>

            <Stack direction="row" spacing={3}>
              <Box>
                <input
                  type="checkbox"
                  checked={!!details.pension_exempt}
                  onChange={e => setDetails({ ...details, pension_exempt: e.target.checked })}
                /> פטור מפנסיה
              </Box>
              <Box>
                <input
                  type="checkbox"
                  checked={!!details.bituach_leumi_exempt}
                  onChange={e => setDetails({ ...details, bituach_leumi_exempt: e.target.checked })}
                /> פטור מביטוח לאומי
              </Box>
            </Stack>

            <Box>
              <Button
                variant="contained"
                onClick={saveDetails}
                disabled={savingDetails}
                size="large"
              >
                {savingDetails ? 'שומר…' : 'שמור פרטי עובד'}
              </Button>
            </Box>
          </Stack>
        )}
      </DialogContent>

      {/* Contracts section */}
      {employee && (
        <Box sx={{ px: 3, pb: 2 }}>
          <EmployeeContracts employeeId={employeeId} />
        </Box>
      )}

      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>

      {/* --- Nested: manual punch dialog --- */}
      <Dialog open={manualForm.open} onClose={() => setManualForm({ ...manualForm, open: false })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>הוספת שעות ידנית</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              להוספת יום שבו העובד שכח להחתים.
            </Alert>
            <TextField label="תאריך" type="date" value={manualForm.date}
              onChange={e => setManualForm({ ...manualForm, date: e.target.value })}
              fullWidth InputLabelProps={{ shrink: true }} />
            <Stack direction="row" spacing={2}>
              <TextField label="שעת כניסה" type="time" value={manualForm.in_time}
                onChange={e => setManualForm({ ...manualForm, in_time: e.target.value })}
                fullWidth InputLabelProps={{ shrink: true }} />
              <TextField label="שעת יציאה" type="time" value={manualForm.out_time}
                onChange={e => setManualForm({ ...manualForm, out_time: e.target.value })}
                fullWidth InputLabelProps={{ shrink: true }} />
            </Stack>
            <TextField label="הערה (למשל: שכחה להחתים)" value={manualForm.note}
              onChange={e => setManualForm({ ...manualForm, note: e.target.value })} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManualForm({ ...manualForm, open: false })}>ביטול</Button>
          <Button variant="contained" onClick={submitManualPunch}>הוסף</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

function EmployeeContracts({ employeeId }) {
  const [contracts, setContracts] = useState([]);
  const [uploading, setUploading] = useState(false);

  const fetchContracts = useCallback(() => {
    if (!employeeId) return;
    api.get(`/contracts?employee_id=${employeeId}`)
      .then(res => setContracts(res.data.contracts || []))
      .catch(() => {});
  }, [employeeId]);

  useEffect(() => { fetchContracts(); }, [fetchContracts]);

  const handleUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.post('/contracts/upload', {
          employee_id: employeeId,
          type: 'employment',
          doc_type: 'employment_contract',
          file_name: file.name,
          file_data: reader.result.split(',')[1],
          file_mimetype: file.type || 'application/pdf',
        });
        fetchContracts();
      } catch { /* ignore */ }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  return (
    <Box>
      <Divider sx={{ mb: 1.5 }} />
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <DescriptionIcon fontSize="small" />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>חוזים ומסמכים</Typography>
        <Button component="label" size="small" startIcon={<UploadFileIcon />} disabled={uploading}
          sx={{ fontSize: '0.75rem' }}>
          {uploading ? 'מעלה...' : 'העלה מסמך'}
          <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png" onChange={handleUpload} />
        </Button>
      </Stack>
      {contracts.length > 0 ? (
        <Stack spacing={0.5}>
          {contracts.map(c => (
            <Stack key={c._id} direction="row" alignItems="center" spacing={1}
              sx={{ py: 0.3, '&:hover': { bgcolor: '#f8fafc' }, borderRadius: 1 }}>
              <DescriptionIcon fontSize="small" sx={{ color: '#7c3aed' }} />
              <Typography variant="body2" sx={{ flex: 1 }}>{c.file_name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {new Date(c.created_at).toLocaleDateString('he-IL')}
              </Typography>
              <Button size="small" href={c.file_url} target="_blank" startIcon={<VisibilityIcon />}
                sx={{ fontSize: '0.7rem' }}>צפה</Button>
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary">אין מסמכים. לחץ "העלה מסמך" כדי להוסיף.</Typography>
      )}
    </Box>
  );
}
