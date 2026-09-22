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
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MergeTypeIcon from '@mui/icons-material/MergeType';
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
/** Consolidated into a newer loan as of `ym` — owes nothing here any more. */
const isMerged = (l, ym) => !!(l.merged_at_month && ym >= l.merged_at_month);
/** What a loan still owed BEFORE `ym` — the figure that moves on a merge. */
function balanceBefore(l, ym) {
  const total = Number(l.total_amount) || 0;
  const ded = isNew(l)
    ? l.payments.filter(p => p.month < ym).reduce((s, p) => s + (Number(p.amount) || 0), 0)
    : (Number(l.installments_paid) || 0) * (Number(l.installment_amount) || 0);
  return Math.max(0, total - ded);
}
function deductedThrough(l, ym) {
  if (!isNew(l)) return (Number(l.installments_paid) || 0) * (Number(l.installment_amount) || 0);
  return l.payments.filter(p => p.month <= ym).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}
function monthAmount(l, ym) {
  if (isMerged(l, ym)) return 0;
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
  const [editIdx, setEditIdx] = useState(-1);
  const [editDraft, setEditDraft] = useState(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [merge, setMerge] = useState({ new_amount: '', installment_amount: '', start_month: ym, notes: '' });

  useEffect(() => {
    if (!open || !row) return;
    setLoans(row.loans_info?.loans || []);
    setDraft({ total_amount: '', installment_amount: '', installments_total: '', start_month: ym, notes: '' });
    setEditIdx(-1);
    setEditDraft(null);
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
    if (!(await confirm({ title: 'מחיקת הלוואה', message: 'למחוק הלוואה זו?', danger: true }))) return;
    const next = loans.filter((_, i) => i !== idx);
    setLoans(next);
    persist(next);
  };

  // Full edit of a loan's parameters (start month, monthly amount, count, total,
  // notes). Rebuilds the payment schedule from scratch — the month-aware
  // deducted/remaining figures recompute from the new schedule.
  const startEdit = (idx, l) => {
    const count = isNew(l)
      ? l.payments.filter(p => (Number(p.amount) || 0) > 0).length
      : (Number(l.installments_total) || 0);
    const start = l.start_month || (isNew(l) && l.payments[0] ? l.payments[0].month : ym);
    setEditIdx(idx);
    setEditDraft({
      total_amount: l.total_amount ?? '',
      installment_amount: l.installment_amount ?? '',
      installments_total: count || '',
      start_month: start,
      notes: l.notes || '',
    });
  };
  const cancelEdit = () => { setEditIdx(-1); setEditDraft(null); };
  const saveEdit = () => {
    const total = Number(editDraft.total_amount);
    const inst = Number(editDraft.installment_amount);
    const cnt = Number(editDraft.installments_total);
    const start = editDraft.start_month || ym;
    if (!total || !inst || !cnt) {
      toast.error('חובה למלא: סכום כולל, תשלום חודשי, מספר תשלומים');
      return;
    }
    const next = loans.map((l, i) => i === editIdx ? {
      ...l,
      total_amount: total,
      installment_amount: inst,
      installments_total: cnt,
      start_month: start,
      notes: editDraft.notes || '',
      payments: buildSchedule(start, cnt, inst),
    } : l);
    setLoans(next);
    persist(next);
    cancelEdit();
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

  /**
   * איחוד הלוואות — one new loan carrying the old balances plus fresh money.
   *
   * The old loans are NOT deleted. Every shekel they deducted is on a payslip
   * already, and a deleted loan takes that history off this screen. They stay,
   * closed as "אוחדה" from the start month, with the balance that moved
   * recorded on them. Their schedule is cut at that month so nothing deducts
   * twice; the new loan deducts from that same month.
   *
   * Count is derived, not typed: balance ÷ monthly, rounded up, and the last
   * instalment takes the remainder — so ₪10,000 at ₪2,000 is five equal ones,
   * and ₪10,000 at ₪3,000 is 3,000 × 3 + 1,000.
   */
  const mergeCandidates = loans.filter(l => !isMerged(l, ym) && balanceBefore(l, merge.start_month || ym) > 0);
  const mergeCarried = mergeCandidates.reduce((s, l) => s + balanceBefore(l, merge.start_month || ym), 0);
  const mergeTotal = mergeCarried + (Number(merge.new_amount) || 0);
  const mergeInst = Number(merge.installment_amount) || 0;
  const mergeCount = mergeInst > 0 ? Math.ceil(mergeTotal / mergeInst) : 0;
  const mergeLast = mergeInst > 0 ? mergeTotal - mergeInst * (mergeCount - 1) : 0;

  const doMerge = async () => {
    const start = merge.start_month || ym;
    if (!mergeCandidates.length) { toast.error('אין הלוואה פעילה לאחד'); return; }
    if (!mergeInst || mergeTotal <= 0) { toast.error('חובה למלא תשלום חודשי'); return; }
    const lines = mergeCandidates.map(l => `${l.start_month || '—'}: יתרה ${Math.round(balanceBefore(l, start)).toLocaleString('he-IL')} ₪`);
    const okGo = await confirm({
      title: 'איחוד הלוואות',
      message: `${lines.join(' · ')}${Number(merge.new_amount) ? ` + חדש ${Number(merge.new_amount).toLocaleString('he-IL')} ₪` : ''}\n\n`
        + `הלוואה אחת של ${Math.round(mergeTotal).toLocaleString('he-IL')} ₪ — ${mergeCount} תשלומים של ${mergeInst.toLocaleString('he-IL')} ₪`
        + (mergeLast !== mergeInst ? ` (האחרון ${Math.round(mergeLast).toLocaleString('he-IL')} ₪)` : '')
        + ` החל מ-${start}.\n\nההלוואות הישנות ייסגרו ולא ינוכו יותר. ההיסטוריה שלהן נשארת.`,
      confirm_label: 'אחד',
    });
    if (!okGo) return;

    const schedule = buildSchedule(start, mergeCount, mergeInst);
    if (schedule.length) schedule[schedule.length - 1] = { ...schedule[schedule.length - 1], amount: Math.round(mergeLast * 100) / 100 };
    const carriedNote = mergeCandidates
      .map(l => `${Math.round(balanceBefore(l, start)).toLocaleString('he-IL')} ₪ מהלוואה מ-${l.start_month || '—'}`)
      .join(', ');
    const newLoan = {
      total_amount: Math.round(mergeTotal * 100) / 100,
      installment_amount: mergeInst,
      installments_total: mergeCount,
      installments_paid: 0,
      start_month: start,
      payments: schedule,
      started_at: new Date(),
      notes: [`איחוד: ${carriedNote}`, Number(merge.new_amount) ? `+ ${Number(merge.new_amount).toLocaleString('he-IL')} ₪ חדש` : '', merge.notes || '']
        .filter(Boolean).join(' '),
    };
    const next = loans.map(l => {
      if (!mergeCandidates.includes(l)) return l;
      const balance = Math.round(balanceBefore(l, start) * 100) / 100;
      return {
        ...l,
        payments: isNew(l) ? l.payments.filter(p => p.month < start) : l.payments,
        merged_at_month: start,
        merged_balance: balance,
        merged_note: `אוחדה ב-${start} להלוואה של ${Math.round(mergeTotal).toLocaleString('he-IL')} ₪`,
      };
    });
    next.push(newLoan);
    setLoans(next);
    persist(next);
    setMergeOpen(false);
    setMerge({ new_amount: '', installment_amount: '', start_month: ym, notes: '' });
  };

  const monthDeduction = loans.reduce((s, l) => s + monthAmount(l, ym), 0);
  const activeCount = loans.filter(l => !isMerged(l, ym) && (Number(l.total_amount) || 0) - deductedThrough(l, ym) > 0).length;

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
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'error.soft', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">הלוואות פעילות</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{activeCount}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.soft', borderRadius: 2, textAlign: 'center' }}>
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
                  const merged = isMerged(l, ym);
                  const remaining = merged ? 0 : Math.max(0, total - deducted);
                  const active = remaining > 0;
                  const newModel = isNew(l);
                  const mainRow = (
                    <TableRow key={l._id || idx} hover>
                      <TableCell>{total.toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{Number(l.installment_amount).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell>{l.start_month || '—'}</TableCell>
                      <TableCell>{Math.round(deducted).toLocaleString('he-IL')} ₪</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {merged
                          ? <Typography variant="caption" color="text.secondary">{Math.round(Number(l.merged_balance) || 0).toLocaleString('he-IL')} ₪ עברו להלוואה המאוחדת</Typography>
                          : `${Math.round(remaining).toLocaleString('he-IL')} ₪`}
                      </TableCell>
                      <TableCell>
                        {merged ? (
                          <Typography variant="caption" color="text.secondary">—</Typography>
                        ) : newModel ? (
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
                            {l.paying_installments > 0 && monthAmount(l, ym) > 0 && (
                              <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>תשלום {l.installment_index}/{l.paying_installments}</Typography>
                            )}
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
                      <TableCell sx={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{merged ? (l.merged_note || l.notes) : (l.notes || '—')}</TableCell>
                      <TableCell>
                        {merged
                          ? <Chip size="small" label="אוחדה" color="default" variant="outlined" />
                          : <Chip size="small" label={active ? 'פעילה' : 'שולם'} color={active ? 'warning' : 'success'} variant="outlined" />}
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0}>
                          <IconButton size="small" onClick={() => (editIdx === idx ? cancelEdit() : startEdit(idx, l))} color={editIdx === idx ? 'primary' : 'default'}>
                            <EditOutlinedIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" onClick={() => removeLoan(idx)} color="error">
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                      </TableCell>
                    </TableRow>
                    );
                  const editRow = editIdx === idx && editDraft ? (
                    <TableRow key={`${l._id || idx}-edit`}>
                      <TableCell colSpan={9} sx={{ bgcolor: 'background.sunken' }}>
                        <Stack spacing={1}>
                          <Typography variant="caption" color="text.secondary">
                            עריכת הלוואה — שינוי כל פרמטר יבנה מחדש את לוח התשלומים לפי הערכים החדשים.
                          </Typography>
                          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                            <TextField size="small" type="number" label="סכום כולל"
                              value={editDraft.total_amount} onChange={e => setEditDraft({ ...editDraft, total_amount: e.target.value })} sx={{ width: 120 }} />
                            <TextField size="small" type="number" label="תשלום חודשי"
                              value={editDraft.installment_amount} onChange={e => setEditDraft({ ...editDraft, installment_amount: e.target.value })} sx={{ width: 120 }} />
                            <TextField size="small" type="number" label="מספר תשלומים"
                              value={editDraft.installments_total} onChange={e => setEditDraft({ ...editDraft, installments_total: e.target.value })} sx={{ width: 120 }} />
                            <TextField size="small" type="month" label="חודש התחלה" InputLabelProps={{ shrink: true }}
                              value={editDraft.start_month} onChange={e => setEditDraft({ ...editDraft, start_month: e.target.value })} sx={{ width: 150 }} />
                            <TextField size="small" label="הערות"
                              value={editDraft.notes} onChange={e => setEditDraft({ ...editDraft, notes: e.target.value })} sx={{ width: 180 }} />
                            <Button size="small" variant="contained" onClick={saveEdit} disabled={saving}>שמור</Button>
                            <Button size="small" onClick={cancelEdit}>ביטול</Button>
                          </Stack>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ) : null;
                  return [mainRow, editRow];
                })}
              </TableBody>
            </Table>
          )}

          {activeCount > 0 && (
            <>
              <Divider />
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>איחוד הלוואות</Typography>
                <Button size="small" variant={mergeOpen ? 'outlined' : 'contained'} color="secondary" startIcon={<MergeTypeIcon />} onClick={() => setMergeOpen(v => !v)}>
                  {mergeOpen ? 'ביטול' : 'אחד הלוואות'}
                </Button>
              </Stack>
              {mergeOpen && (
                <Stack spacing={1.2} sx={{ p: 1.5, bgcolor: 'background.sunken', borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    היתרה של כל ההלוואות הפעילות ({Math.round(mergeCarried).toLocaleString('he-IL')} ₪) תעבור להלוואה אחת חדשה, יחד עם סכום נוסף אם יש. הישנות ייסגרו ולא ינוכו יותר — ההיסטוריה שלהן נשארת.
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                    <TextField size="small" type="number" label="סכום חדש (נוסף)"
                      value={merge.new_amount} onChange={e => setMerge({ ...merge, new_amount: e.target.value })} sx={{ width: 150 }} />
                    <TextField size="small" type="number" label="תשלום חודשי"
                      value={merge.installment_amount} onChange={e => setMerge({ ...merge, installment_amount: e.target.value })} sx={{ width: 130 }} />
                    <TextField size="small" type="month" label="חודש התחלה" InputLabelProps={{ shrink: true }}
                      value={merge.start_month} onChange={e => setMerge({ ...merge, start_month: e.target.value })} sx={{ width: 150 }} />
                    <TextField size="small" label="הערות (אופציונלי)"
                      value={merge.notes} onChange={e => setMerge({ ...merge, notes: e.target.value })} sx={{ flex: 1, minWidth: 160 }} />
                  </Stack>
                  <Alert severity={mergeInst > 0 ? 'info' : 'warning'} icon={false} sx={{ py: 0.5 }}>
                    {mergeInst > 0
                      ? <>הלוואה אחת של <b>{Math.round(mergeTotal).toLocaleString('he-IL')} ₪</b> — <b>{mergeCount}</b> תשלומים של {mergeInst.toLocaleString('he-IL')} ₪{mergeLast !== mergeInst && mergeCount > 0 ? ` (האחרון ${Math.round(mergeLast).toLocaleString('he-IL')} ₪)` : ''}, החל מ-{merge.start_month || ym}.</>
                      : <>יתרה להעברה: {Math.round(mergeCarried).toLocaleString('he-IL')} ₪. מלא/י תשלום חודשי כדי לראות את הפריסה.</>}
                  </Alert>
                  <Box>
                    <Button variant="contained" color="secondary" startIcon={<MergeTypeIcon />} onClick={doMerge} disabled={saving || !mergeInst}>
                      אחד ל-{mergeCount || '—'} תשלומים
                    </Button>
                  </Box>
                </Stack>
              )}
            </>
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
