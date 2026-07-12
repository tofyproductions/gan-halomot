import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack, Typography,
  Chip, CircularProgress, Table, TableHead, TableBody, TableRow, TableCell, Checkbox,
  IconButton, Collapse, Paper, Tabs, Tab, TextField, Autocomplete, Alert,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';

/* Nested preview of the exact hours-report HTML that will be sent. */
function HoursPreview({ open, onClose, title, month, scope, employeeId, branch }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) { setHtml(''); return; }
    let cancelled = false;
    setLoading(true); setHtml('');
    api.get('/payroll/hours-distribution/preview-html', {
      params: { month, scope, employee_id: employeeId, branch }, responseType: 'text', timeout: 180000,
    }).then(res => { if (!cancelled) setHtml(res.data); })
      .catch(() => { if (!cancelled) toast.error('שגיאה בטעינת התצוגה'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, month, scope, employeeId, branch]);
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth PaperProps={{ sx: { height: '92vh' } }}>
      <DialogTitle sx={{ fontWeight: 700 }}>תצוגה מקדימה — {title}</DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: '#f1f5f9' }}>
        {loading ? <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
          : <iframe title="hours" srcDoc={html} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}

/**
 * Rich monthly hours-report distribution — mirrors the payslip send flow:
 * send per employee, consolidated per branch manager, or the whole company to
 * the office. Plus an optional "specific email" override with quick-pick of
 * known manager addresses.
 */
