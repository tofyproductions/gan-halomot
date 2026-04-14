import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, CardContent, Button, Stack, Chip,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatCurrency } from '../../utils/hebrewYear';

const STATUS_MAP = {
  pending: { label: 'ממתין', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

export default function SalaryRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState({ open: false, id: null, action: '', note: '' });

  const fetchRequests = useCallback(() => {
    setLoading(true);
    api.get('/salary-requests')
      .then(res => setRequests(res.data.requests || []))
      .catch(() => toast.error('שגיאה'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleAction = async () => {
    const { id, action, note } = dialog;
    try {
      await api.post(`/salary-requests/${id}/${action}`, { note });
      toast.success(action === 'approve' ? 'בקשה אושרה' : 'בקשה נדחתה');
      setDialog({ open: false, id: null, action: '', note: '' });
      fetchRequests();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 3 }}>בקשות שינוי שכר</Typography>

      {requests.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary">אין בקשות</Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>עובד</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תפקיד</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>מבקש</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">שכר נוכחי</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">שכר מבוקש</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סיבה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                <TableCell align="center">פעולות</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map(req => {
                const status = STATUS_MAP[req.status] || STATUS_MAP.pending;
                const diff = req.new_salary - req.current_salary;
                return (
                  <TableRow key={req._id || req.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{req.employee_name}</TableCell>
                    <TableCell>{req.employee_position || '—'}</TableCell>
                    <TableCell>{req.requester_name}</TableCell>
                    <TableCell align="center">{formatCurrency(req.current_salary)}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700, color: diff > 0 ? 'success.main' : 'error.main' }}>
                      {formatCurrency(req.new_salary)}
                    </TableCell>
                    <TableCell>{req.reason || '—'}</TableCell>
                    <TableCell><Chip label={status.label} color={status.color} size="small" variant="outlined" /></TableCell>
                    <TableCell>{new Date(req.created_at).toLocaleDateString('he-IL')}</TableCell>
                    <TableCell align="center">
                      {req.status === 'pending' && (
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          <Button size="small" color="success" variant="contained"
                            startIcon={<CheckCircleIcon />}
                            onClick={() => setDialog({ open: true, id: req._id || req.id, action: 'approve', note: '' })}
                          >
                            אשר
                          </Button>
                          <Button size="small" color="error" variant="outlined"
                            startIcon={<CancelIcon />}
                            onClick={() => setDialog({ open: true, id: req._id || req.id, action: 'reject', note: '' })}
                          >
                            דחה
                          </Button>
                        </Stack>
                      )}
                      {req.status !== 'pending' && req.decided_note && (
                        <Typography variant="caption" color="text.secondary">{req.decided_note}</Typography>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={dialog.open} onClose={() => setDialog({ open: false, id: null, action: '', note: '' })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.action === 'approve' ? 'אישור בקשת שכר' : 'דחיית בקשת שכר'}
        </DialogTitle>
        <DialogContent>
          <TextField
            label="הערה (אופציונלי)" multiline rows={2} fullWidth sx={{ mt: 1 }}
            value={dialog.note} onChange={e => setDialog(prev => ({ ...prev, note: e.target.value }))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog({ open: false, id: null, action: '', note: '' })}>ביטול</Button>
          <Button variant="contained" color={dialog.action === 'approve' ? 'success' : 'error'} onClick={handleAction}>
            {dialog.action === 'approve' ? 'אשר' : 'דחה'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
