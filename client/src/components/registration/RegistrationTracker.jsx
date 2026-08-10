import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, Stack, Chip, IconButton, Tooltip,
  TextField, InputAdornment, Button, MenuItem, Checkbox,
  Dialog, DialogTitle, DialogContent, DialogActions, Divider, CircularProgress, Alert,
  ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import DescriptionIcon from '@mui/icons-material/Description';
import LinkIcon from '@mui/icons-material/Link';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import FolderIcon from '@mui/icons-material/Folder';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import HistoryEduIcon from '@mui/icons-material/HistoryEdu';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ContentCopyTwoToneIcon from '@mui/icons-material/ContentCopyTwoTone';
import { toast } from 'react-toastify';
import api, { openApiFile } from '../../api/client';
import { formatAcademicYear, getAcademicYears } from '../../hooks/useAcademicYear';
import ConfirmDialog from '../shared/ConfirmDialog';
import { getAcademicYearRange } from '../../utils/hebrewYear';
import { printContractHtml } from '../../utils/contractPdf';

const STATUS_CONFIG = {
  link_generated: { label: 'בתהליך', color: '#fef3c7', textColor: '#92400e', border: '#f59e0b' },
  contract_signed: { label: 'חוזה נחתם', color: '#dbeafe', textColor: '#1e40af', border: '#3b82f6' },
  docs_uploaded: { label: 'מסמכים הועלו', color: '#e0e7ff', textColor: '#3730a3', border: '#6366f1' },
  completed: { label: 'הושלם', color: '#dcfce7', textColor: '#166534', border: '#22c55e' },
};

