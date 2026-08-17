import { createTheme } from '@mui/material/styles';

/**
 * The parent portal's own look, in two lights.
 *
 * The staff system and this one are used by different people for different
 * reasons, and until now they shared a theme built for the first of them:
 * cold slate greys, dense tables, a gradient on every button. That reads as
 * software you operate. A parent opens this between meetings to find out
 * whether their baby ate, and four times a week to look at photographs of
 * them — it should read as an album somebody keeps, not a console.
 *
 * So the ground is warm paper rather than blue-grey, the type is round and
 * soft-cornered, and the brand amber is deepened to a clay that white text
 * can legally sit on. The old #f59e0b behind white failed contrast at 2.2:1
 * on every contained button in the app.
 *
 * NOW A FACTORY, not a constant. Dark mode is not a filter over the light
 * theme — a warm paper design inverted mechanically gives blue-black and
 * muddy clay — so the two palettes are written out separately and every one
 * of the dark values was chosen against its own ground. Everything below the
 * palette is shared: shape, type and component shapes do not change with the
 * light.
 *
 * Scoped deliberately: it wraps the parent routes only, so nothing here can
 * move a pixel in the staff screens.
 */

// One family, headings and body alike. Rubik: rounded terminals, open
// counters, a full weight range, and — not incidentally — the face the gan's
// previous system used for years, so it is what these parents already read
// every morning. A serif was tried here and read as a printed form.
//
// Still exported by name because a few places set it explicitly rather than
// going through a typography variant.
export const DISPLAY = '"Rubik", "Assistant", system-ui, sans-serif';
const BODY = '"Rubik", "Assistant", system-ui, -apple-system, sans-serif';

/**
 * The four colours the home screen is built from.
 *
 * Not in the MUI palette, because none of them is a semantic role: nothing
 * here means "success" or "error", they are the colours of a gan. Kept
 * together so a card that is teal today is teal in both lights, and so the
 * one place to change them is this object.
 *
 * Each carries its own `on` — the text colour that is legible on it. Deriving
 * that per card is how a heading ends up dark grey on a dark teal.
 */
export const PLAYFUL = {
  light: {
    coral: { bg: '#E4572E', on: '#FFFFFF', soft: '#FDEBE5', softOn: '#8E2E12' },
    teal: { bg: '#2E9E8F', on: '#FFFFFF', soft: '#E2F2EF', softOn: '#1B5D54' },
    amber: { bg: '#F4B942', on: '#3A2A08', soft: '#FEF3DC', softOn: '#6B4A00' },
    violet: { bg: '#6C63B5', on: '#FFFFFF', soft: '#EDEBF7', softOn: '#413A7D' },
  },
  dark: {
    coral: { bg: '#C4441F', on: '#FFF3EE', soft: '#33190F', softOn: '#FFB599' },
    teal: { bg: '#248275', on: '#E9F7F4', soft: '#0F2A26', softOn: '#7FD3C6' },
    amber: { bg: '#C9922B', on: '#241900', soft: '#2C2210', softOn: '#F2CB74' },
    violet: { bg: '#585092', on: '#F0EEFA', soft: '#1D1930', softOn: '#B0A8E8' },
  },
};

/**
 * The palette for one light.
 *
 * Every grey is tinted toward the brand hue in both — a flat neutral grey next
 * to cream paper looks like a rendering fault rather than a choice, and the
 * same is true of a blue-black next to warm clay.
 */
function paletteFor(mode) {
  if (mode === 'dark') {
    const INK = '#F2EBE3';
    const INK_SOFT = '#B0A497';
    const INK_FAINT = '#7D7267';
    const PAPER = '#211C16';
    const GROUND = '#17130F';
    const LINE = '#332B23';

    return {
      mode: 'dark',
      // Lighter clay. The light theme's #B4540A on a dark ground is a hole
      // rather than an accent, and white text on it is the wrong contrast
      // direction — here the accent is light and carries DARK text.
      primary: { main: '#F0913F', light: '#F7B674', dark: '#C4711F', contrastText: '#2A1B0B' },
      secondary: { main: '#7FBF93', light: '#25352B', dark: '#5C9E71', contrastText: '#122117' },
      success: { main: '#7FC095', light: '#1D2C22', dark: '#5AA173', contrastText: '#0E1D14' },
      warning: { main: '#E0A64F', light: '#2E2415', dark: '#BC8630', contrastText: '#241800' },
      error: { main: '#F0918A', light: '#331917', dark: '#C96B63', contrastText: '#2B0D0A' },
      info: { main: '#8AB4E0', light: '#182634', dark: '#6693BE', contrastText: '#0B1926' },
      background: { default: GROUND, paper: PAPER },
      text: { primary: INK, secondary: INK_SOFT, disabled: INK_FAINT },
      divider: LINE,
      action: { hover: 'rgba(240,145,63,0.08)', selected: 'rgba(240,145,63,0.14)' },
    };
  }

  const INK = '#2B2119';
  const INK_SOFT = '#6E6157';
  const INK_FAINT = '#A2948A';
  const PAPER = '#FFFFFF';
  const GROUND = '#FAF6F0';
  const LINE = '#EDE3D6';

  return {
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
  };
}

