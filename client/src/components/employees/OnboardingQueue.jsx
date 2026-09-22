import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, IconButton, Tooltip, Divider,
  Tabs, Tab, Alert, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  CircularProgress,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import DescriptionIcon from '@mui/icons-material/Description';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * רישומי עובדים — the queue between "somebody filled in the form" and "there
 * is a person on the payroll".
 *
 * The link that feeds it is permanent and lives in WhatsApp, so this screen is
 * the whole of the guard: nothing arrives as an employee, and the button that
 * makes one is only drawn for the people allowed to press it. A branch manager
 * reads her own hire's form, chases what is missing and can refuse one that is
 * not who she expected — but she does not create a card and she does not see
 * an account number, because neither is her job and both are somebody's
 * private business.
 */

const VIEWS = [
  { key: 'pending', label: 'ממתינים' },
  { key: 'approved', label: 'אושרו' },
  { key: 'rejected', label: 'נדחו' },
];

const FILE_LABEL = {
  id_document: 'צילום ת״ז',
  bank_details: 'אישור בנק',
  certificate: 'תעודה',
  other: 'מסמך',
};

const fmt = (d) => { try { return new Date(d).toLocaleDateString('he-IL'); } catch { return ''; } };

function Field({ label, value }) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={0.8} alignItems="baseline">
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 92 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 700 }}>{value}</Typography>
    </Stack>
  );
}

