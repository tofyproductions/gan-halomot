import { useState, useEffect } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Alert, Skeleton,
  LinearProgress, Divider, Chip,
} from '@mui/material';
import parentApi, { parentApiError } from '../../api/parentClient';
import { DISPLAY } from '../../theme/parentTheme';

/**
 * What the family owes, on the family's screen.
 *
 * The quiet room of this portal, and deliberately so. Everything else here is
 * the gan — colour, photographs, a teal card saying the baby slept an hour and
 * forty. This is the one screen that is about money, and a debt announced on a
 * violet card with an emoji beside it reads as not being taken seriously by
 * the people asking for it. Same app, one room with the volume down.
 *
 * Read-only, all of it. There is no button here that pays: the server has no
 * route for it (controllers/parentPayments), and the screen is honest about
 * that rather than showing a disabled one.
 *
 * The figures are the bookkeeper's own — services/collection-view computes them
 * once for both screens. A parent reading a different number here than the
 * office reads there is the failure this whole feature exists to avoid.
 */

const SHEKEL = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
});
const money = (n) => SHEKEL.format(Number(n) || 0);

/**
 * How each state is said out loud.
 *
 * `overdue` is "באיחור" and sits in warning amber rather than error red. The
 * word חוב and the colour red are a collections decision the gan has not made,
 * and a screen is a bad place to make one on their behalf — a family two weeks
 * late on a standing order would be told, in red, that they are in debt.
 */
const STATUS = {
  paid: { label: 'שולם', tone: 'success' },
  partial: { label: 'שולם חלקית', tone: 'warning' },
  exempt: { label: 'פטור', tone: 'neutral' },
  overdue: { label: 'באיחור', tone: 'warning' },
  pending: { label: 'טרם התחיל', tone: 'neutral' },
  expected: { label: 'לתשלום', tone: 'plain' },
};

function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('he-IL');
}

/** The status pill. `plain` gets no pill at all — most rows are just "לתשלום". */
function StatusPill({ status }) {
  const s = STATUS[status] || STATUS.expected;
  if (s.tone === 'plain') return null;

  // The label takes the DARK end of the colour on paper and the MAIN end on a
  // dark ground — the `light` slot is the tinted background in both themes, so
  // a single choice fails on one of them. Measured: success.main on
  // success.light came to 4.2:1 at 12px, under the 4.5 a small label needs.
  const tone = (t) => (t.palette.mode === 'dark' ? 'main' : 'dark');
  const sx = {
    success: {
      bgcolor: 'success.light',
      color: (t) => t.palette.success[tone(t)],
    },
    warning: {
      bgcolor: 'warning.light',
      color: (t) => t.palette.warning[tone(t)],
    },
    neutral: { bgcolor: 'action.selected', color: 'text.secondary' },
  }[s.tone];

  return (
    <Chip
      size="small"
      label={s.label}
      sx={{ ...sx, fontWeight: 700, height: 24, fontSize: '0.75rem' }}
    />
  );
}

/**
 * One month.
 *
 * A month before the child started is not a debt of zero — it is a month that
 * was never theirs — so it says so in words and shows no figure. Zero with no
 * explanation looks like a bill somebody forgot to raise.
 */
function MonthRow({ m, isLast }) {
  const before = m.is_before_start;

  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.5,
        py: 1.5, px: m.is_current ? 1.5 : 0,
        mx: m.is_current ? -1.5 : 0,
        borderRadius: m.is_current ? '14px' : 0,
        // The month a parent actually opened the app to see. Marked with the
        // ground rather than a border, so the row still lines up with the
        // others — an outline here made the list look broken.
        bgcolor: m.is_current ? 'action.hover' : 'transparent',
        borderBottom: isLast ? 0 : 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" fontWeight={m.is_current ? 800 : 600}>
            {m.label}
          </Typography>
          {m.is_current && (
            <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 800 }}>
              החודש
            </Typography>
          )}
        </Stack>

        {before ? (
          <Typography variant="caption" color="text.disabled">
            לפני תחילת השנה
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {m.receipt && (
              <Typography variant="caption" color="text.secondary">
                קבלה {m.receipt}
                {m.shared_with_sibling && ' • משותפת'}
              </Typography>
            )}
            {m.paid_at && (
              <Typography variant="caption" color="text.secondary">
                {formatDate(m.paid_at)}
              </Typography>
            )}
            {m.is_prorated && (
              <Typography variant="caption" color="text.secondary">
                חלקי
              </Typography>
            )}
            {m.discount > 0 && (
              <Typography variant="caption" sx={{ color: 'success.main' }}>
                הנחה {money(m.discount)}
              </Typography>
            )}
          </Stack>
        )}
      </Box>

      {!before && (
        <>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: m.status === 'paid' ? 'text.secondary' : 'text.primary',
              textAlign: 'left', flexShrink: 0,
            }}
          >
            {money(m.expected)}
          </Typography>
          <Box sx={{ flexShrink: 0 }}><StatusPill status={m.status} /></Box>
        </>
      )}
    </Box>
  );
}

