import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, IconButton, Tooltip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Alert,
  LinearProgress, Checkbox,
} from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import GavelIcon from '@mui/icons-material/Gavel';
import DescriptionIcon from '@mui/icons-material/Description';
import AssignmentIndIcon from '@mui/icons-material/AssignmentInd';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import ThumbUpAltIcon from '@mui/icons-material/ThumbUpAlt';
import BadgeIcon from '@mui/icons-material/Badge';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { mergePdfs, downloadBlob } from '../../utils/mergePdfs';

/**
 * תיק המסמכים של העובד/ת — everything the system holds about one person.
 *
 * The files were never missing; they were scattered. A contract lived on the
 * contracts screen, a 101 on the 101 screen, a certificate on the courses
 * screen, a sick note on the request that carried it, payslips in the payroll
 * archive, and the letters this system issued in a table of their own. Asked
 * "what do we have on her" — at a hearing, at a termination, at a ministry
 * inspection — a manager had to remember six screens exist.
 *
 * So this is a reader, not a new store. Every row still downloads from the
 * screen that owns it, which is why permissions and file storage did not have
 * to be reinvented, and why nothing here can drift out of step with the source.
 *
 * The one thing it writes is an upload: the documents that belong to no
 * existing flow — a recommendation, a ת"ז copy, a bank form, an old payslip
 * that predates the system — which had nowhere to go at all.
 */

const SHELF = {
  employment_contract: { label: 'חוזה העסקה', icon: <GavelIcon fontSize="small" />, color: 'primary' },
  form_101: { label: 'טופס 101', icon: <AssignmentIndIcon fontSize="small" />, color: 'warning' },
  // One shelf for both: a payslip and its month's hours report are asked for
  // together almost every time, and were two shelves apart. The server still
  // files them as two rows; the screen folds them into one row per month.
  payroll: { label: 'תלושים ודוחות שעות', icon: <ReceiptLongIcon fontSize="small" />, color: 'success' },
  payslip: { label: 'תלושי שכר', icon: <ReceiptLongIcon fontSize="small" />, color: 'success' },
  hours_report: { label: 'דוחות שעות', icon: <ScheduleIcon fontSize="small" />, color: 'info' },
  certificate: { label: 'תעודות והסמכות', icon: <WorkspacePremiumIcon fontSize="small" />, color: 'success' },
  health: { label: 'אישורים רפואיים', icon: <LocalHospitalIcon fontSize="small" />, color: 'error' },
  recommendation: { label: 'המלצות', icon: <ThumbUpAltIcon fontSize="small" />, color: 'primary' },
  id_document: { label: 'צילום ת״ז', icon: <BadgeIcon fontSize="small" />, color: 'default' },
  bank_details: { label: 'פרטי בנק', icon: <AccountBalanceIcon fontSize="small" />, color: 'default' },
  letter: { label: 'מסמכים שהונפקו', icon: <DescriptionIcon fontSize="small" />, color: 'primary' },
  other: { label: 'אחר', icon: <FolderOpenIcon fontSize="small" />, color: 'default' },
};

/**
 * What a person may FILE here.
 *
 * A payslip and an hours report are on the list because the years before this
 * system existed are on paper, and a scanned 2019 payslip has nowhere else to
 * live. 'letter' is not: a letter is issued, and offering to upload one would
 * invite a copy of a document beside the original the system rendered.
 */
const UPLOADABLE = [
  'employment_contract', 'form_101', 'recommendation', 'certificate',
  'id_document', 'bank_details', 'health', 'payslip', 'hours_report', 'other',
];

/** Where a row is shown. Payslips and hours reports share the payroll shelf. */
const shelfOf = (item) => (item.shelf === 'payslip' || item.shelf === 'hours_report' ? 'payroll' : item.shelf);
/** The month a payroll row belongs to — its id is `payslip-YYYY-MM` / `hours-YYYY-MM`. */
const monthOf = (item) => (item.id.match(/(\d{4}-\d{2})$/) || [])[1] || '';

/** The bytes behind a row, whichever way its endpoint hands them over. */
async function fetchBlob(item) {
  if (item.fetch_mode === 'base64') {
    const res = await api.get(item.href);
    const { data, mimetype } = res.data;
    const bytes = atob(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mimetype || 'application/octet-stream' });
  }
  const res = await api.get(item.href, { responseType: 'blob' });
  return res.data;
}

const fmtDate = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('he-IL'); } catch { return ''; }
};

