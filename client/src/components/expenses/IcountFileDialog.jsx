import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Alert, Stack, Box, TextField,
} from '@mui/material';
import api, { apiError } from '../../api/client';
import { BusyButton } from '../shared/UploadControls';
import { DOC_TYPE_LABEL, formatILS, formatDay, docAmountText } from './expenseFormat';

/** iCount's expense_doctype in words (the filing service's map, read back). */
const ICOUNT_DOCTYPE_LABEL = {
  invoice: 'חשבונית מס', invrec: 'חשבונית מס/קבלה', receipt: 'קבלה', refund: 'זיכוי', other: 'מסמך אחר',
};

const cleanType = (v) => String(v ?? '').trim();
// iCount reads (supplier list, the pre-create search) can be slow under its throttle.
const ICOUNT_TIMEOUT_MS = 2 * 60 * 1000;

function Line({ label, children }) {
  return (
    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="baseline">
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{children}</Typography>
    </Stack>
  );
}

/**
 * "⬆ העלה לאייקאונט" — a dry run first (what would be sent, to which iCount
 * supplier, and why not), then the real filing. Nothing is sent before the
 * person presses the confirm button on a clean preview.
 */
export default function IcountFileDialog({ doc, open, onClose, onDone }) {
  const [preview, setPreview] = useState(null);   // { ok, blockers, payload, icount_supplier }
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(false);
  const [defaultType, setDefaultType] = useState(null);
  const [typeInput, setTypeInput] = useState('');
  const [checkedType, setCheckedType] = useState(''); // the override the shown preview was made with
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState('');
  const [duplicate, setDuplicate] = useState(null); // { message, existing }
  const [saveFailed, setSaveFailed] = useState(null); // { icount_id }
  const seq = useRef(0);

  const runPreview = useCallback(async (override) => {
    if (!doc) return;
    const my = ++seq.current;
    setLoading(true); setPreviewError('');
    try {
      const params = override ? { expense_type_id: override } : {};
      const { data } = await api.get(`/expenses/documents/${doc._id}/icount-preview`, { params, timeout: ICOUNT_TIMEOUT_MS });
      if (my === seq.current) { setPreview(data); setCheckedType(override); }
    } catch (err) {
      if (my === seq.current) { setPreview(null); setPreviewError(apiError(err, 'התצוגה המקדימה נכשלה')); }
    } finally { if (my === seq.current) setLoading(false); }
  }, [doc]);

  useEffect(() => {
    if (!open || !doc) return;
    setPreview(null); setTypeInput(''); setCheckedType(''); setFileError(''); setDuplicate(null); setSaveFailed(null);
    runPreview('');
    let alive = true;
    api.get('/expenses/icount/settings')
      .then(res => { if (alive) setDefaultType(res.data.expense_type_id ?? null); })
      .catch(() => { if (alive) setDefaultType(null); });
    return () => { alive = false; };
  }, [open, doc, runPreview]);

  const typeNow = cleanType(typeInput);
  const stale = typeNow !== checkedType;
  const ready = !!preview && preview.ok && !stale && !loading;

  const file = async ({ confirmDuplicate = false } = {}) => {
    setBusy(true); setFileError('');
    try {
      const body = {};
      if (checkedType) body.expense_type_id = Number(checkedType);
      if (confirmDuplicate) body.confirm_duplicate = true;
      const { data } = await api.post(`/expenses/documents/${doc._id}/icount-file`, body, { timeout: ICOUNT_TIMEOUT_MS });
      if (data.warning) toast.warning(data.warning);
      else if (data.adopted) toast.info('המסמך כבר היה באייקאונט — הוא קושר אליו, לא נוצר מסמך שני');
      else if (data.recovered) toast.success('המסמך קושר למה שכבר נוצר באייקאונט');
      else toast.success('המסמך הועלה לאייקאונט');
      onDone();
      onClose();
    } catch (err) {
      const d = err?.response?.data || {};
      setDuplicate(null); setSaveFailed(null);
      if (d.code === 'PROBABLE_DUPLICATE') {
        setDuplicate({ message: d.error, existing: d.existing || null });
      } else if (d.code === 'SAVE_FAILED') {
        setSaveFailed({ icount_id: d.icount_id || '' });
        onDone();
      } else if (d.code === 'BLOCKED') {
        setPreview(p => ({ ...(p || {}), ok: false, payload: null, blockers: d.blockers || [d.error] }));
      } else {
        setFileError(apiError(err, 'ההעלאה לאייקאונט נכשלה'));
        if (d.code === 'ALREADY_FILED' || d.code === 'NOT_CLOSED') onDone();
      }
    } finally { setBusy(false); }
  };

  if (!doc) return null;
  const p = preview?.payload;
  const ex = duplicate?.existing;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>העלאה לאייקאונט — בדיקה לפני שליחה</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>מה יישלח</Typography>
            <Stack spacing={0.5}>
              <Line label="ספק אצלנו">{doc.vendor_name || '—'}{doc.supplier_tax_id ? ` · ח.פ ${doc.supplier_tax_id}` : ''}</Line>
              <Line label="ספק באייקאונט">
                {preview?.icount_supplier ? preview.icount_supplier.name || `מס׳ ${preview.icount_supplier.id}` : loading ? 'בודק…' : 'לא נמצא'}
              </Line>
              <Line label="סוג מסמך">{p ? ICOUNT_DOCTYPE_LABEL[p.expense_doctype] || p.expense_doctype : DOC_TYPE_LABEL[doc.doc_type] || '—'}</Line>
              <Line label="מספר מסמך">{p ? p.expense_docnum : doc.doc_number || '—'}</Line>
              <Line label="תאריך">{formatDay(p ? p.expense_date : doc.doc_date)}</Line>
              <Line label="סכום (מלא, בשקלים)">{p ? formatILS(p.expense_sum) : docAmountText(doc)}</Line>
              <Line label="סוג הוצאה באייקאונט">{p ? p.expense_type_id : (checkedType || defaultType || 'לא הוגדר')}</Line>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              לא נשלחים מע״מ, תשלומים, תיאור או קובץ.
            </Typography>
          </Box>

          <Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
              <TextField size="small" label="סוג הוצאה למסמך הזה" value={typeInput} onChange={e => setTypeInput(e.target.value)}
                inputProps={{ inputMode: 'numeric' }} sx={{ flex: 1 }}
                placeholder={defaultType ? String(defaultType) : ''}
                helperText={defaultType ? `ריק = לפי ההגדרה (${defaultType})` : 'לא הוגדר סוג הוצאה ב-⚙️ כלים — אפשר להקליד כאן למסמך הזה'} />
              <Button variant="outlined" disabled={loading || busy} onClick={() => runPreview(typeNow)}>בדוק שוב</Button>
            </Stack>
            {stale && <Typography variant="caption" sx={{ color: 'warning.dark', display: 'block', mt: 0.5 }}>שיניתם את סוג ההוצאה — לחצו "בדוק שוב" לפני ההעלאה.</Typography>}
          </Box>

          {loading && <Typography variant="body2" color="text.secondary">בודק מול אייקאונט…</Typography>}
          {previewError && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => runPreview(typeNow)}>נסו שוב</Button>}>{previewError}</Alert>}

          {preview && !preview.ok && (preview.blockers || []).length > 0 && (
            <Alert severity="error">
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>אי אפשר להעלות עדיין:</Typography>
              <Box component="ul" sx={{ m: 0, paddingInlineStart: '20px' }}>
                {preview.blockers.map((b, i) => <li key={i}><Typography variant="body2">{b}</Typography></li>)}
              </Box>
            </Alert>
          )}
          {ready && !duplicate && !saveFailed && <Alert severity="success">הכל מוכן. ההעלאה יוצרת מסמך באייקאונט, ואין לה ביטול מכאן.</Alert>}

          {duplicate && (
            <Alert severity="warning">
              <Typography variant="body2" sx={{ fontWeight: 700 }}>ייתכן שהמסמך כבר באייקאונט</Typography>
              {ex ? (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  באייקאונט: מסמך {ex.doc_number || ex.icount_id} · {formatILS(ex.amount_total)} · {formatDay(ex.doc_date)}
                </Typography>
              ) : <Typography variant="body2" sx={{ mt: 0.5 }}>{duplicate.message}</Typography>}
              <Typography variant="body2" sx={{ mt: 0.5 }}>אם זה אותו מסמך — אל תעלו; המשיכה הבאה מאייקאונט תקשר אותו.</Typography>
              <BusyButton size="small" variant="outlined" color="warning" loading={busy} sx={{ mt: 1 }}
                onClick={() => file({ confirmDuplicate: true })}>זה מסמך אחר — העלה בכל זאת</BusyButton>
            </Alert>
          )}

          {saveFailed && (
            <Alert severity="error">
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                המסמך נוצר באייקאונט{saveFailed.icount_id ? ` (מספר ${saveFailed.icount_id})` : ''} אבל לא נשמר אצלנו.
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                ניסיון חוזר יקשר אותו למסמך שכבר נוצר — לא ייווצר מסמך שני באייקאונט. אפשר גם ללחוץ "משוך מאייקאונט עכשיו" ב-⚙️ כלים.
              </Typography>
              <BusyButton size="small" variant="outlined" color="error" loading={busy} sx={{ mt: 1 }} onClick={() => file()}>נסה שוב לקשר</BusyButton>
            </Alert>
          )}

          {fileError && <Alert severity="error">{fileError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>סגור</Button>
        {!duplicate && !saveFailed && (
          <BusyButton variant="contained" loading={busy} loadingText="מעלה…" disabled={!ready} onClick={() => file()}>⬆ העלה לאייקאונט</BusyButton>
        )}
      </DialogActions>
    </Dialog>
  );
}
