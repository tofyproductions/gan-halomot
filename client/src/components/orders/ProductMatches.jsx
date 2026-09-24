import { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, Card, CardContent, Button, Stack, Chip, Tabs, Tab, TextField, MenuItem,
  Alert, Divider, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AddLinkIcon from '@mui/icons-material/AddLink';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ProductThumb from './ProductThumb';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrencyExact } from '../../utils/hebrewYear';

const perUnit = (price, qty) => (qty > 0 ? price / qty : null);

/** One side of a match: picture, name, price per pack and — live — per base unit. */
function Side({ product, packQty, onPackQty, baseUnit, editable }) {
  const per = perUnit(product.price_with_vat, Number(packQty));
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <ProductThumb product={product} size={48} radius={1.5} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">{product.supplier_name}</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{product.name}</Typography>
          <Typography variant="caption" color="text.secondary">{product.sku}{product.unit ? ` · ${product.unit}` : ''}</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>{formatCurrencyExact(product.price_with_vat)} ל{product.unit || 'אריזה'}</Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
        {editable ? (
          <TextField
            size="small" type="number" label={`כמות ${baseUnit || 'יחידות'} באריזה`} value={packQty ?? ''}
            onChange={e => onPackQty(e.target.value)} inputProps={{ min: 0, step: 'any' }} sx={{ width: 170 }}
          />
        ) : (
          <Typography variant="body2" color="text.secondary">{packQty ? `${packQty} ${baseUnit || ''} באריזה` : 'כמות באריזה לא ידועה'}</Typography>
        )}
        {per !== null && (
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{formatCurrencyExact(per)} ל{baseUnit || 'יחידה'}</Typography>
        )}
      </Stack>
    </Box>
  );
}

