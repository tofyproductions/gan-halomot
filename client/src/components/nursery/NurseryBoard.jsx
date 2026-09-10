import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Stack, Typography, Card, CardContent, TextField, MenuItem, Alert,
  CircularProgress, Accordion, AccordionSummary, AccordionDetails, Chip,
  Button, Snackbar,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestaurantIcon from '@mui/icons-material/Restaurant';
import SettingsIcon from '@mui/icons-material/Settings';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import ChildDayCard from './ChildDayCard';

/**
 * לוח עדכונים — the gan's day.
 *
 * Two boards behind one screen, chosen by the room. The infant rooms and the
 * צעירים keep the full one: a card per child, every bottle and nap one tap
 * away. The older rooms get a single line for the whole class — "what we did
 * today" — because a teacher of twenty four-year-olds filling in twenty cards
 * is a board that never gets filled in, and until now those rooms had no
 * board and their parents had no day.
 *
 * Replaces a Google Sheet the staff drove through an Apps Script page. The
 * shape of the screen is kept because it earned its shape in the room: the
 * menu at the top, a card per child below, every value one tap away.
 *
 * Two things it does differently.
 *
 * The date is a control, not a consequence. The sheet held only today and
 * wiped it nightly, so yesterday existed as an archived blob; here yesterday
 * is the same screen with a different date, read-only because a day already
 * reported to parents should not quietly change afterwards.
 *
 * And a tap writes one field. The whole board loads in one request — fourteen
 * children of small values would otherwise be forty requests before anybody
 * touches anything — but nothing is batched on the way back, so two teachers
 * working the same room overwrite a value rather than each other's day.
 */
