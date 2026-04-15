import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Button, Stack, MenuItem, Dialog, DialogTitle, DialogContent,
  DialogActions, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, Chip, IconButton, Tooltip, TextField, Divider, InputAdornment, Alert,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatCurrency } from '../../utils/hebrewYear';
import HoursReportDialog from './HoursReportDialog';

const POSITIONS = ['גננת', 'מובילת כיתה', 'מטפלת', 'סייעת', 'מבשלת', 'מנהלת', 'אחר'];

const EMPTY_FORM = {
  full_name: '',
  israeli_id: '',
  branch_id: '',
  phone: '',
  email: '',
  position: '',
  start_date: '',
  salary_type: 'hourly',
  salary_is_net: false,
  // First-amuta rates — simplified single-amuta view. The full
  // amuta_distribution is preserved on the object and restored on save.
  hourly_rate: '',
  global_salary: '',
  global_ot_rate: '',
  required_hours: '',
  travel_allowance: 0,
  meal_vouchers: 0,
  recreation_annual: 0,
  pension_exempt: false,
  bituach_leumi_exempt: false,
  notes: '',
};

/**
 * Extract editable rate fields from the first amuta in the distribution.
 * We keep the rest of the distribution untouched and only write back to the
 * same slot, so adding a new distribution UI later doesn't break existing data.
 */
function flattenPrimaryAmuta(emp) {
  const dist = emp?.amuta_distribution || [];
  const first = dist[0] || {};
  return {
    hourly_rate: first.hourly_rate ?? '',
    global_salary: first.global_salary ?? '',
    global_ot_rate: first.global_ot_rate ?? '',
    required_hours: first.required_hours ?? '',
  };
}

/**
 * Merge the edited primary-amuta fields back into the distribution array.
 * If there is no existing distribution we synthesize a single entry (requires
 * the caller to supply an amuta_id, otherwise it is left null and the server
 * will reject it — which is the desired behavior for now).
 */
function mergePrimaryAmuta(existing, form) {
  const dist = Array.isArray(existing?.amuta_distribution) ? [...existing.amuta_distribution] : [];
  if (dist.length === 0) {
    return dist; // can't create without amuta_id — UI will hint via notes
  }
  const first = { ...dist[0] };
  first.hourly_rate = form.hourly_rate === '' ? null : Number(form.hourly_rate);
  first.global_salary = form.global_salary === '' ? null : Number(form.global_salary);
  first.global_ot_rate = form.global_ot_rate === '' ? null : Number(form.global_ot_rate);
  first.required_hours = form.required_hours === '' ? null : Number(form.required_hours);
  dist[0] = first;
  return dist;
}

