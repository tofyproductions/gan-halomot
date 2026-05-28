import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, Chip, Tabs, Tab,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import LocalHospitalIcon from '@mui/icons-material/LocalHospital';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

const STATUS_MAP = {
  pending: { label: 'ממתין לאישור מנהל', color: 'warning' },
  pending_manager: { label: 'ממתין לאישור מנהל', color: 'warning' },
  pending_accountant: { label: 'ממתין לאישור הנה״ח', color: 'info' },
  approved: { label: 'אושר סופית', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
};
const TYPE_MAP = {
  vacation: { label: 'חופש', icon: <BeachAccessIcon fontSize="small" />, color: '#2563eb' },
  sick: { label: 'מחלה', icon: <LocalHospitalIcon fontSize="small" />, color: '#dc2626' },
};
const isPending = (s) => s === 'pending' || s === 'pending_manager' || s === 'pending_accountant';
function mimeFromName(name = '') {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

export default function RequestsManager() {
  const { isAdmin, isManager, isAccountant } = useAuth();
  const [requests, setRequests] = useState([]);
  const [punches, setPunches] = useState({ pending_manager: [], pending_accountant: [] });
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState('requests'); // 'requests' | 'punches'
  const [tab, setTab] = useState('pending');           // 'pending' | 'approved' | 'rejected'
  const [viewDoc, setViewDoc] = useState(null);        // { name, dataUrl, full_name }

  // Who can act on a given stage.
  const canAct = useCallback((status) => {
    if (status === 'pending_manager' || status === 'pending') return isManager || isAdmin;
    if (status === 'pending_accountant') return isAccountant || isAdmin;
    return false;
  }, [isManager, isAccountant, isAdmin]);

  const fetchAll = useCallback(() => {
    setLoading(true);
    // No branch filter: the approvals queue must show everything pending for
    // this user across all branches. The server already scopes by role —
    // managers see their managed branches, accountant/admin see all.
    Promise.all([
      api.get('/employee-requests'),
      api.get('/payroll/punches/pending'),
    ])
      .then(([r, p]) => {
        setRequests(r.data.requests || []);
        setPunches({ pending_manager: p.data.pending_manager || [], pending_accountant: p.data.pending_accountant || [] });
      })
      .catch(() => { setRequests([]); setPunches({ pending_manager: [], pending_accountant: [] }); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const decideRequest = async (id, status) => {
    try {
      await api.put(`/employee-requests/${id}/status`, { status });
      toast.success(status === 'approved' ? 'אושר והועבר לשלב הבא' : 'נדחה');
      fetchAll();
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };
  const decidePunch = async (id, action) => {
    try {
      await api.patch(`/payroll/punches/${id}/${action}`);
      toast.success(action === 'approve' ? 'אושר והועבר לשלב הבא' : 'נדחה');
      fetchAll();
    } catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };
  const viewCert = async (r) => {
    try {
      const res = await api.get(`/employee-requests/${r._id}/medical-file`);
      setViewDoc({ name: res.data.name, dataUrl: `data:${mimeFromName(res.data.name)};base64,${res.data.data}`, full_name: r.user_id?.full_name });
    } catch (e) { toast.error(e.response?.data?.error || 'אין קובץ'); }
  };

  const visibleRequests = requests.filter(r =>
    tab === 'pending' ? isPending(r.status) : r.status === tab);
  const pendingPunches = [...punches.pending_manager, ...punches.pending_accountant];
  const pendingCount = requests.filter(r => isPending(r.status) && canAct(r.status)).length
    + pendingPunches.filter(p => canAct(p.approval_status)).length;

  return (
    <Box dir="rtl" sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>אישורים</Typography>
        {pendingCount > 0 && <Chip label={`${pendingCount} ממתינות לך`} color="warning" size="small" />}
      </Stack>

      <Tabs value={section} onChange={(_, v) => setSection(v)} sx={{ mb: 2 }}>
        <Tab value="requests" label="בקשות (מחלה / חופש)" />
        <Tab value="punches" label={`החתמות${pendingPunches.length ? ` (${pendingPunches.length})` : ''}`} />
      </Tabs>

      {section === 'requests' && (
        <>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
            <Tab value="pending" label="ממתינות" />
            <Tab value="approved" label="מאושרות" />
            <Tab value="rejected" label="נדחו" />
          </Tabs>
          {loading ? <Typography color="text.secondary">טוען…</Typography>
            : visibleRequests.length === 0 ? (
              <Card sx={{ borderRadius: 3 }}><CardContent><Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>אין בקשות</Typography></CardContent></Card>
            ) : (
              <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
                <Table>
                  <TableHead><TableRow sx={{ bgcolor: '#f8fafc' }}>
                    <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>מתאריך</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>עד תאריך</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>אישור</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>פעולות</TableCell>
                  </TableRow></TableHead>
                  <TableBody>
                    {visibleRequests.map(r => {
                      const t = TYPE_MAP[r.type] || TYPE_MAP.vacation;
                      const s = STATUS_MAP[r.status] || STATUS_MAP.pending;
                      return (
                        <TableRow key={r._id} hover>
                          <TableCell sx={{ fontWeight: 600 }}>{r.user_id?.full_name || 'לא ידוע'}</TableCell>
                          <TableCell><Chip icon={t.icon} label={t.label} size="small" sx={{ bgcolor: `${t.color}15`, color: t.color, fontWeight: 600 }} /></TableCell>
                          <TableCell>{r.from_date}</TableCell>
                          <TableCell>{r.to_date || r.from_date}</TableCell>
                          <TableCell>
                            {r.has_file
                              ? <Button size="small" startIcon={<VisibilityIcon />} onClick={() => viewCert(r)} sx={{ fontSize: '0.7rem', minWidth: 'auto' }}>אישור</Button>
                              : (r.type === 'sick' ? <Chip size="small" label="ללא אישור" color="warning" variant="outlined" /> : '—')}
                          </TableCell>
                          <TableCell><Chip label={s.label} size="small" color={s.color} /></TableCell>
                          <TableCell>
                            {isPending(r.status) && canAct(r.status) ? (
                              <Stack direction="row" spacing={0.5}>
                                <Button size="small" variant="contained" color="success" startIcon={<CheckCircleIcon />} onClick={() => decideRequest(r._id, 'approved')} sx={{ fontSize: '0.75rem' }}>אשר</Button>
                                <Button size="small" variant="outlined" color="error" startIcon={<CancelIcon />} onClick={() => decideRequest(r._id, 'rejected')} sx={{ fontSize: '0.75rem' }}>דחה</Button>
                              </Stack>
                            ) : <Typography variant="caption" color="text.secondary">—</Typography>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
        </>
      )}

      {section === 'punches' && (
        loading ? <Typography color="text.secondary">טוען…</Typography>
          : pendingPunches.length === 0 ? (
            <Card sx={{ borderRadius: 3 }}><CardContent><Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>אין החתמות הממתינות לאישור</Typography></CardContent></Card>
          ) : (
            <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
              <Table>
                <TableHead><TableRow sx={{ bgcolor: '#f8fafc' }}>
                  <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>תאריך ושעה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הערה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>פעולות</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {pendingPunches.map(p => {
                    const s = STATUS_MAP[p.approval_status] || STATUS_MAP.pending;
                    const dt = new Date(p.timestamp);
                    return (
                      <TableRow key={p._id} hover>
                        <TableCell sx={{ fontWeight: 600 }}>{p.employee_id?.full_name || p.israeli_id || 'לא מזוהה'}</TableCell>
                        <TableCell><span dir="ltr">{dt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></TableCell>
                        <TableCell>{p.state === 1 ? 'יציאה' : 'כניסה'}</TableCell>
                        <TableCell>{p.manual_note || '—'}</TableCell>
                        <TableCell><Chip label={s.label} size="small" color={s.color} /></TableCell>
                        <TableCell>
                          {canAct(p.approval_status) ? (
                            <Stack direction="row" spacing={0.5}>
                              <Button size="small" variant="contained" color="success" startIcon={<CheckCircleIcon />} onClick={() => decidePunch(p._id, 'approve')} sx={{ fontSize: '0.75rem' }}>אשר</Button>
                              <Button size="small" variant="outlined" color="error" startIcon={<CancelIcon />} onClick={() => decidePunch(p._id, 'reject')} sx={{ fontSize: '0.75rem' }}>דחה</Button>
                            </Stack>
                          ) : <Typography variant="caption" color="text.secondary">—</Typography>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )
      )}

      <Dialog open={!!viewDoc} onClose={() => setViewDoc(null)} maxWidth="md" fullWidth>
        <DialogTitle>אישור רפואי — {viewDoc?.full_name}</DialogTitle>
        <DialogContent>
          {viewDoc && (
            <Box sx={{ textAlign: 'center' }}>
              {viewDoc.name?.toLowerCase().endsWith('.pdf')
                ? <iframe src={viewDoc.dataUrl} style={{ width: '100%', height: 500, border: 'none' }} title="אישור רפואי" />
                : <img src={viewDoc.dataUrl} alt="אישור רפואי" style={{ maxWidth: '100%', maxHeight: 500 }} />}
            </Box>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setViewDoc(null)}>סגור</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
