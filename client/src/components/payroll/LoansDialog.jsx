import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, Table, TableHead, TableBody,
  TableRow, TableCell, IconButton,
} from '@mui/material';
import PaymentsIcon from '@mui/icons-material/Payments';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * Loans management for one employee. A loan carries a per-month schedule
 * (payments[]) built from a start month + monthly amount × count. Each month
 * the manager can edit that month's deduction, which changes the remaining
 * balance (total − sum of payments deducted so far).
 *
 * Legacy loans (no payments[]) keep the old installments_paid/total display.
 *
 * Persisted via PUT /payroll/employees/:id with the full loans[] array.
 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function buildSchedule(startMonth, count, amount) {
  const out = [];
  let ym = startMonth;
  for (let i = 0; i < count; i++) { out.push({ month: ym, amount }); ym = nextMonth(ym); }
  return out;
}
const isNew = (l) => Array.isArray(l.payments) && l.payments.length > 0;
function deductedThrough(l, ym) {
  if (!isNew(l)) return (Number(l.installments_paid) || 0) * (Number(l.installment_amount) || 0);
  return l.payments.filter(p => p.month <= ym).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}
function monthAmount(l, ym) {
  if (!isNew(l)) {
    const active = (Number(l.installments_paid) || 0) < (Number(l.installments_total) || 0);
    return active ? (Number(l.installment_amount) || 0) : 0;
  }
  const p = l.payments.find(x => x.month === ym);
  return p ? (Number(p.amount) || 0) : 0;
}

