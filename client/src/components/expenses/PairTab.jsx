import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, Alert, Collapse, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';
import { DocCard, TxCard, Reasons, ReviewForm, IcountSourceChip } from './ExpenseCards';
import { matchesBranch, reviewInit, reviewPatchOf, formatILS, DOC_TYPE_LABEL } from './expenseFormat';

const BAD_AMOUNT = 'הסכום שהוקלד לא תקין';
const UNPAID_MSG = 'המסמך יעבור ל"סגור" ויסומן "עוד לא שולמה". כשהתשלום יגיע — משייכים אותו משם.';

/** document | reasons | charge — side by side on a wide screen, stacked on a phone (RTL: document on the right). */
function PairGrid({ left, middle, right }) {
  return (
    <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 7.5rem 1fr' }, alignItems: 'stretch' }}>
      {left}{middle}{right}
    </Box>
  );
}

/** "Other charges for this document" — opened by ✗ לא זה / 🔎 חפש תנועה. */
function DocAlternatives({ doc, canWrite, onAccept, onUnpaid, busy }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('md'));
  const [state, setState] = useState({ loading: true, error: '', list: [] });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState({ loading: true, error: '', list: [] });
    try {
      const { data } = await api.get('/expenses/pairs/alternatives', { params: { document_id: doc._id } });
      if (my === seq.current) setState({ loading: false, error: '', list: data.alternatives || [] });
    } catch (err) {
      if (my === seq.current) setState({ loading: false, error: apiError(err, 'לא הצלחנו לטעון אפשרויות'), list: [] });
    }
  }, [doc._id]);
  useEffect(() => { load(); }, [load]);

  return (
    <Box sx={{ mt: 1.5, p: 1.5, border: '1px dashed', borderColor: 'info.main', borderRadius: 1 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>אפשרויות אחרות ל"{doc.vendor_name || 'המסמך'}":</Typography>
      {state.loading ? <Typography variant="body2" color="text.secondary">טוען…</Typography>
        : state.error ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{state.error}</Alert>
        : !state.list.length ? <Typography variant="body2" color="text.secondary">אין תנועה פתוחה שמתאימה.</Typography>
        : (
          <Stack spacing={1}>
            {state.list.map(a => (
              <Box key={a.tx._id} sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '7.5rem 1fr auto' }, alignItems: 'center' }}>
                <Reasons score={a.score} reasons={a.reasons} vertical={phone} />
                <TxCard tx={a.tx} fields={a.fields} />
                {canWrite && (
                  <Button variant="contained" size="small" disabled={busy} onClick={() => onAccept(a.tx)}>
                    {doc.needs_review ? 'אשר ושייך לזו' : 'שייך לזו'}
                  </Button>
                )}
              </Box>
            ))}
          </Stack>
        )}
      {canWrite && (
        <Button fullWidth variant="outlined" color="warning" sx={{ mt: 1.5 }} disabled={busy} onClick={onUnpaid}>
          אף אחת — ⏳ עוד לא שולמה, להעלות בכל זאת
        </Button>
      )}
    </Box>
  );
}