export default function HoursDistributionDialog({ open, onClose, month }) {
  const confirm = useConfirm();
  const [tab, setTab] = useState('managers');   // 'managers' | 'employees'
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [empSel, setEmpSel] = useState({});     // managers mode: { [branch]: { [id]: bool } }
  const [expanded, setExpanded] = useState({});
  const [sel, setSel] = useState({});           // employees mode: { [id]: bool }
  const [specificEmail, setSpecificEmail] = useState('');
  const [preview, setPreview] = useState(null);

  const officeItem = items.find(it => it.is_office);
  const allEmployees = officeItem?.employees || [];

  const load = () => {
    setLoading(true);
    api.get('/payroll/hours-distribution/preview', { params: { month } })
      .then(res => {
        const its = res.data.items || [];
        setItems(its);
        const es = {};
        its.forEach(it => { es[it.branch] = {}; it.employees.forEach(e => { es[it.branch][e.employee_id] = true; }); });
        setEmpSel(es);
        const s = {};
        (its.find(x => x.is_office)?.employees || []).forEach(e => { s[e.employee_id] = true; });
        setSel(s);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, month]);

  // Known manager emails for the quick-pick.
  const managerEmails = [...new Set(items.flatMap(it => (it.email || '').split(',').map(s => s.trim()).filter(Boolean)))];

  // ── Managers/office mode ──
  const mSelCount = (b) => Object.values(empSel[b] || {}).filter(Boolean).length;
  const mToggleEmp = (b, id) => setEmpSel(s => ({ ...s, [b]: { ...s[b], [id]: !s[b]?.[id] } }));
  const mToggleBranch = (it, v) => setEmpSel(s => { const o = {}; it.employees.forEach(e => { o[e.employee_id] = v; }); return { ...s, [it.branch]: o }; });
  const mTotalSel = items.reduce((n, it) => n + mSelCount(it.branch), 0);

  const sendManagers = async () => {
    const branches = []; const branch_employees = {};
    items.forEach(it => {
      const ids = it.employees.filter(e => empSel[it.branch]?.[e.employee_id]).map(e => e.employee_id);
      if (ids.length) { branches.push(it.branch); branch_employees[it.branch] = ids; }
    });
    if (branches.length === 0) { toast.error('בחר/י לפחות עובד אחד'); return; }
    const to = specificEmail.trim();
    const who = to ? `לכתובת ${to}` : 'למנהלי הסניפים / משרד';
    if (!(await confirm({ title: 'שליחת דוחות שעות', message: `לשלוח דוחות שעות מרוכזים (${month}) ${who}?`, confirm_label: 'שלח' }))) return;
    setBusy(true);
    try {
      const res = await api.post('/payroll/hours-distribution/send-managers', { month, branches, branch_employees, ...(to ? { to } : {}) }, { timeout: 120000 });
      toast.success(`השליחה החלה — ${res.data.count} יעדים. הכנת PDF אורכת 1-3 דק'.`, { autoClose: 8000 });
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשליחה'); }
    finally { setBusy(false); }
  };

  // ── Employees mode ──
  const selectedIds = allEmployees.filter(e => sel[e.employee_id]).map(e => e.employee_id);
  const allChecked = allEmployees.length > 0 && selectedIds.length === allEmployees.length;
  const someChecked = selectedIds.length > 0 && !allChecked;

  const sendEmployees = async () => {
    if (selectedIds.length === 0) { toast.error('בחר/י לפחות עובד אחד'); return; }
    const to = specificEmail.trim();
    const who = to ? `לכתובת ${to}` : 'לכל עובד/ת למייל שלו/ה';
    if (!(await confirm({ title: 'שליחת דוחות שעות לעובדים', message: `לשלוח דוח שעות (${month}) ל-${selectedIds.length} עובדים — ${who}?`, confirm_label: 'שלח' }))) return;
    setBusy(true);
    try {
      const res = await api.post('/payroll/hours-distribution/send-employees', { month, employee_ids: selectedIds, ...(to ? { to } : {}) }, { timeout: 120000 });
      toast.success(`השליחה החלה — ${res.data.count} עובדים. הכנת PDF אורכת מספר דקות.`, { autoClose: 8000 });
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשליחה'); }
    finally { setBusy(false); }
  };

  const emailField = (
    <Autocomplete freeSolo options={managerEmails} value={specificEmail}
      onInputChange={(_, v) => setSpecificEmail(v)} sx={{ minWidth: 260 }}
      renderInput={(p) => <TextField {...p} size="small" label="מייל ספציפי (אופציונלי)" placeholder="השאר/י ריק לשליחה רגילה" dir="ltr" />} />
  );

  return (
    <>
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth PaperProps={{ sx: { height: '90vh' } }}>
      <DialogTitle sx={{ fontWeight: 800, pb: 0 }}>
        שליחת דוחות שעות · {month}
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mt: 1, minHeight: 36 }}>
          <Tab value="managers" label="למנהלים / משרד" sx={{ minHeight: 36 }} />
          <Tab value="employees" label="לעובדים" sx={{ minHeight: 36 }} />
        </Tabs>
      </DialogTitle>
      <DialogContent dividers>
        {loading ? <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box> : tab === 'managers' ? (
          <Stack spacing={1} sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              כל מנהל/ת סניף מקבל/ת דוח מרוכז של עובדי הסניף; "כל הסניפים" נשלח למשרד. פתח/י סניף לבחירת עובדים ותצוגה.
            </Typography>
            {items.map((it, i) => {
              const emps = it.employees || [];
              const sc = mSelCount(it.branch);
              const allS = emps.length > 0 && sc === emps.length;
              const someS = sc > 0 && !allS;
              return (
                <Paper key={i} variant="outlined" sx={{ borderColor: it.email ? 'divider' : 'warning.light' }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
                    <Checkbox size="small" checked={allS} indeterminate={someS} onChange={e => mToggleBranch(it, e.target.checked)} />
                    <IconButton size="small" onClick={() => setExpanded(x => ({ ...x, [it.branch]: !x[it.branch] }))}>
                      {expanded[it.branch] ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 700 }}>{it.branch}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>{sc}/{emps.length} עובדים</Typography>
                      </Typography>
                      <Typography variant="caption" color={it.email ? 'text.secondary' : 'warning.main'} dir="ltr" sx={{ display: 'block' }}>
                        {it.email || 'אין מייל מנהל/ת — יישלח רק אם תזין/י מייל ספציפי'}
                      </Typography>
                    </Box>
                    <Button size="small" variant="text" onClick={() => setPreview({ title: it.branch, scope: 'branch', branch: it.branch })} sx={{ fontSize: 11 }}>תצוגת סניף</Button>
                  </Stack>
                  <Collapse in={!!expanded[it.branch]}>
                    <Table size="small" sx={{ bgcolor: 'grey.50' }}>
                      <TableBody>
                        {emps.map((e, j) => (
                          <TableRow key={j}>
                            <TableCell padding="checkbox"><Checkbox size="small" checked={!!empSel[it.branch]?.[e.employee_id]} onChange={() => mToggleEmp(it.branch, e.employee_id)} /></TableCell>
                            <TableCell sx={{ fontWeight: 600 }}>{e.name}</TableCell>
                            <TableCell dir="ltr"><Typography variant="caption">{e.israeli_id}</Typography></TableCell>
                            <TableCell align="center"><Button size="small" variant="text" onClick={() => setPreview({ title: e.name, scope: 'employee', employeeId: e.employee_id })} sx={{ minWidth: 0, fontSize: 11 }}>תצוגה</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Collapse>
                </Paper>
              );
            })}
          </Stack>
        ) : (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">כל עובד/ת מקבל/ת את דוח השעות שלו/ה למייל שלו/ה (אלא אם הוזן מייל ספציפי).</Typography>
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox"><Checkbox size="small" checked={allChecked} indeterminate={someChecked} onChange={e => { const v = e.target.checked; const s = {}; allEmployees.forEach(x => { s[x.employee_id] = v; }); setSel(s); }} /></TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>עובד</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>מייל</TableCell>
                  <TableCell align="center" />
                </TableRow>
              </TableHead>
              <TableBody>
                {allEmployees.map((e, i) => (
                  <TableRow key={i} sx={{ bgcolor: !e.email ? '#fffbeb' : undefined }}>
                    <TableCell padding="checkbox"><Checkbox size="small" checked={!!sel[e.employee_id]} onChange={() => setSel(s => ({ ...s, [e.employee_id]: !s[e.employee_id] }))} /></TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{e.name}</TableCell>
                    <TableCell dir="ltr"><Typography variant="caption" color={e.email ? 'text.secondary' : 'warning.main'}>{e.email || 'אין מייל'}</Typography></TableCell>
                    <TableCell align="center"><Button size="small" variant="text" onClick={() => setPreview({ title: e.name, scope: 'employee', employeeId: e.employee_id })} sx={{ minWidth: 0, fontSize: 11 }}>תצוגה</Button></TableCell>
                  </TableRow>
                ))}
                {allEmployees.length === 0 && <TableRow><TableCell colSpan={4} align="center" sx={{ py: 2, color: 'text.secondary' }}>אין עובדים.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {emailField}
        <Box sx={{ flex: 1 }} />
        {tab === 'managers'
          ? <Button variant="contained" onClick={sendManagers} disabled={busy || loading || mTotalSel === 0}>שלח לנבחרים ({mTotalSel})</Button>
          : <Button variant="contained" onClick={sendEmployees} disabled={busy || loading || selectedIds.length === 0}>שלח לנבחרים ({selectedIds.length})</Button>}
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
    <HoursPreview open={!!preview} onClose={() => setPreview(null)} month={month}
      title={preview?.title || ''} scope={preview?.scope} employeeId={preview?.employeeId} branch={preview?.branch} />
    </>
  );
}
