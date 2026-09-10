import { useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { screenForPath, titleForPath } from '../../config/screenMeta';

/**
 * Where you are, in two words, and what the browser tab says.
 *
 * Both come from the same place (config/screenMeta) and both exist for the
 * same reason: the rail shows one section at a time now, so "which part of the
 * system am I in" stopped being visible on screen — and it was never visible
 * in the tab strip, where all 72 screens said "גן החלומות - ניהול חכם" and an
 * office with eleven tabs open found the right one by clicking through them.
 *
 * The section is NOT a link. It was one, and it navigated to the dashboard —
 * because a section is a heading in the rail and has no page of its own — so
 * the underline promised a destination the click did not deliver. A crumb that
 * lies about where it goes is worse than a crumb that goes nowhere; this one
 * just says where you are, which is the whole job.
 */
export default function Breadcrumb() {
  const { pathname } = useLocation();
  const screen = screenForPath(pathname);

  // The tab title lives here rather than in each of 62 screens, so a screen
  // renamed in the rail is renamed in the tab strip on the same commit.
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);

  // The dashboard is the root. Saying "ניהול / לוח בקרה" over the words
  // "לוח בקרה" is the crumb explaining itself.
  if (!screen.known || pathname === '/') return null;

  return (
    <Box
      component="nav"
      aria-label="מיקום"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        mb: 1.25,
        fontSize: '0.75rem',
        color: 'text.disabled',
      }}
    >
      {screen.group && (
        <>
          <Box component="span">{screen.group}</Box>
          <Box component="span" aria-hidden>/</Box>
        </>
      )}

      <Typography component="span" sx={{ fontSize: 'inherit', color: 'text.secondary', fontWeight: 600 }}>
        {screen.label}
      </Typography>

      {screen.suffix && (
        <>
          <Box component="span" aria-hidden>/</Box>
          <Typography component="span" sx={{ fontSize: 'inherit' }}>{screen.suffix}</Typography>
        </>
      )}
    </Box>
  );
}
