import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, Alert, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
  Card, CardContent, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { useConfirm } from '../shared/ConfirmProvider';
import { FileLink, BranchChip, OrderChip, IcountSourceChip } from './ExpenseCards';
import IcountFileDialog from './IcountFileDialog';
import { formatILS, formatDay, DOC_TYPE_LABEL, docAmountText, hasFile, matchesBranch } from './expenseFormat';

const DECISION_LABEL = { closed_anyway: '✓ נסגר ידנית', paid_outside_bank: '💵 שולם מחוץ לבנק' };
const ICOUNT_STATUS = {
  in_icount: { text: 'באייקאונט', color: 'success.dark' },
  filed: { text: '⬆ הועלה', color: 'success.dark' },
  not_in_icount: { text: 'לא באייקאונט', color: 'text.secondary' },
  gone: { text: '⚠️ נמחק באייקאונט', color: 'error.main' },
};

function DocCell({ d }) {
  return (
    <Box>
      <Typography variant="subtitle2">{d.vendor_name || '— ספק לא נקרא —'}</Typography>
      <Typography variant="body2" color="text.secondary">
        {[DOC_TYPE_LABEL[d.doc_type], d.doc_number, formatDay(d.doc_date)].filter(Boolean).join(' · ')}
      </Typography>
      <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{docAmountText(d)}</Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {d.supplier_tax_id && <Typography variant="caption" color="text.secondary">ח.פ {d.supplier_tax_id}</Typography>}
        {hasFile(d) && <FileLink docId={d._id} />}
        <IcountSourceChip doc={d} />
      </Stack>
    </Box>
  );
}

/** Payments of one closed document; each can be undone ("✗ לא שייך"). */
function Payments({ d, canWrite, onDone }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async (fn, ok, failMsg) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onDone(); }
    catch (err) { toast.error(apiError(err, failMsg)); }
    finally { setBusy(false); }
  };
  const unpair = async (p) => {
    if (!(await confirm({ title: 'הסרת שיוך', message: 'התנועה תחזור לחיובים הפתוחים, והמסמך יחזור ל"לשייך". השיוך הזה לא יוצע שוב.', confirm_label: 'הסר שיוך', danger: true }))) return;
    run(() => api.post('/expenses/pairs/unpair', { document_id: d._id, transaction_id: p.transaction_id }), 'השיוך הוסר', 'הסרת השיוך נכשלה');
  };
  const undecide = async () => {
    if (!(await confirm({ title: 'ביטול סגירה ידנית', message: 'המסמך יחזור ל"לשייך".', confirm_label: 'בטל' }))) return;
    run(() => api.delete(`/expenses/documents/${d._id}/decision`), 'הסגירה הידנית בוטלה', 'הביטול נכשל');
  };

  return (
    <Stack spacing={0.75}>
      {d.payments.map(p => (
        <Stack key={String(p.transaction_id)} direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2">
              {p.account_type === 'card' ? '💳' : '🏦'} {p.counterparty ? `אל: ${p.counterparty}` : (p.description || 'תנועה')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {[formatDay(p.date), formatILS(p.amount), p.account_label].filter(Boolean).join(' · ')}
              {p.transfer_note ? ` · הערה: ${p.transfer_note}` : ''}
            </Typography>
          </Box>
          {canWrite && <Button size="small" color="error" disabled={busy} onClick={() => unpair(p)}>✗ לא שייך</Button>}
        </Stack>
      ))}
      {d.decision && (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography variant="body2">{DECISION_LABEL[d.decision.kind] || 'נסגר'}{d.decision.note ? ` — ${d.decision.note}` : ''}</Typography>
          {canWrite && <Button size="small" disabled={busy} onClick={undecide}>בטל</Button>}
        </Stack>
      )}
      {!d.payments.length && !d.decision && <Typography variant="body2" color="text.secondary">—</Typography>}
    </Stack>
  );
}

