import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, Box, Typography,
} from '@mui/material';
import api from '../../api/client';
import { toast } from 'react-toastify';

export default function StockCountDialog({ open, onClose, item, onSaved }) {
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(item?.qty ?? '');
      setNotes('');
    }
  }, [open, item?._id]);

  async function handleSave() {
    const num = Number(qty);
    if (isNaN(num) || num < 0) { toast.error('מספר לא תקין'); return; }
    setSaving(true);
    try {
      const res = await api.post(`/stock/items/${item._id}/count`, { qty: num, notes });
      onSaved?.(res.data.item);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  }

  if (!item) return null;
  const delta = Number(qty) - (item.qty || 0);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>ספירה ידנית: {item.name}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">כמות נוכחית</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800 }}>{item.qty} {item.unit}</Typography>
          </Box>
          <TextField
            label="כמות בפועל"
            type="number"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            autoFocus
            inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', step: 'any' }}
            sx={{
              '& input': { fontSize: '1.6rem', fontWeight: 800, textAlign: 'center', py: 2 },
            }}
          />
          {!isNaN(delta) && delta !== 0 && qty !== '' && (
            <Box sx={{
              p: 1, borderRadius: 1, textAlign: 'center',
              bgcolor: delta > 0 ? '#d1fae5' : '#fee2e2',
              color: delta > 0 ? '#065f46' : '#991b1b',
              fontWeight: 700,
            }}>
              שינוי: {delta > 0 ? '+' : ''}{delta}
            </Box>
          )}
          <TextField
            label="הערות (אופציונלי)"
            multiline rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || qty === ''}>
          {saving ? 'שומר...' : 'שמור ספירה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
