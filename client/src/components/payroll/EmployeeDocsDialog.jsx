import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, TextField, Divider, CircularProgress, Table, TableHead,
  TableBody, TableRow, TableCell, IconButton, Tooltip,
} from '@mui/material';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import UndoIcon from '@mui/icons-material/Undo';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton, FilePickButton, UploadingBar, mimeFromName } from '../shared/UploadControls';
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
export default function EmployeeDocsDialog({ open, row, month, onClose, onSaved }) {
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

  const onPickFile = (picked) => {
    setFile(picked);
    if (!name) setName(picked.name.replace(/\.[^.]+$/, '')); // default label = filename
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
      .then(() => { toast.success('המסמך נוסף'); setName(''); setDescription(''); setFile(null); load(); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  // Mark an uploaded doc as seen (or re-flag it as pending) so it stops/starts
  // showing as "ממתין בקבצים" in the salary table's notes column.
  const setAck = (d, acknowledged) => {
    api.post(`/employee-documents/${d.id}/acknowledge`, { acknowledged, source: d.source })
      .then(() => { toast.success(acknowledged ? 'סומן כנצפה' : 'הוחזר לממתין'); load(); onSaved && onSaved(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const viewDoc = async (d) => {
    try {
      // Sick/vacation certificates live on the request; uploaded docs on the doc.
      const res = d.source === 'request'
        ? await api.get(`/employee-requests/${d.id}/medical-file`)
        : await api.get(`/employee-documents/${d.id}/file`);
      const { data, name: fn, mimetype } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimetype || mimeFromName(fn || d.file_name)));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const del = async (d) => {
    if (!(await confirm({ title: 'מחיקת מסמך', message: `למחוק את "${d.name}"?`, danger: true }))) return;
    api.delete(`/employee-documents/${d.id}`)
      .then(() => { toast.success('נמחק'); load(); onSaved && onSaved(); })
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
                      {d.source === 'request' && (
                        <Chip size="small" color="error" variant="outlined" label="אישור מחלה" sx={{ ml: 0.5, height: 18, fontSize: '0.6rem' }} />
                      )}
                      {d.acknowledged === false && (
                        <Chip size="small" color="warning" label="ממתין" sx={{ ml: 0.5, height: 18, fontSize: '0.6rem', fontWeight: 700 }} />
                      )}
                      {d.name}
                      {d.month && <Chip size="small" label={d.month} sx={{ ml: 0.5 }} variant="outlined" />}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-wrap', color: 'text.secondary', maxWidth: 200 }}>{d.description || '—'}</TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
                      {fmtDate(d.created_at)}{d.created_by_name ? ` · ${d.created_by_name}` : ''}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="צפה"><IconButton size="small" color="primary" onClick={() => viewDoc(d)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
                      {d.acknowledged === false
                        ? <Tooltip title="סמן כנצפה (יוריד את ההתראה בהערות)"><IconButton size="small" color="success" onClick={() => setAck(d, true)}><CheckCircleIcon fontSize="small" /></IconButton></Tooltip>
                        : <Tooltip title="החזר לממתין"><IconButton size="small" onClick={() => setAck(d, false)}><UndoIcon fontSize="small" /></IconButton></Tooltip>}
                      {d.source === 'request'
                        ? <Tooltip title="אישור מחלה — מנוהל בלשונית מחלה"><span><IconButton size="small" disabled><DeleteIcon fontSize="small" /></IconButton></span></Tooltip>
                        : <Tooltip title="מחק"><IconButton size="small" color="error" onClick={() => del(d)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוספת מסמך</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <FilePickButton hasFile={!!file} onPick={onPickFile} onError={msg => toast.error(msg)} disabled={saving} />
            {file && <Chip label={file.name} size="small" onDelete={() => setFile(null)} />}
          </Stack>
          <TextField size="small" label="שם המסמך" value={name} onChange={e => setName(e.target.value)} fullWidth />
          <TextField size="small" label="פירוט לרו״ח (אופציונלי)" value={description} onChange={e => setDescription(e.target.value)}
            multiline minRows={2} fullWidth />
          <UploadingBar show={saving} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>סגור</Button>
        <BusyButton variant="contained" onClick={add} loading={saving} loadingText="מעלה מסמך…"
          disabled={!file || !name.trim()}>הוסף מסמך</BusyButton>
      </DialogActions>
    </Dialog>
  );
}