function PaidCell({ d }) {
  return (
    <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>
      <Typography sx={{ fontWeight: 700 }}>{formatILS(d.paid)}</Typography>
      {d.amount_ils != null && Math.abs(d.paid - d.amount_ils) > 0.01 && (
        <Typography variant="caption" color="text.secondary">מתוך {formatILS(d.amount_ils)}</Typography>
      )}
    </Box>
  );
}

/**
 * The iCount column: where the document stands there, "⬆ העלה לאייקאונט"
 * (opens the preview) and "📤 עדכן ששולם" / its undo. Buttons only for
 * whoever holds icount_upload; a reason in words where a button is missing.
 */
function IcountCell({ d, canFile, onFile, onDone }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const ic = d.icount || { status: 'not_in_icount', docnum: '', paid_reported: false };
  const st = ICOUNT_STATUS[ic.status] || ICOUNT_STATUS.not_in_icount;
  const inIcount = ic.status === 'in_icount' || ic.status === 'filed';
  const covered = d.lane === 'closed' && !d.decision && (d.payments || []).length > 0;

  const run = async (fn, okText, failMsg) => {
    setBusy(true);
    try { const { data } = await fn(); toast.success(okText(data)); onDone(); }
    catch (err) { toast.error(apiError(err, failMsg)); }
    finally { setBusy(false); }
  };
  const reportPaid = async () => {
    if (!(await confirm({ title: 'עדכון באייקאונט ששולם', message: 'אייקאונט יסמן את המסמך כשולם, בתאריך של חיוב הבנק האחרון ששויך אליו. אפשר לבטל אחר כך.', confirm_label: '📤 עדכן ששולם' }))) return;
    run(() => api.post(`/expenses/documents/${d._id}/icount-paid`, {}), (r) => `עודכן באייקאונט ששולם (${formatDay(r.paid_date)})`, 'העדכון באייקאונט נכשל');
  };
  const undoPaid = async () => {
    if (!(await confirm({ title: 'ביטול הדיווח ששולם', message: 'המסמך יחזור באייקאונט ל"לא שולם".', confirm_label: 'בטל דיווח' }))) return;
    run(() => api.delete(`/expenses/documents/${d._id}/icount-paid`), () => 'הדיווח ששולם בוטל באייקאונט', 'הביטול נכשל');
  };

  return (
    <Stack spacing={0.5} alignItems="flex-start">
      <Typography variant="body2" sx={{ color: st.color, fontWeight: 600 }}>
        {st.text}{ic.docnum ? ` · ${ic.docnum}` : ''}
      </Typography>
      {ic.status === 'gone' && (
        <Typography variant="caption" color="text.secondary">המסמך נמחק באייקאונט אחרי שקושר — בדקו מול אורלי</Typography>
      )}
      {ic.paid_reported && <Typography variant="caption" sx={{ color: 'success.dark' }}>📤 דווח לאייקאונט ששולם</Typography>}
      {canFile && ic.status === 'not_in_icount' && d.source !== 'icount' && (
        <Button size="small" variant="outlined" disabled={busy} onClick={() => onFile(d)}>⬆ העלה לאייקאונט</Button>
      )}
      {canFile && inIcount && !ic.paid_reported && (covered ? (
        <Button size="small" variant="outlined" disabled={busy} onClick={reportPaid}>📤 עדכן ששולם</Button>
      ) : d.lane === 'closed' && (
        <Typography variant="caption" color="text.secondary">עדכון ששולם — רק כשחיובי בנק מכסים את המסמך</Typography>
      ))}
      {canFile && ic.paid_reported && (
        <Button size="small" disabled={busy} onClick={undoPaid}>בטל דיווח ששולם</Button>
      )}
    </Stack>
  );
}

