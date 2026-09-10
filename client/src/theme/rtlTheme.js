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

const t2 = (ms, curve = MOTION.easing.standard) => `${ms}ms ${curve}`;
const transition = t2(MOTION.duration.fast);

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

  /**
   * The motion scale, reachable from any component as theme.motion.
   *
   * There were eighteen hand-written transition strings across the components —
   * 160ms here, 140ms there, `all 0.2s` in the Gantt — and the token that was
   * supposed to govern them was consumed in exactly one place. A scale nobody
   * can reach is a scale nobody uses.
   */
  motion: {
    instant: t2(MOTION.duration.instant),
    fast: t2(MOTION.duration.fast),
    base: t2(MOTION.duration.base, MOTION.easing.enter),
    slow: t2(MOTION.duration.slow, MOTION.easing.enter),
    exit: t2(MOTION.duration.fast, MOTION.easing.exit),
    duration: MOTION.duration,
    easing: MOTION.easing,
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
        /**
         * `/* @noflip *\/` IS LOad-BEARING. stylis-plugin-rtl rewrites this
         * whole stylesheet, and it does not know that these two declarations
         * are the point rather than an accident: it turned `direction: ltr`
         * into `rtl` and `text-align: right` into `left`, so the class written
         * to stop Israeli IDs and shekel figures reordering was doing the
         * opposite. Verified by running the plugin over the rule.
         *
         * server/scripts/design-tokens.test.js now runs the plugin too and
         * fails if the output stops being ltr.
         */
        '.num': {
          fontVariantNumeric: 'tabular-nums',
          unicodeBidi: 'isolate',
          '/*!@noflip*/direction': 'ltr',
          '/*!@noflip*/textAlign': 'right',
        },

        /**
         * Somewhere to be, for a keyboard.
         *
         * MUI's ButtonBase sets `outline: 0` on everything it renders and this
         * theme never put one back, so every button, icon button, tab, chip and
         * select in the app was invisible to a keyboard. Only two components in
         * the whole client defined a focus style of their own.
         */
        '.Mui-focusVisible, :focus-visible': {
          outline: `2px solid ${COLOR.primary.main}`,
          outlineOffset: 2,
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
            // A row was jumping to its hover colour with no transition while a
            // tile beside it faded in 140ms.
            transition: `background-color ${t2(MOTION.duration.instant)}`,
          },
          /**
           * Dense actually means dense. The rule above outranked MUI's own
           * `.MuiTableCell-sizeSmall`, so `size="small"` did nothing and a
           * 40-employee grid showed fifteen of them.
           */
          '& .MuiTableCell-root.MuiTableCell-sizeSmall': {
            padding: '5px 8px',
          },
        },
      },
    },

    /**
     * Chips stop shouting.
     *
     * MUI's filled colour chips are solid, saturated blocks, and this app puts
     * one in nearly every cell of every table — a verdict, a payment method, a
     * finding, a status. Twelve of them in a row is a row of traffic lights,
     * and once a screen has twelve there is no way to tell which one is the
     * problem. Every filled and outlined colour variant is remapped onto the
     * soft pairs from tokens.js: the same meaning, the same contrast (each pair
     * measured at AA by design-tokens.test.js), a tenth of the volume.
     *
     * Done here rather than screen by screen because it is the single change
     * that reaches all 152 of them at once.
     */
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          fontSize: TYPE.caption.size,
          borderRadius: RADIUS.pill,
          border: '1px solid transparent',
        },
        sizeSmall: { height: 22, fontSize: '0.6875rem' },
        filled: { backgroundColor: COLOR.background.sunken, color: COLOR.text.secondary },
        outlined: { borderColor: COLOR.divider, color: COLOR.text.secondary },
        filledPrimary: {
          backgroundColor: COLOR.primary.soft,
          color: COLOR.primary.softOn,
          '& .MuiChip-deleteIcon': { color: COLOR.primary.softOn, opacity: 0.55 },
          '&:hover': { backgroundColor: COLOR.primary.soft },
        },
        outlinedPrimary: {
          color: COLOR.primary.softOn,
          borderColor: COLOR.primary.soft,
          backgroundColor: COLOR.primary.soft,
        },
        filledSuccess: {
          backgroundColor: COLOR.success.soft,
          color: COLOR.success.softOn,
          '& .MuiChip-deleteIcon': { color: COLOR.success.softOn, opacity: 0.55 },
          '&:hover': { backgroundColor: COLOR.success.soft },
        },
        outlinedSuccess: {
          color: COLOR.success.softOn,
          borderColor: COLOR.success.soft,
          backgroundColor: COLOR.success.soft,
        },
        filledWarning: {
          backgroundColor: COLOR.warning.soft,
          color: COLOR.warning.softOn,
          '& .MuiChip-deleteIcon': { color: COLOR.warning.softOn, opacity: 0.55 },
          '&:hover': { backgroundColor: COLOR.warning.soft },
        },
        outlinedWarning: {
          color: COLOR.warning.softOn,
          borderColor: COLOR.warning.soft,
          backgroundColor: COLOR.warning.soft,
        },
        filledError: {
          backgroundColor: COLOR.error.soft,
          color: COLOR.error.softOn,
          '& .MuiChip-deleteIcon': { color: COLOR.error.softOn, opacity: 0.55 },
          '&:hover': { backgroundColor: COLOR.error.soft },
        },
        outlinedError: {
          color: COLOR.error.softOn,
          borderColor: COLOR.error.soft,
          backgroundColor: COLOR.error.soft,
        },
        filledInfo: {
          backgroundColor: COLOR.info.soft,
          color: COLOR.info.softOn,
          '& .MuiChip-deleteIcon': { color: COLOR.info.softOn, opacity: 0.55 },
          '&:hover': { backgroundColor: COLOR.info.soft },
        },
        outlinedInfo: {
          color: COLOR.info.softOn,
          borderColor: COLOR.info.soft,
          backgroundColor: COLOR.info.soft,
        },
      },
    },

    /**
     * Alerts get what chips got.
     *
     * The Alert is this app's main feedback surface — four of them stack up in
     * one upload dialog — and it was the one component left on MUI's cold blue
     * and green, sitting on warm paper. Same soft pairs, same measured
     * contrast.
     */
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: RADIUS.control, fontSize: TYPE.body2.size },
        standardSuccess: {
          backgroundColor: COLOR.success.soft,
          color: COLOR.success.softOn,
          '& .MuiAlert-icon': { color: COLOR.success.main },
        },
        standardWarning: {
          backgroundColor: COLOR.warning.soft,
          color: COLOR.warning.softOn,
          '& .MuiAlert-icon': { color: COLOR.warning.main },
        },
        standardError: {
          backgroundColor: COLOR.error.soft,
          color: COLOR.error.softOn,
          '& .MuiAlert-icon': { color: COLOR.error.main },
        },
        standardInfo: {
          backgroundColor: COLOR.info.soft,
          color: COLOR.info.softOn,
          '& .MuiAlert-icon': { color: COLOR.info.main },
        },
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