/** One proposed pair. */
function PairRow({ pair, branches, canWrite, onDone, onCounts }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('md'));
  const confirm = useConfirm();
  const { doc, tx } = pair;
  const [review, setReview] = useState(() => reviewInit(doc));
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);

  const accept = async (charge) => {
    const patch = doc.needs_review ? reviewPatchOf(doc, review) : {};
    if (patch === null) { toast.error(BAD_AMOUNT); return; }
    setBusy(true);
    try {
      await api.post('/expenses/pairs/accept', {
        document_id: doc._id, transaction_id: charge._id, ...(doc.needs_review ? { review: patch } : {}),
      });
      toast.success('שויך');
      onDone();
    } catch (err) {
      toast.error(apiError(err, 'השיוך נכשל'));
    } finally { setBusy(false); }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await api.post('/expenses/pairs/reject', { document_id: doc._id, transaction_id: tx._id });
      setRejected(true);
      onCounts();
    } catch (err) {
      toast.error(apiError(err, 'השמירה נכשלה'));
    } finally { setBusy(false); }
  };

  const unpaid = async () => {
    if (!(await confirm({ title: 'עוד לא שולמה', message: UNPAID_MSG, confirm_label: 'סמן' }))) return;
    setBusy(true);
    try { await api.post(`/expenses/documents/${doc._id}/unpaid`); toast.success('סומן "עוד לא שולמה" — עבר ל"סגור"'); onDone(); }
    catch (err) { toast.error(apiError(err, 'הסימון נכשל')); }
    finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <PairGrid
        left={(
          <DocCard doc={doc} fields={pair.fields} branches={branches} canWrite={canWrite} onChanged={onDone}>
            {doc.needs_review && canWrite && <ReviewForm doc={doc} value={review} onChange={setReview} branches={branches} />}
          </DocCard>
        )}
        middle={<Reasons score={pair.score} reasons={pair.reasons} vertical={phone} />}
        right={(
          <TxCard tx={tx} fields={pair.fields} dim={rejected}>
            {rejected && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>✗ סימנתם שזו לא התנועה — לא תוצע שוב</Typography>}
          </TxCard>
        )}
      />
      {canWrite && !rejected && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
          <BusyButton variant="contained" color="success" loading={busy} onClick={() => accept(tx)}>
            {doc.needs_review ? '✓ נכון — אשר ושייך' : '✓ נכון, שייך'}
          </BusyButton>
          <Button variant="outlined" color="error" disabled={busy} onClick={reject}>✗ לא זה — הראו אפשרויות</Button>
        </Stack>
      )}
      {rejected && <DocAlternatives doc={doc} canWrite={canWrite} busy={busy} onAccept={accept} onUnpaid={unpaid} />}
    </Paper>
  );
}

/** A document the engine found no charge for. */
function LonelyDoc({ doc, branches, canWrite, onDone }) {
  const confirm = useConfirm();
  const [review, setReview] = useState(() => reviewInit(doc));
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn, ok, failMsg) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onDone(); }
    catch (err) { toast.error(apiError(err, failMsg)); }
    finally { setBusy(false); }
  };

  const accept = (charge) => {
    const patch = doc.needs_review ? reviewPatchOf(doc, review) : {};
    if (patch === null) { toast.error(BAD_AMOUNT); return; }
    run(() => api.post('/expenses/pairs/accept', {
      document_id: doc._id, transaction_id: charge._id, ...(doc.needs_review ? { review: patch } : {}),
    }), 'שויך', 'השיוך נכשל');
  };
  const unpaid = async () => {
    if (!(await confirm({ title: 'עוד לא שולמה', message: UNPAID_MSG, confirm_label: 'סמן' }))) return;
    run(() => api.post(`/expenses/documents/${doc._id}/unpaid`), 'סומן "עוד לא שולמה" — עבר ל"סגור"', 'הסימון נכשל');
  };
  const confirmReading = () => {
    const patch = reviewPatchOf(doc, review);
    if (patch === null) { toast.error(BAD_AMOUNT); return; }
    run(() => api.post(`/expenses/documents/${doc._id}/confirm`, { fields: patch }), 'הקריאה אושרה', 'האישור נכשל');
  };
  const closeAnyway = async () => {
    if (!(await confirm({ title: 'סגירה ידנית', message: `נותרו ${formatILS(doc.remaining)} לא מכוסים. לסגור את המסמך בכל זאת?`, confirm_label: 'סגור' }))) return;
    run(() => api.post(`/expenses/documents/${doc._id}/decision`, { kind: 'closed_anyway' }), 'המסמך נסגר', 'הסגירה נכשלה');
  };

  // Partly paid (e.g. a withholding gap): a person may close it anyway.
  const partlyPaid = doc.paid > 0 && doc.remaining > 0;

  return (
    <DocCard doc={doc} branches={branches} canWrite={canWrite} onChanged={onDone}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>{doc.why}</Typography>
      {doc.needs_review && canWrite && <ReviewForm doc={doc} value={review} onChange={setReview} branches={branches} />}
      {canWrite && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          {doc.needs_review && <Button size="small" variant="contained" disabled={busy} onClick={confirmReading}>✓ אשר קריאה</Button>}
          <Button size="small" variant="outlined" disabled={busy} onClick={() => setSearching(s => !s)}>🔎 חפש תנועה</Button>
          <Button size="small" variant="outlined" color="warning" disabled={busy} onClick={unpaid}>⏳ עוד לא שולמה</Button>
          {partlyPaid && <Button size="small" variant="outlined" disabled={busy} onClick={closeAnyway}>סגור בכל זאת</Button>}
        </Stack>
      )}
      {searching && <DocAlternatives doc={doc} canWrite={canWrite} busy={busy} onAccept={accept} onUnpaid={unpaid} />}
    </DocCard>
  );
}

