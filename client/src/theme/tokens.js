/**
 * The only file in the client allowed to write a colour down.
 *
 * Everything else — the theme, the shell, every screen — names a token. That
 * is not tidiness for its own sake: the app currently carries hundreds of hex
 * literals typed straight into components, which is why six stat tiles on one
 * screen ended up in six different colours, and why a primary button spent two
 * years failing contrast at 2.2:1 without anyone being able to see it in one
 * place.
 *
 * IMPORTS NOTHING, DELIBERATELY. server/scripts/design-tokens.test.js pulls
 * this module in with a dynamic import and measures every pair below; an
 * import of @mui, or of anything else in the client tree, would break that.
 *
 * Every text-on-fill pair here passes WCAG AA (4.5:1). The test is what makes
 * that a fact rather than an intention.
 */

/**
 * The rail.
 *
 * Warm near-black, not blue-black: a cold grey beside the brand amber reads as
 * a rendering fault rather than a choice. The same reasoning the parent portal
 * used for its own greys, pointed the other way.
 */
const SIDEBAR = {
  // Warm ink, not black and not blue-grey. Deep enough that the marigold
  // marker reads as light rather than as another dark thing.
  bg: '#1F1B16',
  bgDeep: '#181410',
  fg: '#C9C0B4',
  fgActive: '#FFFFFF',
  bgActive: '#332C23',
  // Marigold. Brighter than the button clay on purpose: on ink it is the one
  // thing that should catch the eye, and it carries no text of its own.
  marker: '#E9A13B',
  markerSoft: 'rgba(233,161,59,0.13)',
  groupLabel: '#8C8375',
  rule: '#2E2721',
};

export const COLOR = {
  sidebar: SIDEBAR,

  background: {
    // Warm paper. The cold grey it replaces is what made every screen read as
    // a default admin template — a neutral grey beside warm ink looks like an
    // absence of a decision.
    default: '#FAF7F2',
    paper: '#FFFFFF',
    // The band a page header or a table toolbar sits on.
    sunken: '#F3EEE6',
  },

  text: {
    primary: '#1C1815',
    secondary: '#6B6157',
    disabled: '#A79C8E',
  },

  divider: '#EBE4D9',
  dividerStrong: '#DDD3C4',

  /**
   * Clay, not amber.
   *
   * #f59e0b behind white text measures 2.2:1. This is 5.01:1 — the same clay
   * the parent portal already proved in production. The bright amber survives
   * as `light`, for fills that never carry text.
   */
  primary: {
    main: '#B4540A',
    light: '#F59E0B',
    dark: '#8A3F06',
    contrastText: '#FFFFFF',
    soft: '#FDF0E6',
    softOn: '#7A3806',
  },

  success: {
    main: '#3F7D53',
    dark: '#2E5C3D',
    contrastText: '#FFFFFF',
    soft: '#E4F0E7',
    softOn: '#255239',
  },

  warning: {
    main: '#9A5B00',
    dark: '#7A4700',
    contrastText: '#FFFFFF',
    soft: '#FFF1DC',
    softOn: '#6B3F00',
  },

  error: {
    main: '#B3261E',
    dark: '#8C1D18',
    contrastText: '#FFFFFF',
    soft: '#FBE9E6',
    softOn: '#8C1D18',
  },

  info: {
    main: '#3A6EA5',
    dark: '#2B5480',
    contrastText: '#FFFFFF',
    soft: '#E7EFF8',
    softOn: '#274D74',
  },

  /**
   * The six states a day in the punch grid can be in.
   *
   * These are not decoration and they are not a theme choice — the colour IS
   * the information. A manager reads a month of forty employees across the grid
   * and never opens a single cell; what she is reading is which days came off
   * the clock, which somebody typed in, and which are still waiting on her.
   *
   * They were written by hand in three places — the cell renderer, the legend
   * beneath it, and the PDF stylesheet — which is how a legend ends up
   * describing colours the grid stopped using. The legend now generates itself
   * from this object, so the two cannot drift.
   *
   * Four of the six reuse the semantic soft pairs above, because they mean the
   * same things (fine / needs attention / wrong). Teal and violet are added
   * because "these hours came from a fixed schedule" and "somebody typed this
   * and it is not approved yet" are real distinctions with no semantic role.
   */
  punch: {
    clock:      { bg: '#E4F0E7', on: '#255239', label: 'החתמת שעון' },
    manual:     { bg: '#E7EFF8', on: '#274D74', label: '✎ עדכון ידני' },
    fixed:      { bg: '#DEEFEC', on: '#1C574F', label: '⏱ שעות קבועות' },
    incomplete: { bg: '#FFF1DC', on: '#6B3F00', label: 'חסרה יציאה' },
    pending:    { bg: '#ECE9F6', on: '#413A7D', label: 'ידני — ממתין לאישור' },
    review:     { bg: '#FBE9E6', on: '#8C1D18', label: '⚠️ החתמה כפולה — להחלטת הנה״ח' },
  },

  /**
   * Row tints. A row that needs attention is tinted; a row that is fine is
   * white. This is the whole of the colour budget for a table — the alternative,
   * which the app currently does, is a different coloured chip in every column
   * and no way to tell at a glance which line is the problem.
   */
  row: {
    attention: '#FFF7ED',
    selected: '#FDF0E6',
    hover: '#FAFAF9',
  },
};

