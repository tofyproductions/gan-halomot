import { createTheme } from '@mui/material/styles';
import createCache from '@emotion/cache';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';
import { COLOR, RADIUS, SPACING_UNIT, TYPE, MOTION } from './tokens';

export const cacheRtl = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin],
});

const t = (v) => ({
  fontSize: v.size,
  fontWeight: v.weight,
  lineHeight: v.lineHeight,
  ...(v.letterSpacing ? { letterSpacing: v.letterSpacing } : {}),
});

const transition = `${MOTION.duration}ms ${MOTION.easing}`;

/**
 * Depth is a hairline, not a shadow.
 *
 * A card here is white on #F4F4F2; that difference plus a 1px rule is all the
 * elevation a panel needs, and it survives being printed, screenshotted, and
 * looked at on a bad monitor in a gan office. The outgoing theme gave every
 * card a two-layer shadow, which is why a screen with eight of them read as
 * eight floating objects rather than one page.
 *
 * Shadows are kept for things that genuinely float above the page — menus and
 * dialogs — and are tinted warm, because a neutral black shadow on a warm
 * ground reads dirty.
 */
const FLOAT_SHADOW =
  '0 4px 6px -2px rgba(60,42,20,0.06), 0 14px 32px -10px rgba(60,42,20,0.20)';

/**
 * A card at rest.
 *
 * Almost nothing — a warm hairline and the faintest lift. The point is that a
 * white card on warm paper should read as a sheet lying on a desk, which needs
 * about this much and no more. The theme this replaces gave every card a
 * two-layer neutral-black shadow, and eight of them on a screen read as eight
 * floating objects rather than one page.
 */
const CARD_SHADOW = '0 1px 2px rgba(60,42,20,0.04), 0 6px 16px -10px rgba(60,42,20,0.14)';

