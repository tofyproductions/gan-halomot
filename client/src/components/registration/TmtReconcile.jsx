import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Card, Stack, Chip, Button, TextField, InputAdornment, MenuItem,
  Table, TableHead, TableBody, TableRow, TableCell, Dialog, DialogTitle, DialogContent,
  DialogActions, Alert, AlertTitle, CircularProgress, Tooltip, IconButton, Divider,
  ToggleButton, ToggleButtonGroup, List, ListItem, ListItemText,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import HistoryIcon from '@mui/icons-material/History';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatAcademicYear, getEnrollmentYear } from '../../hooks/useAcademicYear';

/**
 * הצלבת תמ"ת מול קליקטאק.
 *
 * A child enrolls in a ministry-supervised מעון only if BOTH are true: משרד
 * התמ"ת approved them for this gan, and the family completed the registration
 * in ClickTac. The two systems never speak to each other, so every July
 * somebody compares two spreadsheets by hand and decides who is in, who has to
 * be called, and whose place goes to the next family in line.
 *
 * This screen is that comparison. It shows the conclusion per child, the
 * anomalies behind it, and what moved since the last file was uploaded —
 * because both lists are republished through the summer and the question is
 * always "what changed", not "what does it say".
 */

const VERDICT_STYLE = {
  approved: { color: 'success', short: 'מאושר/ת' },
  missing_registration: { color: 'error', short: 'לא נרשם אצלנו' },
  missing_approval: { color: 'error', short: 'אין אישור תמ"ת' },
  cancelled: { color: 'warning', short: 'ביטל/ה רישום' },
  withdrawn: { color: 'error', short: 'הוסר/ה מרשימת תמ״ת' },
  not_approved: { color: 'error', short: 'תמ"ת לא אישר' },
};

const SEVERITY_COLOR = { critical: 'error', warning: 'warning', info: 'info', ok: 'default' };

/** The three groups a child can be placed in. The state's brackets, our rooms. */
const AGE_GROUPS = ['תינוק', 'פעוט', 'בוגר'];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('he-IL') : '—');

/** A count that is only worth showing when it is not zero. */
function StatCard({ label, value, color, onClick, active, hint }) {
  return (
    <Card
      onClick={onClick}
      sx={{
        p: 1.5, minWidth: 132, cursor: onClick ? 'pointer' : 'default',
        border: 2, borderColor: active ? `${color}.main` : 'transparent',
        bgcolor: active ? `${color}.50` : 'background.paper',
      }}
    >
      <Typography variant="h5" color={`${color}.main`} fontWeight={700}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      {hint && <Typography variant="caption" display="block" color="text.disabled">{hint}</Typography>}
    </Card>
  );
}

/**
 * `embedded` — rendered inside רישום לאמונה, which owns the branch, the year
 * and both uploads. The screen then drops its own copies of those controls.
 */
