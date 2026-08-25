import { useState, useEffect } from 'react';
import {
  Stack, Card, CardContent, Typography, Alert, Box, Chip, Button, CircularProgress,
} from '@mui/material';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * לוח החופשות, as a parent needs it.
 *
 * WHAT A PARENT IS ACTUALLY ASKING. Not "what is the year's calendar" — that is
 * a poster on a wall. The question is "do I need childcare on a given day", and
 * the answer has three shapes, so the screen has three shapes:
 *
 *   סגור         — arrange something else for the whole day
 *   פתוח עד …    — arrange something else from that hour
 *   (nothing)    — an ordinary day
 *
 * The next closure is shown first and larger, because that is the one being
 * planned around. Past dates are hidden by default and reachable deliberately:
 * in June, September's dates are noise that buries July's.
 *
 * The colours come from the gan's own published list, so the screen and the
 * printed sheet on the door are recognisably the same document.
 */

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const parseYmd = (s) => new Date(`${s}T12:00:00.000Z`);
const dayName = (s) => DAYS[parseYmd(s).getUTCDay()];
const short = (s) => {
  const d = parseYmd(s);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};

/** '11.9 – 13.9 · שישי–ראשון', or a single day. */
function whenLabel(e) {
  if (e.start === e.end) return `${short(e.start)} · יום ${dayName(e.start)}`;
  return `${short(e.start)} – ${short(e.end)} · ${dayName(e.start)}–${dayName(e.end)}`;
}

const KIND_LABEL = {
  closure: 'הגן סגור',
  employer: 'הגן סגור',
  short_day: 'יום מקוצר',
};

function daysUntil(ymd) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const ms = parseYmd(ymd) - parseYmd(today);
  return Math.round(ms / 86400000);
}

function Row({ entry, highlight }) {
  const c = entry.color || '#64748b';
  const open = entry.kind === 'short_day';
  return (
    <Card
      variant="outlined"
      sx={{
        borderInlineStart: `10px solid ${c}`,
        borderRadius: 3,
        bgcolor: highlight ? `${c}14` : 'background.paper',
      }}
    >
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box
            sx={{
              width: 44, height: 44, borderRadius: '50%', flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, bgcolor: `${c}26`,
            }}
            aria-hidden
          >
            {entry.emoji || '📅'}
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography sx={{ fontWeight: 800, fontSize: highlight ? 20 : 17 }}>
                {entry.name}
              </Typography>
              <Chip
                size="small"
                label={open ? `פתוח עד ${entry.end_time || ''}`.trim() : KIND_LABEL[entry.kind]}
                sx={{
                  fontWeight: 800,
                  bgcolor: open ? 'warning.light' : `${c}26`,
                  color: open ? 'warning.contrastText' : 'text.primary',
                }}
              />
            </Stack>

            <Typography sx={{ mt: 0.25, fontWeight: 700, color: c }}>
              {whenLabel(entry)}
            </Typography>

            {entry.hebrew && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {entry.hebrew}
              </Typography>
            )}
            {entry.note && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>{entry.note}</Typography>
            )}
            {entry.return_note && (
              <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 700, color: c }}>
                {entry.return_note}
              </Typography>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function ParentVacations({ childId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    let alive = true;
    parentApi.get(`/children/${childId}/vacations`)
      .then((res) => { if (alive) setData(res.data); })
      .catch((err) => { if (alive) setError(parentApiError(err, 'שגיאה בטעינת לוח החופשות')); });
    return () => { alive = false; };
  }, [childId]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={28} /></Stack>;

  const list = showPast ? (data.all || []) : (data.entries || []);
  const next = (data.entries || [])[0];
  const away = next ? daysUntil(next.start) : null;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>לוח חופשות</Typography>
        <Typography variant="caption" color="text.secondary">
          שנת הלימודים {data.academic_year}
        </Typography>
      </Box>

      {/* The one fact most visits are for. */}
      {next && away !== null && away >= 0 && (
        <Alert severity={away <= 7 ? 'warning' : 'info'} sx={{ fontWeight: 700 }}>
          {away === 0 && `${next.name} — היום`}
          {away === 1 && `${next.name} — מחר`}
          {away > 1 && `הקרוב: ${next.name}, בעוד ${away} ימים`}
        </Alert>
      )}

      {list.length === 0 && (
        <Alert severity="info">לא נותרו חופשות בשנה זו.</Alert>
      )}

      {list.map((e, i) => (
        <Row key={e.id || `${e.start}-${e.name}`} entry={e} highlight={!showPast && i === 0} />
      ))}

      {!showPast && data.past_count > 0 && (
        <Button variant="text" onClick={() => setShowPast(true)}>
          הצג גם את מה שכבר עבר ({data.past_count})
        </Button>
      )}

      {data.footer && (
        <Alert severity="info" icon={false} sx={{ fontWeight: 700, textAlign: 'center' }}>
          ⭐ {data.footer} ⭐
        </Alert>
      )}
    </Stack>
  );
}
