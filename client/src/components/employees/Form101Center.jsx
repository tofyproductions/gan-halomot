import { useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Stack, Tabs, Tab, Card, CardContent, Table, TableHead, TableBody,
  TableRow, TableCell, TableContainer, Chip, IconButton, Tooltip, TextField, MenuItem,
  Alert, AlertTitle, Divider, Switch, FormControlLabel, CircularProgress, Button,
  Dialog, DialogTitle, DialogContent, DialogActions, Autocomplete,
} from '@mui/material';
import AssignmentIndIcon from '@mui/icons-material/AssignmentInd';
import VisibilityIcon from '@mui/icons-material/Visibility';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import MarkEmailReadIcon from '@mui/icons-material/MarkEmailRead';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton, FilePickButton, UploadingBar } from '../shared/UploadControls';

function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const fmtDate = (d) => { try { return d ? new Date(d).toLocaleDateString('he-IL') : '—'; } catch { return '—'; } };
const fmtDateTime = (d) => { try { return d ? new Date(d).toLocaleString('he-IL') : '—'; } catch { return '—'; } };

const BASIS_HE = {
  israeli_id: 'ת״ז',
  sender_email: 'כתובת השולח',
  name: 'שם בלבד',
  manual: 'ידני',
};

/* ------------------------------------------------------------------ roster */

