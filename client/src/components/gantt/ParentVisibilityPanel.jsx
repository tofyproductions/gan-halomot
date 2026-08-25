import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Card, CardContent, Typography, Switch, FormControlLabel, Alert,
  LinearProgress, Box, Chip,
} from '@mui/material';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/**
 * מה ההורים רואים — a switch per week.
 *
 * Week by week rather than once and for all, because a week still being
 * written is not a week anybody wants read. The gan asked for exactly this.
 *
 * The two switches start in different places and the screen says so: the plan
 * has never been shown to parents, and the kitchen's day already is. A row
 * that nobody has touched is labelled "ברירת מחדל", so "we never decided" can
 * be told apart from "we decided to leave it".
 */

const DAY_MONTH = (ymd) => {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};

export default function ParentVisibilityPanel() {
  const { selectedBranch, selectedBranchName } = useBranch();
  const [weeks, setWeeks] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    if (!selectedBranch || selectedBranch === 'all') { setWeeks(null); return; }
    setError('');
    api.get('/gantt/visibility', { params: { branch: selectedBranch, weeks: 8 } })
      .then((res) => setWeeks(res.data.weeks || []))
      .catch((err) => setError(apiError(err, 'שגיאה בטעינה')));
  }, [selectedBranch]);

  useEffect(load, [load]);

  const flip = async (week, field, value) => {
    setBusy(`${week.week}-${field}`);
    try {
      const res = await api.put('/gantt/visibility', {
        branch_id: selectedBranch, week: week.week, [field]: value,
      });
      setWeeks((ws) => ws.map((w) => (w.week === week.week ? { ...w, ...res.data } : w)));
      toast.success('עודכן');
    } catch (err) { toast.error(apiError(err, 'שגיאה')); }
    finally { setBusy(''); }
  };

  if (!selectedBranch || selectedBranch === 'all') {
    return <Alert severity="info">בחרו סניף כדי לנהל מה ההורים רואים.</Alert>;
  }
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!weeks) return <LinearProgress />;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>
          מה ההורים רואים — {selectedBranchName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          החלטה נפרדת לכל שבוע
        </Typography>
      </Box>

      <Alert severity="info">
        <b>התוכנית השבועית</b> מוסתרת כברירת מחדל — היא תופיע להורים רק אחרי שתפרסמו,
        ורק כשהחודש מאושר. <b>תפריט האוכל</b> מוצג כברירת מחדל, כפי שהוא מוצג היום.
      </Alert>

      {weeks.map((w, i) => (
        <Card key={w.week} variant="outlined" sx={{ borderRadius: 3 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
              <Typography sx={{ fontWeight: 800 }}>
                {DAY_MONTH(w.dates[0])} – {DAY_MONTH(w.dates[5])}
              </Typography>
              {i === 0 && <Chip size="small" color="primary" label="השבוע" sx={{ fontWeight: 800 }} />}
              {w.is_default && (
                <Chip size="small" variant="outlined" label="ברירת מחדל" />
              )}
              {w.set_by_name && (
                <Typography variant="caption" color="text.secondary">{w.set_by_name}</Typography>
              )}
            </Stack>

            <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
              <FormControlLabel
                control={(
                  <Switch
                    checked={w.gantt}
                    disabled={busy === `${w.week}-gantt`}
                    onChange={(e) => flip(w, 'gantt', e.target.checked)}
                  />
                )}
                label="תוכנית שבועית"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={w.menu}
                    disabled={busy === `${w.week}-menu`}
                    onChange={(e) => flip(w, 'menu', e.target.checked)}
                  />
                )}
                label="תפריט אוכל"
              />
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}
