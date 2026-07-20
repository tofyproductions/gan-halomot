import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, IconButton, Chip,
  Table, TableHead, TableBody, TableRow, TableCell, Dialog, DialogTitle,
  DialogContent, DialogActions, Tooltip, Alert, CircularProgress, Link,
} from '@mui/material';
import PhoneIcon from '@mui/icons-material/Phone';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';

const STATUS = {
  new:            { label: 'חדש',          color: 'warning' },
  contacted:      { label: 'נוצר קשר',     color: 'info' },
  tour_scheduled: { label: 'נקבע סיור',    color: 'primary' },
  converted:      { label: 'הומר ללקוח',   color: 'success' },
  closed:         { label: 'סגור',         color: 'default' },
};
const STATUS_ORDER = ['new', 'contacted', 'tour_scheduled', 'converted', 'closed'];
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }); } catch { return ''; } };
// Israeli mobile → intl for wa.me (0501234567 → 972501234567).
const waNumber = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return '972' + digits.slice(1);
  return digits;
};

function LeadDialog({ open, lead, branches, onClose, onSaved }) {
  const [d, setD] = useState({});
  useEffect(() => { setD(lead ? { ...lead } : {}); }, [lead, open]);
  if (!lead) return null;
  const save = () => {
    api.put(`/leads/${lead.id}`, {
      parent_name: d.parent_name, parent_phone: d.parent_phone, parent_email: d.parent_email,
      child_name: d.child_name, child_birth_date: d.child_birth_date, message: d.message,
      manager_note: d.manager_note, branch_id: d.branch_id?._id || d.branch_id || null, status: d.status,
    })
      .then(() => { toast.success('נשמר'); onSaved(); onClose(); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle>פנייה — {lead.parent_name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField label="שם ההורה" value={d.parent_name || ''} onChange={e => setD(x => ({ ...x, parent_name: e.target.value }))} fullWidth size="small" />
            <TextField label="טלפון" value={d.parent_phone || ''} onChange={e => setD(x => ({ ...x, parent_phone: e.target.value }))} fullWidth size="small" inputProps={{ dir: 'ltr' }} />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="אימייל" value={d.parent_email || ''} onChange={e => setD(x => ({ ...x, parent_email: e.target.value }))} fullWidth size="small" inputProps={{ dir: 'ltr' }} />
            <TextField select label="סניף" value={d.branch_id?._id || d.branch_id || ''} onChange={e => setD(x => ({ ...x, branch_id: e.target.value }))} fullWidth size="small">
              <MenuItem value="">— לא נבחר —</MenuItem>
              {branches.map(b => <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="שם הילד/ה" value={d.child_name || ''} onChange={e => setD(x => ({ ...x, child_name: e.target.value }))} fullWidth size="small" />
            <TextField label="גיל / תאריך לידה" value={d.child_birth_date || ''} onChange={e => setD(x => ({ ...x, child_birth_date: e.target.value }))} fullWidth size="small" />
          </Stack>
          <TextField select label="סטטוס" value={d.status || 'new'} onChange={e => setD(x => ({ ...x, status: e.target.value }))} fullWidth size="small">
            {STATUS_ORDER.map(s => <MenuItem key={s} value={s}>{STATUS[s].label}</MenuItem>)}
          </TextField>
          {d.message && <TextField label="הודעת ההורה" value={d.message} fullWidth size="small" multiline InputProps={{ readOnly: true }} />}
          <TextField label="הערות פנימיות (מעקב)" value={d.manager_note || ''} onChange={e => setD(x => ({ ...x, manager_note: e.target.value }))} fullWidth size="small" multiline minRows={2} />
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>ביטול</Button><Button variant="contained" onClick={save}>שמור</Button></DialogActions>
    </Dialog>
  );
}

export default function LeadsPage() {
  const { branches, selectedBranch } = useBranch();
  const confirm = useConfirm();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [dlg, setDlg] = useState({ open: false, lead: null });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/leads', { params: statusFilter ? { status: statusFilter } : {} })
      .then(r => setLeads(r.data.leads || []))
      .catch(() => setLeads([]))
      .finally(() => setLoading(false));
  }, [statusFilter]);
  useEffect(() => { load(); }, [load]);

  const quickStatus = (lead, status) => {
    api.put(`/leads/${lead.id}`, { status }).then(load).catch(() => {});
  };
  const del = async (lead) => {
    if (!(await confirm({ title: 'מחיקת פנייה', message: `למחוק את הפנייה של ${lead.parent_name}?`, danger: true }))) return;
    api.delete(`/leads/${lead.id}`).then(() => { toast.success('נמחק'); load(); }).catch(() => {});
  };

  const copyLink = (path) => {
    const url = `${window.location.origin}${path}`;
    navigator.clipboard?.writeText(url).then(() => toast.success('הקישור הועתק')).catch(() => toast.info(url));
  };

  const newCount = leads.filter(l => l.status === 'new').length;

  return (
    <Box dir="rtl">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          פניות הורים {newCount > 0 && <Chip size="small" color="warning" label={`${newCount} חדשות`} sx={{ ml: 1 }} />}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <TextField select size="small" label="סטטוס" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} sx={{ minWidth: 150 }}>
          <MenuItem value="">הכל</MenuItem>
          {STATUS_ORDER.map(s => <MenuItem key={s} value={s}>{STATUS[s].label}</MenuItem>)}
        </TextField>
      </Stack>

      {/* Shareable public links for ads */}
      <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2, bgcolor: '#fafbff' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>קישורים לפרסום</Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => copyLink('/lead')}>קישור כללי</Button>
          {selectedBranch && selectedBranch !== 'all' && (
            <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => copyLink(`/lead/${selectedBranch}`)}>
              קישור לסניף הנבחר
            </Button>
          )}
        </Stack>
      </Paper>

      {loading ? <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box> : (
        <Paper variant="outlined" sx={{ borderRadius: 2 }}>
          {leads.length === 0 ? (
            <Alert severity="info" sx={{ m: 2 }}>אין פניות{statusFilter ? ' בסטטוס זה' : ''} עדיין.</Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>תאריך</TableCell><TableCell>הורה</TableCell><TableCell>טלפון</TableCell>
                  <TableCell>ילד/ה</TableCell><TableCell>סניף</TableCell><TableCell>סטטוס</TableCell>
                  <TableCell align="center">פעולות</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {leads.map(l => (
                  <TableRow key={l.id} hover sx={{ bgcolor: l.status === 'new' ? '#fffbeb' : undefined }}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(l.created_at)}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{l.parent_name}</TableCell>
                    <TableCell dir="ltr">{l.parent_phone}</TableCell>
                    <TableCell>{l.child_name || '—'}{l.child_birth_date ? ` (${l.child_birth_date})` : ''}</TableCell>
                    <TableCell>{l.branch_name || '—'}</TableCell>
                    <TableCell>
                      <TextField select size="small" variant="standard" value={l.status}
                        onChange={e => quickStatus(l, e.target.value)} sx={{ minWidth: 110 }}>
                        {STATUS_ORDER.map(s => <MenuItem key={s} value={s}>{STATUS[s].label}</MenuItem>)}
                      </TextField>
                    </TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.3} justifyContent="center">
                        <Tooltip title="התקשר"><IconButton size="small" color="primary" component={Link} href={`tel:${l.parent_phone}`}><PhoneIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="וואטסאפ"><IconButton size="small" sx={{ color: '#25D366' }} component={Link} href={`https://wa.me/${waNumber(l.parent_phone)}`} target="_blank" rel="noopener"><WhatsAppIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="ערוך"><IconButton size="small" onClick={() => setDlg({ open: true, lead: l })}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title="מחק"><IconButton size="small" color="error" onClick={() => del(l)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}

      <LeadDialog open={dlg.open} lead={dlg.lead} branches={branches}
        onClose={() => setDlg({ open: false, lead: null })} onSaved={load} />
    </Box>
  );
}
