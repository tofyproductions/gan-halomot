import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Autocomplete } from '@mui/material';

/** Add or edit one person's block of hours in one row on one day. */
export default function EntryDialog({ open, onClose, onSave, onDelete, entry, defaults, employees, rows }) {
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!open) return;
    setForm(entry ? { ...entry } : {
      employee_id: '', employee_name: '', date: defaults.date, area: defaults.area,
      classroom_id: defaults.classroom_id, start_hhmm: '07:00', end_hhmm: '16:00', alternating: false, new_class: false,
    });
  }, [open, entry, defaults]);
  if (!form) return null;
  const rowValue = form.area === 'class' ? `class:${form.classroom_id}` : form.area;
  const employee = employees.find(e => e._id === String(form.employee_id)) || null;
  const valid = form.employee_id && form.start_hhmm && form.end_hhmm && form.start_hhmm < form.end_hhmm;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>{entry ? 'עריכת שיבוץ' : 'שיבוץ עובדת'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={employees} value={employee} disabled={!!entry}
            getOptionLabel={o => o.full_name}
            onChange={(_, v) => setForm(f => ({ ...f, employee_id: v ? v._id : '', employee_name: v ? v.full_name : '' }))}
            renderInput={p => <TextField {...p} label="עובדת" />}
          />
          <TextField
            select label="כיתה / שורה" value={rowValue}
            onChange={e => {
              const v = e.target.value;
              setForm(f => (v.startsWith('class:') ? { ...f, area: 'class', classroom_id: v.slice(6) } : { ...f, area: v, classroom_id: null }));
            }}
          >
            {rows.map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1}>
            <TextField label="משעה" type="time" value={form.start_hhmm} onChange={e => setForm(f => ({ ...f, start_hhmm: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField label="עד שעה" type="time" value={form.end_hhmm} onChange={e => setForm(f => ({ ...f, end_hhmm: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        {entry && <Button color="error" onClick={() => onDelete(entry)} sx={{ mr: 'auto' }}>{entry.alternating ? 'יום חופש השבוע' : 'הסרה'}</Button>}
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave(form)}>שמירה</Button>
      </DialogActions>
    </Dialog>
  );
}
