import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, Chip, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions, Divider, IconButton,
  Table, TableHead, TableBody, TableRow, TableCell, Tooltip, LinearProgress,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import GavelIcon from '@mui/icons-material/Gavel';
import EventNoteIcon from '@mui/icons-material/EventNote';
import VerifiedIcon from '@mui/icons-material/Verified';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';

/**
 * הנפקת מסמכים לעובד.
 *
 * The manager never retypes who the employee is — the server fills name, ת"ז,
 * position, branch, start date, seniority and the statutory notice period from
 * the employee card. This screen only asks for what the system genuinely
 * cannot know: the reasons, the meeting time, what was said at the hearing.
 */

const DOC_TYPES = [
  {
    type: 'hearing_invite', label: 'זימון לשימוע', icon: <EventNoteIcon />,
    color: '#b45309', bg: '#fffbeb',
    blurb: 'מכתב שמזמן את העובד/ת לשימוע לפני החלטה על סיום העסקה.',
  },
  {
    type: 'hearing_protocol', label: 'פרוטוקול שימוע', icon: <DescriptionIcon />,
    color: '#4338ca', bg: '#eef2ff',
    blurb: 'תיעוד שיחת השימוע — נימוקי המעסיק, טענות העובד/ת והנוכחים.',
  },
  {
    type: 'termination', label: 'מכתב סיום העסקה', icon: <GavelIcon />,
    color: '#b91c1c', bg: '#fef2f2',
    blurb: 'הודעת פיטורין, כולל תקופת הודעה מוקדמת המחושבת מהוותק.',
  },
  {
    type: 'employment_confirmation', label: 'אישור העסקה', icon: <VerifiedIcon />,
    color: '#047857', bg: '#ecfdf5',
    blurb: 'אישור "לכל מען דבעי" על תקופת ההעסקה והיקף המשרה.',
  },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function EmployeeLetters() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [empId, setEmpId] = useState('');
  const [ctx, setCtx] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(null);      // { type, values }
  const [previewHtml, setPreviewHtml] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/payroll/employees', { params: { active: true } })
      .then(res => setEmployees((res.data.employees || []).filter(e => e.is_active !== false)))
      .catch(() => toast.error('שגיאה בטעינת עובדים'))
      .finally(() => setLoading(false));
  }, []);

  const loadHistory = useCallback((id) => {
    api.get('/employee-letters', { params: id ? { employee_id: id } : {} })
      .then(res => setHistory(res.data.letters || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!empId) { setCtx(null); setHistory([]); return; }
    api.get(`/employee-letters/context/${empId}`)
      .then(res => setCtx(res.data.context))
      .catch(err => { setCtx(null); toast.error(err.response?.data?.error || 'שגיאה'); });
    loadHistory(empId);
  }, [empId, loadHistory]);

  /** Sensible starting values per document, on top of the server's context. */
  const openForm = (type) => {
    const base = {
      letter_date_iso: todayISO(),
      female: ctx?.female !== false,
      reasons: '',
      hearing_date_iso: '',
      hearing_time: '',
      hearing_place: ctx?.hearing_place || 'במשרדי המעון',
      hearing_before: ctx?.branch_name ? `מנהל/ת המעון – ${ctx.issuer_name}` : ctx?.issuer_name || '',
      workplace_word: 'מעון',
      employer_reasons: '',
      employee_claims: '',
      attendees: [{ name: ctx?.issuer_name || '', role: 'מנהל/ת המעון' }, { name: '', role: '' }, { name: '', role: '' }],
      immediate: false,
      end_date_iso: '',
      extra: '',
      scope_text: ctx?.scope_text || 'משרה מלאה',
    };
    // The dismissal letter defaults to ending at the end of the statutory
    // notice period, counted from today — the date the manager most often means.
    if (type === 'termination' && ctx?.notice_days != null) {
      const d = new Date();
      d.setDate(d.getDate() + Number(ctx.notice_days || 0));
      base.end_date_iso = d.toISOString().slice(0, 10);
    }
    setForm({ type, values: base });
    setPreviewHtml('');
  };

  const setVal = (k, v) => setForm(f => ({ ...f, values: { ...f.values, [k]: v } }));
  const setAttendee = (i, k, v) => setForm(f => ({
    ...f,
    values: { ...f.values, attendees: f.values.attendees.map((a, ai) => (ai === i ? { ...a, [k]: v } : a)) },
  }));

  const doPreview = async () => {
    setBusy(true);
    try {
      const res = await api.post('/employee-letters/preview', {
        employee_id: empId, type: form.type, overrides: form.values,
      });
      setPreviewHtml(res.data.html);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהפקת תצוגה מקדימה');
    } finally { setBusy(false); }
  };

  const doIssue = async () => {
    setBusy(true);
    try {
      const res = await api.post('/employee-letters', {
        employee_id: empId, type: form.type, overrides: form.values,
      });
      toast.success('המסמך הונפק');
      setForm(null); setPreviewHtml('');
      loadHistory(empId);
      openPdf(res.data.letter.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהנפקה');
    } finally { setBusy(false); }
  };

  /** The PDF endpoint needs the auth header, so fetch it and open the blob. */
  const openPdf = async (id) => {
    try {
      const res = await api.get(`/employee-letters/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error('שגיאה בפתיחת המסמך');
    }
  };

  const removeLetter = async (id) => {
    try {
      await api.delete(`/employee-letters/${id}`);
      toast.success('נמחק');
      loadHistory(empId);
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  if (loading) return <LoadingSpinner />;

  const t = form ? DOC_TYPES.find(d => d.type === form.type) : null;

  return (
    <Box dir="rtl">
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>הנפקת מסמכים לעובד</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        הפרטים הקבועים — שם, ת״ז, תפקיד, סניף, תאריך תחילת העסקה, ותק וימי הודעה מוקדמת — נשלפים
        אוטומטית מכרטיס העובד. יש למלא רק את מה שהמערכת לא יכולה לדעת.
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, mb: 2.5 }}>
        <TextField
          select fullWidth size="small" label="בחר/י עובד/ת"
          value={empId} onChange={(e) => { setEmpId(e.target.value); setForm(null); setPreviewHtml(''); }}
          sx={{ maxWidth: 420 }}
        >
          {employees.map(e => (
            <MenuItem key={e.id || e._id} value={e.id || e._id}>
              {e.full_name}{e.position ? ` · ${e.position}` : ''}{e.branch_name ? ` · ${e.branch_name}` : ''}
            </MenuItem>
          ))}
        </TextField>

        {ctx && (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
            <Chip size="small" label={`ת״ז ${ctx.israeli_id || '—'}`} color={ctx.israeli_id ? 'default' : 'warning'} />
            <Chip size="small" label={`תפקיד: ${ctx.position || '—'}`} />
            <Chip size="small" label={`סניף: ${ctx.branch_name || '—'}`} />
            <Chip size="small" label={`תחילת העסקה: ${ctx.start_date || '—'}`} color={ctx.start_date ? 'default' : 'warning'} />
            <Chip size="small" label={`ותק: ${ctx.seniority}`} />
            <Tooltip title={`${ctx.notice_basis}${ctx.notice_law ? ` · ${ctx.notice_law}` : ''}`} arrow>
              <Chip size="small" color="primary" label={`הודעה מוקדמת: ${ctx.notice_days} ימים`} />
            </Tooltip>
          </Stack>
        )}
        {ctx && !ctx.start_date && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            אין תאריך תחילת העסקה בכרטיס — ימי ההודעה המוקדמת יחושבו כ-0. מומלץ להשלים לפני הנפקת
            מכתב סיום העסקה.
          </Alert>
        )}
      </Paper>

      {ctx && (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
          {DOC_TYPES.map(d => (
            <Paper
              key={d.type} variant="outlined"
              sx={{
                p: 2, borderRadius: 2, flex: '1 1 240px', minWidth: 240,
                bgcolor: d.bg, borderColor: d.color + '55',
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1} sx={{ color: d.color, mb: 0.5 }}>
                {d.icon}
                <Typography sx={{ fontWeight: 800 }}>{d.label}</Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5, minHeight: 34 }}>
                {d.blurb}
              </Typography>
              <Button
                fullWidth size="small" variant="contained"
                sx={{ bgcolor: d.color, '&:hover': { bgcolor: d.color, filter: 'brightness(0.9)' } }}
                onClick={() => openForm(d.type)}
              >
                הנפק {d.label}
              </Button>
            </Paper>
          ))}
        </Stack>
      )}

      {ctx && (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
          <Typography sx={{ fontWeight: 800, mb: 1 }}>מסמכים שהונפקו</Typography>
          {history.length === 0 ? (
            <Typography variant="body2" color="text.secondary">עדיין לא הונפקו מסמכים לעובד/ת זו.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>מסמך</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>הונפק ב</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>ע״י</TableCell>
                  <TableCell align="left" />
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map(h => (
                  <TableRow key={h.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{h.title}</TableCell>
                    <TableCell>{new Date(h.created_at).toLocaleString('he-IL')}</TableCell>
                    <TableCell>{h.issued_by_name || '—'}</TableCell>
                    <TableCell align="left">
                      <IconButton size="small" onClick={() => openPdf(h.id)} title="פתח PDF">
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => removeLetter(h.id)} title="מחק">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}

      {/* Issue dialog */}
      <Dialog open={!!form} onClose={() => setForm(null)} dir="rtl" maxWidth="lg" fullWidth>
        <DialogTitle sx={{ fontWeight: 800, color: t?.color }}>
          {t?.label} — {ctx?.employee_name}
        </DialogTitle>
        <DialogContent dividers>
          {busy && <LinearProgress sx={{ mb: 1 }} />}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            {/* Fields */}
            <Box sx={{ flex: '0 0 420px', maxWidth: { md: 420 } }}>
              <Stack spacing={1.5}>
                <TextField
                  select size="small" label="פנייה" value={form?.values.female ? 'f' : 'm'}
                  onChange={(e) => setVal('female', e.target.value === 'f')}
                >
                  <MenuItem value="f">לשון נקבה</MenuItem>
                  <MenuItem value="m">לשון זכר</MenuItem>
                </TextField>
                <TextField
                  size="small" type="date" label="תאריך המכתב" InputLabelProps={{ shrink: true }}
                  value={form?.values.letter_date_iso || ''} onChange={(e) => setVal('letter_date_iso', e.target.value)}
                />

                {form?.type === 'hearing_invite' && (
                  <>
                    <TextField
                      size="small" multiline minRows={5} label="הסיבות לשימוע"
                      placeholder={'משמעת:\nהנך משתמשת בטלפון הנייד בתדירות גבוהה אל מול הילדים בניגוד לנהלי הגן.\nאינך מקפידה על סדר יום והתנהלות נכונה.'}
                      value={form.values.reasons} onChange={(e) => setVal('reasons', e.target.value)}
                    />
                    <Stack direction="row" spacing={1}>
                      <TextField
                        size="small" type="date" label="תאריך השימוע" InputLabelProps={{ shrink: true }} fullWidth
                        value={form.values.hearing_date_iso} onChange={(e) => setVal('hearing_date_iso', e.target.value)}
                        helperText="יום בשבוע נגזר מהתאריך אוטומטית"
                      />
                      <TextField
                        size="small" type="time" label="שעה" InputLabelProps={{ shrink: true }} sx={{ width: 130 }}
                        value={form.values.hearing_time} onChange={(e) => setVal('hearing_time', e.target.value)}
                      />
                    </Stack>
                    <TextField size="small" label="מיקום" value={form.values.hearing_place}
                      onChange={(e) => setVal('hearing_place', e.target.value)} />
                    <TextField size="small" label="בפני" value={form.values.hearing_before}
                      onChange={(e) => setVal('hearing_before', e.target.value)} />
                    <TextField
                      select size="small" label="ניסוח מקום העבודה" value={form.values.workplace_word}
                      onChange={(e) => setVal('workplace_word', e.target.value)}
                    >
                      <MenuItem value="מעון">מעון</MenuItem>
                      <MenuItem value="גן">גן</MenuItem>
                      <MenuItem value="חברתנו">חברתנו</MenuItem>
                    </TextField>
                  </>
                )}

                {form?.type === 'termination' && (
                  <>
                    <TextField
                      size="small" multiline minRows={4} label="נימוקי סיום ההעסקה"
                      placeholder="לאחר שנשמעו טענותייך בשימוע שנערך ביום ..., החלטנו על סיום העסקתך."
                      value={form.values.reasons} onChange={(e) => setVal('reasons', e.target.value)}
                    />
                    <TextField
                      select size="small" label="מועד הסיום" value={form.values.immediate ? 'now' : 'notice'}
                      onChange={(e) => setVal('immediate', e.target.value === 'now')}
                    >
                      <MenuItem value="notice">בתום הודעה מוקדמת ({ctx?.notice_days} ימים)</MenuItem>
                      <MenuItem value="now">לאלתר</MenuItem>
                    </TextField>
                    {!form.values.immediate && (
                      <TextField
                        size="small" type="date" label="תאריך סיום העסקה" InputLabelProps={{ shrink: true }}
                        value={form.values.end_date_iso} onChange={(e) => setVal('end_date_iso', e.target.value)}
                        helperText={ctx?.notice_basis}
                      />
                    )}
                    <TextField size="small" multiline minRows={2} label="סעיף נוסף (רשות)"
                      value={form.values.extra} onChange={(e) => setVal('extra', e.target.value)} />
                  </>
                )}

                {form?.type === 'hearing_protocol' && (
                  <>
                    <Stack direction="row" spacing={1}>
                      <TextField
                        size="small" type="date" label="תאריך השימוע" InputLabelProps={{ shrink: true }} fullWidth
                        value={form.values.hearing_date_iso} onChange={(e) => setVal('hearing_date_iso', e.target.value)}
                      />
                      <TextField
                        size="small" type="time" label="שעה" InputLabelProps={{ shrink: true }} sx={{ width: 130 }}
                        value={form.values.hearing_time} onChange={(e) => setVal('hearing_time', e.target.value)}
                      />
                    </Stack>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>נוכחים</Typography>
                    {form.values.attendees.map((a, i) => (
                      <Stack key={i} direction="row" spacing={1}>
                        <TextField size="small" label="שם" value={a.name} fullWidth
                          onChange={(e) => setAttendee(i, 'name', e.target.value)} />
                        <TextField size="small" label="תפקיד" value={a.role} fullWidth
                          onChange={(e) => setAttendee(i, 'role', e.target.value)} />
                      </Stack>
                    ))}
                    <TextField size="small" multiline minRows={4} label="נימוקי המעסיק"
                      value={form.values.employer_reasons} onChange={(e) => setVal('employer_reasons', e.target.value)} />
                    <TextField size="small" multiline minRows={4} label="טענות העובד/ת"
                      value={form.values.employee_claims} onChange={(e) => setVal('employee_claims', e.target.value)}
                      helperText="אפשר להשאיר ריק ולמלא בכתב יד בישיבה" />
                  </>
                )}

                {form?.type === 'employment_confirmation' && (
                  <>
                    <TextField
                      size="small" type="date" label="תאריך סיום (ריק = עדיין מועסק/ת)"
                      InputLabelProps={{ shrink: true }}
                      value={form.values.end_date_iso} onChange={(e) => setVal('end_date_iso', e.target.value)}
                    />
                    <TextField size="small" label="היקף משרה" value={form.values.scope_text}
                      onChange={(e) => setVal('scope_text', e.target.value)} />
                    <TextField size="small" multiline minRows={2} label="תוספת (רשות)"
                      value={form.values.extra} onChange={(e) => setVal('extra', e.target.value)} />
                  </>
                )}

                <Divider />
                <Button variant="outlined" onClick={doPreview} disabled={busy}>רענן תצוגה מקדימה</Button>
              </Stack>
            </Box>

            {/* Live preview of the real letter */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {previewHtml ? (
                <Box
                  component="iframe" title="preview" srcDoc={previewHtml}
                  sx={{ width: '100%', height: 560, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#fff' }}
                />
              ) : (
                <Box sx={{
                  height: 560, border: '1px dashed #cbd5e1', borderRadius: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary',
                }}>
                  לחצו "רענן תצוגה מקדימה" כדי לראות את המכתב
                </Box>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>ביטול</Button>
          <Button variant="contained" onClick={doIssue} disabled={busy}
            sx={{ bgcolor: t?.color, '&:hover': { bgcolor: t?.color, filter: 'brightness(0.9)' } }}
          >
            הנפק ושמור
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
