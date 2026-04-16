import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, Chip, Tabs, Tab,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { toast } from 'react-toastify';
import api from '../../api/client';

const STATUS_MAP = {
  pending: { label: 'ממתין', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};

const TYPE_MAP = {
  vacation: { label: 'חופש', icon: <BeachAccessIcon fontSize="small" />, color: '#2563eb' },
  sick: { label: 'מחלה', icon: <LocalHospitalIcon fontSize="small" />, color: '#dc2626' },
};

export default function RequestsManager() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pending');
  const [viewDoc, setViewDoc] = useState(null);

  const fetchRequests = () => {
    setLoading(true);
    const branch = localStorage.getItem('selectedBranch');
    api.get(`/employee-requests?branch_id=${branch}&status=${tab}`)
      .then(res => setRequests(res.data.requests || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRequests(); }, [tab]);

  const handleStatus = async (id, status) => {
    try {
      await api.put(`/employee-requests/${id}/status`, { status });
      toast.success(status === 'approved' ? 'בקשה אושרה' : 'בקשה נדחתה');
      fetchRequests();
    } catch {
      toast.error('שגיאה בעדכון');
    }
  };

  const pendingCount = requests.length;

  return (
    <Box dir="rtl" sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול בקשות עובדים</Typography>
        {tab === 'pending' && pendingCount > 0 && (
          <Chip label={`${pendingCount} ממתינות`} color="warning" size="small" />
        )}
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab value="pending" label="ממתינות" />
        <Tab value="approved" label="מאושרות" />
        <Tab value="rejected" label="נדחו" />
      </Tabs>

      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : requests.length === 0 ? (
        <Card sx={{ borderRadius: 3 }}>
          <CardContent>
            <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
              אין בקשות {tab === 'pending' ? 'ממתינות' : tab === 'approved' ? 'מאושרות' : 'שנדחו'}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>מתאריך</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>עד תאריך</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סיבה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תאריך בקשה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                {tab === 'pending' && <TableCell sx={{ fontWeight: 700 }}>פעולות</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map((r) => {
                const typeInfo = TYPE_MAP[r.type] || TYPE_MAP.vacation;
                const statusInfo = STATUS_MAP[r.status] || STATUS_MAP.pending;
                return (
                  <TableRow key={r._id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {r.user_id?.full_name || 'לא ידוע'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        icon={typeInfo.icon}
                        label={typeInfo.label}
                        size="small"
                        sx={{ bgcolor: `${typeInfo.color}15`, color: typeInfo.color, fontWeight: 600 }}
                      />
                    </TableCell>
                    <TableCell>{r.from_date}</TableCell>
                    <TableCell>{r.to_date || r.from_date}</TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <Typography variant="body2">{r.reason || '—'}</Typography>
                        {r.medical_file_data && (
                          <Button size="small" startIcon={<VisibilityIcon />}
                            onClick={() => setViewDoc(r)}
                            sx={{ fontSize: '0.7rem', minWidth: 'auto' }}>
                            אישור
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {new Date(r.created_at).toLocaleDateString('he-IL')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label={statusInfo.label} size="small" color={statusInfo.color} />
                    </TableCell>
                    {tab === 'pending' && (
                      <TableCell>
                        <Stack direction="row" spacing={0.5}>
                          <Button
                            size="small"
                            variant="contained"
                            color="success"
                            startIcon={<CheckCircleIcon />}
                            onClick={() => handleStatus(r._id, 'approved')}
                            sx={{ fontSize: '0.75rem' }}
                          >
                            אשר
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            startIcon={<CancelIcon />}
                            onClick={() => handleStatus(r._id, 'rejected')}
                            sx={{ fontSize: '0.75rem' }}
                          >
                            דחה
                          </Button>
                        </Stack>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Medical document viewer */}
      <Dialog open={!!viewDoc} onClose={() => setViewDoc(null)} maxWidth="md" fullWidth>
        <DialogTitle>אישור רפואי — {viewDoc?.user_id?.full_name}</DialogTitle>
        <DialogContent>
          {viewDoc?.medical_file_data && (
            <Box sx={{ textAlign: 'center' }}>
              {viewDoc.medical_file_name?.endsWith('.pdf') ? (
                <iframe
                  src={`data:application/pdf;base64,${viewDoc.medical_file_data}`}
                  style={{ width: '100%', height: 500, border: 'none' }}
                  title="אישור רפואי"
                />
              ) : (
                <img
                  src={`data:image/jpeg;base64,${viewDoc.medical_file_data}`}
                  alt="אישור רפואי"
                  style={{ maxWidth: '100%', maxHeight: 500 }}
                />
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewDoc(null)}>סגור</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
