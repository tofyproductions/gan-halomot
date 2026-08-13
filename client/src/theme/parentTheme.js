import { createTheme } from '@mui/material/styles';

/**
 * The parent portal's own look.
 *
 * The staff system and this one are used by different people for different
 * reasons, and until now they shared a theme built for the first of them:
 * cold slate greys, dense tables, a gradient on every button. That reads as
 * software you operate. A parent opens this between meetings to find out
 * whether their baby ate, and four times a week to look at photographs of
 * them — it should read as an album somebody keeps, not a console.
 *
 * So the ground is warm paper rather than blue-grey, headings are set in a
 * Hebrew serif with an actual voice, and the brand amber is deepened to a
 * clay that white text can legally sit on. The old #f59e0b behind white
 * failed contrast at 2.2:1 on every contained button in the app.
 *
 * Scoped deliberately: it wraps the parent routes only, so nothing here can
 * move a pixel in the staff screens.
 */

// Kept out of the palette because it is a typeface stack, not a colour, and
// three components need it by name.
export const DISPLAY = '"Frank Ruhl Libre", "Assistant", Georgia, serif';
const BODY = '"Assistant", system-ui, -apple-system, "Segoe UI", sans-serif';

// Warm neutrals. Every grey is tinted toward the brand hue — a flat grey next
// to cream paper looks like a rendering fault rather than a choice.
const INK = '#2B2119';
const INK_SOFT = '#6E6157';
const INK_FAINT = '#A2948A';
const PAPER = '#FFFFFF';
const GROUND = '#FAF6F0';
const LINE = '#EDE3D6';

