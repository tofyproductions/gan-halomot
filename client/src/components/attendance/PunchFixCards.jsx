import { useState } from 'react';
import {
  Stack, Typography, TextField, Button, Chip, ToggleButton, ToggleButtonGroup,
} from '@mui/material';

/**
 * The fix editors for one punch problem day — shared by the employee's popup
 * (she fixes her own day) and the manager's popup (she fixes it for her).
 * Spec: docs/superpowers/specs/2026-09-27-punch-followup-design.md
 */
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const dayLabel = (ymd) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `יום ${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};
export const KIND_TITLE = { missing: 'חסרה החתמה', duplicate: 'החתמה כפולה', empty_day: 'יום ללא החתמות' };

export function MissingCard({ issue, onSend, busy }) {
  const p = issue.punches.find(x => x.counted);
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const what = p?.state === 0 ? 'נרשמה כניסה' : p?.state === 1 ? 'נרשמה יציאה' : 'נרשמה החתמה אחת';
  const missing = p?.state === 0 ? 'שעת היציאה' : p?.state === 1 ? 'שעת הכניסה' : 'השעה החסרה';
  return (
    <Stack spacing={1}>
      <Typography variant="body2">{what} ב-{p?.hhmm}. מה {missing}?</Typography>
      <Stack direction="row" spacing={1}>
        <TextField size="small" type="time" label={missing} value={time}
          onChange={e => setTime(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ minWidth: 140 }} />
        <TextField size="small" label="הערה (לא חובה)" value={note} onChange={e => setNote(e.target.value)} fullWidth />
      </Stack>
      <Button variant="contained" size="small" disabled={busy || !time}
        onClick={() => onSend({ time, note })}>שליחה לאישור</Button>
    </Stack>
  );
}

export function DuplicateCard({ issue, onSend, busy }) {
  const counted = issue.punches.filter(x => x.counted);
  const [roles, setRoles] = useState(() => Object.fromEntries(counted.map((p, i) => [
    p.id, i === 0 ? 'in' : i === counted.length - 1 ? 'out' : 'ignore',
  ])));
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        נרשמו {counted.length} החתמות. סמני ליד כל אחת מה היא הייתה:
      </Typography>
      {counted.map(p => (
        <Stack key={p.id} direction="row" spacing={1} alignItems="center">
          <Chip label={p.hhmm} size="small" sx={{ minWidth: 64 }} />
          <ToggleButtonGroup size="small" exclusive value={roles[p.id]}
            onChange={(_e, v) => v && setRoles(r => ({ ...r, [p.id]: v }))}>
            <ToggleButton value="in">כניסה</ToggleButton>
            <ToggleButton value="out">יציאה</ToggleButton>
            <ToggleButton value="ignore">בטעות</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      ))}
      <Button variant="contained" size="small" disabled={busy}
        onClick={() => onSend({ labels: counted.map(p => ({ punch_id: p.id, role: roles[p.id] })) })}>
        שליחה לאישור
      </Button>
    </Stack>
  );
}

export function EmptyDayCard({ issue, onSend, busy, onRequest, forManager = false }) {
  const [mode, setMode] = useState(null); // 'worked' | 'not'
  const [inT, setInT] = useState(issue.schedule?.start || '');
  const [outT, setOutT] = useState(issue.schedule?.end || '');
  const [text, setText] = useState('');
  const [other, setOther] = useState(false);
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        לא נמצאו החתמות
        {issue.schedule ? ` (לפי ההתחייבות: ${issue.schedule.start}–${issue.schedule.end})` : ''}.
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button size="small" variant={mode === 'worked' ? 'contained' : 'outlined'} onClick={() => setMode('worked')}>{forManager ? 'עבדה' : 'עבדתי'}</Button>
        <Button size="small" variant={mode === 'not' ? 'contained' : 'outlined'} onClick={() => setMode('not')}>{forManager ? 'לא עבדה' : 'לא עבדתי'}</Button>
      </Stack>
      {mode === 'worked' && (
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField size="small" type="time" label="כניסה" value={inT} onChange={e => setInT(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" type="time" label="יציאה" value={outT} onChange={e => setOutT(e.target.value)} InputLabelProps={{ shrink: true }} />
          <Button variant="contained" size="small" disabled={busy || !inT || !outT}
            onClick={() => onSend({ action: 'worked', in_time: inT, out_time: outT })}>שליחה</Button>
        </Stack>
      )}
      {mode === 'not' && (
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {onRequest && (
              <>
                <Button size="small" variant="outlined" onClick={() => onRequest('sick', issue.date)}>מחלה</Button>
                <Button size="small" variant="outlined" onClick={() => onRequest('vacation', issue.date)}>חופשה</Button>
              </>
            )}
            {/*
              For a MANAGER, this is a decision and it finishes here.

              She pressed "לא עבדה" and the only thing on the card was a
              button reading "רשום סיבה" — which looks like an optional
              extra, not the next step. So she stopped, and the day stayed
              open with nothing that looked like a confirmation. Now the
              confirmation is the confirmation, and the reason is what it
              always should have been: something she may add.

              The employee's side is unchanged. Her explanation IS the
              action, so for her the text is still the way through.
            */}
            {!onRequest && (
              <Button
                size="small" variant="contained" color="primary" disabled={busy}
                onClick={() => onSend({ action: 'other', text: text.trim() })}
              >
                {busy ? 'שומר…' : 'אישור — לא עבדה'}
              </Button>
            )}
            <Button size="small" variant={other ? 'contained' : 'outlined'} onClick={() => setOther(v => !v)}>
              {onRequest ? 'אחר' : 'הוספת סיבה'}
            </Button>
          </Stack>
          {other && (
            <Stack direction="row" spacing={1}>
              <TextField
                size="small" label="מה קרה?" value={text}
                onChange={e => setText(e.target.value)} fullWidth
              />
              <Button
                variant="contained" size="small"
                disabled={busy || (Boolean(onRequest) && !text.trim())}
                onClick={() => onSend({ action: 'other', text: text.trim() })}
              >
                שליחה
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}
