import { useEffect } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import HomeIcon from '@mui/icons-material/Home';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';

/**
 * A URL that is not a screen.
 *
 * What happened before: `<Route path="*" element={<Navigate to="/" />} />` —
 * a silent bounce to the dashboard. Somebody following a stale link from an
 * email, or a bookmark to a screen that has since been renamed, simply arrived
 * at the dashboard and concluded the link was fine and the system had lost
 * their data. A wrong address should say it is a wrong address.
 *
 * It renders INSIDE the shell, so the rail is there and the way out is a
 * click. A 404 that also strands you is two problems.
 *
 * Note on the fresh-tab case: AppShell's FreshEntryGate sends a brand-new tab
 * to `/` before this can render, deliberately — a stranger opening a stale
 * deep link on a shared office machine should land on the dashboard rather
 * than anywhere else. So this is the in-session case: a bad link clicked while
 * already working.
 */
export default function NotFound() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => { document.title = 'לא נמצא · גן החלומות'; }, []);

  return (
    <Box sx={{ maxWidth: 560, py: { xs: 4, md: 8 } }}>
      <Typography sx={{ fontSize: '2.5rem', fontWeight: 600, letterSpacing: '-0.03em', color: 'text.disabled', lineHeight: 1 }}>
        404
      </Typography>

      <Typography component="h1" sx={{ fontSize: '1.5rem', fontWeight: 700, mt: 1.5, letterSpacing: '-0.015em' }}>
        הכתובת הזאת לא קיימת במערכת
      </Typography>

      <Typography sx={{ color: 'text.secondary', mt: 1, lineHeight: 1.6 }}>
        יכול להיות שהמסך הזה שינה שם, שהקישור הגיע ממייל ישן, או שנפלה טעות בהקלדה.
        שום דבר לא נמחק — פשוט אין כאן דף כזה.
      </Typography>

      <Box
        component="code"
        sx={{
          display: 'block',
          mt: 2,
          px: 1.5,
          py: 1,
          borderRadius: 1.5,
          bgcolor: 'background.sunken',
          border: '1px solid',
          borderColor: 'divider',
          fontSize: '0.8125rem',
          color: 'text.secondary',
          direction: 'ltr',
          textAlign: 'left',
          overflowWrap: 'anywhere',
        }}
      >
        {pathname}
      </Box>

      <Box sx={{ display: 'flex', gap: 1, mt: 3, flexWrap: 'wrap' }}>
        <Button variant="contained" startIcon={<HomeIcon />} onClick={() => navigate('/')}>
          ללוח הבקרה
        </Button>
        <Button variant="outlined" startIcon={<ArrowForwardIcon />} onClick={() => navigate(-1)}>
          חזרה למסך הקודם
        </Button>
      </Box>

      <Typography sx={{ color: 'text.disabled', fontSize: '0.8125rem', mt: 2.5 }}>
        כל המסכים שיש לך הרשאה אליהם נמצאים בתפריט מימין.
      </Typography>
    </Box>
  );
}
