import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Select, MenuItem, FormControl, InputLabel, Typography, IconButton, Chip,
  List, ListItem, ListItemText, ListItemSecondaryAction, Divider, Box, InputAdornment, Alert,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import {
  ADJUSTMENT_TYPES as TYPES, TYPE_LABEL, typeColor, STATUS_META, canDecidePayroll,
} from './adjustmentTypes';

/**
 * Per-employee per-month salary-adjustment editor. Lists existing
 * adjustments for the row and lets the manager add new ones. Each
 * adjustment is one of a fixed set of types — money credits, money
 * deductions, hour corrections, etc. — each rendering a slightly
 * different form.
 */
export default function SalaryAdjustmentDialog({ open, onClose, row, month, onChanged }) {
  const confirm = useConfirm();
  const { user } = useAuth();
  const canDecide = canDecidePayroll(user);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ type: 'money_add', amount: '', hours: '', reason: '' });

  const employeeId = row?.employee_id;

  const load = () => {
    if (!employeeId) return;
    setLoading(true);
    api.get('/payroll-month/adjustments', { params: { employee_id: employeeId, month } })
      .then(res => setList(res.data.adjustments || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open && employeeId) {
      load();
      setDraft({ type: 'money_add', amount: '', hours: '', reason: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, month]);

  const currentType = TYPES.find(t => t.value === draft.type);
  const usesAmount = currentType?.field === 'amount';

  const save = () => {
    const value = usesAmount ? Number(draft.amount) : Number(draft.hours);
    if (!value || Number.isNaN(value)) return toast.error('יש להזין ערך מספרי');
    const payload = {
      employee_id: employeeId,
      month,
      type: draft.type,
      amount: usesAmount ? Math.abs(value) * (currentType.positive === false ? -1 : 1) : 0,
      hours:  !usesAmount ? Math.abs(value) * (currentType.positive === false ? -1 : 1) : 0,
      reason: draft.reason,
    };
    api.post('/payroll-month/adjustments', payload)
      .then((res) => {
        toast.success(res.data?.pending ? 'העדכון נשלח לאישור הנהלת החשבונות' : 'עדכון נוסף');
        setDraft({ type: 'money_add', amount: '', hours: '', reason: '' });
        load();
        onChanged && onChanged();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const remove = async (id) => {
    if (!(await confirm({ title: 'הסרת עדכון שכר', message: 'להסיר עדכון זה?', danger: true, remember_key: 'remove-salary-adj' }))) return;
    api.delete(`/payroll-month/adjustments/${id}`)
      .then(() => { load(); onChanged && onChanged(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>
        עדכוני שכר — {row.full_name}
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
          {row.branch_name} • חודש {month}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity={canDecide ? 'info' : 'warning'} sx={{ mb: 2 }} icon={false}>
          {canDecide
            ? 'תוספות והורדות חודשיות. ייכנסו לחישוב התלוש מיידית.'
            : 'ניתן להוסיף כל עדכון. העדכון יירשם כ״ממתין לאישור״ ולא ייכנס לחישוב השכר עד שהנהלת החשבונות תאשר אותו.'}
        </Alert>

        {/* List of existing */}
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>עדכונים קיימים</Typography>
        {loading ? <Typography variant="caption" color="text.secondary">טוען…</Typography> : list.length === 0 ? (
          <Typography variant="caption" color="text.disabled">אין עדכוני שכר לחודש זה.</Typography>
        ) : (
          <List dense sx={{ bgcolor: 'grey.50', borderRadius: 2, mb: 2 }}>
            {list.map(adj => (
              <ListItem key={adj.id} sx={{ pr: 1 }}>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Chip size="small" color={typeColor(adj.type)} label={TYPE_LABEL[adj.type] || adj.type} />
                      {adj.status !== 'approved' && (
                        <Chip size="small" variant="outlined"
                          color={(STATUS_META[adj.status] || {}).color || 'default'}
                          label={(STATUS_META[adj.status] || {}).label || adj.status} />
                      )}
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {adj.amount !== 0 ? `${adj.amount > 0 ? '+' : ''}${adj.amount} ₪` : ''}
                        {adj.hours !== 0  ? `${adj.hours > 0 ? '+' : ''}${adj.hours}h`   : ''}
                      </Typography>
                    </Stack>
                  }
                  secondary={
                    <Box>
                      {adj.reason && <Typography variant="caption">{adj.reason}</Typography>}
                      <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                        {adj.created_by_name} • {new Date(adj.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
                      </Typography>
                    </Box>
                  }
                />
                {canDecide && (
                  <ListItemSecondaryAction>
                    <IconButton size="small" color="error" onClick={() => remove(adj.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </ListItemSecondaryAction>
                )}
              </ListItem>
            ))}
          </List>
        )}

        <Divider sx={{ my: 2 }} />

        {/* Add new */}
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הוספת עדכון חדש</Typography>
        <Stack spacing={2}>
          <FormControl size="small" fullWidth>
            <InputLabel>סוג עדכון</InputLabel>
            <Select label="סוג עדכון" value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}>
              {TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
            </Select>
          </FormControl>
          {usesAmount ? (
            <TextField
              type="number" label="סכום" value={draft.amount}
              onChange={e => setDraft({ ...draft, amount: e.target.value })}
              InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              helperText={currentType.positive === false ? 'הסכום ינוכה מהשכר' : currentType.positive === true ? 'הסכום יתווסף לשכר' : 'חיובי = תוספת, שלילי = ניכוי'}
            />
          ) : (
            <TextField
              type="number" label="שעות" value={draft.hours}
              onChange={e => setDraft({ ...draft, hours: e.target.value })}
              InputProps={{ endAdornment: <InputAdornment position="end">שעות</InputAdornment> }}
              helperText={currentType.positive === false ? 'השעות יוורדו' : currentType.positive === true ? 'השעות יתווספו' : 'חיובי = תוספת, שלילי = הורדה'}
            />
          )}
          <TextField
            label="סיבה / הערה" value={draft.reason}
            onChange={e => setDraft({ ...draft, reason: e.target.value })}
            multiline minRows={2}
            placeholder='למשל: בונוס הובלת קבוצה / קניות חומרי יצירה ב-200 ש"ח / שעות שלא נחתמו'
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" startIcon={<AddIcon />} onClick={save}>הוסף עדכון</Button>
      </DialogActions>
    </Dialog>
  );
}
