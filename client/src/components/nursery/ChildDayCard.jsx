import { useState } from 'react';
import {
  Card, CardContent, Box, Stack, Typography, IconButton, Chip, TextField, Divider,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HomeIcon from '@mui/icons-material/Home';
import { FieldButton, ValuePicker, TimePicker } from './pickers';

/**
 * One child's day.
 *
 * Laid out in the order the day happens — what the parent sent from home,
 * then morning, noon, afternoon, then the things that get noticed at pickup —
 * because the staff fill it in as it happens and a screen ordered any other
 * way makes them hunt.
 *
 * What the parent wrote is READ ONLY here, and visually separate. It is the
 * one block on the card the gan did not write, and a teacher who edits it has
 * overwritten the only thing the parent said this morning.
 *
 * Every tap patches immediately. There is no save button and no dirty state:
 * a card that has to be submitted is a card left unsubmitted when somebody
 * picks up a crying baby.
 */

function age(birth) {
  if (!birth) return '';
  const b = new Date(birth);
  if (Number.isNaN(b.getTime())) return '';
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 0) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y === 0 ? `${m} חודשים` : `${y}.${m}`;
}

export default function ChildDayCard({ child, options, onPatch, readOnly }) {
  const log = child.log || {};
  const meals = log.meals || {};
  const sleep = log.sleep || {};
  const home = log.home || {};

  const [picker, setPicker] = useState(null); // { kind, path, title, ... }
  const [note, setNote] = useState(log.staff_note || '');

  const open = (e, spec) => {
    if (readOnly) return;
    setPicker({ ...spec, anchorEl: e.currentTarget });
  };
  const close = () => setPicker(null);
  const patch = (path, value) => onPatch(child.id, { [path]: value });

  const present = log.attendance === 'הגיע';
  const absent = log.attendance === 'חסר';

  const mealRow = (key, label, hoursKey) => (
    <Box key={key}>
      <Typography variant="caption" color="primary" fontWeight={700}>{label}</Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        <FieldButton
          label="כמות" highlight
          value={meals[key]?.amount}
          onClick={(e) => open(e, {
            kind: 'value', path: `meals.${key}.amount`, title: `${label} — כמות`,
            options: options.meal_amounts, value: meals[key]?.amount,
          })}
        />
        <FieldButton
          label='תמ״ל' highlight
          value={meals[key]?.formula}
          onClick={(e) => open(e, {
            kind: 'value', path: `meals.${key}.formula`, title: `${label} — תמ״ל`,
            options: options.formula_amounts, value: meals[key]?.formula,
          })}
        />
      </Stack>
      {hoursKey && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <FieldButton
            label="השכבה" highlight
            value={sleep[hoursKey]?.start}
            empty="--:--"
            onClick={(e) => open(e, {
              kind: 'time', path: `sleep.${hoursKey}.start`, title: 'שעת השכבה',
              hours: options.hours[`sleep_${hoursKey}`] || options.hours.sleep_noon,
              value: sleep[hoursKey]?.start,
            })}
          />
          <FieldButton
            label="השכמה" highlight
            value={sleep[hoursKey]?.end}
            empty="--:--"
            onClick={(e) => open(e, {
              kind: 'time', path: `sleep.${hoursKey}.end`, title: 'שעת השכמה',
              hours: options.hours[`sleep_${hoursKey}`] || options.hours.sleep_noon,
              value: sleep[hoursKey]?.end,
            })}
          />
        </Stack>
      )}
    </Box>
  );

  return (
    <Card sx={{ opacity: absent ? 0.6 : 1 }}>
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <IconButton
            size="small"
            disabled={readOnly}
            color={present ? 'success' : absent ? 'error' : 'default'}
            onClick={() => patch('attendance', present ? 'חסר' : 'הגיע')}
            aria-label={present ? 'נוכח' : 'סמן נוכחות'}
          >
            {present ? <CheckCircleIcon /> : <CancelIcon />}
          </IconButton>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>{child.name}</Typography>
            {age(child.birth_date) && (
              <Typography variant="caption" color="text.secondary">{age(child.birth_date)}</Typography>
            )}
          </Box>
        </Stack>

        {(home.wake_time || home.meal_time || home.meal_amount || home.parent_note) && (
          <Box sx={{ mb: 2, p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
              <HomeIcon sx={{ fontSize: 15 }} color="success" />
              <Typography variant="caption" fontWeight={700} color="success.main">
                מההורים, מהבית
              </Typography>
            </Stack>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {home.wake_time && <Typography variant="body2">התעורר {home.wake_time}</Typography>}
              {(home.meal_time || home.meal_amount) && (
                <Typography variant="body2">
                  אכל {home.meal_time || ''} {home.meal_amount ? `(${home.meal_amount})` : ''}
                </Typography>
              )}
            </Stack>
            {home.parent_note && (
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                {home.parent_note}
              </Typography>
            )}
          </Box>
        )}

        <Stack spacing={2}>
          {mealRow('breakfast', 'בוקר', 'morning')}
          {mealRow('lunch', 'צהריים', 'noon')}
          {mealRow('snack', 'ארוחת 4', null)}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1}>
          <FieldButton
            label="יציאות" highlight
            value={log.diapers}
            onClick={(e) => open(e, {
              kind: 'value', path: 'diapers', title: 'יציאות',
              options: options.diapers, value: log.diapers,
            })}
          />
          <FieldButton
            label="חסר למחר"
            value={(log.missing || []).join(', ')}
            onClick={(e) => open(e, {
              kind: 'value', path: 'missing', title: 'מה חסר למחר', multi: true,
              options: options.missing, value: log.missing || [],
            })}
            sx={{ borderColor: (log.missing || []).length ? 'error.light' : undefined }}
          />
        </Stack>

        {(log.missing || []).length > 0 && (
          <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 1 }}>
            {log.missing.map(m => <Chip key={m} label={m} size="small" color="error" variant="outlined" />)}
          </Stack>
        )}

        <TextField
          label="הערות צוות"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // Saved on blur, not on every keystroke: a note typed one-handed
          // would otherwise be a request per character over the gan's wifi.
          onBlur={() => { if (note !== (log.staff_note || '')) patch('staff_note', note); }}
          disabled={readOnly}
          fullWidth
          multiline
          size="small"
          minRows={1}
          sx={{ mt: 2 }}
        />
      </CardContent>

      {picker?.kind === 'value' && (
        <ValuePicker
          anchorEl={picker.anchorEl}
          open
          onClose={close}
          title={picker.title}
          options={picker.options || []}
          value={picker.value}
          multi={picker.multi}
          onPick={(v) => patch(picker.path, v)}
        />
      )}
      {picker?.kind === 'time' && (
        <TimePicker
          anchorEl={picker.anchorEl}
          open
          onClose={close}
          title={picker.title}
          hours={picker.hours || []}
          minutes={options.minutes || []}
          value={picker.value}
          onPick={(v) => patch(picker.path, v)}
        />
      )}
    </Card>
  );
}