/**
 * One suggested document for a lonely charge. A document still awaiting
 * review opens its reading inline: "אשר ושייך" sends the corrections with the
 * accept (the server confirms and links in one step).
 */
function ChargeOption({ alt, tx, branches, canWrite, onDone }) {
  const { doc } = alt;
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState(() => reviewInit(doc));
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    const patch = doc.needs_review ? reviewPatchOf(doc, review) : {};
    if (patch === null) { toast.error(BAD_AMOUNT); return; }
    setBusy(true);
    try {
      await api.post('/expenses/pairs/accept', {
        document_id: doc._id, transaction_id: tx._id, ...(doc.needs_review ? { review: patch } : {}),
      });
      toast.success('שויך');
      onDone();
    } catch (err) { toast.error(apiError(err, 'השיוך נכשל')); }
    finally { setBusy(false); }
  };

  return (
    <Box sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2">{doc.vendor_name || '—'}{doc.doc_number ? ` · ${doc.doc_number}` : ''} · {DOC_TYPE_LABEL[doc.doc_type] || ''}</Typography>
          <IcountSourceChip doc={doc} />
          <Typography variant="caption" color="text.secondary">
            {formatILS(doc.remaining)}{alt.reasons.length ? ` · ${alt.reasons.join(' · ')}` : ''}
          </Typography>
          {doc.needs_review && <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }}>הקריאה של המסמך עוד לא אושרה — בדקו אותה לפני השיוך</Typography>}
        </Box>
        {canWrite && !doc.needs_review && (
          <BusyButton size="small" variant="contained" loading={busy} onClick={accept}>שייך</BusyButton>
        )}
        {canWrite && doc.needs_review && !reviewing && (
          <Button size="small" variant="contained" onClick={() => setReviewing(true)}>בדוק ושייך</Button>
        )}
      </Stack>
      {reviewing && (
        <>
          <ReviewForm doc={doc} value={review} onChange={setReview} branches={branches} />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <BusyButton size="small" variant="contained" color="success" loading={busy} onClick={accept}>✓ אשר ושייך</BusyButton>
            <Button size="small" disabled={busy} onClick={() => setReviewing(false)}>ביטול</Button>
          </Stack>
        </>
      )}
    </Box>
  );
}

/** A charge with no document: "which invoice is this?" */
function LonelyCharge({ tx, branches, canWrite, onDone }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, error: '', list: [] });
  const seq = useRef(0);

  const load = async () => {
    const my = ++seq.current;
    setState({ loading: true, error: '', list: [] });
    try {
      const { data } = await api.get('/expenses/pairs/alternatives', { params: { transaction_id: tx._id } });
      if (my === seq.current) setState({ loading: false, error: '', list: data.alternatives || [] });
    } catch (err) {
      if (my === seq.current) setState({ loading: false, error: apiError(err, 'לא הצלחנו לטעון חשבוניות'), list: [] });
    }
  };
  const toggle = () => { if (!open) load(); setOpen(o => !o); };

  return (
    <TxCard tx={tx}>
      <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={toggle}>איזו חשבונית זו?</Button>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          {state.loading ? <Typography variant="body2" color="text.secondary">טוען…</Typography>
            : state.error ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{state.error}</Alert>
            : !state.list.length ? <Typography variant="body2" color="text.secondary">אין חשבונית פתוחה שמתאימה — אולי היא עוד לא הגיעה.</Typography>
            : (
              <Stack spacing={0.75}>
                {state.list.map(a => (
                  <ChargeOption key={a.doc._id} alt={a} tx={tx} branches={branches} canWrite={canWrite} onDone={onDone} />
                ))}
              </Stack>
            )}
        </Box>
      </Collapse>
    </TxCard>
  );
}

