import { useState } from 'react';
import { Box, Stack, Chip, TextField, Typography, IconButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

/**
 * A list the gan maintains, edited in place.
 *
 * Every list on this screen ends up on the board as a row of taps, so it is
 * shown here the same way — what you see is what the staff will be tapping.
 * A separate "edit" mode with text fields would let somebody build a list that
 * looks fine in the form and wraps into four lines on a phone.
 *
 * Nothing saves on its own. The screen this sits on has one save, because
 * these lists are read together and a half-applied change is a board offering
 * bottle sizes from one version and portions from another.
 */
export default function ChipListEditor({ label, hint, values, onChange, maxLength = 40 }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim().slice(0, maxLength);
    if (!v || values.includes(v)) { setDraft(''); return; }
    onChange([...values, v]);
    setDraft('');
  };

  const remove = (v) => onChange(values.filter(x => x !== v));

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700}>{label}</Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {hint}
        </Typography>
      )}

      <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 1, mb: 1 }}>
        {values.length === 0 && (
          <Typography variant="caption" color="error">
            רשימה ריקה — לא ניתן לשמור
          </Typography>
        )}
        {values.map(v => (
          <Chip key={v} label={v} size="small" onDelete={() => remove(v)} />
        ))}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          size="small"
          value={draft}
          placeholder="הוספה…"
          onChange={(e) => setDraft(e.target.value)}
          // Enter adds, because this is a list somebody types twelve entries
          // into and reaching for the mouse between each is the whole cost.
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          sx={{ maxWidth: 200 }}
        />
        <IconButton size="small" onClick={add} disabled={!draft.trim()} aria-label="הוספה">
          <AddIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}
