import { useState, useEffect } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Skeleton, ButtonBase, Chip,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import parentApi from '../../api/parentClient';
import { DISPLAY, INSET } from '../../theme/parentTheme';

/**
 * The screen a parent lands on, and the only one most of them will read.
 *
 * It is not a menu. A menu is what the portal had — four sections, all equally
 * important, none of them about today — and the thing the parent came for was
 * always one tap further in. This assembles itself out of the state the gan is
 * actually in: what happened this morning, what was photographed this
 * afternoon, and which month is open for payment.
 *
 * IT CHANGES WITH THE CHILD'S AGE, and that is the whole point rather than a
 * refinement. An infant's parent opens this several times a day for the day
 * itself, so the day is first. A five-year-old's parent has no bottle log to
 * read — showing them an empty one, or a card that says "not yet updated" for
 * a room that keeps no board, is worse than showing nothing. For them the
 * photographs lead.
 *
 * Every card here is a door. Nothing on this screen is the only place its
 * information lives, so a card that fails to load costs a parent a tap, never
 * the information.
 */

const SHEKEL = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
});
const money = (n) => SHEKEL.format(Number(n) || 0);

/** 'יום ב׳, 17 באוגוסט' — the date as somebody would say it. */
function todayLine() {
  const d = new Date();
  const day = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת'][d.getDay()];
  const rest = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  return `יום ${day}, ${rest}`;
}

/**
 * A card that opens a section.
 *
 * ButtonBase rather than a div with onClick: it is a real button, so it takes
 * keyboard focus, announces itself, and shows the press.
 */
function DoorCard({ onClick, label, children, sx }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label={label}
      sx={{
        display: 'block', width: '100%', textAlign: 'start',
        borderRadius: '20px',
        transition: 'transform .18s ease',
        '&:active': { transform: 'scale(0.985)' },
        ...sx,
      }}
    >
      {children}
    </ButtonBase>
  );
}

/** The small "more" chevron. Points left, because the page runs right to left. */
function More({ text, color = 'text.secondary' }) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.25} sx={{ color }}>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>{text}</Typography>
      <ChevronLeftIcon sx={{ fontSize: 16 }} />
    </Stack>
  );
}

/**
 * The three figures from the infant board, as headlines.
 *
 * Deliberately not the whole board — that is what the day section is for. What
 * a parent checks between meetings is whether the child ate, slept and was
 * changed, and those are the three that fit across a phone.
 */
function statsFrom(log) {
  const meals = log?.meals || {};
  const sleep = log?.sleep || {};

  const ate = ['breakfast', 'lunch', 'snack']
    .map(k => meals[k]?.amount)
    .filter(Boolean);

  const napMinutes = ['morning', 'noon'].reduce((total, k) => {
    const nap = sleep[k] || {};
    if (!nap.start || !nap.end) return total;
    const [sh, sm] = nap.start.split(':').map(Number);
    const [eh, em] = nap.end.split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return total;
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return total + (mins > 0 ? mins : 0);
  }, 0);

  const napLabel = napMinutes > 0
    ? `${Math.floor(napMinutes / 60)}:${String(napMinutes % 60).padStart(2, '0')}`
    : null;

  return [
    // The portion, and which meal it was. "חצי מנה" under "2 ארוחות" read as
    // a claim that half a portion is two meals; the figure and its label have
    // to be about the same thing.
    {
      value: ate.length ? ate[ate.length - 1] : null,
      label: ate.length > 1 ? 'ארוחה אחרונה' : 'ארוחה',
    },
    { value: napLabel, label: 'שינה' },
    { value: log?.diapers || null, label: 'יציאות' },
  ];
}

/**
 * The day, in teal.
 *
 * The one loud card on the screen, and it earns it: this is what an infant's
 * parent opened the app for. Colour rather than a heading does the work of
 * saying "start here" — on a phone the eye reaches a filled block before it
 * reads anything.
 */
function TodayCard({ day, childName, onOpen }) {
  const log = day?.log;
  const absent = log?.attendance === 'חסר';
  const stats = statsFrom(log);
  const recorded = stats.some(s => s.value) || absent;

  return (
    <DoorCard onClick={onOpen} label={`היום של ${childName}`}>
      <Card
        sx={{
          border: 0,
          bgcolor: (t) => t.playful.teal.bg,
          color: (t) => t.playful.teal.on,
        }}
      >
        <CardContent>
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 1.5 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: '1.15rem', lineHeight: 1.25 }}>
                {absent ? `${childName} לא היה/תה היום בגן` : `היום של ${childName}`}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.92 }}>{todayLine()}</Typography>
            </Box>
            <More text="הכל" color="inherit" />
          </Stack>

          {absent ? (
            <Typography variant="body2" sx={{ opacity: 0.9 }}>
              הצוות סימן היעדרות. יש לפנות לגן אם זו טעות.
            </Typography>
          ) : recorded ? (
            <Stack direction="row" spacing={1}>
              {stats.map((s) => (
                <Box
                  key={s.label}
                  sx={{
                    flex: 1, minWidth: 0, textAlign: 'center',
                    px: 0.75, py: 1.25, borderRadius: '14px',
                    bgcolor: INSET,
                  }}
                >
                  <Typography
                    sx={{ fontWeight: 800, fontSize: '0.95rem', lineHeight: 1.2 }}
                    noWrap
                  >
                    {s.value || '—'}
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.92, fontSize: '0.72rem' }}>
                    {s.label}
                  </Typography>
                </Box>
              ))}
            </Stack>
          ) : (
            // Not an error, and it must not look like one. The morning is
            // simply still going on.
            <Typography variant="body2" sx={{ opacity: 0.9 }}>
              הצוות עוד לא עדכן היום. אפשר לשלוח להם איך היה הבוקר בבית.
            </Typography>
          )}

          {log?.updated_at && (
            <Typography variant="caption" sx={{ display: 'block', mt: 1.25, opacity: 0.9 }}>
              עודכן {new Date(log.updated_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
            </Typography>
          )}
        </CardContent>
      </Card>
    </DoorCard>
  );
}