export default function RegistrationTracker() {
  const navigate = useNavigate();
  const [registrations, setRegistrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [missingSigOnly, setMissingSigOnly] = useState(false);
  const [missingDocsOnly, setMissingDocsOnly] = useState(false);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  // Moving registrations between gan years — one card, or everything ticked.
  const [selected, setSelected] = useState([]);
  const [yearDlg, setYearDlg] = useState({ open: false, regs: [], year: '', saving: false, conflict: null });
  const [confirm, setConfirm] = useState({ open: false, id: null });
  const [renewDlg, setRenewDlg] = useState({ open: false, reg: null, monthlyFee: '', regFee: '', saving: false, mode: 'link', file: null });
  const [docsDialog, setDocsDialog] = useState({ open: false, reg: null, documents: [], loading: false });
  const [docTypeForUpload, setDocTypeForUpload] = useState('id_copy');
  // Which upload is in flight — drives the spinner so a slow upload never looks
  // like a frozen button.
  const [uploading, setUploading] = useState('');

  const apiBase = '';

  const openDocsDialog = async (reg) => {
    setDocsDialog({ open: true, reg, documents: [], loading: true });
    try {
      const res = await api.get(`/documents/${reg._id || reg.id}`);
      setDocsDialog(prev => ({ ...prev, documents: res.data.documents || [], loading: false }));
    } catch {
      setDocsDialog(prev => ({ ...prev, loading: false }));
      toast.error('שגיאה בטעינת מסמכים');
    }
  };

  const closeDocsDialog = () => setDocsDialog({ open: false, reg: null, documents: [], loading: false });

  const refreshDocs = async () => {
    if (!docsDialog.reg) return;
    try {
      const res = await api.get(`/documents/${docsDialog.reg._id || docsDialog.reg.id}`);
      setDocsDialog(prev => ({ ...prev, documents: res.data.documents || [] }));
    } catch { /* ignore */ }
    fetchData();
  };

  const handleUploadDocument = async (file, docType) => {
    if (!file || !docsDialog.reg) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('doc_type', docType);
    fd.append('registration_id', docsDialog.reg._id || docsDialog.reg.id);
    setUploading('doc');
    try {
      await api.post('/documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('מסמך הועלה');
      refreshDocs();
    } catch {
      toast.error('שגיאה בהעלאה');
    } finally { setUploading(''); }
  };

  const handleFinalizeManual = async (file) => {
    if (!docsDialog.reg) return;
    const fd = new FormData();
    if (file) fd.append('contract_file', file);
    setUploading(file ? 'contract' : 'finalize');
    try {
      await api.post(
        `/registrations/${docsDialog.reg._id || docsDialog.reg.id}/finalize-manual`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      toast.success('רישום סומן כהושלם');
      setDocsDialog(prev => prev.reg ? { ...prev, reg: { ...prev.reg, status: 'completed', agreement_signed: true, card_completed: true } } : prev);
      await refreshDocs();
    } catch {
      toast.error('שגיאה בסיום ידני');
    } finally { setUploading(''); }
  };

  const downloadContract = async (regId) => {
    try {
      const res = await api.get(`/registrations/${regId}/contract-download`);
      if (res.data?.html) {
        toast.info('נפתחת תצוגת הדפסה — בחר/י "שמירה כ-PDF"');
        await printContractHtml(res.data.html);
      } else if (res.data?.url) {
        // Stored PDF — served by the API behind auth, or an old Drive link.
        await openApiFile(res.data.url, { filename: `חוזה_${docsDialog.reg?.child_name || regId}.pdf` });
      } else {
        toast.error('אין חוזה זמין');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין חוזה זמין');
    }
  };

  const downloadDoc = (docId) => {
    openApiFile(`/api/documents/${docId}/download`).catch((e) => toast.error(e.message));
  };

  const DOC_TYPE_LABELS = {
    id_copy: 'תעודת זהות',
    payment_proof: 'אישור תשלום',
    signed_contract: 'חוזה חתום',
    medical: 'אישור רפואי',
    general: 'מסמך כללי',
  };

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get('/registrations')
      .then(res => setRegistrations(res.data.registrations || []))
      .catch(() => toast.error('שגיאה בטעינת רישומים'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // The year a registration is FILED under, which is a stored decision — not
  // whatever its start date happens to imply. A registration typed with last
  // year's dates is exactly the case this page has to be able to show and fix.
  const yearOf = (r) => r.academic_year || getAcademicYearRange(r.start_date) || '';

  const yearOptions = Array.from(
    new Set(registrations.map(yearOf).filter(Boolean))
  ).sort();

  // Years a registration can be moved INTO: the ones already in use, plus the
  // window around today — a year with nobody in it yet is precisely where a
  // misfiled registration usually needs to go.
  const years = getAcademicYears();
  const moveTargets = Array.from(new Set([
    ...yearOptions,
    `${years.current.value - 1}-${years.current.value}`,
    years.current.range,
    years.next.range,
    `${years.next.value + 1}-${years.next.value + 2}`,
  ])).sort();

  const filtered = registrations.filter(r => {
    const q = search.trim().toLowerCase();
    if (q && !r.child_name?.toLowerCase().includes(q) && !r.parent_name?.toLowerCase().includes(q)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (yearFilter && yearOf(r) !== yearFilter) return false;
    if (missingSigOnly && !r.signature_missing) return false;
    if (missingDocsOnly && !r.documents_missing) return false;
    if (duplicatesOnly && !r.duplicate_in_year) return false;
    return true;
  });

  const selectedRegs = registrations.filter(r => selected.includes(r._id || r.id));

  const toggleSelected = (id) => setSelected(
    prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]),
  );

  const openYearDialog = (regs) => setYearDlg({
    open: true,
    regs,
    // Pre-filled with the year after the one they are in, because the mistake
    // this fixes is almost always a renewal filed as the current year.
    year: (() => {
      const from = regs.length === 1 ? yearOf(regs[0]) : '';
      if (!from) return years.next.range;
      const start = Number(from.split('-')[0]);
      return `${start + 1}-${start + 2}`;
    })(),
    saving: false,
    conflict: null,
  });

  /**
   * Move the chosen registrations into another gan year.
   *
   * The server carries the child record and the collection row across with the
   * registration — the three used to derive the year separately, which is how
   * a child ended up listed in one year and billed in another.
   */
  const handleMoveYear = async (force = false) => {
    const { regs, year } = yearDlg;
    if (!regs.length || !year) return;
    setYearDlg(d => ({ ...d, saving: true, conflict: null }));
    try {
      if (regs.length === 1) {
        const id = regs[0]._id || regs[0].id;
        const res = await api.put(`/registrations/${id}/academic-year`, {
          academic_year: year, allow_duplicate: force,
        });
        const moved = res.data.months_moved || 0;
        toast.success(moved
          ? `הועבר ל-${formatAcademicYear(year)} יחד עם ${moved} חודשי גבייה`
          : `הועבר ל-${formatAcademicYear(year)}`);
      } else {
        const res = await api.post('/registrations/academic-year/bulk', {
          ids: regs.map(r => r._id || r.id), academic_year: year, allow_duplicate: force,
        });
        const skipped = res.data.skipped || [];
        toast.success(`${res.data.moved} רישומים הועברו ל-${formatAcademicYear(year)}`);
        if (skipped.length) toast.warning(`${skipped.length} לא הועברו: ${skipped[0].error}`);
      }
      setYearDlg({ open: false, regs: [], year: '', saving: false, conflict: null });
      setSelected([]);
      fetchData();
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'DUPLICATE_IN_YEAR') {
        // Not an error to swallow: the same child is already registered for
        // that year, which is the very thing this page exists to prevent.
        setYearDlg(d => ({ ...d, saving: false, conflict: data }));
        return;
      }
      toast.error(data?.error || 'שגיאה בהעברת שנה');
      setYearDlg(d => ({ ...d, saving: false }));
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/registrations/${confirm.id}`);
      toast.success('רישום הועבר לארכיון');
      setConfirm({ open: false, id: null });
      fetchData();
    } catch {
      toast.error('שגיאה במחיקה');
    }
  };

  const handleWhatsApp = (reg) => {
    const phone = (reg.parent_phone || '').replace(/^0/, '972').replace(/\D/g, '');
    if (!phone) return toast.error('אין מספר טלפון');
    const link = reg.access_token ? `${window.location.origin}/register/${reg.access_token}` : '';
    const text = encodeURIComponent(
      `שלום ${reg.parent_name}, שמחים שהצטרפתם לגן החלומות!\nלהשלמת הרישום אנא היכנסו לקישור וחתמו על החוזה:\n${link}`
    );
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
  };

  const DOC_NAMES = { id_copy: 'צילום תעודת זהות', payment_proof: 'אישור תשלום' };

  // Send the parent a reminder to complete whatever is still missing (signature
  // and/or required documents): refresh the signing link, then open WhatsApp.
  const handleReminder = async (reg) => {
    const phone = (reg.parent_phone || '').replace(/^0/, '972').replace(/\D/g, '');
    if (!phone) return toast.error('אין מספר טלפון להורה');
    const docNames = (reg.missing_doc_types || []).map(t => DOC_NAMES[t] || t).join(' ו');
    let what;
    if (reg.signature_missing && reg.documents_missing) what = `להשלמת החתימה על החוזה והעלאת המסמכים הנדרשים (${docNames})`;
    else if (reg.signature_missing) what = 'להשלמת החתימה על חוזה הרישום';
    else if (reg.documents_missing) what = `להעלאת המסמכים הנדרשים (${docNames})`;
    else what = 'להשלמת הרישום';
    try {
      const res = await api.post(`/registrations/${reg._id || reg.id}/generate-link`);
      const link = `${window.location.origin}/register/${res.data.access_token}`;
      const text = encodeURIComponent(
        `שלום ${reg.parent_name}, זוהי תזכורת ${what} של ${reg.child_name} בגן החלומות 🌟\nנא להיכנס לקישור:\n${link}`
      );
      window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
      toast.success('נפתחה תזכורת בוואטסאפ');
    } catch {
      toast.error('שגיאה ביצירת תזכורת');
    }
  };

  /**
   * Issue next year's contract for a family already in the gan.
   *
   * A registration covers one year and holds the signature for it, so when the
   * year turns there is nothing to sign against — a child whose parent already
   * paid the registration fee is simply absent from next year, which reads as
   * lost data rather than a missing signature. The renewal is a new
   * registration; last year's is left untouched, because it holds a signed
   * contract and a year of payments.
   */
  const handleRenew = async () => {
    const reg = renewDlg.reg;
    if (!reg) return;
    if (renewDlg.mode === 'signed' && !renewDlg.file) {
      return toast.error('יש לבחור את קובץ החוזה החתום');
    }
    setRenewDlg(d => ({ ...d, saving: true }));
    try {
      const res = await api.post(`/registrations/${reg._id || reg.id}/renew`, {
        monthly_fee: renewDlg.monthlyFee === '' ? undefined : Number(renewDlg.monthlyFee),
        registration_fee: renewDlg.regFee === '' ? undefined : Number(renewDlg.regFee),
      });
      const newId = res.data.registration.id || res.data.registration._id;

      // Already signed elsewhere — on paper, or in the old system. There is
      // nothing for the parent to do, so the renewal is finalised on the spot
      // with the file attached: contract stored, registration completed, and
      // the child created for the new year, which is what actually makes them
      // appear in it.
      if (renewDlg.mode === 'signed') {
        const form = new FormData();
        form.append('contract_file', renewDlg.file);
        await api.post(`/registrations/${newId}/finalize-manual`, form,
          { headers: { 'Content-Type': 'multipart/form-data' } });
        setRenewDlg({ open: false, reg: null, monthlyFee: '', regFee: '', saving: false, mode: 'link', file: null });
        fetchData();
        toast.success('הרישום לשנה החדשה נוצר עם החוזה החתום — הילד/ה נמצא/ת במערכת');
        return;
      }

      const link = `${window.location.origin}/register/${res.data.access_token}`;
      setRenewDlg({ open: false, reg: null, monthlyFee: '', regFee: '', saving: false, mode: 'link', file: null });
      fetchData();

      const phone = (reg.parent_phone || '').replace(/^0/, '972').replace(/\D/g, '');
      if (phone) {
        const text = encodeURIComponent(
          `שלום ${reg.parent_name}, לקראת שנת הלימודים החדשה מצורף חוזה הרישום של ${reg.child_name} לחתימה 🌟\nנא להיכנס לקישור:\n${link}`,
        );
        window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
        toast.success(res.data.reused ? 'הקישור הקיים רוענן ונשלח' : 'נוצר רישום לשנה החדשה ונשלח להורה');
      } else {
        navigator.clipboard.writeText(link);
        toast.success('נוצר רישום לשנה החדשה — הקישור הועתק (אין טלפון להורה)');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהנפקת החוזה');
      setRenewDlg(d => ({ ...d, saving: false }));
    }
  };

  const handleCopyLink = (reg) => {
    if (!reg.access_token) return toast.error('אין קישור');
    const link = `${window.location.origin}/register/${reg.access_token}`;
    navigator.clipboard.writeText(link);
    toast.success('קישור הועתק');
  };

  const handleGenerateLink = async (id) => {
    try {
      const res = await api.post(`/registrations/${id}/generate-link`);
      toast.success('קישור חדש נוצר');
      navigator.clipboard.writeText(res.data.link);
      fetchData();
    } catch {
      toast.error('שגיאה');
    }
  };

  const completedCount = registrations.filter(r => r.status === 'completed').length;
  const pendingCount = registrations.filter(r => r.status !== 'completed').length;
  const missingSigCount = registrations.filter(r => r.signature_missing).length;
  const missingDocsCount = registrations.filter(r => r.documents_missing).length;
  const duplicateCount = registrations.filter(r => r.duplicate_in_year).length;

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב רישום הורים</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Chip label={`${registrations.length} רישומים`} size="small" />
            <Chip label={`${completedCount} הושלמו`} color="success" size="small" variant="outlined" />
            <Chip label={`${pendingCount} בתהליך`} color="warning" size="small" variant="outlined" />
            {missingSigCount > 0 && (
              <Chip
                icon={<WarningAmberIcon />}
                label={`${missingSigCount} ללא חתימה`}
                color="error"
                size="small"
                variant={missingSigOnly ? 'filled' : 'outlined'}
                onClick={() => setMissingSigOnly(v => !v)}
                sx={{ cursor: 'pointer', fontWeight: 700 }}
              />
            )}
            {missingDocsCount > 0 && (
              <Chip
                icon={<DescriptionIcon />}
                label={`${missingDocsCount} חסרי מסמכים`}
                color="warning"
                size="small"
                variant={missingDocsOnly ? 'filled' : 'outlined'}
                onClick={() => setMissingDocsOnly(v => !v)}
                sx={{ cursor: 'pointer', fontWeight: 700 }}
              />
            )}
            {duplicateCount > 0 && (
              <Tooltip title="אותו ילד/ה רשום/ה יותר מפעם אחת באותה שנה — בדרך כלל רישום לשנה הבאה שנשמר בשנה הנוכחית">
                <Chip
                  icon={<ContentCopyTwoToneIcon />}
                  label={`${duplicateCount} כפולים באותה שנה`}
                  color="error"
                  size="small"
                  variant={duplicatesOnly ? 'filled' : 'outlined'}
                  onClick={() => setDuplicatesOnly(v => !v)}
                  sx={{ cursor: 'pointer', fontWeight: 700 }}
                />
              </Tooltip>
            )}
          </Stack>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            color="warning"
            onClick={async () => {
              const branch = localStorage.getItem('selectedBranch');
              if (!branch) return toast.error('בחר/י סניף קודם');
              try {
                const res = await api.post('/registrations/fix-orphan-branch', { branch_id: branch });
                const n = res.data?.updated || 0;
                if (n === 0) toast.info('אין רישומים יתומים');
                else toast.success(`${n} רישומים שויכו לסניף`);
                fetchData();
              } catch {
                toast.error('שגיאה');
              }
            }}
          >
            תקן רישומים ללא סניף
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/new-registration')}>
            רישום חדש
          </Button>
        </Stack>
      </Stack>

      {/* Filters */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <TextField
          size="small" placeholder="חיפוש לפי ילד או הורה..."
          value={search} onChange={e => setSearch(e.target.value)}
          sx={{ width: 300 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
          }}
        />
        <TextField select size="small" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          sx={{ minWidth: 140 }} label="סטטוס"
        >
          <MenuItem value="">הכל</MenuItem>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
            <MenuItem key={k} value={k}>{v.label}</MenuItem>
          ))}
        </TextField>
        <TextField select size="small" value={yearFilter} onChange={e => setYearFilter(e.target.value)}
          sx={{ minWidth: 200 }} label="שנת לימודים"
        >
          <MenuItem value="">כל השנים</MenuItem>
          {yearOptions.map(y => (
            <MenuItem key={y} value={y}>{formatAcademicYear(y)}</MenuItem>
          ))}
        </TextField>
      </Stack>

      {/* Moving a whole group at once. Correcting a year card by card is fine
          for one child and unusable for a class imported into the wrong one. */}
      {selected.length > 0 && (
        <Card sx={{ p: 1.5, mb: 2, bgcolor: '#eef2ff', border: '1px solid #6366f1' }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography sx={{ fontWeight: 700 }}>{selected.length} נבחרו</Typography>
            <Button size="small" variant="contained" startIcon={<SwapHorizIcon />}
              onClick={() => openYearDialog(selectedRegs)}>
              העבר לשנת לימודים אחרת
            </Button>
            <Button size="small" onClick={() => setSelected([])}>נקה בחירה</Button>
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={() => setSelected(filtered.map(r => r._id || r.id))}>
              בחר את כל {filtered.length} המוצגים
            </Button>
          </Stack>
        </Card>
      )}

      {/* Registration Cards */}
      <Stack spacing={1.5}>
        {filtered.map(reg => {
          const id = reg._id || reg.id;
          const status = STATUS_CONFIG[reg.status] || STATUS_CONFIG.link_generated;

          return (
            <Card
              key={id}
              sx={{
                p: 2,
                borderRight: `5px solid ${status.border}`,
                bgcolor: status.color,
                '&:hover': { boxShadow: 3 },
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                {/* Info */}
                <Stack direction="row" spacing={4} alignItems="center" sx={{ flex: 1 }}>
                  <Checkbox
                    size="small"
                    checked={selected.includes(id)}
                    onChange={() => toggleSelected(id)}
                    sx={{ p: 0.5 }}
                  />
                  <Box sx={{ minWidth: 160, ml: '0 !important' }}>
                    <Typography sx={{ fontWeight: 800, fontSize: '1rem' }}>{reg.child_name}</Typography>
                    {reg.duplicate_in_year && (
                      <Tooltip title="רשום/ה פעמיים באותה שנת לימודים — העבר/י את הרישום המיותר לשנה הנכונה">
                        <Chip
                          icon={<ContentCopyTwoToneIcon />}
                          label="כפול בשנה"
                          size="small"
                          color="error"
                          sx={{ fontWeight: 700, mt: 0.5 }}
                        />
                      </Tooltip>
                    )}
                  </Box>
                  <Box sx={{ minWidth: 140 }}>
                    <Typography variant="body2" color="text.secondary">הורה</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{reg.parent_name}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 100 }}>
                    <Typography variant="body2" color="text.secondary">שובץ לקבוצה</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{reg.classroom_name || '—'}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 130 }}>
                    <Typography variant="body2" color="text.secondary">שנת לימוד</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {yearOf(reg) ? formatAcademicYear(yearOf(reg)) : '—'}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">חוזה וכרטיסיה</Typography>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Chip
                        label={status.label}
                        size="small"
                        sx={{
                          fontWeight: 700,
                          bgcolor: 'white',
                          color: status.textColor,
                          border: `1px solid ${status.border}`,
                        }}
                      />
                      {reg.signature_missing && (
                        <Tooltip title="מסומן כחתום אך חסרה חתימת הורה">
                          <Chip
                            icon={<WarningAmberIcon />}
                            label="חסרה חתימה"
                            size="small"
                            color="error"
                            sx={{ fontWeight: 700 }}
                          />
                        </Tooltip>
                      )}
                      {reg.documents_missing && (
                        <Tooltip title={`חסר: ${(reg.missing_doc_types || []).map(t => DOC_NAMES[t] || t).join(', ')}`}>
                          <Chip
                            icon={<DescriptionIcon />}
                            label="חסרים מסמכים"
                            size="small"
                            color="warning"
                            sx={{ fontWeight: 700 }}
                          />
                        </Tooltip>
                      )}
                    </Stack>
                  </Box>
                </Stack>

                {/* Actions */}
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="מסמכים וחוזה">
                    <IconButton size="small" onClick={() => openDocsDialog(reg)}>
                      <FolderIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="הפק/חדש קישור">
                    <IconButton size="small" onClick={() => handleGenerateLink(id)}>
                      <LinkIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="העתק קישור">
                    <IconButton size="small" onClick={() => handleCopyLink(reg)}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="שלח בוואטסאפ">
                    <IconButton size="small" sx={{ color: '#25d366' }} onClick={() => handleWhatsApp(reg)}>
                      <WhatsAppIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {(reg.signature_missing || reg.documents_missing) && (
                    <Tooltip title={
                      reg.signature_missing && reg.documents_missing ? 'תזכורת חתימה ומסמכים (וואטסאפ)'
                        : reg.signature_missing ? 'תזכורת חתימה להורה (וואטסאפ)'
                          : 'תזכורת מסמכים להורה (וואטסאפ)'
                    }>
                      <IconButton size="small" sx={{ color: '#dc2626' }} onClick={() => handleReminder(reg)}>
                        <HistoryEduIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="הנפקת חוזה לשנה החדשה">
                    <IconButton
                      size="small" sx={{ color: '#7c3aed' }}
                      onClick={() => setRenewDlg({
                        open: true, reg,
                        monthlyFee: String(reg.monthly_fee ?? ''),
                        regFee: String(reg.registration_fee ?? ''),
                        saving: false, mode: 'link', file: null,
                      })}
                    >
                      <AutorenewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="העברה לשנת לימודים אחרת">
                    <IconButton
                      size="small"
                      sx={{ color: reg.duplicate_in_year ? '#dc2626' : '#0891b2' }}
                      onClick={() => openYearDialog([reg])}
                    >
                      <SwapHorizIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="עריכה">
                    <IconButton size="small" onClick={() => navigate(`/edit-registration/${id}`)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="מחיקה (העבר לארכיון)">
                    <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, id })}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6 }}>
            <Typography color="text.secondary">אין רישומים</Typography>
          </Box>
        )}
      </Stack>

      {/* Next year's contract. The old registration is untouched — it holds a
          signed contract and a year of payments. */}
      <Dialog open={renewDlg.open} onClose={() => setRenewDlg({ open: false, reg: null, monthlyFee: '', regFee: '', saving: false })}
        dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          הנפקת חוזה לשנה החדשה
          <Typography variant="body2" color="text.secondary">
            {renewDlg.reg?.child_name} · {renewDlg.reg?.parent_name}
            {renewDlg.reg?.start_date && (() => {
              // The year renewed INTO — derived from this registration's own
              // year, not from today's date. Shown so nobody has to trust it.
              const d = new Date(renewDlg.reg.start_date);
              const startYear = d.getUTCFullYear() - (d.getUTCMonth() + 1 < 8 ? 1 : 0);
              return ` · ${formatAcademicYear(`${startYear + 1}-${startYear + 2}`)}`;
            })()}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <ToggleButtonGroup
              size="small" exclusive fullWidth value={renewDlg.mode}
              onChange={(_, v) => { if (v) setRenewDlg(d => ({ ...d, mode: v })); }}
            >
              <ToggleButton value="link">שלח קישור חתימה להורה</ToggleButton>
              <ToggleButton value="signed">יש כבר חוזה חתום</ToggleButton>
            </ToggleButtonGroup>

            <Alert severity="info" icon={false}>
              שנת גן מלאה: 1 בספטמבר עד 31 באוגוסט. הרישום של השנה הנוכחית נשאר כפי שהוא —
              הוא מחזיק את החוזה החתום ואת הגבייה של השנה.
              {renewDlg.mode === 'signed'
                ? ' החוזה שתעלה/י נשמר על הרישום החדש, והילד/ה נכנס/ת מיד למערכת של השנה החדשה — בלי לשלוח שום דבר להורה.'
                : ' הילד/ה ייכנס/תיכנס למערכת של השנה החדשה רק לאחר החתימה.'}
            </Alert>

            {renewDlg.mode === 'signed' && (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={renewDlg.saving}>
                  {renewDlg.file ? 'החלף קובץ' : 'בחר/י חוזה חתום'}
                  <input
                    type="file" hidden accept="application/pdf,image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      if (f.size > 8 * 1024 * 1024) return toast.error('הקובץ גדול מדי (מקסימום 8MB)');
                      setRenewDlg(d => ({ ...d, file: f }));
                    }}
                  />
                </Button>
                {renewDlg.file && (
                  <Chip size="small" label={renewDlg.file.name}
                    onDelete={() => setRenewDlg(d => ({ ...d, file: null }))} />
                )}
              </Stack>
            )}
            <TextField
              size="small" type="number" label="שכר לימוד חודשי" value={renewDlg.monthlyFee}
              onChange={e => setRenewDlg(d => ({ ...d, monthlyFee: e.target.value }))}
              helperText="ברירת מחדל: כמו השנה הנוכחית" fullWidth
            />
            <TextField
              size="small" type="number" label="דמי רישום" value={renewDlg.regFee}
              onChange={e => setRenewDlg(d => ({ ...d, regFee: e.target.value }))} fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenewDlg({ open: false, reg: null, monthlyFee: '', regFee: '', saving: false })}
            disabled={renewDlg.saving}>ביטול</Button>
          <Button variant="contained" onClick={handleRenew} disabled={renewDlg.saving}>
            {renewDlg.saving ? 'מנפיק…' : renewDlg.mode === 'signed' ? 'צור רישום עם החוזה החתום' : 'הנפק ושלח להורה'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Move to another gan year. The child record and the collection row go
          with the registration — until now each derived the year on its own. */}
      <Dialog
        open={yearDlg.open}
        onClose={() => setYearDlg({ open: false, regs: [], year: '', saving: false, conflict: null })}
        dir="rtl" maxWidth="xs" fullWidth
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          העברה לשנת לימודים אחרת
          <Typography variant="body2" color="text.secondary">
            {yearDlg.regs.length === 1
              ? `${yearDlg.regs[0]?.child_name} · ${formatAcademicYear(yearOf(yearDlg.regs[0] || {}))}`
              : `${yearDlg.regs.length} רישומים`}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              select size="small" label="שנת לימודים חדשה" fullWidth
              value={yearDlg.year}
              onChange={e => setYearDlg(d => ({ ...d, year: e.target.value, conflict: null }))}
            >
              {moveTargets.map(y => (
                <MenuItem key={y} value={y}>{formatAcademicYear(y)}</MenuItem>
              ))}
            </TextField>

            <Alert severity="info" icon={false}>
              תאריכי ההתחלה והסיום יוזזו באותו מספר שנים — ילד/ה שהתחיל/ה בינואר
              ימשיך/תמשיך להתחיל בינואר, ולא יחויב/תחויב על חודשים שלא היה/הייתה בהם.
              הילד/ה בכיתה ושורת הגבייה עוברים יחד עם הרישום.
            </Alert>

            {yearDlg.conflict && (
              <Alert severity="error">
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{yearDlg.conflict.error}</Typography>
                {(yearDlg.conflict.duplicates || []).map(d => (
                  <Typography key={d.id} variant="caption" sx={{ display: 'block' }}>
                    {d.child_name} · {d.parent_name} · ₪{d.monthly_fee}
                  </Typography>
                ))}
                <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
                  אם באמת מדובר בשני ילדים שונים עם אותו שם — אפשר להעביר בכל זאת.
                </Typography>
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setYearDlg({ open: false, regs: [], year: '', saving: false, conflict: null })}
            disabled={yearDlg.saving}
          >
            ביטול
          </Button>
          {yearDlg.conflict && (
            <Button color="error" onClick={() => handleMoveYear(true)} disabled={yearDlg.saving}>
              העבר בכל זאת
            </Button>
          )}
          <Button variant="contained" onClick={() => handleMoveYear(false)} disabled={yearDlg.saving || !yearDlg.year}>
            {yearDlg.saving ? 'מעביר…' : 'העבר'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, id: null })}
        onConfirm={handleDelete}
        title="מחיקת רישום"
        message="למחוק את הרישום ולהעביר לארכיון?"
      />

      {/* Documents + manual finalize dialog */}
      <Dialog open={docsDialog.open} onClose={closeDocsDialog} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          מסמכים — {docsDialog.reg?.child_name}
          <Typography variant="body2" color="text.secondary">
            {docsDialog.reg?.parent_name}
          </Typography>
        </DialogTitle>
        <DialogContent>
          {/* Contract section */}
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'primary.dark' }}>
            חוזה
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Chip
              size="small"
              label={docsDialog.reg?.agreement_signed ? 'חתום' : 'לא חתום'}
              color={docsDialog.reg?.agreement_signed ? 'success' : 'warning'}
            />
            <Button
              size="small"
              startIcon={<DownloadIcon />}
              disabled={!docsDialog.reg?.agreement_signed && !docsDialog.reg?.contract_pdf_path}
              onClick={() => downloadContract(docsDialog.reg._id || docsDialog.reg.id)}
            >
              הורדת חוזה
            </Button>
          </Stack>
          {docsDialog.reg?.status === 'completed' ? (
            <Typography variant="caption" color="success.main" sx={{ display: 'block', mb: 2, fontWeight: 600 }}>
              ✓ הרישום הושלם
            </Typography>
          ) : (
            <>
              <Button
                component="label"
                size="small"
                variant="outlined"
                disabled={!!uploading}
                startIcon={uploading === 'contract' ? <CircularProgress size={14} /> : <UploadFileIcon />}
                sx={{ mb: 1 }}
              >
                {uploading === 'contract' ? 'מעלה חוזה…' : 'העלה חוזה ידני וסמן כהושלם'}
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.[0]) handleFinalizeManual(e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </Button>
              <Button
                size="small"
                variant="text"
                disabled={!!uploading}
                startIcon={uploading === 'finalize' ? <CircularProgress size={14} /> : null}
                sx={{ display: 'block', mb: 2 }}
                onClick={() => handleFinalizeManual(null)}
              >
                סמן כהושלם ללא קובץ
              </Button>
            </>
          )}

          <Divider sx={{ my: 2 }} />

          {/* Registration card details */}
          {docsDialog.reg?.configuration?.registration_card && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'primary.dark' }}>
                כרטיס רישום שמולא ע"י ההורה
              </Typography>
              <Box sx={{ border: '1px solid #e2e8f0', borderRadius: 1, p: 1.5, mb: 2, fontSize: '0.85rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5 }}>
                {(() => {
                  const c = docsDialog.reg.configuration.registration_card;
                  const rows = [
                    ['שם הילד/ה', c.childFullName],
                    ['ת.ז ילד/ה', c.childIdNumber],
                    ['תאריך לידה', c.childBirthDate],
                    ['הורה 1', c.parent1Name],
                    ['ת.ז הורה 1', c.parent1Id],
                    ['טלפון הורה 1', c.parent1Phone],
                    ['דוא"ל הורה 1', c.parent1Email],
                    ['הורה 2', c.parent2Name],
                    ['ת.ז הורה 2', c.parent2Id],
                    ['טלפון הורה 2', c.parent2Phone],
                    ['דוא"ל הורה 2', c.parent2Email],
                    ['כתובת', c.address],
                    ['רפואי', c.medicalInfo],
                    ['אלרגיות', c.allergies],
                    ['חירום - שם', c.emergencyContact],
                    ['חירום - טלפון', c.emergencyPhone],
                    ['הערות', c.notes],
                  ].filter(([, v]) => v);
                  return rows.map(([label, val]) => (
                    <Box key={label} sx={{ display: 'flex', gap: 1 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 100 }}>
                        {label}:
                      </Typography>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>{val}</Typography>
                    </Box>
                  ));
                })()}
              </Box>
            </>
          )}

          {/* Documents section */}
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'primary.dark' }}>
            מסמכים
          </Typography>
          {docsDialog.loading ? (
            <Typography variant="body2" color="text.secondary">טוען...</Typography>
          ) : docsDialog.documents.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              אין מסמכים
            </Typography>
          ) : (
            <Stack spacing={0.5} sx={{ mb: 2 }}>
              {docsDialog.documents.map(d => (
                <Stack
                  key={d._id || d.id}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ border: '1px solid #e2e8f0', borderRadius: 1, px: 1, py: 0.5 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {DOC_TYPE_LABELS[d.doc_type] || d.doc_type}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.file_name}
                    </Typography>
                  </Box>
                  <IconButton size="small" onClick={() => downloadDoc(d._id || d.id)}>
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}

          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              select
              size="small"
              label="סוג מסמך"
              value={docTypeForUpload}
              onChange={(e) => setDocTypeForUpload(e.target.value)}
              sx={{ width: 160 }}
            >
              {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
                <MenuItem key={k} value={k}>{v}</MenuItem>
              ))}
            </TextField>
            <Button
              component="label"
              size="small"
              variant="contained"
              disabled={!!uploading}
              startIcon={uploading === 'doc' ? <CircularProgress size={14} color="inherit" /> : <UploadFileIcon />}
            >
              {uploading === 'doc' ? 'מעלה…' : 'העלאה'}
              <input
                type="file"
                accept="application/pdf,image/*"
                hidden
                onChange={(e) => {
                  if (e.target.files?.[0]) handleUploadDocument(e.target.files[0], docTypeForUpload);
                  e.target.value = '';
                }}
              />
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDocsDialog}>סגור</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