function Section({ title, count, children }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" sx={{ mb: 1, fontSize: '1.05rem' }}>{title} ({count})</Typography>
      {children}
    </Box>
  );
}

const cardsGrid = { display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } };

/** 🎯 לשייך — proposed pairs, documents without a proposal, charges without a document. */
export default function PairTab({ branch, branches, canWrite, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showExempt, setShowExempt] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setLoadError('');
    try {
      const { data: q } = await api.get('/expenses/pairs');
      if (my === seq.current) setData(q);
    } catch (err) {
      if (my === seq.current) setLoadError(apiError(err, 'לא הצלחנו לטעון את ההתאמות'));
    } finally { if (my === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const done = () => { load(); onChanged(); };

  if (loadError) return <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{loadError}</Alert>;
  if (loading && !data) return <Typography color="text.secondary">טוען…</Typography>;

  const pairs = (data.pairs || []).filter(p => matchesBranch(p.doc, branch));
  const docs = (data.unmatchedDocs || []).filter(d => matchesBranch(d, branch));
  const charges = data.unmatchedCharges || [];
  const exempt = data.exemptCharges || [];

  return (
    <Box>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Typography sx={{ color: 'info.dark' }}>{pairs.length} זוגות מוצעים</Typography>
        <Typography sx={{ color: 'warning.dark' }}>{docs.length} מסמכים בלי הצעה</Typography>
        <Typography sx={{ color: 'error.dark' }}>{charges.length} חיובים בלי מסמך</Typography>
      </Stack>
      {branch && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>הסינון לפי סניף חל על מסמכים; חיובי בנק אינם שייכים לסניף ומוצגים כולם.</Typography>}

      {!pairs.length ? (
        <EmptyState state={branch ? 'filtered' : 'empty'} title="אין הצעות פתוחות ✓" />
      ) : (
        <Stack spacing={1.5}>
          {pairs.map(p => (
            <PairRow key={`${p.doc._id}|${p.tx._id}`} pair={p} branches={branches} canWrite={canWrite} onDone={done} onCounts={onChanged} />
          ))}
        </Stack>
      )}

      <Section title="🧾 מסמכים בלי הצעה" count={docs.length}>
        {!docs.length ? <Typography variant="body2" color="text.secondary">אין.</Typography> : (
          <Box sx={cardsGrid}>
            {docs.map(d => <LonelyDoc key={d._id} doc={d} branches={branches} canWrite={canWrite} onDone={done} />)}
          </Box>
        )}
      </Section>

      <Section title="💸 חיובים בלי מסמך — איזו חשבונית זו?" count={charges.length}>
        {!charges.length ? <Typography variant="body2" color="text.secondary">כל החיובים מוסברים ✓</Typography> : (
          <Box sx={cardsGrid}>
            {charges.map(t => <LonelyCharge key={t._id} tx={t} branches={branches} canWrite={canWrite} onDone={done} />)}
          </Box>
        )}
      </Section>

      {exempt.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Button onClick={() => setShowExempt(s => !s)} sx={{ px: 0 }}>
            {showExempt ? '▾' : '◂'} לא צריך חשבונית — עמלות, משכורות, מסים ({exempt.length})
          </Button>
          <Collapse in={showExempt} unmountOnExit>
            <Box sx={{ ...cardsGrid, mt: 1 }}>
              {exempt.map(({ tx, rule }) => (
                <TxCard key={tx._id} tx={tx} dim>
                  <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                    כלל: {rule.label}{rule.note ? ` — ${rule.note}` : ''}
                  </Typography>
                </TxCard>
              ))}
            </Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