/**
 * The newest photographs, as a strip.
 *
 * Only the child's own — the classroom gallery has other people's children in
 * it and belongs behind a deliberate tap, not on the screen that opens by
 * itself.
 */
function PhotosCard({ photos, onOpen }) {
  const shown = photos.slice(0, 3);

  return (
    <DoorCard onClick={onOpen} label="תמונות">
      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" sx={{ mb: 1.25 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h5">תמונות</Typography>
              <Typography variant="caption" color="text.secondary">
                {photos.length} מהתקופה האחרונה
              </Typography>
            </Box>
            <More text="לגלריה" />
          </Stack>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.75 }}>
            {shown.map((p) => (
              <Box
                key={p.id || p.url}
                component="img"
                src={p.thumb_url || p.url}
                alt=""
                loading="lazy"
                sx={{
                  width: '100%', aspectRatio: '1', objectFit: 'cover',
                  borderRadius: '12px', display: 'block',
                  bgcolor: 'action.hover',
                }}
              />
            ))}
          </Box>
        </CardContent>
      </Card>
    </DoorCard>
  );
}

/**
 * Money, quietly.
 *
 * The only card on this screen with no colour of its own. Everything around it
 * is the gan; this is the office, and it is the one subject where looking
 * playful costs the gan credibility. See Payments.jsx — same reasoning, same
 * restraint.
 */
function PaymentsCard({ payments, onOpen }) {
  const { summary, months, current_month: current } = payments;
  const settled = summary.remaining === 0;
  const currentMonth = months.find(m => m.month === current);

  return (
    <DoorCard onClick={onOpen} label="תשלומים">
      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                {settled ? `תשלומים • ${payments.year_short}` : 'נשאר לתשלום'}
              </Typography>
              <Typography
                sx={{
                  fontFamily: DISPLAY, fontWeight: 800,
                  fontSize: settled ? '1.15rem' : '1.5rem',
                  lineHeight: 1.2, letterSpacing: '-0.02em',
                  fontVariantNumeric: 'tabular-nums',
                  color: settled ? 'success.main' : 'text.primary',
                }}
              >
                {settled ? 'הכל שולם' : money(summary.remaining)}
              </Typography>
            </Box>

            {currentMonth && !settled && (
              <Chip
                size="small"
                label={currentMonth.status === 'paid'
                  ? `${currentMonth.label} שולם`
                  : `${currentMonth.label} פתוח`}
                sx={{
                  fontWeight: 700, mx: 1,
                  bgcolor: currentMonth.status === 'paid' ? 'success.light' : 'warning.light',
                  color: currentMonth.status === 'paid' ? 'success.main' : 'warning.main',
                }}
              />
            )}
            <More text="לפירוט" />
          </Stack>
        </CardContent>
      </Card>
    </DoorCard>
  );
}

/**
 * @param payments  Already fetched by ChildDetails, which needs the same answer
 *                  to decide whether to offer the section at all. Passed down
 *                  rather than fetched again: two requests for one screen, on a
 *                  phone, on a server that may have just woken up.
 */
export default function ParentHome({ childId, childName, isNursery, photos = [], payments = null, onOpen }) {
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(isNursery);

  useEffect(() => {
    if (!isNursery) { setDay(null); setLoading(false); return undefined; }

    let cancelled = false;
    setLoading(true);
    setDay(null);

    (async () => {
      // A summary of a screen that exists in full one tap away, so it is
      // allowed to fail quietly: the card is left out rather than replaced by
      // an error the parent can do nothing about.
      const d = await parentApi.get(`/children/${childId}/day`).catch(() => null);
      if (cancelled) return;
      setDay(d?.data || null);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [childId, isNursery]);

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rounded" height={150} sx={{ borderRadius: '20px' }} />
        <Skeleton variant="rounded" height={190} sx={{ borderRadius: '20px' }} />
        <Skeleton variant="rounded" height={88} sx={{ borderRadius: '20px' }} />
      </Stack>
    );
  }

  // The order IS the design. An infant's day leads; for an older child there
  // is no day to lead with and the photographs take the top of the screen
  // rather than sitting under a gap where a card used to be.
  const cards = [];
  if (isNursery) {
    cards.push(
      <TodayCard key="day" day={day} childName={childName} onOpen={() => onOpen('day')} />,
    );
  }
  if (photos.length) {
    cards.push(<PhotosCard key="photos" photos={photos} onOpen={() => onOpen('photos')} />);
  }
  if (payments) {
    cards.push(<PaymentsCard key="pay" payments={payments} onOpen={() => onOpen('payments')} />);
  }

  return (
    <Stack spacing={2}>
      {cards.map((card, i) => (
        <Box
          key={card.key}
          sx={{
            animation: 'riseIn .4s cubic-bezier(.22,1,.36,1) both',
            animationDelay: `${i * 60}ms`,
          }}
        >
          {card}
        </Box>
      ))}
    </Stack>
  );
}
