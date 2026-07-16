import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, IconButton,
  Chip, Table, TableHead, TableBody, TableRow, TableCell, Accordion,
  AccordionSummary, AccordionDetails, Dialog, DialogTitle, DialogContent,
  DialogActions, Tooltip, Divider, Alert, CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PeopleIcon from '@mui/icons-material/People';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים', 'קבוצה'];
const STATUS = {
  scheduled: { label: 'מתוכנן', color: 'default' },
  occurred: { label: 'התקיים', color: 'success' },
  no_show: { label: 'לא הגיע', color: 'error' },
  postponed: { label: 'נדחה', color: 'warning' },
};
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const ils = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;

// ---------- Providers manager (ספקי גנים) ----------
function ProvidersDialog({ open, onClose }) {
  const confirm = useConfirm();
  const [providers, setProviders] = useState([]);
  const [draft, setDraft] = useState({ name: '', field: '', phone: '', email: '' });
  const load = () => api.get('/classes/providers').then(r => setProviders(r.data.providers || [])).catch(() => {});
  useEffect(() => { if (open) { load(); setDraft({ name: '', field: '', phone: '', email: '' }); } }, [open]);
  const add = () => {
    if (!draft.name.trim()) return toast.error('שם ספק נדרש');
    api.post('/classes/providers', draft).then(() => { toast.success('נוסף'); setDraft({ name: '', field: '', phone: '', email: '' }); load(); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  const del = async (p) => {
    if (!(await confirm({ title: 'הסרת ספק', message: `להסיר את "${p.name}"?` }))) return;
    api.delete(`/classes/providers/${p._id}`).then(() => load()).catch(() => {});
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><PeopleIcon color="primary" /> ספקי גנים</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {providers.length > 0 && (
            <Table size="small">
              <TableHead><TableRow><TableCell>שם</TableCell><TableCell>תחום</TableCell><TableCell>טלפון</TableCell><TableCell /></TableRow></TableHead>
              <TableBody>
                {providers.map(p => (
                  <TableRow key={p._id}>
                    <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                    <TableCell>{p.field || '—'}</TableCell>
                    <TableCell>{p.phone || '—'}</TableCell>
                    <TableCell align="left"><IconButton size="small" color="error" onClick={() => del(p)}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Divider />
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הוספת ספק</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField size="small" label="שם" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
            <TextField size="small" label="תחום" value={draft.field} onChange={e => setDraft(d => ({ ...d, field: e.target.value }))} />
            <TextField size="small" label="טלפון" value={draft.phone} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} />
            <Button variant="contained" startIcon={<AddIcon />} onClick={add}>הוסף</Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}

// ---------- Program create/edit dialog ----------
function ProgramDialog({ open, program, branchId, providers, onClose, onSaved }) {
  const [d, setD] = useState({});
  useEffect(() => {
    setD(program ? {
      name: program.name || '', provider_id: program.provider_id?._id || program.provider_id || '',
      instructor_name: program.instructor_name || '', classroom_category: program.classroom_category || '',
      default_rate: program.default_rate ?? '', default_day: program.default_day ?? '', default_time: program.default_time || '',
    } : { name: '', provider_id: '', instructor_name: '', classroom_category: '', default_rate: '', default_day: '', default_time: '' });
  }, [program, open]);
  const save = () => {
    if (!d.name?.trim()) return toast.error('שם חוג נדרש');
    const payload = { ...d, branch_id: branchId, default_rate: Number(d.default_rate) || 0, default_day: d.default_day === '' ? null : Number(d.default_day) };
    const req = program ? api.put(`/classes/programs/${program._id}`, payload) : api.post('/classes/programs', payload);
    req.then(() => { toast.success('נשמר'); onSaved(); onClose(); }).catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle>{program ? 'עריכת חוג' : 'חוג חדש'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField size="small" label="שם החוג" value={d.name || ''} onChange={e => setD(x => ({ ...x, name: e.target.value }))} fullWidth />
          <Stack direction="row" spacing={2}>
            <TextField size="small" select label="ספק" value={d.provider_id || ''} onChange={e => setD(x => ({ ...x, provider_id: e.target.value }))} fullWidth>
              <MenuItem value="">— ללא —</MenuItem>
              {providers.map(p => <MenuItem key={p._id} value={p._id}>{p.name}</MenuItem>)}
            </TextField>
            <TextField size="small" label="שם מדריך" value={d.instructor_name || ''} onChange={e => setD(x => ({ ...x, instructor_name: e.target.value }))} fullWidth />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField size="small" select label="קטגוריית כיתה" value={d.classroom_category || ''} onChange={e => setD(x => ({ ...x, classroom_category: e.target.value }))} fullWidth>
              <MenuItem value="">— כללי —</MenuItem>
              {CATEGORIES.map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
            <TextField size="small" type="number" label="תעריף למפגש (₪)" value={d.default_rate ?? ''} onChange={e => setD(x => ({ ...x, default_rate: e.target.value }))} fullWidth />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField size="small" select label="יום קבוע" value={d.default_day ?? ''} onChange={e => setD(x => ({ ...x, default_day: e.target.value }))} fullWidth>
              <MenuItem value="">— גמיש —</MenuItem>
              {DAY_NAMES.map((n, i) => <MenuItem key={i} value={i}>{n}</MenuItem>)}
            </TextField>
            <TextField size="small" type="time" label="שעה קבועה" value={d.default_time || ''} onChange={e => setD(x => ({ ...x, default_time: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>ביטול</Button><Button variant="contained" onClick={save}>שמור</Button></DialogActions>
    </Dialog>
  );
}

// ---------- One program's monthly sessions ----------
function ProgramSessions({ program, month, onChanged }) {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState([]);
  const [newDate, setNewDate] = useState('');
  const load = useCallback(() => {
    api.get('/classes/sessions', { params: { program_id: program._id, month } })
      .then(r => setSessions(r.data.sessions || [])).catch(() => setSessions([]));
  }, [program._id, month]);
  useEffect(() => { load(); }, [load]);

  const addDate = () => {
    if (!newDate) return;
    api.post('/classes/sessions', { program_id: program._id, date: newDate })
      .then(() => { setNewDate(''); load(); onChanged && onChanged(); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  const setStatus = (s, status) => {
    // Manual status set (occurred / no_show) — reuses the answer endpoint.
    api.post(`/classes/sessions/${s._id}/answer`, { arrived: status === 'occurred', reason: '' })
      .then(() => { load(); onChanged && onChanged(); }).catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  const del = async (s) => {
    if (!(await confirm({ title: 'מחיקת מפגש', message: `למחוק את המפגש ${s.date}?` }))) return;
    api.delete(`/classes/sessions/${s._id}`).then(() => { load(); onChanged && onChanged(); }).catch(() => {});
  };

  const occurred = sessions.filter(s => s.status === 'occurred');
  const total = occurred.reduce((sum, s) => sum + (Number(s.rate) || 0), 0);

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <TextField size="small" type="date" value={newDate} onChange={e => setNewDate(e.target.value)} InputLabelProps={{ shrink: true }} />
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addDate}>הוסף מפגש</Button>
        <Box sx={{ flex: 1 }} />
        <Chip color="success" label={`סה״כ לתשלום: ${ils(total)} (${occurred.length} מפגשים)`} sx={{ fontWeight: 700 }} />
      </Stack>
      {sessions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">אין מפגשים בחודש זה.</Typography>
      ) : (
        <Table size="small">
          <TableHead><TableRow>
            <TableCell>תאריך</TableCell><TableCell>שעה</TableCell><TableCell align="center">תעריף</TableCell>
            <TableCell align="center">סטטוס</TableCell><TableCell align="center">פעולות</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {sessions.map(s => (
              <TableRow key={s._id}>
                <TableCell>{s.date}</TableCell>
                <TableCell>{s.time || '—'}</TableCell>
                <TableCell align="center">{ils(s.rate)}</TableCell>
                <TableCell align="center">
                  <Chip size="small" color={STATUS[s.status]?.color || 'default'} label={STATUS[s.status]?.label || s.status} />
                  {s.status === 'postponed' && s.postponed_to_date && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'warning.main' }}>→ {s.postponed_to_date}</Typography>
                  )}
                  {s.status === 'occurred' && s.answered_by_lead && !s.manager_confirmed && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'info.main' }}>ממתין לאישור מנהל</Typography>
                  )}
                </TableCell>
                <TableCell align="center">
                  <Stack direction="row" spacing={0.5} justifyContent="center">
                    {s.status !== 'occurred' && <Tooltip title="סמן שהתקיים"><Button size="small" color="success" onClick={() => setStatus(s, 'occurred')}>הגיע</Button></Tooltip>}
                    {s.status !== 'no_show' && s.status !== 'postponed' && <Tooltip title="סמן שלא הגיע"><Button size="small" color="error" onClick={() => setStatus(s, 'no_show')}>לא</Button></Tooltip>}
                    <IconButton size="small" onClick={() => del(s)}><DeleteIcon fontSize="small" /></IconButton>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

export default function ClassTrackingPage() {
  const { selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const confirm = useConfirm();
  const [month, setMonth] = useState(thisMonth());
  const [programs, setPrograms] = useState([]);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [progDlg, setProgDlg] = useState({ open: false, program: null });
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setPrograms([]); return; }
    setLoading(true);
    Promise.all([
      api.get('/classes/programs', { params: { branch: selectedBranch, active: 'true' } }),
      api.get('/classes/providers', { params: { active: 'true' } }),
    ]).then(([pr, pv]) => { setPrograms(pr.data.programs || []); setProviders(pv.data.providers || []); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const delProgram = async (p) => {
    if (!(await confirm({ title: 'הסרת חוג', message: `להסיר את "${p.name}"?` }))) return;
    api.delete(`/classes/programs/${p._id}`).then(() => load()).catch(() => {});
  };

  if (isAllBranches) {
    return <Alert severity="info" sx={{ m: 2 }}>בחר/י סניף ספציפי (למעלה) כדי לנהל מעקב חוגים.</Alert>;
  }

  return (
    <Box dir="rtl">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>מעקב חוגים — {selectedBranchName}</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField size="small" type="month" label="חודש" value={month} onChange={e => setMonth(e.target.value)} InputLabelProps={{ shrink: true }} />
        <Button variant="outlined" startIcon={<PeopleIcon />} onClick={() => setProvidersOpen(true)}>ספקי גנים</Button>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setProgDlg({ open: true, program: null })}>חוג חדש</Button>
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
      ) : programs.length === 0 ? (
        <Alert severity="info">אין חוגים בסניף זה עדיין. לחצ/י "חוג חדש" כדי להוסיף.</Alert>
      ) : (
        programs.map(p => (
          <Accordion key={p._id} defaultExpanded={programs.length <= 3} sx={{ mb: 1 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                <Typography sx={{ fontWeight: 700 }}>{p.name}</Typography>
                {p.instructor_name && <Chip size="small" label={p.instructor_name} />}
                {p.classroom_category && <Chip size="small" variant="outlined" label={p.classroom_category} />}
                {p.default_day != null && <Chip size="small" variant="outlined" label={`יום ${DAY_NAMES[p.default_day]}${p.default_time ? ` ${p.default_time}` : ''}`} />}
                <Chip size="small" variant="outlined" label={`${ils(p.default_rate)}/מפגש`} />
                <Box sx={{ flex: 1 }} />
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); setProgDlg({ open: true, program: p }); }}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); delProgram(p); }}><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <ProgramSessions program={p} month={month} onChanged={() => {}} />
            </AccordionDetails>
          </Accordion>
        ))
      )}

      <ProvidersDialog open={providersOpen} onClose={() => { setProvidersOpen(false); setRefreshKey(k => k + 1); }} />
      <ProgramDialog
        open={progDlg.open} program={progDlg.program} branchId={selectedBranch} providers={providers}
        onClose={() => setProgDlg({ open: false, program: null })} onSaved={() => setRefreshKey(k => k + 1)}
      />
    </Box>
  );
}
