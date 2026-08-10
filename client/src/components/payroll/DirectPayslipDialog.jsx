import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack, Typography,
  Chip, TextField, Divider, CircularProgress, Table, TableHead, TableBody, TableRow,
  TableCell, IconButton, Tooltip, Alert, AlertTitle, Checkbox, Autocomplete,
  FormControlLabel, Switch,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import VisibilityIcon from '@mui/icons-material/Visibility';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton, UploadingBar } from '../shared/UploadControls';

const STATUS = {
  pending:  { label: 'מוכן לשליחה', color: 'info' },
  sent:     { label: 'נשלח', color: 'success' },
  no_match: { label: 'לא זוהה עובד', color: 'error' },
  no_email: { label: 'אין מייל', color: 'warning' },
  error:    { label: 'שגיאה', color: 'error' },
};

const BASIS = { israeli_id: 'ת״ז', name: 'שם', manual: 'ידני' };

const fmtDateTime = (d) => { try { return d ? new Date(d).toLocaleString('he-IL') : ''; } catch { return ''; } };

/**
 * Send a final payslip file without an audit — including a single page for one
 * employee who was missed in the big file.
 *
 * Upload parses and matches by ת״ז; nothing goes out until the user picks rows
 * and presses send. Delivery is the same as the audit path: the page is mailed,
 * archived to "התלושים שלי", and the month is marked paid.
 */
