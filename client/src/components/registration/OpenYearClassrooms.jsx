import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Box,
  Typography, TextField, MenuItem, Alert, Chip, Divider, LinearProgress,
  ToggleButton, ToggleButtonGroup, FormControlLabel, Checkbox, Card, CardContent,
} from '@mui/material';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';

/**
 * פתיחת שנה — the year's classrooms, across branches, in one press.
 *
 * A child absorbed with no classroom is absorbed into nothing: no rooms
 * screen, no attendance, no collections, no supplies list. So the rooms have
 * to exist before an intake can happen, and doing that one dialog at a time
 * across four branches and three age groups is twenty presses.
 *
 * PREVIEW BEFORE WRITE, always. This creates dozens of rows across a whole
 * network, and "are you sure?" is not an answer to "sure about what?". The
 * preview lists the exact names per branch, and — just as important — what it
 * has decided NOT to do and why. A run that reports only "created 6" cannot be
 * checked by the person who pressed the button.
 */

const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים'];

export default function OpenYearClassrooms({ open, onClose, onDone, academicYear, previousYear }) {
  const [branches, setBranches] = useState([]);
  const [picked, setPicked] = useState([]);
  const [mode, setMode] = useState('copy');
  const [plan, setPlan] = useState(CATEGORIES.map((category) => ({ category, count: 0, capacity: '' })));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    api.get('/branches')
      .then((res) => {
        const list = res.data.branches || res.data || [];
        setBranches(list);
        setPicked(list.map((b) => String(b._id || b.id)));
      })
      .catch(() => toast.error('שגיאה בטעינת סניפים'));
  }, [open]);

  const body = useCallback(() => ({
    branch_ids: picked,
    academic_year: academicYear,
    mode,
    from_year: previousYear,
    plan: plan.filter((r) => Number(r.count) > 0)
      .map((r) => ({ category: r.category, count: Number(r.count), capacity: Number(r.capacity) || null })),
  }), [picked, academicYear, mode, previousYear, plan]);

  const doPreview = async () => {
    setBusy(true);
    try {
      const res = await api.post('/classrooms/bulk/preview', body());
      setPreview(res.data);
    } catch (err) { toast.error(apiError(err, 'שגיאה')); }
    finally { setBusy(false); }
  };

  const doCreate = async () => {
    setBusy(true);
    try {
      const res = await api.post('/classrooms/bulk', body());
      toast.success(`נוצרו ${res.data.total_created} כיתות`, { autoClose: 6000 });
      onDone && onDone();
      onClose();
    } catch (err) { toast.error(apiError(err, 'שגיאה ביצירה')); }
    finally { setBusy(false); }
  };

  const willCreate = (preview?.branches || []).reduce((n, b) => n + b.create.length, 0);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        פתיחת שנה — כיתות
        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
          {academicYear}
        </Typography>
      </DialogTitle>

      <DialogContent dividers>
        {busy && <LinearProgress sx={{ mb: 1 }} />}

        <Alert severity="info" sx={{ mb: 2 }}>
          בלי כיתות אי אפשר לשבץ ילדים, והם לא יופיעו בנוכחות, בגבייה וברשימת החוסרים.
          כיתה שכבר קיימת לא תיווצר פעמיים.
        </Alert>

        <Typography sx={{ fontWeight: 800, mb: 1 }}>סניפים</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
          {branches.map((b) => {
            const id = String(b._id || b.id);
            const on = picked.includes(id);
            return (
              <Chip
                key={id} label={b.name}
                onClick={() => setPicked((s) => (on ? s.filter((x) => x !== id) : [...s, id]))}
                color={on ? 'primary' : 'default'}
                variant={on ? 'filled' : 'outlined'}
                sx={{ fontWeight: 700 }}
              />
            );
          })}
        </Box>

        <Divider sx={{ my: 2 }} />

        <ToggleButtonGroup
          exclusive size="small" value={mode}
          onChange={(_, v) => { if (v) { setMode(v); setPreview(null); } }}
          sx={{ mb: 2 }}
        >
          <ToggleButton value="copy">העתקה משנה קודמת</ToggleButton>
          <ToggleButton value="create">יצירה מאפס</ToggleButton>
        </ToggleButtonGroup>

        {mode === 'copy' ? (
          <Alert severity="success" icon={false}>
            הכיתות של <b>{previousYear}</b> ייווצרו מחדש ב-<b>{academicYear}</b>, עם אותם שמות ותקנים.
            שמות פגומים (מהבאג הישן) לא יועתקו.
          </Alert>
        ) : (
          <Stack spacing={1.5}>
            {plan.map((row, i) => (
              <Stack key={row.category} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ minWidth: 90, fontWeight: 700 }}>{row.category}</Typography>
                <TextField
                  size="small" type="number" label="כמה יהיו" sx={{ width: 120 }}
                  value={row.count}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPlan((p) => p.map((r, j) => (j === i ? { ...r, count: v } : r)));
                    setPreview(null);
                  }}
                />
                <TextField
                  size="small" type="number" label="תקן (אופציונלי)" sx={{ width: 150 }}
                  value={row.capacity}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPlan((p) => p.map((r, j) => (j === i ? { ...r, capacity: v } : r)));
                    setPreview(null);
                  }}
                />
              </Stack>
            ))}
            <Typography variant="caption" color="text.secondary">
              המספר הוא <b>כמה כיתות יהיו בסך הכל</b>, לא כמה להוסיף — אם כבר יש אחת
              וביקשתם שתיים, תיווצר אחת. השמות ייקבעו אוטומטית: תינוקייה א, תינוקייה ב, וכן הלאה.
            </Typography>
          </Stack>
        )}

        {/* What will actually happen, named, before anything is written. */}
        {preview && (
          <Box sx={{ mt: 3 }}>
            <Typography sx={{ fontWeight: 800, mb: 1 }}>
              {willCreate > 0 ? `ייווצרו ${willCreate} כיתות` : 'לא ייווצרו כיתות'}
            </Typography>
            <Stack spacing={1}>
              {preview.branches.map((b) => (
                <Card key={b.branch_id} variant="outlined" sx={{ borderRadius: 2 }}>
                  <CardContent sx={{ py: 1.25, '&:last-child': { pb: 1.25 } }}>
                    <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                      <Typography sx={{ fontWeight: 800 }}>{b.branch_name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        כבר קיימות: {b.existing_count}
                      </Typography>
                    </Stack>

                    {b.create.length > 0 ? (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
                        {b.create.map((c) => (
                          <Chip key={c.name} size="small" color="success" label={c.name} sx={{ fontWeight: 700 }} />
                        ))}
                      </Box>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        אין מה ליצור בסניף זה
                      </Typography>
                    )}

                    {/* Refusals are shown, not swallowed. */}
                    {(b.skipped || []).length > 0 && (
                      <Box sx={{ mt: 0.75 }}>
                        {b.skipped.map((sk, i) => (
                          <Typography key={i} variant="caption" sx={{ display: 'block', color: 'warning.main' }}>
                            {sk.name || sk.category} — {sk.reason}
                          </Typography>
                        ))}
                      </Box>
                    )}
                  </CardContent>
                </Card>
              ))}
            </Stack>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        <Button variant="outlined" onClick={doPreview} disabled={busy || !picked.length}>
          בדוק מה ייווצר
        </Button>
        <Button
          variant="contained" onClick={doCreate}
          disabled={busy || !preview || willCreate === 0}
        >
          צור {willCreate > 0 ? `${willCreate} כיתות` : ''}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