export default function EmployeeManager() {
  const { isAdmin, isManager } = useAuth();
  const { branches, selectedBranch } = useBranch();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState({ open: false, mode: 'add', data: { ...EMPTY_FORM }, original: null });
  const [confirm, setConfirm] = useState({ open: false, id: null });
  const [hoursDialog, setHoursDialog] = useState({ open: false, employee: null });

  const fetchEmployees = useCallback(() => {
    if (!selectedBranch) { setEmployees([]); setLoading(false); return; }
    setLoading(true);
    api.get('/payroll/employees', { params: { branch: selectedBranch, active: 'true' } })
      .then(res => setEmployees(res.data.employees || []))
      .catch((err) => {
        console.error(err);
        toast.error('שגיאה בטעינת עובדים');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch]);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  const openAdd = () => setDialog({
    open: true,
    mode: 'add',
    data: { ...EMPTY_FORM, branch_id: selectedBranch },
    original: null,
  });

  const openEdit = (emp) => {
    const primary = flattenPrimaryAmuta(emp);
    setDialog({
      open: true,
      mode: 'edit',
      data: {
        full_name: emp.full_name || '',
        israeli_id: emp.israeli_id || '',
        branch_id: emp.branch_id || '',
        phone: emp.phone || '',
        email: emp.email || '',
        position: emp.position || '',
        start_date: emp.start_date ? new Date(emp.start_date).toISOString().slice(0, 10) : '',
        salary_type: emp.salary_type || 'hourly',
        salary_is_net: !!emp.salary_is_net,
        travel_allowance: emp.travel_allowance || 0,
        meal_vouchers: emp.meal_vouchers || 0,
        recreation_annual: emp.recreation_annual || 0,
        pension_exempt: !!emp.pension_exempt,
        bituach_leumi_exempt: !!emp.bituach_leumi_exempt,
        notes: emp.notes || '',
        id: emp._id || emp.id,
        ...primary,
      },
      original: emp,
    });
  };

  const closeDialog = () => setDialog({ open: false, mode: 'add', data: { ...EMPTY_FORM }, original: null });

  const handleSave = async () => {
    const { mode, data, original } = dialog;
    if (!data.full_name?.trim()) return toast.error('שם מלא חובה');
    if (!data.branch_id) return toast.error('סניף חובה');

    const distribution = mergePrimaryAmuta(original, data);

    const payload = {
      full_name: data.full_name.trim(),
      israeli_id: (data.israeli_id || '').trim(),
      branch_id: data.branch_id,
      phone: data.phone || '',
      email: data.email || '',
      position: data.position || '',
      start_date: data.start_date || null,
      salary_type: data.salary_type,
      salary_is_net: data.salary_is_net,
      amuta_distribution: distribution,
      travel_allowance: Number(data.travel_allowance) || 0,
      meal_vouchers: Number(data.meal_vouchers) || 0,
      recreation_annual: Number(data.recreation_annual) || 0,
      pension_exempt: data.pension_exempt,
      bituach_leumi_exempt: data.bituach_leumi_exempt,
      notes: data.notes || '',
    };

    try {
      if (mode === 'add') {
        await api.post('/payroll/employees', payload);
        toast.success('עובד נוסף');
      } else {
        await api.put(`/payroll/employees/${data.id}`, payload);
        toast.success('עובד עודכן');
      }
      closeDialog();
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/payroll/employees/${confirm.id}`);
      toast.success('עובד הוסר');
      setConfirm({ open: false, id: null });
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const updateField = (key, value) => {
    setDialog(prev => ({ ...prev, data: { ...prev.data, [key]: value } }));
  };

  const { totalCount, missingIdCount } = useMemo(() => ({
    totalCount: employees.length,
    missingIdCount: employees.filter(e => !e.israeli_id).length,
  }), [employees]);

  return (
    <Box dir="rtl" sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול עובדים</Typography>
          <Typography variant="caption" color="text.secondary">
            {totalCount} עובדים
            {missingIdCount > 0 && ` • ${missingIdCount} בלי ת״ז`}
          </Typography>
        </Box>
        {isManager && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
            הוסף עובד
          </Button>
        )}
      </Stack>

      {missingIdCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          {missingIdCount} עובדים עדיין ללא תעודת זהות. החתמות שלהם לא יקושרו אוטומטית עד שתעדכן את ה-ת״ז.
        </Alert>
      )}

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>ת״ז</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>תפקיד</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>טלפון</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סוג שכר</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">שכר / תעריף</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">נסיעות</TableCell>
              {isManager && <TableCell align="center">פעולות</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {employees.map(emp => {
              const rate = emp._display_rate;
              const rateLabel = emp.salary_type === 'global'
                ? (rate ? `${formatCurrency(rate)}/חודש` : '—')
                : (rate ? `₪${rate}/שעה` : '—');
              return (
                <TableRow key={emp._id || emp.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{emp.full_name}</TableCell>
                  <TableCell dir="ltr" sx={{ fontFamily: 'monospace', color: emp.israeli_id ? 'text.primary' : 'warning.main' }}>
                    {emp.israeli_id || '—'}
                  </TableCell>
                  <TableCell>{emp.position || '—'}</TableCell>
                  <TableCell dir="ltr">{emp.phone || '—'}</TableCell>
                  <TableCell>
                    <Chip
                      label={emp.salary_type === 'global' ? 'גלובלי' : 'שעתי'}
                      size="small"
                      color={emp.salary_type === 'global' ? 'primary' : 'default'}
                      variant="outlined"
                    />
                    {emp.salary_is_net && <Chip label="נטו" size="small" sx={{ ml: 0.5 }} />}
                  </TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>{rateLabel}</TableCell>
                  <TableCell align="center">{emp.travel_allowance ? `₪${emp.travel_allowance}` : '—'}</TableCell>
                  {isManager && (
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.5} justifyContent="center">
                        <Tooltip title="דוח שעות">
                          <IconButton size="small" onClick={() => setHoursDialog({ open: true, employee: emp })}>
                            <ScheduleIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="ערוך">
                          <IconButton size="small" onClick={() => openEdit(emp)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="הסר">
                          <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, id: emp._id || emp.id })}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {!loading && employees.length === 0 && (
              <TableRow><TableCell colSpan={8} sx={{ textAlign: 'center', py: 4 }}>אין עובדים</TableCell></TableRow>
            )}
            {loading && (
              <TableRow><TableCell colSpan={8} sx={{ textAlign: 'center', py: 4 }}>טוען…</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Employee Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.mode === 'add' ? 'הוסף עובד' : `ערוך עובד — ${dialog.data.full_name}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>פרטים אישיים</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="שם מלא" value={dialog.data.full_name || ''} onChange={e => updateField('full_name', e.target.value)} fullWidth required />
              <TextField label="ת״ז" value={dialog.data.israeli_id || ''} onChange={e => updateField('israeli_id', e.target.value)} fullWidth
                inputProps={{ dir: 'ltr', maxLength: 9 }}
                helperText="9 ספרות; חייב להתאים ל-userId בשעון"
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="טלפון" value={dialog.data.phone || ''} onChange={e => updateField('phone', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
              <TextField label="אימייל" value={dialog.data.email || ''} onChange={e => updateField('email', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="תפקיד" select value={dialog.data.position || ''} onChange={e => updateField('position', e.target.value)} fullWidth>
                <MenuItem value="">—</MenuItem>
                {POSITIONS.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
              </TextField>
              <TextField label="תאריך התחלה" type="date" value={dialog.data.start_date || ''} onChange={e => updateField('start_date', e.target.value)} fullWidth InputLabelProps={{ shrink: true }} />
            </Stack>
            <Stack direction="row" spacing={2}>
              {isAdmin && (
                <TextField label="סניף" select value={dialog.data.branch_id || ''} onChange={e => updateField('branch_id', e.target.value)} fullWidth>
                  {branches.map(b => <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>)}
                </TextField>
              )}
            </Stack>

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>שכר</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="סוג שכר" select value={dialog.data.salary_type} onChange={e => updateField('salary_type', e.target.value)} fullWidth>
                <MenuItem value="hourly">שעתי</MenuItem>
                <MenuItem value="global">גלובלי</MenuItem>
              </TextField>
              <TextField label="נטו/ברוטו" select value={dialog.data.salary_is_net ? 'net' : 'gross'}
                onChange={e => updateField('salary_is_net', e.target.value === 'net')} fullWidth>
                <MenuItem value="gross">ברוטו</MenuItem>
                <MenuItem value="net">נטו</MenuItem>
              </TextField>
            </Stack>
            {dialog.data.salary_type === 'hourly' ? (
              <TextField label="תעריף שעתי" type="number" value={dialog.data.hourly_rate}
                onChange={e => updateField('hourly_rate', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
            ) : (
              <Stack direction="row" spacing={2}>
                <TextField label="שכר גלובלי חודשי" type="number" value={dialog.data.global_salary}
                  onChange={e => updateField('global_salary', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                />
                <TextField label="שעות נדרשות בחודש" type="number" value={dialog.data.required_hours}
                  onChange={e => updateField('required_hours', e.target.value)} fullWidth
                />
                <TextField label="תעריף שעה נוספת" type="number" value={dialog.data.global_ot_rate}
                  onChange={e => updateField('global_ot_rate', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                />
              </Stack>
            )}

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>תוספות קבועות</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="נסיעות (חודשי)" type="number" value={dialog.data.travel_allowance}
                onChange={e => updateField('travel_allowance', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
              <TextField label="סיבוס" type="number" value={dialog.data.meal_vouchers}
                onChange={e => updateField('meal_vouchers', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
              <TextField label="הבראה (שנתי)" type="number" value={dialog.data.recreation_annual}
                onChange={e => updateField('recreation_annual', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
            </Stack>

            <Divider />
            <TextField label="הערות" multiline rows={3} value={dialog.data.notes}
              onChange={e => updateField('notes', e.target.value)} fullWidth
              helperText="הלוואות, פטורים, תנאים מיוחדים — כרגע עריכה חופשית. מודלים מובנים יתווספו בהמשך."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSave}>שמור</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={confirm.open} onClose={() => setConfirm({ open: false, id: null })}
        onConfirm={handleDelete} title="הסרת עובד" message="להסיר את העובד מהמערכת? (ההחתמות ההיסטוריות נשמרות)"
      />

      <HoursReportDialog
        open={hoursDialog.open}
        employee={hoursDialog.employee}
        onClose={() => setHoursDialog({ open: false, employee: null })}
      />
    </Box>
  );
}
