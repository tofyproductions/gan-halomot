import { useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
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
 * The section is a link because it is the fastest way back to the group you
 * were working in, and one line of 12px type is a cheap price for that.
 */
export default function Breadcrumb() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const screen = screenForPath(pathname);

  // The tab title lives here rather than in each of 62 screens, so a screen
  // renamed in the rail is renamed in the tab strip on the same commit.
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);

  // The dashboard is the root. Saying "ניהול / לוח בקרה" over the words
  // "לוח בקרה" is the crumb explaining itself.
  if (!screen.known || pathname === '/') return null;

  const openGroup = () => {
    // Nothing to navigate to — a section is a heading, not a screen — so this
    // goes home, where the rail opens that section.
    navigate('/');
  };

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
          <Box
            component="button"
            type="button"
            onClick={openGroup}
            sx={{
              border: 0,
              p: 0,
              bgcolor: 'transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              color: 'inherit',
              '&:hover': { color: 'text.secondary', textDecoration: 'underline' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            {screen.group}
          </Box>
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
