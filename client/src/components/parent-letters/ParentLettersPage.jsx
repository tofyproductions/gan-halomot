import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Button, Card, CardContent, Stack, TextField, Autocomplete,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, CircularProgress,
  Chip, Table, TableHead, TableRow, TableCell, TableBody, FormControlLabel,
  Checkbox, Grid,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { BusyButton } from '../shared/UploadControls';

/**
 * מסמכים להורים — the confirmations a family asks the office for.
 *
 * Mirrors the employee letters screen: pick the child, the system fills what
 * it knows (identity, branch, amuta, amounts paid), the office adds only the
 * purpose — preview, issue, PDF. The issued letter is frozen: what the parent
 * handed to מס הכנסה must be reproducible verbatim.
 */

const DOC_TYPES = [
  {
    type: 'attendance_confirmation',
    label: 'אישור שהות בגן',
    blurb: 'לכל מאן דבעי — מס הכנסה, מעסיק, ביטוח לאומי. אפשר לכלול את הסכומים ששולמו.',
    icon: <DescriptionIcon />,
    color: 'primary',
  },
  {
    type: 'camp_confirmation',
    label: 'אישור קייטנת אוגוסט',
    blurb: 'אישור השתתפות בקייטנת אוגוסט, עם העלות ששולמה.',
    icon: <BeachAccessIcon />,
    color: 'warning',
  },
];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