function MatchCard({ match, mode, onDecided }) {
  const [packQty, setPackQty] = useState(() => Object.fromEntries(match.products.map(p => [String(p.id), p.pack_qty ?? ''])));
  const [baseUnit, setBaseUnit] = useState(match.base_unit || '');
  const [busy, setBusy] = useState(false);

  const act = async (action) => {
    setBusy(true);
    try {
      if (action === 'confirm') {
        const pq = Object.fromEntries(Object.entries(packQty).map(([k, v]) => [k, v === '' ? null : Number(v)]));
        await api.post(`/products/matches/${match.id}/confirm`, { pack_qty: pq, base_unit: baseUnit });
        toast.success('ההתאמה אושרה');
      } else if (action === 'reject') {
        await api.post(`/products/matches/${match.id}/reject`);
        toast.info('נרשם — לא יוצע שוב');
      } else {
        await api.post(`/products/matches/${match.id}/unlink`);
        toast.info('ההתאמה בוטלה');
      }
      onDecided();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setBusy(false);
    }
  };

  const editable = mode === 'proposed';
  const pers = match.products.map(p => perUnit(p.price_with_vat, Number(packQty[String(p.id)])));
  const cheapest = pers.every(v => v !== null) ? Math.min(...pers) : null;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            {editable ? (
              <TextField size="small" label="יחידת בסיס" value={baseUnit} onChange={e => setBaseUnit(e.target.value)} sx={{ width: 140 }} />
            ) : (
              <Chip label={match.base_unit || 'יחידה'} size="small" variant="outlined" />
            )}
            {match.label && <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{match.label}</Typography>}
          </Stack>
          {mode === 'proposed' && <Chip label={`ביטחון ${Math.round((match.confidence || 0) * 100)}%`} size="small" color={match.confidence >= 0.8 ? 'success' : 'warning'} variant="outlined" />}
          {mode === 'confirmed' && match.proposed_by === 'user' && <Chip label="ידני" size="small" variant="outlined" />}
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} divider={<Divider orientation="vertical" flexItem />}>
          {match.products.map(p => (
            <Side
              key={p.id} product={p} baseUnit={baseUnit} editable={editable}
              packQty={packQty[String(p.id)]} onPackQty={v => setPackQty(s => ({ ...s, [String(p.id)]: v }))}
            />
          ))}
        </Stack>
        {cheapest !== null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            הזול ביותר ל{baseUnit || 'יחידה'}: {formatCurrencyExact(cheapest)}
          </Typography>
        )}
        {match.reason && <Alert severity="info" sx={{ mt: 1.5, borderRadius: 2 }}>{match.reason}</Alert>}
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          {mode === 'proposed' ? (
            <>
              <Button variant="contained" color="success" startIcon={<CheckIcon />} onClick={() => act('confirm')} disabled={busy}>אשר</Button>
              <Button variant="outlined" color="error" startIcon={<CloseIcon />} onClick={() => act('reject')} disabled={busy}>לא אותו דבר</Button>
            </>
          ) : (
            <Button variant="outlined" color="error" startIcon={<LinkOffIcon />} onClick={() => act('unlink')} disabled={busy}>בטל התאמה</Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Pick two products from two suppliers and declare them the same. */
function ManualMatchDialog({ open, onClose, onCreated }) {
  const [suppliers, setSuppliers] = useState([]);
  const [a, setA] = useState({ supplier: '', products: [], product: '' });
  const [b, setB] = useState({ supplier: '', products: [], product: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/suppliers').then(res => setSuppliers(res.data.suppliers || [])).catch(() => setSuppliers([]));
    setA({ supplier: '', products: [], product: '' }); setB({ supplier: '', products: [], product: '' });
  }, [open]);

  const pickSupplier = (side, set) => async (e) => {
    const supplier = e.target.value;
    set({ supplier, products: [], product: '' });
    try {
      const res = await api.get('/products', { params: { supplier } });
      set(s => ({ ...s, products: res.data.products || [] }));
    } catch { /* keep empty */ }
  };

  const submit = async () => {
    if (!a.product || !b.product) return toast.error('בחר מוצר מכל צד');
    setBusy(true);
    try {
      await api.post('/products/matches', { product_ids: [a.product, b.product] });
      toast.success('ההתאמה נוצרה');
      onCreated(); onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setBusy(false); }
  };

  const sideFields = (state, setState, label) => (
    <Stack spacing={1} sx={{ flex: 1 }}>
      <TextField select size="small" label={`ספק ${label}`} value={state.supplier} onChange={pickSupplier(label, setState)}>
        {suppliers.map(s => <MenuItem key={s._id || s.id} value={s._id || s.id}>{s.name}</MenuItem>)}
      </TextField>
      <TextField select size="small" label={`מוצר ${label}`} value={state.product} onChange={e => setState(s => ({ ...s, product: e.target.value }))} disabled={!state.products.length}>
        {state.products.map(p => <MenuItem key={p._id || p.id} value={p._id || p.id}>{p.name}</MenuItem>)}
      </TextField>
    </Stack>
  );

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 700 }}>התאמה ידנית</DialogTitle>
      <DialogContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
          {sideFields(a, setA, 'א')}
          {sideFields(b, setB, 'ב')}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          את כמות היחידות באריזה תוכל/י להשלים אחר כך בלשונית "מאושרות" — עד אז ההשוואה תוצג לפי אריזה.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !a.product || !b.product || a.supplier === b.supplier}>צור התאמה</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ProductMatches() {
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/products/matches/review')
      .then(res => setData(res.data))
      .catch(() => toast.error('שגיאה בטעינת התאמות'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await api.post('/products/matches/scan');
      const { scanned, proposed } = res.data;
      toast.success(scanned === 0 ? 'אין מוצרים חדשים לסרוק' : `נסרקו ${scanned} מוצרים · ${proposed} הצעות חדשות`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הסריקה נכשלה');
    } finally { setScanning(false); }
  };

  if (!data) return <LoadingSpinner />;
  const last = data.last_scan;
  const list = tab === 0 ? data.proposed : data.confirmed;

  return (
    <Box dir="rtl" sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>התאמות מוצרים</Typography>
          <Typography variant="body2" color="text.secondary">
            {last?.at ? `סריקה אחרונה: ${new Date(last.at).toLocaleString('he-IL')} · ${last.scanned} נסרקו · ${last.proposed} הוצעו` : 'עדיין לא נסרק'}
            {last?.error ? ` · ${last.error}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<AddLinkIcon />} onClick={() => setManualOpen(true)}>התאמה ידנית</Button>
          <Button variant="contained" startIcon={<RefreshIcon />} onClick={runScan} disabled={scanning}>{scanning ? 'סורק...' : 'סרוק עכשיו'}</Button>
        </Stack>
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label={`ממתינות לאישור (${data.proposed.length})`} />
        <Tab label={`מאושרות (${data.confirmed.length})`} />
      </Tabs>
      {list.length === 0 ? (
        <Typography color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
          {tab === 0 ? 'אין הצעות ממתינות. לחץ "סרוק עכשיו" אחרי העלאת קטלוג.' : 'אין התאמות מאושרות'}
        </Typography>
      ) : list.map(m => (
        <MatchCard key={m.id} match={m} mode={tab === 0 ? 'proposed' : 'confirmed'} onDecided={load} />
      ))}
      <ManualMatchDialog open={manualOpen} onClose={() => setManualOpen(false)} onCreated={load} />
    </Box>
  );
}
