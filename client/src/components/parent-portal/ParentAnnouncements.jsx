import { Card, CardContent, Typography, Stack, Box, Alert, Chip } from '@mui/material';
import CampaignIcon from '@mui/icons-material/Campaign';
import { DISPLAY } from '../../theme/parentTheme';

/**
 * What the gan has said, in full.
 *
 * The home screen carries the newest one and this carries all of them, which
 * is the right split: a parent opening the app wants to know whether anything
 * happened, and once a month wants to find the thing they half-remember about
 * the trip.
 *
 * Nothing here is marked read. A read receipt would tell the gan who has seen
 * an announcement, and the first time that number is looked at somebody will
 * treat "she opened it" as "she was told" — which is a claim about a person
 * that a tap on a screen cannot support. The gan's own record is that it was
 * published; how it reached the family is the manager's job, not the app's.
 */

function formatWhen(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (sameDay) return `היום ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  if (d.toDateString() === yesterday.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
}

/**
 * One announcement.
 *
 * An urgent one is marked, and marked in the SAME place and shape as the rest
 * rather than shouting in red — the gan decides what is urgent and a screen
 * that renders every one of them as an alarm teaches parents to scroll past
 * alarms. `for_my_class` is the more useful flag most days: it is the
 * difference between "the gan is closed" and "bring a coat for the trip".
 */
function Item({ a }) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 0.75 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: '1.0625rem', lineHeight: 1.3 }}
            >
              {a.title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatWhen(a.published_at)}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
            {a.is_urgent && (
              <Chip
                size="small" label="דחוף"
                sx={{
                  fontWeight: 800,
                  bgcolor: (t) => t.playful.coral.bg,
                  color: (t) => t.playful.coral.on,
                }}
              />
            )}
            {a.for_my_class && (
              <Chip
                size="small" label="לכיתה שלנו"
                sx={{
                  fontWeight: 700,
                  bgcolor: (t) => t.playful.teal.bg,
                  color: (t) => t.playful.teal.on,
                }}
              />
            )}
          </Stack>
        </Stack>

        {/* The gan writes in a textarea, so the line breaks they typed are the
            only formatting there is. Without pre-line the whole thing arrives
            as one paragraph and a list of what to bring becomes a sentence. */}
        <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
          {a.body}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function ParentAnnouncements({ announcements = [] }) {
  if (!announcements.length) {
    return (
      <Alert severity="info" icon={<CampaignIcon fontSize="small" />}>
        אין הודעות חדשות מהגן.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      {announcements.map((a, i) => (
        <Box
          key={a.id}
          sx={{
            animation: 'riseIn .4s cubic-bezier(.22,1,.36,1) both',
            animationDelay: `${Math.min(i, 6) * 50}ms`,
          }}
        >
          <Item a={a} />
        </Box>
      ))}
    </Stack>
  );
}
