import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Stack, Typography, Card, CardContent, TextField, MenuItem, Alert,
  CircularProgress, Accordion, AccordionSummary, AccordionDetails, Chip,
  Button, Snackbar, Dialog, DialogTitle, DialogContent, DialogActions, List, ListItemButton,
  ListItemText, IconButton, Tooltip,
} from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestaurantIcon from '@mui/icons-material/Restaurant';
import SettingsIcon from '@mui/icons-material/Settings';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import ChildDayCard from './ChildDayCard';
import { useBoardColorMode } from '../../theme/boardColorMode';

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
function Board({ colorMode }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const mayEditSettings = ['system_admin', 'branch_manager'].includes(user?.role);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [classroomId, setClassroomId] = useState('');
  // Which gan first, THEN which room in it.
  //
  // One flat list of every room in the network was thirty-odd lines reading
  // "כפר סבא - משה דיין — פעוטות 25", and a manager who works in one
  // building scrolled past four other buildings to reach her own. The branch
  // is the first question anybody actually asks.
  const [branch, setBranch] = useState('');
  const [date, setDate] = useState('');
  // The older rooms' one line. Held as a draft and saved by hand: it is a
  // sentence somebody is in the middle of typing, not a tap on a chip.
  const [activity, setActivity] = useState('');
  const [activitySaving, setActivitySaving] = useState(false);
  const [activitySaved, setActivitySaved] = useState(false);

  /**
   * The board keeps itself current.
   *
   * It used to load once, when the screen opened, and the classroom tablet
   * opens it at 07:00 and leaves it there all day. Everything a parent sent
   * after that — the wake-up time, the bottle at home, "she's not coming",
   * and every row the Google Sheet sync brings in every two minutes — sat in
   * the database and never reached the room until somebody happened to
   * change the date and back.
   *
   * So a quiet reload runs on a timer and whenever the screen comes back into
   * view. Quiet means it swaps the data underneath and touches nothing the
   * person in the room is holding: not the room or the date they picked, not
   * the activity line they are halfway through typing. And it is thrown away
   * if any save started or finished while it was in flight — its answer may
   * have been read before that save landed, and folding it in would put the
   * old value back on screen until the next tick, which reads as "the tap
   * didn't take".
   */
  const writeSeq = useRef(0);
  const view = useRef({ classroomId: '', date: '' });
  view.current = { classroomId, date };
  // What the server last said the activity line was. The draft is somebody's
  // unsaved sentence whenever it differs, and a refresh leaves it alone.
  const serverActivity = useRef('');
  const activityRef = useRef('');
  activityRef.current = activity;

  const load = useCallback(async (opts = {}) => {
    if (!opts.quiet) setError('');
    const seq = writeSeq.current;
    const cur = opts.quiet ? view.current : { classroomId, date };
    try {
      const params = {};
      if (opts.classroom ?? cur.classroomId) params.classroom = opts.classroom ?? cur.classroomId;
      if (opts.date ?? cur.date) params.date = opts.date ?? cur.date;
      const res = await api.get('/nursery/board', { params });
      if (opts.quiet) {
        if (seq !== writeSeq.current) return;
        // The room or the date changed while this was in flight.
        if (String(res.data.classroom?.id || '') !== String(view.current.classroomId)
          || res.data.date !== view.current.date) return;
        setData(res.data);
        const next = res.data.activity || '';
        if (activityRef.current === serverActivity.current) setActivity(next);
        serverActivity.current = next;
        return;
      }
      serverActivity.current = res.data.activity || '';
      setData(res.data);
      setClassroomId(String(res.data.classroom?.id || ''));
      // Read back rather than set on click: the first load picks the room for
      // us, and the branch box has to show where that room actually is.
      setBranch(res.data.classroom?.branch || '');
      setDate(res.data.date);
      setActivity(res.data.activity || '');
      setActivitySaved(false);
    } catch (err) {
      // A background refresh that fails says nothing: what is on screen is
      // still the last good board, and the next tick tries again.
      if (!opts.quiet) setError(err.response?.data?.error || 'לא הצלחנו לטעון את הלוח');
    } finally {
      if (!opts.quiet) setLoading(false);
    }
  }, [classroomId, date]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !view.current.classroomId) return;
      loadRef.current({ quiet: true });
    };
    const timer = setInterval(refresh, 30 * 1000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const isToday = data && data.date === data.today;

  /**
   * Send one field and fold the server's answer back in.
   *
   * The row the server returns replaces the local one rather than the value
   * being patched in blind: it carries what was actually stored, which is the
   * only version the kitchen and the parents will see.
   */
  const patchChild = async (childId, fields) => {
    writeSeq.current += 1;
    try {
      const res = await api.patch(`/nursery/log/${childId}`, { ...fields, date: data.date });
      setData(d => ({
        ...d,
        children: d.children.map(c => (String(c.id) === String(childId) ? { ...c, log: res.data.log } : c)),
      }));
    } catch (err) {
      setToast(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      writeSeq.current += 1;
    }
  };

  /* --- a פעוט carried on this board ---------------------------------- */
  const [addOpen, setAddOpen] = useState(false);
  const [candidates, setCandidates] = useState(null); // null = loading

  const openAdd = async () => {
    setAddOpen(true);
    setCandidates(null);
    try {
      const res = await api.get('/nursery/board/candidates', { params: { classroom: classroomId } });
      setCandidates(res.data.candidates || []);
    } catch (err) {
      setToast(err.response?.data?.error || 'טעינת הילדים נכשלה');
      setCandidates([]);
    }
  };

  const extendChild = async (childId, months) => {
    try {
      const res = await api.post('/nursery/board/extend', { classroom: classroomId, child_id: childId, months });
      setToast(`נשאר/ת בלוח עד ${res.data.until}`);
      setAddOpen(false);
      load({ classroom: classroomId });
    } catch (err) {
      setToast(err.response?.data?.error || 'הפעולה נכשלה');
    }
  };

  const releaseChild = async (childId) => {
    try {
      await api.post('/nursery/board/release', { classroom: classroomId, child_id: childId });
      setToast('הוסר/ה מהלוח');
      load({ classroom: classroomId });
    } catch (err) {
      setToast(err.response?.data?.error || 'הפעולה נכשלה');
    }
  };

  const requestMove = async (childId, keepOnBoard) => {
    try {
      const res = await api.post('/nursery/board/move-request', {
        classroom: classroomId, child_id: childId, keep_on_board: keepOnBoard,
      });
      setToast(`הבקשה נשלחה למנהלת הסניף (ל${res.data.to})`);
      load({ classroom: classroomId });
    } catch (err) {
      setToast(err.response?.data?.error || 'שליחת הבקשה נכשלה');
    }
  };

  const saveActivity = async () => {
    setActivitySaving(true);
    writeSeq.current += 1;
    try {
      await api.put('/nursery/classroom-day', {
        classroom_id: data.classroom.id,
        date: data.date,
        activity,
      });
      setActivitySaved(true);
      serverActivity.current = activity;
      setData(d => ({ ...d, activity }));
    } catch (err) {
      setToast(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      writeSeq.current += 1;
      setActivitySaving(false);
    }
  };

  const toggleDish = async (mealKey, category, dish) => {
    const key = `${mealKey}.${category}`;
    const current = data.menu_selections[key] || [];
    const next = current.includes(dish) ? current.filter(d => d !== dish) : [...current, dish];
    const selections = { ...data.menu_selections, [key]: next };

    setData(d => ({ ...d, menu_selections: selections }));
    writeSeq.current += 1;
    try {
      await api.put('/nursery/menu', {
        date: data.date,
        branch_id: data.classroom.branch_id,
        selections,
      });
    } catch (err) {
      setToast(err.response?.data?.error || 'שמירת התפריט נכשלה');
      load();
    } finally {
      writeSeq.current += 1;
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

  // Branch order follows the room list the server already sorted, so the two
  // boxes never disagree about what exists.
  const branches = [...new Set(data.classrooms.map(c => c.branch).filter(Boolean))];
  const roomsInBranch = data.classrooms.filter(c => c.branch === branch);
  const onlyRoom = data.classrooms.length === 1 ? data.classrooms[0] : null;

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>לוח יומי</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title={colorMode.dark ? 'מצב יום' : 'מצב לילה'}>
            <IconButton
              onClick={colorMode.toggle}
              aria-label={colorMode.dark ? 'מעבר למצב יום' : 'מעבר למצב לילה'}
              size="small"
            >
              {colorMode.dark ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          {mayEditSettings && (
            <Button size="small" startIcon={<SettingsIcon />} onClick={() => navigate('/nursery/settings')}>
              הגדרות
            </Button>
          )}
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        {/* One room means no choice, and two dropdowns holding one option each
            read as controls somebody forgot to fill in. That is the classroom
            tablet's normal state, and it is also true for anyone scoped to a
            single room — so the rule is "is there anything to pick", not "who
            is asking". The room's name is stated below instead. */}
        {onlyRoom ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
            <Chip label={onlyRoom.branch} size="small" />
            <Chip label={onlyRoom.name} size="small" color="primary" sx={{ fontWeight: 700 }} />
          </Stack>
        ) : (
        <>
        <TextField
          select label="סניף" size="small" value={branch} fullWidth
          onChange={(e) => {
            const next = e.target.value;
            setBranch(next);
            // Moving building moves the room with it — leaving the old room
            // selected would show one gan's board under another gan's name.
            const first = data.classrooms.find(c => c.branch === next);
            if (first) { setClassroomId(String(first.id)); load({ classroom: String(first.id) }); }
          }}
        >
          {branches.map(b => <MenuItem key={b} value={b}>{b}</MenuItem>)}
        </TextField>
        <TextField
          select label="כיתה" size="small" value={classroomId} fullWidth
          onChange={(e) => { setClassroomId(e.target.value); load({ classroom: e.target.value }); }}
        >
          {roomsInBranch.map(c => (
            <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>
          ))}
        </TextField>
        </>
        )}
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

      {/* A פעוט whose family still gets the day. Picked by name from the
          branch's older rooms and carried here for three months. */}
      {!light && isToday && (
        <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1.5 }}>
          <Button size="small" variant="outlined" startIcon={<PersonAddIcon />} onClick={openAdd}>
            הוספת ילד/ה מהפעוטות
          </Button>
        </Stack>
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
            onExtend={(id) => extendChild(id, 1)}
            onRelease={releaseChild}
            onRequestMove={requestMove}
          />
        ))}
      </Box>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle sx={{ fontWeight: 800 }}>הוספת ילד/ה מהפעוטות ללוח</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            הילד/ה יישאר/תישאר בלוח של הכיתה הזו ל-3 חודשים, וההורים ימשיכו לקבל עדכונים. שלושה ימים לפני הסוף הלוח ישאל אם להמשיך.
          </Typography>
          {candidates === null ? <CircularProgress size={22} /> : candidates.length === 0 ? (
            <Alert severity="info" icon={false}>אין ילדים בכיתות הפעוטות של הסניף שאינם כבר בלוח.</Alert>
          ) : (
            <List dense disablePadding>
              {candidates.map(c => (
                <ListItemButton key={c.id} onClick={() => extendChild(c.id, 3)}>
                  <ListItemText primary={c.name} secondary={c.classroom} />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>סגירה</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
      />
    </Box>
  );
}

/**
 * The board, in the light the room asked for.
 *
 * `embedded` is the kiosk, which paints the whole page itself and only needs
 * the theme passed down. Inside the app shell the board paints its own
 * ground instead, bled out over the shell's padding so the dark reaches the
 * edges of the workspace rather than sitting in it as a dark card on cream.
 */
export default function NurseryBoard({ embedded = false }) {
  const colorMode = useBoardColorMode();
  const board = <Board colorMode={colorMode} />;
  if (!colorMode.theme) return board;
  return (
    <ThemeProvider theme={colorMode.theme}>
      <Box sx={{
        bgcolor: 'background.default',
        color: 'text.primary',
        colorScheme: 'dark',
        ...(embedded ? {} : {
          mx: { xs: -2, md: -3 },
          mb: { xs: -2, md: -2.5 },
          px: { xs: 2, md: 3 },
          pt: 2,
          minHeight: '100dvh',
        }),
      }}>
        {board}
      </Box>
    </ThemeProvider>
  );
}
