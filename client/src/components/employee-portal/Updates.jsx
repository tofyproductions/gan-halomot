import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, TextField,
  Dialog, DialogTitle, DialogContent, DialogActions, Chip, Divider,
} from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';
import { toast } from 'react-toastify';
import { BusyButton, FilePickButton, UploadingBar } from '../shared/UploadControls';

const STATUS_MAP = {
  pending: { label: 'ממתין', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

export default function Updates() {
  const { user } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [vacationDialog, setVacationDialog] = useState(false);
  const [sickDialog, setSickDialog] = useState(false);
  const [form, setForm] = useState({ from_date: '', to_date: '', reason: '' });
  const [medicalFile, setMedicalFile] = useState(null);
  const [sending, setSending] = useState(false);

  const fetchRequests = () => {
    api.get('/employee-requests/my')
      .then(res => setRequests(res.data.requests || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRequests(); }, []);

  const handleSubmitVacation = async () => {
    setSending(true);
    try {
      await api.post('/employee-requests', {
        type: 'vacation',
        from_date: form.from_date,
        to_date: form.to_date,
        reason: form.reason,
      });
      toast.success('בקשת חופש נשלחה');
      setVacationDialog(false);
      setForm({ from_date: '', to_date: '', reason: '' });
      fetchRequests();
    } catch { toast.error('שגיאה בשליחה'); }
    finally { setSending(false); }
  };

  const handleSubmitSick = async () => {
    if (!medicalFile) {
      toast.error('חובה לצרף אישור רפואי לפני שליחת דיווח מחלה');
      return;
    }
    if (!form.from_date || !form.to_date) {
      toast.error('יש למלא תאריכים');
      return;
    }
    setSending(true);
    try {
      const payload = {
        type: 'sick',
        from_date: form.from_date,
        to_date: form.to_date,
        reason: form.reason,
        medical_file_data: medicalFile.data,
        medical_file_name: medicalFile.name,
      };
      await api.post('/employee-requests', payload);
      toast.success('דיווח מחלה נשלח');
      setSickDialog(false);
      setForm({ from_date: '', to_date: '', reason: '' });
      setMedicalFile(null);
      fetchRequests();
    } catch { toast.error('שגיאה בשליחה'); }
    finally { setSending(false); }
  };

  const handleMedicalFile = (picked) => setMedicalFile({ name: picked.name, data: picked.data });

  const vacationRequests = requests.filter(r => r.type === 'vacation');
  const sickRequests = requests.filter(r => r.type === 'sick');

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <NotificationsIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>עדכונים</Typography>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Button
          variant="contained"
          startIcon={<BeachAccessIcon />}
          onClick={() => setVacationDialog(true)}
          sx={{ borderRadius: 3 }}
        >
          בקשת ימי חופש
        </Button>
        <Button
          variant="outlined"
          color="error"
          startIcon={<LocalHospitalIcon />}
          onClick={() => setSickDialog(true)}
          sx={{ borderRadius: 3 }}
        >
          דיווח מחלה
        </Button>
      </Stack>

      {/* Existing requests */}
      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : (
        <Stack spacing={3}>
          {vacationRequests.length > 0 && (
            <Card sx={{ borderRadius: 3 }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
                  <BeachAccessIcon sx={{ verticalAlign: 'middle', mr: 1 }} />
                  בקשות חופש
                </Typography>
                {vacationRequests.map((r, i) => {
                  const s = STATUS_MAP[r.status] || STATUS_MAP.pending;
                  return (
                    <Stack key={i} direction="row" justifyContent="space-between" alignItems="center"
                      sx={{ py: 1, borderBottom: i < vacationRequests.length - 1 ? '1px solid #e2e8f0' : 'none' }}>
                      <Typography>{r.from_date} - {r.to_date}</Typography>
                      <Stack direction="row" spacing={1} alignItems="center">
                        {r.reason && <Typography variant="caption" color="text.secondary">{r.reason}</Typography>}
                        <Chip label={s.label} size="small" color={s.color} />
                      </Stack>
                    </Stack>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {sickRequests.length > 0 && (
            <Card sx={{ borderRadius: 3 }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
                  <LocalHospitalIcon sx={{ verticalAlign: 'middle', mr: 1 }} />
                  דיווחי מחלה
                </Typography>
                {sickRequests.map((r, i) => {
                  const s = STATUS_MAP[r.status] || STATUS_MAP.pending;
                  return (
                    <Stack key={i} direction="row" justifyContent="space-between" alignItems="center"
                      sx={{ py: 1, borderBottom: i < sickRequests.length - 1 ? '1px solid #e2e8f0' : 'none' }}>
                      <Typography>{r.from_date} - {r.to_date}</Typography>
                      <Chip label={s.label} size="small" color={s.color} />
                    </Stack>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {requests.length === 0 && (
            <Typography color="text.secondary">אין בקשות פתוחות.</Typography>
          )}
        </Stack>
      )}

      {/* Vacation Dialog */}
      <Dialog open={vacationDialog} onClose={() => setVacationDialog(false)} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>בקשת ימי חופש</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="מתאריך" type="date" InputLabelProps={{ shrink: true }}
              value={form.from_date} onChange={e => setForm(p => ({ ...p, from_date: e.target.value }))} />
            <TextField label="עד תאריך" type="date" InputLabelProps={{ shrink: true }}
              value={form.to_date} onChange={e => setForm(p => ({ ...p, to_date: e.target.value }))} />
            <TextField label="סיבה" multiline minRows={2}
              value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVacationDialog(false)} disabled={sending}>ביטול</Button>
          <BusyButton variant="contained" onClick={handleSubmitVacation} loading={sending}
            disabled={!form.from_date || !form.to_date}>שלח בקשה</BusyButton>
        </DialogActions>
      </Dialog>

      {/* Sick Dialog */}
      <Dialog open={sickDialog} onClose={() => setSickDialog(false)} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>דיווח מחלה</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="מתאריך" type="date" InputLabelProps={{ shrink: true }}
              value={form.from_date} onChange={e => setForm(p => ({ ...p, from_date: e.target.value }))} />
            <TextField label="עד תאריך" type="date" InputLabelProps={{ shrink: true }}
              value={form.to_date} onChange={e => setForm(p => ({ ...p, to_date: e.target.value }))} />
            <TextField label="הערות" multiline minRows={2} placeholder="אופציונלי"
              value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} />
            <FilePickButton
              variant={medicalFile ? 'outlined' : 'contained'}
              color={medicalFile ? 'success' : 'warning'}
              accept=".pdf,.jpg,.jpeg,.png"
              hasFile={!!medicalFile}
              label="צרף אישור רפואי (PDF / תמונה) — חובה"
              replaceLabel={medicalFile ? `✓ צורף: ${medicalFile.name}` : 'החלף אישור'}
              onPick={handleMedicalFile}
              onError={msg => toast.error(msg)}
            />
            {!medicalFile && (
              <Typography variant="caption" color="error" sx={{ pl: 1 }}>
                דיווח מחלה לא יישלח ללא אישור רפואי
              </Typography>
            )}
            <UploadingBar show={sending} text="שולח את הדיווח והאישור… אין צורך לרענן את הדף" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSickDialog(false)} disabled={sending}>ביטול</Button>
          <BusyButton
            variant="contained" color="error"
            onClick={handleSubmitSick} loading={sending} loadingText="מעלה אישור ושולח…"
            disabled={!form.from_date || !form.to_date || !medicalFile}
          >שלח דיווח</BusyButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
