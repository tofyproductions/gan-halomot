import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  MenuItem, Autocomplete, Box, Typography, InputAdornment, Switch, FormControlLabel,
  useMediaQuery, useTheme,
} from '@mui/material';
import api from '../../api/client';
import { toast } from 'react-toastify';

const UNITS = ['יח\'', 'ק"ג', 'ל\'', 'אריזה', 'חבילה'];

export default function StockItemDialog({ open, onClose, branchId, categoryId, item, onSaved }) {
  const isEdit = !!item;
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  const [linkToProduct, setLinkToProduct] = useState(false);
  const [productOptions, setProductOptions] = useState([]);
  const [productInput, setProductInput] = useState('');
  const [productLoading, setProductLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const [name, setName] = useState('');
  const [unit, setUnit] = useState('יח\'');
  const [packSize, setPackSize] = useState(0);
  const [qty, setQty] = useState(0);
  const [minQty, setMinQty] = useState(0);
  const [warnQty, setWarnQty] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (item) {
      setLinkToProduct(!!item.product_id);
      setSelectedProduct(item.product_id || null);
      setName(item.name || '');
      setUnit(item.unit || 'יח\'');
      setPackSize(item.pack_size || 0);
      setQty(item.qty || 0);
      setMinQty(item.min_qty || 0);
      setWarnQty(item.warn_qty || 0);
      setNotes(item.notes || '');
    } else {
      setLinkToProduct(false);
      setSelectedProduct(null);
      setName('');
      setUnit('יח\'');
      setPackSize(0);
      setQty(0);
      setMinQty(0);
      setWarnQty(0);
      setNotes('');
    }
  }, [open, item]);

  // Debounced product search
  useEffect(() => {
    if (!linkToProduct || !productInput || productInput.trim().length < 1) {
      setProductOptions([]);
      return;
    }
    const t = setTimeout(async () => {
      setProductLoading(true);
      try {
        const res = await api.get('/stock/search-products', { params: { q: productInput } });
        setProductOptions(res.data.products || []);
      } catch {} finally {
        setProductLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [productInput, linkToProduct]);

  const showPackSize = unit === 'אריזה' || unit === 'חבילה';

  async function handleSave() {
    if (!linkToProduct && !name.trim()) { toast.error('שם נדרש'); return; }
    if (linkToProduct && !selectedProduct) { toast.error('בחר מוצר מהרשימה'); return; }
    setSaving(true);
    try {
      const payload = {
        category_id: categoryId,
        product_id: linkToProduct ? selectedProduct?._id : null,
        name: linkToProduct ? '' : name.trim(),
        unit,
        pack_size: showPackSize ? Number(packSize) || 0 : 0,
        min_qty: Number(minQty) || 0,
        warn_qty: Number(warnQty) || 0,
        notes,
      };
      let saved;
      if (isEdit) {
        const res = await api.patch(`/stock/items/${item._id}`, payload);
        saved = res.data.item;
      } else {
        payload.branch_id = branchId;
        payload.qty = Number(qty) || 0;
        const res = await api.post('/stock/items', payload);
        saved = res.data.item;
      }
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={fullScreen}>
      <DialogTitle sx={{ fontWeight: 800 }}>{isEdit ? 'עריכת פריט' : 'פריט חדש'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!isEdit && (
            <FormControlLabel
              control={<Switch checked={linkToProduct} onChange={(e) => setLinkToProduct(e.target.checked)} />}
              label="חיבור למוצר קיים מספק"
            />
          )}

          {linkToProduct ? (
            <Autocomplete
              options={productOptions}
              loading={productLoading}
              value={selectedProduct}
              onChange={(_, v) => setSelectedProduct(v)}
              onInputChange={(_, v) => setProductInput(v)}
              getOptionLabel={(opt) => opt?.name || ''}
              isOptionEqualToValue={(a, b) => a._id === b._id}
              renderOption={(props, opt) => (
                <Box component="li" {...props}>
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{opt.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {opt.supplier_id?.name || 'ללא ספק'} · ₪{opt.price_with_vat?.toFixed?.(2) || '—'}
                    </Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => (
                <TextField {...params} label="מוצר מהקטלוג" placeholder="הקלד שם מוצר..." />
              )}
            />
          ) : (
            <TextField
              label="שם פריט"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={isEdit && !!item?.product_id}
              helperText={isEdit && item?.product_id ? 'פריט מקושר למוצר — שנה במנהל המוצרים' : undefined}
            />
          )}

          <Stack direction="row" spacing={1}>
            <TextField
              select label="יחידה" value={unit} onChange={(e) => setUnit(e.target.value)} sx={{ flex: 1 }}
            >
              {UNITS.map(u => <MenuItem key={u} value={u}>{u}</MenuItem>)}
            </TextField>
            {showPackSize && (
              <TextField
                label="כמות באריזה" type="number"
                value={packSize} onChange={(e) => setPackSize(e.target.value)}
                sx={{ flex: 1 }}
                InputProps={{ endAdornment: <InputAdornment position="end">יח'</InputAdornment> }}
              />
            )}
          </Stack>

          {!isEdit && (
            <TextField
              label="כמות התחלתית" type="number"
              value={qty} onChange={(e) => setQty(e.target.value)}
              helperText="נרשמת כתנועת 'התחלת מלאי' ביומן"
            />
          )}

          <Stack direction="row" spacing={1}>
            <TextField
              label="סף מינימלי (אדום)" type="number"
              value={minQty} onChange={(e) => setMinQty(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              label="סף אזהרה (כתום)" type="number"
              value={warnQty} onChange={(e) => setWarnQty(e.target.value)}
              sx={{ flex: 1 }}
              helperText={Number(warnQty) < Number(minQty) ? 'אזהרה: נמוך מסף מינימום' : ''}
            />
          </Stack>

          <TextField
            label="הערות" multiline rows={2}
            value={notes} onChange={(e) => setNotes(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? 'שומר...' : 'שמור'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
