import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Box, Typography,
  Checkbox, TextField, Divider, Alert, Chip, IconButton, CircularProgress,
} from '@mui/material';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { toast } from 'react-toastify';

function suggestedQty(item) {
  // Default: bring qty up to warn_qty (or min_qty * 2 fallback)
  const target = item.warn_qty > 0 ? item.warn_qty : item.min_qty * 2;
  return Math.max(1, Math.ceil(target - item.qty));
}

export default function ShortageOrderDialog({ open, onClose, branchId }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeSupplier, setActiveSupplier] = useState(null);
  const [selections, setSelections] = useState({}); // { itemId: { checked, qty } }
  const navigate = useNavigate();

  useEffect(() => {
    if (open) load();
  }, [open]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get('/stock/shortages', { params: { branch_id: branchId, level: 'warn' } });
      const list = res.data.groups || [];
      setGroups(list);
      const firstWithSupplier = list.find(g => g.supplier);
      setActiveSupplier(firstWithSupplier?.supplier?._id || null);
      const sel = {};
      for (const g of list) {
        for (const it of g.items) {
          if (it.product_id) {
            sel[it._id] = { checked: it.qty < it.min_qty, qty: suggestedQty(it) };
          }
        }
      }
      setSelections(sel);
    } catch (err) {
      toast.error('שגיאה בטעינת חוסרים');
    } finally {
      setLoading(false);
    }
  }

  function toggle(itemId) {
    setSelections(prev => ({
      ...prev,
      [itemId]: { ...prev[itemId], checked: !prev[itemId]?.checked },
    }));
  }

  function setQty(itemId, qty) {
    setSelections(prev => ({
      ...prev,
      [itemId]: { ...prev[itemId], qty: Math.max(1, Number(qty) || 1) },
    }));
  }

  function adjustQty(itemId, delta) {
    setSelections(prev => ({
      ...prev,
      [itemId]: { ...prev[itemId], qty: Math.max(1, (prev[itemId]?.qty || 1) + delta) },
    }));
  }

  function handleContinue() {
    const group = groups.find(g => g.supplier?._id === activeSupplier);
    if (!group) return;
    const items = group.items
      .filter(it => it.product_id && selections[it._id]?.checked)
      .map(it => ({
        product_id: it.product_id._id || it.product_id,
        qty: selections[it._id].qty,
      }));
    if (items.length === 0) {
      toast.error('בחר לפחות פריט אחד');
      return;
    }
    navigate('/orders/new', {
      state: {
        prefill: {
          supplier_id: group.supplier._id,
          items,
          source: 'stock-shortages',
        },
      },
    });
  }

  if (!open) return null;

  const activeGroup = groups.find(g => g.supplier?._id === activeSupplier);
  const orphanGroup = groups.find(g => !g.supplier);
  const selectedCount = activeGroup ? activeGroup.items.filter(it => selections[it._id]?.checked && it.product_id).length : 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>צור הזמנה ממה שחסר</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
        ) : groups.length === 0 ? (
          <Alert severity="success">כל הפריטים מעל סף האזהרה. אין מה להזמין.</Alert>
        ) : (
          <Stack spacing={2}>
            <Alert severity="info">
              הזמנה נפרדת לכל ספק. בחר ספק מימין, סמן פריטים, וקבע כמות. הכמות המוצעת מבוססת על סף האזהרה.
            </Alert>

            {/* Supplier picker */}
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              {groups.filter(g => g.supplier).map(g => (
                <Chip
                  key={g.supplier._id}
                  label={`${g.supplier.name} · ${g.items.filter(it => it.product_id).length}`}
                  color={activeSupplier === g.supplier._id ? 'primary' : 'default'}
                  onClick={() => setActiveSupplier(g.supplier._id)}
                  sx={{ fontWeight: 700 }}
                />
              ))}
            </Stack>

            <Divider />

            {/* Active supplier items */}
            {activeGroup && (
              <Stack spacing={1}>
                {activeGroup.items.map(it => {
                  const linked = !!it.product_id;
                  const sel = selections[it._id] || {};
                  return (
                    <Box
                      key={it._id}
                      sx={{
                        p: 1.5, borderRadius: 1.5,
                        border: '1px solid #e2e8f0',
                        bgcolor: !linked ? '#f8fafc' : sel.checked ? '#eff6ff' : '#fff',
                        opacity: !linked ? 0.7 : 1,
                      }}
                    >
                      <Stack direction="row" alignItems="center" spacing={1.5}>
                        <Checkbox
                          checked={!!sel.checked}
                          onChange={() => toggle(it._id)}
                          disabled={!linked}
                        />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 700 }}>{it.name}</Typography>
                          <Stack direction="row" spacing={1} sx={{ mt: 0.3 }}>
                            <Chip size="small" label={`במלאי: ${it.qty}`} sx={{ height: 18, fontSize: '0.7rem', bgcolor: it.qty < it.min_qty ? '#fee2e2' : '#fef3c7' }} />
                            <Chip size="small" label={`סף: ${it.min_qty}`} variant="outlined" sx={{ height: 18, fontSize: '0.7rem' }} />
                            {!linked && <Chip size="small" label="לא מחובר למוצר" sx={{ height: 18, fontSize: '0.7rem', bgcolor: '#e2e8f0' }} />}
                          </Stack>
                        </Box>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <IconButton size="small" onClick={() => adjustQty(it._id, -1)} disabled={!linked || !sel.checked}><RemoveIcon fontSize="small" /></IconButton>
                          <TextField
                            size="small"
                            value={sel.qty || 1}
                            onChange={(e) => setQty(it._id, e.target.value)}
                            disabled={!linked || !sel.checked}
                            inputProps={{ inputMode: 'numeric', style: { textAlign: 'center', fontWeight: 700, width: 50 } }}
                          />
                          <IconButton size="small" onClick={() => adjustQty(it._id, +1)} disabled={!linked || !sel.checked}><AddIcon fontSize="small" /></IconButton>
                        </Stack>
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}

            {orphanGroup && (
              <Box sx={{ mt: 2 }}>
                <Alert severity="warning">
                  {orphanGroup.items.length} פריטים בחסר ללא ספק מקושר — לא ניתן ליצור הזמנה אוטומטית עבורם. חבר אותם למוצר מספק במסך המלאי.
                </Alert>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button
          variant="contained" onClick={handleContinue}
          disabled={selectedCount === 0}
        >
          המשך לטופס הזמנה ({selectedCount})
        </Button>
      </DialogActions>
    </Dialog>
  );
}
