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

export default function EmployeeDetailDialog({ open, employeeId, initialMonth, onClose, onChanged }) {
  const [tab, setTab] = useState(0);
  const [month, setMonth] = useState(initialMonth || currentYearMonth());
  const [employee, setEmployee] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [hoursReport, setHoursReport] = useState(null);
  const [forceFullGlobal, setForceFullGlobal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Local edit state for loans/bonuses
  const [loans, setLoans] = useState([]);
  const [bonuses, setBonuses] = useState([]);
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
        setEmployee(empRes.data.employee);
        setLoans(empRes.data.employee.loans || []);
        setBonuses(empRes.data.employee.bonuses || []);
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
    if (!confirm('למחוק את ההחתמה? (לא ניתן לשחזר)')) return;
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
              label={employee?.salary_type === 'global' ? 'גלובלי' : 'שעתי'}
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

      <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="סיכום" />
        <Tab label={`שעות יומיות (${hoursReport?.totals.days_worked || 0})`} />
        <Tab label={`הלוואות (${loans.length})`} />
        <Tab label={`בונוסים (${bonuses.length})`} />
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
                    {forceFullGlobal ? 'חזור לחישוב יחסי' : 'השלם לשכר גלובלי מלא'}
                  </Button>
                }
              >
                {forceFullGlobal
                  ? `שכר גלובלי מלא: ₪${breakdown.rates.global_salary} (מנהל השלים ידנית)`
                  : `שכר יחסי: עבד/ה ${breakdown.hours.total}h מתוך ${breakdown.rates.required_hours}h נדרשות`
                }
              </Alert>
            )}

            <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1 }}>פירוט רכיבים</Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
              <Table size="small">
                <TableBody>
                  <TableRow>
                    <TableCell>שכר בסיס</TableCell>
                    <TableCell align="left" sx={{ fontWeight: 700 }}>{formatCurrency(breakdown.components.base_salary)}</TableCell>
                  </TableRow>
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
      </DialogContent>

      {/* Contracts section */}
      {emp && (
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
