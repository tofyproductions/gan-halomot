import { useState } from 'react';
import {
  Popover, Box, Stack, Chip, Typography, Button, ButtonBase, Divider,
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
      {multi && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button size="small" onClick={onClose}>ביטול</Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => { onPick(draft); onClose(); }}
            >
              אישור
            </Button>
          </Stack>
        </>
      )}
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
export function TimePicker({ anchorEl, open, onClose, title, hours, minutes, value, onPick }) {
  const [h, setH] = useState('');
  const [m, setM] = useState('');

  const seed = () => {
    const [hh = '', mm = ''] = String(value || '').split(':');
    setH(hh);
    setM(mm);
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      TransitionProps={{ onEnter: seed }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      slotProps={{ paper: { sx: { p: 1.5, maxWidth: 300 } } }}
    >
      {title && (
        <Typography variant="caption" color="primary" fontWeight={700} sx={{ display: 'block', mb: 1 }}>
          {title}
        </Typography>
      )}

      <Typography variant="caption" color="text.secondary">שעה</Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1.5, mt: 0.5 }}>
        {hours.map(x => (
          <Chip key={x} label={x} size="small"
            color={h === x ? 'primary' : 'default'}
            variant={h === x ? 'filled' : 'outlined'}
            onClick={() => setH(x)} />
        ))}
      </Stack>

      <Typography variant="caption" color="text.secondary">דקות</Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1.5, mt: 0.5 }}>
        {minutes.map(x => (
          <Chip key={x} label={x} size="small"
            color={m === x ? 'primary' : 'default'}
            variant={m === x ? 'filled' : 'outlined'}
            onClick={() => setM(x)} />
        ))}
      </Stack>

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'space-between' }}>
        <Button size="small" color="error" onClick={() => { onPick(''); onClose(); }}>
          נקה
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!h || !m}
          onClick={() => { onPick(`${h}:${m}`); onClose(); }}
        >
          שמירה
        </Button>
      </Box>
    </Popover>
  );
}
