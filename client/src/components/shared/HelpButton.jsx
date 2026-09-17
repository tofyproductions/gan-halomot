import { useState } from 'react';
import {
  IconButton, Tooltip, Drawer, Box, Typography, Stack, Divider, Chip,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useLocation } from 'react-router-dom';
import { screenForPath } from '../../config/screenMeta';
import { helpFor } from '../../config/screenHelp';

/**
 * The "?" in the corner, answering for whichever screen you are on.
 *
 * One button in the shell rather than one per screen: the people who run this
 * system learn a screen by being shown it once, and a year later they use the
 * three parts they were shown. A help button that exists on some screens and
 * not others teaches them to stop looking, so it is in the same corner
 * everywhere, and the content is keyed off the same id the rail and the
 * permission system already use.
 *
 * A drawer rather than a dialog, so the screen stays visible behind it — the
 * question is almost always "what does THIS button do", and an answer that
 * covers the button is an answer read twice.
 *
 * It renders nothing at all on a screen with no help written yet. An empty
 * page under a "?" is worse than no "?", because it is a promise broken at the
 * moment somebody was stuck enough to ask.
 */
export default function HelpButton() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const screen = screenForPath(pathname);
  const help = helpFor(screen.id);

  if (!help) return null;

  return (
    <>
      <Tooltip title="מה אפשר לעשות במסך הזה?">
        <IconButton
          onClick={() => setOpen(true)}
          size="small"
          aria-label="עזרה למסך הנוכחי"
          sx={{ color: 'text.secondary' }}
        >
          <HelpOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Drawer
        anchor="left"
        open={open}
        onClose={() => setOpen(false)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 420 }, p: 0 } }}
      >
        <Box sx={{ p: 2.5, pb: 1.5, position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Box>
              {screen.group && (
                <Typography variant="caption" color="text.disabled">{screen.group}</Typography>
              )}
              <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                {screen.label}
              </Typography>
            </Box>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="סגירה">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
        </Box>
        <Divider />

        <Box sx={{ p: 2.5, pt: 2, overflowY: 'auto' }}>
          <Typography sx={{ mb: 2.5 }}>{help.summary}</Typography>

          {help.can?.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                מה אפשר לעשות כאן
              </Typography>
              <Stack component="ul" sx={{ m: 0, mb: 2.5, pr: 2.5, gap: 0.75 }}>
                {help.can.map((line, i) => (
                  <Typography component="li" variant="body2" key={i}>{line}</Typography>
                ))}
              </Stack>
            </>
          )}

          {help.buttons?.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                מה כל כפתור עושה
              </Typography>
              <Stack spacing={1.25} sx={{ mb: 2.5 }}>
                {help.buttons.map((b, i) => (
                  <Box key={i}>
                    <Chip size="small" label={b.name} sx={{ mb: 0.5, fontWeight: 600 }} />
                    <Typography variant="body2" color="text.secondary">{b.what}</Typography>
                  </Box>
                ))}
              </Stack>
            </>
          )}

          {help.notes?.length > 0 && (
            /* Apart from the lists on purpose: "this sends an email to every
               parent" must not read as one more tip. */
            <Stack spacing={1} sx={{ mb: 2.5 }}>
              {help.notes.map((n, i) => (
                <Stack
                  key={i}
                  direction="row"
                  spacing={1}
                  sx={{
                    p: 1.25,
                    borderRadius: 1,
                    bgcolor: 'warning.light',
                    color: 'warning.contrastText',
                    alignItems: 'flex-start',
                  }}
                >
                  <WarningAmberIcon fontSize="small" sx={{ mt: 0.1 }} />
                  <Typography variant="body2">{n}</Typography>
                </Stack>
              ))}
            </Stack>
          )}

          {help.faq?.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                שאלות שעולות
              </Typography>
              {help.faq.map((f, i) => (
                <Accordion key={i} disableGutters elevation={0} sx={{ '&:before': { display: 'none' } }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{f.q}</Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ px: 0, pt: 0 }}>
                    <Typography variant="body2" color="text.secondary">{f.a}</Typography>
                  </AccordionDetails>
                </Accordion>
              ))}
            </>
          )}
        </Box>
      </Drawer>
    </>
  );
}
