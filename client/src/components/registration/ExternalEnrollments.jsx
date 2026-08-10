import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, Stack, Chip, Button, TextField, InputAdornment,
  Table, TableHead, TableBody, TableRow, TableCell, Checkbox, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, CircularProgress,
  Tooltip, IconButton, Divider, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import VisibilityIcon from '@mui/icons-material/Visibility';
import BlockIcon from '@mui/icons-material/Block';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import PrintIcon from '@mui/icons-material/Print';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatAcademicYear, getAcademicYears } from '../../hooks/useAcademicYear';

/**
 * קליטת רישומים מקליקטאק — the review queue.
 *
 * Three of the network's branches enroll in an external system, so their
 * families are invisible here. A file of seventy-seven children is not
 * something to write straight into the live tables: the branch is not in the
 * export, the tuition is not in the export, and about half the rows may
 * already exist. Everything lands here first and is imported deliberately.
 */

const STATUS_COLORS = {
  pending: { label: 'ממתין', color: 'warning' },
  imported: { label: 'יובא', color: 'success' },
  ignored: { label: 'לא רלוונטי', color: 'default' },
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');

export default function ExternalEnrollments() {
  const years = getAcademicYears();
  const [year, setYear] = useState(years.next.range);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [selected, setSelected] = useState({});
  const [branches, setBranches] = useState([]);

  const [uploadDlg, setUploadDlg] = useState({ open: false, file: null, branchId: '', saving: false, result: null });
  const [detail, setDetail] = useState({ open: false, loading: false, data: null });
  const [importDlg, setImportDlg] = useState({ open: false, saving: false, pricing: null, tier: '', fees: {}, regFee: '' });
  const [contactsDlg, setContactsDlg] = useState({ open: false, loading: false, rows: [] });

  const fetchData = useCallback(() => {
    setLoading(true);
    const branch = localStorage.getItem('selectedBranch');
    api.get('/external-enrollments', { params: { year, ...(branch ? { branch } : {}) } })
      .then(res => { setRows(res.data.enrollments || []); setSummary(res.data.summary || {}); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  }, [year]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    api.get('/branches').then(res => setBranches(res.data.branches || [])).catch(() => {});
  }, []);

  const visible = rows.filter(r => {
    if (statusFilter && r.review?.status !== statusFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.child?.full_name?.toLowerCase().includes(q)
      || String(r.child?.id_number).includes(q)
      || `${r.parent1?.first_name} ${r.parent1?.last_name}`.toLowerCase().includes(q);
  });

  const selectedIds = Object.keys(selected).filter(k => selected[k]);

  const handleUpload = async () => {
    if (!uploadDlg.file) return toast.error('יש לבחור קובץ');
    if (!uploadDlg.branchId) return toast.error('יש לבחור סניף');
    setUploadDlg(d => ({ ...d, saving: true, result: null }));
    try {
      const form = new FormData();
      form.append('file', uploadDlg.file);
      form.append('branch_id', uploadDlg.branchId);
      const res = await api.post('/external-enrollments/import', form,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      setUploadDlg(d => ({ ...d, saving: false, result: res.data }));
      fetchData();
    } catch (err) {
      const data = err.response?.data;
      toast.error(data?.error || 'שגיאה בקליטת הקובץ');
      setUploadDlg(d => ({ ...d, saving: false }));
    }
  };

  const openDetail = async (row) => {
    setDetail({ open: true, loading: true, data: null });
    try {
      const res = await api.get(`/external-enrollments/${row.id}`);
      setDetail({ open: true, loading: false, data: res.data.enrollment });
    } catch {
      setDetail({ open: false, loading: false, data: null });
      toast.error('שגיאה בטעינת הרשומה');
    }
  };

  /** The state price matrix for the branch, so a tier picks the fees. */
  const openImportDialog = async () => {
    if (!selectedIds.length) return toast.info('לא נבחרו רשומות');
    const branchId = rows.find(r => r.id === selectedIds[0])?.branch_id;
    setImportDlg({ open: true, saving: false, pricing: null, tier: '', fees: {}, regFee: '' });
    try {
      const res = await api.get('/external-enrollments/pricing', { params: { branch: branchId, year } });
      const p = res.data.pricing;
      setImportDlg(d => ({
        ...d,
        pricing: p,
        regFee: p?.one_time?.registration != null ? String(p.one_time.registration) : '',
      }));
    } catch { /* the fees can still be typed by hand */ }
  };

  /** A tier row prices all three age groups at once — column per age group. */
  const applyTier = (label) => {
    const p = importDlg.pricing;
    const tier = p?.tiers?.find(t => t.label === label);
    if (!tier) return setImportDlg(d => ({ ...d, tier: label }));
    setImportDlg(d => ({
      ...d,
      tier: label,
      fees: { 'תינוק': tier.prices[0], 'פעוט': tier.prices[1], 'בוגר': tier.prices[2] },
    }));
  };

  const handleImport = async () => {
    const fees = importDlg.fees;
    if (!Object.values(fees).some(v => Number(v) > 0)) {
      return toast.error('יש לקבוע שכר לימוד — הוא לא קיים בקובץ הייצוא');
    }
    setImportDlg(d => ({ ...d, saving: true }));
    try {
      const res = await api.post('/external-enrollments/promote-bulk', {
        ids: selectedIds,
        fees_by_age_group: Object.fromEntries(
          Object.entries(fees).map(([k, v]) => [k, Number(v) || 0]),
        ),
        registration_fee: Number(importDlg.regFee) || 0,
      });
      toast.success(`${res.data.imported} רישומים נוצרו במערכת`);
      (res.data.skipped || []).slice(0, 4).forEach(s => toast.warning(`${s.child || s.id}: ${s.error}`));
      setImportDlg({ open: false, saving: false, pricing: null, tier: '', fees: {}, regFee: '' });
      setSelected({});
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בייבוא');
      setImportDlg(d => ({ ...d, saving: false }));
    }
  };

  const setIgnored = async (row, status) => {
    try {
      await api.put(`/external-enrollments/${row.id}/review`, { status });
      fetchData();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const openContacts = async () => {
    setContactsDlg({ open: true, loading: true, rows: [] });
    try {
      const branch = localStorage.getItem('selectedBranch');
      const res = await api.get('/external-enrollments/contacts',
        { params: { year, ...(branch ? { branch } : {}) } });
      setContactsDlg({ open: true, loading: false, rows: res.data.contacts || [] });
    } catch {
      setContactsDlg({ open: false, loading: false, rows: [] });
      toast.error('שגיאה בטעינת דף הקשר');
    }
  };

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>קליטת רישומים מקליקטאק</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${summary.total || 0} רשומות`} />
            <Chip size="small" color="warning" variant={statusFilter === 'pending' ? 'filled' : 'outlined'}
              label={`${summary.pending || 0} ממתינים`} onClick={() => setStatusFilter('pending')}
              sx={{ cursor: 'pointer', fontWeight: 700 }} />
            <Chip size="small" color="success" variant={statusFilter === 'imported' ? 'filled' : 'outlined'}
              label={`${summary.imported || 0} יובאו`} onClick={() => setStatusFilter('imported')}
              sx={{ cursor: 'pointer', fontWeight: 700 }} />
            {summary.matched > 0 && (
              <Tooltip title="נמצאה התאמה לילד/ה שכבר קיים/ת במערכת — ייבוא ייצור רישום שני">
                <Chip size="small" color="info" variant="outlined" label={`${summary.matched} כבר במערכת`} />
              </Tooltip>
            )}
            {summary.cancelled > 0 && (
              <Chip size="small" color="error" variant="outlined" label={`${summary.cancelled} ביטלו רישום`} />
            )}
            {summary.disagree_age_group > 0 && (
              <Tooltip title="השכבה שחושבה לפי תאריך הלידה שונה מזו שבקליקטאק — שווה בדיקה, לא בהכרח שגיאה">
                <Chip size="small" color="warning" icon={<WarningAmberIcon />}
                  label={`${summary.disagree_age_group} פערי שכבת גיל`} />
              </Tooltip>
            )}
          </Stack>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<ContactPhoneIcon />} onClick={openContacts}>
            דף קשר להורים
          </Button>
          <Button variant="contained" startIcon={<UploadFileIcon />}
            onClick={() => setUploadDlg({ open: true, file: null, branchId: '', saving: false, result: null })}>
            קליטת קובץ
          </Button>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField size="small" placeholder="חיפוש לפי ילד/ה, ת.ז או הורה…"
          value={search} onChange={e => setSearch(e.target.value)} sx={{ width: 300 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <TextField select size="small" label="שנת לימודים" sx={{ minWidth: 200 }}
          value={year} onChange={e => setYear(e.target.value)}>
          {[years.current.range, years.next.range].map(y => (
            <MenuItem key={y} value={y}>{formatAcademicYear(y)}</MenuItem>
          ))}
        </TextField>
        <ToggleButtonGroup size="small" exclusive value={statusFilter}
          onChange={(_, v) => setStatusFilter(v ?? '')}>
          <ToggleButton value="pending">ממתינים</ToggleButton>
          <ToggleButton value="imported">יובאו</ToggleButton>
          <ToggleButton value="ignored">לא רלוונטי</ToggleButton>
          <ToggleButton value="">הכל</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {selectedIds.length > 0 && (
        <Card sx={{ p: 1.5, mb: 2, bgcolor: '#eef2ff', border: '1px solid #6366f1' }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography sx={{ fontWeight: 700 }}>{selectedIds.length} נבחרו</Typography>
            <Button size="small" variant="contained" startIcon={<PlaylistAddCheckIcon />}
              onClick={openImportDialog}>
              ייבוא למערכת
            </Button>
            <Button size="small" onClick={() => setSelected({})}>נקה בחירה</Button>
            <Box sx={{ flex: 1 }} />
            <Button size="small"
              onClick={() => setSelected(Object.fromEntries(visible.map(r => [r.id, true])))}>
              בחר את כל {visible.length} המוצגים
            </Button>
          </Stack>
        </Card>
      )}

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : rows.length === 0 ? (
        <Alert severity="info">
          אין רשומות לשנה זו. השתמש/י ב"קליטת קובץ" כדי לטעון ייצוא מקליקטאק.
          שים/י לב: עמודת <b>מוסד</b> בקובץ רושמת "כפר סבא" לכל השורות ואינה מבחינה בין
          משה דיין לקפלן — הסניף נבחר בעת הקליטה.
        </Alert>
      ) : (
        <Card>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell padding="checkbox" />
                <TableCell sx={{ fontWeight: 700 }}>ילד/ה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>לידה / שכבה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>הורים</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס בקליקטאק</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>במערכת</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map(r => {
                const st = STATUS_COLORS[r.review?.status] || STATUS_COLORS.pending;
                const cancelled = r.enrollment?.status === 'ביטל רישום';
                return (
                  <TableRow key={r.id} hover sx={cancelled ? { opacity: 0.6 } : undefined}>
                    <TableCell padding="checkbox">
                      <Checkbox size="small"
                        disabled={r.review?.status === 'imported'}
                        checked={!!selected[r.id]}
                        onChange={() => setSelected(s => ({ ...s, [r.id]: !s[r.id] }))} />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {r.child?.full_name}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} dir="ltr">
                        {r.child?.id_number}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {fmtDate(r.child?.birth_date)}
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.3 }} alignItems="center">
                        <Chip size="small" label={r.computed?.age_group || '—'} sx={{ height: 18, fontSize: '0.65rem' }} />
                        {r.computed?.agrees_with_source === false && (
                          <Tooltip title={`בקליקטאק: ${r.child?.age_group}`}>
                            <Chip size="small" color="warning" label={`≠ ${r.child?.age_group}`}
                              sx={{ height: 18, fontSize: '0.65rem' }} />
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {r.parent1?.first_name} {r.parent1?.last_name}
                        {r.parent1?.relation && <Typography component="span" variant="caption" color="text.secondary"> ({r.parent1.relation})</Typography>}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" dir="ltr" sx={{ display: 'block' }}>
                        {r.parent1?.phone}
                      </Typography>
                      {r.parent2?.first_name && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {r.parent2.first_name} {r.parent2.last_name} · <span dir="ltr">{r.parent2.phone}</span>
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={cancelled ? 'error' : 'default'}
                        label={r.enrollment?.status || '—'} />
                      {r.enrollment?.continuing && (
                        <Chip size="small" variant="outlined" label="ממשיך" sx={{ mr: 0.5, height: 18, fontSize: '0.65rem' }} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={st.color} label={st.label} />
                      {r.review?.matched_registration_id && (
                        <Tooltip title={`הותאם לפי ${r.review.matched_by === 'id_number' ? 'ת.ז' : 'שם + תאריך לידה'}`}>
                          <Chip size="small" color="info" variant="outlined" label="קיים כבר"
                            sx={{ mr: 0.5, height: 18, fontSize: '0.65rem' }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="פרטים מלאים">
                        <IconButton size="small" onClick={() => openDetail(r)}>
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      {r.review?.status !== 'imported' && (
                        <Tooltip title={r.review?.status === 'ignored' ? 'החזר לממתינים' : 'סמן כלא רלוונטי'}>
                          <IconButton size="small"
                            onClick={() => setIgnored(r, r.review?.status === 'ignored' ? 'pending' : 'ignored')}>
                            <BlockIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    אין תוצאות
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Upload. The branch is asked for, never read from the file. */}
      <Dialog open={uploadDlg.open} onClose={() => setUploadDlg({ open: false, file: null, branchId: '', saving: false, result: null })}
        dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>קליטת ייצוא מקליקטאק</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="warning" icon={false}>
              עמודת <b>מוסד</b> בקובץ רושמת "כפר סבא" לכל השורות, ויש שני סניפי כפר סבא.
              הסניף נקבע כאן ולא מהקובץ — בחירה שגויה תשייך את כל הקבוצה לגן הלא נכון.
            </Alert>
            <TextField select size="small" label="סניף" fullWidth
              value={uploadDlg.branchId}
              onChange={e => setUploadDlg(d => ({ ...d, branchId: e.target.value }))}>
              {branches.map(b => (
                <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={uploadDlg.saving}>
                {uploadDlg.file ? 'החלף קובץ' : 'בחר/י קובץ xlsx'}
                <input type="file" hidden accept=".xlsx,.xls"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) setUploadDlg(d => ({ ...d, file: f }));
                  }} />
              </Button>
              {uploadDlg.file && <Chip size="small" label={uploadDlg.file.name}
                onDelete={() => setUploadDlg(d => ({ ...d, file: null }))} />}
            </Stack>

            {uploadDlg.result && (
              <Alert severity="success">
                <b>{uploadDlg.result.branch}</b> · {uploadDlg.result.rows} שורות בגיליון ·{' '}
                {uploadDlg.result.created} חדשות · {uploadDlg.result.updated} עודכנו ·{' '}
                {uploadDlg.result.unchanged} ללא שינוי
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadDlg({ open: false, file: null, branchId: '', saving: false, result: null })}>
            סגור
          </Button>
          <Button variant="contained" onClick={handleUpload} disabled={uploadDlg.saving}>
            {uploadDlg.saving ? 'קולט…' : 'קלוט'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import into the system. The tuition is not in the export — it comes
          from the branch's state matrix, and the tier is a property of the
          family's income that ClickTac does not send. */}
      <Dialog open={importDlg.open} onClose={() => setImportDlg(d => ({ ...d, open: false }))}
        dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          ייבוא {selectedIds.length} רישומים למערכת
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" icon={false}>
              ייווצרו רישום וילד/ה לכל שורה, עם <b>שני ההורים</b>. החוזה נחתם בקליקטאק, לכן
              הרישום ייווצר כ"הושלם" אך <b>ללא חתימה</b> במערכת הזו — מקור החתימה נשמר על הרישום.
              מספר קבלה של דמי הרישום ייכנס לשורת הגבייה, כך שלא ייגבו פעמיים.
            </Alert>

            {importDlg.pricing?.tiers?.length > 0 ? (
              <>
                <TextField select size="small" label="דרגת סבסוד" fullWidth value={importDlg.tier}
                  onChange={e => applyTier(e.target.value)}
                  helperText="הדרגה נקבעת לפי הכנסת המשפחה ואינה קיימת בקובץ הייצוא">
                  {importDlg.pricing.tiers.map(t => (
                    <MenuItem key={t.label} value={t.label}>{t.label}</MenuItem>
                  ))}
                </TextField>
                <Typography variant="caption" color="text.secondary">
                  עמודות המחירון: {(importDlg.pricing.age_groups || []).join(' · ')}
                </Typography>
              </>
            ) : (
              <Alert severity="warning">
                לא נמצא מחירון לסניף ולשנה. אפשר להזין שכר לימוד ידנית לכל שכבה.
              </Alert>
            )}

            <Stack direction="row" spacing={1}>
              {['תינוק', 'פעוט', 'בוגר'].map(g => (
                <TextField key={g} size="small" type="number" label={g} fullWidth
                  value={importDlg.fees[g] ?? ''}
                  onChange={e => setImportDlg(d => ({ ...d, fees: { ...d.fees, [g]: e.target.value } }))} />
              ))}
            </Stack>

            <TextField size="small" type="number" label="דמי רישום" value={importDlg.regFee}
              onChange={e => setImportDlg(d => ({ ...d, regFee: e.target.value }))}
              helperText="ברירת מחדל מהמחירון של הסניף" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportDlg(d => ({ ...d, open: false }))} disabled={importDlg.saving}>
            ביטול
          </Button>
          <Button variant="contained" onClick={handleImport} disabled={importDlg.saving}>
            {importDlg.saving ? 'מייבא…' : `ייבא ${selectedIds.length}`}
          </Button>
        </DialogActions>
      </Dialog>

      {/* One record, in full — this is the only place the standing order is shown. */}
      <Dialog open={detail.open} onClose={() => setDetail({ open: false, loading: false, data: null })}
        dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {detail.data?.child?.full_name || 'פרטי רישום'}
        </DialogTitle>
        <DialogContent>
          {detail.loading ? <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box>
            : detail.data && (
              <Stack spacing={1.5} sx={{ mt: 1 }}>
                <Row label="ת.ז" value={detail.data.child.id_number} ltr />
                <Row label="תאריך לידה" value={fmtDate(detail.data.child.birth_date)} />
                <Row label="גיל ב-1.9" value={`${detail.data.computed?.age_months} חודשים → ${detail.data.computed?.age_group}`} />
                <Row label="שכבה בקליקטאק" value={detail.data.child.age_group} />
                <Row label="מגדר" value={detail.data.child.gender} />
                <Row label="קופת חולים" value={detail.data.child.health_fund} />
                {detail.data.child.has_allergy && (
                  <Row label="אלרגיה" value={detail.data.child.allergy_detail} />
                )}
                {detail.data.child.aide_name && (
                  <Row label="מלווה" value={`${detail.data.child.aide_name} · ${detail.data.child.aide_phone}`} />
                )}
                <Divider />
                {[detail.data.parent1, detail.data.parent2].filter(p => p?.first_name).map((p, i) => (
                  <Box key={i}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {p.first_name} {p.last_name} {p.relation && `(${p.relation})`}
                    </Typography>
                    <Row label="ת.ז" value={p.id_number} ltr />
                    <Row label="טלפון" value={p.phone} ltr />
                    <Row label="אימייל" value={p.email} ltr />
                    <Row label="כתובת" value={p.address} />
                    <Row label="עיסוק" value={p.occupation} />
                  </Box>
                ))}
                <Divider />
                <Row label="סטטוס" value={detail.data.enrollment?.status} />
                <Row label="חותם שני" value={detail.data.enrollment?.second_signer} />
                <Row label="תאריך הרשמה" value={fmtDate(detail.data.enrollment?.registered_at)} />
                <Row label="מספר קבלה" value={detail.data.enrollment?.receipt_number} ltr />
                <Row label="אמצעי תשלום שכ״ל" value={detail.data.enrollment?.tuition_method} />
                {detail.data.standing_order?.bank && (
                  <>
                    <Divider />
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוראת קבע</Typography>
                    <Row label="בנק" value={detail.data.standing_order.bank} />
                    <Row label="סניף" value={detail.data.standing_order.branch} ltr />
                    <Row label="חשבון" value={detail.data.standing_order.account} ltr />
                    <Row label="בעל החשבון" value={detail.data.standing_order.holder_name} />
                  </>
                )}
              </Stack>
            )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail({ open: false, loading: false, data: null })}>סגור</Button>
        </DialogActions>
      </Dialog>

      {/* The contact sheet — the thing the previous export could not produce
          at all, because it carried no parent data of any kind. */}
      <Dialog open={contactsDlg.open} onClose={() => setContactsDlg({ open: false, loading: false, rows: [] })}
        dir="rtl" maxWidth="lg" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          דף קשר להורים — {formatAcademicYear(year)}
          <Button size="small" startIcon={<PrintIcon />} sx={{ float: 'left' }}
            onClick={() => window.print()}>הדפסה</Button>
        </DialogTitle>
        <DialogContent>
          {contactsDlg.loading ? <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>ילד/ה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>שכבה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הורה 1</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>טלפון</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הורה 2</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>טלפון</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>כתובת</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {contactsDlg.rows.map((c, i) => (
                  <TableRow key={i} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{c.child_name}</TableCell>
                    <TableCell>{c.age_group}</TableCell>
                    <TableCell>{c.parent1_name} {c.parent1_relation && `(${c.parent1_relation})`}</TableCell>
                    <TableCell dir="ltr">{c.parent1_phone}</TableCell>
                    <TableCell>{c.parent2_name} {c.parent2_relation && `(${c.parent2_relation})`}</TableCell>
                    <TableCell dir="ltr">{c.parent2_phone}</TableCell>
                    <TableCell>{c.address}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setContactsDlg({ open: false, loading: false, rows: [] })}>סגור</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function Row({ label, value, ltr }) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={1}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 110 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600 }} dir={ltr ? 'ltr' : undefined}>{value}</Typography>
    </Stack>
  );
}
