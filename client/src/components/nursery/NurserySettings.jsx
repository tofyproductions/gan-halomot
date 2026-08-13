import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, Stack, Button, Alert, CircularProgress,
  TextField, Divider, IconButton, Snackbar,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import api from '../../api/client';
import ChipListEditor from './ChipListEditor';

/**
 * The lists and the menu behind the daily board.
 *
 * These lived in a sheet tab the gan edited itself, and the point of this
 * screen is that they still can — the bottle sizes, the what-to-bring list and
 * the dishes are the kitchen's business, and a menu that needs a developer to
 * change is a menu that goes stale.
 *
 * One save for the whole screen. The board reads these lists together, and a
 * half-applied change would leave it offering portions from one version and
 * bottle sizes from another.
 *
 * The three meals are fixed — the child card is laid out around breakfast,
 * lunch and the four o'clock — so this edits their names, their categories and
 * their dishes, and does not offer to invent a fourth.
 */

const LISTS = [
  { key: 'meal_amounts', label: 'כמויות אכילה', hint: 'מה שנבחר בשדה "כמות" בכל ארוחה' },
  { key: 'formula_amounts', label: 'כמויות תמ״ל', hint: 'במיליליטרים' },
  { key: 'diapers', label: 'יציאות', hint: '' },
  { key: 'missing', label: 'מה חסר למחר', hint: 'מה שאפשר לבקש מההורים להביא' },
];

export default function NurserySettings() {
  const navigate = useNavigate();
  const [options, setOptions] = useState(null);
  const [menu, setMenu] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/nursery/settings');
        setOptions(res.data.options);
        setMenu(res.data.menu);
      } catch (err) {
        setError(err.response?.data?.error || 'לא הצלחנו לטעון את ההגדרות');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setList = (key, values) => setOptions(o => ({ ...o, [key]: values }));

  const setMealLabel = (mealKey, label) =>
    setMenu(m => ({ ...m, [mealKey]: { ...m[mealKey], label } }));

  const setDishes = (mealKey, category, dishes) =>
    setMenu(m => ({
      ...m,
      [mealKey]: { ...m[mealKey], categories: { ...m[mealKey].categories, [category]: dishes } },
    }));

  const removeCategory = (mealKey, category) =>
    setMenu(m => {
      const next = { ...m[mealKey].categories };
      delete next[category];
      return { ...m, [mealKey]: { ...m[mealKey], categories: next } };
    });

  const addCategory = (mealKey, name) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    setMenu(m => (m[mealKey].categories[clean]
      ? m
      : { ...m, [mealKey]: { ...m[mealKey], categories: { ...m[mealKey].categories, [clean]: [] } } }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // Two calls because they are two settings keys, and the server validates
      // each on its own terms. Options first: a menu saved against rejected
      // lists would be the half-applied state this screen exists to avoid.
      const o = await api.put('/nursery/settings/options', options);
      setOptions(o.data.options);
      const m = await api.put('/nursery/settings/menu', { menu });
      setMenu(m.data.menu);
      setToast('נשמר');
    } catch (err) {
      setError(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Stack alignItems="center" sx={{ py: 8 }}><CircularProgress /></Stack>;
  if (!options || !menu) return <Alert severity="error">{error || 'לא נטען'}</Alert>;

  const anyEmpty = LISTS.some(l => (options[l.key] || []).length === 0);

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', pb: 8 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <IconButton size="small" onClick={() => navigate('/nursery')} aria-label="חזרה ללוח">
          <ArrowForwardIcon />
        </IconButton>
        <Typography variant="h5" fontWeight={700}>הגדרות לוח תינוקייה</Typography>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        השינויים חלים על כל הסניפים. ימים שכבר נרשמו לא משתנים — מה שהוגש בעבר נשאר כפי שהיה.
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>רשימות בחירה</Typography>
          <Stack spacing={3}>
            {LISTS.map(l => (
              <ChipListEditor
                key={l.key}
                label={l.label}
                hint={l.hint}
                values={options[l.key] || []}
                onChange={(v) => setList(l.key, v)}
              />
            ))}
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" fontWeight={700} sx={{ mb: 0.5 }}>תפריט</Typography>
          <Typography variant="caption" color="text.secondary">
            המנות שהצוות בוחר מהן כל בוקר. שלוש הארוחות קבועות — אפשר לשנות את שמן ואת התוכן.
          </Typography>

          <Stack spacing={3} sx={{ mt: 2 }}>
            {Object.entries(menu).map(([mealKey, meal]) => (
              <Box key={mealKey}>
                <TextField
                  label="שם הארוחה" size="small" value={meal.label}
                  onChange={(e) => setMealLabel(mealKey, e.target.value)}
                  sx={{ mb: 2, maxWidth: 260 }}
                />
                <Stack spacing={2} sx={{ pr: 1 }}>
                  {Object.entries(meal.categories || {}).map(([category, dishes]) => (
                    <Box key={category}>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <Typography variant="body2" fontWeight={700} color="primary">
                          {category}
                        </Typography>
                        <IconButton size="small" aria-label={`מחיקת ${category}`}
                          onClick={() => removeCategory(mealKey, category)}>
                          <DeleteOutlineIcon fontSize="inherit" />
                        </IconButton>
                      </Stack>
                      <ChipListEditor
                        label=""
                        values={dishes}
                        onChange={(v) => setDishes(mealKey, category, v)}
                      />
                    </Box>
                  ))}
                  <AddCategory onAdd={(name) => addCategory(mealKey, name)} />
                </Stack>
                <Divider sx={{ mt: 2 }} />
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button onClick={() => navigate('/nursery')} disabled={saving}>חזרה</Button>
        <Button variant="contained" onClick={save} disabled={saving || anyEmpty}>
          {saving ? 'שומר…' : 'שמירה'}
        </Button>
      </Stack>
      {anyEmpty && (
        <Typography variant="caption" color="error" sx={{ display: 'block', textAlign: 'left', mt: 1 }}>
          יש רשימה ריקה. שדה בלי אפשרויות הוא שדה שהצוות לא יכול למלא.
        </Typography>
      )}

      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast('')} message={toast} />
    </Box>
  );
}

function AddCategory({ onAdd }) {
  const [name, setName] = useState('');
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <TextField
        size="small" value={name} placeholder="קטגוריה חדשה…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(name); setName(''); } }}
        sx={{ maxWidth: 200 }}
      />
      <IconButton size="small" disabled={!name.trim()}
        onClick={() => { onAdd(name); setName(''); }} aria-label="הוספת קטגוריה">
        <AddIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}
