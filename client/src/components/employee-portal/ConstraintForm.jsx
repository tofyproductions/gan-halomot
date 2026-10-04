import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack,
  ToggleButtonGroup, ToggleButton, Alert, Typography,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { TYPE_LABEL } from '../shifts/constraintLabels';

const EMPTY = { type: 'day_off', date: '', target_date: '', from_hhmm: '10:00', to_hhmm: '12:00', details: '', swap_mode: 'handover', target: 'colleague', colleague_id: '' };

/** One constraint: the type decides which fields appear. Files go up as multipart. */
export default function ConstraintForm({ open, onClose, onSaved }) {
  const [f, setF] = useState(EMPTY);
  const [files, setFiles] = useState([]);
  const [colleagues, setColleagues] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(EMPTY); setFiles([]);
    api.get('/shifts/constraints/colleagues').then(r => setColleagues(r.data.colleagues || [])).catch(() => setColleagues([]));
  }, [open]);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const needsDetails = ['day_off', 'partial', 'sick_expected', 'other'].includes(f.type);
  const needsTarget = f.type === 'move_day' || (f.type === 'swap' && f.swap_mode === 'mutual');

  const submit = async () => {
    const fd = new FormData();
    fd.append('type', f.type); fd.append('date', f.date); fd.append('details', f.details);
    if (f.type === 'partial') { fd.append('from_hhmm', f.from_hhmm); fd.append('to_hhmm', f.to_hhmm); }
    if (needsTarget) fd.append('target_date', f.target_date);
    if (f.type === 'swap') {
      fd.append('swap_mode', f.swap_mode);
      if (f.target === 'all') fd.append('broadcast', 'true'); else fd.append('colleague_id', f.colleague_id);
    }
    files.forEach(file => fd.append('files', file));
    setSaving(true);
    try {
      await api.post('/shifts/constraints', fd);
      toast.success('האילוץ נשלח');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שליחה נכשלה');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>אילוץ חדש</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">אילוצים לשבוע הבא אפשר להגיש עד יום חמישי ב-18:00. לשבועות רחוקים יותר — בכל זמן.</Alert>
          <TextField select label="סוג" value={f.type} onChange={set('type')}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
          </TextField>
          <TextField type="date" label={f.type === 'move_day' ? 'היום שאני לא עובדת בו' : 'תאריך'} value={f.date} onChange={set('date')} InputLabelProps={{ shrink: true }} />
          {f.type === 'partial' && (
            <Stack direction="row" spacing={1}>
              <TextField type="time" label="משעה" value={f.from_hhmm} onChange={set('from_hhmm')} InputLabelProps={{ shrink: true }} fullWidth />
              <TextField type="time" label="עד שעה" value={f.to_hhmm} onChange={set('to_hhmm')} InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
          )}
          {f.type === 'swap' && (
            <>
              <ToggleButtonGroup exclusive size="small" value={f.swap_mode} onChange={(_, v) => v && setF(s => ({ ...s, swap_mode: v }))}>
                <ToggleButton value="handover">מסירת משמרת</ToggleButton>
                <ToggleButton value="mutual">החלפה הדדית</ToggleButton>
              </ToggleButtonGroup>
              <ToggleButtonGroup exclusive size="small" value={f.target} onChange={(_, v) => v && setF(s => ({ ...s, target: v }))}>
                <ToggleButton value="colleague">עובדת מסוימת</ToggleButton>
                <ToggleButton value="all">הצעה לכל הסניף</ToggleButton>
              </ToggleButtonGroup>
              {f.target === 'colleague' ? (
                <TextField select label="עם מי" value={f.colleague_id} onChange={set('colleague_id')}>
                  {colleagues.map(c => <MenuItem key={c._id} value={c._id}>{c.full_name}</MenuItem>)}
                </TextField>
              ) : (
                <Typography variant="caption" color="text.secondary">ההצעה תישלח לכל העובדות בסניף אחרי אישור המנהלת. אף אחת לא תראה מי עוד הסכימה.</Typography>
              )}
            </>
          )}
          {needsTarget && <TextField type="date" label={f.type === 'move_day' ? 'היום שאעבוד בו במקום' : 'היום שאעבוד במקומה'} value={f.target_date} onChange={set('target_date')} InputLabelProps={{ shrink: true }} />}
          <TextField label={needsDetails ? 'סיבה / פירוט' : 'הערה (לא חובה)'} value={f.details} onChange={set('details')} multiline minRows={2} />
          <Button component="label" variant="outlined">
            צירוף מסמכים ({files.length}/3)
            <input hidden type="file" multiple accept=".pdf,.jpg,.jpeg,.png" onChange={e => setFiles([...e.target.files].slice(0, 3))} />
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !f.date || (needsDetails && !f.details.trim())}>שליחה</Button>
      </DialogActions>
    </Dialog>
  );
}