export default function LoansDialog({ open, row, month, onClose, onSaved }) {
  const confirm = useConfirm();
  const ym = month || currentYearMonth();
  const [loans, setLoans] = useState([]);
  const [draft, setDraft] = useState({ total_amount: '', installment_amount: '', installments_total: '', start_month: ym, notes: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !row) return;
    setLoans(row.loans_info?.loans || []);
    setDraft({ total_amount: '', installment_amount: '', installments_total: '', start_month: ym, notes: '' });
  }, [open, row, ym]);

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
    const start = draft.start_month || ym;
    if (!total || !inst || !cnt) {
      toast.error('חובה למלא: סכום כולל, תשלום חודשי, מספר תשלומים');
      return;
    }
    const next = [...loans, {
      total_amount: total,
      installment_amount: inst,
      installments_total: cnt,
      installments_paid: 0,
      start_month: start,
      payments: buildSchedule(start, cnt, inst),
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

  // Edit THIS month's deduction for a (new-model) loan; reduces the balance.
  const setMonthPayment = (idx, value) => {
    const v = Math.max(0, Math.round(Number(value) || 0));
    const next = loans.map((l, i) => {
      if (i !== idx) return l;
      const payments = Array.isArray(l.payments) ? [...l.payments] : [];
      const pi = payments.findIndex(p => p.month === ym);
      if (pi >= 0) payments[pi] = { ...payments[pi], amount: v };
      else payments.push({ month: ym, amount: v });
      return { ...l, payments };
    });
    setLoans(next);
  };

  // Pause THIS month's deduction: zero it out and extend the loan by one month
  // at the end, so the total is still fully repaid — just one month later.
  const pauseMonth = (idx) => {
    const next = loans.map((l, i) => {
      if (i !== idx) return l;
      const inst = Number(l.installment_amount) || 0;
      let payments = Array.isArray(l.payments) && l.payments.length
        ? [...l.payments]
        : buildSchedule(l.start_month || ym, Number(l.installments_total) || 0, inst);
      const pi = payments.findIndex(p => p.month === ym);
      if (pi >= 0) payments[pi] = { ...payments[pi], amount: 0, paused: true };
      else payments.push({ month: ym, amount: 0, paused: true });
      const maxMonth = payments.reduce((mx, p) => (p.month > mx ? p.month : mx), ym);
      payments.push({ month: nextMonth(maxMonth), amount: inst, paused: false }); // extension month
      return { ...l, payments };
    });
    setLoans(next);
    persist(next);
  };

  // Resume: restore this month's installment and drop one extension month.
  const resumeMonth = (idx) => {
    const next = loans.map((l, i) => {
      if (i !== idx) return l;
      const inst = Number(l.installment_amount) || 0;
      const payments = Array.isArray(l.payments) ? [...l.payments] : [];
      const pi = payments.findIndex(p => p.month === ym);
      if (pi >= 0) payments[pi] = { ...payments[pi], amount: inst, paused: false };
      if (payments.length) {
        let lastIdx = 0;
        payments.forEach((p, i2) => { if (p.month > payments[lastIdx].month) lastIdx = i2; });
        payments.splice(lastIdx, 1);
      }
      return { ...l, payments };
    });
    setLoans(next);
    persist(next);
  };
  const isPaused = (l) => { const p = (Array.isArray(l.payments) ? l.payments : []).find(x => x.month === ym); return !!(p && p.paused); };

  // Legacy loans: advance the paid-installments counter.
  const updatePaid = (idx, value) => {
    const v = Math.max(0, Math.round(Number(value) || 0));
    const next = loans.map((l, i) => i === idx ? { ...l, installments_paid: v } : l);
    setLoans(next);
  };

  const saveAll = () => persist(loans);

  const monthDeduction = loans.reduce((s, l) => s + monthAmount(l, ym), 0);
  const activeCount = loans.filter(l => (Number(l.total_amount) || 0) - deductedThrough(l, ym) > 0).length;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <PaymentsIcon color="error" />
        הלוואות — {row.full_name}
        <Chip size="small" label={`חודש ${ym}`} sx={{ ml: 'auto' }} />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'error.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">הלוואות פעילות</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{activeCount}</Typography>
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
                  <TableCell sx={{ fontWeight: 700 }}>חודש התחלה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>נוכה עד כה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>יתרה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>ניכוי {ym}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הערות</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {loans.map((l, idx) => {
                  const total = Number(l.total_amount) || 0;
                  const deducted = deductedThrough(l, ym);
                  const remaining = Math.max(0, total - deducted);
                  const active = remaining > 0;
                  const newModel = isNew(l);
                  return (
                    <TableRow key={l._id || idx} hover>
                      <TableCell>{total.toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{Number(l.installment_amount).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{l.start_month || '—'}</TableCell>
                      <TableCell>{Math.round(deducted).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>{Math.round(remaining).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>
                        {newModel ? (
                          <Stack spacing={0.4} alignItems="center">
                            <TextField
                              size="small" type="number" value={monthAmount(l, ym)}
                              onChange={e => setMonthPayment(idx, e.target.value)}
                              onBlur={saveAll} disabled={isPaused(l)}
                              inputProps={{ min: 0, style: { width: 70, textAlign: 'center' } }}
                            />
                            {active && (isPaused(l)
                              ? <Button size="small" color="success" startIcon={<PlayArrowIcon sx={{ fontSize: 14 }} />} onClick={() => resumeMonth(idx)} sx={{ fontSize: '0.65rem', py: 0 }}>חדש תשלום</Button>
                              : <Button size="small" color="warning" startIcon={<PauseCircleOutlineIcon sx={{ fontSize: 14 }} />} onClick={() => pauseMonth(idx)} sx={{ fontSize: '0.65rem', py: 0 }}>עצור החודש</Button>
                            )}
                            {isPaused(l) && <Chip size="small" color="warning" label="מושהה — הוארך בחודש" sx={{ height: 15, fontSize: '0.52rem' }} />}
                          </Stack>
                        ) : (
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <TextField
                              size="small" type="number" value={Number(l.installments_paid) || 0}
                              onChange={e => updatePaid(idx, e.target.value)}
                              onBlur={saveAll}
                              inputProps={{ min: 0, max: Number(l.installments_total) || 0, style: { width: 50, textAlign: 'center' } }}
                            />
                            <Typography component="span" variant="caption">/{Number(l.installments_total) || 0}</Typography>
                          </Stack>
                        )}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.notes || '—'}</TableCell>
                      <TableCell>
                        <Chip size="small" label={active ? 'פעילה' : 'שולם'} color={active ? 'warning' : 'success'} variant="outlined" />
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
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוסף הלוואה / מפרעה חדשה</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField size="small" type="number" label="סכום כולל"
              value={draft.total_amount} onChange={e => setDraft({ ...draft, total_amount: e.target.value })}
              sx={{ width: 130 }}
            />
            <TextField size="small" type="number" label="תשלום חודשי"
              value={draft.installment_amount} onChange={e => setDraft({ ...draft, installment_amount: e.target.value })}
              sx={{ width: 130 }}
            />
            <TextField size="small" type="number" label="מספר תשלומים"
              value={draft.installments_total} onChange={e => setDraft({ ...draft, installments_total: e.target.value })}
              sx={{ width: 130 }}
            />
            <TextField size="small" type="month" label="חודש התחלה" InputLabelProps={{ shrink: true }}
              value={draft.start_month} onChange={e => setDraft({ ...draft, start_month: e.target.value })}
              sx={{ width: 150 }}
            />
            <TextField size="small" label="הערות (אופציונלי)"
              value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })}
              sx={{ flex: 1, minWidth: 160 }}
            />
            <Button variant="contained" startIcon={<AddCircleOutlineIcon />} onClick={addLoan} disabled={saving}>
              הוסף
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            מפרעה = סכום כולל + תשלום חודשי זהים + מספר תשלומים 1. תרד מהשכר בחודש ההתחלה.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" onClick={saveAll} disabled={saving}>שמור שינויים</Button>
      </DialogActions>
    </Dialog>
  );
}
