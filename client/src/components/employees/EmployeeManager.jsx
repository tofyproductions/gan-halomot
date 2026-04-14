import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  MenuItem, Dialog, DialogTitle, DialogContent, DialogActions,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, Chip, IconButton, Tooltip, Divider, InputAdornment,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import MoneyIcon from '@mui/icons-material/AttachMoney';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatCurrency } from '../../utils/hebrewYear';

const ROLES = [
  { value: 'system_admin', label: 'מנהל מערכת' },
  { value: 'branch_manager', label: 'מנהל גן' },
  { value: 'employee', label: 'עובד' },
];

const POSITIONS = ['מובילת כיתה', 'מטפלת', 'מבשלת', 'סייעת', 'מנהלת', 'אחר'];

const EMPTY_FORM = {
  email: '', password: '', full_name: '', role: 'employee',
  branch_id: '', phone: '', id_number: '', address: '',
  position: '', salary: '', bank_account: '', bank_branch: '',
  bank_number: '', start_date: '',
};

export default function EmployeeManager() {
  const { isAdmin, isManager } = useAuth();
  const { branches, selectedBranch } = useBranch();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState({ open: false, mode: 'add', data: { ...EMPTY_FORM } });
  const [salaryDialog, setSalaryDialog] = useState({ open: false, employee: null, newSalary: '', reason: '' });
  const [confirm, setConfirm] = useState({ open: false, id: null });

  const fetchEmployees = useCallback(() => {
    setLoading(true);
    api.get('/employees')
      .then(res => setEmployees(res.data.employees || []))
      .catch(() => toast.error('שגיאה בטעינת עובדים'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  const openAdd = () => setDialog({
    open: true, mode: 'add',
    data: { ...EMPTY_FORM, branch_id: selectedBranch },
  });

  const openEdit = (emp) => setDialog({
    open: true, mode: 'edit',
    data: {
      ...emp,
      id: emp._id || emp.id,
      password: '',
      start_date: emp.start_date ? new Date(emp.start_date).toISOString().slice(0, 10) : '',
    },
  });

  const closeDialog = () => setDialog({ open: false, mode: 'add', data: { ...EMPTY_FORM } });

  const handleSave = async () => {
    const { mode, data } = dialog;
    if (!data.full_name?.trim() || !data.email?.trim()) {
      return toast.error('שם מלא ואימייל חובה');
    }
    if (mode === 'add' && !data.password) {
      return toast.error('סיסמה חובה ליצירת עובד');
    }

    try {
      const payload = { ...data };
      if (mode === 'edit') delete payload.password_hash;
      if (!payload.password) delete payload.password;

      if (mode === 'add') {
        await api.post('/employees', payload);
        toast.success('עובד נוסף');
      } else {
        await api.put(`/employees/${data.id}`, payload);
        toast.success('עובד עודכן');
      }
      closeDialog();
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/employees/${confirm.id}`);
      toast.success('עובד הוסר');
      setConfirm({ open: false, id: null });
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleSalaryRequest = async () => {
    const { employee, newSalary, reason } = salaryDialog;
    if (!newSalary) return toast.error('הזן שכר חדש');

    try {
      if (isAdmin) {
        // Admin can change directly
        await api.put(`/employees/${employee._id || employee.id}`, { salary: parseFloat(newSalary) });
        toast.success('שכר עודכן');
      } else {
        // Manager sends request
        await api.post('/salary-requests', {
          user_id: employee._id || employee.id,
          new_salary: parseFloat(newSalary),
          reason,
        });
        toast.success('בקשת שינוי שכר נשלחה לאישור');
      }
      setSalaryDialog({ open: false, employee: null, newSalary: '', reason: '' });
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const updateField = (key, value) => {
    setDialog(prev => ({ ...prev, data: { ...prev.data, [key]: value } }));
  };

  const roleLabel = (r) => ROLES.find(x => x.value === r)?.label || r;

  return (
    <Box dir="rtl" sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול עובדים</Typography>
        {isManager && (
          <Stack direction="row" spacing={1}>
            {isAdmin && (
              <Button variant="outlined" onClick={() => window.location.href = '/salary-requests'}>
                בקשות שכר
              </Button>
            )}
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
              הוסף עובד
            </Button>
          </Stack>
        )}
      </Stack>

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>תפקיד</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>טלפון</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>הרשאה</TableCell>
              {isManager && <TableCell sx={{ fontWeight: 700 }} align="center">שכר</TableCell>}
              {isManager && <TableCell align="center">פעולות</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {employees.map(emp => (
              <TableRow key={emp._id || emp.id} hover>
                <TableCell sx={{ fontWeight: 600 }}>{emp.full_name}</TableCell>
                <TableCell>{emp.position || '—'}</TableCell>
                <TableCell dir="ltr">{emp.phone || '—'}</TableCell>
                <TableCell>{emp.branch_name || '—'}</TableCell>
                <TableCell>
                  <Chip label={roleLabel(emp.role)} size="small" variant="outlined"
                    color={emp.role === 'system_admin' ? 'error' : emp.role === 'branch_manager' ? 'primary' : 'default'}
                  />
                </TableCell>
                {isManager && (
                  <TableCell align="center" sx={{ fontWeight: 700 }}>
                    {formatCurrency(emp.salary || 0)}
                  </TableCell>
                )}
                {isManager && (
                  <TableCell align="center">
                    <Stack direction="row" spacing={0.5} justifyContent="center">
                      <Tooltip title="ערוך">
                        <IconButton size="small" onClick={() => openEdit(emp)}><EditIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      <Tooltip title="שנה שכר">
                        <IconButton size="small" color="primary" onClick={() =>
                          setSalaryDialog({ open: true, employee: emp, newSalary: String(emp.salary || 0), reason: '' })
                        }><MoneyIcon fontSize="small" /></IconButton>
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
            ))}
            {employees.length === 0 && (
              <TableRow><TableCell colSpan={7} sx={{ textAlign: 'center', py: 4 }}>אין עובדים</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Employee Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.mode === 'add' ? 'הוסף עובד חדש' : 'ערוך עובד'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>פרטים אישיים</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="שם מלא" value={dialog.data.full_name || ''} onChange={e => updateField('full_name', e.target.value)} fullWidth required />
              <TextField label="ת.ז" value={dialog.data.id_number || ''} onChange={e => updateField('id_number', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="טלפון" value={dialog.data.phone || ''} onChange={e => updateField('phone', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
              <TextField label="כתובת" value={dialog.data.address || ''} onChange={e => updateField('address', e.target.value)} fullWidth />
            </Stack>

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>פרטי עבודה</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="תפקיד" select value={dialog.data.position || ''} onChange={e => updateField('position', e.target.value)} fullWidth>
                {POSITIONS.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
              </TextField>
              {isAdmin && (
                <TextField label="הרשאה" select value={dialog.data.role || 'employee'} onChange={e => updateField('role', e.target.value)} fullWidth>
                  {ROLES.map(r => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
                </TextField>
              )}
            </Stack>
            <Stack direction="row" spacing={2}>
              {isAdmin && (
                <TextField label="סניף" select value={dialog.data.branch_id || ''} onChange={e => updateField('branch_id', e.target.value)} fullWidth>
                  {branches.map(b => <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>)}
                </TextField>
              )}
              <TextField label="תאריך התחלה" type="date" value={dialog.data.start_date || ''} onChange={e => updateField('start_date', e.target.value)} fullWidth InputLabelProps={{ shrink: true }} />
            </Stack>

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>התחברות</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="אימייל" value={dialog.data.email || ''} onChange={e => updateField('email', e.target.value)} fullWidth required inputProps={{ dir: 'ltr' }} />
              <TextField label={dialog.mode === 'add' ? 'סיסמה' : 'סיסמה חדשה (ריק = ללא שינוי)'} type="password"
                value={dialog.data.password || ''} onChange={e => updateField('password', e.target.value)} fullWidth
                required={dialog.mode === 'add'}
              />
            </Stack>

            {isAdmin && (
              <>
                <Divider />
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>פרטי בנק ושכר</Typography>
                <Stack direction="row" spacing={2}>
                  <TextField label="שכר חודשי" type="number" value={dialog.data.salary || ''} onChange={e => updateField('salary', e.target.value)} fullWidth
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                  <TextField label="מספר חשבון" value={dialog.data.bank_account || ''} onChange={e => updateField('bank_account', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
                </Stack>
                <Stack direction="row" spacing={2}>
                  <TextField label="מספר סניף בנק" value={dialog.data.bank_branch || ''} onChange={e => updateField('bank_branch', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
                  <TextField label="מספר בנק" value={dialog.data.bank_number || ''} onChange={e => updateField('bank_number', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
                </Stack>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSave}>שמור</Button>
        </DialogActions>
      </Dialog>

      {/* Salary Change Dialog */}
      <Dialog open={salaryDialog.open} onClose={() => setSalaryDialog({ open: false, employee: null, newSalary: '', reason: '' })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          שינוי שכר - {salaryDialog.employee?.full_name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              שכר נוכחי: {formatCurrency(salaryDialog.employee?.salary || 0)}
            </Typography>
            <TextField label="שכר חדש" type="number" value={salaryDialog.newSalary}
              onChange={e => setSalaryDialog(prev => ({ ...prev, newSalary: e.target.value }))} fullWidth
              InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
            />
            {!isAdmin && (
              <TextField label="סיבה לשינוי" multiline rows={2} value={salaryDialog.reason}
                onChange={e => setSalaryDialog(prev => ({ ...prev, reason: e.target.value }))} fullWidth
              />
            )}
            {!isAdmin && (
              <Typography variant="caption" color="text.secondary">
                * השינוי ישלח לאישור מנהל המערכת
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSalaryDialog({ open: false, employee: null, newSalary: '', reason: '' })}>ביטול</Button>
          <Button variant="contained" onClick={handleSalaryRequest}>
            {isAdmin ? 'עדכן שכר' : 'שלח לאישור'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={confirm.open} onClose={() => setConfirm({ open: false, id: null })}
        onConfirm={handleDelete} title="הסרת עובד" message="להסיר את העובד מהמערכת?"
      />
    </Box>
  );
}
