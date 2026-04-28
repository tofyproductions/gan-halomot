import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  Typography, TextField, Box, Chip, Divider, InputAdornment, Alert,
  Card, CardContent, Grid, MenuItem,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import PhoneIcon from '@mui/icons-material/Phone';
import EmailIcon from '@mui/icons-material/Email';
import PaymentsIcon from '@mui/icons-material/Payments';
import MedicalServicesIcon from '@mui/icons-material/MedicalServices';
import EditIcon from '@mui/icons-material/Edit';
import DescriptionIcon from '@mui/icons-material/Description';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { getClassroomColor } from '../../utils/classroomColors';

/**
 * ChildDetailDialog — view and edit details of a single child.
 *
 * Fetches the child + populates registration for the full picture: parent
 * info, phone, email, monthly fee, registration fee, medical alerts.
 *
 * The "edit payment" mode lets the admin change the monthly_fee on the
 * Registration document, optionally specifying from which month the
 * change takes effect (for now this is informational — the actual
 * collection-per-month is handled by the existing CollectionsTable logic).
 */

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('he-IL');
}

export default function ChildDetailDialog({ open, childId, onClose, onChanged }) {
  const [child, setChild] = useState(null);
  const [registration, setRegistration] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    monthly_fee: '', phone: '', email: '', medical_alerts: '',
    fee_effective_from: '', previous_monthly_fee: '',
  });

  useEffect(() => {
    if (!open || !childId) return;
    setLoading(true);
    setEditing(false);
    // Fetch child with populated registration
    api.get(`/children/${childId}`)
      .then(res => {
        const c = res.data.child;
        const reg = res.data.registration;
        setChild(c);
        setRegistration(reg);
        // Default effective month = current month
        const now = new Date();
        const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        setEditForm({
          monthly_fee: String(reg?.monthly_fee || ''),
          phone: c.phone || reg?.parent_phone || '',
          email: c.email || reg?.parent_email || '',
          medical_alerts: c.medical_alerts || '',
          fee_effective_from: reg?.fee_effective_from || curMonth,
          previous_monthly_fee: reg?.previous_monthly_fee != null ? String(reg.previous_monthly_fee) : '',
        });
      })
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת פרטי הילד');
      })
      .finally(() => setLoading(false));
  }, [open, childId]);

  const handleSave = async () => {
    try {
      // Update child fields
      await api.put(`/children/${childId}`, {
        phone: editForm.phone,
        email: editForm.email,
        medical_alerts: editForm.medical_alerts,
      });
      // Update registration monthly_fee if changed
      const feeChanged = registration && String(registration.monthly_fee) !== editForm.monthly_fee;
      const prevFeeChanged = registration && String(registration.previous_monthly_fee || '') !== (editForm.previous_monthly_fee || '');
      const effectiveChanged = registration && String(registration.fee_effective_from || '') !== (editForm.fee_effective_from || '');
      if (feeChanged || prevFeeChanged || effectiveChanged) {
        const payload = {
          monthly_fee: Number(editForm.monthly_fee) || 0,
          fee_effective_from: editForm.fee_effective_from || null,
        };
        if (editForm.previous_monthly_fee !== '') {
          payload.previous_monthly_fee = Number(editForm.previous_monthly_fee);
        } else if (!editForm.fee_effective_from) {
          payload.previous_monthly_fee = null;
        }
        await api.put(`/registrations/${registration._id || registration.id}`, payload);
      }
      toast.success('פרטים עודכנו');
      setEditing(false);
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בעדכון');
    }
  };

  const classroomName = child?.classroom_id?.name || '';
  const cc = getClassroomColor(classroomName);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        {loading ? 'טוען...' : (
          <>
            <PersonIcon sx={{ color: cc.primary }} />
            {child?.child_name || ''}
            {classroomName && (
              <Chip label={classroomName} size="small" sx={{ bgcolor: cc.bg, color: cc.primary, fontWeight: 700, ml: 1 }} />
            )}
          </>
        )}
      </DialogTitle>
      <DialogContent>
        {loading && <Typography sx={{ py: 4, textAlign: 'center' }}>טוען…</Typography>}
        {!loading && child && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            {/* Parent info */}
            <Card variant="outlined" sx={{ borderRadius: 3, borderColor: cc.border }}>
              <CardContent sx={{ py: 1.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: cc.primary, mb: 1 }}>פרטי הורה</Typography>
                <Grid container spacing={1}>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="caption" color="text.secondary">שם ההורה</Typography>
                    <Typography sx={{ fontWeight: 600 }}>
                      {child.parent_name || registration?.parent_name || '—'}
                    </Typography>
                  </Grid>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="caption" color="text.secondary">ת.ז הורה</Typography>
                    <Typography dir="ltr">{registration?.parent_id_number || '—'}</Typography>
                  </Grid>
                </Grid>
                {editing ? (
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    <TextField
                      label="טלפון" size="small" dir="ltr"
                      value={editForm.phone}
                      onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                      InputProps={{ startAdornment: <InputAdornment position="start"><PhoneIcon fontSize="small" /></InputAdornment> }}
                    />
                    <TextField
                      label="אימייל" size="small" dir="ltr"
                      value={editForm.email}
                      onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                      InputProps={{ startAdornment: <InputAdornment position="start"><EmailIcon fontSize="small" /></InputAdornment> }}
                    />
                  </Stack>
                ) : (
                  <Grid container spacing={1} sx={{ mt: 0.5 }}>
                    <Grid size={{ xs: 6 }}>
                      <Typography variant="caption" color="text.secondary">טלפון</Typography>
                      <Typography dir="ltr" sx={{ fontWeight: 600 }}>
                        {child.phone || registration?.parent_phone || '—'}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 6 }}>
                      <Typography variant="caption" color="text.secondary">אימייל</Typography>
                      <Typography dir="ltr" sx={{ fontSize: '0.85rem' }}>
                        {child.email || registration?.parent_email || '—'}
                      </Typography>
                    </Grid>
                  </Grid>
                )}
              </CardContent>
            </Card>

            {/* Child details */}
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent sx={{ py: 1.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.primary', mb: 1 }}>פרטי הילד/ה</Typography>
                <Grid container spacing={1}>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="caption" color="text.secondary">תאריך לידה</Typography>
                    <Typography>{child.birth_date ? formatDate(child.birth_date) : '—'}</Typography>
                  </Grid>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="caption" color="text.secondary">שנה אקדמית</Typography>
                    <Typography>{child.academic_year || '—'}</Typography>
                  </Grid>
                </Grid>
                {editing ? (
                  <TextField
                    label="רגישויות / רפואי" size="small" fullWidth multiline rows={2} sx={{ mt: 1.5 }}
                    value={editForm.medical_alerts}
                    onChange={e => setEditForm({ ...editForm, medical_alerts: e.target.value })}
                    InputProps={{ startAdornment: <InputAdornment position="start"><MedicalServicesIcon fontSize="small" /></InputAdornment> }}
                  />
                ) : child.medical_alerts ? (
                  <Alert severity="warning" icon={<MedicalServicesIcon />} sx={{ mt: 1, fontSize: '0.85rem' }}>
                    {child.medical_alerts}
                  </Alert>
                ) : null}
              </CardContent>
            </Card>

            {/* Payment info */}
            <Card variant="outlined" sx={{ borderRadius: 3, borderColor: '#fbbf24' }}>
              <CardContent sx={{ py: 1.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#d97706', mb: 1 }}>
                  <PaymentsIcon sx={{ fontSize: 16, mr: 0.5, verticalAlign: 'text-bottom' }} />
                  תשלום
                </Typography>
                {editing ? (
                  <Stack spacing={1.5}>
                    <Button
                      size="small"
                      variant="outlined"
                      color="warning"
                      onClick={() => {
                        const currentFee = Number(editForm.monthly_fee) || Number(registration?.monthly_fee) || 0;
                        const discounted = Math.round(currentFee * 0.9);
                        const now = new Date();
                        const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                        const nextMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
                        setEditForm({
                          ...editForm,
                          previous_monthly_fee: String(currentFee),
                          monthly_fee: String(discounted),
                          fee_effective_from: nextMonth,
                        });
                      }}
                    >
                      🎁 הוסף הנחת אח/ות 10% מהחודש הבא
                    </Button>
                    <TextField
                      label="תשלום חודשי חדש" type="number" size="small" fullWidth
                      value={editForm.monthly_fee}
                      onChange={e => setEditForm({ ...editForm, monthly_fee: e.target.value })}
                      InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                    />
                    <TextField
                      label="תשלום חודשי קודם (לפני שינוי)"
                      type="number"
                      size="small"
                      fullWidth
                      value={editForm.previous_monthly_fee}
                      onChange={e => setEditForm({ ...editForm, previous_monthly_fee: e.target.value })}
                      InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                      helperText="ישולם עבור החודשים שלפני 'החל מחודש'. ריק = חל רטרואקטיבית."
                    />
                    <TextField
                      label="החל מחודש"
                      type="month"
                      size="small"
                      fullWidth
                      value={editForm.fee_effective_from}
                      onChange={e => setEditForm({ ...editForm, fee_effective_from: e.target.value })}
                      InputLabelProps={{ shrink: true }}
                      helperText="השינוי יחול מהחודש שנבחר והלאה. השאר ריק לשינוי רטרואקטיבי לכל השנה."
                    />
                  </Stack>
                ) : (
                  <Grid container spacing={1}>
                    <Grid size={{ xs: 4 }}>
                      <Typography variant="caption" color="text.secondary">חודשי</Typography>
                      <Typography sx={{ fontWeight: 800, fontSize: '1.2rem', color: '#d97706' }}>
                        ₪{registration?.monthly_fee?.toLocaleString() || '—'}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 4 }}>
                      <Typography variant="caption" color="text.secondary">דמי רישום</Typography>
                      <Typography>₪{registration?.registration_fee?.toLocaleString() || '0'}</Typography>
                    </Grid>
                    <Grid size={{ xs: 4 }}>
                      <Typography variant="caption" color="text.secondary">חוזה</Typography>
                      <Typography>{formatDate(registration?.start_date)} — {formatDate(registration?.end_date)}</Typography>
                    </Grid>
                  </Grid>
                )}
              </CardContent>
            </Card>

            {/* Registration status + contracts */}
            {registration && (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip
                    label={registration.agreement_signed ? 'חוזה חתום' : 'ממתין לחתימה'}
                    size="small"
                    color={registration.agreement_signed ? 'success' : 'warning'}
                    variant="outlined"
                  />
                  <Chip
                    label={`סטטוס: ${registration.status}`}
                    size="small"
                    variant="outlined"
                  />
                </Stack>
                <ContractSection registrationId={registration._id} />
              </Stack>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {editing ? (
          <>
            <Button onClick={() => setEditing(false)}>ביטול</Button>
            <Button variant="contained" onClick={handleSave}>שמור שינויים</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>סגור</Button>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)}>
              ערוך פרטים
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

function ContractSection({ registrationId }) {
  const [contracts, setContracts] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!registrationId) return;
    api.get(`/contracts?registration_id=${registrationId}`)
      .then(res => setContracts(res.data.contracts || []))
      .catch(() => {});
  }, [registrationId]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        await api.post('/contracts/upload', {
          registration_id: registrationId,
          type: 'enrollment',
          doc_type: 'enrollment_contract',
          file_name: file.name,
          file_data: base64,
          file_mimetype: file.type || 'application/pdf',
        });
        toast.success('חוזה הועלה בהצלחה');
        const res = await api.get(`/contracts?registration_id=${registrationId}`);
        setContracts(res.data.contracts || []);
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch {
      toast.error('שגיאה בהעלאת חוזה');
      setUploading(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <DescriptionIcon fontSize="small" color="action" />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>חוזים ומסמכים</Typography>
        <Button component="label" size="small" startIcon={<UploadFileIcon />} disabled={uploading}
          sx={{ fontSize: '0.75rem' }}>
          {uploading ? 'מעלה...' : 'העלה חוזה'}
          <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png" onChange={handleUpload} />
        </Button>
      </Stack>
      {contracts.length > 0 ? (
        <Stack spacing={0.5}>
          {contracts.map(c => (
            <Stack key={c._id} direction="row" alignItems="center" spacing={1}
              sx={{ pl: 1, py: 0.3, borderRadius: 1, '&:hover': { bgcolor: '#f8fafc' } }}>
              <DescriptionIcon fontSize="small" sx={{ color: '#7c3aed' }} />
              <Typography variant="body2" sx={{ flex: 1 }}>{c.file_name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {new Date(c.created_at).toLocaleDateString('he-IL')}
              </Typography>
              <Button size="small" href={c.file_url} target="_blank" startIcon={<VisibilityIcon />}
                sx={{ fontSize: '0.7rem', minWidth: 'auto' }}>
                צפה
              </Button>
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
          אין חוזים. לחץ "העלה חוזה" כדי להוסיף.
        </Typography>
      )}
    </Box>
  );
}
