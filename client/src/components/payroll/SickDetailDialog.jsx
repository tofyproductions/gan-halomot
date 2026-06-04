import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, Alert, CircularProgress, Table,
  TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip,
} from '@mui/material';
import HealingIcon from '@mui/icons-material/Healing';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
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

/**
 * Sick-day management for one employee in a month. The manager:
 *   - sees approved sick periods (with day count and certificate)
 *   - approves/rejects pending sick reports the employee filed (with their cert)
 *   - records a new sick period by date range + uploads the certificate
 *
 * Days are counted server-side from the employee's working days (Saturday and
 * the employee's day off never count). Approving/adding pushes the counted
 * days into manual.sick_days for the month.
 */
export default function SickDetailDialog({ open, row, month, onClose, onSaved }) {
  const confirm = useConfirm();
  const [approved, setApproved] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ from_date: '', to_date: '', reason: '' });
  const [file, setFile] = useState(null); // { name, data }
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null); // when set, the form edits this request
  const [manualDays, setManualDays] = useState(''); // direct edit of manual.sick_days (legacy/orphan values)

  const load = () => {
    if (!row) return;
    setLoading(true);
    Promise.all([
      api.get('/employee-requests/sick-for-month', { params: { employee_id: row.employee_id, month } }),
      api.get('/employee-requests/pending-for-employee', { params: { employee_id: row.employee_id, type: 'sick' } }),
    ])
      .then(([a, p]) => {
        setApproved(a.data.requests || []);
        setPending(p.data.requests || []);
        if (a.data.sick_days !== undefined) setManualDays(String(Number(a.data.sick_days) || 0));
      })
      .catch(() => { setApproved([]); setPending([]); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !row) return;
    setDraft({ from_date: '', to_date: '', reason: '' });
    setFile(null);
    setEditingId(null);
    setManualDays(String(Number(row.manual?.sick_days) || 0));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row, month]);

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

  const resetForm = () => { setDraft({ from_date: '', to_date: '', reason: '' }); setFile(null); setEditingId(null); };

  const addSick = () => {
    if (!draft.from_date) return toast.error('בחר תאריך התחלה');
    setSaving(true);
    const payload = {
      from_date: draft.from_date,
      to_date: draft.to_date || draft.from_date,
      reason: draft.reason || null,
      medical_file_data: file?.data || null,
      medical_file_name: file?.name || null,
    };
    const req = editingId
      ? api.put(`/employee-requests/${editingId}/admin`, payload)
      : api.post('/employee-requests/admin', { employee_id: row.employee_id, type: 'sick', ...payload });
    req
      .then(() => {
        toast.success(editingId ? 'המחלה עודכנה' : 'מחלה נרשמה וחושבה לפי ימי העבודה');
        resetForm();
        onSaved && onSaved();
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setDraft({ from_date: r.from_date, to_date: r.to_date || r.from_date, reason: r.reason || '' });
    setFile(null);
  };

  const deleteSick = async (r) => {
    if (!(await confirm({ title: 'מחיקת מחלה', message: `למחוק את המחלה ${r.from_date}–${r.to_date || r.from_date}? ימי המחלה יקוזזו.`, danger: true }))) return;
    api.delete(`/employee-requests/${r.id}`)
      .then(() => { toast.success('המחלה נמחקה'); if (editingId === r.id) resetForm(); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Direct edit of the month's sick-day count — for legacy/orphan values that
  // have no underlying request record (e.g. imported or manually set).
  const saveManualDays = (value) => {
    const n = Math.max(0, Number(value) || 0);
    api.patch(`/payroll-month/${row.employee_id}`, { manual: { sick_days: n } }, { params: { month } })
      .then(() => { toast.success('ימי המחלה עודכנו'); setManualDays(String(n)); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Recompute the month's sick-day count from the approved requests (fixes a
  // count that drifted from the actual records).
  const syncFromRequests = () => {
    api.post('/employee-requests/sync-sick', { employee_id: row.employee_id, month })
      .then(() => { toast.success('סונכרן לפי הבקשות'); onSaved && onSaved(); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const decide = (id, status) => {
    api.put(`/employee-requests/${id}/status`, { status })
      .then(() => {
        toast.success(status === 'approved' ? 'אושר' : 'נדחה');
        onSaved && onSaved();
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const totalApprovedDays = approved.reduce((s, r) => s + (Number(r.days) || 0), 0);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HealingIcon color="error" />
        ימי מחלה — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'error.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ימי מחלה החודש</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{Number(manualDays) || 0}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">סך מבקשות מאושרות</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{totalApprovedDays}</Typography>
            </Box>
          </Stack>

          {(Number(manualDays) || 0) !== totalApprovedDays && (
            <Alert
              severity="warning"
              action={<Button color="inherit" size="small" onClick={syncFromRequests}>סנכרן ל-{totalApprovedDays}</Button>}
            >
              מספר ימי המחלה ({Number(manualDays) || 0}) אינו תואם לסך הבקשות המאושרות ({totalApprovedDays}).
            </Alert>
          )}

          {/* Direct edit of the month's sick-day count (handles legacy/orphan
              values with no request behind them). */}
          <Box sx={{ p: 1.5, border: '1px dashed', borderColor: 'divider', borderRadius: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>עריכת מספר ימי המחלה בחודש:</Typography>
              <TextField
                type="number" size="small" value={manualDays}
                onChange={e => setManualDays(e.target.value)}
                inputProps={{ min: 0, step: 0.5 }} sx={{ width: 100 }}
              />
              <Button variant="contained" size="small" onClick={() => saveManualDays(manualDays)}>שמור</Button>
              <Button variant="outlined" color="error" size="small" onClick={() => saveManualDays(0)}>אפס</Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              שינוי ישיר של מספר הימים החודש (גם אם אין רשומת מחלה מצורפת). לרישום מתועד עם תאריכים ואישור — השתמש בטופס למטה.
            </Typography>
          </Box>

          {loading && <Box sx={{ textAlign: 'center', py: 1 }}><CircularProgress size={24} /></Box>}

          {pending.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                ממתין לאישור (העובד דיווח)
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>מתאריך</TableCell>
                    <TableCell>עד תאריך</TableCell>
                    <TableCell>אישור</TableCell>
                    <TableCell align="center">פעולות</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pending.map(r => (
                    <TableRow key={r.id}>
                      <TableCell>{r.from_date}</TableCell>
                      <TableCell>{r.to_date}</TableCell>
                      <TableCell>
                        {r.has_file ? (
                          <Tooltip title="צפה באישור">
                            <IconButton size="small" onClick={() => viewCert(r.id)}><VisibilityIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        ) : <Chip size="small" label="ללא אישור" color="warning" variant="outlined" />}
                      </TableCell>
                      <TableCell align="center">
                        <Tooltip title="אשר"><IconButton size="small" color="success" onClick={() => decide(r.id, 'approved')}><CheckIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="דחה"><IconButton size="small" color="error" onClick={() => decide(r.id, 'rejected')}><CloseIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="מחק"><IconButton size="small" onClick={() => deleteSick(r)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>מחלות מאושרות החודש</Typography>
          {approved.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין מחלות מאושרות החודש.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מתאריך</TableCell>
                  <TableCell>עד תאריך</TableCell>
                  <TableCell align="center">ימים</TableCell>
                  <TableCell align="center">אישור</TableCell>
                  <TableCell align="center">פעולות</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {approved.map(r => (
                  <TableRow key={r.id} sx={editingId === r.id ? { bgcolor: 'primary.50' } : undefined}>
                    <TableCell>{r.from_date}</TableCell>
                    <TableCell>{r.to_date}</TableCell>
                    <TableCell align="center"><Chip label={r.days} size="small" color="error" /></TableCell>
                    <TableCell align="center">
                      {r.has_file ? (
                        <Tooltip title="צפה באישור">
                          <IconButton size="small" color="primary" onClick={() => viewCert(r.id)}><VisibilityIcon fontSize="small" /></IconButton>
                        </Tooltip>
                      ) : <Chip size="small" label="ללא אישור" color="warning" variant="outlined" />}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="ערוך">
                        <IconButton size="small" onClick={() => startEdit(r)}><EditIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      <Tooltip title="מחק">
                        <IconButton size="small" color="error" onClick={() => deleteSick(r)}><DeleteIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Divider />
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {editingId ? 'עריכת מחלה' : 'רישום מחלה חדשה'}
            </Typography>
            {editingId && <Chip size="small" label="עורך — שמירה תעדכן את הרישום" color="primary" variant="outlined" onDelete={resetForm} />}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            הזן טווח תאריכים — המערכת תספור רק ימי עבודה (לא שבת ולא היום החופשי של העובד).
            {editingId && ' אם לא תעלה אישור חדש — האישור הקיים יישמר.'}
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField size="small" type="date" label="מתאריך" InputLabelProps={{ shrink: true }}
              value={draft.from_date} onChange={e => setDraft({ ...draft, from_date: e.target.value })} sx={{ width: 160 }} />
            <TextField size="small" type="date" label="עד תאריך" InputLabelProps={{ shrink: true }}
              value={draft.to_date} onChange={e => setDraft({ ...draft, to_date: e.target.value })} sx={{ width: 160 }} />
            <TextField size="small" label="הערה (אופציונלי)"
              value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} sx={{ flex: 1, minWidth: 140 }} />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} size="small">
              {file ? 'החלף אישור' : 'העלה אישור מחלה'}
              <input type="file" hidden accept="image/*,application/pdf" onChange={onPickFile} />
            </Button>
            {file && <Chip label={file.name} size="small" onDelete={() => setFile(null)} />}
            {!file && <Typography variant="caption" color="warning.main">מומלץ לצרף אישור</Typography>}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        {editingId && <Button onClick={resetForm}>בטל עריכה</Button>}
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" color="error" onClick={addSick} disabled={saving || !draft.from_date}>
          {editingId ? 'עדכן מחלה' : 'רשום מחלה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
