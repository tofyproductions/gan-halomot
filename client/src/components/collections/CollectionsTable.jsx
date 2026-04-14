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
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAcademicYear } from '../../hooks/useAcademicYear';
import YearSelector from '../shared/YearSelector';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';

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
    receipt: '', expected: 0, childName: '',
    duplicates: null, saving: false,
  });

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get(`/collections?year=${selectedYear}`)
      .then((res) => setRawData(res.data.collections || {}))
      .catch(() => toast.error('שגיאה בטעינת נתוני גבייה'))
      .finally(() => setLoading(false));
  }, [selectedYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

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
    allRows.forEach(r => {
      (r.months || []).forEach(m => {
        expected += m.expected_amount || 0;
        collected += m.paid_amount || 0;
      });
    });
    const pct = expected > 0 ? Math.round((collected / expected) * 100) : 0;
    return { expected, collected, pct };
  }, [allRows]);

  // Open receipt dialog
  const handleCellClick = (regId, monthNum, receipt, expected, childName, notes) => {
    setDialog({
      open: true, regId, monthNum,
      receipt: receipt || '', expected, childName,
      duplicates: null, saving: false, notes: notes || null,
    });
  };

  // Save receipt (with duplicate handling)
  const handleSaveReceipt = async (force = false) => {
    const { regId, monthNum, receipt } = dialog;
    const receipt_number = receipt.trim() || null;

    setDialog(prev => ({ ...prev, saving: true }));

    try {
      await api.put(`/collections/${regId}/month/${monthNum}`, {
        receipt_number,
        payment_status: receipt_number ? 'paid' : 'expected',
        force,
      });
      setDialog({ open: false, regId: null, monthNum: null, receipt: '', expected: 0, childName: '', duplicates: null, saving: false });
      fetchData();
      if (receipt_number) toast.success('מספר קבלה נשמר');
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.error === 'duplicate_receipt') {
        // Show duplicate warning
        setDialog(prev => ({
          ...prev,
          saving: false,
          duplicates: err.response.data.duplicates,
        }));
      } else {
        toast.error('שגיאה בשמירת קבלה');
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
        payment_status: 'expected',
      });
      setDialog({ open: false, regId: null, monthNum: null, receipt: '', expected: 0, childName: '', duplicates: null, saving: false });
      fetchData();
    } catch {
      toast.error('שגיאה במחיקת קבלה');
    }
  };

  // Close dialog
  const closeDialog = () => {
    setDialog({ open: false, regId: null, monthNum: null, receipt: '', expected: 0, childName: '', duplicates: null, saving: false });
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

  // Monthly totals
  const monthlyTotals = useMemo(() => {
    const totals = {};
    ACADEMIC_MONTHS.forEach(m => { totals[m] = 0; });
    allRows.forEach(r => {
      (r.months || []).forEach(m => {
        totals[m.month] = (totals[m.month] || 0) + (m.paid_amount || 0);
      });
    });
    return totals;
  }, [allRows]);

  const handlePrint = () => window.print();

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl">
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב גבייה</Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <YearSelector value={selectedYear} onChange={setSelectedYear} />
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={handlePrint} size="small">
            הדפסה
          </Button>
        </Stack>
      </Stack>

      {/* KPI Cards */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">צפי שנתי</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>{formatCurrency(kpi.expected)}</Typography>
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
                onExitMonth={handleExitMonth}
                getCellSx={getCellSx}
              />
            ))}

            {/* Footer Totals */}
            <TableRow sx={{ bgcolor: '#f8fafc' }}>
              <TableCell sx={{ fontWeight: 800, position: 'sticky', right: 0, bgcolor: '#f8fafc', zIndex: 2 }}>
                סה״כ
              </TableCell>
              {ACADEMIC_MONTHS.map((m, i) => (
                <TableCell key={i} align="center" sx={{ fontWeight: 700 }}>
                  {formatCurrency(monthlyTotals[m] || 0)}
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

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
            value={dialog.receipt}
            onChange={(e) => setDialog(prev => ({ ...prev, receipt: e.target.value, duplicates: null }))}
            placeholder="הכנס מספר קבלה..."
            sx={{ mt: 1 }}
            inputProps={{ dir: 'ltr' }}
            disabled={dialog.saving}
          />

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
          {dialog.receipt && !dialog.duplicates && (
            <Button color="error" onClick={handleRemoveReceipt} sx={{ ml: 'auto' }}>
              הסר קבלה
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
    </Box>
  );
}

/* Grouped rows for a classroom */
function GroupRows({ classroom, rows, onCellClick, onExitMonth, getCellSx }) {
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
        <TableCell colSpan={14} sx={{ bgcolor: '#eef2ff', fontWeight: 800, fontSize: '0.95rem', position: 'sticky', right: 0 }}>
          <Chip label={`${classroom} (${rows.length})`} size="small" sx={{ fontWeight: 700 }} />
        </TableCell>
      </TableRow>

      {rows.map((row) => {
        const regId = row.registration_id;
        const monthsMap = {};
        (row.months || []).forEach(m => { monthsMap[m.month] = m; });

        return (
          <TableRow key={regId} hover>
            <TableCell sx={{ fontWeight: 600, position: 'sticky', right: 0, bgcolor: 'background.paper', zIndex: 1 }}>
              {row.child_name}
            </TableCell>
            {ACADEMIC_MONTHS.map((monthNum, mi) => {
              const m = monthsMap[monthNum] || {};
              const paid = m.paid_amount || 0;
              const expected = m.expected_amount || 0;
              const isBeforeStart = m.is_before_start || false;
              const receipt = m.receipt_number || '';
              const isDupOverride = m.notes === 'duplicate_override';
              const cellSx = getCellSx(paid, expected, isBeforeStart);

              return (
                <TableCell
                  key={mi}
                  align="center"
                  sx={{
                    p: 0.5,
                    cursor: !isBeforeStart && expected > 0 ? 'pointer' : 'default',
                    ...cellSx,
                    fontSize: '0.85rem',
                    fontWeight: receipt ? 600 : 400,
                    position: 'relative',
                  }}
                  onClick={() => {
                    if (!isBeforeStart && expected > 0) {
                      onCellClick(regId, monthNum, receipt, expected, row.child_name, m.notes);
                    }
                  }}
                >
                  {receipt || (expected > 0 ? formatCurrency(expected) : '')}
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
