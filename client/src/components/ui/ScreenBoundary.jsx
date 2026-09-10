import { Component } from 'react';
import { Box, Typography, Button, Alert } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

/**
 * What happens when a screen's code does not arrive.
 *
 * Every screen is its own download now (App.jsx), which is why the app starts
 * in a fifth of the bytes — and it introduced a failure this app had never had.
 * In a gan with bad wifi, or in a tab left open across a deploy that replaced
 * the hashed chunk filenames, `import()` rejects. Without a boundary that
 * rejection unmounts the tree: a white screen, no message.
 *
 * Worse, and the reason a plain boundary is not enough: React CACHES the
 * rejected promise for that lazy component. Navigating away and back re-throws
 * the same failure forever. The only real recovery is a reload, so that is what
 * the button does — this is one of the few places where reloading the page is
 * the correct answer rather than an admission of defeat.
 *
 * A class, because React only offers error boundaries as classes.
 */
export default class ScreenBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    // A new route is a new chance. Without this, one failed screen would leave
    // the boundary showing its error over every subsequent screen.
    if (prev.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A chunk that did not load is a different problem from a component that
    // threw, and the person in front of it can act on the first one.
    const isChunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i
      .test(String(error?.message || ''));
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    return (
      <Box sx={{ maxWidth: 560, py: { xs: 4, md: 6 } }}>
        <Typography component="h1" sx={{ fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.015em' }}>
          {isChunk ? 'המסך לא הצליח להיטען' : 'משהו נשבר במסך הזה'}
        </Typography>

        <Typography sx={{ color: 'text.secondary', mt: 1, lineHeight: 1.6 }}>
          {offline
            ? 'אין חיבור לאינטרנט. המסכים נטענים לפי הצורך, ולכן צריך חיבור כדי לפתוח מסך שעוד לא נפתח במכשיר הזה.'
            : isChunk
              ? 'ייתכן שהחיבור נפל באמצע, או שיצאה גרסה חדשה בזמן שהעמוד היה פתוח. רענון יטען את הגרסה העדכנית.'
              : 'שום דבר לא נשמר ולא נמחק. רענון יחזיר את המסך למצב תקין.'}
        </Typography>

        <Alert severity="info" sx={{ mt: 2, fontSize: '0.8125rem' }}>
          שאר המערכת עובדת — אפשר לעבור למסך אחר מהתפריט בלי לרענן.
        </Alert>

        <Button
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={() => window.location.reload()}
          sx={{ mt: 2.5 }}
        >
          רענון העמוד
        </Button>

        {import.meta.env?.DEV && (
          <Box component="pre" sx={{
            mt: 3, p: 1.5, borderRadius: 1.5, bgcolor: 'background.sunken',
            fontSize: '0.75rem', direction: 'ltr', textAlign: 'left',
            overflowX: 'auto', color: 'text.secondary',
          }}>
            {String(error?.stack || error?.message || error)}
          </Box>
        )}
      </Box>
    );
  }
}
