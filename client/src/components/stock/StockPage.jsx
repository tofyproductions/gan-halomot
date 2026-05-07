import { useState, useEffect, useMemo } from 'react';
import {
  Box, Stack, Typography, Tabs, Tab, IconButton, Button, TextField, MenuItem, Paper,
  Tooltip, Chip, CircularProgress, Alert, Divider, InputAdornment,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HistoryIcon from '@mui/icons-material/History';
import StraightenIcon from '@mui/icons-material/Straighten';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { toast } from 'react-toastify';
import StockItemDialog from './StockItemDialog';
import StockHistoryDrawer from './StockHistoryDrawer';
import StockCountDialog from './StockCountDialog';
import StockCategoryManager from './StockCategoryManager';
import ShortageOrderDialog from './ShortageOrderDialog';
import ShoppingBasketIcon from '@mui/icons-material/ShoppingBasket';

function colorForStatus(item) {
  const { qty = 0, min_qty = 0, warn_qty = 0 } = item;
  if (qty < min_qty) return { border: '#dc2626', bg: '#fef2f2', label: 'אדום', tint: '#dc2626' };
  if (warn_qty > 0 && qty < warn_qty) return { border: '#f59e0b', bg: '#fffbeb', label: 'כתום', tint: '#f59e0b' };
  return { border: '#10b981', bg: '#f0fdf4', label: 'ירוק', tint: '#10b981' };
}

function daysSince(d) {
  if (!d) return null;
  const ms = Date.now() - new Date(d).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function StockItemCard({ item, onAdjust, onCount, onEdit, onDelete, onHistory }) {
  const status = colorForStatus(item);
  const days = daysSince(item.last_counted_at);
  const stale = days !== null && days >= 7;

  return (
    <Paper
      sx={{
        p: 1.5, borderRadius: 2,
        border: `2px solid ${status.border}`,
        bgcolor: status.bg,
        display: 'flex', flexDirection: 'column', gap: 1,
        minHeight: 180,
      }}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontWeight: 800, fontSize: '1rem', lineHeight: 1.2 }}>
            {item.name}
          </Typography>
          {item.supplier_id?.name && (
            <Typography variant="caption" color="text.secondary">{item.supplier_id.name}</Typography>
          )}
        </Box>
        <Stack direction="row" spacing={0}>
          <Tooltip title="היסטוריה">
            <IconButton size="small" onClick={() => onHistory(item)}><HistoryIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="ספירה ידנית">
            <IconButton size="small" onClick={() => onCount(item)}><StraightenIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="ערוך">
            <IconButton size="small" onClick={() => onEdit(item)}><EditIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Tooltip title="מחק">
            <IconButton size="small" color="error" onClick={() => onDelete(item)}><DeleteOutlineIcon fontSize="small" /></IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Stack direction="row" alignItems="center" justifyContent="center" spacing={2} sx={{ py: 0.5 }}>
        <IconButton
          onClick={() => onAdjust(item, -1)}
          sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', width: 44, height: 44 }}
        >
          <RemoveIcon />
        </IconButton>
        <Stack alignItems="center" sx={{ minWidth: 80 }}>
          <Typography sx={{ fontWeight: 900, fontSize: '2rem', lineHeight: 1, color: status.tint }}>
            {item.qty}
          </Typography>
          <Typography variant="caption" color="text.secondary">{item.unit}{item.pack_size ? ` × ${item.pack_size}` : ''}</Typography>
        </Stack>
        <IconButton
          onClick={() => onAdjust(item, +1)}
          sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', width: 44, height: 44 }}
        >
          <AddIcon />
        </IconButton>
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Chip size="small" label={`סף: ${item.min_qty}`} sx={{ height: 20, fontSize: '0.7rem' }} />
        {item.warn_qty > 0 && (
          <Chip size="small" label={`אזהרה: ${item.warn_qty}`} sx={{ height: 20, fontSize: '0.7rem' }} />
        )}
        {stale && (
          <Tooltip title={`לא נספר ${days} ימים`}>
            <WarningAmberIcon fontSize="small" sx={{ color: '#f59e0b' }} />
          </Tooltip>
        )}
        {days !== null && (
          <Typography variant="caption" color="text.secondary">
            ספירה: לפני {days === 0 ? 'פחות מיום' : `${days} ימים`}
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}

export default function StockPage() {
  const { selectedBranch, branches } = useBranch();
  const isAll = selectedBranch === 'all';

  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [activeCat, setActiveCat] = useState('');
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [suppliers, setSuppliers] = useState([]);

  const [itemDialog, setItemDialog] = useState({ open: false, item: null });
  const [historyItem, setHistoryItem] = useState(null);
  const [countItem, setCountItem] = useState(null);
  const [catManagerOpen, setCatManagerOpen] = useState(false);
  const [shortageOpen, setShortageOpen] = useState(false);

  const redCount = useMemo(() => items.filter(i => i.qty < i.min_qty).length, [items]);

  useEffect(() => {
    if (selectedBranch && !isAll) {
      loadCategories();
      loadItems();
      loadSuppliers();
    }
  }, [selectedBranch]);

  async function loadCategories() {
    try {
      const res = await api.get('/stock/categories', { params: { branch_id: selectedBranch } });
      const list = res.data.categories || [];
      setCategories(list);
      if (!activeCat && list.length > 0) setActiveCat(list[0]._id);
      else if (activeCat && !list.some(c => c._id === activeCat)) setActiveCat(list[0]?._id || '');
    } catch (err) {
      toast.error('שגיאה בטעינת קטגוריות');
    }
  }

  async function loadItems() {
    setLoading(true);
    try {
      const res = await api.get('/stock/items', { params: { branch_id: selectedBranch } });
      setItems(res.data.items || []);
    } catch (err) {
      toast.error('שגיאה בטעינת פריטים');
    } finally {
      setLoading(false);
    }
  }

  async function loadSuppliers() {
    try {
      const res = await api.get('/suppliers');
      setSuppliers(res.data.suppliers || res.data || []);
    } catch {}
  }

  async function handleAdjust(item, delta) {
    try {
      const res = await api.post(`/stock/items/${item._id}/adjust`, { delta, reason: 'correction' });
      setItems(prev => prev.map(i => i._id === item._id ? res.data.item : i));
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בעדכון');
    }
  }

  async function handleDelete(item) {
    if (!confirm(`למחוק את "${item.name}"?`)) return;
    try {
      await api.delete(`/stock/items/${item._id}`);
      setItems(prev => prev.filter(i => i._id !== item._id));
      toast.success('נמחק');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה במחיקה');
    }
  }

  function handleSaved(saved) {
    setItems(prev => {
      const exists = prev.some(i => i._id === saved._id);
      if (exists) return prev.map(i => i._id === saved._id ? { ...i, ...saved } : i);
      return [...prev, saved];
    });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (activeCat && i.category_id !== activeCat) return false;
      if (supplierFilter && i.supplier_id?._id !== supplierFilter && i.supplier_id !== supplierFilter) return false;
      if (q && !(i.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, activeCat, search, supplierFilter]);

  const counts = useMemo(() => {
    const byCat = {};
    for (const c of categories) byCat[c._id] = { total: 0, red: 0 };
    for (const i of items) {
      const c = byCat[i.category_id];
      if (!c) continue;
      c.total++;
      if (i.qty < i.min_qty) c.red++;
    }
    return byCat;
  }, [items, categories]);

  if (isAll) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          מעקב מלאי הוא פר סניף. בחר סניף ספציפי בחלק העליון של המסך.
        </Alert>
      </Box>
    );
  }

  if (!selectedBranch) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="warning">בחר סניף תחילה.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 1, md: 2 } }}>
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'stretch', md: 'center' }} spacing={1.5} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב מלאי</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small" placeholder="חיפוש פריט"
          value={search} onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ minWidth: 200 }}
        />
        <TextField
          select size="small" label="ספק"
          value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">כל הספקים</MenuItem>
          {suppliers.map(s => <MenuItem key={s._id} value={s._id}>{s.name}</MenuItem>)}
        </TextField>
        <Button
          variant="outlined" color="warning" startIcon={<ShoppingBasketIcon />}
          onClick={() => setShortageOpen(true)}
        >
          הזמנה מחוסרים{redCount > 0 ? ` (${redCount})` : ''}
        </Button>
        <Button
          variant="contained" startIcon={<AddIcon />}
          onClick={() => setItemDialog({ open: true, item: null })}
          disabled={!activeCat}
        >
          פריט חדש
        </Button>
        <Tooltip title="ניהול קטגוריות">
          <IconButton onClick={() => setCatManagerOpen(true)}><SettingsIcon /></IconButton>
        </Tooltip>
      </Stack>

      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={activeCat || false}
          onChange={(_, v) => setActiveCat(v)}
          variant="scrollable" scrollButtons="auto"
        >
          {categories.map(c => {
            const stat = counts[c._id] || { total: 0, red: 0 };
            return (
              <Tab
                key={c._id} value={c._id}
                label={
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <span>{c.name}</span>
                    {stat.red > 0 && (
                      <Chip
                        size="small"
                        label={stat.red}
                        sx={{ bgcolor: '#dc2626', color: '#fff', height: 18, fontSize: '0.7rem' }}
                      />
                    )}
                  </Stack>
                }
              />
            );
          })}
        </Tabs>
      </Paper>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : filtered.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">אין פריטים בקטגוריה הזו עדיין.</Typography>
          {activeCat && (
            <Button
              sx={{ mt: 2 }} variant="contained" startIcon={<AddIcon />}
              onClick={() => setItemDialog({ open: true, item: null })}
            >
              הוסף פריט ראשון
            </Button>
          )}
        </Paper>
      ) : (
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
            lg: 'repeat(4, 1fr)',
          },
          gap: 1.5,
        }}>
          {filtered.map(item => (
            <StockItemCard
              key={item._id}
              item={item}
              onAdjust={handleAdjust}
              onCount={(it) => setCountItem(it)}
              onEdit={(it) => setItemDialog({ open: true, item: it })}
              onDelete={handleDelete}
              onHistory={(it) => setHistoryItem(it)}
            />
          ))}
        </Box>
      )}

      <StockItemDialog
        open={itemDialog.open}
        item={itemDialog.item}
        branchId={selectedBranch}
        categoryId={itemDialog.item?.category_id || activeCat}
        onClose={() => setItemDialog({ open: false, item: null })}
        onSaved={handleSaved}
      />
      <StockHistoryDrawer
        open={!!historyItem}
        item={historyItem}
        onClose={() => setHistoryItem(null)}
        onItemChange={(updated) => setItems(prev => prev.map(i => i._id === updated._id ? updated : i))}
      />
      <StockCountDialog
        open={!!countItem}
        item={countItem}
        onClose={() => setCountItem(null)}
        onSaved={(updated) => {
          setItems(prev => prev.map(i => i._id === updated._id ? updated : i));
          setCountItem(null);
        }}
      />
      <StockCategoryManager
        open={catManagerOpen}
        onClose={() => setCatManagerOpen(false)}
        categories={categories}
        branchId={selectedBranch}
        onChanged={loadCategories}
      />
      <ShortageOrderDialog
        open={shortageOpen}
        onClose={() => setShortageOpen(false)}
        branchId={selectedBranch}
      />
    </Box>
  );
}
