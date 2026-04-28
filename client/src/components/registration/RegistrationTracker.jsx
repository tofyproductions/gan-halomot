import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, Stack, Chip, IconButton, Tooltip,
  TextField, InputAdornment, Button, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Divider,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import DescriptionIcon from '@mui/icons-material/Description';
import LinkIcon from '@mui/icons-material/Link';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import FolderIcon from '@mui/icons-material/Folder';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ConfirmDialog from '../shared/ConfirmDialog';
import { getHebrewYear } from '../../utils/hebrewYear';
import html2pdf from 'html2pdf.js';

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
  const [confirm, setConfirm] = useState({ open: false, id: null });
  const [docsDialog, setDocsDialog] = useState({ open: false, reg: null, documents: [], loading: false });
  const [docTypeForUpload, setDocTypeForUpload] = useState('id_copy');

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
    try {
      await api.post('/documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('מסמך הועלה');
      refreshDocs();
    } catch {
      toast.error('שגיאה בהעלאה');
    }
  };

  const handleFinalizeManual = async (file) => {
    if (!docsDialog.reg) return;
    const fd = new FormData();
    if (file) fd.append('contract_file', file);
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
    }
  };

  const renderHtmlToPdf = async (html, filename) => {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.right = '-10000px';
    container.style.top = '0';
    container.style.width = '900px';
    container.dir = 'rtl';
    container.innerHTML = html;
    document.body.appendChild(container);
    try {
      // Wait briefly for fonts/images to load.
      await new Promise(r => setTimeout(r, 250));
      await html2pdf()
        .set({
          margin: [10, 10, 10, 10],
          filename: filename || 'contract.pdf',
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, allowTaint: true },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
        })
        .from(container)
        .save();
    } finally {
      document.body.removeChild(container);
    }
  };

  const downloadContract = async (regId) => {
    try {
      const res = await api.get(`/registrations/${regId}/contract-download`);
      if (res.data?.html) {
        await renderHtmlToPdf(res.data.html, `חוזה_${docsDialog.reg?.child_name || regId}.pdf`);
      } else if (res.data?.url) {
        // Saved PDF in R2 — download directly.
        const a = document.createElement('a');
        a.href = res.data.url;
        a.download = `חוזה_${docsDialog.reg?.child_name || regId}.pdf`;
        a.click();
      } else {
        toast.error('אין חוזה זמין');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין חוזה זמין');
    }
  };

  const downloadDoc = (docId) => {
    window.open(`/api/documents/${docId}/download`, '_blank');
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

  const yearOptions = Array.from(
    new Set(registrations.map(r => r.start_date ? getHebrewYear(r.start_date) : null).filter(Boolean))
  ).sort();

  const filtered = registrations.filter(r => {
    const q = search.trim().toLowerCase();
    if (q && !r.child_name?.toLowerCase().includes(q) && !r.parent_name?.toLowerCase().includes(q)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (yearFilter && (!r.start_date || getHebrewYear(r.start_date) !== yearFilter)) return false;
    return true;
  });

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

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב רישום הורים</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Chip label={`${registrations.length} רישומים`} size="small" />
            <Chip label={`${completedCount} הושלמו`} color="success" size="small" variant="outlined" />
            <Chip label={`${pendingCount} בתהליך`} color="warning" size="small" variant="outlined" />
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
          sx={{ minWidth: 140 }} label="שנה"
        >
          <MenuItem value="">כל השנים</MenuItem>
          {yearOptions.map(y => (
            <MenuItem key={y} value={y}>{y}</MenuItem>
          ))}
        </TextField>
      </Stack>

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
                  <Box sx={{ minWidth: 160 }}>
                    <Typography sx={{ fontWeight: 800, fontSize: '1rem' }}>{reg.child_name}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 140 }}>
                    <Typography variant="body2" color="text.secondary">הורה</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{reg.parent_name}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 100 }}>
                    <Typography variant="body2" color="text.secondary">שובץ לקבוצה</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{reg.classroom_name || '—'}</Typography>
                  </Box>
                  <Box sx={{ minWidth: 90 }}>
                    <Typography variant="body2" color="text.secondary">שנת לימוד</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {reg.start_date ? getHebrewYear(reg.start_date) : '—'}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">חוזה וכרטיסיה</Typography>
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
                startIcon={<UploadFileIcon />}
                sx={{ mb: 1 }}
              >
                העלה חוזה ידני וסמן כהושלם
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
              startIcon={<UploadFileIcon />}
            >
              העלאה
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
