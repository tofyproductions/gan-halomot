import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, Stack, Chip, IconButton, Tooltip,
  TextField, InputAdornment, Button, MenuItem,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import DescriptionIcon from '@mui/icons-material/Description';
import LinkIcon from '@mui/icons-material/Link';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ConfirmDialog from '../shared/ConfirmDialog';

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
  const [confirm, setConfirm] = useState({ open: false, id: null });

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get('/registrations')
      .then(res => setRegistrations(res.data.registrations || []))
      .catch(() => toast.error('שגיאה בטעינת רישומים'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = registrations.filter(r => {
    const q = search.trim().toLowerCase();
    if (q && !r.child_name?.toLowerCase().includes(q) && !r.parent_name?.toLowerCase().includes(q)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
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
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/new-registration')}>
          רישום חדש
        </Button>
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
    </Box>
  );
}
