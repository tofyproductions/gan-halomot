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

  const fetchRequests = () => {
    api.get('/employee-requests/my')
      .then(res => setRequests(res.data.requests || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRequests(); }, []);

  const handleSubmitVacation = async () => {
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
  };

  const handleSubmitSick = async () => {
    try {
      await api.post('/employee-requests', {
        type: 'sick',
        from_date: form.from_date,
        to_date: form.to_date,
        reason: form.reason,
      });
      toast.success('דיווח מחלה נשלח');
      setSickDialog(false);
      setForm({ from_date: '', to_date: '', reason: '' });
      fetchRequests();
    } catch { toast.error('שגיאה בשליחה'); }
  };

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
          <Button onClick={() => setVacationDialog(false)}>ביטול</Button>
          <Button variant="contained" onClick={handleSubmitVacation} disabled={!form.from_date || !form.to_date}>שלח בקשה</Button>
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
            <TextField label="הערות" multiline minRows={2} placeholder="אופציונלי - ניתן לצרף אישור רפואי בהמשך"
              value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSickDialog(false)}>ביטול</Button>
          <Button variant="contained" color="error" onClick={handleSubmitSick} disabled={!form.from_date}>שלח דיווח</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
