import { useState } from 'react';
import {
  Card, CardContent, Box, Stack, Typography, IconButton, Chip, TextField, Divider,
  Alert, Button, Tooltip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HomeIcon from '@mui/icons-material/Home';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import EventBusyIcon from '@mui/icons-material/EventBusy';
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

/**
 * A tile that shows and does not take a tap.
 *
 * Reads like FieldButton because it sits among them, but it is a Box and not a
 * ButtonBase on purpose: what the parent wrote is the one thing on this card
 * the gan did not write, and a teacher who edits it has overwritten the only
 * thing that family said this morning. Rendering it as a button would invite
 * exactly that, and would announce itself to a screen reader as something that
 * can be pressed.
 *
 * Wraps rather than truncating — "120 מ״ל סימילאק" is two lines and cutting
 * it to "120 מ״ל…" loses which formula.
 */
function HomeTile({ label, parts }) {
  const shown = (parts || []).map(p => (p == null ? '' : String(p).trim())).filter(Boolean);
  const filled = shown.length > 0;
  return (
    <Box
      sx={{
        flex: 1, minWidth: 0, py: 1, px: 0.75, borderRadius: 2,
        border: '1px solid', borderColor: 'divider',
        bgcolor: 'background.paper',
        textAlign: 'center',
      }}
    >
      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        fontWeight={filled ? 700 : 400}
        color={filled ? 'text.primary' : 'text.disabled'}
        sx={{ wordBreak: 'break-word' }}
      >
        {/* Each piece in its own <bdi>.
            "06:45 / 100%" is two left-to-right runs inside a right-to-left
            line, so the browser reorders them as one block and the tile read
            "100% / 06:45" — the time and the portion swapped, which on this
            particular card is a sentence about when a baby last ate. It only
            looked right for the children whose amount ends in Hebrew
            ("120 מ״ל סימילאק"), which is the worst kind of bug: correct in
            the example somebody checked. <bdi> isolates each piece so the
            order written here is the order shown. */}
        {filled
          ? shown.map((part, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i}>
              {i > 0 && ' / '}
              <bdi>{part}</bdi>
            </span>
          ))
          : '—'}
      </Typography>
    </Box>
  );
}

