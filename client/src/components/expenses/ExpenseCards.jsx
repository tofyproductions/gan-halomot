import { useState, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Chip, Menu, MenuItem, Tooltip, TextField, Link, Divider, CircularProgress,
} from '@mui/material';
import api, { apiError, openApiFile } from '../../api/client';
import {
  DOC_TYPE_LABEL, DOC_TYPES, formatILS, formatDay, docAmountText, hasFile, txTitle, refLabel, tintSx, scoreColor,
  branchLabel,
} from './expenseFormat';

/**
 * The shared pieces of the expenses screen: a document card, a charge card,
 * the reasons column between them, and the branch / order chips that are
 * edited right on the row. Tabs compose these; none of them loads a list.
 */

export function Tint({ verdict, children, sx }) {
  return <Box component="span" sx={{ ...tintSx(verdict), ...sx }}>{children}</Box>;
}

export function FileLink({ docId, label = '📎 המסמך' }) {
  return (
    <Link component="button" type="button" variant="body2" underline="hover"
      onClick={() => openApiFile(`/api/expenses/documents/${docId}/file`).catch(e => toast.error(e.message))}>
      {label}
    </Link>
  );
}

/** Inline correction form for a machine-read document (`needs_review`). */
export function ReviewForm({ doc, value, onChange }) {
  const foreign = (doc.currency || 'ILS') !== 'ILS';
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <Box sx={{ mt: 1, p: 1.25, border: '1px dashed', borderColor: 'warning.main', borderRadius: 1, bgcolor: 'background.default' }}>
      <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 700, display: 'block', mb: 1 }}>
        ✎ קריאה אוטומטית — בדקו ותקנו לפני האישור
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
        <TextField size="small" label="ספק" value={value.vendor_name} onChange={set('vendor_name')} />
        <TextField size="small" label="מס׳ מסמך" value={value.doc_number} onChange={set('doc_number')} />
        <TextField size="small" label="ח.פ / עוסק" value={value.supplier_tax_id} onChange={set('supplier_tax_id')} />
        <TextField size="small" label="תאריך" type="date" value={value.doc_date} onChange={set('doc_date')} InputLabelProps={{ shrink: true }} />
        <TextField size="small" label={foreign ? 'סכום בשקלים (מהחיוב)' : 'סכום כולל'} placeholder={foreign ? 'יילקח מהחיוב' : ''}
          value={value.amount_total} onChange={set('amount_total')} inputProps={{ inputMode: 'decimal' }} />
        <TextField size="small" select label="סוג" value={value.doc_type} onChange={set('doc_type')}>
          {DOC_TYPES.map(t => <MenuItem key={t} value={t}>{DOC_TYPE_LABEL[t]}</MenuItem>)}
        </TextField>
      </Box>
    </Box>
  );
}

/** Branch chip — pick a branch or "כללי" right on the row. */
export function BranchChip({ doc, branches, canWrite, onChanged }) {
  const [anchor, setAnchor] = useState(null);
  const [busy, setBusy] = useState(false);
  const blocked = doc.needs_review;
  const save = async (value) => {
    setAnchor(null);
    setBusy(true);
    try {
      const fields = value === 'general' ? { branch_id: null, is_general: true } : { branch_id: value, is_general: false };
      await api.patch(`/expenses/documents/${doc._id}`, fields);
      toast.success('הסניף נשמר');
      onChanged?.();
    } catch (err) {
      toast.error(apiError(err, 'שמירת הסניף נכשלה'));
    } finally { setBusy(false); }
  };
  const label = `סניף: ${branchLabel(doc, branches)}`;
  if (!canWrite) return <Chip size="small" variant="outlined" label={label} />;
  return (
    <>
      <Tooltip title={blocked ? 'קודם אשרו את הקריאה של המסמך' : ''}>
        <span>
          <Chip size="small" variant="outlined" label={label} disabled={blocked || busy}
            color={!doc.branch_id && !doc.is_general ? 'warning' : 'default'}
            onClick={(e) => setAnchor(e.currentTarget)} />
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem selected={!!doc.is_general} onClick={() => save('general')}>כללי (לכל הגן)</MenuItem>
        <Divider />
        {branches.map(b => (
          <MenuItem key={b._id} selected={String(doc.branch_id) === String(b._id)} onClick={() => save(b._id)}>{b.name}</MenuItem>
        ))}
      </Menu>
    </>
  );
}

