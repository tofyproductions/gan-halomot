import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  TextField, MenuItem, Typography, Box, Alert, Chip, CircularProgress,
  FormControlLabel, Checkbox,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

const MONTH_NAMES = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * Copy a month's plan from another room.
 *
 * Every branch writes the same month three times — תינוקייה, צעירים, בוגרים —
 * and the three are mostly the same plan pitched differently. Typing it out
 * twice more is the largest piece of work left in the job, and it is the
 * reason a gananet keeps a copy in Excel: there you duplicate a sheet.
 *
 * The picker is a flat list rather than a branch → room → month drill, because
 * the thing she is looking for is "the one I already wrote" and she recognises
 * it by its room and its month, not by where it sits in a hierarchy.
 */
export default function GanttCopyDialog({ open, onClose, target, onCopied }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPick('');
    setOverwrite(false);
    api.get('/gantt/sources')
      .then(res => setSources(res.data.sources || []))
      .catch(() => toast.error('שגיאה בטעינת התוכניות'))
      .finally(() => setLoading(false));
  }, [open]);

  // Never offer the month you are standing in as its own source.
  const options = useMemo(() => sources.filter(s => !(
    String(s.classroom_id) === String(target?.classroomId)
    && s.month === target?.month && s.year === target?.year
  )), [sources, target]);

  // The same room in another month, and the same month in another room, are
  // the two things anybody actually copies. Both float to the top.
  const ranked = useMemo(() => [...options].sort((a, b) => {
    const score = (s) => (
      (String(s.classroom_id) === String(target?.classroomId) ? 2 : 0)
      + (s.month === target?.month && s.year === target?.year ? 1 : 0)
    );
    return score(b) - score(a) || b.year - a.year || b.month - a.month;
  }), [options, target]);

  const chosen = ranked.find(s => String(s.id) === String(pick));

  const run = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const res = await api.post('/gantt/copy', {
        from: { classroom: chosen.classroom_id, month: chosen.month, year: chosen.year },
        to: { classroom: target.classroomId, month: target.month, year: target.year },
        overwrite,
      });
      const { copied, kept, skipped } = res.data;
      const notes = [];
      if (kept) notes.push(`${kept} תאים שכבר היה בהם תוכן לא נדרסו`);
      if (skipped) notes.push(`${skipped} דולגו — הגן סגור באותם ימים`);
      toast.success(`הועתקו ${copied} תאים${notes.length ? `. ${notes.join(', ')}` : ''}`);
      onCopied?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהעתקה');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>העתקת תוכנית מכיתה אחרת</DialogTitle>
      <DialogContent>
        {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

        {!loading && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              מעתיקים אל <b>{target?.classroomName}</b> · {MONTH_NAMES[target?.month]} {target?.year}
            </Typography>

            {ranked.length === 0 && (
              <Alert severity="info">אין עדיין תוכניות אחרות עם תוכן להעתיק מהן.</Alert>
            )}

            {ranked.length > 0 && (
              <TextField select label="להעתיק מ" fullWidth value={pick}
                onChange={e => setPick(e.target.value)}>
                {ranked.map(s => (
                  <MenuItem key={s.id} value={String(s.id)}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                      <span style={{ fontWeight: 700 }}>{s.classroom_name}</span>
                      {s.category && <Chip label={s.category} size="small" />}
                      <span style={{ opacity: 0.7 }}>{MONTH_NAMES[s.month]} {s.year}</span>
                      <span style={{ marginInlineStart: 'auto', opacity: 0.6, fontSize: '0.8rem' }}>
                        {s.branch_name} · {s.filled} תאים
                      </span>
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
            )}

            <FormControlLabel
              control={<Checkbox checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />}
              label="לדרוס גם תאים שכבר כתוב בהם משהו"
            />

            <Typography variant="caption" color="text.secondary">
              ההעתקה היא לפי מיקום ולא לפי תאריך: שבוע 1 לשבוע 1, ראשון לראשון —
              כך שאותו נושא נופל על אותו שבוע גם כשלחודשים יש מספר שבועות שונה.
              ימים שבהם הגן סגור לפי לוח החופשות של סניף היעד מדולגים — לוח
              החופשות של שני הגנים לא בהכרח זהה.
            </Typography>

            {chosen?.status === 'approved' && (
              <Alert severity="warning" sx={{ py: 0.5 }}>
                המקור מאושר. ההעתק נשמר כטיוטה וידרוש אישור בנפרד.
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={run} disabled={!chosen || busy}>
          {busy ? 'מעתיק…' : 'העתק'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