export default function ChildDayCard({
  child, options, onPatch, readOnly, onExtend, onRelease, onRequestMove,
}) {
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

  /**
   * "העבר לכיתת הפעוטות" — two questions, in this order, on purpose.
   *
   * The first is the brake: a move changes what the family pays, and the
   * button sits an inch from the attendance toggle. The second is the one
   * only this person can answer — does the family still want the bottle log
   * — and it is asked NOW, while she is thinking about this child, because
   * the manager who approves later has no way of knowing.
   */
  const askMove = () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`להעביר את ${child.name} לכיתת הפעוטות?\n\nהבקשה תישלח למנהלת הסניף לאישור — בלעדיו המעבר לא מתבצע. התשלום לא משתנה.`)) return;
    // eslint-disable-next-line no-alert
    const keep = window.confirm(`להשאיר את ${child.name} בלוח העדכונים של התינוקייה ל-3 החודשים הקרובים?\n\nכן — ההורים ימשיכו לקבל עדכונים מכאן.\nביטול — הילד/ה יוסר/תוסר מהלוח עם המעבר.`);
    onRequestMove?.(child.id, keep);
  };

  const present = log.attendance === 'הגיע';
  const absent = log.attendance === 'חסר';

  /**
   * What a sync conflict rejected for one field, if this day has one.
   *
   * The sheet's value already won and sits in the cell above — that is the
   * whole of the conflict policy (see `DailyLog.sync_conflicts`). This is
   * what OURS held at the moment of the sync, so the person in the room sees
   * both instead of a number nobody here typed with no explanation. `.lean()`
   * on the board's own read does not backfill a document written before this
   * field existed, so `log.sync_conflicts` may be `undefined` rather than
   * `[]` — tolerated here rather than assumed away.
   */
  const conflictNote = (fieldPath) => (log.sync_conflicts || [])
    .filter(c => c.field === fieldPath)
    .map((c, i) => (
      <Typography key={i} variant="caption" sx={{ display: 'block', color: 'warning.main', mt: 0.25 }}>
        אצלנו נרשם: {Array.isArray(c.ours) ? c.ours.join(', ') : c.ours || '—'}
      </Typography>
    ));

  /**
   * The same note, for the fields the parent owns.
   *
   * These four are written in the parent portal and are read-only here, so
   * without this they are the one group of conflicts no screen in either
   * system shows: the parent's value loses to the sheet, is kept on the log,
   * and is then quietly dropped the next time the parent edits that field —
   * deleted silently, from every human's point of view, which is the exact
   * thing the conflict policy exists to prevent. Shown on the staff board
   * rather than the portal on purpose: a parent should not be shown the gan's
   * sync mechanics, and the staff are the ones who can act on knowing that
   * the old board overrode what the family sent this morning.
   */
  const HOME_LABELS = {
    'home.wake_time': 'התעורר',
    'home.meal_time': 'אכל בבית — שעה',
    'home.meal_amount': 'אכל בבית — כמות',
    'home.parent_note': 'הערת הורים',
  };
  const homeConflicts = (log.sync_conflicts || []).filter(c => HOME_LABELS[c.field]);

  const mealRow = (key, label, hoursKey) => (
    <Box key={key}>
      <Typography variant="caption" color="primary" fontWeight={700}>{label}</Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <FieldButton
            label="כמות" highlight
            value={meals[key]?.amount}
            onClick={(e) => open(e, {
              kind: 'value', path: `meals.${key}.amount`, title: `${label} — כמות`,
              options: options.meal_amounts, value: meals[key]?.amount,
            })}
          />
          {conflictNote(`meals.${key}.amount`)}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <FieldButton
            label='תמ״ל' highlight
            value={meals[key]?.formula}
            onClick={(e) => open(e, {
              kind: 'value', path: `meals.${key}.formula`, title: `${label} — תמ״ל`,
              options: options.formula_amounts, value: meals[key]?.formula,
            })}
          />
          {conflictNote(`meals.${key}.formula`)}
        </Box>
      </Stack>
      {hoursKey && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
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
            {conflictNote(`sleep.${hoursKey}.start`)}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
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
            {conflictNote(`sleep.${hoursKey}.end`)}
          </Box>
        </Stack>
      )}
    </Box>
  );

  return (
    <Card sx={{ opacity: absent ? 0.7 : 1, borderTop: 4, borderTopColor: present ? 'success.main' : absent ? 'error.main' : 'transparent' }}>
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          {/* Green = here today, red = not coming. Two chips, not one icon:
              the old grey ✕ for "not marked yet" read as "absent", and a room
              cannot tell "nobody marked him" from "he is not coming". Tapping
              the lit chip again clears it. */}
          <Stack direction="row" spacing={0.4}>
            <Chip
              size="small" icon={<CheckCircleIcon />} label={present && log.attendance_auto ? 'הגיע ·אוטו' : 'הגיע'}
              title={log.attendance_auto ? 'סומן אוטומטית — לחיצה קובעת ידנית' : undefined}
              color="success" variant={present ? 'filled' : 'outlined'}
              disabled={readOnly}
              onClick={() => patch('attendance', present ? '' : 'הגיע')}
              sx={{ fontWeight: present ? 800 : 500, opacity: absent ? 0.5 : 1 }}
            />
            <Chip
              size="small" icon={<CancelIcon />} label={absent && log.attendance_auto ? 'לא הגיע ·אוטו' : 'לא הגיע'}
              title={log.attendance_auto ? 'סומן אוטומטית לפי הודעת ההורים — לחיצה קובעת ידנית' : undefined}
              color="error" variant={absent ? 'filled' : 'outlined'}
              disabled={readOnly}
              onClick={() => patch('attendance', absent ? '' : 'חסר')}
              sx={{ fontWeight: absent ? 800 : 500, opacity: present ? 0.5 : 1 }}
            />
          </Stack>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1" fontWeight={700} noWrap>{child.name}</Typography>
              {/* A child who moved up and is carried here for a while. The mark
                  says so and names their real room, because a card that looks
                  like every other card is how a פעוט gets a תינוקייה portion. */}
              {child.carried && (
                <Tooltip title={`עבר/ה ל${child.own_classroom || 'פעוטות'}. נשאר/ת בלוח עד ${child.board_until || '—'}`}>
                  <Chip size="small" color="secondary" variant="outlined" label="פעוט/ה" sx={{ height: 20, fontSize: '0.7rem' }} />
                </Tooltip>
              )}
              {child.pending_move && (
                <Tooltip title={`בקשת מעבר ל${child.pending_move.to} ממתינה לאישור מנהלת הסניף`}>
                  <Chip size="small" color="warning" variant="outlined" label="מעבר ממתין" sx={{ height: 20, fontSize: '0.7rem' }} />
                </Tooltip>
              )}
            </Stack>
            {age(child.birth_date) && (
              <Typography variant="caption" color="text.secondary">{age(child.birth_date)}</Typography>
            )}
          </Box>
          {/* Only for the room's OWN children: a carried פעוט has already moved.
              The button asks; the branch manager answers, because the room
              decides the fee. */}
          {!readOnly && !child.carried && !child.pending_move && onRequestMove && (
            <Tooltip title="העבר לכיתת הפעוטות">
              <IconButton size="small" onClick={() => askMove()} aria-label="העבר לכיתת הפעוטות">
                <TrendingUpIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        {conflictNote('attendance')}

        {/* The last three days of a carried child's stay: ask, in place, where
            the people who know the child are. כן = one more month from
            today; לא = off the board at the end. Not a push notification — the
            board IS where the גננות are, and a question nobody is standing in
            front of is a question that gets answered by the calendar. */}
        {child.carried && child.board_expiring && !readOnly && (
          <Alert
            severity="warning" icon={<EventBusyIcon fontSize="inherit" />}
            sx={{ mb: 1.5, py: 0.5, '& .MuiAlert-message': { width: '100%' } }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
              האם להשאיר את {child.name} בלוח העדכונים?
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              השהייה בלוח מסתיימת ב-{child.board_until}.
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" color="warning" onClick={() => onExtend?.(child.id)}>
                כן, עוד חודש
              </Button>
              <Button size="small" variant="outlined" color="inherit" onClick={() => onRelease?.(child.id)}>
                לא, להסיר
              </Button>
            </Stack>
          </Alert>
        )}

        {(home.wake_time || home.meal_time || home.meal_amount || home.parent_note || home.not_coming
          || homeConflicts.length > 0) && (
          <Box
            sx={{
              mb: 2, p: 1.25, borderRadius: 3,
              border: '1px solid', borderColor: 'success.soft',
              bgcolor: 'action.hover',
            }}
          >
            <Stack direction="row" justifyContent="center" sx={{ mb: 1 }}>
              <Chip
                size="small" icon={<HomeIcon />} label="עדכוני הורים (בבית)"
                sx={{ bgcolor: 'success.soft', color: 'success.softOn', fontWeight: 700 }}
              />
            </Stack>

            {/* Two tiles, the way the rest of this card reads — a label above a
                value, in a box. As text on one line ("התעורר 06:15 אכל
                06:30 (25%)") it was the only part of the card a teacher had to
                actually parse, and it is the part she reads first, standing up,
                holding somebody.

                Both are drawn even when only one was filled in: a missing
                answer is a fact the room wants ("nobody said when he woke"),
                and a block that changes shape per child is a block that has to
                be re-read every time. */}
            {home.not_coming && (
              <Stack direction="row" justifyContent="center" sx={{ mb: 1 }}>
                <Chip size="small" color="error" icon={<CancelIcon />} label="ההורים הודיעו: לא מגיע/ה היום" sx={{ fontWeight: 800 }} />
              </Stack>
            )}
            <Stack direction="row" spacing={1}>
              <HomeTile label="אכל בבוקר" parts={[home.meal_time, home.meal_amount]} />
              <HomeTile label="התעורר" parts={[home.wake_time]} />
            </Stack>

            {home.parent_note && (
              <Box
                sx={{
                  mt: 1, p: 1, borderRadius: 2,
                  border: '1px solid', borderColor: 'warning.soft',
                  bgcolor: 'warning.soft',
                }}
              >
                <Typography variant="caption" fontWeight={700} sx={{ color: 'warning.softOn', display: 'block', mb: 0.25 }}>
                  הערת הורים:
                </Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', color: 'warning.softOn' }}>
                  {home.parent_note}
                </Typography>
              </Box>
            )}

            {homeConflicts.map((c, i) => (
              <Typography key={i} variant="caption" sx={{ display: 'block', color: 'warning.main', mt: 0.5 }}>
                ההורים רשמו {HOME_LABELS[c.field]}: {Array.isArray(c.ours) ? c.ours.join(', ') : c.ours || '—'} — הלוח הישן גבר
              </Typography>
            ))}
          </Box>
        )}

        <Stack spacing={2}>
          {mealRow('breakfast', 'בוקר', 'morning')}
          {mealRow('lunch', 'צהריים', 'noon')}
          {mealRow('snack', 'ארוחת 4', null)}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <FieldButton
              label="יציאות" highlight
              value={log.diapers}
              onClick={(e) => open(e, {
                kind: 'value', path: 'diapers', title: 'יציאות',
                options: options.diapers, value: log.diapers,
              })}
            />
            {conflictNote('diapers')}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <FieldButton
              label="חסר למחר"
              value={(log.missing || []).join(', ')}
              onClick={(e) => open(e, {
                kind: 'value', path: 'missing', title: 'מה חסר למחר', multi: true,
                options: options.missing, value: log.missing || [],
              })}
              sx={{ borderColor: (log.missing || []).length ? 'error.light' : undefined }}
            />
            {conflictNote('missing')}
          </Box>
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
        {conflictNote('staff_note')}
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
