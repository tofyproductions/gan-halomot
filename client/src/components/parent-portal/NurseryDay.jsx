import { useState, useEffect, useCallback } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, TextField, Button, Alert,
  Chip, Divider, CircularProgress,
} from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import RestaurantIcon from '@mui/icons-material/Restaurant';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import EmojiFoodBeverageIcon from '@mui/icons-material/EmojiFoodBeverage';
import DonutSmallIcon from '@mui/icons-material/DonutSmall';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * The day in the תינוקייה, for the parent.
 *
 * One screen where the old system had two. It had a "live" page and a "daily
 * report" page holding the same values and differing only in when you opened
 * them, so a parent who opened the wrong one got either a half-empty report or
 * a live view they took as final. This is the same page all day: thin in the
 * morning because the morning is thin, complete by evening because the day is.
 *
 * The parent's half is at the top and is the only part they can write — four
 * fields about the morning at home, which the staff read before the child is
 * even in the room. Everything the gan recorded is below it and read-only.
 */

function Row({ label, value, empty = '—' }) {
  const has = value !== null && value !== undefined && String(value).trim() !== '';
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={has ? 600 : 400}
        color={has ? 'text.primary' : 'text.disabled'} sx={{ textAlign: 'left' }}>
        {has ? String(value) : empty}
      </Typography>
    </Stack>
  );
}

/**
 * One fact of the morning, as a labelled tile.
 *
 * The shape the gan's previous system used, and kept on purpose: parents read
 * it every morning for years, and a form that stays open after it has been
 * submitted gives them no way to tell at a glance whether this morning's
 * update actually went in.
 */
function Tile({ icon, label, value, wide = false }) {
  return (
    <Box
      sx={{
        gridColumn: wide ? 'span 2' : 'auto',
        p: 1.5, borderRadius: '12px',
        bgcolor: 'background.default',
        border: 1, borderColor: 'rgba(180,84,10,0.16)',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.25 }}>
        <Box sx={{ color: 'primary.main', display: 'flex', '& svg': { fontSize: 16 } }}>{icon}</Box>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
      </Stack>
      <Typography
        variant="body1" fontWeight={700}
        sx={{ whiteSpace: 'pre-wrap', color: value ? 'text.primary' : 'text.disabled' }}
      >
        {value || '—'}
      </Typography>
    </Box>
  );
}

/** "09:30 - 11:00", or "מ-09:30 (עדיין ישן)" while the nap is still running. */
function napLabel(nap = {}) {
  if (!nap.start && !nap.end) return '';
  if (nap.start && !nap.end) return `מ-${nap.start} (עדיין ישן)`;
  if (!nap.start && nap.end) return `עד ${nap.end}`;
  return `${nap.start} - ${nap.end}`;
}