const orderLine = (c) => `הזמנה ${c.order.order_number} · ${formatDay(c.order.received_at || c.order.created_at)} · ${formatILS(c.compare_amount)}`;
const diffText = (diff) => (Math.abs(diff) > 2 ? `פער ${formatILS(Math.abs(diff))}` : 'סכום תואם');

/** Order chip — link the document to the order it bills; warns when the amounts differ by more than 2 ₪. */
export function OrderChip({ doc, canWrite, onChanged }) {
  const [anchor, setAnchor] = useState(null);
  const [cands, setCands] = useState(null); // null = not loaded
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = async (quiet) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const { data } = await api.get(`/expenses/documents/${doc._id}/orders`);
      if (my === seq.current) setCands(data.candidates || []);
    } catch (err) {
      if (my === seq.current && !quiet) toast.error(apiError(err, 'לא הצלחנו לטעון הזמנות'));
    } finally { if (my === seq.current) setLoading(false); }
  };

  // A linked order needs its number and the amount check, so it loads once.
  useEffect(() => { if (doc.order_id) load(true); }, [doc._id, doc.order_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const linked = doc.order_id && cands ? cands.find(c => String(c.order._id) === String(doc.order_id)) : null;
  const mismatch = linked && Math.abs(linked.diff) > 2;

  const open = (e) => { setAnchor(e.currentTarget); if (cands == null) load(false); };

  const link = async (orderId) => {
    setAnchor(null); setBusy(true);
    try {
      const { data } = await api.post(`/expenses/documents/${doc._id}/order`, { order_id: orderId });
      if (data.warning) toast.warning(data.warning); else toast.success('ההזמנה קושרה');
      onChanged?.();
    } catch (err) { toast.error(apiError(err, 'קישור ההזמנה נכשל')); }
    finally { setBusy(false); }
  };
  const unlink = async () => {
    setAnchor(null); setBusy(true);
    try { await api.delete(`/expenses/documents/${doc._id}/order`); toast.success('הקישור להזמנה הוסר'); onChanged?.(); }
    catch (err) { toast.error(apiError(err, 'הסרת הקישור נכשלה')); }
    finally { setBusy(false); }
  };

  const label = doc.order_id
    ? (linked ? `הזמנה ${linked.order.order_number}` : 'הזמנה מקושרת')
    : 'בלי הזמנה';
  const noSupplier = !doc.supplier_id;

  return (
    <>
      <Tooltip title={noSupplier && !doc.order_id ? 'אין ספק מזוהה — אי אפשר להציע הזמנות' : ''}>
        <span>
          <Chip size="small" variant="outlined" label={label}
            color={mismatch ? 'warning' : 'default'}
            disabled={busy || (!canWrite && !doc.order_id) || (noSupplier && !doc.order_id)}
            onClick={canWrite ? open : undefined} />
        </span>
      </Tooltip>
      {mismatch && (
        <Typography variant="caption" sx={{ color: 'warning.dark' }}>
          ⚠️ {linked.diff > 0 ? 'החשבונית גבוהה' : 'החשבונית נמוכה'} ב-{formatILS(Math.abs(linked.diff))} ממה שהתקבל
        </Typography>
      )}
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {loading && <MenuItem disabled><CircularProgress size={16} sx={{ mr: 1 }} /> טוען…</MenuItem>}
        {!loading && cands && !cands.length && <MenuItem disabled>אין הזמנה מתאימה של הספק הזה</MenuItem>}
        {!loading && (cands || []).map(c => (
          <MenuItem key={c.order._id} selected={String(doc.order_id) === String(c.order._id)} onClick={() => link(c.order._id)}>
            <Stack>
              <Typography variant="body2">{orderLine(c)}</Typography>
              <Typography variant="caption" color={Math.abs(c.diff) > 2 ? 'warning.dark' : 'text.secondary'}>{diffText(c.diff)}</Typography>
            </Stack>
          </MenuItem>
        ))}
        {doc.order_id && <Divider />}
        {doc.order_id && <MenuItem onClick={unlink}>הסר קישור להזמנה</MenuItem>}
      </Menu>
    </>
  );
}

/**
 * A supplier document. `fields` (from the pair engine) tints name/date/amount;
 * `chips` shows the branch/order chips; children render under it (review form, buttons).
 */
export function DocCard({ doc, fields, branches = [], canWrite, onChanged, chips = true, dim, children }) {
  const f = fields || {};
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderInlineStart: '4px solid', borderInlineStartColor: 'warning.main', opacity: dim ? 0.55 : 1, height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography component="span" aria-hidden>🧾</Typography>
        <Typography variant="subtitle2" component="span">
          <Tint verdict={f.name}>{doc.vendor_name || '— ספק לא נקרא —'}</Tint>
        </Typography>
        <Chip size="small" label={DOC_TYPE_LABEL[doc.doc_type] || 'מסמך'} />
        {doc.needs_review && <Chip size="small" color="warning" variant="outlined" label="לבדיקה" />}
      </Stack>
      <Stack direction="row" spacing={1.5} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        {doc.doc_number && <Typography variant="body2">מס׳ {doc.doc_number}</Typography>}
        <Typography variant="body2"><Tint verdict={f.date}>{formatDay(doc.doc_date)}</Tint></Typography>
        <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          <Tint verdict={f.amount}>{docAmountText(doc)}</Tint>
        </Typography>
      </Stack>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        {doc.supplier_tax_id && <Typography variant="caption" color="text.secondary">ח.פ {doc.supplier_tax_id}</Typography>}
        {hasFile(doc) && <FileLink docId={doc._id} />}
      </Stack>
      {doc.paid > 0 && doc.remaining > 0 && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'success.dark' }}>
          שויך {formatILS(doc.paid)} · נותרו {formatILS(doc.remaining)}
        </Typography>
      )}
      {chips && (
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <BranchChip doc={doc} branches={branches} canWrite={canWrite} onChanged={onChanged} />
          <OrderChip doc={doc} canWrite={canWrite} onChanged={onChanged} />
        </Stack>
      )}
      {children}
    </Paper>
  );
}

