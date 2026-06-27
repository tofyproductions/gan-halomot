import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, CircularProgress, Table, TableHead,
  TableBody, TableRow, TableCell, IconButton, Tooltip,
} from '@mui/material';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
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
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('he-IL'); } catch { return ''; } };

/**
 * Manage free-form documents attached to one employee — a file plus a label and
 * a detail note for the accountant (רו"ח). Opened from the salary table's notes
 * column.
 */
export default function EmployeeDocsDialog({ open, row, month, onClose }) {
  const confirm = useConfirm();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null); // { name, data, mimetype }

  const load = () => {
    if (!row) return;
    setLoading(true);
    api.get('/employee-documents', { params: { employee_id: row.employee_id } })
      .then(res => setDocs(res.data.documents || []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !row) return;
    setName(''); setDescription(''); setFile(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  if (!row) return null;

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, data: reader.result.split(',')[1], mimetype: f.type || mimeFromName(f.name) });
    reader.readAsDataURL(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, '')); // default label = filename
  };

  const add = () => {
    if (!file?.data) return toast.error('בחר קובץ');
    if (!name.trim()) return toast.error('הזן שם למסמך');
    setSaving(true);
    api.post('/employee-documents', {
      employee_id: row.employee_id,
      month: month || null,
      name: name.trim(),
      description: description || '',
      file_data: file.data,
      file_name: file.name,
      file_mimetype: file.mimetype,
    })
      .then(() => { toast.success('המסמך נוסף'); setName(''); setDescription(''); setFile(null); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const viewDoc = async (d) => {
    try {
      const res = await api.get(`/employee-documents/${d.id}/file`);
      const { data, name: fn, mimetype } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimetype || mimeFromName(fn)));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const del = async (d) => {
    if (!(await confirm({ title: 'מחיקת מסמך', message: `למחוק את "${d.name}"?`, danger: true }))) return;
    api.delete(`/employee-documents/${d.id}`)
      .then(() => { toast.success('נמחק'); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <AttachFileIcon color="primary" />
        מסמכי עובד — {row.full_name}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {loading && <Box sx={{ textAlign: 'center', py: 1 }}><CircularProgress size={24} /></Box>}

          {!loading && docs.length === 0 && (
            <Typography variant="body2" color="text.secondary">אין מסמכים מצורפים לעובד זה.</Typography>
          )}

          {docs.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>שם</TableCell>
                  <TableCell>פירוט לרו״ח</TableCell>
                  <TableCell>נוסף</TableCell>
                  <TableCell align="center">פעולות</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {docs.map(d => (
                  <TableRow key={d.id}>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {d.name}
                      {d.month && <Chip size="small" label={d.month} sx={{ ml: 0.5 }} variant="outlined" />}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-wrap', color: 'text.secondary', maxWidth: 200 }}>{d.description || '—'}</TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
                      {fmtDate(d.created_at)}{d.created_by_name ? ` · ${d.created_by_name}` : ''}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="צפה"><IconButton size="small" color="primary" onClick={() => viewDoc(d)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="מחק"><IconButton size="small" color="error" onClick={() => del(d)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוספת מסמך</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} size="small">
              {file ? 'החלף קובץ' : 'בחר קובץ'}
              <input type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={onPickFile} />
            </Button>
            {file && <Chip label={file.name} size="small" onDelete={() => setFile(null)} />}
          </Stack>
          <TextField size="small" label="שם המסמך" value={name} onChange={e => setName(e.target.value)} fullWidth />
          <TextField size="small" label="פירוט לרו״ח (אופציונלי)" value={description} onChange={e => setDescription(e.target.value)}
            multiline minRows={2} fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="contained" onClick={add} disabled={saving || !file || !name.trim()}>הוסף מסמך</Button>
      </DialogActions>
    </Dialog>
  );
}