/**
 * The card shadow, which is the one thing that cannot simply be re-coloured.
 *
 * On paper a card is lifted by a warm shadow — a neutral black one reads grey
 * and dirty against cream. On a dark ground a shadow is invisible, and depth
 * has to come from the card being LIGHTER than what is behind it plus a hairline.
 */
function cardElevation(mode) {
  return mode === 'dark'
    ? '0 0 0 1px rgba(255,255,255,0.04), 0 12px 30px -18px rgba(0,0,0,0.9)'
    : '0 1px 2px rgba(43,33,25,0.04), 0 10px 26px -14px rgba(43,33,25,0.16)';
}

export function createParentTheme(mode = 'light') {
  const palette = paletteFor(mode);
  const dark = mode === 'dark';

  return createTheme({
    direction: 'rtl',
    palette,

    // Reachable from any component as theme.playful — see PLAYFUL above.
    playful: dark ? PLAYFUL.dark : PLAYFUL.light,

    shape: { borderRadius: 16 },

    // A fixed rem scale, not fluid: this is product UI, and headings that
    // resize with the viewport make a phone and a tablet feel like two apps.
    // Steps are at least 1.15 apart so hierarchy survives without colour.
    typography: {
      fontFamily: BODY,
      h1: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '2rem', lineHeight: 1.2, letterSpacing: '-0.01em' },
      h2: { fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.625rem', lineHeight: 1.25, letterSpacing: '-0.01em' },
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
            backgroundColor: palette.background.default,
            WebkitFontSmoothing: 'antialiased',
            textRendering: 'optimizeLegibility',
          },
          // Tells the browser which way to paint its own furniture — form
          // controls, scrollbars, and the bar behind the address field on
          // iOS. Without it a dark page keeps a white scrollbar down its side.
          ':root': { colorScheme: dark ? 'dark' : 'light' },
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
            border: `1px solid ${palette.divider}`,
            backgroundImage: 'none',
            boxShadow: cardElevation(mode),
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
            backgroundColor: dark ? '#1B1611' : '#FEFCF9',
            // 16px exactly: anything smaller and iOS Safari zooms the page on
            // focus, which on a phone reads as the app jumping.
            fontSize: '1rem',
          },
          notchedOutline: { borderColor: palette.divider },
          input: { paddingTop: 14, paddingBottom: 14 },
        },
      },
      MuiInputLabel: { styleOverrides: { root: { fontSize: '0.9375rem' } } },

      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 999, fontWeight: 600 },
          sizeSmall: { height: 26, fontSize: '0.78rem' },
          outlined: { borderColor: palette.divider },
        },
      },

      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 16, fontSize: '0.9375rem', alignItems: 'flex-start' },
          // The `light` slot of each semantic colour is the tinted ground in
          // both themes — see paletteFor, where dark mode deliberately puts a
          // near-black tint there rather than a pastel.
          standardInfo: { backgroundColor: palette.info.light, color: dark ? palette.info.main : '#26456A' },
          standardSuccess: { backgroundColor: palette.success.light, color: dark ? palette.success.main : '#274A32' },
          standardWarning: { backgroundColor: palette.warning.light, color: dark ? palette.warning.main : '#6B3F00' },
          standardError: { backgroundColor: palette.error.light, color: dark ? palette.error.main : '#7A1912' },
        },
      },

      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 24, margin: 16, width: 'calc(100% - 32px)' },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: { fontSize: '1.25rem', fontWeight: 700, paddingBottom: 4 },
        },
      },
      // A scrim you can see through is a scrim that leaves the page behind
      // competing with the dialog in front.
      MuiBackdrop: {
        styleOverrides: {
          root: { backgroundColor: dark ? 'rgba(0,0,0,0.68)' : 'rgba(43,33,25,0.5)' },
        },
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
            color: palette.text.secondary,
            '&.Mui-selected': { color: palette.primary.main },
          },
          // Always shown. An icon-only bar is a guessing game the first time.
          label: { fontSize: '0.75rem', fontWeight: 700, '&.Mui-selected': { fontSize: '0.75rem' } },
        },
      },

      MuiLinearProgress: {
        styleOverrides: { root: { borderRadius: 999, height: 6 } },
      },

      MuiAvatar: {
        styleOverrides: { root: { fontWeight: 700 } },
      },

      MuiSkeleton: {
        styleOverrides: {
          root: { backgroundColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(43,33,25,0.06)' },
        },
      },
    },
  });
}

/**
 * The light theme, still the default export.
 *
 * Anything that has not yet been taught about the second light keeps working
 * and keeps looking exactly as it did.
 */
const parentTheme = createParentTheme('light');
export default parentTheme;
