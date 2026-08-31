import { useState, useEffect } from 'react';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  MenuItem, Stack, Typography, Chip, Alert, Divider, LinearProgress, Paper,
  Table, TableHead, TableBody, TableRow, TableCell, IconButton, Tooltip,
  Checkbox, FormControlLabel,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SendIcon from '@mui/icons-material/Send';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import BlockIcon from '@mui/icons-material/Block';
import PaidIcon from '@mui/icons-material/Paid';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { toast } from 'react-toastify';
import api, { apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import EmploymentTermsPanel from './EmploymentTermsPanel';

/**
 * הסכם העסקה for one employee — generate, send for mobile signature, confirm.
 *
 * The two escape hatches are first-class here, not hidden: the ~80 people
 * already employed have no contract in the system, and the manager needs a
 * one-click way to say "this one is handled elsewhere" or to attach the paper
 * copy, or the screen would show a wall of red for staff who are perfectly fine.
 */

export const CONTRACT_STATUS = {
  draft:    { label: 'טיוטה',            color: 'default' },
  sent:     { label: 'נשלח לחתימה',      color: 'info' },
  signed:   { label: 'נחתם — ממתין להנה״ח', color: 'warning' },
  approved: { label: 'מאושר',            color: 'success' },
  waived:   { label: 'ללא חוזה (בוויתור)', color: 'default' },
  uploaded: { label: 'הועלה — ממתין להנה״ח', color: 'warning' },
};

const isApproverRole = (r) => r === 'system_admin' || r === 'accountant';

const WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

/**
 * Israeli mobile → the international form wa.me needs (0501234567 →
 * 972501234567). Returns '' for anything that cannot be a mobile number, so the
 * caller falls back to the unaddressed link rather than opening a chat with a
 * number somebody mistyped into the card.
 */
function waNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) return digits.length === 12 ? digits : '';
  if (digits.startsWith('0')) return digits.length === 10 ? `972${digits.slice(1)}` : '';
  return '';
}

/**
 * The contracted week: a working day, or a day off, per weekday.
 *
 * This replaced two pairs of fields — "א׳–ה׳ משעה/עד" and "שישי משעה/עד" —
 * which could describe exactly one shape of week. A weekly day off (Wednesday)
 * and a short day mid-week are both ordinary here and neither could be written
 * there; the manager's only options were to leave the contract wrong or to not
 * issue one.
 *
 * The rows are the employee's commitment (שכר ← התחייבויות), not a copy of it,
 * so what is typed here is also what attendance, sick days and paid vacation
 * are counted against. Saturday is absent on purpose: the contract states the
 * day of rest separately, and it is not negotiable per employee here.
 */
function WeeklyHoursEditor({ rows, onChange }) {
  const byDay = new Map((rows || []).map(r => [Number(r.weekday), r]));
  const grid = WEEKDAY_NAMES.map((name, weekday) => {
    const r = byDay.get(weekday);
    return {
      weekday,
      name,
      // A weekday with no row at all is treated as a day off: the grid always
      // shows all six, so every day the manager can see is a day she answered.
      off: r ? !!r.off : true,
      in: r?.in || '',
      out: r?.out || '',
    };
  });

  const update = (weekday, patch) => {
    onChange(grid.map(r => (r.weekday === weekday
      ? { ...r, ...patch, note: '' }
      : { weekday: r.weekday, off: r.off, in: r.in, out: r.out, note: '' })));
  };

  return (
    <Stack spacing={0.5}>
      {grid.map(r => (
        <Stack key={r.weekday} direction="row" spacing={1} alignItems="center">
          <FormControlLabel
            sx={{ minWidth: 92, mr: 0 }}
            control={(
              <Checkbox
                size="small"
                checked={!r.off}
                onChange={(e) => update(r.weekday, { off: !e.target.checked })}
              />
            )}
            label={<Typography variant="body2">{r.name}</Typography>}
          />
          {r.off ? (
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              יום חופש שבועי
            </Typography>
          ) : (
            <>
              <TextField
                size="small" label="משעה" type="time" fullWidth
                InputLabelProps={{ shrink: true }}
                value={r.in}
                onChange={(e) => update(r.weekday, { in: e.target.value })}
              />
              <TextField
                size="small" label="עד שעה" type="time" fullWidth
                InputLabelProps={{ shrink: true }}
                value={r.out}
                onChange={(e) => update(r.weekday, { out: e.target.value })}
              />
            </>
          )}
        </Stack>
      ))}
      <Typography variant="caption" color="text.secondary">
        יום שאינו מסומן הוא יום חופש שבועי. השעות נשמרות גם במסך שכר ← התחייבויות,
        ולפיהן נספרים ימי מחלה, היעדרות וחופשה.
      </Typography>
    </Stack>
  );
}