export default function NurseryBoard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const mayEditSettings = ['system_admin', 'branch_manager'].includes(user?.role);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [classroomId, setClassroomId] = useState('');
  const [date, setDate] = useState('');
  // The older rooms' one line. Held as a draft and saved by hand: it is a
  // sentence somebody is in the middle of typing, not a tap on a chip.
  const [activity, setActivity] = useState('');
  const [activitySaving, setActivitySaving] = useState(false);
  const [activitySaved, setActivitySaved] = useState(false);

  const load = useCallback(async (opts = {}) => {
    setError('');
    try {
      const params = {};
      if (opts.classroom ?? classroomId) params.classroom = opts.classroom ?? classroomId;
      if (opts.date ?? date) params.date = opts.date ?? date;
      const res = await api.get('/nursery/board', { params });
      setData(res.data);
      setClassroomId(String(res.data.classroom?.id || ''));
      setDate(res.data.date);
      setActivity(res.data.activity || '');
      setActivitySaved(false);
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו לטעון את הלוח');
    } finally {
      setLoading(false);
    }
  }, [classroomId, date]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const isToday = data && data.date === data.today;

  /**
   * Send one field and fold the server's answer back in.
   *
   * The row the server returns replaces the local one rather than the value
   * being patched in blind: it carries what was actually stored, which is the
   * only version the kitchen and the parents will see.
   */
  const patchChild = async (childId, fields) => {
    try {
      const res = await api.patch(`/nursery/log/${childId}`, { ...fields, date: data.date });
      setData(d => ({
        ...d,
        children: d.children.map(c => (String(c.id) === String(childId) ? { ...c, log: res.data.log } : c)),
      }));
    } catch (err) {
      setToast(err.response?.data?.error || 'השמירה נכשלה');
    }
  };

  const saveActivity = async () => {
    setActivitySaving(true);
    try {
      await api.put('/nursery/classroom-day', {
        classroom_id: data.classroom.id,
        date: data.date,
        activity,
      });
      setActivitySaved(true);
      setData(d => ({ ...d, activity }));
    } catch (err) {
      setToast(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setActivitySaving(false);
    }
  };

  const toggleDish = async (mealKey, category, dish) => {
    const key = `${mealKey}.${category}`;
    const current = data.menu_selections[key] || [];
    const next = current.includes(dish) ? current.filter(d => d !== dish) : [...current, dish];
    const selections = { ...data.menu_selections, [key]: next };

    setData(d => ({ ...d, menu_selections: selections }));
    try {
      await api.put('/nursery/menu', {
        date: data.date,
        branch_id: data.classroom.branch_id,
        selections,
      });
    } catch (err) {
      setToast(err.response?.data?.error || 'שמירת התפריט נכשלה');
      load();
    }
  };

  if (loading) {
    return <Stack alignItems="center" sx={{ py: 8 }}><CircularProgress /></Stack>;
  }
  if (error && !data) return <Alert severity="error">{error}</Alert>;

  if (!data?.classrooms?.length) {
    return <Alert severity="info">לא נמצאו כיתות פעילות.</Alert>;
  }

  // Which board this room keeps. Decided on the server (nursery.boardKind) and
  // read here, so the two never disagree about a room somebody re-categorised.
  const light = data.classroom?.board === 'light';

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>לוח יומי</Typography>
        {mayEditSettings && (
          <Button size="small" startIcon={<SettingsIcon />} onClick={() => navigate('/nursery/settings')}>
            הגדרות
          </Button>
        )}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          select label="כיתה" size="small" value={classroomId} fullWidth
          onChange={(e) => { setClassroomId(e.target.value); load({ classroom: e.target.value }); }}
        >
          {data.classrooms.map(c => (
            <MenuItem key={c.id} value={String(c.id)}>
              {c.branch} — {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          type="date" label="תאריך" size="small" value={date} fullWidth
          InputLabelProps={{ shrink: true }}
          inputProps={{ max: data.today }}
          onChange={(e) => { setDate(e.target.value); load({ date: e.target.value }); }}
        />
      </Stack>

      {!isToday && (
        <Alert severity="info" sx={{ mb: 2 }}
          action={<Button size="small" onClick={() => load({ date: data.today })}>חזרה להיום</Button>}>
          צפייה ביום קודם — לקריאה בלבד.
        </Alert>
      )}

      <Accordion defaultExpanded={false} sx={{ mb: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <RestaurantIcon fontSize="small" color="primary" />
            <Typography fontWeight={700}>תפריט היום</Typography>
          </Stack>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={2}>
            {Object.entries(data.menu).map(([mealKey, meal]) => (
              <Box key={mealKey}>
                <Typography variant="subtitle2" fontWeight={700} color="primary" sx={{ mb: 1 }}>
                  {meal.label}
                </Typography>
                <Stack spacing={1}>
                  {Object.entries(meal.categories || {}).map(([category, dishes]) => (
                    <Box key={category}>
                      <Typography variant="caption" color="text.secondary">{category}</Typography>
                      <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 0.5 }}>
                        {dishes.map(dish => {
                          const chosen = (data.menu_selections[`${mealKey}.${category}`] || []).includes(dish);
                          return (
                            <Chip
                              key={dish} label={dish} size="small"
                              color={chosen ? 'primary' : 'default'}
                              variant={chosen ? 'filled' : 'outlined'}
                              onClick={isToday ? () => toggleDish(mealKey, category, dish) : undefined}
                            />
                          );
                        })}
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        </AccordionDetails>
      </Accordion>

      {/* The older rooms' whole board: one line, for the room. */}
      {light && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.5 }}>
              מה עשינו היום
            </Typography>
            <Typography variant="caption" color="text.secondary">
              נכתב פעם אחת לכל הכיתה, וההורים של כל ילדי הכיתה רואים את זה.
            </Typography>
            <TextField
              fullWidth multiline minRows={3} size="small" sx={{ mt: 1.5 }}
              placeholder="למשל: יצאנו לחצר, הכנו עוגיות ושמענו סיפור על הפיל"
              value={activity}
              disabled={!isToday}
              onChange={(e) => { setActivity(e.target.value); setActivitySaved(false); }}
            />
            {isToday && (
              <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 1.5 }}>
                <Button
                  variant="contained" size="small"
                  disabled={activitySaving || activity === (data.activity || '')}
                  onClick={saveActivity}
                >
                  {activitySaving ? 'שומר…' : 'שמירה'}
                </Button>
                {activitySaved && (
                  <Typography variant="caption" color="success.main" fontWeight={700}>
                    נשמר — ההורים רואים
                  </Typography>
                )}
              </Stack>
            )}
          </CardContent>
        </Card>
      )}

      {!light && data.children.length === 0 && (
        <Alert severity="info">אין ילדים פעילים בכיתה זו.</Alert>
      )}

      <Box sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
      }}>
        {data.children.map(child => (
          <ChildDayCard
            key={child.id}
            child={child}
            options={data.options}
            onPatch={patchChild}
            readOnly={!isToday}
          />
        ))}
      </Box>

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
      />
    </Box>
  );
}