const parentTheme = createTheme({
  direction: 'rtl',

  palette: {
    mode: 'light',
    // Clay, not amber: the brand colour, dark enough to carry white text at
    // 4.97:1. The bright amber survives as `primary.light`, for fills that
    // never have text on them.
    primary: { main: '#B4540A', light: '#F2A03D', dark: '#8A3F06', contrastText: '#fff' },
    // The garden. Calm counterweight to all that warmth, and the colour of
    // everything that went right.
    secondary: { main: '#4A7C59', light: '#DCEADF', dark: '#355B41', contrastText: '#fff' },
    success: { main: '#3F7D53', light: '#E4F0E7', dark: '#2E5C3D', contrastText: '#fff' },
    warning: { main: '#9A5B00', light: '#FFF1DC', dark: '#7A4700', contrastText: '#fff' },
    error: { main: '#B3261E', light: '#FBE9E6', dark: '#8C1D18', contrastText: '#fff' },
    info: { main: '#3A6EA5', light: '#E7EFF8', dark: '#2B5480', contrastText: '#fff' },
    background: { default: GROUND, paper: PAPER },
    text: { primary: INK, secondary: INK_SOFT, disabled: INK_FAINT },
    divider: LINE,
    action: { hover: 'rgba(180,84,10,0.05)', selected: 'rgba(180,84,10,0.09)' },
  },

  shape: { borderRadius: 16 },

  // A fixed rem scale, not fluid: this is product UI, and headings that
  // resize with the viewport make a phone and a tablet feel like two apps.
  // Steps are at least 1.15 apart so hierarchy survives without colour.
  typography: {
    fontFamily: BODY,
    h1: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '2rem', lineHeight: 1.2 },
    h2: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.625rem', lineHeight: 1.25 },
    h3: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.375rem', lineHeight: 1.3 },
    h4: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.25rem', lineHeight: 1.3 },
    h5: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.125rem', lineHeight: 1.35 },
    h6: { fontWeight: 700, fontSize: '1.0625rem', lineHeight: 1.4 },
    subtitle1: { fontWeight: 700, fontSize: '1rem', lineHeight: 1.45 },
    subtitle2: { fontWeight: 700, fontSize: '0.875rem', lineHeight: 1.45 },
    body1: { fontSize: '1rem', lineHeight: 1.6 },
    body2: { fontSize: '0.9375rem', lineHeight: 1.6 },
    caption: { fontSize: '0.8125rem', lineHeight: 1.45 },
    button: { fontWeight: 700, fontSize: '0.9375rem', textTransform: 'none' },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: GROUND,
          WebkitFontSmoothing: 'antialiased',
          textRendering: 'optimizeLegibility',
        },
        // Cards arrive rather than appear. One gesture, staggered by the
        // caller, and switched off entirely for anyone who asked the system
        // for less movement.
        '@keyframes riseIn': {
          from: { opacity: 0, transform: 'translateY(10px)' },
          to: { opacity: 1, transform: 'none' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          '*': { animation: 'none !important', transition: 'none !important' },
        },
      },
    },

    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 20,
          border: `1px solid ${LINE}`,
          backgroundImage: 'none',
          // Warm shadow. A neutral black shadow on cream paper reads grey
          // and dirty; this one is the ink colour at low opacity.
          boxShadow: '0 1px 2px rgba(43,33,25,0.04), 0 10px 26px -14px rgba(43,33,25,0.16)',
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: { padding: 20, '&:last-child': { paddingBottom: 20 } },
      },
    },

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 999,
          minHeight: 44, // the touch minimum, not a look
          paddingInline: 22,
          transition: 'background-color .18s ease, transform .18s ease',
          '&:active': { transform: 'scale(0.97)' },
        },
        sizeSmall: { minHeight: 38, paddingInline: 16, fontSize: '0.875rem' },
        outlined: { borderWidth: 1.5, '&:hover': { borderWidth: 1.5 } },
        text: { paddingInline: 12 },
      },
    },

    MuiIconButton: {
      styleOverrides: { root: { padding: 10 } },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 14,
          backgroundColor: '#FEFCF9',
          // 16px exactly: anything smaller and iOS Safari zooms the page on
          // focus, which on a phone reads as the app jumping.
          fontSize: '1rem',
        },
        notchedOutline: { borderColor: LINE },
        input: { paddingTop: 14, paddingBottom: 14 },
      },
    },
    MuiInputLabel: { styleOverrides: { root: { fontSize: '0.9375rem' } } },

    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 999, fontWeight: 600 },
        sizeSmall: { height: 26, fontSize: '0.78rem' },
        outlined: { borderColor: LINE },
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 16, fontSize: '0.9375rem', alignItems: 'flex-start' },
        standardInfo: { backgroundColor: '#E7EFF8', color: '#26456A' },
        standardSuccess: { backgroundColor: '#E4F0E7', color: '#274A32' },
        standardWarning: { backgroundColor: '#FFF1DC', color: '#6B3F00' },
        standardError: { backgroundColor: '#FBE9E6', color: '#7A1912' },
      },
    },

    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 24, margin: 16, width: 'calc(100% - 32px)' },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: { fontFamily: DISPLAY, fontSize: '1.25rem', fontWeight: 700, paddingBottom: 4 },
      },
    },
    // A scrim you can see through is a scrim that leaves the page behind
    // competing with the dialog in front.
    MuiBackdrop: {
      styleOverrides: { root: { backgroundColor: 'rgba(43,33,25,0.5)' } },
    },

    MuiTabs: {
      styleOverrides: {
        indicator: { height: 3, borderRadius: 3 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: { minHeight: 52, fontWeight: 700, fontSize: '0.9375rem' },
      },
    },

    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          minWidth: 0,
          paddingTop: 8,
          color: INK_SOFT,
          '&.Mui-selected': { color: '#B4540A' },
        },
        // Always shown. An icon-only bar is a guessing game the first time.
        label: { fontSize: '0.75rem', fontWeight: 700, '&.Mui-selected': { fontSize: '0.75rem' } },
      },
    },

    MuiLinearProgress: {
      styleOverrides: { root: { borderRadius: 999, height: 6 } },
    },

    MuiAvatar: {
      styleOverrides: { root: { fontFamily: DISPLAY, fontWeight: 700 } },
    },
  },
});

export default parentTheme;