export default function NurseryDay({ childId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Null until the first load decides. A family who already sent this morning
  // sees the summary; everybody else sees the form, open and ready.
  const [editing, setEditing] = useState(null);

  const [wake, setWake] = useState('');
  const [mealTime, setMealTime] = useState('');
  const [mealAmount, setMealAmount] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await parentApi.get(`/children/${childId}/day`);
      setData(res.data);
      const home = res.data.log?.home || {};
      setWake(home.wake_time || '');
      setMealTime(home.meal_time || '');
      setMealAmount(home.meal_amount || '');
      setNote(home.parent_note || '');
      setEditing(!(home.wake_time || home.meal_time || home.meal_amount || home.parent_note));
    } catch (err) {
      setError(parentApiError(err, 'לא הצלחנו לטעון את היום'));
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await parentApi.patch(`/children/${childId}/day`, {
        'home.wake_time': wake,
        'home.meal_time': mealTime,
        'home.meal_amount': mealAmount,
        'home.parent_note': note,
      });
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 4000);
      load();
    } catch (err) {
      setError(parentApiError(err, 'השמירה נכשלה'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={28} /></Stack>;
  }
  if (error && !data) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  const log = data.log;
  const meals = log?.meals || {};
  const sleep = log?.sleep || {};
  const absent = log?.attendance === 'חסר';

  const mealLine = (key, label) => {
    const m = meals[key] || {};
    const parts = [];
    if (m.amount) parts.push(`אכל ${m.amount}`);
    if (m.formula) parts.push(`תמ״ל ${m.formula}`);
    return <Row key={key} label={label} value={parts.join(' · ')} empty="טרם עודכן" />;
  };

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}

      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
            <HomeIcon fontSize="small" color="success" />
            <Typography variant="h5">הבוקר שלנו בבית</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            הצוות רואה את זה לפני שהילד מגיע לכיתה.
          </Typography>

          {editing === false ? (
            /* Sent. The old system collapsed the form into exactly this, and
               it was right to: the answer to "did I send it this morning" has
               to be readable without re-reading four half-filled inputs. */
            <>
              <Stack
                direction="row" alignItems="center" justifyContent="center"
                spacing={0.75} sx={{ mt: 2, mb: 2, color: 'success.dark' }}
              >
                <CheckCircleIcon fontSize="small" />
                <Typography variant="subtitle1" color="success.dark">
                  {saved ? 'העדכון נשלח לצוות' : 'העדכון של הבוקר נשלח'}
                </Typography>
              </Stack>

              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                <Tile icon={<WbSunnyIcon />} label="התעורר/ה" value={wake} />
                <Tile icon={<EmojiFoodBeverageIcon />} label="אכל/ה בבית" value={mealTime} />
                <Tile icon={<DonutSmallIcon />} label="כמות ארוחה" value={mealAmount} wide />
                {note && (
                  <Tile icon={<ChatBubbleOutlineIcon />} label="הערה לצוות" value={note} wide />
                )}
              </Box>

              <Stack alignItems="center" sx={{ mt: 2 }}>
                <Button size="small" variant="outlined" startIcon={<EditIcon />}
                  onClick={() => setEditing(true)}>
                  עדכון/שינוי הפרטים
                </Button>
              </Stack>
            </>
          ) : (
            <Stack spacing={2} sx={{ mt: 2 }}>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="שעת התעוררות" type="time" size="small" fullWidth
                  value={wake} onChange={(e) => setWake(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
                <TextField
                  label="שעת ארוחה" type="time" size="small" fullWidth
                  value={mealTime} onChange={(e) => setMealTime(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Stack>
              <TextField
                label="כמה אכל" size="small" fullWidth
                value={mealAmount} onChange={(e) => setMealAmount(e.target.value)}
                placeholder="למשל: 120 מ״ל, חצי מנה"
              />
              <TextField
                label="הערה לצוות" size="small" fullWidth multiline minRows={2}
                value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="כל מה שחשוב שהצוות ידע הבוקר"
              />
              <Button
                variant="contained" fullWidth startIcon={<SendIcon />}
                onClick={save} disabled={saving}
              >
                {saving ? 'שולח…' : 'שליחת עדכון'}
              </Button>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 1.5 }}>היום בגן</Typography>

          {!log && (
            <Alert severity="info">הצוות עוד לא עדכן היום.</Alert>
          )}

          {absent && <Alert severity="warning" sx={{ mb: 2 }}>סומן כלא הגיע היום.</Alert>}

          {log && !absent && (
            <Stack spacing={1}>
              {mealLine('breakfast', 'בוקר')}
              <Row label="שנת בוקר" value={napLabel(sleep.morning)} empty="לא נרשמה" />
              <Divider sx={{ my: 0.5 }} />
              {mealLine('lunch', 'צהריים')}
              <Row label="שנת צהריים" value={napLabel(sleep.noon)} empty="לא נרשמה" />
              <Divider sx={{ my: 0.5 }} />
              {mealLine('snack', 'ארוחת 4')}
              <Row label="יציאות" value={log.diapers} empty="לא נרשם" />

              {(log.missing || []).length > 0 && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="body2" color="error" fontWeight={700} sx={{ mb: 0.5 }}>
                    להביא מחר
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" gap={0.5}>
                    {log.missing.map(m => (
                      <Chip key={m} label={m} size="small" color="error" variant="outlined" />
                    ))}
                  </Stack>
                </Box>
              )}

              {log.staff_note && (
                <Box sx={{ mt: 1.5, p: 1.5, borderRadius: '12px', bgcolor: 'action.hover' }}>
                  <Typography variant="caption" color="primary" fontWeight={700}>הערת הצוות</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{log.staff_note}</Typography>
                </Box>
              )}
            </Stack>
          )}
        </CardContent>
      </Card>

      {data.menu.length > 0 && (
        <Card>
          <CardContent>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
              <RestaurantIcon fontSize="small" color="primary" />
              <Typography variant="h5">מה אכלנו היום</Typography>
            </Stack>
            <Stack spacing={1.5}>
              {data.menu.map(meal => (
                <Box key={meal.meal}>
                  <Typography variant="body2" fontWeight={700} color="primary">{meal.label}</Typography>
                  <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 0.5 }}>
                    {meal.categories.flatMap(c => c.dishes).map(dish => (
                      <Chip key={dish} label={dish} size="small" variant="outlined" />
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