export const SPACING_UNIT = 8;

/**
 * One radius scale, and only these three. Mixed systems — pill buttons beside
 * square cards beside rounded inputs — are what make an interface look
 * assembled rather than designed.
 */
export const RADIUS = {
  control: 6,   // inputs, buttons, menu items
  surface: 8,   // cards, tables, panels, dialogs
  pill: 999,    // filter chips and badges only
};

/**
 * One family.
 *
 * A display face — the outgoing Varela Round, at weight 900 on h1 and h2 — in
 * product-UI labels is noise. Hierarchy here comes from weight and colour, not
 * from a second typeface.
 *
 * Fixed rem steps, never fluid. Staff view this at consistent DPI, and a
 * heading that resizes with the viewport makes a laptop and a desktop feel
 * like two different applications.
 */
export const TYPE = {
  fontFamily: '"Assistant", system-ui, -apple-system, sans-serif',

  /**
   * The figures.
   *
   * Not in the MUI variant scale, because these are not headings — they are
   * the thing the page is about. A count of children waiting for a signature
   * set at 20px in the same weight as its own label is why a screen of
   * fourteen numbers reads as a wall of grey: nothing on it claims to matter
   * more than anything else.
   *
   * Tight tracking, because tabular figures at this size sit too loose by
   * default and read as a licence plate.
   */
  figureHero: { size: '2.5rem', weight: 600, lineHeight: 1.05, letterSpacing: '-0.03em' },
  figure: { size: '1.75rem', weight: 600, lineHeight: 1.1, letterSpacing: '-0.02em' },
  figureSmall: { size: '1.25rem', weight: 600, lineHeight: 1.15, letterSpacing: '-0.01em' },

  /** The small line above a figure or a section. Tracked, never shouted. */
  overline: { size: '0.6875rem', weight: 600, lineHeight: 1.35, letterSpacing: '0.04em' },

  h1: { size: '1.75rem', weight: 700, lineHeight: 1.25, letterSpacing: '-0.01em' },
  h2: { size: '1.5rem', weight: 700, lineHeight: 1.28, letterSpacing: '-0.01em' },
  h3: { size: '1.3125rem', weight: 700, lineHeight: 1.3 },
  h4: { size: '1.1875rem', weight: 700, lineHeight: 1.35 },
  h5: { size: '1.0625rem', weight: 700, lineHeight: 1.4 },
  h6: { size: '0.9375rem', weight: 700, lineHeight: 1.45 },
  body1: { size: '0.9375rem', weight: 400, lineHeight: 1.55 },
  body2: { size: '0.875rem', weight: 400, lineHeight: 1.5 },
  caption: { size: '0.75rem', weight: 400, lineHeight: 1.4 },
  button: { size: '0.875rem', weight: 600, lineHeight: 1.4 },
  columnHead: { size: '0.75rem', weight: 600, lineHeight: 1.4 },
};

/**
 * Motion conveys state, never decoration. Users here are inside a task; a
 * transition they have to wait for is a transition that is too long.
 */
export const MOTION = {
  duration: 180,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
};