const theme = createTheme({
  direction: 'rtl',

  spacing: SPACING_UNIT,

  shape: { borderRadius: RADIUS.surface },

  palette: {
    mode: 'light',
    primary: COLOR.primary,
    secondary: COLOR.info,
    success: COLOR.success,
    warning: COLOR.warning,
    error: COLOR.error,
    info: COLOR.info,
    background: COLOR.background,
    text: COLOR.text,
    divider: COLOR.divider,
    // A second, heavier rule. Under a table head and around a hovered control,
    // where the hairline that separates rows is too faint to read as an edge.
    dividerStrong: COLOR.dividerStrong,
    action: {
      hover: COLOR.row.hover,
      selected: COLOR.row.selected,
    },

    /**
     * INSIDE palette, deliberately.
     *
     * `sx={{ color: 'sidebar.fg' }}` resolves against theme.palette and
     * nowhere else. Declared one level up — which is where these first went —
     * the lookup silently misses, the raw string 'sidebar.fg' is handed to CSS
     * as a colour, and the rail renders with black text and an invisible
     * marker. It fails quietly, which is the worst way for a colour to fail.
     */
    sidebar: COLOR.sidebar,
    row: COLOR.row,
  },

  // Type, not colour, so these stay off the palette.
  figure: { hero: t(TYPE.figureHero), base: t(TYPE.figure), small: t(TYPE.figureSmall) },
  overline: { ...t(TYPE.overline), textTransform: 'none' },

  typography: {
    fontFamily: TYPE.fontFamily,
    h1: t(TYPE.h1),
    h2: t(TYPE.h2),
    h3: t(TYPE.h3),
    h4: t(TYPE.h4),
    h5: t(TYPE.h5),
    h6: t(TYPE.h6),
    subtitle1: t(TYPE.h6),
    subtitle2: { ...t(TYPE.body2), fontWeight: 600 },
    body1: t(TYPE.body1),
    body2: t(TYPE.body2),
    caption: t(TYPE.caption),
    button: { ...t(TYPE.button), textTransform: 'none' },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: COLOR.background.default,
          WebkitFontSmoothing: 'antialiased',
        },

        /**
         * An Israeli ID, a phone number or a shekel figure inside an RTL
         * sentence reorders on screen unless it is isolated — the digits stay
         * put but the surrounding punctuation walks. Every number in this app
         * is one of those three, so isolation is a default here rather than
         * something each of 152 screens has to remember.
         */
        '.num': {
          fontVariantNumeric: 'tabular-nums',
          unicodeBidi: 'isolate',
          direction: 'ltr',
          textAlign: 'right',
        },

        '@media (prefers-reduced-motion: reduce)': {
          '*': {
            animationDuration: '0.01ms !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: RADIUS.control,
          padding: '7px 16px',
          minHeight: 38,
          transition: `background-color ${transition}, border-color ${transition}`,
        },
        // No gradient. The outgoing containedPrimary painted one on every
        // primary button in the app, which is most of why four of them in a
        // row read as decoration rather than as one action.
        containedPrimary: {
          '&:hover': { backgroundColor: COLOR.primary.dark },
        },
        outlined: {
          borderColor: COLOR.divider,
          color: COLOR.text.primary,
          '&:hover': {
            borderColor: COLOR.text.disabled,
            backgroundColor: COLOR.row.hover,
          },
        },
        text: {
          color: COLOR.text.secondary,
          '&:hover': { backgroundColor: COLOR.row.hover },
        },
        sizeSmall: { padding: '4px 12px', minHeight: 30 },
      },
    },

    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: RADIUS.control,
          // Finger-sized on a phone. Staff use this in the rooms.
          '@media (max-width: 900px)': { padding: 10 },
        },
      },
    },

    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: { borderColor: COLOR.divider, borderRadius: RADIUS.surface },
      },
    },

    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: RADIUS.surface,
          border: `1px solid ${COLOR.divider}`,
          boxShadow: CARD_SHADOW,
        },
      },
    },

    MuiTextField: { defaultProps: { size: 'small' } },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: RADIUS.control,
          backgroundColor: COLOR.background.paper,
          '& fieldset': { borderColor: COLOR.divider },
          '&:hover fieldset': { borderColor: COLOR.text.disabled },
        },
      },
    },

    MuiInputLabel: {
      styleOverrides: { root: { color: COLOR.text.secondary } },
    },

    MuiTableContainer: {
      styleOverrides: {
        root: {
          borderRadius: RADIUS.surface,
          border: `1px solid ${COLOR.divider}`,
          backgroundColor: COLOR.background.paper,
          boxShadow: CARD_SHADOW,
        },
      },
    },

    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            backgroundColor: COLOR.background.sunken,
            color: COLOR.text.secondary,
            fontWeight: TYPE.columnHead.weight,
            fontSize: TYPE.columnHead.size,
            letterSpacing: '0.02em',
            borderBottom: `1px solid ${COLOR.dividerStrong}`,
            whiteSpace: 'nowrap',
            padding: '9px 12px',
            // The tables here run to hundreds of rows and nobody remembers
            // what column four was by the time they have scrolled to one.
            position: 'sticky',
            top: 0,
            zIndex: 2,
          },
        },
      },
    },

    MuiTableBody: {
      styleOverrides: {
        root: {
          // No zebra striping. Alternating fills fight the row tints that
          // actually carry meaning — a row needing attention, a row selected —
          // and a reader cannot tell the two kinds of stripe apart.
          '& .MuiTableRow-root:hover': { backgroundColor: COLOR.row.hover },
          '& .MuiTableCell-root': {
            padding: '9px 12px',
            fontSize: TYPE.body2.size,
            borderBottom: `1px solid ${COLOR.divider}`,
          },
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 500,
          fontSize: TYPE.caption.size,
          borderRadius: RADIUS.pill,
        },
        sizeSmall: { height: 22, fontSize: '0.6875rem' },
        outlined: { borderColor: COLOR.divider },
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: RADIUS.control, fontSize: TYPE.body2.size },
      },
    },

    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: RADIUS.surface, boxShadow: FLOAT_SHADOW },
      },
    },

    MuiDialogTitle: {
      styleOverrides: { root: { ...t(TYPE.h4), paddingBottom: 8 } },
    },

    MuiMenu: {
      styleOverrides: {
        paper: {
          borderRadius: RADIUS.surface,
          border: `1px solid ${COLOR.divider}`,
          boxShadow: FLOAT_SHADOW,
        },
      },
    },

    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          fontSize: TYPE.caption.size,
          borderRadius: RADIUS.control,
          padding: '5px 10px',
        },
      },
    },

    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          fontSize: TYPE.body2.size,
          minHeight: 42,
        },
      },
    },
  },
});

export default theme;