export default function ParentLettersPage() {
  const [children, setChildren] = useState([]);
  const [child, setChild] = useState(null);
  const [context, setContext] = useState(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(null); // {type, purpose, include_amounts, monthly_fee, total_paid, camp_paid, extra, previewHtml}
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.get('/parent-letters');
      setHistory(res.data.letters || []);
    } catch { /* the history table is secondary */ }
  }, []);

  useEffect(() => {
    api.get('/children')
      .then(res => setChildren(res.data.children || res.data || []))
      .catch(err => toast.error(apiError(err, 'שגיאה בטעינת הילדים')));
    loadHistory();
  }, [loadHistory]);

  const pickChild = async (c) => {
    setChild(c);
    setContext(null);
    if (!c) return;
    setCtxLoading(true);
    try {
      const res = await api.get(`/parent-letters/context/${c._id || c.id}`);
      setContext(res.data.context);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בטעינת פרטי הילד/ה'));
    } finally {
      setCtxLoading(false);
    }
  };

  const openForm = (type) => {
    setForm({
      type,
      purpose: '',
      include_amounts: type === 'camp_confirmation',
      monthly_fee: context?.monthly_fee || '',
      total_paid: context?.total_paid || '',
      camp_paid: context?.camp_paid || '',
      extra: '',
      previewHtml: '',
    });
  };

  const overridesOf = () => ({
    purpose: form.purpose,
    include_amounts: !!form.include_amounts,
    monthly_fee: form.monthly_fee === '' ? null : Number(form.monthly_fee),
    total_paid: form.total_paid === '' ? null : Number(form.total_paid),
    camp_paid: form.camp_paid === '' ? null : Number(form.camp_paid),
    extra: form.extra,
  });

  const doPreview = async () => {
    setBusy(true);
    try {
      const res = await api.post('/parent-letters/preview', {
        child_id: child._id || child.id,
        letter_type: form.type,
        overrides: overridesOf(),
      });
      setForm(v => ({ ...v, previewHtml: res.data.html }));
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בתצוגה מקדימה'));
    } finally {
      setBusy(false);
    }
  };

  const openPdf = async (id) => {
    try {
      const res = await api.get(`/parent-letters/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בפתיחת המסמך'));
    }
  };

  const doIssue = async () => {
    setBusy(true);
    try {
      const res = await api.post('/parent-letters', {
        child_id: child._id || child.id,
        letter_type: form.type,
        overrides: overridesOf(),
      });
      toast.success('המסמך הופק');
      setForm(null);
      loadHistory();
      openPdf(res.data.id);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בהפקה'));
    } finally {
      setBusy(false);
    }
  };

  const typeLabel = DOC_TYPES.find(t => t.type === form?.type)?.label || '';

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מסמכים להורים</Typography>
        <Typography variant="body2" color="text.secondary">
          אישור שהות בגן ואישור קייטנה — הפרטים והסכומים נשלפים מהמערכת, המסמך נשמר בהיסטוריה.
        </Typography>
      </Box>

      <Autocomplete
        options={children}
        value={child}
        onChange={(_, v) => pickChild(v)}
        getOptionLabel={(c) => `${c.child_name}${c.classroom_name ? ` — ${c.classroom_name}` : ''}`}
        isOptionEqualToValue={(a, b) => (a._id || a.id) === (b._id || b.id)}
        renderInput={(params) => <TextField {...params} label="בחירת ילד/ה" />}
        sx={{ maxWidth: 420, mb: 2 }}
      />

      {ctxLoading && <CircularProgress size={24} sx={{ mb: 2 }} />}

      {context && (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <Chip size="small" label={`הורה: ${context.parent_name || '—'}`} />
            <Chip size="small" label={`סניף: ${context.branch_name || '—'}`} />
            <Chip size="small" label={`שנה"ל: ${context.academic_year || '—'}`} />
            {context.amuta_name && <Chip size="small" label={`עמותה: ${context.amuta_name}`} />}
            {context.total_paid != null && <Chip size="small" color="success" variant="outlined" label={`שולם השנה: ${Number(context.total_paid).toLocaleString('he-IL')} ₪`} />}
            {!context.child_id && <Chip size="small" color="warning" variant="outlined" label="חסרה ת.ז של הילד/ה בכרטיס" />}
          </Stack>

          <Grid container spacing={2} sx={{ mb: 3 }}>
            {DOC_TYPES.map(t => (
              <Grid item xs={12} sm={6} key={t.type}>
                <Card variant="outlined" sx={{ height: '100%' }}>
                  <CardContent>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                      {t.icon}
                      <Typography sx={{ fontWeight: 800 }}>{t.label}</Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t.blurb}</Typography>
                    <Button variant="contained" color={t.color} onClick={() => openForm(t.type)}>הנפקה</Button>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </>
      )}

      <Typography sx={{ fontWeight: 800, mb: 1 }}>מסמכים שהופקו</Typography>
      <Card variant="outlined">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell align="right">תאריך</TableCell>
                <TableCell align="right">מסמך</TableCell>
                <TableCell align="right">ילד/ה</TableCell>
                <TableCell align="right">סניף</TableCell>
                <TableCell align="right">שנה"ל</TableCell>
                <TableCell align="left" />
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map(row => (
                <TableRow key={row.id}>
                  <TableCell align="right">{fmtDate(row.created_at)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{row.type_label}</TableCell>
                  <TableCell align="right">{row.child_name}</TableCell>
                  <TableCell align="right">{row.branch_name}</TableCell>
                  <TableCell align="right">{row.academic_year}</TableCell>
                  <TableCell align="left">
                    <Button size="small" startIcon={<PictureAsPdfIcon />} onClick={() => openPdf(row.id)}>
                      פתיחה
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!history.length && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  עדיין לא הופקו מסמכים
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Card>

      {/* ---- טופס הפקה ---- */}
      <Dialog open={!!form} onClose={() => setForm(null)} maxWidth="md" fullWidth dir="rtl">
        <DialogTitle>{typeLabel} — {context?.child_name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="מטרת האישור (יופיע במסמך, לא חובה)"
              placeholder="למשל: הצגה למס הכנסה / למקום העבודה"
              value={form?.purpose || ''} fullWidth
              onChange={e => setForm(v => ({ ...v, purpose: e.target.value }))}
            />
            <FormControlLabel
              control={<Checkbox checked={!!form?.include_amounts}
                onChange={e => setForm(v => ({ ...v, include_amounts: e.target.checked }))} />}
              label="לכלול סכומים במסמך"
            />
            {form?.include_amounts && (
              <Stack direction="row" spacing={2}>
                {form.type === 'attendance_confirmation' ? (
                  <>
                    <TextField type="number" label="שכר לימוד חודשי (₪)" value={form?.monthly_fee ?? ''}
                      onChange={e => setForm(v => ({ ...v, monthly_fee: e.target.value }))} fullWidth />
                    <TextField type="number" label='סה"כ שולם השנה (₪)' value={form?.total_paid ?? ''}
                      onChange={e => setForm(v => ({ ...v, total_paid: e.target.value }))} fullWidth />
                  </>
                ) : (
                  <TextField type="number" label="עלות הקייטנה ששולמה (₪)" value={form?.camp_paid ?? ''}
                    onChange={e => setForm(v => ({ ...v, camp_paid: e.target.value }))} fullWidth />
                )}
              </Stack>
            )}
            <TextField
              label="תוספת חופשית (לא חובה)" multiline minRows={2}
              value={form?.extra || ''} fullWidth
              onChange={e => setForm(v => ({ ...v, extra: e.target.value }))}
            />
            {form?.previewHtml ? (
              <Box component="iframe" srcDoc={form.previewHtml} title="preview"
                sx={{ width: '100%', height: 480, border: '1px solid #e5e7eb', borderRadius: 1 }} />
            ) : (
              <Alert severity="info" sx={{ py: 0.5 }}>
                לחצו "תצוגה מקדימה" כדי לראות את המסמך לפני ההפקה.
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>ביטול</Button>
          <BusyButton loading={busy} onClick={doPreview}>תצוגה מקדימה</BusyButton>
          <BusyButton variant="contained" loading={busy} onClick={doIssue} disabled={!form?.previewHtml}>
            הפקה ופתיחת PDF
          </BusyButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
