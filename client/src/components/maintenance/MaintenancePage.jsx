import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, IconButton, Chip,
  Table, TableHead, TableBody, TableRow, TableCell, Tabs, Tab, Dialog, DialogTitle,
  DialogContent, DialogActions, Tooltip, Divider, Alert, CircularProgress, Badge,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import BuildCircleIcon from '@mui/icons-material/BuildCircle';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton, FilePickButton } from '../shared/UploadControls';

const CATEGORIES = ['מזגן', 'מקרר', 'רמקול', 'מכשיר', 'מלאי', 'אחר'];
const CATEGORY_ICON = { 'מזגן': '❄️', 'מקרר': '🧊', 'רמקול': '🔊', 'מכשיר': '📱', 'מלאי': '📦', 'אחר': '🔧' };
const fmtDate = (d) => { if (!d) return '—'; try { return new Date(d).toLocaleDateString('he-IL'); } catch { return '—'; } };

function mimeFromName(name = '') {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (['png', 'gif', 'webp'].includes(ext)) return `image/${ext}`;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}
function base64ToBlob(b64, mime) {
  const bytes = atob(b64); const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
// Next service due date + overdue flag from last service + cycle days.
function serviceStatus(item) {
  if (!item.last_service_at || !item.service_cycle_days) return null;
  const next = new Date(item.last_service_at);
  next.setDate(next.getDate() + Number(item.service_cycle_days));
  const overdue = next < new Date();
  return { next, overdue };
}

// ---------- Item create/edit dialog ----------
function ItemDialog({ open, item, category, branchId, onClose, onSaved }) {
  const [d, setD] = useState({});
  useEffect(() => {
    setD(item ? {
      name: item.name || '', model: item.model || '', location: item.location || '',
      quantity: item.quantity ?? 1,
      last_service_at: item.last_service_at ? new Date(item.last_service_at).toISOString().slice(0, 10) : '',
      service_cycle_days: item.service_cycle_days ?? '', notes: item.notes || '',
    } : { name: '', model: '', location: '', quantity: 1, last_service_at: '', service_cycle_days: '', notes: '' });
  }, [item, open]);
  const save = () => {
    if (!d.name?.trim()) return toast.error('שם נדרש');
    const payload = {
      ...d, branch_id: branchId, category,
      quantity: Number(d.quantity) || 1,
      last_service_at: d.last_service_at || null,
      service_cycle_days: d.service_cycle_days ? Number(d.service_cycle_days) : null,
    };
    const req = item ? api.put(`/maintenance/${item._id}`, payload) : api.post('/maintenance', payload);
    req.then(() => { toast.success('נשמר'); onSaved(); onClose(); }).catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle>{item ? 'עריכת פריט' : `פריט חדש — ${category}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField size="small" label="שם" value={d.name || ''} onChange={e => setD(x => ({ ...x, name: e.target.value }))} fullWidth />
            <TextField size="small" label="דגם" value={d.model || ''} onChange={e => setD(x => ({ ...x, model: e.target.value }))} fullWidth />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField size="small" label="מיקום / כיתה" value={d.location || ''} onChange={e => setD(x => ({ ...x, location: e.target.value }))} fullWidth />
            <TextField size="small" type="number" label="כמות" value={d.quantity ?? 1} onChange={e => setD(x => ({ ...x, quantity: e.target.value }))} sx={{ width: 110 }} />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField size="small" type="date" label="טיפול/ניקוי אחרון" value={d.last_service_at || ''} onChange={e => setD(x => ({ ...x, last_service_at: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField size="small" type="number" label="מחזור טיפול (ימים)" value={d.service_cycle_days ?? ''} onChange={e => setD(x => ({ ...x, service_cycle_days: e.target.value }))} fullWidth />
          </Stack>
          <TextField size="small" label="הערות" value={d.notes || ''} onChange={e => setD(x => ({ ...x, notes: e.target.value }))} multiline minRows={2} fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>ביטול</Button><Button variant="contained" onClick={save}>שמור</Button></DialogActions>
    </Dialog>
  );
}

// ---------- Faults dialog ----------
function FaultsDialog({ open, item, onClose, onSaved }) {
  const confirm = useConfirm();
  const [desc, setDesc] = useState('');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const faults = item?.faults || [];
  useEffect(() => { if (open) { setDesc(''); setFile(null); } }, [open]);
  if (!item) return null;

  const onPickFile = (picked) => setFile({ name: picked.name, data: picked.data });
  const addFault = () => {
    if (!desc.trim()) return toast.error('תיאור התקלה נדרש');
    setSaving(true);
    api.post(`/maintenance/${item._id}/faults`, { description: desc, photo_data: file?.data || null, photo_name: file?.name || '' })
      .then(() => { toast.success('התקלה נפתחה'); setDesc(''); setFile(null); onSaved(); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };
  const resolve = (f, status) => api.put(`/maintenance/${item._id}/faults/${f._id}`, { status }).then(() => onSaved()).catch(() => {});
  const del = async (f) => { if (!(await confirm({ title: 'מחיקת תקלה', message: 'למחוק?' }))) return; api.delete(`/maintenance/${item._id}/faults/${f._id}`).then(() => onSaved()).catch(() => {}); };
  const viewPhoto = async (f) => {
    try {
      const res = await api.get(`/maintenance/${item._id}/faults/${f._id}/photo`);
      const url = URL.createObjectURL(base64ToBlob(res.data.data, mimeFromName(res.data.name)));
      window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('אין תמונה'); }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><BuildCircleIcon color="warning" /> תקלות — {item.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {faults.length === 0 ? <Typography variant="body2" color="text.secondary">אין תקלות רשומות.</Typography> : (
            <Table size="small">
              <TableHead><TableRow><TableCell>תיאור</TableCell><TableCell align="center">תמונה</TableCell><TableCell align="center">סטטוס</TableCell><TableCell align="center">פעולות</TableCell></TableRow></TableHead>
              <TableBody>
                {faults.map(f => (
                  <TableRow key={f._id} sx={{ bgcolor: f.status === 'open' ? '#fff7ed' : undefined }}>
                    <TableCell sx={{ whiteSpace: 'pre-wrap' }}>{f.description}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtDate(f.created_at)}</Typography></TableCell>
                    <TableCell align="center">{f.has_photo ? <IconButton size="small" onClick={() => viewPhoto(f)}><VisibilityIcon fontSize="small" /></IconButton> : '—'}</TableCell>
                    <TableCell align="center"><Chip size="small" color={f.status === 'open' ? 'warning' : 'success'} label={f.status === 'open' ? 'פתוחה' : 'טופלה'} /></TableCell>
                    <TableCell align="center">
                      {f.status === 'open'
                        ? <Tooltip title="סמן שטופל"><IconButton size="small" color="success" onClick={() => resolve(f, 'resolved')}><CheckCircleIcon fontSize="small" /></IconButton></Tooltip>
                        : <Tooltip title="פתח מחדש"><IconButton size="small" onClick={() => resolve(f, 'open')}><WarningAmberIcon fontSize="small" /></IconButton></Tooltip>}
                      <IconButton size="small" onClick={() => del(f)}><DeleteIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>פתיחת תקלה</Typography>
          <TextField size="small" label="תיאור התקלה" value={desc} onChange={e => setDesc(e.target.value)} multiline minRows={2} fullWidth />
          <Stack direction="row" spacing={1} alignItems="center">
            <FilePickButton hasFile={!!file} label="צרף תמונה" replaceLabel="החלף תמונה"
              accept="image/*" onPick={onPickFile} onError={msg => toast.error(msg)} />
            {file && <Chip size="small" label={file.name} onDelete={() => setFile(null)} />}
            <Box sx={{ flex: 1 }} />
            <BusyButton variant="contained" color="warning" onClick={addFault} loading={saving}
              loadingText={file ? 'מעלה תמונה…' : 'פותח…'}>פתח תקלה</BusyButton>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}

export default function MaintenancePage() {
  const { selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const confirm = useConfirm();
  const [cat, setCat] = useState('מזגן');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [itemDlg, setItemDlg] = useState({ open: false, item: null });
  const [faultsDlg, setFaultsDlg] = useState({ open: false, item: null });

  const load = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setItems([]); return; }
    setLoading(true);
    api.get('/maintenance', { params: { branch_id: selectedBranch } })
      .then(r => setItems(r.data.items || [])).catch(() => setItems([])).finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);
  useEffect(() => { load(); }, [load]);

  // Keep the faults dialog's item in sync after a mutation.
  const refreshFaults = () => {
    load();
    if (faultsDlg.item) {
      api.get('/maintenance', { params: { branch_id: selectedBranch, category: faultsDlg.item.category } })
        .then(r => { const fresh = (r.data.items || []).find(i => i._id === faultsDlg.item._id); if (fresh) setFaultsDlg(s => ({ ...s, item: fresh })); });
    }
  };

  const delItem = async (it) => {
    if (!(await confirm({ title: 'הסרת פריט', message: `להסיר את "${it.name}"?` }))) return;
    api.delete(`/maintenance/${it._id}`).then(() => load()).catch(() => {});
  };

  if (isAllBranches) return <Alert severity="info" sx={{ m: 2 }}>בחר/י סניף ספציפי (למעלה) כדי לנהל אחזקה.</Alert>;

  const catItems = items.filter(i => i.category === cat);
  const openFaultsByCat = (c) => items.filter(i => i.category === c).reduce((s, i) => s + (i.open_faults || 0), 0);

  return (
    <Box dir="rtl">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>אחזקה — {selectedBranchName}</Typography>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setItemDlg({ open: true, item: null })}>פריט חדש</Button>
      </Stack>

      <Tabs value={cat} onChange={(_e, v) => setCat(v)} variant="scrollable" scrollButtons="auto" sx={{ mb: 2 }}>
        {CATEGORIES.map(c => (
          <Tab key={c} value={c} label={
            <Badge color="error" badgeContent={openFaultsByCat(c)}>
              <span>{CATEGORY_ICON[c]} {c}</span>
            </Badge>
          } />
        ))}
      </Tabs>

      {loading ? <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box> : (
        <Paper variant="outlined" sx={{ borderRadius: 2 }}>
          {catItems.length === 0 ? (
            <Alert severity="info" sx={{ m: 2 }}>אין פריטים בקטגוריה "{cat}". לחצ/י "פריט חדש".</Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>שם</TableCell><TableCell>דגם</TableCell><TableCell>מיקום</TableCell>
                  <TableCell align="center">כמות</TableCell><TableCell>טיפול אחרון</TableCell>
                  <TableCell>מחזור</TableCell><TableCell align="center">תקלות</TableCell><TableCell align="center">פעולות</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {catItems.map(it => {
                  const ss = serviceStatus(it);
                  return (
                    <TableRow key={it._id} sx={{ bgcolor: ss?.overdue ? '#fef2f2' : undefined }}>
                      <TableCell sx={{ fontWeight: 600 }}>{it.name}</TableCell>
                      <TableCell>{it.model || '—'}</TableCell>
                      <TableCell>{it.location || '—'}</TableCell>
                      <TableCell align="center">{it.quantity}</TableCell>
                      <TableCell>{fmtDate(it.last_service_at)}</TableCell>
                      <TableCell>
                        {it.service_cycle_days ? `${it.service_cycle_days} ימים` : '—'}
                        {ss && <Chip size="small" sx={{ ml: 0.5 }} color={ss.overdue ? 'error' : 'default'} label={ss.overdue ? 'טיפול נדרש' : `הבא: ${fmtDate(ss.next)}`} />}
                      </TableCell>
                      <TableCell align="center">
                        <Button size="small" color={it.open_faults ? 'warning' : 'inherit'} startIcon={<BuildCircleIcon />} onClick={() => setFaultsDlg({ open: true, item: it })}>
                          {it.open_faults ? `${it.open_faults} פתוחות` : 'תקלות'}
                        </Button>
                      </TableCell>
                      <TableCell align="center">
                        <IconButton size="small" onClick={() => setItemDlg({ open: true, item: it })}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" color="error" onClick={() => delItem(it)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}

      <ItemDialog open={itemDlg.open} item={itemDlg.item} category={itemDlg.item?.category || cat} branchId={selectedBranch}
        onClose={() => setItemDlg({ open: false, item: null })} onSaved={load} />
      <FaultsDialog open={faultsDlg.open} item={faultsDlg.item}
        onClose={() => setFaultsDlg({ open: false, item: null })} onSaved={refreshFaults} />
    </Box>
  );
}
