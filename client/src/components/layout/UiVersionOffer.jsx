import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Box, Stack,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SettingsIcon from '@mui/icons-material/Settings';
import { useUiVersion } from '../../hooks/useUiVersion';

/**
 * The one time each person is asked whether to move to the new interface.
 *
 * Shown once per ACCOUNT, not once per browser, and it is a question rather
 * than an announcement: the answer is written to the user record either way,
 * so neither answer brings it back.
 *
 * Both answers are reversible and the dialog says so before it is answered,
 * not after. Somebody deciding whether to change the tool they run four gans
 * on should be told what the way back is at the moment they decide, not
 * discover afterwards that they are stuck. "לא עכשיו" is not "never": it
 * leaves the old interface in place and leaves the door in settings.
 */
export default function UiVersionOffer() {
  const { shouldOffer, switchTo, declineOffer } = useUiVersion();
  const [busy, setBusy] = useState(false);

  if (!shouldOffer) return null;

  const accept = async () => { setBusy(true); await switchTo('new'); setBusy(false); };
  const decline = async () => { setBusy(true); await declineOffer(); setBusy(false); };

  return (
    <Dialog
      open
      dir="rtl"
      maxWidth="xs"
      fullWidth
      // Not dismissible by clicking away: an unanswered question would come
      // back on the next login, which is exactly what "ask once" forbids.
      disableEscapeKeyDown
      onClose={(_e, reason) => { if (reason !== 'backdropClick') decline(); }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <AutoAwesomeIcon color="primary" />
        <Box>
          עיצוב חדש למערכת
          <Typography variant="caption" component="div" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            רוצה לעבור אליו?
          </Typography>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Stack spacing={1.5}>
          <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
            המערכת קיבלה עיצוב חדש: תפריט צד שמחזיק את כל המסכים במקום אחד,
            חיפוש מסכים, וטבלאות נוחות יותר לקריאה.
          </Typography>

          <Box sx={{
            p: 1.5, borderRadius: 2, bgcolor: 'action.hover',
            display: 'flex', gap: 1, alignItems: 'flex-start',
          }}>
            <SettingsIcon fontSize="small" sx={{ mt: 0.25, color: 'text.secondary' }} />
            <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
              <b>אפשר לחזור לעיצוב הישן בכל רגע</b> — דרך "חשבון והגדרות",
              באותו מקום שבו מחליפים גם בכיוון השני. שום דבר לא נמחק ושום נתון
              לא משתנה, זו רק התצוגה.
            </Typography>
          </Box>

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            אם תבחר/י "לא עכשיו" — נשארים בעיצוב הנוכחי, ותמיד אפשר לעבור
            מאוחר יותר מההגדרות.
          </Typography>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={decline} disabled={busy}>לא עכשיו</Button>
        <Button onClick={accept} variant="contained" disabled={busy} autoFocus>
          {busy ? 'רגע…' : 'כן, לעבור לעיצוב החדש'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
