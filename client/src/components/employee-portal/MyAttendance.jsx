import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, Button,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Alert,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Employee self-service attendance view + "report a missing punch" form.
 * The reported punch goes to the branch manager as a pending approval; only
 * after they approve does it count toward the employee's salary.
 */

function ReportMissingPunchDialog({ open, prefill, onClose, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ date: today, in_time: '', out_time: '', note: '' });
  // Opened from a specific incomplete day: start on that date with the time the
  // clock already recorded filled in, so only the missing half is left to type.
  useEffect(() => {
    if (!open) return;
    setForm({
      date: prefill?.date || today,
      in_time: prefill?.in_time || '',
      out_time: prefill?.out_time || '',
      note: '',
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open, prefill]);

  const save = () => {
    if (!form.date) return toast.error('יש לבחור תאריך');
    if (!form.in_time && !form.out_time) return toast.error('יש למלא שעת כניסה או יציאה לפחות');
    onSubmit(form);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>דיווח החתמה שנשכחה</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          הדיווח יישלח למנהל הסניף לאישור. לאחר אישור הוא ייכנס לתלוש החודשי.
        </Alert>
        <Stack spacing={2}>
          <TextField label="תאריך" type="date" value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            InputLabelProps={{ shrink: true }} fullWidth />
          <Stack direction="row" spacing={2}>
            <TextField label="שעת כניסה" type="time" value={form.in_time}
              onChange={e => setForm(f => ({ ...f, in_time: e.target.value }))}
              InputLabelProps={{ shrink: true }} fullWidth />
            <TextField label="שעת יציאה" type="time" value={form.out_time}
              onChange={e => setForm(f => ({ ...f, out_time: e.target.value }))}
              InputLabelProps={{ shrink: true }} fullWidth />
          </Stack>
          <TextField label="הערה למנהל" value={form.note}
            onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            multiline minRows={2} placeholder="מה קרה? למה שכחת לדווח?" fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save}>שלח לאישור</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function MyAttendance() {
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [month] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/payroll/my-punches?month=${month}`)
      .then(res => setPunches(res.data.punches || []))
      .catch(() => setPunches([]))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const submitReport = (form) => {
    api.post('/payroll/punch-requests', form)
      .then(() => { toast.success('הדיווח נשלח למנהל'); setReportOpen(false); setPrefill(null); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const completeDay = (p) => {
    setPrefill({ date: p.iso_date, in_time: p.in_time || '', out_time: p.out_time || '' });
    setReportOpen(true);
  };

  const incomplete = punches.filter(p => p.incomplete);

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <AccessTimeIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800, flex: 1 }}>מעקב ההחתמות שלי</Typography>
        <Button variant="contained" startIcon={<EditNoteIcon />} onClick={() => { setPrefill(null); setReportOpen(true); }}>
          דווח החתמה שנשכחה
        </Button>
      </Stack>

      <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
        חודש נוכחי: {month}
      </Typography>

      {incomplete.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
            יש {incomplete.length} ימים שבהם חסרה החתמה
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mb: 1 }}>
            השלימי את השעה החסרה — הדיווח יעבור לאישור מנהל/ת הסניף ומשם להנהלת החשבונות.
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {incomplete.map(p => (
              <Button key={p.date} size="small" variant="outlined" color="warning"
                onClick={() => completeDay(p)}>
                {p.date} · {p.in_time || p.out_time} → השלם
              </Button>
            ))}
          </Stack>
        </Alert>
      )}

      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : punches.length > 0 ? (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>כניסה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>יציאה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>שעות</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {punches.map((p, i) => (
                <TableRow key={i} hover>
                  <TableCell>{p.date}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{p.in_time || '-'}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{p.out_time || '-'}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{p.hours || '-'}</TableCell>
                  <TableCell>{p.branch && <Chip label={p.branch} size="small" variant="outlined" />}</TableCell>
                  <TableCell>
                    {p.pending_approval ? (
                      <Chip
                        label={p.approval_stage === 'accountant' ? 'ממתין לאישור הנה״ח' : 'ממתין לאישור מנהל'}
                        size="small"
                        color={p.approval_stage === 'accountant' ? 'info' : 'warning'}
                      />
                    ) : p.incomplete ? (
                      <Chip label="חסרה החתמה" size="small" color="warning" onClick={() => completeDay(p)} />
                    ) : (
                      <Chip label="שלם" size="small" color="success" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">
          אין החתמות לחודש הנוכחי. אם אתה חושב שזו טעות, לחץ על "דווח החתמה שנשכחה" למעלה.
        </Typography>
      )}

      <ReportMissingPunchDialog
        open={reportOpen}
        prefill={prefill}
        onClose={() => { setReportOpen(false); setPrefill(null); }}
        onSubmit={submitReport}
      />
    </Box>
  );
}