/** A bank / card charge. */
export function TxCard({ tx, fields, dim, children }) {
  const f = fields || {};
  const card = tx.account_type === 'card';
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderInlineStart: '4px solid', borderInlineStartColor: 'info.main', opacity: dim ? 0.55 : 1, height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography component="span" aria-hidden>{card ? '💳' : '🏦'}</Typography>
        <Typography variant="subtitle2" component="span"><Tint verdict={f.name}>{txTitle(tx)}</Tint></Typography>
      </Stack>
      {tx.counterparty && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{tx.description}</Typography>}
      <Stack direction="row" spacing={1.5} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        <Typography variant="body2"><Tint verdict={f.date}>{formatDay(tx.date)}</Tint></Typography>
        <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          <Tint verdict={f.amount}>{formatILS(Math.abs(tx.amount))}</Tint>
        </Typography>
        {tx.remaining != null && Math.abs(Math.abs(tx.amount) - tx.remaining) > 0.01 && (
          <Typography variant="caption" color="text.secondary">נותרו {formatILS(tx.remaining)}</Typography>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        {[tx.account_label, refLabel(tx.bank_ref), card && tx.processed_date && tx.processed_date !== tx.date ? `ירד מהחשבון ${formatDay(tx.processed_date)}` : '', tx.provider_category]
          .filter(Boolean).join(' · ')}
      </Typography>
      {tx.transfer_note && (
        <Typography variant="caption" sx={{ display: 'block' }}>
          <Tint verdict={f.ref === 'ok' ? 'ok' : undefined}>הערה: {tx.transfer_note}</Tint>
        </Typography>
      )}
      {!card && !tx.counterparty && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>שם המקבל עוד לא נקרא מהבנק</Typography>
      )}
      {children}
    </Paper>
  );
}

/** The column between the two cards: score and why. */
export function Reasons({ score, reasons = [], vertical }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={0.5} sx={{ py: 0.5, textAlign: 'center' }}>
      <Typography color="text.secondary" aria-hidden>{vertical ? '↕' : '⟷'}</Typography>
      {score > 0 && <Chip size="small" color={scoreColor(score)} label={`${score}%`} />}
      {reasons.length > 0 && <Typography variant="caption" color="text.secondary">{reasons.join(' · ')}</Typography>}
    </Stack>
  );
}
