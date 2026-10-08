import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  MenuItem, Alert, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api, { apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import { BusyButton, FilePickButton, UploadingBar } from '../shared/UploadControls';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

const DOC_TYPES = [
  { value: 'tax_invoice', label: 'חשבונית מס' },
  { value: 'invoice_receipt', label: 'חשבונית מס/קבלה' },
  { value: 'receipt', label: 'קבלה' },
];

/**
 * צירוף חשבונית של ספק חוגים לחודש אחד.
 *
 * The file becomes a regular ExpenseDocument (same intake, same duplicate
 * rules as the expenses tab's "+ מסמך"), written in the provider's name and
 * remembered on the provider's month here. The amount arrives pre-filled
 * with the month's computed total — the figure the invoice is SUPPOSED to
 * say — but stays editable, because the invoice is the truth and the screen
 * is the estimate.
 */
export default function ClassInvoiceDialog({ open, onClose, onSaved, provider, branch, month, suggestedAmount }) {
  const [file, setFile] = useState(null); // { name, data (base64), mimetype, size }
  const [docType, setDocType] = useState('tax_invoice');
  const [docNumber, setDocNumber] = useState('');
  const [docDate, setDocDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setFile(null); setDocType('tax_invoice'); setDocNumber(''); setDocDate(today());
    setAmount(suggestedAmount ? String(Math.round(suggestedAmount * 100) / 100) : '');
    setError('');
  }, [open, suggestedAmount]);

  const save = async () => {
    setError('');
    const amt = Number(String(amount).replace(/[^\d.]/g, ''));
    if (!file) { setError('חסר קובץ חשבונית'); return; }
    if (!docDate) { setError('חסר תאריך'); return; }
    if (!(amt > 0)) { setError('הסכום לא תקין'); return; }
    setBusy(true);
    try {
      await api.post('/classes/payments/invoice', {
        branch_id: branch,
        month,
        provider_id: provider?.provider_id || null,
        provider_name: provider?.provider_name || '',
        fields: { doc_type: docType, doc_number: docNumber.trim(), doc_date: docDate, amount_total: amt },
        file: { data: file.data, name: file.name, mime: file.mimetype },
      }, { timeout: UPLOAD_TIMEOUT_MS });
      toast.success('החשבונית נשמרה');
      onSaved?.();
      onClose();
    } catch (err) {
      setError(apiError(err, 'שמירת החשבונית נכשלה'));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>חשבונית — {provider?.provider_name || ''} · {month}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <FilePickButton
            accept="application/pdf,image/jpeg,image/png,image/webp"
            maxSizeMB={10}
            hasFile={!!file}
            label="בחירת קובץ (PDF או תמונה)"
            onPick={(f) => { setFile(f); setError(''); }}
            onError={setError}
          />
          {file && <Typography variant="caption" color="text.secondary">{file.name}</Typography>}
          <TextField select size="small" label="סוג מסמך" value={docType} onChange={e => setDocType(e.target.value)}>
            {DOC_TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          <TextField size="small" label="מספר חשבונית" value={docNumber} onChange={e => setDocNumber(e.target.value)} />
          <TextField size="small" type="date" label="תאריך החשבונית" value={docDate}
            onChange={e => setDocDate(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="סכום (₪, כולל מע״מ אם יש)" value={amount}
            onChange={e => setAmount(e.target.value)} inputProps={{ inputMode: 'decimal' }}
            helperText="מולא מראש לפי החישוב של החודש — אם החשבונית אומרת אחרת, החשבונית קובעת" />
          {error && <Alert severity="error">{error}</Alert>}
          <UploadingBar show={busy} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>ביטול</Button>
        <BusyButton variant="contained" loading={busy} loadingText="שומר…" onClick={save}>שמירה</BusyButton>
      </DialogActions>
    </Dialog>
  );
}
