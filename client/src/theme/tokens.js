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
    /**
     * Darkened from #6B6157 (5.22:1) to 7.04:1 — AAA for body text. Most of
     * the people reading this all day are over 55, on office monitors of
     * varying honesty, and secondary text here is not decoration: it is the
     * branch name, the column head, the hint under a figure.
     */
    secondary: '#57504A',
    /**
     * FOR NON-TEXT ONLY — an empty cell's em dash, a disabled control's
     * outline. It measures 2.70:1 and always did; the mistake was using it for
     * breadcrumbs and hints, which are read. `textMuted` below is what those
     * want.
     */
    disabled: '#A79C8E',
    /** Quiet, and still legible: 4.83:1 on paper. */
    muted: '#7A7067',
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
   * A gan's own colour.
   *
   * Semantic, like the punch grid: the payroll table, the attendance grid, the
   * employee list and the branch switcher all identify a branch by the same
   * colour, and somebody scanning a cross-branch report is reading the strips
   * rather than the names.
   *
   * These were framework-default colours — the full-saturation Tailwind ramp —
   * which is why the tables read as cold next to warm paper, and none of the
   * text-on-strip pairs had ever been measured. `strip` carries `stripText`, so
   * both are checked by design-tokens.test.js; `nameTint` and `rowTint` are
   * washes that ordinary body text sits on, and are checked against it.
   *
   * Deliberately still twelve distinct hues. Harmonising a palette whose whole
   * job is telling four things apart into one tasteful family would be the
   * design decision that breaks the feature.
   */
  branch: {
    red:      { strip: '#B23A2E', stripText: '#FFFFFF', nameTint: '#F6DCD8', rowTint: '#FDF3F1', accent: '#8E2C22' },
    amber:    { strip: '#C58A12', stripText: '#2A1C00', nameTint: '#F8E7BE', rowTint: '#FEF7E6', accent: '#9A6B08' },
    orange:   { strip: '#B4540A', stripText: '#FFFFFF', nameTint: '#F7DEC6', rowTint: '#FDF4EA', accent: '#98490A' },
    pink:     { strip: '#AC3D6B', stripText: '#FFFFFF', nameTint: '#F4DAE5', rowTint: '#FDF2F6', accent: '#8A2F54' },
    blue:     { strip: '#3A6EA5', stripText: '#FFFFFF', nameTint: '#D8E4F1', rowTint: '#F1F5FA', accent: '#2B5480' },
    green:    { strip: '#3F7D53', stripText: '#FFFFFF', nameTint: '#D9EADE', rowTint: '#F1F8F3', accent: '#2E5C3D' },
    violet:   { strip: '#5B4B9E', stripText: '#FFFFFF', nameTint: '#E0DBF0', rowTint: '#F4F2FB', accent: '#453979' },
    cyan:     { strip: '#1F7480', stripText: '#FFFFFF', nameTint: '#D2E8EB', rowTint: '#EFF7F8', accent: '#175860' },
    slate:    { strip: '#5C6470', stripText: '#FFFFFF', nameTint: '#DDE0E4', rowTint: '#F4F5F6', accent: '#454C55' },
    rose:     { strip: '#A93E52', stripText: '#FFFFFF', nameTint: '#F3DBE0', rowTint: '#FCF2F4', accent: '#87313F' },
    olive:    { strip: '#5F7326', stripText: '#FFFFFF', nameTint: '#E0E7C9', rowTint: '#F5F7EC', accent: '#48571C' },
    bronze:   { strip: '#8A5A22', stripText: '#FFFFFF', nameTint: '#EDDCC6', rowTint: '#F9F3EA', accent: '#6B451A' },
  },

  /**
   * Where a pregnancy stands, in the payroll row.
   *
   * Four states that change what the month owes and what may lawfully be done
   * about it — 40 monitoring hours, שמירת הריון, maternity leave, and the
   * protected period under §9 — so they are read off the row rather than
   * looked up, and they have to stay apart from one another. Written by hand
   * as four unmeasured pairs before this.
   */
  maternity: {
    expecting: { bg: '#F6DEE9', on: '#8A2F54' },
    bedrest:   { bg: '#F7E3D2', on: '#8A4A12' },
    leave:     { bg: '#E4DFF2', on: '#453979' },
    protected: { bg: '#F8DDD9', on: '#8C1D18' },
  },

  /**
   * What a payroll column is FOR.
   *
   * The monthly table is about forty columns wide and scrolls sideways, so by
   * the time somebody reaches בונוס the header row is a long way from the
   * figure under the cursor. The tints are how you keep your place: they say
   * whether the column you are in is base pay, overtime, a top-up, a deduction,
   * a once-a-year payment or a loan — six families rather than forty labels.
   *
   * `head` is the column heading, `cell` the body cells beneath it, one step
   * fainter so a column reads as a column without the table reading as stripes.
   * Both carry ordinary body text, and both are measured against it.
   */
  payrollColumn: {
    base:      { head: '#E3EDF6', cell: '#F2F6FA' },
    overtime:  { head: '#DCE8F5', cell: '#EFF4F9' },
    topUp:     { head: '#F8EBC9', cell: '#FCF6E8' },
    deduction: { head: '#F7E3D2', cell: '#FBF2EA' },
    annual:    { head: '#DCECEC', cell: '#F0F7F7' },
    bonus:     { head: '#DEEEE1', cell: '#F0F7F2' },
    loan:      { head: '#F6E0DD', cell: '#FBF1EF' },
  },

  /**
   * Where a row in the punch grid came from.
   *
   * Cell state (COLOR.punch) answers "how did these hours get here"; this
   * answers "whose row is this at all" — an employee borrowed from another
   * branch for a week, or a card the system could not match to anybody. Both
   * change what the manager is allowed to do with the row, so they are marked
   * on the row rather than explained in a footnote, and both appear in the
   * printed sheet's legend.
   */
  attendanceRow: {
    guest:        { bg: '#F1EDF8', section: '#E4DFF2', on: '#453979' },
    unlinked:     { bg: '#FDF3E2', on: '#8A4A12' },
    missingPunch: { bg: '#FDF6E7', border: '#D9A21B', on: '#6B3F00' },
  },

  /**
   * The collections sheet: who has paid, and who has not.
   *
   * `cell.*` is one family — a month either is paid, is partly paid, is unpaid,
   * or falls before the child started. Somebody chasing a debt reads a year of
   * these across a row and never opens one, which is the whole point of the
   * grid, so the four have to be told apart instantly and none may be mistaken
   * for another.
   *
   * `summary.*` are the three total rows at the foot, `camp` marks the קייטנה
   * columns, and `registration` the דמי רישום column.
   */
  collections: {
    cell: {
      paid:    { bg: '#E4F0E7', on: '#255239' },
      partial: { bg: '#FDF3E2', on: '#6B3F00' },
      unpaid:  { bg: '#FBEDEA', on: '#8C1D18' },
      // Muted, not unreadable. The original was #94a3b8 on #f1f5f9 — 2.33:1,
      // and the cell still prints the amount, so a month before the child
      // started was a figure nobody could actually read.
      before:  { bg: '#F3EEE6', on: '#6B6157' },
    },
    summary: {
      expected: '#EDF2F9',
      paid:     '#E9F3EC',
      debt:     '#FBF6E4',
    },
    camp:         { bg: '#F1EDF8', on: '#453979' },
    registration: '#FBF6E4',
  },

  /**
   * The hours report, which is a document somebody signs.
   *
   * `row.*` are the five states a day can be in on the daily sheet, and the
   * report prints its own legend of them — so, like the punch grid, they must
   * stay distinguishable and they must survive being printed in black and
   * white by somebody's office laser. Each carries the ink used for the
   * figures in that row.
   *
   * `leave.*` are the five kinds of absence, tinting the same sheet.
   */
  hours: {
    row: {
      deducted:  { bg: '#FBEDEA', on: '#8C1D18' },
      approved:  { bg: '#EDF2F9', on: '#2B5480' },
      paid:      { bg: '#E9F3EC', on: '#255239' },
      pending:   { bg: '#F1EDF8', on: '#453979' },
      incomplete:{ bg: '#FDF3E2', on: '#6B3F00' },
    },
    leave: {
      absence:  '#FBEDEA',
      sick:     '#FDF3E2',
      vacation: '#EDF2F9',
      miluim:   '#F1EDF8',
      holiday:  '#F3EEE6',
    },
  },

  /**
   * The Gantt board.
   *
   * `day.*` is a family: a column heading says at a glance whether that day
   * belongs to this gan, is closed, is a holiday, or is the short Friday —
   * which is the whole reason a planner scans the header row before reading a
   * single cell. `cell.*` are the body washes underneath them, and `note`,
   * `span` and `fixedRow` are the three kinds of block that sit in the grid.
   *
   * `defaultActivity` is the odd one out and is DATA, like ganttCell above: it
   * is written onto an activity when one is created and stored, so changing it
   * would not restyle a single existing activity — it would only make new ones
   * disagree with old ones.
   */
  gantt: {
    header: '#2A241D',
    headerOn: '#FFFFFF',
    day: {
      own:     { bg: '#2A241D', on: '#FFFFFF' },
      other:   { bg: '#6B6157', on: '#FFFFFF' },
      closed:  { bg: '#8A4A12', on: '#FFFFFF' },
      holiday: { bg: '#9A5B00', on: '#FFFFFF' },
      friday:  { bg: '#5B4B9E', on: '#FFFFFF' },
    },
    cell: {
      holiday: '#FDF3E2',
      friday:  '#F1EEF9',
      other:   '#FAF7F2',
    },
    note:     { bg: '#FDF3E2', border: '#F3E2C0', on: '#6B3F00' },
    span:     { bg: '#EDEAF7', border: '#DCD6EF', on: '#453979' },
    fixedRow: { bg: '#FBEFF4', border: '#F2DDE7' },
    defaultActivity: '#dbeafe',

    /**
     * The five kinds of row on the printed plan — פגישה, פעילות, יצירה,
     * סיפור, שונות. On a sheet pinned to a wall and read across a room the
     * tint is what separates one band from the next, so the five have to stay
     * apart from each other, and `ink` has to hold up printed.
     */
    row: {
      meeting:  { bg: '#EEF3FA', label: '#DCE8F5', ink: '#2B5480' },
      activity: { bg: '#EDF5EF', label: '#DBEBE0', ink: '#255239' },
      creation: { bg: '#FBEFF4', label: '#F4DAE5', ink: '#8A2F54' },
      story:    { bg: '#FBF6E4', label: '#F5EAC4', ink: '#6B4A00' },
      misc:     { bg: '#F2EFFA', label: '#E4DFF2', ink: '#453979' },
    },
  },

  /**
   * The six highlight colours a gan can paint a Gantt cell with.
   *
   * THE VALUES ARE DATA, NOT STYLE, AND THEY DO NOT CHANGE. When somebody
   * marks a week yellow the hex itself is written to the cell and stored, so
   * a prettier yellow here would not restyle those cells — it would leave
   * every one already painted holding a colour no longer in the picker, and
   * the plan a gan built last August would come back in colours nobody chose.
   *
   * They live here for the same reason everything else does — one place, and
   * the next colour anybody adds gets measured — but changing one is a data
   * migration, not a design decision.
   */
  ganttCell: [
    { label: 'צהוב', value: '#fef9c3' },
    { label: 'ירוק', value: '#dcfce7' },
    { label: 'כחול', value: '#dbeafe' },
    { label: 'ורוד', value: '#fce7f3' },
    { label: 'סגול', value: '#ede9fe' },
    { label: 'כתום', value: '#ffedd5' },
  ],

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
  /**
   * Four durations, not one.
   *
   * A single 180ms for everything is not a motion language, it is a default —
   * too slow for a hover, too fast for twelve rows opening, and it read as
   * mechanical because it was. These are the four things this app actually
   * animates.
   */
  duration: {
    instant: 90,   // background, colour, border — feedback you should not notice
    fast: 140,     // hover, focus, a control changing state
    base: 200,     // a section opening, a dialog, a panel
    slow: 300,     // a list arriving, a row closing after it is resolved
  },
  /**
   * Two curves. A symmetric ease in both directions is the other half of why
   * an interface feels like a machine: things that arrive should decelerate
   * into place, and things that leave should not linger.
   */
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0.2, 0, 0, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
};
