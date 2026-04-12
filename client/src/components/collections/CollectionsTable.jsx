import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, LinearProgress, MenuItem, InputAdornment, Chip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import PrintIcon from '@mui/icons-material/Print';
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

const EXIT_MONTHS = [
  { value: '', label: 'ללא' },
  ...MONTH_LABELS.map((label, i) => ({ value: i, label })),
];

const CLASS_ORDER = ['תינוקייה א', 'תינוקייה ב', 'צעירים', 'בוגרים'];

export default function CollectionsTable() {
  const { selectedYear, setSelectedYear } = useAcademicYear();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get(`/collections?year=${selectedYear}`)
      .then((res) => setData(res.data))
      .catch(() => toast.error('שגיאה בטעינת נתוני גבייה'))
      .finally(() => setLoading(false));
  }, [selectedYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter((r) => r.childName?.toLowerCase().includes(q));
  }, [data, search]);

  // Group by classroom
  const grouped = useMemo(() => {
    const groups = {};
    CLASS_ORDER.forEach((c) => { groups[c] = []; });
    filtered.forEach((r) => {
      const cls = r.classroom || 'אחר';
      if (!groups[cls]) groups[cls] = [];
      groups[cls].push(r);
    });
    // Remove empty groups
    return Object.entries(groups).filter(([, rows]) => rows.length > 0);
  }, [filtered]);

  // KPI calculations
  const kpi = useMemo(() => {
    let expected = 0;
    let collected = 0;
    data.forEach((r) => {
      const fee = r.monthlyFee || 0;
      const exitMonth = r.exitMonth != null ? r.exitMonth : 11;
      const months = exitMonth + 1;
      expected += (r.regFee || 0) + fee * months;
      collected += (r.regFeePaid || 0);
      (r.payments || []).forEach((p) => { collected += (p || 0); });
    });
    const pct = expected > 0 ? Math.round((collected / expected) * 100) : 0;
    return { expected, collected, pct };
  }, [data]);

  // Save a single month payment
  const handlePaymentChange = async (regId, monthIndex, value) => {
    const num = parseFloat(value) || 0;
    try {
      await api.put(`/collections/${regId}/month/${monthIndex}`, { amount: num });
      // Update local state
      setData((prev) =>
        prev.map((r) => {
          if ((r._id || r.id) !== regId) return r;
          const payments = [...(r.payments || new Array(12).fill(0))];
          payments[monthIndex] = num;
          return { ...r, payments };
        })
      );
    } catch {
      toast.error('שגיאה בשמירת תשלום');
    }
  };

  // Save exit month
  const handleExitMonth = async (regId, value) => {
    const exitMonth = value === '' ? null : parseInt(value, 10);
    try {
      await api.put(`/collections/${regId}/month/exit`, { exitMonth });
      setData((prev) =>
        prev.map((r) => ((r._id || r.id) === regId ? { ...r, exitMonth } : r))
      );
    } catch {
      toast.error('שגיאה בעדכון חודש יציאה');
    }
  };

  // Cell color
  const getCellSx = (payment, expected, isApplicable) => {
    if (!isApplicable) return { bgcolor: '#f1f5f9', color: '#94a3b8' };
    if (payment >= expected && expected > 0) return { bgcolor: '#d1fae5', color: '#065f46' };
    if (payment > 0 && payment < expected) return { bgcolor: '#fef3c7', color: '#92400e' };
    if (payment === 0 && expected > 0) return { bgcolor: '#fee2e2', color: '#991b1b' };
    return {};
  };

  // Monthly totals
  const monthlyTotals = useMemo(() => {
    const totals = new Array(12).fill(0);
    filtered.forEach((r) => {
      (r.payments || []).forEach((p, i) => { totals[i] += (p || 0); });
    });
    return totals;
  }, [filtered]);

  const handlePrint = () => window.print();

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl">
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>
          מעקב גבייה
        </Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <YearSelector value={selectedYear} onChange={setSelectedYear} />
          <Button
            variant="outlined"
            startIcon={<PrintIcon />}
            onClick={handlePrint}
            size="small"
          >
            הדפסה
          </Button>
        </Stack>
      </Stack>

      {/* KPI Cards */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">צפי שנתי</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>
              {formatCurrency(kpi.expected)}
            </Typography>
          </CardContent>
        </Card>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">נגבה בפועל</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>
              {formatCurrency(kpi.collected)}
            </Typography>
          </CardContent>
        </Card>
        <Card sx={{ flex: 1 }}>
          <CardContent sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">אחוז גבייה</Typography>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>
              {kpi.pct}%
            </Typography>
            <LinearProgress
              variant="determinate"
              value={kpi.pct}
              sx={{
                mt: 1,
                height: 8,
                borderRadius: 4,
                bgcolor: '#e2e8f0',
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
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
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
              <TableCell
                sx={{
                  fontWeight: 800,
                  position: 'sticky',
                  right: 0,
                  zIndex: 3,
                  bgcolor: 'background.paper',
                  minWidth: 140,
                }}
              >
                שם הילד/ה
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 80 }}>דמי רישום</TableCell>
              {MONTH_LABELS.map((m) => (
                <TableCell key={m} align="center" sx={{ fontWeight: 700, minWidth: 90 }}>
                  {m}
                </TableCell>
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
                onPaymentChange={handlePaymentChange}
                onExitMonth={handleExitMonth}
                getCellSx={getCellSx}
              />
            ))}

            {/* Footer Totals */}
            <TableRow sx={{ bgcolor: '#f8fafc' }}>
              <TableCell
                sx={{
                  fontWeight: 800,
                  position: 'sticky',
                  right: 0,
                  bgcolor: '#f8fafc',
                  zIndex: 2,
                }}
              >
                סה״כ
              </TableCell>
              <TableCell sx={{ fontWeight: 700 }}>
                {formatCurrency(filtered.reduce((s, r) => s + (r.regFeePaid || 0), 0))}
              </TableCell>
              {monthlyTotals.map((total, i) => (
                <TableCell key={i} align="center" sx={{ fontWeight: 700 }}>
                  {formatCurrency(total)}
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

/* Grouped rows for a classroom */
function GroupRows({ classroom, rows, onPaymentChange, onExitMonth, getCellSx }) {
  // Subtotals
  const subtotals = new Array(12).fill(0);
  rows.forEach((r) => {
    (r.payments || []).forEach((p, i) => { subtotals[i] += (p || 0); });
  });

  return (
    <>
      {/* Classroom header */}
      <TableRow>
        <TableCell
          colSpan={15}
          sx={{
            bgcolor: '#eef2ff',
            fontWeight: 800,
            fontSize: '0.95rem',
            position: 'sticky',
            right: 0,
          }}
        >
          <Chip
            label={`${classroom} (${rows.length})`}
            size="small"
            sx={{ fontWeight: 700 }}
          />
        </TableCell>
      </TableRow>

      {rows.map((row) => {
        const regId = row._id || row.id;
        const payments = row.payments || new Array(12).fill(0);
        const exitMonth = row.exitMonth != null ? row.exitMonth : 11;

        return (
          <TableRow key={regId} hover>
            <TableCell
              sx={{
                fontWeight: 600,
                position: 'sticky',
                right: 0,
                bgcolor: 'background.paper',
                zIndex: 1,
              }}
            >
              {row.childName}
            </TableCell>
            <TableCell>
              <Box sx={{ position: 'relative' }}>
                <TextField
                  size="small"
                  type="number"
                  defaultValue={row.regFeePaid || 0}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    if (val !== (row.regFeePaid || 0)) {
                      onPaymentChange(regId, 'reg', e.target.value);
                    }
                  }}
                  inputProps={{ style: { textAlign: 'center', width: 60, padding: '4px 6px' } }}
                  variant="standard"
                />
                {row.regFee > 0 && (
                  <Typography
                    variant="caption"
                    sx={{ position: 'absolute', bottom: -14, right: 0, color: '#94a3b8', fontSize: '0.65rem' }}
                  >
                    {formatCurrency(row.regFee)}
                  </Typography>
                )}
              </Box>
            </TableCell>
            {MONTH_LABELS.map((_, mi) => {
              const isApplicable = mi <= exitMonth;
              const expected = row.monthlyFee || 0;
              const paid = payments[mi] || 0;
              const cellSx = getCellSx(paid, expected, isApplicable);

              return (
                <TableCell key={mi} align="center" sx={{ p: 0.5, position: 'relative', ...cellSx }}>
                  <TextField
                    size="small"
                    type="number"
                    defaultValue={paid || ''}
                    placeholder={isApplicable ? String(expected) : ''}
                    disabled={!isApplicable}
                    onBlur={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      if (val !== paid) {
                        onPaymentChange(regId, mi, e.target.value);
                      }
                    }}
                    inputProps={{
                      style: {
                        textAlign: 'center',
                        width: 60,
                        padding: '4px 4px',
                        fontSize: '0.85rem',
                      },
                    }}
                    variant="standard"
                    sx={{ '& .MuiInput-underline:before': { borderBottom: 'none' } }}
                  />
                </TableCell>
              );
            })}
            <TableCell>
              <TextField
                select
                size="small"
                value={row.exitMonth != null ? row.exitMonth : ''}
                onChange={(e) => onExitMonth(regId, e.target.value)}
                variant="standard"
                sx={{ minWidth: 80 }}
              >
                {EXIT_MONTHS.map((opt) => (
                  <MenuItem key={String(opt.value)} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </TableCell>
          </TableRow>
        );
      })}

      {/* Subtotals row */}
      <TableRow sx={{ bgcolor: '#f8fafc' }}>
        <TableCell
          sx={{
            fontWeight: 700,
            fontSize: '0.8rem',
            position: 'sticky',
            right: 0,
            bgcolor: '#f8fafc',
            zIndex: 1,
          }}
        >
          סה״כ {classroom}
        </TableCell>
        <TableCell />
        {subtotals.map((t, i) => (
          <TableCell key={i} align="center" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
            {t > 0 ? formatCurrency(t) : ''}
          </TableCell>
        ))}
        <TableCell />
      </TableRow>
    </>
  );
}
