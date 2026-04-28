import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, LinearProgress, MenuItem, InputAdornment, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import PrintIcon from '@mui/icons-material/Print';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DiscountIcon from '@mui/icons-material/LocalOffer';
import DeleteIcon from '@mui/icons-material/Delete';
import Tooltip from '@mui/material/Tooltip';
import EditIcon from '@mui/icons-material/Edit';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAcademicYear } from '../../hooks/useAcademicYear';
import YearSelector from '../shared/YearSelector';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';
import { getClassroomColor } from '../../utils/classroomColors';
import ChildDetailDialog from '../shared/ChildDetailDialog';

const MONTH_LABELS = [
  'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳', 'ינו׳', 'פבר׳',
  'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳',
];

const ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8];

const EXIT_MONTHS = [
  { value: '', label: 'ללא' },
  ...MONTH_LABELS.map((label, i) => ({ value: ACADEMIC_MONTHS[i], label })),
];

export default function CollectionsTable() {
  const { selectedYear, setSelectedYear } = useAcademicYear();
  const [rawData, setRawData] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Receipt dialog state
  const [dialog, setDialog] = useState({
    open: false, regId: null, monthNum: null,
    receipt: '', notes: '', expected: 0, childName: '',
    duplicates: null, saving: false,
    feeOverride: '', feeOverrideReason: '',
    hasFeeOverride: false, originalExpected: null,
  });

  // Registration fee dialog
  const [regFeeDialog, setRegFeeDialog] = useState({
    open: false, regId: null, receipt: '', childName: '', regFee: 0, saving: false,
  });

  // Discount dialog
  const [discountDialog, setDiscountDialog] = useState({ open: false });

  // Child detail dialog
  const [selectedChild, setSelectedChild] = useState(null);
  const [discounts, setDiscounts] = useState([]);
  const [newDiscount, setNewDiscount] = useState({
    scope: 'child', registration_id: '', classroom_id: '',
    discount_type: 'percentage', value: '', month: '', reason: '',
  });

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get(`/collections?year=${selectedYear}`)
      .then((res) => setRawData(res.data.collections || {}))
      .catch(() => toast.error('שגיאה בטעינת נתוני גבייה'))
      .finally(() => setLoading(false));
  }, [selectedYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchDiscounts = () => {
    api.get('/discounts').then(res => setDiscounts(res.data.discounts || [])).catch(() => {});
  };

  const handleAddDiscount = async () => {
    try {
      await api.post('/discounts', {
        ...newDiscount,
        branch_id: localStorage.getItem('selectedBranch'),
        month: newDiscount.month ? parseInt(newDiscount.month) : null,
        value: parseFloat(newDiscount.value),
        registration_id: newDiscount.registration_id || null,
        classroom_id: newDiscount.classroom_id || null,
      });
      toast.success('הנחה נוספה');
      setNewDiscount({ scope: 'child', registration_id: '', classroom_id: '', discount_type: 'percentage', value: '', month: '', reason: '' });
      fetchDiscounts();
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleDeleteDiscount = async (id) => {
    try {
      await api.delete(`/discounts/${id}`);
      toast.success('הנחה הוסרה');
      fetchDiscounts();
      fetchData();
    } catch { toast.error('שגיאה'); }
  };

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = [];
    for (const [classroom, rows] of Object.entries(rawData)) {
      const filtered = q
        ? rows.filter(r => r.child_name?.toLowerCase().includes(q))
        : rows;
      if (filtered.length > 0) result.push([classroom, filtered]);
    }
    return result;
  }, [rawData, search]);

  const allRows = useMemo(() => grouped.flatMap(([, rows]) => rows), [grouped]);

  // KPI
  const kpi = useMemo(() => {
    let expected = 0;
    let collected = 0;
    let potential = 0;
    let totalRegFees = 0;
    allRows.forEach(r => {
      const fee = r.monthly_fee || 0;
      potential += fee * 12;
      totalRegFees += r.registration_fee || 0;
      (r.months || []).forEach(m => {
        expected += m.expected_amount || 0;
        collected += m.paid_amount || 0;
      });
    });
    potential += totalRegFees;
    expected += totalRegFees;
    const pct = expected > 0 ? Math.round((collected / expected) * 100) : 0;
    return { expected, collected, pct, potential };
  }, [allRows]);

  // Open receipt dialog
  const handleCellClick = (regId, monthNum, receipt, expected, childName, notes, monthData) => {
    setDialog({
      open: true, regId, monthNum,
      receipt: receipt || '', notes: notes || '',
      expected, childName,
      duplicates: null, saving: false,
      feeOverride: monthData?.has_fee_override ? String(monthData.expected_amount) : '',
      feeOverrideReason: monthData?.fee_override_reason || '',
      hasFeeOverride: monthData?.has_fee_override || false,
      originalExpected: monthData?.original_expected || null,
    });
  };

  // Save receipt (with duplicate handling)
  const handleSaveReceipt = async (force = false) => {
    const { regId, monthNum, receipt, notes, feeOverride, feeOverrideReason } = dialog;
    const receipt_number = receipt.trim() || null;
    const notesVal = (notes || '').trim() || null;
    const overrideVal = feeOverride !== '' ? parseFloat(feeOverride) : null;

    setDialog(prev => ({ ...prev, saving: true }));

    try {
      await api.put(`/collections/${regId}/month/${monthNum}`, {
        receipt_number,
        notes: notesVal,
        payment_status: (receipt_number || notesVal) ? 'paid' : 'expected',
        force,
        fee_override: overrideVal,
        fee_override_reason: overrideVal != null ? (feeOverrideReason || null) : null,
      });
      setDialog({ open: false, regId: null, monthNum: null, receipt: '', notes: '', expected: 0, childName: '', duplicates: null, saving: false, feeOverride: '', feeOverrideReason: '', hasFeeOverride: false, originalExpected: null });
      fetchData();
      if (receipt_number || notesVal) toast.success('נשמר בהצלחה');
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.error === 'duplicate_receipt') {
        setDialog(prev => ({
          ...prev,
          saving: false,
          duplicates: err.response.data.duplicates,
        }));
      } else {
        toast.error('שגיאה בשמירה');
        setDialog(prev => ({ ...prev, saving: false }));
      }
    }
  };

  // Remove receipt
  const handleRemoveReceipt = async () => {
    const { regId, monthNum } = dialog;
    try {
      await api.put(`/collections/${regId}/month/${monthNum}`, {
        receipt_number: null,
        notes: null,
        payment_status: 'expected',
      });
      setDialog({ open: false, regId: null, monthNum: null, receipt: '', notes: '', expected: 0, childName: '', duplicates: null, saving: false, feeOverride: '', feeOverrideReason: '', hasFeeOverride: false, originalExpected: null });
      fetchData();
    } catch {
      toast.error('שגיאה במחיקת קבלה');
    }
  };

  // Close dialog
  const closeDialog = () => {
    setDialog({ open: false, regId: null, monthNum: null, receipt: '', notes: '', expected: 0, childName: '', duplicates: null, saving: false, feeOverride: '', feeOverrideReason: '', hasFeeOverride: false, originalExpected: null });
  };

  // Open reg-fee dialog
  const handleRegFeeClick = (regId, currentReceipt, childName, regFee) => {
    if (!regFee) return;
    const editable = currentReceipt && !String(currentReceipt).startsWith('-') ? currentReceipt : '';
    setRegFeeDialog({ open: true, regId, receipt: editable, childName, regFee, saving: false });
  };

  const closeRegFeeDialog = () => {
    setRegFeeDialog({ open: false, regId: null, receipt: '', childName: '', regFee: 0, saving: false });
  };

  const handleSaveRegFee = async () => {
    const { regId, receipt } = regFeeDialog;
    setRegFeeDialog(prev => ({ ...prev, saving: true }));
    try {
      await api.put(`/collections/${regId}/registration-fee`, {
        receipt_number: receipt.trim() || null,
        year: selectedYear,
      });
      closeRegFeeDialog();
      fetchData();
      toast.success('נשמר בהצלחה');
    } catch {
      toast.error('שגיאה בשמירה');
      setRegFeeDialog(prev => ({ ...prev, saving: false }));
    }
  };

  // Save exit month
  const handleExitMonth = async (regId, value) => {
    const exit_month = value === '' ? null : parseInt(value, 10);
    try {
      await api.put(`/collections/${regId}/exit-month`, { exit_month });
      fetchData();
    } catch {
      toast.error('שגיאה בעדכון חודש יציאה');
    }
  };

  // Cell color
  const getCellSx = (paid, expected, isBeforeStart) => {
    if (isBeforeStart) return { bgcolor: '#f1f5f9', color: '#94a3b8' };
    if (paid >= expected && expected > 0) return { bgcolor: '#d1fae5', color: '#065f46' };
    if (paid > 0 && paid < expected) return { bgcolor: '#fef3c7', color: '#92400e' };
    if (paid === 0 && expected > 0) return { bgcolor: '#fee2e2', color: '#991b1b' };
    return {};
  };

  // Monthly totals (collected + expected + percentage)
  const monthlySummary = useMemo(() => {
    const summary = {};
    ACADEMIC_MONTHS.forEach(m => { summary[m] = { collected: 0, expected: 0 }; });
    allRows.forEach(r => {
      (r.months || []).forEach(m => {
        summary[m.month].collected += (m.paid_amount || 0);
        summary[m.month].expected += (m.expected_amount || 0);
      });
    });
    ACADEMIC_MONTHS.forEach(m => {
      summary[m].pct = summary[m].expected > 0
        ? Math.round((summary[m].collected / summary[m].expected) * 100)
        : 0;
    });
    return summary;
  }, [allRows]);

  const monthlyTotals = useMemo(() => {
    const totals = {};
    ACADEMIC_MONTHS.forEach(m => { totals[m] = monthlySummary[m].collected; });
    return totals;
  }, [monthlySummary]);

  const handlePrint = () => window.print();

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl">
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב גבייה</Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <YearSelector value={selectedYear} onChange={setSelectedYear} />
          <Button variant="outlined" color="secondary" startIcon={<DiscountIcon />}
            onClick={() => { setDiscountDialog({ open: true }); fetchDiscounts(); }} size="small"
          >
            הנחות
          </Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={handlePrint} size="small">
            הדפסה
          </Button>
        </Stack>
      </Stack>

      {/* KPI Cards */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">פוטנציאל שנתי</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{formatCurrency(kpi.potential)}</Typography>
            <Typography variant="caption" color="text.secondary">לפי חוזים חתומים</Typography>
          </CardContent>
        </Card>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">צפי ריאלי</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{formatCurrency(kpi.expected)}</Typography>
            <Typography variant="caption" color="text.secondary">כולל חישוב יחסי</Typography>
          </CardContent>
        </Card>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">נגבה בפועל</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>{formatCurrency(kpi.collected)}</Typography>
          </CardContent>
        </Card>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">אחוז גבייה</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{kpi.pct}%</Typography>
            <LinearProgress
              variant="determinate"
              value={kpi.pct}
              sx={{
                mt: 1, height: 8, borderRadius: 4, bgcolor: '#e2e8f0',
                '& .MuiLinearProgress-bar': {
                  bgcolor: kpi.pct >= 80 ? 'success.main' : kpi.pct >= 50 ? 'warning.main' : 'error.main',
                  borderRadius: 4,
                },
              }}
            />
          </CardContent>
        </Card>
      </Stack>

      {/* Search */}
      <TextField
        placeholder="חיפוש לפי שם ילד..."
        size="small"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ mb: 2, width: 300 }}
        InputProps={{
          startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
        }}
      />

      {/* Table */}
      <TableContainer
        component={Paper}
        sx={{
          borderRadius: 3,
          maxHeight: 'calc(100vh - 380px)',
          overflow: 'auto',
          '@media print': { maxHeight: 'none', overflow: 'visible' },
        }}
      >
        <Table stickyHeader size="small" sx={{ minWidth: 1400 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 800, position: 'sticky', right: 0, zIndex: 3, bgcolor: 'background.paper', minWidth: 140 }}>
                שם הילד/ה
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, minWidth: 75, bgcolor: '#fef9c3' }}>דמי רישום</TableCell>
              {MONTH_LABELS.map((m) => (
                <TableCell key={m} align="center" sx={{ fontWeight: 700, minWidth: 90 }}>{m}</TableCell>
              ))}
              <TableCell sx={{ fontWeight: 700, minWidth: 100 }}>חודש יציאה</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {grouped.map(([classroom, rows]) => (
              <GroupRows
                key={classroom}
                classroom={classroom}
                rows={rows}
                onCellClick={handleCellClick}
                onRegFeeClick={handleRegFeeClick}
                onExitMonth={handleExitMonth}
                getCellSx={getCellSx}
                onChildClick={(childId) => setSelectedChild(childId)}
              />
            ))}

            {/* Monthly Summary */}
            <TableRow sx={{ bgcolor: '#f0fdf4' }}>
              <TableCell sx={{ fontWeight: 800, position: 'sticky', right: 0, bgcolor: '#f0fdf4', zIndex: 2, fontSize: '0.8rem' }}>
                נגבה בפועל
              </TableCell>
              <TableCell />
              {ACADEMIC_MONTHS.map((m, i) => (
                <TableCell key={i} align="center" sx={{ fontWeight: 700, fontSize: '0.8rem', color: 'success.main' }}>
                  {formatCurrency(monthlySummary[m].collected)}
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
            <TableRow sx={{ bgcolor: '#eff6ff' }}>
              <TableCell sx={{ fontWeight: 800, position: 'sticky', right: 0, bgcolor: '#eff6ff', zIndex: 2, fontSize: '0.8rem' }}>
                צפוי
              </TableCell>
              <TableCell />
              {ACADEMIC_MONTHS.map((m, i) => (
                <TableCell key={i} align="center" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                  {formatCurrency(monthlySummary[m].expected)}
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
            <TableRow sx={{ bgcolor: '#fefce8' }}>
              <TableCell sx={{ fontWeight: 800, position: 'sticky', right: 0, bgcolor: '#fefce8', zIndex: 2, fontSize: '0.85rem' }}>
                אחוז גבייה
              </TableCell>
              <TableCell />
              {ACADEMIC_MONTHS.map((m, i) => {
                const pct = monthlySummary[m].pct;
                return (
                  <TableCell key={i} align="center" sx={{
                    fontWeight: 800, fontSize: '0.85rem',
                    color: pct >= 100 ? '#16a34a' : pct >= 80 ? '#ca8a04' : pct > 0 ? '#dc2626' : '#94a3b8',
                  }}>
                    {monthlySummary[m].expected > 0 ? `${pct}%` : ''}
                  </TableCell>
                );
              })}
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

      {/* Discount Dialog */}
      <Dialog open={discountDialog.open} onClose={() => setDiscountDialog({ open: false })} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>ניהול הנחות</DialogTitle>
        <DialogContent>
          {/* Existing discounts */}
          {discounts.length > 0 && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הנחות פעילות:</Typography>
              {discounts.map(d => (
                <Chip key={d._id || d.id} sx={{ m: 0.5 }} onDelete={() => handleDeleteDiscount(d._id || d.id)}
                  label={`${d.scope === 'child' ? d.child_name : d.scope === 'classroom' ? d.classroom_name : 'כל הגן'}: ${d.discount_type === 'percentage' ? d.value + '%' : '₪' + d.value}${d.month ? ' (חודש ' + d.month + ')' : ' (כל השנה)'}${d.reason ? ' - ' + d.reason : ''}`}
                />
              ))}
            </Box>
          )}

          {/* Add new */}
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>הוסף הנחה:</Typography>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2}>
              <TextField select size="small" label="סוג" value={newDiscount.scope}
                onChange={e => setNewDiscount(p => ({ ...p, scope: e.target.value, registration_id: '', classroom_id: '' }))}
                sx={{ minWidth: 130 }}
              >
                <MenuItem value="child">ילד ספציפי</MenuItem>
                <MenuItem value="classroom">כיתה</MenuItem>
                <MenuItem value="branch">כל הגן</MenuItem>
              </TextField>

              {newDiscount.scope === 'child' && (
                <TextField select size="small" label="בחר ילד" value={newDiscount.registration_id}
                  onChange={e => setNewDiscount(p => ({ ...p, registration_id: e.target.value }))}
                  sx={{ minWidth: 200 }}
                >
                  {allRows.map(r => (
                    <MenuItem key={r.registration_id} value={r.registration_id}>{r.child_name}</MenuItem>
                  ))}
                </TextField>
              )}

              {newDiscount.scope === 'classroom' && (
                <TextField select size="small" label="בחר כיתה" value={newDiscount.classroom_id}
                  onChange={e => setNewDiscount(p => ({ ...p, classroom_id: e.target.value }))}
                  sx={{ minWidth: 200 }}
                >
                  {grouped.map(([cls]) => (
                    <MenuItem key={cls} value={cls}>{cls}</MenuItem>
                  ))}
                </TextField>
              )}
            </Stack>

            <Stack direction="row" spacing={2}>
              <TextField select size="small" label="סוג הנחה" value={newDiscount.discount_type}
                onChange={e => setNewDiscount(p => ({ ...p, discount_type: e.target.value }))}
                sx={{ minWidth: 130 }}
              >
                <MenuItem value="percentage">אחוזים (%)</MenuItem>
                <MenuItem value="fixed">סכום קבוע (₪)</MenuItem>
              </TextField>

              <TextField size="small" label={newDiscount.discount_type === 'percentage' ? 'אחוז הנחה' : 'סכום הנחה'}
                type="number" value={newDiscount.value}
                onChange={e => setNewDiscount(p => ({ ...p, value: e.target.value }))}
                InputProps={{ endAdornment: <InputAdornment position="end">{newDiscount.discount_type === 'percentage' ? '%' : '₪'}</InputAdornment> }}
                sx={{ width: 150 }}
              />

              <TextField select size="small" label="חודש" value={newDiscount.month}
                onChange={e => setNewDiscount(p => ({ ...p, month: e.target.value }))}
                sx={{ minWidth: 130 }}
              >
                <MenuItem value="">כל השנה</MenuItem>
                {MONTH_LABELS.map((m, i) => (
                  <MenuItem key={i} value={ACADEMIC_MONTHS[i]}>{m}</MenuItem>
                ))}
              </TextField>

              <TextField size="small" label="סיבה" value={newDiscount.reason}
                onChange={e => setNewDiscount(p => ({ ...p, reason: e.target.value }))}
                sx={{ flex: 1 }}
              />
            </Stack>

            <Button variant="contained" onClick={handleAddDiscount} disabled={!newDiscount.value}>
              הוסף הנחה
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscountDialog({ open: false })}>סגור</Button>
        </DialogActions>
      </Dialog>

      {/* Receipt Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.childName && (
            <Typography variant="body2" color="text.secondary">{dialog.childName}</Typography>
          )}
          מספר קבלה
          <Typography variant="body2" color="text.secondary">
            סכום צפוי: {formatCurrency(dialog.expected)}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="מספר קבלה"
            helperText="ניתן להזין מספר קבלות (מופרד ברווח, פסיק או /). למשל: 2584 / 2515"
            value={dialog.receipt}
            onChange={(e) => setDialog(prev => ({ ...prev, receipt: e.target.value, duplicates: null }))}
            placeholder="הכנס מספר קבלה..."
            sx={{ mt: 1 }}
            inputProps={{ dir: 'ltr' }}
            disabled={dialog.saving}
          />

          <TextField
            fullWidth
            label="הערות"
            helperText="למשל: חסר שיק, חלקי, חסרה וכו׳"
            value={dialog.notes}
            onChange={(e) => setDialog(prev => ({ ...prev, notes: e.target.value }))}
            placeholder="הוסף הערה..."
            sx={{ mt: 2 }}
            multiline
            minRows={2}
            disabled={dialog.saving}
          />

          {/* Fee Override Section */}
          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid #e2e8f0' }}>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 700, color: '#7c3aed', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <EditIcon fontSize="small" />
              דריסת סכום צפוי
            </Typography>
            {dialog.hasFeeOverride && dialog.originalExpected != null && (
              <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                סכום מקורי (לפני דריסה): {formatCurrency(dialog.originalExpected)}
              </Typography>
            )}
            <Stack direction="row" spacing={1.5}>
              <TextField
                type="number"
                label="סכום חדש"
                value={dialog.feeOverride}
                onChange={(e) => setDialog(prev => ({ ...prev, feeOverride: e.target.value }))}
                placeholder={String(dialog.expected)}
                size="small"
                sx={{ width: 140 }}
                inputProps={{ dir: 'ltr', min: 0 }}
                disabled={dialog.saving}
              />
              <TextField
                label="סיבה"
                value={dialog.feeOverrideReason}
                onChange={(e) => setDialog(prev => ({ ...prev, feeOverrideReason: e.target.value }))}
                placeholder="הנחה אישית..."
                size="small"
                sx={{ flex: 1 }}
                disabled={dialog.saving}
              />
              {dialog.feeOverride !== '' && (
                <Button
                  size="small"
                  color="error"
                  onClick={() => setDialog(prev => ({ ...prev, feeOverride: '', feeOverrideReason: '', hasFeeOverride: false }))}
                >
                  הסר דריסה
                </Button>
              )}
            </Stack>
          </Box>

          {/* Duplicate warning */}
          {dialog.duplicates && dialog.duplicates.length > 0 && (
            <Alert
              severity="warning"
              icon={<WarningAmberIcon />}
              sx={{ mt: 2, borderRadius: 2 }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>
                מספר קבלה {dialog.receipt} כבר קיים:
              </Typography>
              {dialog.duplicates.map((dup, i) => (
                <Typography key={i} variant="body2" sx={{ mr: 1 }}>
                  • {dup.child_name} ({dup.parent_name}) - {dup.month_name}
                  {dup.same_parent && ' (אותו הורה)'}
                </Typography>
              ))}
              <Button
                variant="outlined"
                color="warning"
                size="small"
                sx={{ mt: 1.5 }}
                onClick={() => handleSaveReceipt(true)}
                disabled={dialog.saving}
              >
                כן, אני בטוח - שמור בכל זאת
              </Button>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          {(dialog.receipt || dialog.notes) && !dialog.duplicates && (
            <Button color="error" onClick={handleRemoveReceipt} sx={{ ml: 'auto' }}>
              נקה תא
            </Button>
          )}
          <Button onClick={closeDialog}>ביטול</Button>
          {!dialog.duplicates && (
            <Button variant="contained" onClick={() => handleSaveReceipt(false)} disabled={dialog.saving}>
              שמור
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Registration Fee Dialog */}
      <Dialog open={regFeeDialog.open} onClose={closeRegFeeDialog} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {regFeeDialog.childName && (
            <Typography variant="body2" color="text.secondary">{regFeeDialog.childName}</Typography>
          )}
          דמי רישום — מספר קבלה
          <Typography variant="body2" color="text.secondary">
            סכום: {formatCurrency(regFeeDialog.regFee)}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="מספר קבלה"
            value={regFeeDialog.receipt}
            onChange={(e) => setRegFeeDialog(prev => ({ ...prev, receipt: e.target.value }))}
            placeholder="הכנס מספר קבלה..."
            sx={{ mt: 1 }}
            inputProps={{ dir: 'ltr' }}
            disabled={regFeeDialog.saving}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRegFee(); }}
          />
        </DialogContent>
        <DialogActions>
          {regFeeDialog.receipt && (
            <Button
              color="error"
              onClick={() => setRegFeeDialog(prev => ({ ...prev, receipt: '' }))}
              sx={{ ml: 'auto' }}
            >
              נקה
            </Button>
          )}
          <Button onClick={closeRegFeeDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSaveRegFee} disabled={regFeeDialog.saving}>
            שמור
          </Button>
        </DialogActions>
      </Dialog>

      <ChildDetailDialog
        open={!!selectedChild}
        childId={selectedChild}
        onClose={() => setSelectedChild(null)}
        onChanged={fetchData}
      />
    </Box>
  );
}

/* Grouped rows for a classroom */
function GroupRows({ classroom, rows, onCellClick, onRegFeeClick, onExitMonth, getCellSx, onChildClick }) {
  const subtotals = {};
  ACADEMIC_MONTHS.forEach(m => { subtotals[m] = 0; });
  rows.forEach(r => {
    (r.months || []).forEach(m => {
      subtotals[m.month] = (subtotals[m.month] || 0) + (m.paid_amount || 0);
    });
  });

  return (
    <>
      {/* Classroom header */}
      <TableRow>
        <TableCell colSpan={15} sx={{ bgcolor: getClassroomColor(classroom).bg, fontWeight: 800, fontSize: '0.95rem', position: 'sticky', right: 0, borderRight: `4px solid ${getClassroomColor(classroom).primary}` }}>
          <Chip label={`${classroom} (${rows.length})`} size="small" sx={{ fontWeight: 700, bgcolor: getClassroomColor(classroom).primary, color: '#fff' }} />
        </TableCell>
      </TableRow>

      {rows.map((row) => {
        const regId = row.registration_id;
        const cc = getClassroomColor(classroom);
        const monthsMap = {};
        (row.months || []).forEach(m => { monthsMap[m.month] = m; });

        return (
          <TableRow key={regId} hover sx={{ '& td:first-of-type': { borderRight: `3px solid ${cc.border}` } }}>
            <TableCell
              sx={{
                fontWeight: 600, position: 'sticky', right: 0, zIndex: 1,
                bgcolor: cc.bg, cursor: 'pointer',
                '&:hover': { bgcolor: cc.border },
              }}
              onClick={() => row.child_id && onChildClick?.(row.child_id)}
            >
              {row.child_name}
            </TableCell>
            <TableCell align="center" sx={{
              bgcolor: row.registration_fee_receipt ? '#d1fae5' : (row.registration_fee > 0 ? '#fee2e2' : '#f8fafc'),
              fontWeight: 600, fontSize: '0.8rem',
              cursor: row.registration_fee > 0 ? 'pointer' : 'default',
              '&:hover': row.registration_fee > 0 ? { filter: 'brightness(0.95)' } : undefined,
            }}
            onClick={() => row.registration_fee > 0 && onRegFeeClick(regId, row.registration_fee_receipt, row.child_name, row.registration_fee)}
            >
              {row.registration_fee_receipt || (row.registration_fee > 0 ? formatCurrency(row.registration_fee) : '')}
            </TableCell>
            {ACADEMIC_MONTHS.map((monthNum, mi) => {
              const m = monthsMap[monthNum] || {};
              const paid = m.paid_amount || 0;
              const expected = m.expected_amount || 0;
              const isBeforeStart = m.is_before_start || false;
              const receipt = m.receipt_number || '';
              const notes = m.notes || '';
              const isDupOverride = m.is_duplicate_override === true;
              const cellSx = getCellSx(paid, expected, isBeforeStart);
              const hasContent = !!(receipt || notes);

              return (
                <TableCell
                  key={mi}
                  align="center"
                  sx={{
                    p: 0.5,
                    cursor: !isBeforeStart && expected > 0 ? 'pointer' : 'default',
                    ...cellSx,
                    fontSize: '0.85rem',
                    fontWeight: hasContent ? 600 : 400,
                    position: 'relative',
                  }}
                  onClick={() => {
                    if (!isBeforeStart && expected > 0) {
                      onCellClick(regId, monthNum, receipt, expected, row.child_name, notes, m);
                    }
                  }}
                >
                  {hasContent ? (
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
                      {receipt && <span>{receipt}</span>}
                      {notes && (
                        <span style={{ fontSize: '0.7rem', fontWeight: 500, opacity: 0.85 }}>{notes}</span>
                      )}
                    </Box>
                  ) : (expected > 0 ? formatCurrency(expected) : '')}
                  {isDupOverride && (
                    <Box
                      component="span"
                      sx={{
                        position: 'absolute',
                        top: 2,
                        left: 4,
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        bgcolor: '#f59e0b',
                      }}
                    />
                  )}
                  {m.has_fee_override && (
                    <Tooltip title={`דריסה: ${m.fee_override_reason || 'ללא סיבה'}${m.original_expected != null ? ` (מקורי: ${m.original_expected}₪)` : ''}`} arrow>
                      <Box
                        component="span"
                        sx={{
                          position: 'absolute',
                          top: 2,
                          right: 4,
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          bgcolor: '#8b5cf6',
                        }}
                      />
                    </Tooltip>
                  )}
                </TableCell>
              );
            })}
            <TableCell>
              <TextField
                select
                size="small"
                value={row.exit_month != null ? row.exit_month : ''}
                onChange={(e) => onExitMonth(regId, e.target.value)}
                variant="standard"
                sx={{ minWidth: 80 }}
              >
                {EXIT_MONTHS.map((opt) => (
                  <MenuItem key={String(opt.value)} value={opt.value}>{opt.label}</MenuItem>
                ))}
              </TextField>
            </TableCell>
          </TableRow>
        );
      })}

      {/* Subtotals row */}
      <TableRow sx={{ bgcolor: '#f8fafc' }}>
        <TableCell sx={{ fontWeight: 700, fontSize: '0.8rem', position: 'sticky', right: 0, bgcolor: '#f8fafc', zIndex: 1 }}>
          סה״כ {classroom}
        </TableCell>
        <TableCell />
        {ACADEMIC_MONTHS.map((m, i) => (
          <TableCell key={i} align="center" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
            {(subtotals[m] || 0) > 0 ? formatCurrency(subtotals[m]) : ''}
          </TableCell>
        ))}
        <TableCell />
      </TableRow>
    </>
  );
}
