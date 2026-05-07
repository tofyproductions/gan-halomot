import { useState, useEffect } from 'react';
import {
  Drawer, Box, Typography, Stack, IconButton, Divider, Chip, Tooltip, Button, CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import UndoIcon from '@mui/icons-material/Undo';
import api from '../../api/client';
import { toast } from 'react-toastify';

const REASON_LABELS = {
  count: { label: 'ספירה', color: '#0ea5e9' },
  delivery: { label: 'קבלת הזמנה', color: '#10b981' },
  consumption: { label: 'צריכה', color: '#f59e0b' },
  correction: { label: 'תיקון', color: '#6366f1' },
  spoilage: { label: 'פסולת', color: '#dc2626' },
  undo: { label: 'ביטול', color: '#94a3b8' },
  init: { label: 'התחלה', color: '#7c3aed' },
};

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function StockHistoryDrawer({ open, onClose, item, onItemChange }) {
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    load();
  }, [open, item?._id]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get('/stock/movements', { params: { item_id: item._id, limit: 100 } });
      setMovements(res.data.movements || []);
    } catch (err) {
      toast.error('שגיאה בטעינת היסטוריה');
    } finally {
      setLoading(false);
    }
  }

  async function handleUndo(m) {
    if (!confirm(`לבטל את התנועה ${m.delta > 0 ? '+' : ''}${m.delta}?`)) return;
    try {
      const res = await api.post(`/stock/movements/${m._id}/undo`);
      onItemChange?.(res.data.item);
      toast.success('התנועה בוטלה');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בביטול');
    }
  }

  return (
    <Drawer anchor="left" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '92vw', sm: 460 } } }}>
      <Box sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 800, flex: 1 }}>היסטוריה: {item?.name}</Typography>
          <IconButton onClick={onClose}><CloseIcon /></IconButton>
        </Stack>
        <Divider sx={{ mb: 2 }} />
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>
        ) : movements.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>אין תנועות עדיין</Typography>
        ) : (
          <Stack spacing={1}>
            {movements.map(m => {
              const meta = REASON_LABELS[m.reason] || { label: m.reason, color: '#64748b' };
              const positive = m.delta > 0;
              const reversed = !!m.reversed_by_id;
              return (
                <Box
                  key={m._id}
                  sx={{
                    p: 1.5, borderRadius: 2, border: '1px solid #e2e8f0',
                    bgcolor: reversed ? '#f8fafc' : '#fff',
                    opacity: reversed ? 0.6 : 1,
                  }}
                >
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Chip
                      size="small"
                      label={meta.label}
                      sx={{ bgcolor: meta.color, color: '#fff', fontSize: '0.7rem', fontWeight: 700, height: 20 }}
                    />
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 800, fontSize: '1rem',
                        color: positive ? '#10b981' : '#dc2626',
                      }}
                    >
                      {positive ? '+' : ''}{m.delta}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" color="text.secondary">
                      {m.qty_before} → {m.qty_after}
                    </Typography>
                    {!reversed && m.reason !== 'undo' && (
                      <Tooltip title="בטל תנועה זו">
                        <IconButton size="small" onClick={() => handleUndo(m)}>
                          <UndoIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">
                      {fmtDate(m.created_at)}
                    </Typography>
                    {m.by_user_name && (
                      <Typography variant="caption" color="text.secondary">· {m.by_user_name}</Typography>
                    )}
                  </Stack>
                  {m.notes && (
                    <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.primary' }}>
                      {m.notes}
                    </Typography>
                  )}
                  {reversed && (
                    <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'warning.main', fontWeight: 700 }}>
                      תנועה זו בוטלה
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}
