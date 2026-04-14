import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, Button, Stack, Chip,
  Table, TableBody, TableCell, TableHead, TableRow, Divider, Alert,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CancelIcon from '@mui/icons-material/Cancel';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';
import ConfirmDialog from '../shared/ConfirmDialog';

const STATUS_MAP = {
  draft: { label: 'טיוטה', color: 'default' },
  pending: { label: 'ממתין לאישור', color: 'warning' },
  approved: { label: 'מאושר', color: 'success' },
  sent: { label: 'נשלח', color: 'info' },
  cancelled: { label: 'בוטל', color: 'error' },
};

export default function OrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState({ open: false, action: '' });

  useEffect(() => {
    api.get(`/orders/${id}`)
      .then(res => setOrder(res.data.order))
      .catch(() => toast.error('שגיאה בטעינת הזמנה'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleApprove = async () => {
    try {
      await api.post(`/orders/${id}/approve`, { approved_by: 'מנהל' });
      toast.success('ההזמנה אושרה!');
      setOrder(prev => ({ ...prev, status: 'approved', approved_at: new Date() }));
      setConfirm({ open: false, action: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleCancel = async () => {
    try {
      await api.delete(`/orders/${id}`);
      toast.success('ההזמנה בוטלה');
      navigate('/orders');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  if (loading) return <LoadingSpinner />;
  if (!order) return <Typography>הזמנה לא נמצאה</Typography>;

  const status = STATUS_MAP[order.status] || STATUS_MAP.draft;
  const supplier = order.supplier_id || {};
  const branch = order.branch_id || {};

  return (
    <Box dir="rtl" sx={{ maxWidth: 800, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>הזמנה {order.order_number}</Typography>
          <Chip label={status.label} color={status.color} size="small" sx={{ mt: 0.5 }} />
        </Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/orders')}>חזרה</Button>
      </Stack>

      {/* Details */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack direction="row" spacing={4} sx={{ mb: 2 }}>
            <Box>
              <Typography variant="body2" color="text.secondary">ספק</Typography>
              <Typography sx={{ fontWeight: 700 }}>{supplier.name || ''}</Typography>
              {supplier.contact_name && <Typography variant="body2">{supplier.contact_name} - {supplier.contact_phone}</Typography>}
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">סניף</Typography>
              <Typography sx={{ fontWeight: 700 }}>{branch.name || ''}</Typography>
              {branch.address && <Typography variant="body2">{branch.address}</Typography>}
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">תאריך</Typography>
              <Typography sx={{ fontWeight: 700 }}>{new Date(order.created_at).toLocaleDateString('he-IL')}</Typography>
            </Box>
          </Stack>

          {order.notes && (
            <Alert severity="info" sx={{ borderRadius: 2, mb: 2 }}>הערות: {order.notes}</Alert>
          )}

          <Divider sx={{ my: 2 }} />

          {/* Items Table */}
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>מק״ט</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>מוצר</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">כמות</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">מחיר יח׳</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">סה״כ</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(order.items || []).map((item, i) => (
                <TableRow key={i}>
                  <TableCell>{item.sku || ''}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{item.name}</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>{item.qty}</TableCell>
                  <TableCell align="center">{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>{formatCurrency(item.total)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={4} sx={{ fontWeight: 800, fontSize: '1rem' }}>סה״כ</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem' }}>
                  {formatCurrency(order.total_amount)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Actions */}
      {order.status === 'pending' && (
        <Stack direction="row" spacing={2}>
          <Button
            variant="contained" color="success" size="large"
            startIcon={<CheckCircleIcon />}
            onClick={() => setConfirm({ open: true, action: 'approve' })}
          >
            אשר הזמנה
          </Button>
          <Button
            variant="outlined" color="error" size="large"
            startIcon={<CancelIcon />}
            onClick={() => setConfirm({ open: true, action: 'cancel' })}
          >
            בטל הזמנה
          </Button>
        </Stack>
      )}

      {order.status === 'approved' && order.approved_at && (
        <Alert severity="success" sx={{ borderRadius: 2 }}>
          אושר ב-{new Date(order.approved_at).toLocaleDateString('he-IL')}
          {order.approved_by && ` על ידי ${order.approved_by}`}
        </Alert>
      )}

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, action: '' })}
        onConfirm={confirm.action === 'approve' ? handleApprove : handleCancel}
        title={confirm.action === 'approve' ? 'אישור הזמנה' : 'ביטול הזמנה'}
        message={confirm.action === 'approve' ? 'לאשר את ההזמנה?' : 'לבטל את ההזמנה?'}
      />
    </Box>
  );
}
