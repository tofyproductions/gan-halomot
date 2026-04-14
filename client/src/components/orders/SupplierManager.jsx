import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
  Divider, Table, TableBody, TableCell, TableHead, TableRow, Chip, Alert,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatCurrency } from '../../utils/hebrewYear';
import ConfirmDialog from '../shared/ConfirmDialog';

export default function SupplierManager() {
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState({});
  const [supplierDialog, setSupplierDialog] = useState({ open: false, mode: 'add', data: {} });
  const [productDialog, setProductDialog] = useState({ open: false, supplierId: null, data: {} });
  const [importDialog, setImportDialog] = useState({ open: false, supplierId: null, text: '' });
  const [confirm, setConfirm] = useState({ open: false, type: '', id: null });

  const fetchSuppliers = useCallback(async () => {
    const res = await api.get('/suppliers');
    setSuppliers(res.data.suppliers || []);
  }, []);

  const fetchProducts = useCallback(async (supplierId) => {
    const res = await api.get('/products', { params: { supplier: supplierId } });
    setProducts(prev => ({ ...prev, [supplierId]: res.data.products || [] }));
  }, []);

  useEffect(() => { fetchSuppliers(); }, [fetchSuppliers]);
  useEffect(() => {
    suppliers.forEach(s => fetchProducts(s._id || s.id));
  }, [suppliers, fetchProducts]);

  // Supplier CRUD
  const handleSaveSupplier = async () => {
    const { mode, data } = supplierDialog;
    if (!data.name?.trim()) return toast.error('שם הספק חובה');
    try {
      if (mode === 'add') {
        await api.post('/suppliers', data);
        toast.success('ספק נוסף');
      } else {
        await api.put(`/suppliers/${data.id || data._id}`, data);
        toast.success('ספק עודכן');
      }
      setSupplierDialog({ open: false, mode: 'add', data: {} });
      fetchSuppliers();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  // Product add
  const handleSaveProduct = async () => {
    const { supplierId, data } = productDialog;
    if (!data.name?.trim()) return toast.error('שם המוצר חובה');
    try {
      await api.post('/products', { ...data, supplier_id: supplierId });
      toast.success('מוצר נוסף');
      setProductDialog({ open: false, supplierId: null, data: {} });
      fetchProducts(supplierId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  // Bulk import
  const handleImport = async () => {
    const { supplierId, text } = importDialog;
    if (!text.trim()) return;
    try {
      // Parse tab/comma separated: SKU, Category, Name, Price
      const lines = text.trim().split('\n').filter(l => l.trim());
      const products = lines.map(line => {
        const parts = line.split(/[\t,]/).map(s => s.trim());
        return {
          sku: parts[0] || '',
          category: parts[1] || '',
          name: parts[2] || parts[0] || '',
          price_before_vat: parseFloat(parts[3]) || 0,
        };
      }).filter(p => p.name);

      if (products.length === 0) return toast.error('לא נמצאו מוצרים');

      await api.post('/products/import', { supplier_id: supplierId, products });
      toast.success(`${products.length} מוצרים יובאו`);
      setImportDialog({ open: false, supplierId: null, text: '' });
      fetchProducts(supplierId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  // Delete
  const handleDelete = async () => {
    const { type, id } = confirm;
    try {
      if (type === 'supplier') {
        await api.delete(`/suppliers/${id}`);
        toast.success('ספק הוסר');
        fetchSuppliers();
      } else {
        await api.delete(`/products/${id}`);
        toast.success('מוצר הוסר');
        suppliers.forEach(s => fetchProducts(s._id || s.id));
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
    setConfirm({ open: false, type: '', id: null });
  };

  const updateField = (key, value) => {
    setSupplierDialog(prev => ({ ...prev, data: { ...prev.data, [key]: value } }));
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 1000, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול ספקים ומוצרים</Typography>
        <Button variant="contained" startIcon={<AddIcon />}
          onClick={() => setSupplierDialog({ open: true, mode: 'add', data: { min_order_amount: 1200, vat_rate: 1.18 } })}
        >
          הוסף ספק
        </Button>
      </Stack>

      <Stack spacing={3}>
        {suppliers.map(supplier => {
          const sid = supplier._id || supplier.id;
          const prods = products[sid] || [];

          return (
            <Card key={sid} sx={{ borderRight: '5px solid #10b981' }}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>{supplier.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {supplier.contact_name} | {supplier.contact_phone}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                      <Chip size="small" label={`${prods.length} מוצרים`} variant="outlined" />
                      <Chip size="small" label={`מינימום: ${formatCurrency(supplier.min_order_amount)}`} variant="outlined" />
                      <Chip size="small" label={`מע״מ: ${Math.round((supplier.vat_rate - 1) * 100)}%`} variant="outlined" />
                    </Stack>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="ערוך">
                      <IconButton size="small" onClick={() => setSupplierDialog({ open: true, mode: 'edit', data: supplier })}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="ייבוא מוצרים">
                      <IconButton size="small" color="primary" onClick={() => setImportDialog({ open: true, supplierId: sid, text: '' })}>
                        <UploadIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="מחק">
                      <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, type: 'supplier', id: sid })}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>

                <Divider sx={{ my: 2 }} />

                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>מוצרים</Typography>
                  <Button size="small" startIcon={<AddIcon />}
                    onClick={() => setProductDialog({ open: true, supplierId: sid, data: {} })}
                  >
                    הוסף מוצר
                  </Button>
                </Stack>

                {prods.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
                    אין מוצרים. ייבא מחירון או הוסף ידנית.
                  </Typography>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }} width="50">תמונה</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>מק״ט</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>קטגוריה</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="center">מחיר + מע״מ</TableCell>
                        <TableCell align="center"></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {prods.slice(0, 20).map(p => (
                        <TableRow key={p._id || p.id} hover>
                          <TableCell>
                            {p.image_url ? (
                              <Box component="img" src={p.image_url} sx={{ width: 36, height: 36, borderRadius: 1, objectFit: 'cover' }} />
                            ) : (
                              <Box sx={{ width: 36, height: 36, borderRadius: 1, bgcolor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', cursor: 'pointer' }}
                                onClick={() => {
                                  const url = prompt('הכנס URL לתמונה:');
                                  if (url) {
                                    api.put(`/products/${p._id || p.id}`, { image_url: url })
                                      .then(() => { toast.success('תמונה עודכנה'); fetchProducts(sid); })
                                      .catch(() => toast.error('שגיאה'));
                                  }
                                }}
                                title="לחץ להוספת תמונה"
                              >📷</Box>
                            )}
                          </TableCell>
                          <TableCell>{p.sku}</TableCell>
                          <TableCell>{p.category}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 700 }}>{formatCurrency(p.price_with_vat)}</TableCell>
                          <TableCell align="center">
                            <IconButton size="small" color="error"
                              onClick={() => setConfirm({ open: true, type: 'product', id: p._id || p.id })}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                      {prods.length > 20 && (
                        <TableRow>
                          <TableCell colSpan={5} sx={{ textAlign: 'center', color: 'text.secondary' }}>
                            ...ועוד {prods.length - 20} מוצרים
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })}
      </Stack>

      {/* Supplier Dialog */}
      <Dialog open={supplierDialog.open} onClose={() => setSupplierDialog({ open: false, mode: 'add', data: {} })} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {supplierDialog.mode === 'add' ? 'הוסף ספק' : 'ערוך ספק'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="שם הספק" value={supplierDialog.data.name || ''} onChange={e => updateField('name', e.target.value)} fullWidth required />
            <TextField label="איש קשר" value={supplierDialog.data.contact_name || ''} onChange={e => updateField('contact_name', e.target.value)} fullWidth />
            <TextField label="טלפון" value={supplierDialog.data.contact_phone || ''} onChange={e => updateField('contact_phone', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
            <TextField label="אימייל" value={supplierDialog.data.contact_email || ''} onChange={e => updateField('contact_email', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
            <TextField label="מינימום הזמנה (₪)" type="number" value={supplierDialog.data.min_order_amount || ''} onChange={e => updateField('min_order_amount', parseFloat(e.target.value) || 0)} fullWidth />
            <TextField label="מע״מ (למשל 1.18)" type="number" value={supplierDialog.data.vat_rate || ''} onChange={e => updateField('vat_rate', parseFloat(e.target.value) || 1.18)} fullWidth inputProps={{ step: 0.01 }} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSupplierDialog({ open: false, mode: 'add', data: {} })}>ביטול</Button>
          <Button variant="contained" onClick={handleSaveSupplier}>שמור</Button>
        </DialogActions>
      </Dialog>

      {/* Product Dialog */}
      <Dialog open={productDialog.open} onClose={() => setProductDialog({ open: false, supplierId: null, data: {} })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>הוסף מוצר</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="מק״ט" value={productDialog.data.sku || ''} onChange={e => setProductDialog(prev => ({ ...prev, data: { ...prev.data, sku: e.target.value } }))} fullWidth />
            <TextField label="קטגוריה" value={productDialog.data.category || ''} onChange={e => setProductDialog(prev => ({ ...prev, data: { ...prev.data, category: e.target.value } }))} fullWidth />
            <TextField label="שם המוצר" value={productDialog.data.name || ''} onChange={e => setProductDialog(prev => ({ ...prev, data: { ...prev.data, name: e.target.value } }))} fullWidth required />
            <TextField label="מחיר לפני מע״מ" type="number" value={productDialog.data.price_before_vat || ''} onChange={e => setProductDialog(prev => ({ ...prev, data: { ...prev.data, price_before_vat: parseFloat(e.target.value) || 0 } }))} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProductDialog({ open: false, supplierId: null, data: {} })}>ביטול</Button>
          <Button variant="contained" onClick={handleSaveProduct}>הוסף</Button>
        </DialogActions>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialog.open} onClose={() => setImportDialog({ open: false, supplierId: null, text: '' })} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>ייבוא מוצרים</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
            הדבק נתונים בפורמט: מק״ט, קטגוריה, שם מוצר, מחיר (לפני מע״מ)
            <br />שורה לכל מוצר. מופרד בטאב או פסיק.
          </Alert>
          <TextField
            fullWidth multiline rows={10} placeholder="מק״ט, קטגוריה, שם, מחיר..."
            value={importDialog.text}
            onChange={e => setImportDialog(prev => ({ ...prev, text: e.target.value }))}
            inputProps={{ dir: 'rtl', style: { fontFamily: 'monospace' } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportDialog({ open: false, supplierId: null, text: '' })}>ביטול</Button>
          <Button variant="contained" onClick={handleImport}>ייבא</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, type: '', id: null })}
        onConfirm={handleDelete}
        title="אישור מחיקה"
        message={confirm.type === 'supplier' ? 'למחוק את הספק?' : 'למחוק את המוצר?'}
      />
    </Box>
  );
}
