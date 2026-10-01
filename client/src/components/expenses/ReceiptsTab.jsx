import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import { Box, Stack, Typography, Paper, Button, Alert, Collapse } from '@mui/material';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { useConfirm } from '../shared/ConfirmProvider';
import { FileLink, IcountSourceChip } from './ExpenseCards';
import { formatILS, formatDay, DOC_TYPE_LABEL } from './expenseFormat';

/** Invoices this receipt may belong to — loaded when "הצמד לחשבונית…" opens. */
function Candidates({ receipt, canWrite, onDone }) {
  const [state, setState] = useState({ loading: true, error: '', list: [] });
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState({ loading: true, error: '', list: [] });
    try {
      const { data } = await api.get(`/expenses/receipts/${receipt.id}/candidates`);
      if (my === seq.current) setState({ loading: false, error: '', list: data.candidates || [] });
    } catch (err) {
      if (my === seq.current) setState({ loading: false, error: apiError(err, 'לא הצלחנו לטעון חשבוניות'), list: [] });
    }
  }, [receipt.id]);
  useEffect(() => { load(); }, [load]);

  const link = async (inv) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/expenses/receipts/${receipt.id}/link`, { invoice_id: inv.id });
      const moved = data.moved ? ` · ${data.moved} שיוכי בנק עברו לחשבונית` : '';
      const kept = data.kept ? ` · ${data.kept} נשארו על שתיהן` : '';
      toast.success(`הקבלה הוצמדה${moved}${kept}`);
      onDone();
    } catch (err) { toast.error(apiError(err, 'ההצמדה נכשלה')); }
    finally { setBusy(false); }
  };

  if (state.loading) return <Typography variant="body2" color="text.secondary">טוען…</Typography>;
  if (state.error) return <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{state.error}</Alert>;
  if (!state.list.length) return <Typography variant="body2" color="text.secondary">לא נמצאה חשבונית מתאימה. אם היא עוד לא הגיעה — הקבלה תחכה כאן.</Typography>;
  return (
    <Stack spacing={0.75}>
      {state.list.map(c => (
        <Stack key={c.id} direction="row" spacing={1} alignItems="center" justifyContent="space-between"
          sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2">{c.vendor_name || '—'}{c.doc_number ? ` · ${c.doc_number}` : ''} · {DOC_TYPE_LABEL[c.doc_type] || ''}</Typography>
            <Typography variant="caption" color="text.secondary">{formatDay(c.doc_date)} · {formatILS(c.amount_total)}{c.why ? ` · ${c.why}` : ''}</Typography>
          </Box>
          {canWrite && <Button size="small" variant="contained" disabled={busy} onClick={() => link(c)}>הצמד</Button>}
        </Stack>
      ))}
    </Stack>
  );
}

function WaitingCard({ r, graceDays, canWrite, onDone }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const overdue = r.days_waiting >= graceDays;

  // The receipt row carries no supplier, so read the document to decide: a
  // known supplier is remembered for all its receipts; otherwise only this one.
  const exempt = async () => {
    setBusy(true);
    try {
      const { data } = await api.get(`/expenses/documents/${r.id}`);
      const supplierId = data.document?.supplier_id;
      const ok = await confirm({
        title: 'הספק עוסק פטור / עמותה',
        message: supplierId
          ? `הקבלות של "${r.vendor_name}" ייחשבו מעכשיו מסמך בפני עצמו (לא יחכו לחשבונית) ויעברו ל"לשייך".`
          : 'הספק לא מזוהה במערכת — רק הקבלה הזאת תיחשב מסמך ותעבור ל"לשייך".',
        confirm_label: 'אישור',
      });
      if (!ok) return;
      if (supplierId) await api.post(`/expenses/suppliers/${supplierId}/receipt-is-document`, { value: true });
      else await api.post(`/expenses/receipts/${r.id}/is-document`);
      toast.success(supplierId ? 'הקבלות של הספק עברו ל"לשייך"' : 'הקבלה עברה ל"לשייך"');
      onDone();
    } catch (err) {
      toast.error(apiError(err, 'השמירה נכשלה'));
    } finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderInlineStart: '4px solid', borderInlineStartColor: overdue ? 'error.main' : 'secondary.main' }}>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography variant="subtitle2">🧾 {r.vendor_name || '— ספק לא נקרא —'}</Typography>
        <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatILS(r.amount_total)}</Typography>
      </Stack>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mt: 0.5 }}>
        <Typography variant="body2">קבלה {r.doc_number || '—'} · {formatDay(r.doc_date)}</Typography>
        {r.supplier_tax_id && <Typography variant="caption" color="text.secondary">ח.פ {r.supplier_tax_id}</Typography>}
        {r.has_file && <FileLink docId={r.id} />}
        <IcountSourceChip doc={r} />
      </Stack>
      {overdue && (
        <Typography variant="body2" sx={{ color: 'error.main', mt: 0.5 }}>ממתינה {r.days_waiting} ימים — לבקש מהספק את החשבונית</Typography>
      )}
      {r.payments?.length > 0 && (
        <Typography variant="caption" sx={{ color: 'warning.dark', display: 'block', mt: 0.5 }}>
          יש עליה תנועת בנק ({r.payments.map(p => formatILS(p.amount)).join(', ')}) — תעבור לחשבונית כשתוצמד
        </Typography>
      )}
      {canWrite && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
          <Button size="small" variant="outlined" onClick={() => setOpen(o => !o)}>הצמד לחשבונית…</Button>
          <Button size="small" variant="text" disabled={busy} onClick={exempt}>הספק עוסק פטור / עמותה — הקבלה היא המסמך</Button>
        </Stack>
      )}
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1 }}><Candidates receipt={r} canWrite={canWrite} onDone={onDone} /></Box>
      </Collapse>
    </Paper>
  );
}

function LinkedLine({ r, canWrite, onDone }) {
  const confirm = useConfirm();
  const inv = r.linked_invoice;
  const unlink = async () => {
    if (!(await confirm({ title: 'ביטול הצמדה', message: 'הקבלה תחזור להמתין לחשבונית. שיוכי בנק שכבר עברו לחשבונית יישארו עליה.', confirm_label: 'בטל הצמדה' }))) return;
    try { await api.delete(`/expenses/receipts/${r.id}/link`); toast.success('ההצמדה בוטלה'); onDone(); }
    catch (err) { toast.error(apiError(err, 'הביטול נכשל')); }
  };
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between"
      sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, borderInlineStart: '4px solid', borderInlineStartColor: 'success.main' }}>
      <Typography variant="body2" sx={{ minWidth: 0 }}>
        {r.vendor_name} · קבלה {formatDay(r.doc_date)} {formatILS(r.amount_total)}
        {inv ? ` ↔ חשבונית ${inv.doc_number || ''} ${formatDay(inv.doc_date)} ${formatILS(inv.amount_total)}` : ''}
      </Typography>
      {canWrite && <Button size="small" onClick={unlink}>בטל</Button>}
    </Stack>
  );
}

/** 🧾 קבלות — receipts waiting for their invoice (never linked automatically). */
export default function ReceiptsTab({ canWrite, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setLoadError('');
    try {
      const { data: d } = await api.get('/expenses/receipts');
      if (my === seq.current) setData(d);
    } catch (err) {
      if (my === seq.current) setLoadError(apiError(err, 'לא הצלחנו לטעון את הקבלות'));
    } finally { if (my === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const done = () => { load(); onChanged(); };

  if (loadError) return <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{loadError}</Alert>;
  if (loading && !data) return <Typography color="text.secondary">טוען…</Typography>;

  const grace = data.grace_days || 14;
  const waiting = [...(data.waiting || [])].sort((a, b) => b.days_waiting - a.days_waiting);
  const linked = data.linkedRecently || [];
  const overdue = (data.overdue || []).length;

  return (
    <Box>
      <Typography variant="h6" sx={{ fontSize: '1.05rem' }}>⏳ ממתינות לחשבונית ({waiting.length}){overdue ? ` · ${overdue} באיחור` : ''}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        קבלה מחכה לחשבונית שלה; אחרי {grace} ימים היא מסומנת באדום. שום קבלה לא מוצמדת אוטומטית.
      </Typography>
      {!waiting.length ? (
        <EmptyState title="אין קבלות שממתינות ✓" hint="קבלה שתגיע בלי חשבונית תופיע כאן." />
      ) : (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
          {waiting.map(r => <WaitingCard key={r.id} r={r} graceDays={grace} canWrite={canWrite} onDone={done} />)}
        </Box>
      )}

      <Typography variant="h6" sx={{ fontSize: '1.05rem', mt: 3, mb: 1 }}>✓ הוצמדו לחשבונית לאחרונה ({linked.length})</Typography>
      {!linked.length ? <Typography variant="body2" color="text.secondary">אין.</Typography> : (
        <Stack spacing={0.75}>{linked.map(r => <LinkedLine key={r.id} r={r} canWrite={canWrite} onDone={done} />)}</Stack>
      )}
    </Box>
  );
}
