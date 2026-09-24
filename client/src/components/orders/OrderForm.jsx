import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  MenuItem, Table, TableBody, TableCell, TableHead, TableRow,
  InputAdornment, IconButton, Alert, Divider, Chip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import SearchIcon from '@mui/icons-material/Search';
import SendIcon from '@mui/icons-material/Send';
import SaveIcon from '@mui/icons-material/Save';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ProductThumb from './ProductThumb';
import OrderGroupPanel from './OrderGroupPanel';
import { useBranch } from '../../hooks/useBranch';
import { formatCurrency, formatCurrencyExact } from '../../utils/hebrewYear';

/**
 * "אצל דאלאס: 0.24 ₪ ל-מגבון (96.78 ₪ לקרטון 400) · זול ב-12%".
 * Green when the other supplier is cheaper per unit — that is the fact worth
 * knowing while the finger is on this row. Grey when it is dearer. Per pack
 * only, with a note, when a pack size is unknown.
 */
function OtherSupplierPrice({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <Box sx={{ mt: 0.25 }}>
      {rows.map((r, i) => {
        const cheaper = r.diff_pct !== null && r.diff_pct < 0;
        const pct = r.diff_pct === null ? null : Math.abs(r.diff_pct);
        const perPack = `${formatCurrencyExact(r.price_with_vat)} ל${r.unit || 'אריזה'}${r.pack_qty ? ` ${r.pack_qty}` : ''}`;
        const text = r.per_unit_price !== null
          ? `אצל ${r.supplier_name}: ${formatCurrencyExact(r.per_unit_price)} ל-${r.base_unit || 'יחידה'} (${perPack})${pct !== null && pct !== 0 ? ` · ${cheaper ? 'זול' : 'יקר'} ב-${pct}%` : ''}`
          : `אצל ${r.supplier_name}: ${perPack} · לפי אריזה`;
        return (
          <Typography key={i} variant="caption" sx={{ display: 'block', fontWeight: cheaper ? 700 : 400 }} color={cheaper ? 'success.main' : 'text.secondary'}>
            {text}
          </Typography>
        );
      })}
    </Box>
  );
}

