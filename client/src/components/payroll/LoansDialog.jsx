import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, Table, TableHead, TableBody,
  TableRow, TableCell, IconButton,
} from '@mui/material';
import PaymentsIcon from '@mui/icons-material/Payments';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * Loans management for one employee. Lists every loan with progress
 * (paid / total installments), and lets the manager:
 *   - add a new loan
 *   - delete an inactive loan
 *   - update `installments_paid` (manual progress, e.g. after running
 *     the payslip for this month)
 *
 * Persisted via PUT /payroll/employees/:id with the full loans[] array.
 */
export default function LoansDialog({ open, row, onClose, onSaved }) {
  const confirm = useConfirm();
  const [loans, setLoans] = useState([]);
  const [draft, setDraft] = useState({ total_amount: '', installment_amount: '', installments_total: '', notes: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !row) return;
    setLoans(row.loans_info?.loans || []);
    setDraft({ total_amount: '', installment_amount: '', installments_total: '', notes: '' });
  }, [open, row]);

  if (!row) return null;

  const persist = (next) => {
    setSaving(true);
    api.put(`/payroll/employees/${row.employee_id}`, { loans: next })
      .then(() => { toast.success('הלוואות עודכנו'); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const addLoan = () => {
    const total = Number(draft.total_amount);
    const inst = Number(draft.installment_amount);
    const cnt = Number(draft.installments_total);
    if (!total || !inst || !cnt) {
      toast.error('חובה למלא: סכום כולל, גובה תשלום, מספר תשלומים');
      return;
    }
    const next = [...loans, {
      total_amount: total,
      installment_amount: inst,
      installments_total: cnt,
      installments_paid: 0,
      started_at: new Date(),
      notes: draft.notes || '',
    }];
    setLoans(next);
    persist(next);
  };

  const removeLoan = async (idx) => {
    if (!(await confirm({ title: 'מחיקת הלוואה', message: 'למחוק הלוואה זו?', danger: true, remember_key: 'delete-loan' }))) return;
    const next = loans.filter((_, i) => i !== idx);
    setLoans(next);
    persist(next);
  };

  const updatePaid = (idx, value) => {
    const v = Math.max(0, Math.round(Number(value) || 0));
    const next = loans.map((l, i) => i === idx ? { ...l, installments_paid: v } : l);
    setLoans(next);
  };

  const saveAll = () => {
    persist(loans);
  };

  const activeLoans = loans.filter(l => (Number(l.installments_paid) || 0) < (Number(l.installments_total) || 0));
  const monthDeduction = activeLoans.reduce((s, l) => s + (Number(l.installment_amount) || 0), 0);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <PaymentsIcon color="error" />
        הלוואות — {row.full_name}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'error.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">הלוואות פעילות</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{activeLoans.length}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ניכוי החודש</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{Math.round(monthDeduction)} ₪</Typography>
            </Box>
          </Stack>

          {loans.length === 0 ? (
            <Alert severity="info">אין הלוואות פעילות לעובד זה.</Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>סכום כולל</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>תשלום חודשי</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>מס׳ תשלומים</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>שולם עד כה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הערות</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {loans.map((l, idx) => {
                  const paid = Number(l.installments_paid) || 0;
                  const total = Number(l.installments_total) || 0;
                  const isActive = paid < total;
                  return (
                    <TableRow key={idx} hover>
                      <TableCell>{Number(l.total_amount).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{Number(l.installment_amount).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{total}</TableCell>
                      <TableCell>
                        <TextField
                          size="small" type="number" value={paid}
                          onChange={e => updatePaid(idx, e.target.value)}
                          onBlur={saveAll}
                          inputProps={{ min: 0, max: total, style: { width: 60, textAlign: 'center' } }}
                        />
                        <Typography component="span" variant="caption" sx={{ ml: 0.5 }}>/{total}</Typography>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.notes || '—'}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={isActive ? 'פעילה' : 'שולם'}
                          color={isActive ? 'warning' : 'success'}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell>
                        <IconButton size="small" onClick={() => removeLoan(idx)} color="error">
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוסף הלוואה חדשה</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField size="small" type="number" label="סכום כולל"
              value={draft.total_amount} onChange={e => setDraft({ ...draft, total_amount: e.target.value })}
              sx={{ width: 140 }}
            />
            <TextField size="small" type="number" label="תשלום חודשי"
              value={draft.installment_amount} onChange={e => setDraft({ ...draft, installment_amount: e.target.value })}
              sx={{ width: 140 }}
            />
            <TextField size="small" type="number" label="מספר תשלומים"
              value={draft.installments_total} onChange={e => setDraft({ ...draft, installments_total: e.target.value })}
              sx={{ width: 140 }}
            />
            <TextField size="small" label="הערות (אופציונלי)"
              value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })}
              sx={{ flex: 1, minWidth: 180 }}
            />
            <Button variant="contained" startIcon={<AddCircleOutlineIcon />} onClick={addLoan} disabled={saving}>
              הוסף
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" onClick={saveAll} disabled={saving}>שמור שינויים</Button>
      </DialogActions>
    </Dialog>
  );
}
