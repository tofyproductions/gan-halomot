import { useState, useEffect, useMemo } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Button, Alert, Chip,
  TextField, Skeleton, IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import parentApi, { parentApiError } from '../../api/parentClient';
import { DISPLAY } from '../../theme/parentTheme';

/**
 * "היא לא מגיעה מחר."
 *
 * The message this replaces is a WhatsApp to a teacher's private phone at ten
 * past six in the morning, which she reads while opening a room and then has
 * to remember. Here it is on her list before she arrives.
 *
 * DAYS, NOT A DATE PICKER. Illness is "today and tomorrow", not the fourteenth
 * — a native date input on a phone is three taps and a scroll for something a
 * parent wants to do in one. Fourteen chips, today first, tap what applies.
 *
 * IT SAYS PLAINLY THAT NOTHING CHANGES ABOUT THE MONEY. A family reporting a
 * week of illness will otherwise assume the week is not charged, discover in
 * November that it was, and be right to feel misled. One line, on the screen
 * where the assumption is formed.
 */

const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** 'YYYY-MM-DD' → { day: 'שני', date: '18.8' } */
function label(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return { day: DOW[dt.getDay()], date: `${d}.${m}` };
}

/** The fourteen days a parent may report, today first. */
function windowFrom(today, max) {
  const out = [];
  const [y, m, d] = today.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  for (let i = 0; i < 40; i += 1) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    out.push(key);
    if (key === max) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export default function ParentAbsence({ childId, childName }) {
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState([]);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const res = await parentApi.get(`/children/${childId}/absences`);
      setData(res.data);
    } catch (err) {
      setError(parentApiError(err, 'לא הצלחנו לטעון את הדיווחים'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true); setError(''); setData(null); setPicked([]); setReason('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId]);

  const days = useMemo(
    () => (data ? windowFrom(data.today, data.max_date) : []),
    [data],
  );
  const reported = useMemo(
    () => new Set((data?.absences || []).map(a => a.date)),
    [data],
  );

  const toggle = (key) => {
    setSaved(false);
    setPicked(p => (p.includes(key) ? p.filter(x => x !== key) : [...p, key]));
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const res = await parentApi.post(`/children/${childId}/absences`, {
        dates: picked, reason,
      });
      setData(res.data);
      setPicked([]); setReason('');
      setSaved(true);
      setTimeout(() => setSaved(false), 5000);
    } catch (err) {
      setError(parentApiError(err, 'הדיווח נכשל'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (date) => {
    setError('');
    try {
      const res = await parentApi.delete(`/children/${childId}/absences/${date}`);
      setData(res.data);
    } catch (err) {
      setError(parentApiError(err, 'הביטול נכשל'));
    }
  };

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rounded" height={230} sx={{ borderRadius: '20px' }} />
      </Stack>
    );
  }

  return (
    <Stack spacing={2} sx={{ animation: 'riseIn .35s cubic-bezier(.22,1,.36,1) both' }}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {saved && <Alert severity="success">הדיווח נשמר. הצוות יראה אותו ברשימת הבוקר.</Alert>}

      <Card>
        <CardContent>
          <Typography sx={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: '1.15rem' }}>
            {childName} לא מגיע/ה לגן
          </Typography>
          <Typography variant="caption" color="text.secondary">
            אפשר לסמן כמה ימים יחד. הצוות רואה את זה ברשימת הבוקר.
          </Typography>

          <Box
            sx={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
              gap: 0.75, mt: 2,
            }}
          >
            {days.map((key, i) => {
              const l = label(key);
              const already = reported.has(key);
              const on = picked.includes(key);
              return (
                <Box
                  key={key}
                  component="button"
                  type="button"
                  disabled={already}
                  onClick={() => toggle(key)}
                  aria-pressed={on}
                  sx={{
                    border: 2, borderStyle: 'solid', borderRadius: '14px',
                    px: 0.5, py: 1, cursor: already ? 'default' : 'pointer',
                    font: 'inherit', textAlign: 'center', lineHeight: 1.25,
                    // Reported days are shown, not hidden: a parent looking for
                    // Thursday needs to see that Thursday is already handled,
                    // not to find it missing from the row.
                    bgcolor: (t) => {
                      if (already) return t.playful.teal.soft;
                      return on ? t.playful.coral.bg : t.palette.background.paper;
                    },
                    color: (t) => {
                      if (already) return t.playful.teal.softOn;
                      return on ? t.playful.coral.on : t.palette.text.primary;
                    },
                    borderColor: (t) => {
                      if (already) return t.playful.teal.soft;
                      return on ? t.playful.coral.bg : t.palette.divider;
                    },
                    opacity: already ? 0.9 : 1,
                  }}
                >
                  <Box sx={{ fontSize: '0.7rem', opacity: 0.85 }}>
                    {i === 0 ? 'היום' : i === 1 ? 'מחר' : l.day}
                  </Box>
                  <Box sx={{ fontWeight: 800, fontSize: '0.9rem' }}>{l.date}</Box>
                </Box>
              );
            })}
          </Box>

          <TextField
            fullWidth size="small" sx={{ mt: 2 }}
            label="סיבה (לא חובה)"
            placeholder="חום, ביקור רופא, חופשה משפחתית…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            inputProps={{ maxLength: 300 }}
          />

          <Button
            fullWidth variant="contained" sx={{ mt: 2 }}
            disabled={busy || !picked.length}
            onClick={save}
          >
            {busy ? 'שולח…' : picked.length ? `דיווח על ${picked.length} ימים` : 'בחרו ימים'}
          </Button>

          {/* The assumption this line exists to stop is formed right here, at
              the moment of reporting a week of illness. */}
          <Alert severity="info" sx={{ mt: 2 }}>
            הדיווח מיידע את הצוות בלבד. <b>שכר הלימוד אינו משתנה</b> — התשלום הוא על המקום בגן,
            לא על ימי נוכחות.
          </Alert>
        </CardContent>
      </Card>

      {(data?.absences || []).length > 0 && (
        <Card>
          <CardContent>
            <Typography variant="h5" sx={{ mb: 1 }}>דיווחים קרובים</Typography>
            <Stack spacing={1}>
              {data.absences.map((a) => {
                const l = label(a.date);
                const isToday = a.date === data.today;
                return (
                  <Stack
                    key={a.date} direction="row" alignItems="center" spacing={1.5}
                    sx={{ py: 0.5 }}
                  >
                    <Chip
                      size="small" label={`יום ${l.day} · ${l.date}`}
                      sx={{
                        fontWeight: 700,
                        bgcolor: (t) => t.playful.teal.soft,
                        color: (t) => t.playful.teal.softOn,
                      }}
                    />
                    <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
                      {a.reason || 'ללא סיבה'}
                    </Typography>
                    {/* Today's report cannot be withdrawn from here — the
                        teacher has already read the list and planned around
                        it, and a row disappearing behind her is worse than one
                        she has to re-read. */}
                    {isToday ? (
                      <Typography variant="caption" color="text.disabled">היום</Typography>
                    ) : (
                      <IconButton size="small" onClick={() => cancel(a.date)} aria-label="ביטול הדיווח">
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Stack>
                );
              })}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              לביטול דיווח על היום — יש לפנות לגן.
            </Typography>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
