import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  Box, Typography, Divider, Alert, IconButton,
} from '@mui/material';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import api from '../../api/client';
import { toast } from 'react-toastify';

function todayPlusDays(d) {
  const date = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export default function ReceiveOrderDialog({ open, onClose, order, onReceived }) {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !order) return;
    setRows((order.items || []).map(it => ({
      qty_ordered: it.qty,
      qty_received: it.qty_received || it.qty,
      expiry_date: it.expiry_date ? String(it.expiry_date).slice(0, 10) : '',
      shelf_number: it.shelf_number || '',
      name: it.name,
    })));
  }, [open, order]);

  function update(i, field, value) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  }

  function adjust(i, delta) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, qty_received: Math.max(0, Number(r.qty_received) + delta) } : r));
  }

  async function handleSubmit() {
    setSaving(true);
    try {
      const payload = {
        items: rows.map((r, index) => ({
          index,
          qty_received: Number(r.qty_received) || 0,
          expiry_date: r.expiry_date || null,
          shelf_number: r.shelf_number || '',
        })),
      };
      const res = await api.post(`/orders/${order._id || order.id}/receive`, payload);
      onReceived?.(res.data.order);
      toast.success('קבלה נרשמה בהצלחה');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה באישור קבלה');
    } finally {
      setSaving(false);
    }
  }

  if (!order) return null;
  const anyShortage = rows.some(r => Number(r.qty_received) < Number(r.qty_ordered));
  const anyOver = rows.some(r => Number(r.qty_received) > Number(r.qty_ordered));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>אישור קבלה — {order.order_number}</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          עדכן כמות שהגיעה בפועל. התוקף ומספר המדף יישמרו ב-batch של המלאי לצרכי מעקב פג-תוקף.
        </Alert>

        <Stack spacing={1.5}>
          {rows.map((r, i) => {
            const shortage = Number(r.qty_received) < Number(r.qty_ordered);
            const over = Number(r.qty_received) > Number(r.qty_ordered);
            return (
              <Box
                key={i}
                sx={{
                  p: 1.5, borderRadius: 2,
                  border: shortage ? '2px solid #f59e0b' : over ? '2px solid #6366f1' : '1px solid #e2e8f0',
                  bgcolor: shortage ? '#fffbeb' : over ? '#eef2ff' : '#fff',
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Box sx={{ flex: 1, minWidth: 160 }}>
                    <Typography sx={{ fontWeight: 700 }}>{r.name}</Typography>
                    <Typography variant="caption" color="text.secondary">הוזמן: {r.qty_ordered}</Typography>
                  </Box>

                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <IconButton size="small" onClick={() => adjust(i, -1)}><RemoveIcon fontSize="small" /></IconButton>
                    <TextField
                      size="small" label="הגיע"
                      value={r.qty_received}
                      onChange={(e) => update(i, 'qty_received', e.target.value)}
                      inputProps={{ inputMode: 'numeric', style: { textAlign: 'center', fontWeight: 700, width: 60 } }}
                    />
                    <IconButton size="small" onClick={() => adjust(i, +1)}><AddIcon fontSize="small" /></IconButton>
                  </Stack>

                  <TextField
                    size="small" label="תוקף" type="date"
                    value={r.expiry_date}
                    onChange={(e) => update(i, 'expiry_date', e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    sx={{ minWidth: 150 }}
                  />

                  <TextField
                    size="small" label="מספר מדף"
                    value={r.shelf_number}
                    onChange={(e) => update(i, 'shelf_number', e.target.value)}
                    placeholder="A-3"
                    sx={{ width: 110 }}
                  />
                </Stack>
                {shortage && (
                  <Typography variant="caption" sx={{ color: '#92400e', mt: 0.5, display: 'block' }}>
                    חוסר: {Number(r.qty_ordered) - Number(r.qty_received)}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Stack>

        {(anyShortage || anyOver) && (
          <Alert severity={anyShortage ? 'warning' : 'info'} sx={{ mt: 2 }}>
            {anyShortage && 'יש פריטים שהגיעו בחסר. ההזמנה תסומן כ"קבלה חלקית". '}
            {anyOver && 'יש פריטים שהגיעו ביתר.'}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={saving}>
          {saving ? 'שומר...' : 'אשר קבלה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
