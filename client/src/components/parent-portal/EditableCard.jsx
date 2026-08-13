import { useState } from 'react';
import {
  Card, CardContent, Typography, Stack, Button, TextField, Alert, Box,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';

/**
 * A block of the child's record that the parent may correct in place.
 *
 * Read mode by default, because that is what the screen is for most of the
 * time; editing is a deliberate act. Save sends only what changed — the server
 * ignores unchanged values anyway, and sending the whole form would put a row
 * on the staff's screen every time somebody opened the editor and closed it.
 *
 * `warning` is shown while editing, not in read mode. It carries the health
 * caution: these fields are what the kitchen and the staff work from, and a
 * parent about to clear one should be told that before they type, not after.
 */
export default function EditableCard({
  title, fields, values, warning, onSave, extraAction,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const begin = () => {
    setDraft(Object.fromEntries(fields.map(f => [f.name, values[f.name] ?? ''])));
    setError('');
    setEditing(true);
  };

  const cancel = () => { setEditing(false); setDraft({}); setError(''); };

  const save = async () => {
    setError('');
    const changed = {};
    for (const f of fields) {
      const before = String(values[f.name] ?? '').trim();
      const after = String(draft[f.name] ?? '').trim();
      if (before !== after) changed[f.name] = after;
    }
    if (Object.keys(changed).length === 0) { cancel(); return; }

    setSaving(true);
    try {
      await onSave(changed);
      setEditing(false);
    } catch (err) {
      setError(err.message || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
          {!editing && (
            <Button size="small" startIcon={<EditIcon />} onClick={begin}>עריכה</Button>
          )}
        </Stack>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {editing && warning && <Alert severity="warning" sx={{ mb: 2 }}>{warning}</Alert>}

        {!editing && (
          <Stack spacing={1}>
            {fields.map(f => {
              const v = values[f.name];
              const has = v !== null && v !== undefined && String(v).trim() !== '';
              return (
                <Stack key={f.name} direction="row" spacing={1} justifyContent="space-between" alignItems="baseline">
                  <Typography variant="body2" color="text.secondary">{f.label}</Typography>
                  <Typography
                    variant="body2"
                    sx={{ textAlign: 'left', color: has ? 'text.primary' : 'text.disabled' }}
                  >
                    {has ? String(v) : (f.empty || 'לא רשום')}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>
        )}

        {editing && (
          <Stack spacing={2}>
            {fields.map(f => (
              <TextField
                key={f.name}
                label={f.label}
                value={draft[f.name] ?? ''}
                onChange={(e) => setDraft(d => ({ ...d, [f.name]: e.target.value }))}
                fullWidth
                size="small"
                multiline={f.multiline}
                minRows={f.multiline ? 2 : undefined}
                inputMode={f.numeric ? 'numeric' : undefined}
              />
            ))}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button onClick={cancel} disabled={saving}>ביטול</Button>
              <Button variant="contained" onClick={save} disabled={saving}>
                {saving ? 'שומר…' : 'שמירה'}
              </Button>
            </Stack>
          </Stack>
        )}

        {!editing && extraAction && <Box sx={{ mt: 2 }}>{extraAction}</Box>}
      </CardContent>
    </Card>
  );
}
