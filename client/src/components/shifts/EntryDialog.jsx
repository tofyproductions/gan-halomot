import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Stack, Autocomplete, Divider, Typography } from '@mui/material';
import CallSplitIcon from '@mui/icons-material/CallSplit';

/** Add or edit one person's block of hours in one row on one day. */
export default function EntryDialog({ open, onClose, onSave, onDelete, onSplit, entry, defaults, employees, rows, onRequestRate }) {
  const [form, setForm] = useState(null);
  /**
   * The split, at ANY hour: her one block becomes two — the first keeps its
   * room, the second gets its own hour and its own room. Opened on demand so
   * a plain hours-edit stays the two fields it always was.
   */
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAt, setSplitAt] = useState('14:00');
  const [splitRow, setSplitRow] = useState('');
  useEffect(() => {
    if (!open) return;
    setForm(entry ? { ...entry } : {
      employee_id: '', employee_name: '', date: defaults.date, area: defaults.area,
      classroom_id: defaults.classroom_id, start_hhmm: '07:00', end_hhmm: '16:00', alternating: false, new_class: false,
    });
    setSplitOpen(false);
    setSplitAt('14:00');
    setSplitRow('');
    // defaults is read only when the dialog opens; a re-render must not wipe edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);
  if (!form) return null;
  const rowValue = form.area === 'class' ? `class:${form.classroom_id}` : form.area;
  const employee = employees.find(e => e._id === String(form.employee_id)) || null;
  const valid = form.employee_id && form.start_hhmm && form.end_hhmm && form.start_hhmm < form.end_hhmm;
  const splitValid = splitOpen && splitRow && splitAt > form.start_hhmm && splitAt < form.end_hhmm;
  const doSplit = () => {
    const v = splitRow;
    const target = v.startsWith('class:')
      ? { area: 'class', classroom_id: v.slice(6) }
      : { area: v, classroom_id: null };
    onSplit(entry, { at: splitAt, ...target });
  };

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
          {onRequestRate && !entry && (
            <Button size="small" variant="text" onClick={onRequestRate} sx={{ alignSelf: 'flex-start' }}>עובדת מסניף אחר בלי תעריף? בקשת תעריף</Button>
          )}
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

          {entry && onSplit && !splitOpen && (
            <Button size="small" variant="text" startIcon={<CallSplitIcon />} onClick={() => setSplitOpen(true)} sx={{ alignSelf: 'flex-start' }}>
              פיצול המשמרת לשתי כיתות
            </Button>
          )}
          {entry && onSplit && splitOpen && (
            <>
              <Divider />
              <Typography variant="body2" sx={{ fontWeight: 700 }}>פיצול המשמרת</Typography>
              <Typography variant="caption" color="text.secondary">
                עד שעת הפיצול היא נשארת בכיתה הנוכחית; משעת הפיצול ועד {form.end_hhmm} היא עוברת לכיתה שתיבחר.
              </Typography>
              <TextField label="שעת פיצול" type="time" value={splitAt}
                onChange={e => setSplitAt(e.target.value)} InputLabelProps={{ shrink: true }}
                error={!!splitAt && !(splitAt > form.start_hhmm && splitAt < form.end_hhmm)}
                helperText={splitAt && !(splitAt > form.start_hhmm && splitAt < form.end_hhmm)
                  ? `השעה חייבת להיות בין ${form.start_hhmm} ל-${form.end_hhmm}` : ''} />
              <TextField select label="כיתה לחלק השני" value={splitRow}
                onChange={e => setSplitRow(e.target.value)}>
                {rows.filter(r => r.key !== rowValue).map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
              </TextField>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setSplitOpen(false)}>ביטול פיצול</Button>
                <Button size="small" variant="contained" startIcon={<CallSplitIcon />} disabled={!splitValid} onClick={doSplit}>
                  פצל
                </Button>
              </Stack>
            </>
          )}
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