export default function OnboardingQueue() {
  const { user } = useAuth();
  const mayApprove = ['system_admin', 'accountant'].includes(user?.role);

  const [view, setView] = useState(0);
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [reject, setReject] = useState({ open: false, row: null, reason: '' });

  const load = useCallback(() => {
    setLoading(true);
    const status = VIEWS[view].key;
    Promise.all([
      api.get('/employee-onboarding', { params: { status } }),
      api.get('/employee-onboarding/counts'),
    ])
      .then(([list, c]) => { setRows(list.data.registrations || []); setCounts(c.data || {}); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינת הרישומים'))
      .finally(() => setLoading(false));
  }, [view]);

  useEffect(() => { load(); }, [load]);

  const openFile = async (row, file) => {
    try {
      const res = await api.get(`/employee-onboarding/${row.id}/file/${file.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error('פתיחת הקובץ נכשלה');
    }
  };

  const approve = async (row) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`לאשר את ${row.full_name} וליצור כרטיס עובד/ת? המסמכים יועברו לתיק שלה/ו.`)) return;
    setBusyId(row.id);
    try {
      await api.post(`/employee-onboarding/${row.id}/approve`);
      toast.success('נוצר כרטיס עובד/ת');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'האישור נכשל');
    } finally { setBusyId(''); }
  };

  const doReject = async () => {
    const { row, reason } = reject;
    if (!row) return;
    try {
      await api.post(`/employee-onboarding/${row.id}/reject`, { reason });
      toast.success('הרישום נדחה');
      setReject({ open: false, row: null, reason: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>רישומי עובדים</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        פרטים שמילאו עובדים חדשים בטופס הרישום. כרטיס עובד/ת נוצר רק לאחר אישור כאן.
      </Typography>

      <Tabs value={view} onChange={(_, v) => setView(v)} sx={{ mb: 2 }}>
        {VIEWS.map(v => (
          <Tab key={v.key} label={`${v.label}${counts[v.key] != null ? ` (${counts[v.key]})` : ''}`} />
        ))}
      </Tabs>

      {loading ? <CircularProgress /> : rows.length === 0 ? (
        <Alert severity="info" icon={false}>אין רישומים להצגה.</Alert>
      ) : (
        <Stack spacing={1.5}>
          {rows.map(row => (
            <Paper key={row.id} variant="outlined" sx={{ p: 2, borderRadius: 3, opacity: busyId === row.id ? 0.5 : 1 }}>
              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                <Typography sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{row.full_name}</Typography>
                <Typography dir="ltr" color="text.secondary">{row.phone}</Typography>
                {row.requested_branch && <Chip size="small" label={row.requested_branch} />}
                {row.position && <Chip size="small" variant="outlined" label={row.position} />}
                {row.status === 'approved' && <Chip size="small" color="success" label="אושר" />}
                {row.status === 'rejected' && <Chip size="small" color="error" variant="outlined" label="נדחה" />}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">הגיע {fmt(row.created_at)}</Typography>
              </Stack>

              <Stack
                direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 1, md: 4 }}
                sx={{ mb: 1.2 }}
              >
                <Stack spacing={0.4} sx={{ flex: 1 }}>
                  <Field label="ת״ז" value={row.israeli_id} />
                  <Field label="אימייל" value={row.email} />
                  <Field label="כתובת" value={row.address} />
                  <Field label="תאריך לידה" value={row.birth_date} />
                </Stack>
                <Stack spacing={0.4} sx={{ flex: 1 }}>
                  <Field label="איש קשר" value={row.emergency_name} />
                  <Field label="טלפון חירום" value={row.emergency_phone} />
                  <Field label="קרבה" value={row.emergency_relation} />
                  {row.bank_visible ? (
                    <>
                      <Field label="בנק" value={row.bank_number} />
                      <Field label="סניף בנק" value={row.bank_branch} />
                      <Field label="חשבון" value={row.bank_account} />
                      <Field label="על שם" value={row.bank_account_holder} />
                    </>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      פרטי הבנק מוצגים להנהלת החשבונות בלבד.
                    </Typography>
                  )}
                </Stack>
              </Stack>

              {row.note && (
                <Typography variant="body2" sx={{ mb: 1, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
                  {row.note}
                </Typography>
              )}

              {row.files.length > 0 && (
                <Stack direction="row" spacing={0.8} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                  {row.files.map(f => (
                    <Chip
                      key={f.id} size="small" color="primary" variant="outlined"
                      icon={<DescriptionIcon />}
                      label={FILE_LABEL[f.kind] || f.filename}
                      onClick={() => openFile(row, f)}
                      sx={{ cursor: 'pointer' }}
                    />
                  ))}
                </Stack>
              )}

              {row.status === 'rejected' && row.reject_reason && (
                <Alert severity="warning" sx={{ py: 0.5, mb: 1 }}>
                  נדחה — {row.reject_reason}
                </Alert>
              )}
              {row.status === 'approved' && (
                <Alert severity="success" sx={{ py: 0.5, mb: 1 }}
                  action={row.employee_id && (
                    <Button size="small" color="success" href={`/employee-letters?employee=${row.employee_id}`} endIcon={<OpenInNewIcon />}>
                      לתיק העובד/ת
                    </Button>
                  )}>
                  אושר ע״י {row.decided_by_name || '—'}
                </Alert>
              )}

              {row.status === 'pending' && (
                <>
                  <Divider sx={{ my: 1.2 }} />
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                    {mayApprove ? (
                      <Button
                        size="small" variant="contained" color="success" startIcon={<CheckCircleIcon />}
                        onClick={() => approve(row)} disabled={busyId === row.id}
                      >
                        אשר וצור כרטיס עובד/ת
                      </Button>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        האישור הסופי נעשה ע״י הנהלת החשבונות.
                      </Typography>
                    )}
                    <Button
                      size="small" variant="outlined" color="error" startIcon={<CancelIcon />}
                      onClick={() => setReject({ open: true, row, reason: '' })}
                    >
                      דחה
                    </Button>
                  </Stack>
                </>
              )}
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog open={reject.open} onClose={() => setReject({ open: false, row: null, reason: '' })} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>דחיית רישום</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={3} sx={{ mt: 1 }}
            label="הסיבה (תישמר לתיעוד)"
            value={reject.reason}
            onChange={e => setReject(r => ({ ...r, reason: e.target.value }))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReject({ open: false, row: null, reason: '' })}>ביטול</Button>
          <Button variant="contained" color="error" onClick={doReject}>דחה</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
