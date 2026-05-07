import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, Button, Stack, Chip,
  Table, TableBody, TableCell, TableHead, TableRow, Divider, Alert,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CancelIcon from '@mui/icons-material/Cancel';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import InventoryIcon from '@mui/icons-material/Inventory';
import PrintIcon from '@mui/icons-material/Print';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';
import ConfirmDialog from '../shared/ConfirmDialog';
import ReceiveOrderDialog from './ReceiveOrderDialog';

const STATUS_MAP = {
  draft: { label: 'טיוטה', color: 'default' },
  pending: { label: 'ממתין לאישור', color: 'warning' },
  approved: { label: 'מאושר', color: 'success' },
  sent: { label: 'נשלח', color: 'info' },
  pending_receive: { label: 'בדרך — ממתין לקבלה', color: 'warning' },
  received: { label: 'התקבל', color: 'success' },
  received_partial: { label: 'התקבל חלקית', color: 'warning' },
  cancelled: { label: 'בוטל', color: 'error' },
};

export default function OrderView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState({ open: false, action: '' });
  const [receiveOpen, setReceiveOpen] = useState(false);

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

  const handlePrint = () => {
    if (!order) return;
    const fmt = (n) => `₪${Number(n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const today = new Date(order.created_at || Date.now()).toLocaleDateString('he-IL');
    const supplierObj = order.supplier_id || {};
    const branchObj = order.branch_id || {};

    const itemsHTML = (order.items || []).map(it => `
      <tr>
        <td>${it.sku || ''}</td>
        <td style="font-weight:600">${it.name || ''}</td>
        <td style="text-align:center;font-weight:700">${it.qty || 0}</td>
        <td style="text-align:center">${fmt(it.unit_price)}</td>
        <td style="text-align:center;font-weight:700">${fmt(it.total)}</td>
      </tr>
    `).join('');

    const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
      <title>הזמנה ${order.order_number}</title>
      <style>
        @media print { @page { size: A4; margin: 14mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        body { font-family: Assistant, Arial, sans-serif; color:#1e293b; padding:20px; max-width:800px; margin:0 auto; }
        .head { border-bottom:3px solid #f59e0b; padding-bottom:12px; margin-bottom:20px; }
        .head h1 { margin:0; color:#d97706; font-size:26px; }
        .meta { width:100%; border-collapse:collapse; margin-bottom:16px; }
        .meta td { vertical-align:top; padding:12px; border-radius:8px; width:50%; }
        .meta .l { background:#f8fafc; }
        .meta .r { background:#fffbeb; }
        .lbl { color:#64748b; font-size:13px; }
        .val { font-weight:700; font-size:16px; }
        table.items { width:100%; border-collapse:collapse; font-size:14px; }
        table.items th, table.items td { padding:10px; border:1px solid #e2e8f0; }
        table.items th { background:#f8fafc; text-align:right; }
        table.items tfoot td { background:#fef3c7; font-weight:800; font-size:16px; }
        .notes { padding:12px; background:#dbeafe; border-radius:8px; margin-bottom:16px; }
        .footer { margin-top:32px; padding-top:16px; border-top:1px solid #e2e8f0; color:#94a3b8; font-size:12px; text-align:center; }
        .print-btn { position:fixed; bottom:20px; left:20px; z-index:9999; padding:12px 24px; background:#f59e0b; color:#fff; border:none; border-radius:30px; font-weight:700; font-size:16px; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); }
        @media print { .print-btn { display:none; } }
      </style></head>
      <body>
        <button class="print-btn" onclick="window.print()">🖨️ הדפס / שמור כ-PDF</button>
        <div class="head">
          <h1>הזמנה ${order.order_number}</h1>
          <div style="color:#64748b;margin-top:6px">${today}</div>
        </div>
        <table class="meta"><tr>
          <td class="l">
            <div class="lbl">ספק</div>
            <div class="val">${supplierObj.name || ''}</div>
            ${supplierObj.contact_name ? `<div>${supplierObj.contact_name}${supplierObj.contact_phone ? ' · ' + supplierObj.contact_phone : ''}</div>` : ''}
            ${supplierObj.contact_email ? `<div>${supplierObj.contact_email}</div>` : ''}
          </td>
          <td class="r">
            <div class="lbl">סניף מזמין</div>
            <div class="val">${branchObj.name || ''}</div>
            ${branchObj.address ? `<div>${branchObj.address}</div>` : ''}
          </td>
        </tr></table>
        ${order.notes ? `<div class="notes"><b>הערות:</b> ${order.notes}</div>` : ''}
        <table class="items">
          <thead><tr>
            <th>מק"ט</th><th>מוצר</th>
            <th style="text-align:center">כמות</th>
            <th style="text-align:center">מחיר ליח'</th>
            <th style="text-align:center">סה"כ</th>
          </tr></thead>
          <tbody>${itemsHTML}</tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:left">סה"כ להזמנה</td>
            <td style="text-align:center">${fmt(order.total_amount)}</td>
          </tr></tfoot>
        </table>
        <div class="footer">גן החלומות · נוצר ב-${new Date().toLocaleString('he-IL')}</div>
        <script>setTimeout(() => window.print(), 400);</script>
      </body></html>`;

    const w = window.open('', '_blank');
    if (!w) { toast.error('הדפדפן חסם פתיחת חלון. אפשר חלונות פופ-אפ ונסה שוב.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  };

  const handleMarkArrived = async () => {
    try {
      const res = await api.post(`/orders/${id}/mark-arrived`);
      setOrder(res.data.order);
      toast.success('סומן כהגיע — אשר קבלה כשהפריטים בידיים');
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
        <Stack direction="row" spacing={1}>
          <Button startIcon={<PrintIcon />} variant="outlined" onClick={handlePrint}>הדפס / PDF</Button>
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/orders')}>חזרה</Button>
        </Stack>
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
          {(() => {
            const showReceived = ['received', 'received_partial', 'pending_receive'].includes(order.status);
            return (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>מק״ט</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>מוצר</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">כמות</TableCell>
                    {showReceived && <TableCell sx={{ fontWeight: 700 }} align="center">הגיע</TableCell>}
                    {showReceived && <TableCell sx={{ fontWeight: 700 }} align="center">תוקף</TableCell>}
                    {showReceived && <TableCell sx={{ fontWeight: 700 }} align="center">מדף</TableCell>}
                    <TableCell sx={{ fontWeight: 700 }} align="center">מחיר יח׳</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">סה״כ</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(order.items || []).map((item, i) => {
                    const shortage = showReceived && item.qty_received < item.qty;
                    return (
                      <TableRow key={i} sx={{ bgcolor: shortage ? '#fffbeb' : undefined }}>
                        <TableCell>{item.sku || ''}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{item.name}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>{item.qty}</TableCell>
                        {showReceived && (
                          <TableCell align="center" sx={{ fontWeight: 700, color: shortage ? '#92400e' : '#065f46' }}>
                            {item.qty_received ?? 0}
                          </TableCell>
                        )}
                        {showReceived && (
                          <TableCell align="center">
                            {item.expiry_date ? new Date(item.expiry_date).toLocaleDateString('he-IL') : '—'}
                          </TableCell>
                        )}
                        {showReceived && (
                          <TableCell align="center">{item.shelf_number || '—'}</TableCell>
                        )}
                        <TableCell align="center">{formatCurrency(item.unit_price)}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>{formatCurrency(item.total)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell colSpan={showReceived ? 7 : 4} sx={{ fontWeight: 800, fontSize: '1rem' }}>סה״כ</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem' }}>
                      {formatCurrency(order.total_amount)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            );
          })()}
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

      {(order.status === 'approved' || order.status === 'sent') && (
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <Button
            variant="contained" color="info" size="large"
            startIcon={<LocalShippingIcon />}
            onClick={() => setConfirm({ open: true, action: 'arrived' })}
          >
            סמן כהגיע
          </Button>
          <Button
            variant="contained" color="success" size="large"
            startIcon={<InventoryIcon />}
            onClick={() => setReceiveOpen(true)}
          >
            אשר קבלה ועדכן מלאי
          </Button>
        </Stack>
      )}

      {order.status === 'pending_receive' && (
        <Stack direction="column" spacing={1} sx={{ mt: 2 }}>
          <Alert severity="info">סומן כהגיע {order.pending_receive_at ? new Date(order.pending_receive_at).toLocaleString('he-IL') : ''}. ממתין לאישור קבלה.</Alert>
          <Button
            variant="contained" color="success" size="large"
            startIcon={<InventoryIcon />}
            onClick={() => setReceiveOpen(true)}
          >
            אשר קבלה ועדכן מלאי
          </Button>
        </Stack>
      )}

      {(order.status === 'received' || order.status === 'received_partial') && (
        <Alert severity={order.status === 'received' ? 'success' : 'warning'} sx={{ borderRadius: 2, mt: 2 }}>
          {order.status === 'received' ? 'התקבלה במלואה' : 'התקבלה חלקית — ראה חוסרים בטבלה'}
          {order.received_at && ` ב-${new Date(order.received_at).toLocaleString('he-IL')}`}
          {order.received_by_name && ` ע"י ${order.received_by_name}`}. המלאי עודכן אוטומטית.
        </Alert>
      )}

      {order.status === 'approved' && order.approved_at && (
        <Alert severity="success" sx={{ borderRadius: 2, mt: 2 }}>
          אושר ב-{new Date(order.approved_at).toLocaleDateString('he-IL')}
          {order.approved_by && ` על ידי ${order.approved_by}`}
        </Alert>
      )}

      <ReceiveOrderDialog
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        order={order}
        onReceived={(updated) => setOrder(updated)}
      />

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, action: '' })}
        onConfirm={
          confirm.action === 'approve' ? handleApprove
          : confirm.action === 'arrived' ? handleMarkArrived
          : handleCancel
        }
        title={
          confirm.action === 'approve' ? 'אישור הזמנה'
          : confirm.action === 'arrived' ? 'סימון כהגיע'
          : 'ביטול הזמנה'
        }
        message={
          confirm.action === 'approve' ? 'לאשר את ההזמנה?'
          : confirm.action === 'arrived' ? 'לסמן את ההזמנה כהגיעה? תוכל לאשר קבלה ולעדכן מלאי בשלב הבא.'
          : 'לבטל את ההזמנה?'
        }
      />
    </Box>
  );
}
