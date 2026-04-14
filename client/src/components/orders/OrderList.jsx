import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Card, Stack, Chip, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper, MenuItem, TextField,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';

const STATUS_MAP = {
  draft: { label: 'טיוטה', color: 'default' },
  pending: { label: 'ממתין לאישור', color: 'warning' },
  approved: { label: 'מאושר', color: 'success' },
  sent: { label: 'נשלח', color: 'info' },
  cancelled: { label: 'בוטל', color: 'error' },
};

export default function OrderList() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const fetchOrders = useCallback(() => {
    setLoading(true);
    const params = {};
    if (statusFilter) params.status = statusFilter;
    api.get('/orders', { params })
      .then(res => setOrders(res.data.orders || []))
      .catch(() => toast.error('שגיאה בטעינת הזמנות'))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>הזמנות</Typography>
        <Stack direction="row" spacing={2}>
          <TextField
            select size="small" value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            sx={{ minWidth: 140 }}
            label="סטטוס"
          >
            <MenuItem value="">הכל</MenuItem>
            {Object.entries(STATUS_MAP).map(([k, v]) => (
              <MenuItem key={k} value={k}>{v.label}</MenuItem>
            ))}
          </TextField>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/orders/new')}>
            הזמנה חדשה
          </Button>
        </Stack>
      </Stack>

      {orders.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary">אין הזמנות</Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>מס׳ הזמנה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>ספק</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סכום</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map(order => {
                const status = STATUS_MAP[order.status] || STATUS_MAP.draft;
                return (
                  <TableRow
                    key={order._id || order.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/orders/${order._id || order.id}`)}
                  >
                    <TableCell sx={{ fontWeight: 600 }}>{order.order_number}</TableCell>
                    <TableCell>{order.supplier_name || order.supplier_id?.name || ''}</TableCell>
                    <TableCell>{order.branch_name || order.branch_id?.name || ''}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{formatCurrency(order.total_amount)}</TableCell>
                    <TableCell>
                      <Chip label={status.label} color={status.color} size="small" variant="outlined" />
                    </TableCell>
                    <TableCell>{new Date(order.created_at).toLocaleDateString('he-IL')}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