function Roster({ year, setYear, currentYear }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [search, setSearch] = useState('');
  const [uploadFor, setUploadFor] = useState(null); // employee row
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/form-101/overview', { params: { year } })
      .then(res => setRows(res.data.employees || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [year]);

  const filtered = useMemo(() => {
    let list = rows;
    if (onlyMissing) list = list.filter(r => !r.has_form);
    const q = search.trim();
    if (q) list = list.filter(r => r.full_name.includes(q) || (r.israeli_id || '').includes(q));
    return list;
  }, [rows, onlyMissing, search]);

  const missing = rows.filter(r => !r.has_form).length;

  const view = async (row) => {
    try {
      const res = await api.get(`/employee-documents/${row.document_id}/file`);
      const { data, name, mimetype } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimetype || 'application/pdf'));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const upload = () => {
    if (!file?.data) return toast.error('בחר/י קובץ');
    setSaving(true);
    api.post(`/form-101/employees/${uploadFor.employee_id}`, {
      file_data: file.data,
      file_name: file.name,
      file_mimetype: file.mimetype,
      tax_year: year,
    })
      .then(() => { toast.success('הטופס נקלט'); setUploadFor(null); setFile(null); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const years = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2];

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField select size="small" label="שנת מס" value={year} onChange={e => setYear(Number(e.target.value))} sx={{ minWidth: 120 }}>
          {years.map(y => <MenuItem key={y} value={y}>{y}</MenuItem>)}
        </TextField>
        <TextField size="small" label="חיפוש (שם / ת״ז)" value={search} onChange={e => setSearch(e.target.value)} />
        <FormControlLabel
          control={<Switch checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} />}
          label="רק חסרים"
        />
        <Box sx={{ flex: 1 }} />
        <Chip
          color={missing ? 'warning' : 'success'}
          icon={missing ? <ErrorOutlineIcon /> : <CheckCircleIcon />}
          label={missing ? `${missing} מתוך ${rows.length} ללא טופס ל-${year}` : `כל ${rows.length} העובדים הגישו`}
          sx={{ fontWeight: 700 }}
        />
        <Tooltip title="רענן"><IconButton onClick={load}><RefreshIcon /></IconButton></Tooltip>
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
      ) : (
        <TableContainer component={Card} sx={{ borderRadius: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>ת״ז</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">סטטוס {year}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>הוגש</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">פעולות</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(r => (
                <TableRow key={r.employee_id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{r.full_name}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{r.branch_name || '—'}</TableCell>
                  <TableCell sx={{ color: r.israeli_id ? 'text.primary' : 'error.main' }}>
                    {r.israeli_id || 'חסרה'}
                  </TableCell>
                  <TableCell align="center">
                    {r.has_form
                      ? <Chip size="small" color="success" label="הוגש" />
                      : (
                        <Stack spacing={0.3} alignItems="center">
                          <Chip size="small" color="warning" label="חסר" />
                          {r.last_year_on_file && (
                            <Typography variant="caption" color="text.secondary">
                              אחרון: {r.last_year_on_file}
                            </Typography>
                          )}
                        </Stack>
                      )}
                  </TableCell>
                  <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                    {r.has_form ? (
                      <>
                        {fmtDate(r.filed_at)}
                        {r.filed_source === 'mail' && (
                          <Chip size="small" variant="outlined" label={`ממייל · ${BASIS_HE[r.match_basis] || ''}`}
                            sx={{ ml: 0.5, height: 18, fontSize: '0.6rem' }} />
                        )}
                        {r.self_uploaded && (
                          <Chip size="small" variant="outlined" color="primary" label="ע״י העובד/ת"
                            sx={{ ml: 0.5, height: 18, fontSize: '0.6rem' }} />
                        )}
                      </>
                    ) : '—'}
                  </TableCell>
                  <TableCell align="center">
                    {r.has_form && (
                      <Tooltip title="צפייה"><IconButton size="small" color="primary" onClick={() => view(r)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
                    )}
                    <Tooltip title={r.has_form ? 'העלאת טופס נוסף' : 'העלאת טופס'}>
                      <IconButton size="small" onClick={() => { setUploadFor(r); setFile(null); }}>
                        <UploadFileIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                  אין רשומות להצגה
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={!!uploadFor} onClose={() => setUploadFor(null)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          טופס 101 — {uploadFor?.full_name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              שנת מס {year}. אם הטופס נושא שנה אחרת, היא תילקח מהטופס עצמו.
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <FilePickButton hasFile={!!file} onPick={setFile} onError={m => toast.error(m)}
                disabled={saving} accept="application/pdf,image/*" maxSizeMB={8} />
              {file && <Chip label={file.name} size="small" onDelete={() => setFile(null)} />}
            </Stack>
            <UploadingBar show={saving} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadFor(null)} disabled={saving}>ביטול</Button>
          <BusyButton variant="contained" onClick={upload} loading={saving} loadingText="מעלה…" disabled={!file}>
            שמור
          </BusyButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/* ------------------------------------------------------------------- inbox */

/**
 * Forms that arrived by mail and could not be tied to one employee.
 *
 * Everything the scan read is on screen next to the file, so assigning is a
 * confirmation rather than a guess — and the file is still here, which is the
 * whole reason the queue exists instead of a log line.
 */
function Inbox({ onCountChange }) {
  const confirm = useConfirm();
  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assignFor, setAssignFor] = useState(null);
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/form-101/inbox', { params: { status: 'pending' } })
      .then((res) => {
        setItems(res.data.items || []);
        onCountChange?.(res.data.pending_count || 0);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    api.get('/payroll/employees', { params: { active: 'true', branch: 'all' } })
      .then(res => setEmployees(res.data.employees || []))
      .catch(() => setEmployees([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = async (item) => {
    try {
      const res = await api.get(`/form-101/inbox/${item.id}/file`);
      const { data, mimetype } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimetype || 'application/pdf'));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const assign = () => {
    if (!target) return toast.error('בחר/י עובד/ת');
    setSaving(true);
    api.post(`/form-101/inbox/${assignFor.id}/assign`, {
      employee_id: target.id || target._id,
      tax_year: assignFor.scan?.tax_year || undefined,
    })
      .then((res) => { toast.success(`שויך לשנת מס ${res.data.tax_year}`); setAssignFor(null); setTarget(null); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const discard = async (item) => {
    if (!(await confirm({
      title: 'הסרת פריט',
      message: 'להסיר את הפריט מהתור? הקובץ לא יישמר.',
      danger: true,
    }))) return;
    api.post(`/form-101/inbox/${item.id}/discard`)
      .then(() => { toast.success('הוסר'); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  if (loading) return <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>;

  if (items.length === 0) {
    return (
      <Alert severity="success">
        אין טפסים הממתינים לשיוך. טופס שהגיע במייל וזוהה בוודאות משויך אוטומטית ואינו מגיע לכאן.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <Alert severity="info">
        {items.length} טפסים הגיעו במייל ולא ניתן היה לשייך אותם לעובד/ת יחיד/ה. בדוק/י את הפרטים שנקראו מהטופס ושייך/י ידנית.
      </Alert>
      {items.map(item => (
        <Card key={item.id} sx={{ borderRadius: 3 }}>
          <CardContent>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between">
              <Stack spacing={0.5} sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 700 }}>
                  {item.scan?.employee_name || 'ללא שם קריא'}
                  {item.scan?.tax_year && <Chip size="small" sx={{ ml: 1 }} label={`שנת מס ${item.scan.tax_year}`} />}
                  {item.scan?.confidence && <Chip size="small" variant="outlined" sx={{ ml: 0.5 }} label={`ודאות: ${item.scan.confidence}`} />}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  ת״ז שנקראה: {item.scan?.israeli_id || '—'} · מעסיק: {item.scan?.employer_name || '—'} · {item.scan?.signed ? 'חתום' : 'ללא חתימה'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  מ־{item.mail?.from || 'לא ידוע'} · {fmtDateTime(item.mail?.date)} · {item.file_name}
                </Typography>
                {item.reason && (
                  <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
                    {item.reason}
                  </Typography>
                )}
                {item.scan?.notes && (
                  <Typography variant="caption" color="text.secondary">{item.scan.notes}</Typography>
                )}
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center">
                <Tooltip title="צפייה בטופס"><IconButton color="primary" onClick={() => view(item)}><VisibilityIcon /></IconButton></Tooltip>
                <Button variant="contained" size="small" startIcon={<MarkEmailReadIcon />}
                  onClick={() => {
                    setAssignFor(item);
                    const first = item.candidates?.[0];
                    setTarget(first ? employees.find(e => String(e.id) === String(first.employee_id)) || null : null);
                  }}>
                  שייך
                </Button>
                <Tooltip title="הסר"><IconButton color="error" onClick={() => discard(item)}><DeleteOutlineIcon /></IconButton></Tooltip>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ))}

      <Dialog open={!!assignFor} onClose={() => setAssignFor(null)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>שיוך טופס 101</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              על הטופס: {assignFor?.scan?.employee_name || '—'} · ת״ז {assignFor?.scan?.israeli_id || '—'} · שנת מס {assignFor?.scan?.tax_year || '—'}
            </Typography>
            {assignFor?.candidates?.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                מועמדים שזוהו: {assignFor.candidates.map(c => c.full_name).join(', ')}
              </Typography>
            )}
            <Autocomplete
              options={employees}
              value={target}
              onChange={(_, v) => setTarget(v)}
              getOptionLabel={o => `${o.full_name}${o.israeli_id ? ` (${o.israeli_id})` : ''}`}
              isOptionEqualToValue={(o, v) => String(o.id) === String(v?.id)}
              renderInput={params => <TextField {...params} label="עובד/ת" size="small" />}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignFor(null)} disabled={saving}>ביטול</Button>
          <BusyButton variant="contained" onClick={assign} loading={saving} loadingText="משייך…" disabled={!target}>
            שייך
          </BusyButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/* ---------------------------------------------------------------- settings */

function ScanSettings() {
  const [cfg, setCfg] = useState(null);
  const [meta, setMeta] = useState({});
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  const load = () => {
    api.get('/form-101/config')
      .then((res) => {
        setCfg(res.data.config);
        setMeta({
          mailbox_configured: res.data.mailbox_configured,
          mailbox_user: res.data.mailbox_user,
          ai_configured: res.data.ai_configured,
        });
      })
      .catch(() => setCfg(null));
  };

  useEffect(load, []);

  const save = (patch) => {
    setSaving(true);
    api.put('/form-101/config', patch)
      .then(() => { toast.success('נשמר'); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setSaving(false));
  };

  const scanNow = () => {
    setScanning(true);
    api.post('/form-101/scan')
      .then((res) => {
        const r = res.data.run || {};
        toast.success(r.message || 'הסריקה הסתיימה');
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setScanning(false));
  };

  if (!cfg) return <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>;

  return (
    <Stack spacing={2}>
      {!meta.mailbox_configured && (
        <Alert severity="error">
          <AlertTitle sx={{ fontWeight: 700 }}>תיבת הדואר לא מוגדרת</AlertTitle>
          הסריקה נכנסת לתיבת דואר וקוראת ממנה את הטפסים שהגיעו. חסרים בשרת (Render)
          שני משתנים:
          <Box component="ul" sx={{ my: 0.5, pr: 3 }}>
            <li><code>CIBUS_MAIL_USER</code> — <b>כתובת המייל של התיבה</b> שאליה מגיעים הטפסים</li>
            <li><code>CIBUS_MAIL_PASS</code> — <b>סיסמת אפליקציה</b> של אותה תיבה (ב-Gmail: App Password, לא סיסמת החשבון)</li>
          </Box>
          <b>אלו לא שם המשתמש והסיסמה שלך בסיבוס.</b> השם CIBUS נשאר מהשימוש הראשון
          שנעשה בתיבה הזו — ייבוא דוח סיבוס — ואותה תיבה משמשת גם לסריקת טופסי 101.
        </Alert>
      )}
      {!meta.ai_configured && (
        <Alert severity="warning">
          חסר ANTHROPIC_API_KEY — בלעדיו לא ניתן לקרוא את הטפסים, וכל קובץ יגיע לתור השיוך ללא פרטים.
        </Alert>
      )}

      <Card sx={{ borderRadius: 3 }}>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap" useFlexGap>
              <FormControlLabel
                control={<Switch checked={cfg.enabled} onChange={e => save({ enabled: e.target.checked })} disabled={saving} />}
                label={<Typography sx={{ fontWeight: 700 }}>סריקה אוטומטית</Typography>}
              />
              <Typography variant="body2" color="text.secondary">
                {meta.mailbox_user ? `תיבה: ${meta.mailbox_user}` : ''}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <BusyButton variant="outlined" onClick={scanNow} loading={scanning} loadingText="סורק…" startIcon={<RefreshIcon />}>
                סרוק עכשיו
              </BusyButton>
            </Stack>

            <Divider />

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                size="small" label="מילים בנושא (מופרד בפסיק)" fullWidth
                defaultValue={(cfg.subject_contains || []).join(', ')}
                onBlur={e => save({ subject_contains: e.target.value.split(',') })}
                helperText="ריק = כל נושא"
              />
              <TextField
                size="small" label="שולחים (מופרד בפסיק)" fullWidth
                defaultValue={(cfg.from_contains || []).join(', ')}
                onBlur={e => save({ from_contains: e.target.value.split(',') })}
                helperText="ריק = כל שולח — טפסים מגיעים מהעובדים עצמם"
              />
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                size="small" type="number" label="לאחור (ימים)" sx={{ maxWidth: 160 }}
                defaultValue={cfg.lookback_days}
                onBlur={e => save({ lookback_days: Number(e.target.value) })}
              />
              <TextField
                size="small" type="number" label="מקסימום הודעות" sx={{ maxWidth: 160 }}
                defaultValue={cfg.max_messages}
                onBlur={e => save({ max_messages: Number(e.target.value) })}
              />
              <FormControlLabel
                control={<Switch checked={cfg.allow_name_match} onChange={e => save({ allow_name_match: e.target.checked })} />}
                label="שיוך אוטומטי לפי שם"
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              כיבוי שיוך לפי שם ידרוש זיהוי ודאי (ת״ז או כתובת מייל מוכרת); כל השאר יגיע לתור השיוך.
              קבצים מזוהים לפי תוכן, כך שסריקה חוזרת של אותו חלון זמן לא תיצור כפילויות.
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ borderRadius: 3 }}>
        <CardContent>
          <Typography sx={{ fontWeight: 700, mb: 1 }}>הרצות אחרונות</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            הרצה אחרונה: {fmtDateTime(cfg.last_run_at)} · הצלחה אחרונה: {fmtDateTime(cfg.last_success_at)}
            {cfg.last_error && <Box component="span" sx={{ color: 'error.main' }}> · {cfg.last_error}</Box>}
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מתי</TableCell>
                  <TableCell>מקור</TableCell>
                  <TableCell align="center">נסרקו ב-AI</TableCell>
                  <TableCell align="center">מהזיכרון</TableCell>
                  <TableCell align="center">שויכו</TableCell>
                  <TableCell align="center">לשיוך</TableCell>
                  <TableCell>הודעה</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(cfg.runs || []).map(r => (
                  <TableRow key={r._id}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</TableCell>
                    <TableCell>{r.trigger === 'manual' ? 'ידני' : 'מתוזמן'}</TableCell>
                    {/* The only column that costs money. */}
                    <TableCell align="center">{r.files_scanned}</TableCell>
                    {/* Files answered from what a previous run already learned
                        about them, instead of being sent to Claude again. */}
                    <TableCell align="center" sx={{ color: 'success.main', fontWeight: 700 }}>
                      {r.cached_count || 0}
                    </TableCell>
                    <TableCell align="center">{r.attached_count}</TableCell>
                    <TableCell align="center">{r.unmatched_count}</TableCell>
                    <TableCell sx={{ color: r.status === 'error' ? 'error.main' : 'text.secondary' }}>{r.message}</TableCell>
                  </TableRow>
                ))}
                {(cfg.runs || []).length === 0 && (
                  <TableRow><TableCell colSpan={7} align="center" sx={{ color: 'text.secondary', py: 2 }}>
                    טרם רצה סריקה
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Stack>
  );
}

/* -------------------------------------------------------------------- page */

/**
 * טופס 101 in one place: who is missing one for the tax year, what the mail
 * scan pulled in that nobody could place, and the scan's own switches.
 */
export default function Form101Center() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'system_admin' || user?.role === 'accountant';
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [tab, setTab] = useState(0);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api.get('/form-101/inbox', { params: { status: 'pending' } })
      .then(res => setPending(res.data.pending_count || 0))
      .catch(() => setPending(0));
  }, []);

  return (
    <Box dir="rtl" sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <AssignmentIndIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>טופסי 101</Typography>
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="מצב הגשה" />
        <Tab label={pending ? `לשיוך (${pending})` : 'לשיוך'} />
        {isAdmin && <Tab label="סריקת מייל" />}
      </Tabs>

      {tab === 0 && <Roster year={year} setYear={setYear} currentYear={currentYear} />}
      {tab === 1 && <Inbox onCountChange={setPending} />}
      {tab === 2 && isAdmin && <ScanSettings />}
    </Box>
  );
}