/** Open a file the API answers with, carrying the bearer token the tab lacks. */
async function openFromApi(href, { download = false, filename = '' } = {}) {
  const res = await api.get(href, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'מסמך';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, '_blank');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function EmployeeFileCabinet({ employeeId, refreshKey = 0, onChanged }) {
  const [items, setItems] = useState([]);
  const [employeeName, setEmployeeName] = useState('');
  const [selected, setSelected] = useState(() => new Set()); // item ids picked for one bundle
  const [bundling, setBundling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shelfFilter, setShelfFilter] = useState('');
  const [busyRow, setBusyRow] = useState('');
  const [upload, setUpload] = useState(null); // { file, name, doc_type, description, tax_year }
  const [saving, setSaving] = useState(false);
  const fileInput = useRef(null);

  const load = useCallback(() => {
    if (!employeeId) { setItems([]); return; }
    setLoading(true);
    api.get(`/employee-file/${employeeId}`)
      .then(res => { setItems(res.data.items || []); setEmployeeName(res.data.employee?.full_name || ''); setSelected(new Set()); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת תיק המסמכים'))
      .finally(() => setLoading(false));
  }, [employeeId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const counts = useMemo(() => {
    const m = {};
    for (const it of items) m[shelfOf(it)] = (m[shelfOf(it)] || 0) + 1;
    return m;
  }, [items]);

  // Shelves in the fixed order above, so the screen does not reshuffle itself
  // as documents come and go; empty ones are simply absent.
  const shelvesInUse = useMemo(
    () => Object.keys(SHELF).filter(k => counts[k]),
    [counts],
  );

  const visible = useMemo(
    () => (shelfFilter ? items.filter(i => shelfOf(i) === shelfFilter) : items),
    [items, shelfFilter],
  );

  const grouped = useMemo(() => {
    const m = new Map();
    for (const it of visible) {
      const k = shelfOf(it);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return Object.keys(SHELF).filter(k => m.has(k)).map(k => [k, m.get(k)]);
  }, [visible]);

  // The payroll shelf, one row per month: the payslip (when it was produced)
  // and the hours report side by side, newest month first.
  const payrollMonths = useMemo(() => {
    const byMonth = new Map();
    for (const it of items) {
      if (shelfOf(it) !== 'payroll') continue;
      const ym = monthOf(it);
      if (!byMonth.has(ym)) byMonth.set(ym, { ym, payslip: null, hours: null });
      byMonth.get(ym)[it.shelf === 'payslip' ? 'payslip' : 'hours'] = it;
    }
    return [...byMonth.values()].sort((a, b) => b.ym.localeCompare(a.ym));
  }, [items]);

  /* --- one PDF out of several rows ---------------------------------- */
  const toggle = (ids, on) => setSelected(prev => {
    const next = new Set(prev);
    ids.forEach(id => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const isSelected = (ids) => ids.length > 0 && ids.every(id => selected.has(id));

  /**
   * Fetch each chosen row through its own endpoint and staple them in the
   * order they appear on the screen — shelf by shelf, newest first — so six
   * months of payslips come out in the order a reader expects.
   */
  const bundle = async (chosen, filename) => {
    if (!chosen.length) return;
    setBundling(true);
    try {
      const parts = [];
      for (const it of chosen) {
        try {
          parts.push({ blob: await fetchBlob(it), name: it.title });
        } catch {
          parts.push({ blob: new Blob([], { type: 'text/plain' }), name: it.title }); // reported as skipped below
        }
      }
      const { blob, pages, skipped } = await mergePdfs(parts);
      if (!pages) { toast.error('אף אחד מהמסמכים שנבחרו אינו PDF או תמונה'); return; }
      downloadBlob(blob, filename);
      if (skipped.length) toast.warn(`לא נכללו (לא PDF/תמונה): ${skipped.join(', ')}`, { autoClose: 8000 });
      else toast.success(`הופק קובץ אחד — ${pages} עמודים`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפקת הקובץ נכשלה');
    } finally { setBundling(false); }
  };
  const bundleSelected = () => {
    const chosen = [];
    for (const [, rows] of grouped) for (const it of rows) if (selected.has(it.id)) chosen.push(it);
    bundle(chosen, `${employeeName || 'עובד'} — מסמכים.pdf`);
  };
  const bundleMonth = (m) => bundle(
    [m.payslip, m.hours].filter(Boolean),
    `${employeeName || 'עובד'} — ${m.ym} תלוש ודוח שעות.pdf`,
  );

  const openItem = async (item, { download = false, refresh = false } = {}) => {
    setBusyRow(item.id);
    try {
      const href = refresh && item.refresh_href ? item.refresh_href : item.href;
      if (item.fetch_mode === 'base64') {
        const res = await api.get(href);
        const { data, mimetype, name } = res.data;
        const bytes = atob(data);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([arr], { type: mimetype || 'application/octet-stream' }));
        if (download) {
          const a = document.createElement('a');
          a.href = url; a.download = name || item.file_name || 'מסמך';
          document.body.appendChild(a); a.click(); a.remove();
        } else {
          window.open(url, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        await openFromApi(href, { download, filename: item.file_name || item.title });
      }
      // A refresh re-renders the month and replaces the stored copy, so the
      // "שמור בתיק" badge on the row is now out of date.
      if (refresh) load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בפתיחת המסמך');
    } finally { setBusyRow(''); }
  };

  const removeItem = async (item) => {
    if (!item.delete_href) return;
    if (!window.confirm(`למחוק את "${item.title}"? הפעולה אינה הפיכה.`)) return;
    try {
      await api.delete(item.delete_href);
      toast.success('נמחק');
      load();
      onChanged && onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה במחיקה'); }
  };

  const pickFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file twice still fires
    if (!file) return;
    setUpload({
      file,
      // The filename without its extension is almost always the right label,
      // and retyping it for every document is how uploads stop happening.
      name: file.name.replace(/\.[^.]+$/, ''),
      doc_type: 'other',
      description: '',
      tax_year: new Date().getFullYear(),
    });
  };

  const doUpload = async () => {
    if (!upload?.file || !upload.name.trim()) {
      toast.error('בחרו קובץ ותנו לו שם');
      return;
    }
    setSaving(true);
    const body = new FormData();
    body.append('file', upload.file);
    body.append('employee_id', employeeId);
    body.append('name', upload.name.trim());
    body.append('description', upload.description || '');
    body.append('doc_type', upload.doc_type);
    if (upload.doc_type === 'form_101') body.append('tax_year', String(upload.tax_year));
    try {
      await api.post('/employee-documents', body);
      toast.success('המסמך נוסף לתיק');
      setUpload(null);
      load();
      onChanged && onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהעלאה');
    } finally { setSaving(false); }
  };

  if (!employeeId) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
        <FolderOpenIcon color="primary" />
        <Typography sx={{ fontWeight: 800, flex: 1 }}>תיק המסמכים</Typography>
        <Chip size="small" label={`${items.length} מסמכים`} />
        {selected.size > 0 && (
          <>
            <Button
              size="small" variant="outlined" color="secondary" startIcon={<PictureAsPdfIcon />}
              onClick={bundleSelected} disabled={bundling}
            >
              {bundling ? 'מפיק…' : `הפק PDF אחד (${selected.size})`}
            </Button>
            <Button size="small" color="inherit" onClick={() => setSelected(new Set())} disabled={bundling}>נקה בחירה</Button>
          </>
        )}
        <input
          type="file" ref={fileInput} onChange={pickFile}
          style={{ display: 'none' }}
        />
        <Button
          size="small" variant="contained" startIcon={<UploadFileIcon />}
          onClick={() => fileInput.current?.click()}
        >
          העלאת מסמך
        </Button>
      </Stack>

      {loading && <LinearProgress sx={{ mb: 1 }} />}

      {items.length === 0 && !loading ? (
        <Alert severity="info" icon={false}>
          אין עדיין מסמכים בתיק. חוזה, טופס 101, תעודות, תלושים ודוחות שעות מופיעים כאן מעצמם
          ברגע שהם נוצרים במערכת — וכל מסמך אחר אפשר להעלות מכאן.
        </Alert>
      ) : (
        <>
          <Stack direction="row" spacing={0.7} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Chip
              size="small" label={`הכול (${items.length})`}
              color={shelfFilter ? 'default' : 'primary'}
              variant={shelfFilter ? 'outlined' : 'filled'}
              onClick={() => setShelfFilter('')}
            />
            {shelvesInUse.map(k => (
              <Chip
                key={k} size="small"
                label={`${SHELF[k].label} (${counts[k]})`}
                color={shelfFilter === k ? 'primary' : 'default'}
                variant={shelfFilter === k ? 'filled' : 'outlined'}
                onClick={() => setShelfFilter(shelfFilter === k ? '' : k)}
              />
            ))}
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            סמנו כמה מסמכים כדי להפיק אותם כקובץ PDF אחד — למשל תלושים של חצי שנה.
          </Typography>

          <Stack spacing={2}>
            {grouped.map(([shelf, rows]) => (
              <Box key={shelf}>
                <Stack direction="row" alignItems="center" spacing={0.8} sx={{ mb: 0.6 }}>
                  <Checkbox
                    size="small" sx={{ p: 0.3 }}
                    checked={isSelected(rows.map(r => r.id))}
                    indeterminate={!isSelected(rows.map(r => r.id)) && rows.some(r => selected.has(r.id))}
                    onChange={(e) => toggle(rows.map(r => r.id), e.target.checked)}
                    inputProps={{ 'aria-label': `בחר את כל ${SHELF[shelf].label}` }}
                  />
                  <Box sx={{ color: 'text.secondary', display: 'flex' }}>{SHELF[shelf].icon}</Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                    {SHELF[shelf].label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">({rows.length})</Typography>
                </Stack>
                <Divider sx={{ mb: 0.8 }} />
                {shelf === 'payroll' ? (
                  <Stack spacing={0.6}>
                    {payrollMonths.filter(m => rows.some(r => monthOf(r) === m.ym)).map(m => {
                      const ids = [m.payslip, m.hours].filter(Boolean).map(i => i.id);
                      const busy = ids.includes(busyRow);
                      return (
                        <Stack
                          key={m.ym} direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap
                          sx={{ px: 1.2, py: 0.8, borderRadius: 2, bgcolor: 'background.default', opacity: busy ? 0.5 : 1 }}
                        >
                          <Checkbox size="small" sx={{ p: 0.3 }} checked={isSelected(ids)} onChange={(e) => toggle(ids, e.target.checked)} />
                          <Typography variant="body2" sx={{ fontWeight: 800, minWidth: 90 }}>{m.ym}</Typography>
                          {/* the payslip */}
                          <Stack direction="row" alignItems="center" spacing={0.3} sx={{ minWidth: 220 }}>
                            <ReceiptLongIcon fontSize="small" sx={{ color: m.payslip ? 'success.main' : 'text.disabled' }} />
                            <Typography variant="caption" sx={{ fontWeight: 700, color: m.payslip ? 'text.primary' : 'text.disabled' }}>
                              תלוש
                            </Typography>
                            {m.payslip ? (
                              <>
                                {(m.payslip.badges || []).map(b => (
                                  <Chip key={b} size="small" variant="outlined" label={b} sx={{ height: 20, fontSize: '0.65rem' }} />
                                ))}
                                <Tooltip title="פתח תלוש"><IconButton size="small" onClick={() => openItem(m.payslip)}><OpenInNewIcon fontSize="small" /></IconButton></Tooltip>
                                <Tooltip title="הורד תלוש"><IconButton size="small" onClick={() => openItem(m.payslip, { download: true })}><DownloadIcon fontSize="small" /></IconButton></Tooltip>
                              </>
                            ) : (
                              <Typography variant="caption" color="text.disabled">— טרם הופק</Typography>
                            )}
                          </Stack>
                          {/* the hours report */}
                          <Stack direction="row" alignItems="center" spacing={0.3} sx={{ minWidth: 220 }}>
                            <ScheduleIcon fontSize="small" sx={{ color: m.hours ? 'info.main' : 'text.disabled' }} />
                            <Typography variant="caption" sx={{ fontWeight: 700, color: m.hours ? 'text.primary' : 'text.disabled' }}>
                              דוח שעות
                            </Typography>
                            {m.hours ? (
                              <>
                                {(m.hours.badges || []).map(b => (
                                  <Chip key={b} size="small" variant="outlined" label={b} sx={{ height: 20, fontSize: '0.65rem' }} />
                                ))}
                                <Tooltip title="פתח דוח שעות"><IconButton size="small" onClick={() => openItem(m.hours)}><OpenInNewIcon fontSize="small" /></IconButton></Tooltip>
                                <Tooltip title="הורד דוח שעות"><IconButton size="small" onClick={() => openItem(m.hours, { download: true })}><DownloadIcon fontSize="small" /></IconButton></Tooltip>
                                {m.hours.refresh_href && (
                                  <Tooltip title="חשב מחדש מול ההחתמות של היום ושמור עותק מעודכן בתיק">
                                    <IconButton size="small" onClick={() => openItem(m.hours, { refresh: true })}><RefreshIcon fontSize="small" /></IconButton>
                                  </Tooltip>
                                )}
                              </>
                            ) : (
                              <Typography variant="caption" color="text.disabled">—</Typography>
                            )}
                          </Stack>
                          <Box sx={{ flex: 1 }} />
                          {m.payslip && m.hours && (
                            <Tooltip title="תלוש + דוח שעות של החודש בקובץ PDF אחד">
                              <Button
                                size="small" variant="outlined" startIcon={<PictureAsPdfIcon />}
                                onClick={() => bundleMonth(m)} disabled={bundling}
                                sx={{ py: 0, fontSize: '0.72rem' }}
                              >
                                הפק יחד
                              </Button>
                            </Tooltip>
                          )}
                        </Stack>
                      );
                    })}
                  </Stack>
                ) : (
                <Stack spacing={0.6}>
                  {rows.map(item => (
                    <Stack
                      key={item.id}
                      direction="row" alignItems="center" spacing={1}
                      flexWrap="wrap" useFlexGap
                      sx={{
                        px: 1.2, py: 0.8, borderRadius: 2,
                        bgcolor: 'background.default',
                        opacity: busyRow === item.id ? 0.5 : 1,
                      }}
                    >
                      <Checkbox size="small" sx={{ p: 0.3 }} checked={selected.has(item.id)} onChange={(e) => toggle([item.id], e.target.checked)} />
                      <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 180 }}>
                        {item.title}
                      </Typography>
                      {item.subtitle && (
                        <Typography variant="caption" color="text.secondary">
                          {item.subtitle}
                        </Typography>
                      )}
                      {(item.badges || []).map(b => (
                        <Chip key={b} size="small" variant="outlined" label={b}
                          sx={{ height: 20, fontSize: '0.65rem' }} />
                      ))}
                      <Box sx={{ flex: 1 }} />
                      <Typography variant="caption" color="text.secondary">
                        {fmtDate(item.date)}
                      </Typography>
                      <Tooltip title="פתח">
                        <IconButton size="small" onClick={() => openItem(item)}>
                          <OpenInNewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="הורד">
                        <IconButton size="small" onClick={() => openItem(item, { download: true })}>
                          <DownloadIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      {item.refresh_href && (
                        <Tooltip title="חשב מחדש מול ההחתמות של היום ושמור עותק מעודכן בתיק">
                          <IconButton size="small" onClick={() => openItem(item, { refresh: true })}>
                            <RefreshIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      {item.deletable && (
                        <Tooltip title="מחק">
                          <IconButton size="small" color="error" onClick={() => removeItem(item)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                  ))}
                </Stack>
                )}
              </Box>
            ))}
          </Stack>
        </>
      )}

      <Dialog open={!!upload} onClose={() => !saving && setUpload(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle sx={{ fontWeight: 800 }}>הוספת מסמך לתיק</DialogTitle>
        <DialogContent dividers>
          {saving && <LinearProgress sx={{ mb: 1.5 }} />}
          <Stack spacing={1.8} sx={{ mt: 0.5 }}>
            <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
              {upload?.file?.name} · {upload ? (upload.file.size / 1024 / 1024).toFixed(1) : 0}MB
            </Alert>
            <TextField
              size="small" label="שם המסמך" fullWidth autoFocus
              value={upload?.name || ''}
              onChange={e => setUpload(u => ({ ...u, name: e.target.value }))}
            />
            <TextField
              select size="small" label="סוג המסמך" fullWidth
              value={upload?.doc_type || 'other'}
              onChange={e => setUpload(u => ({ ...u, doc_type: e.target.value }))}
              helperText="קובע באיזה מדף בתיק המסמך יישב"
            >
              {UPLOADABLE.map(k => (
                <MenuItem key={k} value={k}>{SHELF[k].label}</MenuItem>
              ))}
            </TextField>
            {upload?.doc_type === 'form_101' && (
              <TextField
                size="small" type="number" label="שנת מס" fullWidth
                value={upload.tax_year}
                onChange={e => setUpload(u => ({ ...u, tax_year: e.target.value }))}
                helperText="טופס 101 מוגש מחדש בכל ינואר, ולכן הוא נשמר לפי שנה"
              />
            )}
            <TextField
              size="small" label="הערה (אופציונלי)" fullWidth multiline minRows={2}
              value={upload?.description || ''}
              onChange={e => setUpload(u => ({ ...u, description: e.target.value }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUpload(null)} disabled={saving}>ביטול</Button>
          <Button variant="contained" onClick={doUpload} disabled={saving}>שמור בתיק</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