export default function EmploymentContractDialog({ open, employee, role, onClose, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState(null);
  const [presets, setPresets] = useState([]);
  const [history, setHistory] = useState([]);
  const [values, setValues] = useState({});
  const [previewHtml, setPreviewHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [signUrl, setSignUrl] = useState('');
  const [waiveReason, setWaiveReason] = useState('');
  const [mode, setMode] = useState('new'); // new | waive | upload | terms
  // Filing the paper is only half of what a new contract does — the pay it
  // agreed to has to reach payroll too, or the signed page and the salary drift
  // apart with nothing pointing it out. Off by default: most uploads are the
  // backlog of contracts for people already being paid correctly.
  const [alsoTerms, setAlsoTerms] = useState(false);
  const [termsContractId, setTermsContractId] = useState(null);

  const empId = employee?.id || employee?._id;

  const load = () => {
    if (!empId) return;
    setLoading(true);
    Promise.all([
      api.get(`/employment-contracts/context/${empId}`),
      api.get('/employment-contracts', { params: { employee_id: empId } }),
    ])
      .then(([c, h]) => {
        setCtx(c.data.context);
        setPresets(c.data.job_presets || []);
        setValues(v => ({ ...c.data.context, ...v }));
        setHistory(h.data.contracts || []);
      })
      .catch(err => toast.error(apiError(err, 'שגיאה בטעינה')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) { setValues({}); setPreviewHtml(''); setSignUrl(''); setMode('new'); setWaiveReason(''); setAlsoTerms(false); setTermsContractId(null); load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, empId]);

  const set = (k, v) => setValues(s => ({ ...s, [k]: v }));

  const current = history[0] || null;
  const active = current && ['sent', 'signed', 'approved'].includes(current.status) ? current : null;

  // wa.me with no number opens WhatsApp on the contact list, so sending the
  // signing link meant searching for the employee by name — for someone whose
  // telephone number is already on the card that produced the contract. Address
  // it. The bare form stays for the employee who has no number on file: it is
  // still the fastest way to send, it just cannot be aimed.
  const waPhone = waNumber(values.phone);
  const waText = encodeURIComponent(`הסכם ההעסקה שלך לחתימה: ${signUrl}`);
  const waLink = waPhone ? `https://wa.me/${waPhone}?text=${waText}` : `https://wa.me/?text=${waText}`;

  const doPreview = async () => {
    setBusy(true);
    try {
      const res = await api.post('/employment-contracts/preview', { employee_id: empId, overrides: values });
      setPreviewHtml(res.data.html);
    } catch (err) { toast.error(apiError(err)); }
    finally { setBusy(false); }
  };

  const doCreate = async (send) => {
    setBusy(true);
    try {
      const res = await api.post('/employment-contracts', {
        employee_id: empId, overrides: values, send, replace: !!active,
      });
      toast.success(send ? 'ההסכם נשלח לחתימה' : 'טיוטה נשמרה');
      if (res.data.sign_url) setSignUrl(res.data.sign_url);
      load(); onChanged && onChanged();
    } catch (err) {
      toast.error(apiError(err));
    } finally { setBusy(false); }
  };

  const resend = async (id) => {
    setBusy(true);
    try {
      const res = await api.post(`/employment-contracts/${id}/send`);
      setSignUrl(res.data.sign_url);
      toast.success(res.data.emailed ? 'נשלח במייל וקישור נוצר' : 'קישור נוצר — אין מייל תקין, שלחו בוואטסאפ');
      load(); onChanged && onChanged();
    } catch (err) { toast.error(apiError(err)); }
    finally { setBusy(false); }
  };

  const approve = async (id) => {
    setBusy(true);
    try {
      await api.post(`/employment-contracts/${id}/approve`);
      toast.success('החוזה אושר');
      load(); onChanged && onChanged();
    } catch (err) { toast.error(apiError(err)); }
    finally { setBusy(false); }
  };

  const doWaive = async () => {
    setBusy(true);
    try {
      await api.post('/employment-contracts/waive', { employee_id: empId, reason: waiveReason });
      toast.success('סומן כללא חוזה');
      setMode('new'); load(); onChanged && onChanged();
    } catch (err) { toast.error(apiError(err)); }
    finally { setBusy(false); }
  };

  /**
   * Send the scan as a file, not as base64 inside JSON.
   *
   * The old shape read the file into a data URL and posted the string: a third
   * more bytes over the wire, and every one of them buffered on the server
   * before anything could look at it. The size ceiling now lives on the server,
   * where it depends on whether object storage is configured — so this no
   * longer guesses a number, it lets the server answer and shows what it said.
   */
  const doUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('employee_id', empId);
      // An upload is megabytes over a home connection. The client default is
      // 30s, meant for JSON; cut off there the browser reports no response at
      // all, which surfaced as a bare "שגיאה בהעלאה" while the request was in
      // fact still running.
      const res = await api.post('/employment-contracts/upload', form, {
        timeout: UPLOAD_TIMEOUT_MS,
      });
      toast.success('החוזה הועלה וממתין לאישור הנהלת החשבונות');
      load(); onChanged && onChanged();
      // The terms step follows the upload rather than riding along inside it:
      // the file is filed either way, and a mistake in the pay fields can then
      // be fixed without re-uploading the contract.
      if (alsoTerms && isApproverRole(role)) {
        setTermsContractId(res.data?.contract?.id || null);
        setMode('terms');
      } else {
        setMode('new');
      }
    } catch (err) { toast.error(apiError(err, 'שגיאה בהעלאה')); }
    finally { setBusy(false); }
  };

  const openFile = async (id) => {
    try {
      const res = await api.get(`/employment-contracts/${id}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('שגיאה בפתיחת המסמך'); }
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(signUrl);
    toast.success('הקישור הועתק');
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        הסכם העסקה — {employee?.full_name}
        {current && (
          <Chip size="small" sx={{ mr: 1 }}
            color={CONTRACT_STATUS[current.status]?.color}
            label={CONTRACT_STATUS[current.status]?.label || current.status} />
        )}
      </DialogTitle>
      <DialogContent dividers>
        {(loading || busy) && <LinearProgress sx={{ mb: 1 }} />}

        {signUrl && (
          <Alert severity="success" sx={{ mb: 2 }}
            action={
              <Stack direction="row" spacing={0.5}>
                <Button size="small" startIcon={<ContentCopyIcon />} onClick={copyLink}>העתק</Button>
                <Button size="small" href={waLink} target="_blank">
                  וואטסאפ
                </Button>
              </Stack>
            }
          >
            {waPhone
              ? `קישור חתימה נוצר. הוואטסאפ ייפתח ישירות בשיחה עם ${values.employee_name || 'העובד/ת'}.`
              : 'קישור חתימה נוצר. אין מספר טלפון בכרטיס העובד/ת, לכן תצטרכו לבחור אותו/ה בוואטסאפ.'}
          </Alert>
        )}

        {/* History */}
        {history.length > 0 && (
          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, mb: 2 }}>
            <Typography sx={{ fontWeight: 800, mb: 1 }}>חוזים קיימים</Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סוג</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>נוצר</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>נחתם</TableCell>
                  <TableCell align="left" />
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map(h => (
                  <TableRow key={h.id} hover>
                    <TableCell>
                      <Chip size="small" color={CONTRACT_STATUS[h.status]?.color}
                        label={CONTRACT_STATUS[h.status]?.label || h.status} />
                      {h.status === 'waived' && h.waived_reason && (
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                          {h.waived_reason} · {h.waived_by_name}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{h.variant === 'global' ? 'גלובלי' : 'שעתי'}</TableCell>
                    <TableCell>{new Date(h.created_at).toLocaleDateString('he-IL')}</TableCell>
                    <TableCell>{h.signed_at ? new Date(h.signed_at).toLocaleDateString('he-IL') : '—'}</TableCell>
                    <TableCell align="left">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {(h.status !== 'waived') && (
                          <Tooltip title="פתח מסמך"><IconButton size="small" onClick={() => openFile(h.id)}>
                            <OpenInNewIcon fontSize="small" /></IconButton></Tooltip>
                        )}
                        {['draft', 'sent'].includes(h.status) && (
                          <Tooltip title="שלח / חדש קישור"><IconButton size="small" color="primary" onClick={() => resend(h.id)}>
                            <SendIcon fontSize="small" /></IconButton></Tooltip>
                        )}
                        {['signed', 'uploaded'].includes(h.status) && isApproverRole(role) && (
                          <Tooltip title="אשר סופית"><IconButton size="small" color="success" onClick={() => approve(h.id)}>
                            <CheckCircleIcon fontSize="small" /></IconButton></Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {history.some(h => ['signed', 'uploaded'].includes(h.status)) && !isApproverRole(role) && (
              <Alert severity="info" sx={{ mt: 1 }}>
                החוזה נחתם וממתין לאישור הנהלת החשבונות.
              </Alert>
            )}
          </Paper>
        )}

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <Button variant={mode === 'new' ? 'contained' : 'outlined'} size="small" onClick={() => setMode('new')}>
            הסכם חדש
          </Button>
          <Button variant={mode === 'upload' ? 'contained' : 'outlined'} size="small"
            startIcon={<UploadFileIcon />} onClick={() => setMode('upload')}>
            העלה חוזה עבודה
          </Button>
          {isApproverRole(role) && (
            <Button variant={mode === 'terms' ? 'contained' : 'outlined'} size="small" color="secondary"
              startIcon={<PaidIcon />} onClick={() => { setTermsContractId(current?.id || null); setMode('terms'); }}>
              תנאי העסקה
            </Button>
          )}
          <Button variant={mode === 'waive' ? 'contained' : 'outlined'} size="small" color="inherit"
            startIcon={<BlockIcon />} onClick={() => setMode('waive')}>
            התעלם מחוזה עבודה
          </Button>
        </Stack>

        {mode === 'waive' && (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Alert severity="info" sx={{ mb: 1.5 }}>
              מסמן את העובד/ת כתקין/ה ללא חוזה במערכת — לעובדים ותיקים שהחוזה שלהם קיים מחוץ למערכת.
              לא נמחק דבר, וניתן להנפיק חוזה בהמשך.
            </Alert>
            <TextField fullWidth size="small" label="סיבה" value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="לדוגמה: חוזה חתום קיים בתיק הפיזי מ-2023" />
            <Button sx={{ mt: 1.5 }} variant="contained" disabled={busy || !waiveReason.trim()} onClick={doWaive}>
              סמן כללא חוזה
            </Button>
          </Paper>
        )}

        {mode === 'upload' && (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Alert severity="info" sx={{ mb: 1.5 }}>
              העלאת חוזה שנחתם על נייר. גם הוא יעבור לאישור הנהלת החשבונות.
            </Alert>
            {isApproverRole(role) && (
              <FormControlLabel
                sx={{ display: 'block', mb: 1 }}
                control={<Checkbox checked={alsoTerms} onChange={(e) => setAlsoTerms(e.target.checked)} />}
                label="החוזה משנה את תנאי ההעסקה — לעדכן גם את השכר במערכת"
              />
            )}
            <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
              בחר קובץ
              <input hidden type="file" accept="application/pdf,image/*"
                onChange={(e) => doUpload(e.target.files?.[0])} />
            </Button>
          </Paper>
        )}

        {mode === 'terms' && isApproverRole(role) && (
          <EmploymentTermsPanel
            employeeId={empId}
            contractId={termsContractId}
            onSaved={() => onChanged && onChanged()}
          />
        )}

        {mode === 'new' && ctx && (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Box sx={{ flex: '0 0 400px', maxWidth: { md: 400 } }}>
              <Stack spacing={1.5}>
                <TextField select size="small" label="סוג הסכם" value={values.variant || ctx.variant}
                  onChange={(e) => set('variant', e.target.value)}>
                  <MenuItem value="hourly">שעתי</MenuItem>
                  <MenuItem value="global">גלובלי (בהתחייבות לשעות חודשיות)</MenuItem>
                </TextField>

                {(values.variant || ctx.variant) === 'global' ? (
                  <Stack direction="row" spacing={1}>
                    <TextField size="small" label="שכר חודשי ברוטו" type="number" fullWidth
                      value={values.monthly_salary ?? ''} onChange={(e) => set('monthly_salary', e.target.value)} />
                    <TextField size="small" label="שעות חודשיות" type="number" fullWidth
                      value={values.required_hours ?? ''} onChange={(e) => set('required_hours', e.target.value)} />
                  </Stack>
                ) : (
                  <TextField size="small" label="שכר שעתי ברוטו" type="number"
                    value={values.hourly_rate ?? ''} onChange={(e) => set('hourly_rate', e.target.value)} />
                )}

                <TextField size="small" label="ממונה ישירה" value={values.supervisor ?? ''}
                  onChange={(e) => set('supervisor', e.target.value)} />

                <Divider textAlign="right"><Typography variant="caption">ימים ושעות</Typography></Divider>
                <WeeklyHoursEditor
                  rows={values.weekly_hours}
                  onChange={(rows) => set('weekly_hours', rows)}
                />

                <Divider textAlign="right"><Typography variant="caption">שנת לימודים</Typography></Divider>
                <Stack direction="row" spacing={1}>
                  <TextField size="small" label="תחילה" value={values.school_year_start ?? ''} fullWidth
                    onChange={(e) => set('school_year_start', e.target.value)} />
                  <TextField size="small" label="סיום" value={values.school_year_end ?? ''} fullWidth
                    onChange={(e) => set('school_year_end', e.target.value)} />
                </Stack>
                <TextField size="small" label="סיום קייטנת אוגוסט" value={values.camp_end ?? ''}
                  onChange={(e) => set('camp_end', e.target.value)} />

                <Divider textAlign="right"><Typography variant="caption">נספח א׳ — הגדרת התפקיד</Typography></Divider>
                <TextField
                  select size="small" label="בחר/י הגדרת תפקיד"
                  value={presets.some(p => p.text === values.job_definition) ? values.job_definition : '__other__'}
                  onChange={(e) => { if (e.target.value !== '__other__') set('job_definition', e.target.value); }}
                  helperText="בחירה מרשימת התפקידים, או 'אחר' לניסוח חופשי"
                >
                  {presets.map(p => <MenuItem key={p.position} value={p.text}>{p.position}</MenuItem>)}
                  <MenuItem value="__other__">אחר — ניסוח חופשי</MenuItem>
                </TextField>
                <TextField
                  size="small" multiline minRows={6} label="מטלות התפקיד (שורה לכל סעיף)"
                  value={values.job_definition ?? ''} onChange={(e) => set('job_definition', e.target.value)}
                />

                <TextField size="small" label="דת (לתשלום ימי חג)" value={values.religion ?? ''}
                  onChange={(e) => set('religion', e.target.value)} placeholder="יהודית / נוצרית / מוסלמית / דרוזית" />
                <TextField size="small" label="קרן פנסיה" value={values.pension_text ?? ''}
                  onChange={(e) => set('pension_text', e.target.value)} />
                <TextField size="small" label="פרטי בנק" value={values.bank_text ?? ''}
                  onChange={(e) => set('bank_text', e.target.value)} />

                <Divider />
                <Button variant="outlined" onClick={doPreview} disabled={busy}>רענן תצוגה מקדימה</Button>
              </Stack>
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              {previewHtml ? (
                <Box component="iframe" title="preview" srcDoc={previewHtml}
                  sx={{ width: '100%', height: 620, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#fff' }} />
              ) : (
                <Box sx={{
                  height: 620, border: '1px dashed #cbd5e1', borderRadius: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary',
                }}>
                  לחצו "רענן תצוגה מקדימה" כדי לראות את ההסכם
                </Box>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        {mode === 'new' && (
          <>
            <Button onClick={() => doCreate(false)} disabled={busy}>שמור טיוטה</Button>
            <Button variant="contained" startIcon={<SendIcon />} onClick={() => doCreate(true)} disabled={busy}>
              {active ? 'החלף ושלח לחתימה' : 'שלח לחתימה'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
