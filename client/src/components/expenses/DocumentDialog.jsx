import { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Alert, Stack, Box, TextField, MenuItem,
  Autocomplete, List, ListItemButton, ListItemText,
} from '@mui/material';
import api, { apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import { BusyButton, FilePickButton, UploadingBar } from '../shared/UploadControls';
import { DOC_TYPES, DOC_TYPE_LABEL, GENERAL, formatILS, formatDay } from './expenseFormat';

const CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const EMPTY = () => ({
  supplier: null, vendor_name: '', supplier_tax_id: '', doc_type: 'tax_invoice', doc_number: '',
  doc_date: today(), amount_total: '', currency: 'ILS', branch: '',
});

/**
 * "+ מסמך" — a supplier document typed by a person, with an optional scan.
 * Step 2 (after the save) offers the supplier's orders to link.
 */
export default function DocumentDialog({ open, onClose, onSaved, branches }) {
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null); // { name, data (base64), mimetype, size }
  const [suppliers, setSuppliers] = useState([]);
  const [supplierError, setSupplierError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null); // the created document
  const [orders, setOrders] = useState({ loading: false, error: '', list: [] });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSupplierError('');
    api.get('/suppliers')
      .then(res => { if (alive) setSuppliers(res.data.suppliers || []); })
      .catch(err => { if (alive) setSupplierError(apiError(err, 'לא הצלחנו לטעון ספקים — אפשר להקליד שם')); });
    return () => { alive = false; };
  }, [open]);

  const reset = () => { setForm(EMPTY()); setFile(null); setError(''); setSaved(null); setOrders({ loading: false, error: '', list: [] }); };
  const close = () => { if (busy) return; reset(); onClose(); };
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const pickSupplier = (_e, s) => setForm(f => ({
    ...f, supplier: s, vendor_name: s ? s.name : f.vendor_name, supplier_tax_id: s ? (s.tax_id || '') : f.supplier_tax_id,
  }));

  const loadOrders = async (docId) => {
    setOrders({ loading: true, error: '', list: [] });
    try {
      const { data } = await api.get(`/expenses/documents/${docId}/orders`);
      setOrders({ loading: false, error: '', list: data.candidates || [] });
    } catch (err) {
      setOrders({ loading: false, error: apiError(err, 'לא הצלחנו לטעון הזמנות'), list: [] });
    }
  };

  const save = async () => {
    setError('');
    const amount = Number(String(form.amount_total).replace(/[^\d.]/g, ''));
    if (!form.vendor_name.trim()) { setError('חסר שם ספק'); return; }
    if (!form.doc_date) { setError('חסר תאריך'); return; }
    if (!(amount > 0)) { setError('הסכום לא תקין'); return; }
    const fields = {
      vendor_name: form.vendor_name.trim(),
      supplier_tax_id: form.supplier_tax_id.trim(),
      doc_type: form.doc_type,
      doc_number: form.doc_number.trim(),
      doc_date: form.doc_date,
      amount_total: amount,
      currency: form.currency,
      ...(form.supplier ? { supplier_id: form.supplier._id } : {}),
      ...(form.branch === GENERAL ? { is_general: true, branch_id: null } : form.branch ? { branch_id: form.branch, is_general: false } : {}),
    };
    setBusy(true);
    try {
      const { data } = await api.post('/expenses/documents', {
        fields,
        file: file ? { data: file.data, name: file.name, mime: file.mimetype } : null,
      }, { timeout: UPLOAD_TIMEOUT_MS });
      toast.success('המסמך נשמר');
      setSaved(data.document);
      onSaved?.();
      if (data.document?.supplier_id) loadOrders(data.document._id);
    } catch (err) {
      setError(apiError(err, 'שמירת המסמך נכשלה'));
    } finally { setBusy(false); }
  };

  const linkOrder = async (orderId) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/expenses/documents/${saved._id}/order`, { order_id: orderId });
      if (data.warning) toast.warning(data.warning); else toast.success('ההזמנה קושרה');
      onSaved?.();
      reset(); onClose();
    } catch (err) {
      toast.error(apiError(err, 'קישור ההזמנה נכשל'));
    } finally { setBusy(false); }
  };

  const foreign = form.currency !== 'ILS';

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>{saved ? 'קישור להזמנה' : 'מסמך חדש'}</DialogTitle>
      <DialogContent>
        {!saved ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Box>
              <FilePickButton
                accept="application/pdf,image/jpeg,image/png,image/webp"
                maxSizeMB={10}
                hasFile={!!file}
                label="צירוף קובץ (PDF או תמונה)"
                onPick={(f) => { setFile(f); setError(''); }}
                onError={setError}
              />
              {file && <Typography variant="body2" sx={{ mt: 0.5 }}>{file.name}</Typography>}
            </Box>
            <Autocomplete
              options={suppliers}
              value={form.supplier}
              onChange={pickSupplier}
              getOptionLabel={(s) => s.name || ''}
              isOptionEqualToValue={(a, b) => String(a._id) === String(b._id)}
              renderInput={(params) => <TextField {...params} size="small" label="ספק מהרשימה (לא חובה)" helperText={supplierError || ''} error={!!supplierError} />}
              noOptionsText="אין ספק כזה — הקלידו שם למטה"
            />
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
              <TextField size="small" label="שם הספק" value={form.vendor_name} onChange={set('vendor_name')} required />
              <TextField size="small" label="ח.פ / עוסק" value={form.supplier_tax_id} onChange={set('supplier_tax_id')} inputProps={{ inputMode: 'numeric' }} />
              <TextField size="small" select label="סוג מסמך" value={form.doc_type} onChange={set('doc_type')}>
                {DOC_TYPES.map(t => <MenuItem key={t} value={t}>{DOC_TYPE_LABEL[t]}</MenuItem>)}
              </TextField>
              <TextField size="small" label="מס׳ מסמך" value={form.doc_number} onChange={set('doc_number')} />
              <TextField size="small" type="date" label="תאריך המסמך" value={form.doc_date} onChange={set('doc_date')} InputLabelProps={{ shrink: true }} required />
              <Stack direction="row" spacing={1}>
                <TextField size="small" label={foreign ? 'סכום במטבע' : 'סכום כולל'} value={form.amount_total} onChange={set('amount_total')}
                  inputProps={{ inputMode: 'decimal' }} required sx={{ flex: 1 }} />
                <TextField size="small" select label="מטבע" value={form.currency} onChange={set('currency')} sx={{ width: 90 }}>
                  {CURRENCIES.map(c => <MenuItem key={c} value={c}>{c === 'ILS' ? '₪' : c}</MenuItem>)}
                </TextField>
              </Stack>
              <TextField size="small" select label="סניף" value={form.branch} onChange={set('branch')} sx={{ gridColumn: { sm: '1 / -1' } }}>
                <MenuItem value="">לא נבחר</MenuItem>
                <MenuItem value={GENERAL}>כללי (לכל הגן)</MenuItem>
                {branches.map(b => <MenuItem key={b._id} value={b._id}>{b.name}</MenuItem>)}
              </TextField>
            </Box>
            {foreign && <Typography variant="caption" color="text.secondary">מטבע חוץ: הסכום בשקלים יילקח מהחיוב בבנק כשישויך.</Typography>}
            {error && <Alert severity="error">{error}</Alert>}
            <UploadingBar show={busy && !!file} />
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Alert severity="success">המסמך של {saved.vendor_name} נשמר.</Alert>
            {!saved.supplier_id ? (
              <Typography variant="body2" color="text.secondary">הספק לא מזוהה ברשימת הספקים, ולכן אין הזמנות להציע.</Typography>
            ) : orders.loading ? (
              <Typography variant="body2" color="text.secondary">טוען הזמנות…</Typography>
            ) : orders.error ? (
              <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => loadOrders(saved._id)}>נסו שוב</Button>}>{orders.error}</Alert>
            ) : !orders.list.length ? (
              <Typography variant="body2" color="text.secondary">אין הזמנה פתוחה של הספק הזה בתקופה של המסמך.</Typography>
            ) : (
              <>
                <Typography variant="body2">לאיזו הזמנה המסמך שייך?</Typography>
                <List dense disablePadding sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  {orders.list.map(c => (
                    <ListItemButton key={c.order._id} divider disabled={busy} onClick={() => linkOrder(c.order._id)}>
                      <ListItemText
                        primary={`הזמנה ${c.order.order_number} · ${formatDay(c.order.received_at || c.order.created_at)} · ${formatILS(c.compare_amount)}`}
                        secondary={Math.abs(c.diff) > 2 ? `פער ${formatILS(Math.abs(c.diff))} מול המסמך` : 'הסכום תואם'}
                        secondaryTypographyProps={{ color: Math.abs(c.diff) > 2 ? 'warning.dark' : 'text.secondary' }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {!saved ? (
          <>
            <Button onClick={close} disabled={busy}>ביטול</Button>
            <BusyButton variant="contained" loading={busy} loadingText="שומר…" onClick={save}>שמירה</BusyButton>
          </>
        ) : (
          <Button onClick={close} disabled={busy}>{orders.list.length ? 'דלג' : 'סגירה'}</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