export default function DirectPayslipDialog({ open, onClose, defaultMonth }) {
  const confirm = useConfirm();
  const [file, setFile] = useState(null);
  const [month, setMonth] = useState(defaultMonth || '');
  const [branch, setBranch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [batch, setBatch] = useState(null);
  const [sel, setSel] = useState({});
  const [sending, setSending] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [includeHours, setIncludeHours] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [otherMonths, setOtherMonths] = useState([]);

  useEffect(() => {
    if (!open) return;
    setFile(null); setBatch(null); setSel({}); setTestTo(''); setOtherMonths([]);
    setMonth(defaultMonth || '');
    api.get('/payroll/employees', { params: { active: 'true', branch: 'all' } })
      .then(res => setEmployees(res.data.employees || []))
      .catch(() => setEmployees([]));
  }, [open, defaultMonth]);

  const upload = () => {
    if (!file) return toast.error('בחר/י קובץ PDF');
    setUploading(true);
    const form = new FormData();
    form.append('payslip_file', file);
    if (month) form.append('month', month);
    if (branch.trim()) form.append('branch', branch.trim());
    api.post('/payroll/direct-payslips', form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 })
      .then((res) => {
        setBatch(res.data.batch);
        setOtherMonths(res.data.other_months || []);
        setMonth(res.data.batch.month);
        // Pre-select everything that is actually sendable — the common case is
        // "send all of this file", and a single page is one click either way.
        const next = {};
        for (const it of res.data.batch.items) if (it.status === 'pending') next[it.page] = true;
        setSel(next);
        toast.success(`זוהו ${res.data.batch.page_count} תלושים`);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בקריאת הקובץ'))
      .finally(() => setUploading(false));
  };

  const selectedPages = useMemo(
    () => (batch?.items || []).filter(i => sel[i.page]).map(i => i.page),
    [batch, sel],
  );
  const sendable = (batch?.items || []).filter(i => i.status === 'pending' || i.status === 'sent');

  const assign = (page, emp) => {
    if (!emp) return;
    api.put(`/payroll/direct-payslips/${batch.id}/pages/${page}`, { employee_id: emp.id })
      .then((res) => {
        setBatch(res.data.batch);
        const it = res.data.batch.items.find(i => i.page === page);
        if (it?.status === 'pending') setSel(s => ({ ...s, [page]: true }));
        toast.success(`עמוד ${page} שויך ל${emp.full_name}`);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // The preview route sits behind the bearer token — window.open on it would
  // 401, exactly as the document downloads used to.
  const viewPage = async (page) => {
    try {
      const res = await api.get(`/payroll/direct-payslips/${batch.id}/page/${page}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error('שגיאה בפתיחת העמוד');
    }
  };

  const send = async () => {
    if (selectedPages.length === 0) return toast.error('בחר/י לפחות עמוד אחד');
    const resend = (batch.items || []).filter(i => sel[i.page] && i.status === 'sent');
    const test = testTo.trim();
    const ok = await confirm({
      title: test ? 'שליחת בדיקה' : 'שליחת תלושים',
      message: test
        ? `כל ${selectedPages.length} העמודים יישלחו ל-${test} בלבד. לא יתויק דבר ולא יסומן חודש כשולם.`
        : `לשלוח ${selectedPages.length} תלושים לחודש ${batch.month}?`
          + (resend.length ? ` ${resend.length} מהם כבר נשלחו — שליחה חוזרת תחליף את התלוש המתויק.` : ''),
      danger: !test,
    });
    if (!ok) return;

    setSending(true);
    api.post(`/payroll/direct-payslips/${batch.id}/send`, {
      pages: selectedPages,
      include_hours: includeHours,
      ...(test ? { to: test } : {}),
    }, { timeout: 180000 })
      .then((res) => {
        setBatch(res.data.batch);
        const sent = res.data.results.filter(r => r.status === 'sent').length;
        const failed = res.data.results.length - sent;
        if (failed) toast.warn(`נשלחו ${sent}, נכשלו ${failed}`);
        else toast.success(res.data.test_mode ? `נשלחו ${sent} לבדיקה` : `נשלחו ${sent} תלושים`);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בשליחה'))
      .finally(() => setSending(false));
  };

  const discard = async () => {
    if (!(await confirm({ title: 'מחיקת קובץ', message: 'למחוק את הקובץ שהועלה? התלושים שכבר נשלחו יישארו מתויקים.', danger: true }))) return;
    api.delete(`/payroll/direct-payslips/${batch.id}`)
      .then(() => { setBatch(null); setSel({}); setFile(null); toast.success('נמחק'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>הפצה ישירה — ללא ביקורת</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">
            <AlertTitle sx={{ fontWeight: 700 }}>מתי להשתמש בזה</AlertTitle>
            קובץ סופי שכבר נבדק, או עמוד בודד של עובד/ת שנשכח/ה בקובץ הגדול. כל עמוד מותאם לפי <b>ת״ז</b>,
            ואפשר לבחור בדיוק את מי לשלוח. השליחה מתייקת את התלוש ב״התלושים שלי״ ומסמנת את החודש כשולם —
            בדיוק כמו הפצה מביקורת. אין כאן השוואה מול טבלת שכר.
          </Alert>

          {!batch && (
            <>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                {/* The file goes up as multipart, so keep the raw File — reading
                    a 25MB PDF into base64 first would cost a freeze for nothing. */}
                <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={uploading}>
                  {file ? 'החלף קובץ' : 'בחר/י קובץ תלושים (PDF)'}
                  <input
                    type="file" hidden accept="application/pdf"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      if (f.size > 25 * 1024 * 1024) return toast.error(`הקובץ גדול מדי (${(f.size / 1048576).toFixed(1)}MB). המקסימום 25MB.`);
                      setFile(f);
                    }}
                  />
                </Button>
                {file && <Chip label={`${file.name} (${Math.round(file.size / 1024)} KB)`} size="small" onDelete={() => setFile(null)} />}
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  label="חודש" type="month" size="small" value={month}
                  onChange={e => setMonth(e.target.value)} InputLabelProps={{ shrink: true }}
                  sx={{ width: 200 }} helperText="ריק = ייקרא מהתלוש עצמו"
                />
                <TextField
                  label="סניף (לתיוק בלבד)" size="small" value={branch}
                  onChange={e => setBranch(e.target.value)} sx={{ width: 240 }}
                />
              </Stack>
              <UploadingBar show={uploading} />
            </>
          )}

          {batch && (
            <>
              {otherMonths.length > 0 && (
                <Alert severity="warning">
                  בקובץ יש עמודים מחודשים אחרים ({otherMonths.join(', ')}). כולם יתויקו תחת {batch.month} —
                  בדוק/י לפני שליחה.
                </Alert>
              )}
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 700 }}>{batch.file_name}</Typography>
                <Chip size="small" label={`${batch.page_count} עמודים`} />
                <Chip size="small" color="primary" label={`חודש ${batch.month}`} />
                {batch.sent_count > 0 && <Chip size="small" color="success" label={`${batch.sent_count} נשלחו`} />}
                {batch.last_send_at && (
                  <Typography variant="caption" color="text.secondary">שליחה אחרונה: {fmtDateTime(batch.last_send_at)}</Typography>
                )}
                <Box sx={{ flex: 1 }} />
                <Tooltip title="מחק את הקובץ"><IconButton color="error" onClick={discard}><DeleteOutlineIcon /></IconButton></Tooltip>
              </Stack>

              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={sendable.length > 0 && selectedPages.length === sendable.length}
                        indeterminate={selectedPages.length > 0 && selectedPages.length < sendable.length}
                        onChange={(e) => {
                          const next = {};
                          if (e.target.checked) for (const i of sendable) next[i.page] = true;
                          setSel(next);
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>עמוד</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>על התלוש</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>עובד/ת במערכת</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>מייל</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">סטטוס</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">צפייה</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {batch.items.map((it) => {
                    const st = STATUS[it.status] || STATUS.pending;
                    const selectable = it.status === 'pending' || it.status === 'sent';
                    return (
                      <TableRow key={it.page} hover>
                        <TableCell padding="checkbox">
                          <Checkbox
                            disabled={!selectable}
                            checked={!!sel[it.page]}
                            onChange={e => setSel(s => ({ ...s, [it.page]: e.target.checked }))}
                          />
                        </TableCell>
                        <TableCell>{it.page}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}>
                          {it.name_on_payslip || '—'}
                          <Typography variant="caption" color="text.secondary" display="block">
                            ת״ז {it.israeli_id || '—'}{it.year_month && it.year_month !== batch.month ? ` · ${it.year_month}` : ''}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {it.employee_id ? (
                            <>
                              <Typography sx={{ fontWeight: 600, fontSize: '0.85rem' }}>{it.employee_name}</Typography>
                              {it.match_basis && (
                                <Chip size="small" variant="outlined" label={`לפי ${BASIS[it.match_basis] || it.match_basis}`}
                                  sx={{ height: 17, fontSize: '0.6rem' }} />
                              )}
                            </>
                          ) : (
                            <Autocomplete
                              size="small"
                              options={employees}
                              onChange={(_, v) => assign(it.page, v)}
                              getOptionLabel={o => `${o.full_name}${o.israeli_id ? ` (${o.israeli_id})` : ''}`}
                              sx={{ minWidth: 220 }}
                              renderInput={p => <TextField {...p} placeholder="שייך/י ידנית" size="small" />}
                            />
                          )}
                        </TableCell>
                        <TableCell sx={{ fontSize: '0.75rem', color: it.email ? 'text.secondary' : 'warning.main' }}>
                          {it.email || 'חסר'}
                        </TableCell>
                        <TableCell align="center">
                          <Chip size="small" color={st.color} label={st.label} />
                          {it.error && (
                            <Typography variant="caption" color="error" display="block">{it.error}</Typography>
                          )}
                          {it.sent_at && (
                            <Typography variant="caption" color="text.secondary" display="block">{fmtDateTime(it.sent_at)}</Typography>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          {it.status === 'no_match'
                            ? <Tooltip title="לא שויך"><LinkOffIcon fontSize="small" color="disabled" /></Tooltip>
                            : null}
                          <Tooltip title="צפה בעמוד">
                            <IconButton size="small" color="primary" onClick={() => viewPage(it.page)}>
                              <VisibilityIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <Divider />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <FormControlLabel
                  control={<Switch checked={includeHours} onChange={e => setIncludeHours(e.target.checked)} />}
                  label="צרף גם דוח שעות"
                />
                <TextField
                  size="small" label="שליחת בדיקה לכתובת אחת" value={testTo}
                  onChange={e => setTestTo(e.target.value)} sx={{ minWidth: 260 }}
                  helperText="ריק = שליחה אמיתית לעובדים"
                />
              </Stack>
              <UploadingBar show={sending} />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={uploading || sending}>סגור</Button>
        {!batch ? (
          <BusyButton variant="contained" onClick={upload} loading={uploading} loadingText="קורא קובץ…" disabled={!file}>
            העלה וזהה
          </BusyButton>
        ) : (
          <BusyButton
            variant="contained" color={testTo.trim() ? 'secondary' : 'primary'}
            startIcon={<SendIcon />} onClick={send} loading={sending} loadingText="שולח…"
            disabled={selectedPages.length === 0}
          >
            {testTo.trim() ? `שלח בדיקה (${selectedPages.length})` : `שלח לנבחרים (${selectedPages.length})`}
          </BusyButton>
        )}
      </DialogActions>
    </Dialog>
  );
}