export default function OrderForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: editId } = useParams();
  const isEdit = !!editId;
  const { selectedBranch } = useBranch();
  const prefill = location.state?.prefill;
  const prefillApplied = useRef(false);
  const editLoaded = useRef(false);

  const [suppliers, setSuppliers] = useState([]);
  const [selectedSupplier, setSelectedSupplier] = useState(prefill?.supplier_id || '');
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]); // [{ product, qty }]
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState(prefill?.source === 'stock-shortages' ? 'הזמנה אוטומטית מחוסרי מלאי' : '');
  const [saving, setSaving] = useState(false);
  const [editSourceItems, setEditSourceItems] = useState(null);
  const [editOrder, setEditOrder] = useState(null); // { status, group_id, group_invited_by, group_invited_from } of the order being edited
  const [groupInfo, setGroupInfo] = useState(null);
  const [matchMap, setMatchMap] = useState({});

  // Load suppliers
  useEffect(() => {
    api.get('/suppliers').then(res => setSuppliers(res.data.suppliers || [])).catch(() => {});
  }, []);

  // Edit mode: load the existing order, set its supplier, stash the items so
  // the products-loaded effect below can hydrate the cart.
  useEffect(() => {
    if (!isEdit || editLoaded.current) return;
    api.get(`/orders/${editId}`)
      .then(res => {
        const order = res.data.order;
        if (order.status !== 'pending' && order.status !== 'draft') {
          toast.error('ניתן לערוך רק הזמנות ממתינות');
          navigate(`/orders/${editId}`);
          return;
        }
        setSelectedSupplier(order.supplier_id?._id || order.supplier_id);
        setNotes(order.notes || '');
        setEditSourceItems(order.items || []);
        setEditOrder({
          status: order.status, group_id: order.group_id || null,
          group_invited_by: order.group_invited_by || '', group_invited_from: order.group_invited_from || '',
        });
        editLoaded.current = true;
      })
      .catch(() => toast.error('שגיאה בטעינת הזמנה'));
  }, [isEdit, editId, navigate]);

  // Load products when supplier changes
  useEffect(() => {
    if (!selectedSupplier) { setProducts([]); return; }
    api.get('/products', { params: { supplier: selectedSupplier } })
      .then(res => setProducts(res.data.products || []))
      .catch(() => toast.error('שגיאה בטעינת מוצרים'));
  }, [selectedSupplier]);

  // What the same product costs at the other supplier — confirmed matches only.
  useEffect(() => {
    if (!selectedSupplier) { setMatchMap({}); return; }
    let alive = true;
    api.get('/products/matches', { params: { supplier: selectedSupplier } })
      .then(res => { if (alive) setMatchMap(res.data.matches || {}); })
      .catch(() => { if (alive) setMatchMap({}); });
    return () => { alive = false; };
  }, [selectedSupplier]);

  // Apply prefill once products for the prefilled supplier load.
  useEffect(() => {
    if (!prefill || prefillApplied.current) return;
    if (!products.length) return;
    if (prefill.supplier_id !== selectedSupplier) return;
    const newCart = [];
    for (const it of (prefill.items || [])) {
      const product = products.find(p => (p._id || p.id) === it.product_id);
      if (product) newCart.push({ product, qty: it.qty });
    }
    if (newCart.length) {
      setCart(newCart);
      toast.info(`נטענו ${newCart.length} פריטים מחוסרי מלאי`);
    }
    prefillApplied.current = true;
  }, [products, prefill, selectedSupplier]);

  const supplierVatRate = suppliers.find(s => (s._id || s.id) === selectedSupplier)?.vat_rate || 1.18;

  // Edit mode: hydrate the cart from the source order items once the supplier's
  // products have loaded.
  useEffect(() => {
    if (!editSourceItems || !products.length) return;
    const newCart = [];
    for (const it of editSourceItems) {
      const pid = it.product_id?._id || it.product_id;
      const product = products.find(p => (p._id || p.id) === pid);
      if (product) {
        newCart.push({ product, qty: it.qty });
      } else {
        // Product no longer in catalog — fall back to a synthetic product so
        // the row still appears and the user can decide to remove it.
        newCart.push({
          product: {
            _id: pid || `legacy-${it.sku}`,
            name: it.name,
            sku: it.sku || '',
            price_with_vat: it.unit_price || 0,
            // The order line kept only the price with VAT; back it out at the
            // supplier's rate so the row reads like every other.
            price_before_vat: Number(((it.unit_price || 0) / (supplierVatRate || 1.18)).toFixed(2)),
          },
          qty: it.qty,
        });
      }
    }
    setCart(newCart);
    setEditSourceItems(null);
  }, [products, editSourceItems, supplierVatRate]);

  const supplier = suppliers.find(s => (s._id || s.id) === selectedSupplier);
  const minOrder = supplier?.min_order_amount || 0;

  // Filter products by search
  const filtered = useMemo(() => {
    if (!search.trim()) return products;
    const q = search.trim().toLowerCase();
    return products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q) ||
      p.sku?.toLowerCase().includes(q)
    );
  }, [products, search]);

  // Group by category
  const categories = useMemo(() => {
    const cats = {};
    filtered.forEach(p => {
      const cat = p.category || 'כללי';
      if (!cats[cat]) cats[cat] = [];
      cats[cat].push(p);
    });
    return Object.entries(cats);
  }, [filtered]);

  const addToCart = (product) => {
    const existing = cart.find(c => (c.product._id || c.product.id) === (product._id || product.id));
    if (existing) {
      setCart(cart.map(c =>
        (c.product._id || c.product.id) === (product._id || product.id)
          ? { ...c, qty: c.qty + 1 }
          : c
      ));
    } else {
      setCart([...cart, { product, qty: 1 }]);
    }
  };

  const updateQty = (productId, qty) => {
    if (qty <= 0) {
      setCart(cart.filter(c => (c.product._id || c.product.id) !== productId));
    } else {
      setCart(cart.map(c =>
        (c.product._id || c.product.id) === productId ? { ...c, qty } : c
      ));
    }
  };

  const removeFromCart = (productId) => {
    setCart(cart.filter(c => (c.product._id || c.product.id) !== productId));
  };

  const total = cart.reduce((sum, c) => sum + c.qty * c.product.price_with_vat, 0);
  const totalBeforeVat = cart.reduce((sum, c) => sum + c.qty * (c.product.price_before_vat || 0), 0);

  /**
   * mode: 'hold'  — new order, saved as a draft, no email
   *       'send'  — send to the supplier (new: create+send; draft: save then send)
   *       'save'  — edit only (draft or pending)
   */
  const handleSubmit = async (mode) => {
    if (!selectedSupplier) return toast.error('בחר ספק');
    if (cart.length === 0) return toast.error('הוסף מוצרים להזמנה');

    const isGroup = Boolean(editOrder?.group_id);
    const effectiveTotal = isGroup && groupInfo
      // Every OTHER order in the group, by id: for the office every member
      // is "mine", so filtering on is_mine would leave only this cart.
      ? (groupInfo.members || []).filter(m => String(m.id) !== String(editId) && m.status !== 'cancelled').reduce((s, m) => s + m.total_amount, 0) + total
      : total;
    if (mode === 'send' && minOrder > 0 && effectiveTotal < minOrder) {
      return toast.error(`מינימום הזמנה: ${formatCurrency(minOrder)}${isGroup ? ' (על הסכום המשותף)' : ''}`);
    }

    setSaving(true);
    try {
      const items = cart.map(c => ({
        product_id: c.product._id || c.product.id,
        sku: c.product.sku,
        name: c.product.name,
        qty: c.qty,
        unit_price: c.product.price_with_vat,
      }));

      if (isEdit) {
        await api.put(`/orders/${editId}`, { items, notes });
        if (mode === 'send') {
          try {
            const res = await api.post(`/orders/${editId}/send`);
            const n = res.data.sent_count || 1;
            toast.success(n > 1 ? `ההזמנה נשלחה לספק — ${n} סניפים` : 'ההזמנה נשלחה לספק');
          } catch (sendErr) {
            toast.error(`ההזמנה נשמרה אבל לא נשלחה: ${sendErr.response?.data?.error || 'שגיאה בשליחה'}`);
          }
        } else {
          toast.success('ההזמנה עודכנה');
        }
        navigate(`/orders/${editId}`);
      } else {
        const res = await api.post('/orders', {
          branch_id: selectedBranch,
          supplier_id: selectedSupplier,
          items,
          notes,
          hold: mode === 'hold',
        });
        if (mode === 'hold') {
          toast.success('ההזמנה נשמרה בהמתנה');
          navigate(`/orders/${res.data.order.id || res.data.order._id}`);
        } else {
          toast.success('ההזמנה נשלחה לספק');
          navigate('/orders');
        }
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 1000, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 3 }}>{isEdit ? 'עריכת הזמנה' : 'הזמנה חדשה'}</Typography>

      {/* Supplier Selection */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <TextField
            select fullWidth label="בחר ספק" value={selectedSupplier}
            disabled={isEdit}
            helperText={isEdit ? 'לא ניתן לשנות ספק בעריכה — בטל וצור הזמנה חדשה אם נדרש' : ''}
            onChange={e => { setSelectedSupplier(e.target.value); setCart([]); }}
          >
            {suppliers.map(s => (
              <MenuItem key={s._id || s.id} value={s._id || s.id}>
                {s.name} {s.contact_name ? `(${s.contact_name})` : ''}
              </MenuItem>
            ))}
          </TextField>
        </CardContent>
      </Card>

      {selectedSupplier && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
          {/* Product Catalog */}
          <Box sx={{ flex: 2 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>קטלוג מוצרים</Typography>
                <TextField
                  size="small" fullWidth placeholder="חיפוש מוצר..."
                  value={search} onChange={e => setSearch(e.target.value)}
                  sx={{ mb: 2 }}
                  InputProps={{
                    startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
                  }}
                />

                <Box sx={{ maxHeight: 500, overflow: 'auto' }}>
                  {categories.map(([cat, prods]) => (
                    <Box key={cat} sx={{ mb: 2 }}>
                      <Chip label={cat} size="small" sx={{ fontWeight: 700, mb: 1 }} />
                      {prods.map(p => {
                        const inCart = cart.find(c => (c.product._id || c.product.id) === (p._id || p.id));
                        return (
                          <Box
                            key={p._id || p.id}
                            sx={{
                              display: 'flex', alignItems: 'center', gap: 1.5,
                              p: 1, mb: 0.5, borderRadius: 2, bgcolor: inCart ? '#dcfce7' : '#f8fafc',
                              cursor: 'pointer', '&:hover': { bgcolor: inCart ? '#bbf7d0' : '#f1f5f9' },
                            }}
                            onClick={() => addToCart(p)}
                          >
                            <ProductThumb product={p} size={44} radius={1.5} />
                            <Box sx={{ flex: 1 }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.name}</Typography>
                              {/* The unit is not a detail next to the price — it IS the
                                  price. ₪70 buys a CARTON of item 60246 and ₪3.68 buys a
                                  single item 2101, and a row that shows only a number and
                                  a name cannot tell you which one you just added. */}
                              <Typography variant="caption" color="text.secondary">
                                {p.sku}{p.unit ? ` · ${p.unit}` : ''}
                              </Typography>
                              {p.standing_note && (
                                <Typography variant="caption" sx={{ display: 'block', color: '#b45309', fontWeight: 700 }}>
                                  ⚠️ {p.standing_note}
                                </Typography>
                              )}
                              <OtherSupplierPrice rows={matchMap[String(p._id || p.id)]} />
                            </Box>
                            <Box sx={{ textAlign: 'left' }}>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {formatCurrencyExact(p.price_with_vat)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'nowrap' }}>
                                {formatCurrencyExact(p.price_before_vat)} לפני מע״מ
                              </Typography>
                              {inCart && (
                                <Typography variant="caption" color="success.main" sx={{ fontWeight: 700 }}>
                                  x{inCart.qty}
                                </Typography>
                              )}
                            </Box>
                          </Box>
                        );
                      })}
                    </Box>
                  ))}
                  {products.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
                      אין מוצרים לספק זה
                    </Typography>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Box>

          {/* Cart */}
          <Box sx={{ flex: 1 }}>
            <Card sx={{ position: 'sticky', top: 80 }}>
              <CardContent>
                {isEdit && editOrder?.group_id && (
                  <OrderGroupPanel orderId={editId} onLoaded={setGroupInfo} />
                )}
                {isEdit && editOrder?.group_invited_by && editOrder?.status === 'draft' && (
                  <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
                    הוזמנת להצטרף על ידי {editOrder.group_invited_by}{editOrder.group_invited_from ? ` מסניף ${editOrder.group_invited_from}` : ''}. הוסיפו את הפריטים שלכם ושמרו.
                  </Alert>
                )}
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  סל הזמנה ({cart.length} פריטים)
                </Typography>

                {cart.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                    לחץ על מוצר להוספה
                  </Typography>
                ) : (
                  <>
                    {cart.map(c => (
                      <Box key={c.product._id || c.product.id} sx={{ mb: 1, p: 1, bgcolor: '#f8fafc', borderRadius: 2 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>{c.product.name}</Typography>
                          <IconButton size="small" color="error" onClick={() => removeFromCart(c.product._id || c.product.id)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                        {c.product.standing_note && (
                          <Typography variant="caption" sx={{ display: 'block', color: '#b45309', fontWeight: 700 }}>
                            ⚠️ {c.product.standing_note} — יצורף להזמנה אוטומטית
                          </Typography>
                        )}
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                          <TextField
                            size="small" type="number" value={c.qty}
                            onChange={e => updateQty(c.product._id || c.product.id, parseInt(e.target.value) || 0)}
                            inputProps={{ min: 0, style: { width: 50, textAlign: 'center', padding: '4px' } }}
                          />
                          <Typography variant="body2" color="text.secondary">x {formatCurrencyExact(c.product.price_with_vat)}</Typography>
                          <Typography variant="body2" sx={{ fontWeight: 700, ml: 'auto' }}>
                            = {formatCurrencyExact(c.qty * c.product.price_with_vat)}
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                          לפני מע״מ: {formatCurrencyExact(c.product.price_before_vat || 0)} ליחידה
                          {' · '}{formatCurrencyExact(c.qty * (c.product.price_before_vat || 0))} לשורה
                        </Typography>
                      </Box>
                    ))}

                    <Divider sx={{ my: 2 }} />

                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Typography sx={{ fontWeight: 800, fontSize: '1.1rem' }}>סה״כ כולל מע״מ</Typography>
                      <Typography sx={{ fontWeight: 800, fontSize: '1.1rem' }}>{formatCurrencyExact(total)}</Typography>
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                      <Typography variant="body2" color="text.secondary">לפני מע״מ</Typography>
                      <Typography variant="body2" color="text.secondary">{formatCurrencyExact(totalBeforeVat)}</Typography>
                    </Stack>

                    {minOrder > 0 && total < minOrder && !editOrder?.group_id && (
                      <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
                        מינימום הזמנה: {formatCurrency(minOrder)}
                      </Alert>
                    )}

                    <TextField
                      fullWidth size="small" label="הערות" multiline rows={2}
                      value={notes} onChange={e => setNotes(e.target.value)}
                      sx={{ mb: 2 }}
                    />

                    {(() => {
                      const isDraft = !isEdit || editOrder?.status === 'draft';
                      const isGroup = Boolean(editOrder?.group_id);
                      const memberCount = groupInfo?.members?.filter(m => m.status !== 'cancelled').length || 0;
                      const sendLabel = isGroup && memberCount > 1 ? `שלח לספק — כל הסניפים (${memberCount})` : 'שלח לספק';
                      const below = minOrder > 0 && total < minOrder && !isGroup;
                      return (
                        <Stack spacing={1}>
                          {isDraft && (
                            <Button
                              fullWidth variant="outlined" size="large"
                              startIcon={<SaveIcon />}
                              onClick={() => handleSubmit(isEdit ? 'save' : 'hold')}
                              disabled={saving}
                            >
                              {isEdit ? 'שמור' : 'שמור בהמתנה'}
                            </Button>
                          )}
                          {isDraft ? (
                            <Button
                              fullWidth variant="contained" size="large"
                              startIcon={<SendIcon />}
                              onClick={() => handleSubmit('send')}
                              disabled={saving || below}
                            >
                              {saving ? 'שולח...' : sendLabel}
                            </Button>
                          ) : (
                            <Button
                              fullWidth variant="contained" size="large"
                              startIcon={<SaveIcon />}
                              onClick={() => handleSubmit('save')}
                              disabled={saving}
                            >
                              {saving ? 'שומר...' : 'שמור שינויים'}
                            </Button>
                          )}
                        </Stack>
                      );
                    })()}
                  </>
                )}
              </CardContent>
            </Card>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
