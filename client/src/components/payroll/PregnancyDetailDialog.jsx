import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip, LinearProgress,
} from '@mui/material';
import PregnantWomanIcon from '@mui/icons-material/PregnantWoman';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

function mimeFromName(name = '') {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const STATUS_LABEL = {
  pending: 'ממתין למנהל',
  pending_manager: 'ממתין למנהל',
  pending_accountant: 'ממתין להנה״ח',
  approved: 'מאושר',
  rejected: 'נדחה',
};
const STATUS_COLOR = {
  pending: 'warning', pending_manager: 'warning', pending_accountant: 'info',
  approved: 'success', rejected: 'error',
};

/**
 * Pregnancy medical-exam hours tracking (§7 חוק עבודת נשים) for one employee.
 * DISPLAY / TRACKING ONLY — nothing here changes computed salary. The manager
 * (and accountant/admin) can:
 *   - see the 40h (prorated) entitlement, hours used, and remaining;
 *   - see every exam-hour entry with its medical certificate;
 *   - record a new exam absence (date + hours + optional certificate);
 *   - approve/reject entries the employee filed (manager → accountant chain);
 *   - delete an entry.
 */
export default function PregnancyDetailDialog({ open, row, canManager, canAccounting, onClose, onSaved }) {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(null);
  const [draft, setDraft] = useState({ date: '', hours: '', reason: '' });
  const [file, setFile] = useState(null); // { name, data }
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!row) return;
    setLoading(true);
    api.get('/employee-requests/pregnancy-exam', { params: { employee_id: row.employee_id } })
      .then(res => setBalance(res.data))
      .catch(() => setBalance(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !row) return;
    setDraft({ date: '', hours: '', reason: '' });
    setFile(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  if (!row) return null;

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, data: reader.result.split(',')[1] });
    reader.readAsDataURL(f);
  };

  const viewCert = async (id) => {
    try {
      const res = await api.get(`/employee-requests/${id}/medical-file`);
      const { data, name } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimeFromName(name)));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const addExam = () => {
    if (!draft.date) return toast.error('בחר תאריך בדיקה');
    if (!(Number(draft.hours) > 0)) return toast.error('הזן מספר שעות');
    setSaving(true);
    api.post('/employee-requests/admin', {
      employee_id: row.employee_id,
      type: 'pregnancy_exam',
      from_date: draft.date,
      to_date: draft.date,
      exam_hours: Number(draft.hours),
      reason: draft.reason || null,
      medical_file_data: file?.data || null,
      medical_file_name: file?.name || null,
    })
      .then(() => {
        toast.success('שעות הבדיקה נרשמו');
        setDraft({ date: '', hours: '', reason: '' });
        setFile(null);
        onSaved && onSaved();
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const decide = (id, status) => {
    api.put(`/employee-requests/${id}/status`, { status })
      .then(() => { toast.success(status === 'approved' ? 'אושר' : 'נדחה'); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const remove = async (id) => {
    if (!(await confirm({ title: 'מחיקת רישום', message: 'למחוק את רישום שעות הבדיקה?' }))) return;
    api.delete(`/employee-requests/${id}`)
      .then(() => { toast.success('נמחק'); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const p = balance?.proration || {};
  const entitlement = balance?.entitlement ?? 0;
  const used = balance?.used ?? 0;
  const pendingHours = balance?.pending_hours ?? 0;
  const remaining = balance?.remaining ?? 0;
  const pct = entitlement > 0 ? Math.min(100, (used / entitlement) * 100) : 0;
  const requests = balance?.requests || [];
  const canDecide = canManager || canAccounting;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth dir="rtl">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#9d174d' }}>
        <PregnantWomanIcon /> מעקב שעות בדיקות הריון — {row.full_name || ''}
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
        ) : (
          <Stack spacing={2}>
            {/* Balance meter */}
            <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: '#fdf2f8', border: '1px solid #fbcfe8' }}>
              <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 0.5 }}>
                <Typography sx={{ fontWeight: 700, color: '#9d174d' }}>
                  נוצלו {used} מתוך {entitlement} שעות
                </Typography>
                <Typography sx={{ fontWeight: 700, color: remaining > 0 ? 'success.main' : 'error.main' }}>
                  נותרו {remaining} שעות
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate" value={pct}
                sx={{ height: 10, borderRadius: 5, bgcolor: '#fce7f3',
                  '& .MuiLinearProgress-bar': { bgcolor: balance?.over_cap ? '#dc2626' : '#db2777' } }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                זכאות: {p.mode === 'statutory' ? 'דו-שכבתי סטטוטורי' : 'לינארי'}
                {p.has_commitment
                  ? ` · היקף משרה ${Math.round((p.fte || 0) * 100)}% (${p.weekly_hours}ש׳/שבוע${p.avg_hours_per_day != null ? `, ${p.avg_hours_per_day}ש׳/יום` : ''})`
                  : ' · אין התחייבות במערכת — הונחה משרה מלאה'}
                {pendingHours > 0 && ` · ${pendingHours}ש׳ ממתינות לאישור`}
              </Typography>
              {balance?.over_cap && (
                <Alert severity="warning" sx={{ mt: 1, py: 0 }}>חריגה ממכסת השעות הסטטוטורית.</Alert>
              )}
            </Box>

            {/* Add new exam entry */}
            {canDecide && (
              <Box sx={{ p: 1.5, borderRadius: 2, border: '1px dashed', borderColor: 'divider' }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>רישום היעדרות לבדיקה</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="flex-start">
                  <TextField
                    label="תאריך" type="date" size="small"
                    value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))}
                    InputLabelProps={{ shrink: true }} sx={{ minWidth: 160 }}
                  />
                  <TextField
                    label="שעות" type="number" size="small"
                    value={draft.hours} onChange={e => setDraft(d => ({ ...d, hours: e.target.value }))}
                    inputProps={{ min: 0, step: 0.5 }} sx={{ width: 100 }}
                  />
                  <TextField
                    label="הערה (סוג בדיקה)" size="small" fullWidth
                    value={draft.reason} onChange={e => setDraft(d => ({ ...d, reason: e.target.value }))}
                  />
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
                  <Button component="label" size="small" variant="outlined" startIcon={<UploadFileIcon />}>
                    צרף אישור
                    <input type="file" hidden accept="image/*,application/pdf" onChange={onPickFile} />
                  </Button>
                  {file && <Chip size="small" label={file.name} onDelete={() => setFile(null)} />}
                  <Box sx={{ flex: 1 }} />
                  <Button variant="contained" color="secondary" size="small" disabled={saving} onClick={addExam}>
                    {saving ? 'שומר…' : 'רשום שעות'}
                  </Button>
                </Stack>
              </Box>
            )}

            {/* Entries list */}
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>רישומי שעות ({requests.length})</Typography>
              {requests.length === 0 ? (
                <Alert severity="info">לא נרשמו עדיין שעות בדיקות.</Alert>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>תאריך</TableCell>
                      <TableCell align="center">שעות</TableCell>
                      <TableCell>הערה</TableCell>
                      <TableCell align="center">אישור</TableCell>
                      <TableCell align="center">סטטוס</TableCell>
                      <TableCell align="center">פעולות</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {requests.map(r => (
                      <TableRow key={r.id}>
                        <TableCell>{r.date}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>{r.hours}</TableCell>
                        <TableCell>{r.reason || '—'}</TableCell>
                        <TableCell align="center">
                          {r.has_file ? (
                            <Tooltip title={r.file_name || 'צפה באישור'}>
                              <IconButton size="small" onClick={() => viewCert(r.id)}><VisibilityIcon fontSize="small" /></IconButton>
                            </Tooltip>
                          ) : <Typography variant="caption" color="text.disabled">אין</Typography>}
                        </TableCell>
                        <TableCell align="center">
                          <Chip size="small" color={STATUS_COLOR[r.status] || 'default'} label={STATUS_LABEL[r.status] || r.status} />
                        </TableCell>
                        <TableCell align="center">
                          <Stack direction="row" spacing={0.5} justifyContent="center">
                            {canDecide && (r.status === 'pending' || r.status === 'pending_manager' || r.status === 'pending_accountant') && (
                              <>
                                <Tooltip title="אשר">
                                  <IconButton size="small" color="success" onClick={() => decide(r.id, 'approved')}><CheckIcon fontSize="small" /></IconButton>
                                </Tooltip>
                                <Tooltip title="דחה">
                                  <IconButton size="small" color="error" onClick={() => decide(r.id, 'rejected')}><CloseIcon fontSize="small" /></IconButton>
                                </Tooltip>
                              </>
                            )}
                            {canDecide && (
                              <Tooltip title="מחק">
                                <IconButton size="small" onClick={() => remove(r.id)}><DeleteIcon fontSize="small" /></IconButton>
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Box>

            <Divider />
            <Alert severity="info" sx={{ py: 0.5 }}>
              מעקב בלבד — שעות אלו אינן משפיעות אוטומטית על חישוב השכר. לפי §7 חוק עבודת נשים הן משולמות
              במלואן ואינן מנוכות ממאזן המחלה/חופשה.
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