export default function Payments({ childId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);

    (async () => {
      try {
        const res = await parentApi.get(`/children/${childId}/payments`);
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(parentApiError(err, 'לא הצלחנו לטעון את התשלומים'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [childId]);

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rounded" height={150} sx={{ borderRadius: '20px' }} />
        <Skeleton variant="rounded" height={380} sx={{ borderRadius: '20px' }} />
      </Stack>
    );
  }
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  // The gan has not set this child's fee yet. The screen is not offered at all
  // in that case — ChildDetails leaves the section out — so this is only ever
  // reached by someone holding an old link, and it tells the truth rather than
  // showing a total of zero.
  if (!data.available) {
    return (
      <Alert severity="info">
        {data.reason === 'fee_pending'
          ? 'שכר הלימוד לילד/ה עדיין לא נקבע, ולכן אין מה להציג כאן. הגן יעדכן אתכם.'
          : 'אין נתוני תשלומים לשנה זו.'}
      </Alert>
    );
  }

  const { summary, months, camp, registration_fee: regFee } = data;
  const progress = summary.expected > 0
    ? Math.min(100, Math.round((summary.paid / summary.expected) * 100))
    : 0;
  const settled = summary.remaining === 0;
  const rows = camp ? [...months, camp] : months;

  return (
    <Stack spacing={2} sx={{ animation: 'riseIn .35s cubic-bezier(.22,1,.36,1) both' }}>

      {/* The one number, and how far through the year it is. */}
      <Card>
        <CardContent>
          <Typography variant="caption" color="text.secondary">
            {settled ? `שנת ${data.year_short}` : 'נשאר לתשלום'}
          </Typography>

          <Typography
            sx={{
              fontFamily: DISPLAY, fontWeight: 800,
              fontSize: settled ? '1.5rem' : '2.25rem',
              lineHeight: 1.15, letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
              color: settled ? 'success.main' : 'text.primary',
              mt: 0.25,
            }}
          >
            {settled ? 'הכל שולם' : money(summary.remaining)}
          </Typography>

          <Box sx={{ mt: 2 }}>
            <LinearProgress
              variant="determinate"
              value={progress}
              sx={{
                bgcolor: 'action.selected',
                '& .MuiLinearProgress-bar': { bgcolor: settled ? 'success.main' : 'primary.main' },
              }}
            />
            <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                שולם {money(summary.paid)} מתוך {money(summary.expected)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {summary.months_paid} מתוך {summary.months_billable} חודשים
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>

      {/* Every month of the year, in gan order — September first. A parent who
          can only see what has already fallen due cannot plan, and planning is
          most of why they came here. */}
      <Card>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 0.5 }}>לפי חודש</Typography>
          <Typography variant="caption" color="text.secondary">
            {data.year_label}
          </Typography>

          <Box sx={{ mt: 1.5 }}>
            {rows.map((m, i) => (
              <MonthRow key={m.month} m={m} isLast={i === rows.length - 1} />
            ))}
          </Box>

          {regFee && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Stack direction="row" alignItems="center" gap={1.5}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600}>דמי רישום</Typography>
                  {regFee.receipt && (
                    <Typography variant="caption" color="text.secondary">
                      קבלה {regFee.receipt}{regFee.shared_with_sibling && ' • משותפת'}
                    </Typography>
                  )}
                </Box>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}
                >
                  {money(regFee.amount)}
                </Typography>
                <StatusPill status={regFee.receipt ? 'paid' : 'expected'} />
              </Stack>
            </>
          )}
        </CardContent>
      </Card>

      {/* Said once, at the bottom, and only when it applies. A note repeated on
          every row is a note nobody reads; a receipt in a sibling's name and no
          note at all is a phone call to the office. */}
      {data.has_shared_receipts && (
        <Alert severity="info">
          קבלה המסומנת „משותפת" הופקה על שם אח או אחות — תשלום אחד מכסה את שני הילדים.
        </Alert>
      )}

      <Alert severity="info">
        המסך מציג את הרישום שבידי הגן. לתשלום, לתיקון או לקבלה חתומה — יש לפנות למשרד.
      </Alert>
    </Stack>
  );
}
