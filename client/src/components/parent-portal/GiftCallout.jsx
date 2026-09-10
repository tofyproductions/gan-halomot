import { Card, CardContent, Typography, Stack, Box, Button, Alert } from '@mui/material';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

/**
 * The gift card AS THE FAMILY SEES IT — one component, two callers.
 *
 * The parent's screen renders it for real; the staff's campaign editor renders
 * it as a preview while somebody is still typing the round's details. That is
 * the entire reason it is a component rather than two pieces of markup: a
 * preview built separately is a promise about wording that drifts the first
 * time either side is edited, and the wording is the whole point of the
 * exercise.
 *
 * WHAT IT SAYS, and why. The heading used to be the campaign's name, printed
 * verbatim — so a round the office called "מבצע חנוכה" told families the gan
 * was running a promotion. It is a gift for their child, not a sale. The
 * heading is now built from the occasion alone:
 *
 *     בחירת התמונה למתנת חנוכה
 *
 * Singular, deliberately, even though the family marks two. They are choosing
 * THE photograph that goes on the gift; the second is a spare, because the
 * staff have to fit one to the product and a single pick leaves them no room
 * when it is the wrong shape. Saying "בחרו שתי תמונות" as the headline made
 * families think the gift carried both.
 *
 * Rounds created before the occasion field existed have none, and there the
 * heading falls back to the name — which is exactly what those families were
 * already looking at.
 */

/** "תמונה אחת" reads; "1 תמונות" does not. */
export function photoCount(n) {
  if (n === 1) return 'תמונה אחת';
  if (n === 2) return 'שתי תמונות';
  return `${n} תמונות`;
}

/** The one line at the top of the card. */
export function giftHeadline({ occasion, name }) {
  const word = String(occasion || '').trim();
  return word ? `בחירת התמונה למתנת ${word}` : String(name || 'מתנה');
}

export default function GiftCallout({
  occasion, name, product, deadline, needed = 2, childName,
  open = true, done = false, finalised = false,
  chosenPhotos = [],
  onChoose,
  // A preview on the staff's screen: the same card, with nothing to press.
  preview = false,
}) {
  const loud = open && !done;

  return (
    <Card
      sx={{
        // The whole surface changes, not a stripe down its edge. Loud while
        // something is required of the family, quiet once it is done: a demand
        // that stays loud after it has been met is a demand people learn to
        // ignore.
        bgcolor: loud ? 'warning.light' : 'background.paper',
        borderColor: loud ? '#EFD3A6' : 'divider',
      }}
    >
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 0.75 }}>
          <Box
            sx={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
              display: 'grid', placeItems: 'center',
              bgcolor: done ? 'success.light' : open ? 'primary.main' : 'action.hover',
              color: done ? 'success.dark' : open ? '#fff' : 'text.secondary',
            }}
          >
            {done ? <CheckCircleIcon /> : <CardGiftcardIcon />}
          </Box>
          <Typography variant="h5">{giftHeadline({ occasion, name })}</Typography>
        </Stack>

        {product && (
          <Typography variant="body2" color="text.secondary">
            המתנה השנה: {product}
          </Typography>
        )}

        {open && !done && (
          <>
            <Typography variant="body1" fontWeight={700} sx={{ mt: 1 }}>
              צריך לבחור תמונה של {childName} עד {deadline}.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              אפשר לסמן עד {photoCount(needed)} — הצוות יבחר מתוכן את זו שמתאימה
              למתנה. אם לא תבחרו — הגן יבחר עבורכם.
            </Typography>
            {/* The one primary action on this card, and sized like it. */}
            <Button
              variant="contained" color="primary" size="large"
              startIcon={<CardGiftcardIcon />}
              sx={{ mt: 2, width: { xs: '100%', sm: 'auto' } }}
              disabled={preview}
              onClick={preview ? undefined : onChoose}
            >
              בחירת תמונה
            </Button>
          </>
        )}

        {open && done && (
          <>
            <Typography variant="body2" sx={{ mt: 1 }}>
              הבחירה נשמרה. אפשר לשנות עד {deadline}.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              {chosenPhotos.map(p => (
                <Box key={p.id} component="img" src={p.thumb_url} alt=""
                  sx={{
                    width: 76, height: 76, objectFit: 'cover', borderRadius: '14px',
                    border: '2px solid', borderColor: 'success.main',
                  }} />
              ))}
            </Stack>
            <Button size="small" sx={{ mt: 1 }} disabled={preview} onClick={onChoose}>
              שינוי הבחירה
            </Button>
          </>
        )}

        {!open && (
          <Alert severity="info" sx={{ mt: 1 }}>
            מועד הבחירה הסתיים{finalised ? '. הגן בחר תמונה למתנה.' : '.'}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
