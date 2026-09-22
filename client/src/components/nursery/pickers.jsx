import { useState } from 'react';
import {
  Popover, Box, Stack, Chip, Typography, Button, ButtonBase, Divider, TextField,
} from '@mui/material';

/**
 * How a value gets into the board.
 *
 * The staff are holding a baby with one hand and the phone with the other, so
 * everything here is a tap: a field opens a popover of the allowed values and
 * closes the moment one is chosen. There is no free typing outside the note,
 * no keyboard, and no save button — the tap IS the save.
 *
 * Tapping the value that is already set clears it. Getting a field wrong is
 * common (the wrong child, the wrong meal) and the alternative is a separate
 * erase control on every one of the eleven fields.
 */

/** A field as it sits on the card: label above, value below, whole thing tappable. */
export function FieldButton({ label, value, empty = '—', onClick, highlight, sx }) {
  const filled = value !== null && value !== undefined && String(value).trim() !== '';
  return (
    <ButtonBase
      onClick={onClick}
      sx={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        py: 1,
        px: 0.5,
        borderRadius: 2,
        border: '1px solid',
        borderColor: filled && highlight ? 'primary.main' : 'divider',
        bgcolor: filled && highlight ? 'action.selected' : 'transparent',
        ...sx,
      }}
    >
      <Typography variant="caption" color="text.secondary" noWrap>{label}</Typography>
      <Typography
        variant="body2"
        fontWeight={filled ? 700 : 400}
        color={filled ? 'text.primary' : 'text.disabled'}
        noWrap
      >
        {filled ? String(value) : empty}
      </Typography>
    </ButtonBase>
  );
}

/**
 * Choose one of a list, or several when `multi`.
 *
 * Single choice closes on tap. Multi stays open with a confirm, because
 * "what to bring tomorrow" is three or four items and reopening the popover
 * between each would be four taps too many.
 */
export function ValuePicker({ anchorEl, open, onClose, title, options, value, multi, onPick }) {
  const current = multi
    ? (Array.isArray(value) ? value : [])
    : (value ?? '');
  const [draft, setDraft] = useState(current);

  // Re-seed each time it opens; the popover is mounted once and reused.
  const seed = () => setDraft(multi ? (Array.isArray(value) ? value : []) : (value ?? ''));

  const toggle = (opt) => {
    if (!multi) {
      // Tapping the set value clears it.
      onPick(String(opt) === String(current) ? '' : opt);
      onClose();
      return;
    }
    setDraft(d => (d.includes(opt) ? d.filter(x => x !== opt) : [...d, opt]));
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      TransitionProps={{ onEnter: seed }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      slotProps={{ paper: { sx: { p: 1.5, maxWidth: 320 } } }}
    >
      {title && (
        <Typography variant="caption" color="primary" fontWeight={700} sx={{ display: 'block', mb: 1 }}>
          {title}
        </Typography>
      )}
      <Stack direction="row" flexWrap="wrap" gap={0.75}>
        {options.map(opt => {
          const selected = multi ? draft.includes(opt) : String(draft) === String(opt);
          return (
            <Chip
              key={opt}
              label={opt}
              size="small"
              color={selected ? 'primary' : 'default'}
              variant={selected ? 'filled' : 'outlined'}
              onClick={() => toggle(opt)}
            />
          );
        })}
      </Stack>
      <Divider sx={{ my: 1.5 }} />
      <Stack direction="row" spacing={1} justifyContent="space-between">
        {/* Tapping the chosen chip again clears it too, but nobody guesses
            that. A field entered by mistake needs a way out that says so. */}
        <Button
          size="small" color="error"
          disabled={multi ? draft.length === 0 : !current}
          onClick={() => { onPick(multi ? [] : ''); onClose(); }}
        >
          נקה
        </Button>
        {multi && (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={onClose}>ביטול</Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => { onPick(draft); onClose(); }}
            >
              אישור
            </Button>
          </Stack>
        )}
      </Stack>
    </Popover>
  );
}

/**
 * A time, as hours then minutes.
 *
 * The hours offered are narrowed per field — a morning nap does not begin at
 * six in the evening — so the common tap is on a short list rather than a
 * scroll through twenty-four. Minutes are in fives; nobody is recording that
 * a baby fell asleep at 09:37.
 */
/**
 * A clock time, typed.
 *
 * The first version was two rows of chips — pick an hour, pick a minute,
 * save — and it was, in the words of the person filling it in forty times a
 * day, the least convenient way there is to write a time. Now it is what a
 * time is: four digits. "1115" becomes 11:15, "915" becomes 09:15, a colon is
 * fine but not needed, Enter saves. "עכשיו" is one tap, because the nap
 * usually ended a moment ago. The hour list that used to gate the chips now
 * only warns when the typed hour falls outside the room's day — a 03:00
 * bedtime is far more often a typo than a fact, but it is still allowed.
 */
export function TimePicker({ anchorEl, open, onClose, title, hours, value, onPick }) {
  const [raw, setRaw] = useState('');

  const seed = () => setRaw(String(value || ''));

  // What the digits typed so far mean, or null while they do not yet.
  const parsed = (() => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 3) return null;
    const hh = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
    const mm = digits.length === 3 ? digits.slice(1, 3) : digits.slice(2, 4);
    const h = Number(hh);
    const m = Number(mm);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  })();
  const unusual = parsed && Array.isArray(hours) && hours.length > 0 && !hours.includes(parsed.slice(0, 2));

  const now = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const save = () => { if (parsed) { onPick(parsed); onClose(); } };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      TransitionProps={{ onEnter: seed }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      slotProps={{ paper: { sx: { p: 1.5, width: 260 } } }}
    >
      {title && (
        <Typography variant="caption" color="primary" fontWeight={700} sx={{ display: 'block', mb: 1 }}>
          {title}
        </Typography>
      )}

      <TextField
        autoFocus
        fullWidth
        size="small"
        placeholder="למשל 1115"
        value={raw}
        onChange={(e) => setRaw(e.target.value.replace(/[^\d:]/g, '').slice(0, 5))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        inputProps={{
          inputMode: 'numeric',
          dir: 'ltr',
          style: { textAlign: 'center', fontSize: '1.4rem', fontWeight: 700, letterSpacing: 2 },
        }}
        helperText={
          parsed
            ? (unusual ? `${parsed} — מחוץ לשעות הרגילות של הכיתה, בטוח/ה?` : parsed)
            : 'הקלידו את השעה כספרות: 1115 = 11:15'
        }
        FormHelperTextProps={{ sx: { textAlign: 'center', color: unusual ? 'warning.main' : 'text.secondary', fontWeight: parsed ? 700 : 400 } }}
      />

      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Chip label="עכשיו" size="small" variant="outlined" onClick={() => setRaw(now())} />
      </Stack>

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'space-between', mt: 1.5 }}>
        <Button size="small" color="error" onClick={() => { onPick(''); onClose(); }}>
          נקה
        </Button>
        <Button size="small" variant="contained" disabled={!parsed} onClick={save}>
          שמירה
        </Button>
      </Box>
    </Popover>
  );
}