function UnpaidRow({ d, canWrite, canFile, onFile, onDone }) {
  const [busy, setBusy] = useState(false);
  const back = async () => {
    setBusy(true);
    try { await api.delete(`/expenses/documents/${d._id}/unpaid`); toast.success('המסמך חזר ל"לשייך"'); onDone(); }
    catch (err) { toast.error(apiError(err, 'השמירה נכשלה')); }
    finally { setBusy(false); }
  };
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderStyle: 'dashed', borderColor: 'warning.main' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
        <DocCell d={d} />
        <Stack spacing={0.5} alignItems={{ sm: 'flex-end' }}>
          <Typography variant="body2" sx={{ color: 'warning.dark' }}>⏳ עוד לא שולמה</Typography>
          <IcountCell d={d} canFile={canFile} onFile={onFile} onDone={onDone} />
          {canWrite && <Button size="small" variant="outlined" disabled={busy} onClick={back}>החזר ל"לשייך"</Button>}
        </Stack>
      </Stack>
    </Paper>
  );
}

/** ✅ סגור — closed documents, and the ones marked "not paid yet". */
export default function ClosedTab({ branch, branches, canWrite, canFile = false, onChanged }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('md'));
  const [docs, setDocs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [fileDoc, setFileDoc] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setLoadError('');
    try {
      const { data } = await api.get('/expenses/closed');
      if (my === seq.current) setDocs(data.documents || []);
    } catch (err) {
      if (my === seq.current) setLoadError(apiError(err, 'לא הצלחנו לטעון את המסמכים הסגורים'));
    } finally { if (my === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const done = () => { load(); onChanged(); };

  if (loadError) return <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{loadError}</Alert>;
  if (loading && !docs) return <Typography color="text.secondary">טוען…</Typography>;

  const visible = docs.filter(d => matchesBranch(d, branch));
  const closed = visible.filter(d => d.lane === 'closed');
  const unpaid = visible.filter(d => d.lane === 'unpaid_marked');

  const chips = (d) => (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
      <BranchChip doc={d} branches={branches} canWrite={canWrite} onChanged={done} />
      <OrderChip doc={d} canWrite={canWrite} onChanged={done} />
    </Stack>
  );

  return (
    <Box>
      <Typography sx={{ mb: 2 }}>{closed.length} מסמכים סגורים · {unpaid.length} עוד לא שולמו</Typography>

      {!closed.length ? (
        <EmptyState state={branch ? 'filtered' : 'empty'} title="אין עדיין מסמכים סגורים" hint="מסמך נסגר כשהחיובים ששויכו אליו מכסים אותו." />
      ) : phone ? (
        <Stack spacing={1}>
          {closed.map(d => (
            <Card key={d._id} variant="outlined">
              <CardContent sx={{ py: 1.5 }}>
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <DocCell d={d} />
                  <PaidCell d={d} />
                </Stack>
                {chips(d)}
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                  <Payments d={d} canWrite={canWrite} onDone={done} />
                </Box>
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
                  <Typography variant="caption" color="text.secondary">אייקאונט</Typography>
                  <IcountCell d={d} canFile={canFile} onFile={setFileDoc} onDone={done} />
                </Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>מסמך</TableCell>
                <TableCell>שולם</TableCell>
                <TableCell>תנועות</TableCell>
                <TableCell>אייקאונט</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {closed.map(d => (
                <TableRow key={d._id} sx={{ verticalAlign: 'top' }}>
                  <TableCell sx={{ minWidth: 220 }}><DocCell d={d} />{chips(d)}</TableCell>
                  <TableCell><PaidCell d={d} /></TableCell>
                  <TableCell sx={{ minWidth: 260 }}><Payments d={d} canWrite={canWrite} onDone={done} /></TableCell>
                  <TableCell sx={{ minWidth: 150 }}><IcountCell d={d} canFile={canFile} onFile={setFileDoc} onDone={done} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="h6" sx={{ fontSize: '1.05rem', mt: 3, mb: 1 }}>⏳ עוד לא שולמה ({unpaid.length})</Typography>
      {!unpaid.length ? <Typography variant="body2" color="text.secondary">אין.</Typography> : (
        <Stack spacing={1}>{unpaid.map(d => <UnpaidRow key={d._id} d={d} canWrite={canWrite} canFile={canFile} onFile={setFileDoc} onDone={done} />)}</Stack>
      )}

      <IcountFileDialog doc={fileDoc} open={!!fileDoc} onClose={() => setFileDoc(null)} onDone={done} />
    </Box>
  );
}