export default function TmtReconcile({
  branchId: propBranch, year: propYear, embedded = false, reloadKey = 0,
  // Acting is a narrower grant than seeing — the page above works them out and
  // the server enforces the same split.
  canImport = true, canPlace = true,
} = {}) {
  // The intake year — fixed, never picked. See getEnrollmentYear().
  const year = embedded ? propYear : getEnrollmentYear();
  const [branches, setBranches] = useState([]);
  const [ownBranchId, setOwnBranchId] = useState(localStorage.getItem('selectedBranch') || '');
  const branchId = embedded ? propBranch : ownBranchId;
  const setBranchId = setOwnBranchId;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState('');

  const [uploadDlg, setUploadDlg] = useState({ open: false, file: null, saving: false, result: null });
  const [detail, setDetail] = useState(null);
  const [applyDlg, setApplyDlg] = useState({ open: false, saving: false, result: null });
  const [historyDlg, setHistoryDlg] = useState({ open: false, loading: false, imports: [] });
  const [contactsDlg, setContactsDlg] = useState({ open: false, loading: false, rows: [] });
  const [saving, setSaving] = useState({});

  useEffect(() => {
    if (embedded) return;   // the page above already chose the branch
    api.get('/branches')
      .then(res => {
        const all = res.data.branches || [];
        // קפלן is not under the ministry — it registers directly with us and
        // has no approval list, so it is not offered here at all.
        const supervised = all.filter(b => (b.tmt_supervised ?? !/קפלן/.test(b.name || '')));
        setBranches(supervised);
        if (!branchId && supervised.length) setBranchId(supervised[0].id || supervised[0]._id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded]);

  const fetchData = useCallback(() => {
    if (!branchId || !year) return;
    setLoading(true);
    setError('');
    api.get('/tmt/reconcile', { params: { branch: branchId, year } })
      .then(res => setData(res.data))
      .catch(err => {
        setData(null);
        setError(err.response?.data?.error || 'שגיאה בטעינת ההצלבה');
      })
      .finally(() => setLoading(false));
    // reloadKey: the page above uploaded a file or undid one.
  }, [branchId, year, reloadKey]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rows = data?.rows || [];
  const summary = data?.summary || {};

  const visible = useMemo(() => rows.filter(r => {
    if (verdictFilter && r.verdict !== verdictFilter) return false;
    if (issueFilter && !r.issues.some(i => i.code === issueFilter)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.child_name.toLowerCase().includes(q) || String(r.id_number).includes(q);
  }), [rows, verdictFilter, issueFilter, search]);

  const handleUpload = async () => {
    if (!uploadDlg.file) return toast.error('יש לבחור קובץ');
    if (!branchId) return toast.error('יש לבחור סניף');
    setUploadDlg(d => ({ ...d, saving: true, result: null }));
    try {
      const form = new FormData();
      form.append('file', uploadDlg.file);
      form.append('branch_id', branchId);
      form.append('academic_year', year);
      const res = await api.post('/tmt/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setUploadDlg(d => ({ ...d, saving: false, result: res.data }));
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בקליטת הקובץ');
      setUploadDlg(d => ({ ...d, saving: false }));
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/tmt/reconcile/export', {
        params: { branch: branchId, year }, responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `הצלבת תמת ${data?.branch_name || ''} ${year}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('שגיאה בייצוא');
    }
  };

  const openHistory = async () => {
    setHistoryDlg({ open: true, loading: true, imports: [] });
    try {
      const res = await api.get('/tmt/imports', { params: { branch: branchId, year } });
      setHistoryDlg({ open: true, loading: false, imports: res.data.imports || [] });
    } catch {
      setHistoryDlg({ open: false, loading: false, imports: [] });
      toast.error('שגיאה בטעינת ההיסטוריה');
    }
  };

  const openContacts = async () => {
    setContactsDlg({ open: true, loading: true, rows: [] });
    try {
      const res = await api.get('/tmt/contacts', { params: { branch: branchId, year, verdict: 'approved' } });
      setContactsDlg({ open: true, loading: false, rows: res.data.contacts || [] });
    } catch (err) {
      setContactsDlg({ open: false, loading: false, rows: [] });
      toast.error(err.response?.data?.error || 'שגיאה בטעינת דף הקשר');
    }
  };

  /**
   * Which group this child actually joins.
   *
   * The ministry's שכבת גיל is a funding bracket and ClickTac's is a form
   * field. Neither is a placement — a child of 22 months can belong with the
   * בוגרים in one gan and the צעירים in another, and that is the manager's
   * call, made against the age on 1 September shown next to it. Once made it
   * decides the fee column and the classroom at import, and it survives the
   * next file.
   */
  const setPlacement = async (row, group) => {
    if (!row.clicktac) {
      return toast.info('אפשר לשבץ רק ילד/ה שנרשמו בקליקטאק — אין רשומה לשבץ');
    }
    setSaving(s => ({ ...s, [row.id_number]: true }));
    try {
      await api.put(`/external-enrollments/${row.clicktac.id}/placement`, { age_group: group });
      toast.success(group ? `${row.child_name} שובץ/ה ל${group}` : `בוטל השיבוץ הידני של ${row.child_name}`);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשיבוץ');
    } finally {
      setSaving(s => ({ ...s, [row.id_number]: false }));
    }
  };

  const handleApply = async () => {
    setApplyDlg(d => ({ ...d, saving: true }));
    try {
      const res = await api.post('/tmt/apply', { branch_id: branchId, academic_year: year });
      setApplyDlg({ open: true, saving: false, result: res.data });
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהחלת המסקנות');
      setApplyDlg(d => ({ ...d, saving: false }));
    }
  };

  const lastTmt = data?.last_import?.tmt;
  const lastCt = data?.last_import?.clicktac;

  return (
    <Box sx={{ p: 2 }}>
      {!embedded && (
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" sx={{ mb: 2 }}>
          <Typography variant="h5" fontWeight={700}>הצלבת תמ"ת מול קליקטאק</Typography>
          <TextField
            select size="small" label="סניף" value={branchId}
            onChange={e => setBranchId(e.target.value)} sx={{ minWidth: 200 }}
          >
            {branches.map(b => (
              <MenuItem key={b.id || b._id} value={b.id || b._id}>{b.name}</MenuItem>
            ))}
          </TextField>
          <Chip variant="outlined" label={`שנת ${formatAcademicYear(year)}`} />
          <Box sx={{ flex: 1 }} />
          <Button startIcon={<UploadFileIcon />} variant="contained"
            onClick={() => setUploadDlg({ open: true, file: null, saving: false, result: null })}>
            העלאת קובץ תמ"ת
          </Button>
          <Tooltip title="רענון"><span>
            <IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton>
          </span></Tooltip>
        </Stack>
      )}

      <Alert severity="info" sx={{ mb: 2 }}>
        ילד נקלט לשנה הבאה רק אם הוא מופיע גם ברשימת האישורים של משרד התמ"ת וגם ברישום בקליקטאק.
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

      {data && !loading && (
        <>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <StatCard label="מאושרים לשנה הבאה" value={summary.approved || 0} color="success"
              active={verdictFilter === 'approved'} hint={`${summary.clean || 0} ללא חריגות`}
              onClick={() => setVerdictFilter(verdictFilter === 'approved' ? '' : 'approved')} />
            <StatCard label='אושר בתמ"ת — לא נרשם' value={summary.missing_registration || 0} color="error"
              active={verdictFilter === 'missing_registration'} hint="להתקשר להורים"
              onClick={() => setVerdictFilter(verdictFilter === 'missing_registration' ? '' : 'missing_registration')} />
            <StatCard label='נרשם — אין אישור תמ"ת' value={summary.missing_approval || 0} color="error"
              active={verdictFilter === 'missing_approval'} hint="לא ניתן לקלוט"
              onClick={() => setVerdictFilter(verdictFilter === 'missing_approval' ? '' : 'missing_approval')} />
            <StatCard label="ביטלו רישום" value={summary.cancelled || 0} color="warning"
              active={verdictFilter === 'cancelled'} hint={`${summary.places_freed || 0} מקומות התפנו`}
              onClick={() => setVerdictFilter(verdictFilter === 'cancelled' ? '' : 'cancelled')} />
            <StatCard label='ללא אישור בתמ"ת' value={summary.not_approved || 0} color="error"
              active={verdictFilter === 'not_approved'}
              onClick={() => setVerdictFilter(verdictFilter === 'not_approved' ? '' : 'not_approved')} />
            <StatCard label='הוסרו מרשימת התמ"ת' value={summary.withdrawn || 0} color="error"
              active={verdictFilter === 'withdrawn'} hint="האישור בוטל"
              onClick={() => setVerdictFilter(verdictFilter === 'withdrawn' ? '' : 'withdrawn')} />
            <StatCard label='להזין תאריך כניסה בתמ"ת' value={summary.needs_absorption_date || 0} color="warning"
              active={issueFilter === 'needs_absorption_date'} hint={`${summary.absorbed || 0} כבר עם תאריך`}
              onClick={() => setIssueFilter(issueFilter === 'needs_absorption_date' ? '' : 'needs_absorption_date')} />
            <StatCard label="שובצו ידנית" value={summary.placed_by_hand || 0} color="info"
              hint="החלטה שלך על הכיתה" />
            <StatCard label="נקלטו כבר למערכת" value={summary.already_imported || 0} color="info" />
          </Stack>

          <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
            <TextField
              size="small" placeholder="חיפוש שם או ת״ז" value={search}
              onChange={e => setSearch(e.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              sx={{ minWidth: 220 }}
            />
            <ToggleButtonGroup size="small" exclusive value={issueFilter}
              onChange={(e, v) => setIssueFilter(v || '')}>
              {Object.entries(summary.issues || {}).map(([code, count]) => (
                <ToggleButton key={code} value={code}>
                  {data.dictionaries?.issues?.[code]?.label || code} ({count})
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Box sx={{ flex: 1 }} />
            <Button size="small" startIcon={<HistoryIcon />} onClick={openHistory}>היסטוריית העלאות</Button>
            <Button size="small" startIcon={<ContactPhoneIcon />} onClick={openContacts}>דף קשר</Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={handleExport}>ייצוא לאקסל</Button>
            {canImport && (
              <Button size="small" variant="outlined" color="warning" startIcon={<PlaylistAddCheckIcon />}
                onClick={() => setApplyDlg({ open: true, saving: false, result: null })}>
                החלת המסקנות
              </Button>
            )}
          </Stack>

          {(lastTmt || lastCt) && (
            <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              {[['תמ"ת', lastTmt], ['קליקטאק', lastCt]].map(([label, imp]) => (
                <Card key={label} sx={{ p: 1.5, flex: 1, minWidth: 280 }}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    קובץ {label} אחרון — {imp ? fmtDateTime(imp.created_at) : 'טרם הועלה'}
                  </Typography>
                  {imp && (
                    <Typography variant="caption" color="text.secondary">
                      {imp.file_name} · {imp.parsed} שורות · חדשים {imp.created} · עודכנו {imp.updated} ·
                      {' '}ללא שינוי {imp.unchanged} · הוסרו {imp.missing}
                      {imp.imported_by_name ? ` · ${imp.imported_by_name}` : ''}
                    </Typography>
                  )}
                  {!!imp?.details?.missing?.length && (
                    <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                      ירדו מהרשימה: {imp.details.missing.join(', ')}
                    </Alert>
                  )}
                </Card>
              ))}
            </Stack>
          )}

          <Card>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>שם הילד/ה</TableCell>
                  <TableCell>ת״ז</TableCell>
                  <TableCell>תאריך לידה</TableCell>
                  <TableCell>גיל ב־1.9</TableCell>
                  <TableCell>שיבוץ לכיתה</TableCell>
                  <TableCell>מסקנה</TableCell>
                  <TableCell>חריגות</TableCell>
                  <TableCell>תמ"ת</TableCell>
                  <TableCell>קליקטאק</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(r => (
                  <TableRow key={r.id_number} hover>
                    <TableCell>{r.child_name}</TableCell>
                    <TableCell>{r.id_number}</TableCell>
                    <TableCell>
                      {fmtDate(r.birth_date)}
                      {r.age_source && (
                        <Typography variant="caption" color="text.disabled" display="block">
                          לפי {r.age_source}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {r.age_at_year_start?.label || '—'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        לפי הגיל: {r.age_at_year_start?.suggested_group || '—'}
                        {r.age_group && r.age_group !== r.age_at_year_start?.suggested_group
                          ? ` · בקבצים: ${r.age_group}` : ''}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <TextField
                        select size="small" variant="standard"
                        sx={{ minWidth: 110 }}
                        disabled={!canPlace || !r.clicktac || !!saving[r.id_number]
                          || r.clicktac?.review_status === 'imported'}
                        value={r.age_group_override || ''}
                        onChange={e => setPlacement(r, e.target.value)}
                      >
                        <MenuItem value="">
                          לפי הגיל ({r.age_at_year_start?.suggested_group || '—'})
                        </MenuItem>
                        {AGE_GROUPS.map(g => <MenuItem key={g} value={g}>{g}</MenuItem>)}
                      </TextField>
                      {r.clicktac?.review_status === 'imported' && (
                        <Typography variant="caption" color="text.disabled" display="block">
                          נקלט/ה — משנים במסך הכיתות
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={VERDICT_STYLE[r.verdict]?.short || r.verdict}
                        color={VERDICT_STYLE[r.verdict]?.color || 'default'} />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {r.issues.map(i => (
                          <Tooltip key={i.code} title={i.detail || ''}>
                            <Chip size="small" variant="outlined" label={i.label}
                              color={SEVERITY_COLOR[i.severity] || 'default'} />
                          </Tooltip>
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {r.tmt
                        ? `${r.tmt.decision}${r.tmt.is_present ? '' : ' (הוסר/ה)'}`
                        : <Typography variant="caption" color="error">לא ברשימה</Typography>}
                    </TableCell>
                    <TableCell>
                      {r.clicktac
                        ? r.clicktac.status
                        : <Typography variant="caption" color="error">לא נרשם</Typography>}
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" onClick={() => setDetail(r)}><VisibilityIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {!visible.length && (
                  <TableRow><TableCell colSpan={10} align="center" sx={{ py: 3 }}>
                    <Typography color="text.secondary">אין רשומות להצגה</Typography>
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {/* ---- העלאת קובץ תמ"ת ---- */}
      <Dialog open={uploadDlg.open} onClose={() => setUploadDlg(d => ({ ...d, open: false }))} maxWidth="sm" fullWidth>
        <DialogTitle>העלאת קובץ אישורים מתמ"ת</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            הקובץ מורד מהפורטל של משרד התמ"ת בנפרד לכל מעון ואינו כולל את שם הסניף,
            ולכן הוא נקלט לסניף <b>{branches.find(b => (b.id || b._id) === branchId)?.name || ''}</b> ולשנת {formatAcademicYear(year)}.
          </Alert>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            בחירת קובץ
            <input hidden type="file" accept=".xls,.xlsx"
              onChange={e => setUploadDlg(d => ({ ...d, file: e.target.files[0] }))} />
          </Button>
          {uploadDlg.file && <Typography sx={{ mt: 1 }}>{uploadDlg.file.name}</Typography>}

          {uploadDlg.result && (
            <Alert severity="success" sx={{ mt: 2 }}>
              <AlertTitle>נקלטו {uploadDlg.result.parsed} שורות</AlertTitle>
              חדשים: {uploadDlg.result.created} · עודכנו: {uploadDlg.result.updated} ·
              {' '}ללא שינוי: {uploadDlg.result.unchanged} · ירדו מהרשימה: {uploadDlg.result.missing}
              {!!uploadDlg.result.details?.missing?.length && (
                <Box sx={{ mt: 1 }}>
                  <b>ירדו מרשימת התמ"ת:</b> {uploadDlg.result.details.missing.join(', ')}
                </Box>
              )}
              {!!uploadDlg.result.details?.updated?.length && (
                <Box sx={{ mt: 1 }}>
                  <b>שינויים:</b>
                  <List dense>
                    {uploadDlg.result.details.updated.slice(0, 20).map((u, i) => (
                      <ListItem key={i} sx={{ py: 0 }}>
                        <ListItemText primary={u.name} secondary={u.changes.join(' · ')} />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadDlg(d => ({ ...d, open: false }))}>סגירה</Button>
          <Button variant="contained" onClick={handleUpload} disabled={uploadDlg.saving || !uploadDlg.file}>
            {uploadDlg.saving ? 'קולט…' : 'קליטה'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- כרטיס ילד: שני הצדדים זה מול זה ---- */}
      <Dialog open={!!detail} onClose={() => setDetail(null)} maxWidth="md" fullWidth>
        {detail && (
          <>
            <DialogTitle>
              {detail.child_name}
              <Chip size="small" sx={{ mr: 1 }} label={detail.verdict_label}
                color={VERDICT_STYLE[detail.verdict]?.color || 'default'} />
            </DialogTitle>
            <DialogContent>
              <Alert severity={detail.verdict === 'approved' ? 'success' : 'warning'} sx={{ mb: 2 }}>
                {detail.verdict_action}
              </Alert>

              {!!detail.issues.length && (
                <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>חריגות</Typography>
                  {detail.issues.map(i => (
                    <Typography key={i.code} variant="body2">
                      • {i.label}{i.detail ? ` — ${i.detail}` : ''}
                    </Typography>
                  ))}
                </Card>
              )}

              <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                  גיל בפתיחת השנה
                </Typography>
                <Typography variant="body2">
                  ב־1 בספטמבר: <b>{detail.age_at_year_start?.label || '—'}</b>
                  {detail.age_source ? ` (לפי תאריך הלידה ב${detail.age_source})` : ''}
                </Typography>
                <Typography variant="body2">
                  לפי הגיל בלבד: {detail.age_at_year_start?.suggested_group || '—'} ·
                  {' '}בקבצים: {detail.age_group || '—'}
                  {detail.age_group_override ? ` · שובץ ידנית ל${detail.age_group_override}` : ''}
                </Typography>
              </Card>

              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <Card variant="outlined" sx={{ p: 1.5, flex: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>משרד התמ"ת</Typography>
                  {detail.tmt ? (
                    <>
                      <Typography variant="body2">שם: {detail.tmt.full_name}</Typography>
                      <Typography variant="body2">תאריך לידה: {fmtDate(detail.tmt.birth_date)}</Typography>
                      <Typography variant="body2">קבוצת גיל: {detail.tmt.age_group}</Typography>
                      <Typography variant="body2">החלטה: {detail.tmt.decision}</Typography>
                      <Typography variant="body2">
                        תאריך כניסה לגן: {detail.tmt.absorbed_at
                          ? fmtDate(detail.tmt.absorbed_at)
                          : 'טרם הוזן בפורטל התמ"ת'}
                      </Typography>
                      <Typography variant="body2">ילד ממשיך: {detail.tmt.continuing == null ? '—' : (detail.tmt.continuing ? 'כן' : 'לא')}</Typography>
                      <Typography variant="body2">ילד רווחה: {detail.tmt.welfare == null ? '—' : (detail.tmt.welfare ? 'כן' : 'לא')}</Typography>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="body2">איש קשר: {detail.tmt.contact_name || '—'}</Typography>
                      <Typography variant="body2">טלפון: {detail.tmt.contact_phone || '—'}</Typography>
                      <Typography variant="body2">מייל: {detail.tmt.contact_email || '—'}</Typography>
                      {!detail.tmt.is_present && (
                        <Alert severity="error" sx={{ mt: 1 }}>
                          ירד/ה מרשימת התמ"ת בתאריך {fmtDate(detail.tmt.missing_since)}
                        </Alert>
                      )}
                    </>
                  ) : <Typography color="error">לא מופיע/ה ברשימת התמ"ת</Typography>}
                </Card>

                <Card variant="outlined" sx={{ p: 1.5, flex: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>קליקטאק</Typography>
                  {detail.clicktac ? (
                    <>
                      <Typography variant="body2">שם: {detail.clicktac.full_name}</Typography>
                      <Typography variant="body2">תאריך לידה: {fmtDate(detail.clicktac.birth_date)}</Typography>
                      <Typography variant="body2">שכבת גיל: {detail.clicktac.age_group}</Typography>
                      <Typography variant="body2">סטטוס: {detail.clicktac.status}</Typography>
                      <Typography variant="body2">חותם שני: {detail.clicktac.second_signer || '—'}</Typography>
                      <Typography variant="body2">תאריך הרשמה: {fmtDate(detail.clicktac.registered_at)}</Typography>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="body2">
                        {detail.clicktac.parent1_name} · {detail.clicktac.parent1_phone}
                      </Typography>
                      <Typography variant="body2">
                        {detail.clicktac.parent2_name} · {detail.clicktac.parent2_phone}
                      </Typography>
                      <Typography variant="body2">{detail.clicktac.address}</Typography>
                      {detail.clicktac.review_status === 'imported' && (
                        <Alert severity="info" sx={{ mt: 1 }}>הרשומה כבר נקלטה למערכת כרישום</Alert>
                      )}
                    </>
                  ) : <Typography color="error">לא נרשם/ה בקליקטאק</Typography>}
                </Card>
              </Stack>

              {!!detail.tmt?.changes?.length && (
                <Card variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>שינויים בין העלאות תמ"ת</Typography>
                  {detail.tmt.changes.map((c, i) => (
                    <Typography key={i} variant="body2">
                      {fmtDateTime(c.at)} — {c.field}: {c.from} ← {c.to}
                    </Typography>
                  ))}
                </Card>
              )}
            </DialogContent>
            <DialogActions><Button onClick={() => setDetail(null)}>סגירה</Button></DialogActions>
          </>
        )}
      </Dialog>

      {/* ---- החלת המסקנות ---- */}
      <Dialog open={applyDlg.open} onClose={() => setApplyDlg({ open: false, saving: false, result: null })} maxWidth="sm" fullWidth>
        <DialogTitle>החלת מסקנות ההצלבה</DialogTitle>
        <DialogContent>
          {!applyDlg.result ? (
            <>
              <Alert severity="warning" sx={{ mb: 2 }}>
                <AlertTitle>מה תעשה הפעולה</AlertTitle>
                כל מי שההצלבה פוסלת — נרשם ללא אישור תמ"ת, ביטל רישום, או החלטת תמ"ת שאינה אישור —
                יסומן בתור קליקטאק כ"לא רלוונטי" עם הסיבה, ולא יוצע יותר לקליטה.
                כל מי שמאושר ונפסל בעבר בטעות — יוחזר לרשימת הממתינים.
              </Alert>
              <Alert severity="info">
                ילדים שכבר נקלטו למערכת כרישום <b>לא ישונו</b>. הוצאת ילד שכבר נקלט משמעה סגירת רישום,
                ביטול הוראת קבע ופינוי מקום בכיתה — הפעולה תציג אותם ברשימה נפרדת להחלטה שלך.
              </Alert>
            </>
          ) : (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>
                סומנו כלא רלוונטיים: {applyDlg.result.dropped} · הוחזרו לממתינים: {applyDlg.result.restored}
              </Alert>
              {!!applyDlg.result.needs_manual?.length && (
                <Alert severity="warning">
                  <AlertTitle>דורש טיפול ידני — כבר נקלטו למערכת</AlertTitle>
                  {applyDlg.result.needs_manual.map(m => (
                    <Typography key={m.id_number} variant="body2">
                      {m.child_name} ({m.id_number}) — {m.verdict_label}
                    </Typography>
                  ))}
                </Alert>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApplyDlg({ open: false, saving: false, result: null })}>סגירה</Button>
          {!applyDlg.result && (
            <Button variant="contained" color="warning" onClick={handleApply} disabled={applyDlg.saving}>
              {applyDlg.saving ? 'מחיל…' : 'החלה'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* ---- היסטוריית העלאות ---- */}
      <Dialog open={historyDlg.open} onClose={() => setHistoryDlg({ open: false, loading: false, imports: [] })} maxWidth="md" fullWidth>
        <DialogTitle>היסטוריית העלאות</DialogTitle>
        <DialogContent>
          {historyDlg.loading ? <CircularProgress /> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מקור</TableCell><TableCell>תאריך</TableCell><TableCell>קובץ</TableCell>
                  <TableCell>שורות</TableCell><TableCell>חדשים</TableCell><TableCell>עודכנו</TableCell>
                  <TableCell>ירדו</TableCell><TableCell>מי העלה</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {historyDlg.imports.map(i => (
                  <TableRow key={i.id}>
                    <TableCell>{i.source === 'tmt' ? 'תמ"ת' : 'קליקטאק'}</TableCell>
                    <TableCell>{fmtDateTime(i.created_at)}</TableCell>
                    <TableCell>{i.file_name}</TableCell>
                    <TableCell>{i.parsed}</TableCell>
                    <TableCell>{i.created}</TableCell>
                    <TableCell>{i.updated}</TableCell>
                    <TableCell>{i.missing}</TableCell>
                    <TableCell>{i.imported_by_name}</TableCell>
                  </TableRow>
                ))}
                {!historyDlg.imports.length && (
                  <TableRow><TableCell colSpan={8} align="center">אין העלאות</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryDlg({ open: false, loading: false, imports: [] })}>סגירה</Button>
        </DialogActions>
      </Dialog>

      {/* ---- דף קשר ---- */}
      <Dialog open={contactsDlg.open} onClose={() => setContactsDlg({ open: false, loading: false, rows: [] })} maxWidth="lg" fullWidth>
        <DialogTitle>דף קשר — מאושרים לשנה הבאה ({contactsDlg.rows.length})</DialogTitle>
        <DialogContent>
          {contactsDlg.loading ? <CircularProgress /> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ילד/ה</TableCell><TableCell>שכבה</TableCell>
                  <TableCell>הורה 1</TableCell><TableCell>טלפון</TableCell>
                  <TableCell>הורה 2</TableCell><TableCell>טלפון</TableCell>
                  <TableCell>מייל</TableCell><TableCell>כתובת</TableCell>
                  <TableCell>איש קשר תמ"ת</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {contactsDlg.rows.map(c => (
                  <TableRow key={c.id_number}>
                    <TableCell>{c.child_name}</TableCell>
                    <TableCell>{c.age_group}</TableCell>
                    <TableCell>{c.parent1_name}</TableCell>
                    <TableCell>{c.parent1_phone}</TableCell>
                    <TableCell>{c.parent2_name}</TableCell>
                    <TableCell>{c.parent2_phone}</TableCell>
                    <TableCell>{c.parent1_email}</TableCell>
                    <TableCell>{c.address}</TableCell>
                    <TableCell>{c.tmt_contact_name} {c.tmt_contact_phone}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button startIcon={<DownloadIcon />} onClick={handleExport}>ייצוא לאקסל</Button>
          <Button onClick={() => setContactsDlg({ open: false, loading: false, rows: [] })}>סגירה</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
