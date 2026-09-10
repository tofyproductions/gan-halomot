import { createTheme } from '@mui/material/styles';
import createCache from '@emotion/cache';
import { COLOR, MOTION, TYPE } from './tokens';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';

export const cacheRtlClassic = createCache({
  key: 'muirtlclassic',
  stylisPlugins: [prefixer, rtlPlugin],
});

const theme = createTheme({
  direction: 'rtl',
  typography: {
    fontFamily: '"Assistant", "Varela Round", "Heebo", sans-serif',
    h1: { fontFamily: '"Varela Round", sans-serif', fontWeight: 900 },
    h2: { fontFamily: '"Varela Round", sans-serif', fontWeight: 800 },
    h3: { fontWeight: 700 },
    h4: { fontWeight: 700, fontSize: '1.4rem' },
    h5: { fontWeight: 800, fontSize: '1.25rem' },
    h6: { fontWeight: 700, fontSize: '1.1rem' },
    button: { fontWeight: 700 },
    subtitle1: { fontWeight: 600, fontSize: '0.95rem' },
    subtitle2: { fontWeight: 700, fontSize: '0.85rem' },
    caption: { fontSize: '0.78rem', lineHeight: 1.4 },
  },
  palette: {
    primary: { main: '#f59e0b', light: '#fbbf24', dark: '#d97706', contrastText: '#fff' },
    secondary: { main: '#6366f1', light: '#818cf8', dark: '#4f46e5' },
    success: { main: '#10b981', light: '#d1fae5', dark: '#059669' },
    warning: { main: '#f59e0b', light: '#fef3c7', dark: '#d97706' },
    error: { main: '#ef4444', light: '#fee2e2', dark: '#dc2626' },
    info: { main: '#3b82f6', light: '#dbeafe', dark: '#2563eb' },
    background: { default: '#f8fafc', paper: '#ffffff' },
    text: { primary: '#1e293b', secondary: '#64748b' },
    divider: '#e2e8f0',
  },
  shape: { borderRadius: 12 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          textTransform: 'none',
          fontWeight: 700,
          padding: '8px 20px',
          fontSize: '0.875rem',
          minHeight: 40,
        },
        containedPrimary: {
          background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
          boxShadow: '0 2px 8px rgba(245,158,11,0.25)',
          '&:hover': {
            background: 'linear-gradient(135deg, #f59e0b, #d97706)',
            boxShadow: '0 4px 12px rgba(245,158,11,0.35)',
          },
        },
        outlined: {
          borderWidth: '1.5px',
          '&:hover': { borderWidth: '1.5px' },
        },
        sizeSmall: { padding: '5px 14px', fontSize: '0.8rem', minHeight: 32 },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          '@media (max-width: 600px)': { padding: 10 },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
          border: '1px solid #f1f5f9',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: '#e2e8f0', borderRadius: 12 },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: { '& .MuiOutlinedInput-root': { borderRadius: 10 } },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            backgroundColor: '#f8fafc',
            color: '#475569',
            fontWeight: 700,
            fontSize: '0.8rem',
            letterSpacing: '0.01em',
            borderBottom: '2px solid #e2e8f0',
            whiteSpace: 'nowrap',
            padding: '10px 12px',
          },
        },
      },
    },
    MuiTableBody: {
      styleOverrides: {
        root: {
          '& .MuiTableRow-root': {
            '&:nth-of-type(even)': { backgroundColor: '#fafbfc' },
            '&:hover': { backgroundColor: '#f1f5f9' },
            transition: 'background-color 0.15s ease',
          },
          '& .MuiTableCell-root': {
            padding: '8px 12px',
            fontSize: '0.85rem',
            borderBottom: '1px solid #f1f5f9',
          },
        },
      },
    },
    MuiTableContainer: {
      styleOverrides: {
        root: { borderRadius: 12, border: '1px solid #e2e8f0' },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, fontSize: '0.78rem' },
        sizeSmall: { height: 24, fontSize: '0.72rem' },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10, fontSize: '0.85rem' },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 16 },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: { fontSize: '1.15rem', fontWeight: 800, paddingBottom: 8 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 700,
          fontSize: '0.9rem',
          minHeight: 44,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { fontSize: '0.8rem', borderRadius: 8, padding: '6px 12px' },
      },
    },
  },
});

/**
 * The classic theme has to answer the same questions the new one does.
 *
 * The redesign was not only a shell and a colour scheme: roughly thirty screens
 * were rebuilt during it and now read `theme.motion`, `theme.figure`, the soft
 * colour pairs, `background.sunken`, `palette.row` and the rest. Those screens
 * are SHARED — there is one גבייה, one החתמות, one רישום חיצוני — so under the
 * classic shell they render against this theme, and a missing key is not a
 * missing style: `t.motion.fast` on a theme without `motion` throws, and the
 * screen goes to the error boundary. That is exactly what happened the first
 * time this ran.
 *
 * So the classic theme keeps its own LOOK — its colours, its typography, its
 * component overrides, all untouched above — and gains the vocabulary the
 * shared screens speak. What it does not do is repaint itself: `primary` here
 * is still the classic primary, and only the keys the old theme never had are
 * filled in.
 *
 * `createTheme` a second time rather than mutating: the first call has already
 * resolved the palette, and augmenting the result in place would skip the
 * channel/contrast computation MUI does for anything colour-shaped.
 */
const classicTheme = createTheme(theme, {
  palette: {
    // Soft pairs, measured for contrast in tokens.js. The old theme had no
    // notion of a "soft" fill, and chips, tinted rows and StatBoard all ask
    // for one now.
    primary: { soft: COLOR.primary.soft, softOn: COLOR.primary.softOn },
    secondary: { soft: COLOR.info.soft, softOn: COLOR.info.softOn },
    success: { soft: COLOR.success.soft, softOn: COLOR.success.softOn },
    warning: { soft: COLOR.warning.soft, softOn: COLOR.warning.softOn },
    error: { soft: COLOR.error.soft, softOn: COLOR.error.softOn },
    info: { soft: COLOR.info.soft, softOn: COLOR.info.softOn },

    // Surfaces below the page. The classic background stays what it was; these
    // are the two sunken bands the rebuilt tables and headers sit on.
    background: {
      sunken: COLOR.background.sunken,
      sunkenDeep: COLOR.background.sunkenDeep,
    },
    text: { muted: COLOR.text.muted },
    dividerStrong: COLOR.dividerStrong,

    // A row that needs somebody, and the rail's own ink. `sidebar` is only
    // read by the new shell, which never renders under this theme — but a
    // component that reads a missing palette branch resolves to the raw string
    // and paints garbage, and this file is the cheaper place to be safe.
    row: COLOR.row,
    sidebar: COLOR.sidebar,
  },

  motion: {
    instant: `${MOTION.duration.instant}ms ${MOTION.easing.standard}`,
    fast: `${MOTION.duration.fast}ms ${MOTION.easing.standard}`,
    base: `${MOTION.duration.base}ms ${MOTION.easing.enter}`,
    slow: `${MOTION.duration.slow}ms ${MOTION.easing.enter}`,
    exit: `${MOTION.duration.fast}ms ${MOTION.easing.exit}`,
    duration: MOTION.duration,
    easing: MOTION.easing,
  },

  figure: {
    hero: { ...TYPE.figureHero },
    base: { ...TYPE.figure },
    small: { ...TYPE.figureSmall },
  },
  overline: { ...TYPE.overline, textTransform: 'none' },
});

export default classicTheme;
