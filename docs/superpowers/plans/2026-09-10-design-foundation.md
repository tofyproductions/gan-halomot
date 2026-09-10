# Design Foundation (theme + shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the staff app's theme and navigation shell so every screen inherits one palette, one type scale, one radius system and a fixed sidebar built from the existing permission config — without editing a single screen component.

**Architecture:** Colours, spacing, radii and type live in `client/src/theme/tokens.js`, a module with zero imports so a plain node script can import and assert it. `rtlTheme.js` becomes a builder over those tokens and holds no colour literals of its own. The navigation model is extracted from `Header.jsx` into a pure `buildNavModel(user)` in `client/src/config/nav.js`, tested for permission parity, and rendered by a new `Sidebar`. `AppShell` replaces `Layout.jsx`.

**Tech Stack:** React 18, MUI 6 (`@mui/material`), Emotion + `stylis-plugin-rtl`, Vite 6. Tests are plain node scripts under `server/scripts/`, matching the repo's existing convention (`node scripts/*.test.js`, no framework).

**Spec:** `docs/superpowers/specs/2026-09-10-staff-design-system-design.md`

## Global Constraints

- **Never change a tab `id`** in `client/src/config/tabs.js`. They are permission keys stored per user in `User.tab_overrides_*`.
- **Never change a route path** in `client/src/App.jsx`.
- **Never edit `server/`** except to add test scripts under `server/scripts/` and register them in `server/package.json`.
- **Never touch `client/src/components/parent-portal/**` or `client/src/theme/parentTheme.js`.**
- **No colour literal (`#rrggbb`, `rgb(`, `rgba(`) may appear in `client/src/theme/rtlTheme.js`, `client/src/theme/tokens.js` excepted.** Enforced by a test in Task 3.
- **Primary action colour is `#B4540A`** with white text (4.97:1). `#f59e0b` is `primary.light` only and never carries text.
- All new components go in `client/src/components/ui/` except the shell, which goes in `client/src/components/layout/`.
- Work happens in the worktree `gan-halomot-design` on branch `feat/design-system`. Never commit to `main`.

---

### Task 1: The token module

**Files:**
- Create: `client/src/theme/tokens.js`
- Create: `server/scripts/design-tokens.test.js`
- Modify: `server/package.json` (add `test:design-tokens` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `client/src/theme/tokens.js` default-exports nothing; it named-exports `COLOR`, `RADIUS`, `SPACING_UNIT`, `TYPE`, `MOTION`. `COLOR` is a nested object of hex strings. Task 2 and Task 5 import these.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/design-tokens.test.js`:

```js
#!/usr/bin/env node
/**
 * The design tokens are the one place a colour is allowed to be written down,
 * so this is the one place their contrast is checked.
 *
 * The staff theme shipped `primary.main: '#f59e0b'` with white text for two
 * years — 2.2:1, failing WCAG AA on every contained primary button in the
 * app. Nobody noticed because nothing measured it. This does.
 *
 * tokens.js imports nothing, which is what lets this CommonJS script pull an
 * ESM module in with a dynamic import.
 *
 *   node scripts/design-tokens.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const TOKENS = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'theme', 'tokens.js')
).href;

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  console.log('=== אסימוני עיצוב: ניגודיות ושלמות ===\n');
  const { COLOR, RADIUS, SPACING_UNIT, TYPE, MOTION } = await import(TOKENS);

  console.log('נוכחות:');
  for (const key of ['sidebar', 'background', 'text', 'primary', 'success', 'warning', 'error', 'info', 'divider']) {
    ok(COLOR[key] !== undefined, `COLOR.${key} קיים`);
  }
  ok(typeof SPACING_UNIT === 'number' && SPACING_UNIT === 8, 'SPACING_UNIT = 8');
  ok(RADIUS && RADIUS.control === 6 && RADIUS.surface === 8 && RADIUS.pill === 999, 'סולם פינות: 6 / 8 / 999');
  ok(TYPE && TYPE.fontFamily && !/Varela/i.test(TYPE.fontFamily), 'משפחת גופנים אחת, בלי Varela Round');
  ok(MOTION && MOTION.duration >= 150 && MOTION.duration <= 250, 'משך תנועה 150–250ms');

  console.log('\nניגודיות טקסט (מינימום AA = 4.5):');
  const AA = 4.5;
  const pairs = [
    ['primary.contrastText על primary.main', COLOR.primary.contrastText, COLOR.primary.main],
    ['success.contrastText על success.main', COLOR.success.contrastText, COLOR.success.main],
    ['warning.contrastText על warning.main', COLOR.warning.contrastText, COLOR.warning.main],
    ['error.contrastText על error.main', COLOR.error.contrastText, COLOR.error.main],
    ['info.contrastText על info.main', COLOR.info.contrastText, COLOR.info.main],
    ['text.primary על background.paper', COLOR.text.primary, COLOR.background.paper],
    ['text.primary על background.default', COLOR.text.primary, COLOR.background.default],
    ['text.secondary על background.paper', COLOR.text.secondary, COLOR.background.paper],
    ['text.secondary על background.default', COLOR.text.secondary, COLOR.background.default],
    ['sidebar.fg על sidebar.bg', COLOR.sidebar.fg, COLOR.sidebar.bg],
    ['sidebar.fgActive על sidebar.bgActive', COLOR.sidebar.fgActive, COLOR.sidebar.bgActive],
    ['sidebar.groupLabel על sidebar.bg', COLOR.sidebar.groupLabel, COLOR.sidebar.bg],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    ok(ratio >= AA, `${label} — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  console.log('\nניגודיות תגיות רכות:');
  for (const role of ['success', 'warning', 'error', 'info']) {
    const ratio = contrast(COLOR[role].softOn, COLOR[role].soft);
    ok(ratio >= AA, `${role}.softOn על ${role}.soft — ${ratio.toFixed(2)}:1`, `נדרש ${AA}`);
  }

  console.log('\nהצבע הישן לא חזר:');
  ok(COLOR.primary.main.toLowerCase() !== '#f59e0b',
    'primary.main אינו הכתום שנכשל בניגודיות');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/scripts/design-tokens.test.js`
Expected: FAIL — `Cannot find module .../client/src/theme/tokens.js`

- [ ] **Step 3: Write the tokens**

Create `client/src/theme/tokens.js`:

```js
/**
 * The only file in the client allowed to write a colour down.
 *
 * Everything else — the theme, the shell, every screen — names a token. That
 * is not tidiness for its own sake: the app currently carries 799 hex literals
 * typed into components, which is why six stat tiles ended up in six colours
 * and why a primary button spent two years failing contrast at 2.2:1 without
 * anyone being able to see it in one place.
 *
 * IMPORTS NOTHING, DELIBERATELY. server/scripts/design-tokens.test.js pulls
 * this module in with a dynamic import and measures every pair below; an
 * import of @mui or of anything else in the client tree would break that.
 *
 * Every text-on-fill pair here passes WCAG AA (4.5:1). The test is what makes
 * that a fact rather than an intention.
 */

/** The rail is warm near-black, not blue-black: a cold grey beside the brand amber reads as a rendering fault. */
const SIDEBAR = {
  bg: '#1C1917',
  fg: '#D6D3D1',
  fgActive: '#FFFFFF',
  bgActive: '#292524',
  // Brand amber, on dark, carrying no text of its own — the one place the
  // original #f59e0b survives at full strength.
  marker: '#F59E0B',
  groupLabel: '#A8A29E',
};

export const COLOR = {
  sidebar: SIDEBAR,

  background: {
    default: '#F4F4F2',
    paper: '#FFFFFF',
  },

  text: {
    primary: '#1B1917',
    secondary: '#6B6560',
    disabled: '#A8A29E',
  },

  divider: '#E7E5E4',

  /**
   * Clay, not amber. #f59e0b behind white text measures 2.2:1; this is 4.97:1,
   * the same value the parent portal already proved in production. The bright
   * amber survives as `light`, for fills that never carry text.
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

  /** Row tints. A row that needs attention is tinted; a row that is fine is white. */
  row: {
    attention: '#FFF7ED',
    selected: '#FDF0E6',
    hover: '#FAFAF9',
  },
};

export const SPACING_UNIT = 8;

/**
 * One radius scale, and only these three. Mixed systems — pill buttons beside
 * square cards — are what make an interface look assembled rather than designed.
 */
export const RADIUS = {
  control: 6,   // inputs, buttons, menu items
  surface: 8,   // cards, tables, panels, dialogs
  pill: 999,    // filter chips and badges only
};

/**
 * One family. A display face (the outgoing Varela Round, at weight 900 on h1
 * and h2) in product-UI labels is noise: hierarchy here comes from weight and
 * colour, not from a second typeface.
 *
 * Fixed rem steps, never fluid. Staff view this at consistent DPI, and a
 * heading that resizes with the viewport makes a laptop and a desktop feel
 * like two different applications.
 */
export const TYPE = {
  fontFamily: '"Assistant", system-ui, -apple-system, sans-serif',
  h1: { size: '1.75rem', weight: 700, lineHeight: 1.25, letterSpacing: '-0.01em' },
  h2: { size: '1.5rem',  weight: 700, lineHeight: 1.28, letterSpacing: '-0.01em' },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/scripts/design-tokens.test.js`
Expected: PASS, all checks green. If a contrast pair fails, darken the `main`/`softOn` value until it clears 4.5 — do not lower the threshold.

- [ ] **Step 5: Register the test**

In `server/package.json`, add to `scripts`:

```json
"test:design-tokens": "node scripts/design-tokens.test.js",
```

- [ ] **Step 6: Commit**

```bash
git add client/src/theme/tokens.js server/scripts/design-tokens.test.js server/package.json
git commit -m "feat(design): design tokens, with their contrast measured

The staff theme has shipped primary.main #f59e0b behind white text since the
beginning — 2.2:1, failing AA on every contained primary button in the app.
Nothing measured it, so nobody saw it.

tokens.js is now the only file allowed to write a colour down, and it imports
nothing so a plain node script can pull it in and check every text-on-fill
pair it declares. Primary becomes the clay the parent portal already proved at
4.97:1; the bright amber stays on as primary.light, for fills without text."
```

---

### Task 2: The theme, built from tokens

**Files:**
- Modify: `client/src/theme/rtlTheme.js` (full rewrite, 160 lines)

**Interfaces:**
- Consumes: `COLOR`, `RADIUS`, `SPACING_UNIT`, `TYPE`, `MOTION` from Task 1.
- Produces: default export `theme` (MUI theme) and named export `cacheRtl`, both unchanged in name and shape so `RTLProvider.jsx` needs no edit.

- [ ] **Step 1: Rewrite the theme**

Replace the whole of `client/src/theme/rtlTheme.js`:

```js
import { createTheme } from '@mui/material/styles';
import createCache from '@emotion/cache';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';
import { COLOR, RADIUS, SPACING_UNIT, TYPE, MOTION } from './tokens';

export const cacheRtl = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin],
});

const t = (v) => ({ fontSize: v.size, fontWeight: v.weight, lineHeight: v.lineHeight, ...(v.letterSpacing ? { letterSpacing: v.letterSpacing } : {}) });

const transition = `${MOTION.duration}ms ${MOTION.easing}`;

/**
 * Depth is a hairline, not a shadow.
 *
 * A card here sits on #F4F4F2 and is white; that difference plus a 1px rule is
 * all the elevation a panel needs, and it survives being printed, screenshotted
 * and looked at on a bad monitor in a gan office. Shadows are kept for things
 * that genuinely float above the page — menus, dialogs, the detail panel — and
 * are tinted warm, because a neutral black shadow on a warm ground reads dirty.
 */
const FLOAT_SHADOW = '0 4px 6px -2px rgba(28,25,23,0.05), 0 12px 28px -8px rgba(28,25,23,0.16)';

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
    action: {
      hover: COLOR.row.hover,
      selected: COLOR.row.selected,
    },
  },

  // Reachable from any component as theme.sidebar / theme.soft / theme.row.
  // Not in `palette` because none of these is a semantic MUI role.
  sidebar: COLOR.sidebar,
  row: COLOR.row,
  soft: {
    primary: { bg: COLOR.primary.soft, fg: COLOR.primary.softOn },
    success: { bg: COLOR.success.soft, fg: COLOR.success.softOn },
    warning: { bg: COLOR.warning.soft, fg: COLOR.warning.softOn },
    error: { bg: COLOR.error.soft, fg: COLOR.error.softOn },
    info: { bg: COLOR.info.soft, fg: COLOR.info.softOn },
  },

  typography: {
    fontFamily: TYPE.fontFamily,
    h1: t(TYPE.h1), h2: t(TYPE.h2), h3: t(TYPE.h3),
    h4: t(TYPE.h4), h5: t(TYPE.h5), h6: t(TYPE.h6),
    body1: t(TYPE.body1), body2: t(TYPE.body2),
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
         * sentence reorders on screen unless it is isolated. Every number in
         * this app is one of those three, so isolation is a default rather
         * than something each screen remembers.
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
          '&:hover': { borderColor: COLOR.text.disabled, backgroundColor: COLOR.row.hover },
        },
        sizeSmall: { padding: '4px 12px', minHeight: 30 },
      },
    },

    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: RADIUS.control,
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
          boxShadow: 'none',
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

    MuiTableContainer: {
      styleOverrides: {
        root: { borderRadius: RADIUS.surface, border: `1px solid ${COLOR.divider}` },
      },
    },

    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            backgroundColor: COLOR.background.default,
            color: COLOR.text.secondary,
            fontWeight: TYPE.columnHead.weight,
            fontSize: TYPE.columnHead.size,
            borderBottom: `1px solid ${COLOR.divider}`,
            whiteSpace: 'nowrap',
            padding: '9px 12px',
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
          // actually mean something (a row needing attention, a row selected).
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
        root: { fontWeight: 500, fontSize: TYPE.caption.size, borderRadius: RADIUS.pill },
        sizeSmall: { height: 22, fontSize: '0.6875rem' },
        outlined: { borderColor: COLOR.divider },
      },
    },

    MuiAlert: {
      styleOverrides: { root: { borderRadius: RADIUS.control, fontSize: TYPE.body2.size } },
    },

    MuiDialog: {
      styleOverrides: { paper: { borderRadius: RADIUS.surface, boxShadow: FLOAT_SHADOW } },
    },

    MuiDialogTitle: {
      styleOverrides: { root: { ...t(TYPE.h4), paddingBottom: 8 } },
    },

    MuiMenu: {
      styleOverrides: { paper: { borderRadius: RADIUS.surface, border: `1px solid ${COLOR.divider}`, boxShadow: FLOAT_SHADOW } },
    },

    MuiTooltip: {
      styleOverrides: { tooltip: { fontSize: TYPE.caption.size, borderRadius: RADIUS.control, padding: '5px 10px' } },
    },

    MuiTab: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, fontSize: TYPE.body2.size, minHeight: 42 },
      },
    },
  },
});

export default theme;
```

- [ ] **Step 2: Verify the app still boots**

Run the demo server and the client:

```bash
npm --prefix server run demo:viewer
```

In a second shell: `npm --prefix client run dev`

Open `http://localhost:5173`, sign in as `אורי מנהל (הדגמה)` / ת״ז `900000001` / password `demo1234`.
Expected: the app renders, the login button is clay rather than gradient amber, tables are hairline-bordered.

- [ ] **Step 3: Walk every route and record breakages**

Visit each path in `client/src/App.jsx` that the demo admin can reach. For each, note in a scratch file: renders / does not render, and any element that is now unreadable (text on a fill that changed under it).

This list is the input to the stage-3 screen work. Do not fix screens here.

- [ ] **Step 4: Commit**

```bash
git add client/src/theme/rtlTheme.js
git commit -m "feat(design): rebuild the staff theme on the tokens

Same exports, same file, so RTLProvider and every screen keep working — what
changes is that the theme now holds no colour of its own, the primary button
loses its gradient, cards lose their two-layer shadow for a hairline, and the
table head sticks.

Numbers get a .num class in CssBaseline: an Israeli ID or a phone number
inside an RTL sentence reorders on screen without unicode-bidi isolation, and
every screen was solving that alone or not at all."
```

---

### Task 3: The hex-literal ratchet

**Files:**
- Create: `server/scripts/design-hex-budget.test.js`
- Create: `docs/design/hex-budget.json`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: nothing at runtime; scans `client/src/**` as text.
- Produces: a test that fails when the count of colour literals in the client rises. `docs/design/hex-budget.json` holds `{ "total": <n>, "recorded": "<ISO date>" }`.

**Why this task exists:** the spec's headline number is 799 hex literals going to zero across 152 screens, over many sessions and probably several people. Without a ratchet that number drifts back up the first time somebody is in a hurry. This makes it mechanical.

- [ ] **Step 1: Write the test**

Create `server/scripts/design-hex-budget.test.js`:

```js
#!/usr/bin/env node
/**
 * A one-way ratchet on hand-written colour in the client.
 *
 * The staff app carries hundreds of hex literals typed straight into
 * components, which is the direct cause of six stat tiles in six colours and
 * of a table that styles itself differently on every screen. They come out
 * screen by screen, over a long time — and anything that comes out slowly
 * goes back in quietly unless something counts.
 *
 * So: count them, keep the number in docs/design/hex-budget.json, and fail
 * when it grows. Lowering it is the point; the test prints the new number to
 * paste in whenever it drops.
 *
 * theme/tokens.js is exempt. It is the file whose job is to hold colours.
 *
 *   node scripts/design-hex-budget.test.js
 */
const fs = require('fs');
const path = require('path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const BUDGET_FILE = path.join(__dirname, '..', '..', 'docs', 'design', 'hex-budget.json');

// The parent portal was designed separately and deliberately, and its theme
// factory is allowed its own colours for the same reason tokens.js is.
const EXEMPT = [
  path.join('theme', 'tokens.js'),
  path.join('theme', 'parentTheme.js'),
  path.join('components', 'parent-portal') + path.sep,
];

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  console.log('=== תקציב צבעים קשיחים בצד הלקוח ===\n');

  const files = walk(CLIENT_SRC).filter((f) => {
    const rel = path.relative(CLIENT_SRC, f);
    return !EXEMPT.some((e) => rel === e || rel.startsWith(e));
  });

  const perFile = [];
  let total = 0;
  for (const f of files) {
    const n = (fs.readFileSync(f, 'utf8').match(COLOUR) || []).length;
    if (n > 0) { perFile.push([path.relative(CLIENT_SRC, f), n]); total += n; }
  }
  perFile.sort((a, b) => b[1] - a[1]);

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));

  console.log(`נמצאו ${total} צבעים קשיחים ב-${perFile.length} קבצים.`);
  console.log(`התקציב הרשום: ${budget.total} (נרשם ${budget.recorded})\n`);
  console.log('עשרת הקבצים הגדולים:');
  for (const [rel, n] of perFile.slice(0, 10)) console.log(`  ${String(n).padStart(4)}  ${rel}`);

  if (total > budget.total) {
    console.log(`\n❌ עלה ב-${total - budget.total}. צבע חדש נכתב ידנית במקום אסימון.`);
    process.exit(1);
  }
  if (total < budget.total) {
    console.log(`\n✅ ירד ב-${budget.total - total}. עדכן את docs/design/hex-budget.json ל-${total}.`);
    process.exit(0);
  }
  console.log('\n✅ ללא שינוי.');
  process.exit(0);
}

main();
```

- [ ] **Step 2: Run it to learn the current number**

Run: `node server/scripts/design-hex-budget.test.js`
Expected: FAIL — `ENOENT ... docs/design/hex-budget.json`. Note the total it printed before failing; if it exits before printing, create the file with `{"total": 99999, "recorded": "2026-09-10"}` first and re-run to read the real count.

- [ ] **Step 3: Record the budget**

Create `docs/design/hex-budget.json` with the number the test just printed:

```json
{
  "total": 0,
  "recorded": "2026-09-10",
  "note": "Hand-written colour literals in client/src, excluding theme/tokens.js and the parent portal. Only ever goes down. server/scripts/design-hex-budget.test.js enforces it."
}
```

Replace `0` with the real count.

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/scripts/design-hex-budget.test.js`
Expected: PASS, "ללא שינוי".

- [ ] **Step 5: Register and commit**

In `server/package.json` add:

```json
"test:design-hex": "node scripts/design-hex-budget.test.js",
```

```bash
git add server/scripts/design-hex-budget.test.js docs/design/hex-budget.json server/package.json
git commit -m "test(design): a one-way ratchet on hand-written colour

Taking hundreds of hex literals out of 152 screens is slow work spread over
many sessions, and slow work reverses quietly. This counts them, keeps the
number in docs/design/hex-budget.json, and fails when it grows."
```

---

### Task 4: The navigation model

**Files:**
- Create: `client/src/config/nav.js`
- Create: `server/scripts/nav-model.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `TAB_GROUPS`, `hasTabAccess` from `client/src/config/tabs.js` (unchanged).
- Produces: `buildNavModel(user)` returning `[{ label: string, items: [{ id, label, path }] }]` — groups with no visible item are dropped, and items with `path: null` (write grants) are never included. Task 5 renders this.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/nav-model.test.js`:

```js
#!/usr/bin/env node
/**
 * The rail is about to become the only way to reach a screen, so the set of
 * screens it draws has to be exactly the set the old dropdowns drew — no more,
 * and no fewer.
 *
 * Two failure modes are worth a test of their own. A write grant is a tab id
 * with `path: null` (clicktac_write is the permission to act on רישום חיצוני,
 * not a screen); drawing it puts a dead entry in the menu. And a group whose
 * every item is hidden from this role must disappear rather than leave a
 * heading over nothing.
 *
 *   node scripts/nav-model.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const NAV = pathToFileURL(path.join(__dirname, '..', '..', 'client', 'src', 'config', 'nav.js')).href;
const TABS = pathToFileURL(path.join(__dirname, '..', '..', 'client', 'src', 'config', 'tabs.js')).href;

let failures = 0;
let checks = 0;
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`); }
  return !!cond;
}

const user = (role, extra = {}) => ({ role, tab_overrides_add: [], tab_overrides_remove: [], ...extra });

async function main() {
  console.log('=== מודל הניווט של סרגל הצד ===\n');
  const { buildNavModel } = await import(NAV);
  const { TAB_GROUPS, hasTabAccess } = await import(TABS);

  const flat = (model) => model.flatMap((g) => g.items.map((i) => i.id));

  console.log('התאמה להרשאות הקיימות:');
  for (const role of ['system_admin', 'admin_viewer', 'branch_manager', 'accountant', 'teacher']) {
    const u = user(role);
    const expected = TAB_GROUPS
      .flatMap((g) => g.items)
      .filter((i) => i.path && hasTabAccess(u, i.id))
      .map((i) => i.id);
    const got = flat(buildNavModel(u));
    ok(
      expected.length === got.length && expected.every((id, n) => got[n] === id),
      `${role}: ${got.length} מסכים, זהה ל-hasTabAccess`,
      `ציפינו ל-${expected.length}`
    );
  }

  console.log('\nמענקי כתיבה אינם מסכים:');
  const admin = user('system_admin');
  ok(!flat(buildNavModel(admin)).includes('clicktac_write'),
    'clicktac_write לא מופיע בתפריט');
  const nullPathIds = TAB_GROUPS.flatMap((g) => g.items).filter((i) => !i.path).map((i) => i.id);
  ok(nullPathIds.every((id) => !flat(buildNavModel(admin)).includes(id)),
    `אף פריט ללא path לא מופיע (${nullPathIds.length} כאלה)`);

  console.log('\nקבוצות ריקות נעלמות:');
  const model = buildNavModel(user('teacher'));
  ok(model.every((g) => g.items.length > 0), 'אין קבוצה בלי פריטים');
  ok(model.length < TAB_GROUPS.length, 'מורה רואה פחות קבוצות ממנהל מערכת');

  console.log('\nעקיפות אישיות נשמרות:');
  const granted = user('teacher', { tab_overrides_add: ['pricing'] });
  ok(flat(buildNavModel(granted)).includes('pricing'),
    'מסך שהוענק ידנית מופיע');
  const revoked = user('system_admin', { tab_overrides_remove: ['pricing'] });
  ok(!flat(buildNavModel(revoked)).includes('pricing'),
    'מסך שנשלל ידנית לא מופיע');

  console.log('\nצורת המודל:');
  ok(model.every((g) => typeof g.label === 'string' && Array.isArray(g.items)),
    'כל קבוצה: label + items');
  ok(model.every((g) => g.items.every((i) => i.id && i.label && i.path)),
    'כל פריט: id + label + path');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} עברו\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/scripts/nav-model.test.js`
Expected: FAIL — `Cannot find module .../client/src/config/nav.js`

- [ ] **Step 3: Write the nav model**

Create `client/src/config/nav.js`:

```js
/**
 * What the sidebar draws, for one person.
 *
 * Kept apart from the component that renders it, and free of MUI imports, so
 * the question "does this role see exactly the screens it saw before" is
 * answerable by a test rather than by clicking through the app as five
 * different users (server/scripts/nav-model.test.js).
 *
 * TAB_GROUPS stays the single source of truth and is not modified here: this
 * is a filter over it, in its order.
 */
import { TAB_GROUPS, hasTabAccess } from './tabs';

/**
 * @param {{role: string, tab_overrides_add?: string[], tab_overrides_remove?: string[]}} user
 * @returns {{label: string, items: {id: string, label: string, path: string}[]}[]}
 */
export function buildNavModel(user) {
  if (!user) return [];

  return TAB_GROUPS
    .map((group) => ({
      label: group.label,
      items: group.items
        // `path: null` marks a write grant — a permission that is stored and
        // checked exactly like a tab but is not a place you can navigate to.
        // Drawing one puts an entry in the menu that goes nowhere.
        .filter((item) => item.path && hasTabAccess(user, item.id))
        .map(({ id, label, path }) => ({ id, label, path })),
    }))
    // A heading with nothing under it is worse than a missing heading: it
    // tells someone the screens exist and that they may not have them.
    .filter((group) => group.items.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/scripts/nav-model.test.js`
Expected: PASS, all checks green.

- [ ] **Step 5: Register and commit**

Add to `server/package.json` scripts:

```json
"test:nav-model": "node scripts/nav-model.test.js",
```

```bash
git add client/src/config/nav.js server/scripts/nav-model.test.js server/package.json
git commit -m "feat(nav): the sidebar's model, as a pure function with a test

The rail is about to be the only way to reach a screen, so what it draws has
to be exactly what the dropdowns drew. Pulling the filter out of the component
makes that a test instead of a click-through as five different users — and it
pins the two things that were easy to get wrong: a write grant (path: null) is
not a screen, and a group with nothing under it does not draw a heading."
```

---

### Task 5: The Sidebar

**Files:**
- Create: `client/src/components/layout/Sidebar.jsx`
- Create: `client/src/components/layout/navIcons.js`
- Create: `client/src/components/layout/AccountMenu.jsx`

**Interfaces:**
- Consumes: `buildNavModel` (Task 4), `COLOR` (Task 1), `useAuth`, `useBranch`, `usePendingProposals`, `useNewLeadsCount`.
- Produces: `<Sidebar />` and `export const SIDEBAR_WIDTH = 224`. Self-contained — it reads its own hooks and owns its own account dialog. Task 6 mounts it and nothing more.

- [ ] **Step 1: Move the icon map out of Header**

Create `client/src/components/layout/navIcons.js`. Copy the whole `ICON_BY_TAB` object from `client/src/components/layout/Header.jsx:48-79` and its MUI icon imports (`Header.jsx:9-36`) verbatim, then extend it so **every** tab id in `config/tabs.js` that has a `path` is covered. The existing map covers roughly half; a missing icon in a rail of forty entries reads as a broken row, not as a neutral one.

Export it as `export const ICON_BY_TAB = { ... }` plus:

```js
import CircleOutlinedIcon from '@mui/icons-material/CircleOutlined';

/** Never returns undefined: an unknown id gets a neutral mark, not a gap. */
export function iconFor(tabId) {
  return ICON_BY_TAB[tabId] || CircleOutlinedIcon;
}
```

- [ ] **Step 2: Write the Sidebar**

Create `client/src/components/layout/Sidebar.jsx`:

```jsx
import { useMemo } from 'react';
import { Box, Typography, Select, MenuItem, Tooltip, Badge, IconButton, Avatar } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import LogoutIcon from '@mui/icons-material/Logout';
import SettingsIcon from '@mui/icons-material/Settings';
import { buildNavModel } from '../../config/nav';
import { iconFor } from './navIcons';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import { usePendingProposals } from '../../hooks/usePendingProposals';
import { useNewLeadsCount } from '../../hooks/useNewLeadsCount';

export const SIDEBAR_WIDTH = 224;

/** Badges hang off tab ids rather than off a screen, so a screen never has to know it is counted. */
function useBadges() {
  const pendingProposals = usePendingProposals();
  const newLeads = useNewLeadsCount();
  return useMemo(
    () => ({ proposed_changes: pendingProposals, leads: newLeads }),
    [pendingProposals, newLeads]
  );
}

export default function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout, canSeeAllBranches } = useAuth();
  const { branches, selectedBranch, changeBranch } = useBranch();
  const badges = useBadges();
  const model = useMemo(() => buildNavModel(user), [user]);

  return (
    <Box
      component="nav"
      aria-label="ניווט ראשי"
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: '100dvh',
        position: 'sticky',
        top: 0,
        bgcolor: 'sidebar.bg',
        color: 'sidebar.fg',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        px: 1.25,
        py: 1.75,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.75, mb: 1.5 }}>
        <Box sx={{ width: 26, height: 26, borderRadius: 1.25, bgcolor: 'sidebar.marker' }} />
        <Typography sx={{ color: 'sidebar.fgActive', fontWeight: 700, fontSize: '0.9375rem' }}>
          גן החלומות
        </Typography>
      </Box>

      {canSeeAllBranches && branches.length > 1 && (
        <Select
          value={selectedBranch || ''}
          onChange={(e) => changeBranch(e.target.value)}
          size="small"
          aria-label="בחירת סניף"
          sx={{
            mb: 1.5,
            bgcolor: 'sidebar.bgActive',
            color: 'sidebar.fgActive',
            fontSize: '0.8125rem',
            '& fieldset': { border: 'none' },
            '& .MuiSvgIcon-root': { color: 'sidebar.fg' },
          }}
        >
          {branches.map((b) => (
            <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
          ))}
        </Select>
      )}

      <Box sx={{ flex: 1 }}>
        {model.map((group) => (
          <Box key={group.label} sx={{ mb: 1.25 }}>
            <Typography
              component="div"
              sx={{
                px: 1, pt: 0.75, pb: 0.25,
                fontSize: '0.625rem',
                letterSpacing: '0.06em',
                color: 'sidebar.groupLabel',
              }}
            >
              {group.label}
            </Typography>

            {group.items.map((item) => {
              const Icon = iconFor(item.id);
              const active = pathname === item.path;
              const count = badges[item.id] || 0;
              return (
                <Box
                  key={item.id}
                  component="button"
                  onClick={() => navigate(item.path)}
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1, py: 0.75,
                    border: 0,
                    cursor: 'pointer',
                    textAlign: 'inherit',
                    borderRadius: 1,
                    fontSize: '0.8125rem',
                    fontFamily: 'inherit',
                    color: active ? 'sidebar.fgActive' : 'sidebar.fg',
                    fontWeight: active ? 600 : 400,
                    bgcolor: active ? 'sidebar.bgActive' : 'transparent',
                    borderRight: active ? '2px solid' : '2px solid transparent',
                    borderRightColor: active ? 'sidebar.marker' : 'transparent',
                    '&:hover': { bgcolor: 'sidebar.bgActive' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'sidebar.marker', outlineOffset: -2 },
                  }}
                >
                  <Icon sx={{ fontSize: 17, opacity: active ? 1 : 0.75 }} />
                  <Box component="span" sx={{ flex: 1 }}>{item.label}</Box>
                  {count > 0 && (
                    <Badge
                      badgeContent={count}
                      sx={{ '& .MuiBadge-badge': { position: 'static', transform: 'none', bgcolor: 'sidebar.marker', color: 'sidebar.bg', fontWeight: 700 } }}
                    />
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.75, pt: 1, mt: 'auto' }}>
        <Avatar sx={{ width: 26, height: 26, fontSize: '0.75rem', bgcolor: 'sidebar.bgActive', color: 'sidebar.fgActive' }}>
          {(user?.full_name || '?').trim().charAt(0)}
        </Avatar>
        <Box component="span" sx={{ flex: 1, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user?.full_name || user?.email}
        </Box>
        <Tooltip title="חשבון והגדרות">
          <IconButton size="small" onClick={() => setAccountOpen(true)} sx={{ color: 'sidebar.fg' }} aria-label="חשבון והגדרות">
            <SettingsIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="התנתק">
          <IconButton size="small" onClick={logout} sx={{ color: 'sidebar.fg' }} aria-label="התנתק">
            <LogoutIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <AccountMenu open={accountOpen} onClose={() => setAccountOpen(false)} />
    </Box>
  );
}
```

Add to the imports at the top of the file:

```jsx
import { useMemo, useState } from 'react';
import AccountMenu from './AccountMenu';
```

and to the component body, beside the other hooks:

```jsx
const [accountOpen, setAccountOpen] = useState(false);
```

- [ ] **Step 3: Write the AccountMenu**

`Header.jsx` kept two things in the foot of its drawer that are not navigation: WebAuthn biometric enrolment, and `<DeleteAccountRequest />`. They belong to the person, not to a screen, so they go in a dialog off the gear.

**They must not go to `/account`.** That route is `MyAccount.jsx`, the gan's commercial screen — what they pay and why — and `App.jsx:257` gates it to `system_admin`. Putting fingerprint enrolment behind it would take it from every branch manager, teacher and assistant, which is exactly the group that signs in on a phone.

Create `client/src/components/layout/AccountMenu.jsx`:

```jsx
import { Dialog, DialogTitle, DialogContent, Button, Stack, Divider } from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import DeleteAccountRequest from '../shared/DeleteAccountRequest';

export default function AccountMenu({ open, onClose }) {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();

  // Copy handleSetupBiometric out of Header.jsx verbatim — its startRegistration
  // import, its api calls, its toast messages, and both its failure paths.
  const handleSetupBiometric = async () => { /* ← from Header.jsx */ };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{user?.full_name || user?.email}</DialogTitle>
      <DialogContent>
        <Stack spacing={1} sx={{ pb: 1 }}>
          <Button startIcon={<FingerprintIcon />} onClick={handleSetupBiometric} fullWidth
                  variant="outlined" sx={{ justifyContent: 'flex-start' }}>
            הפעלת כניסה בטביעת אצבע
          </Button>

          {/* Only the admin has this route. Offering a door that answers with a
              permission error is worse than not offering it. */}
          {isAdmin && (
            <Button startIcon={<ReceiptLongIcon />} onClick={() => { onClose(); navigate('/account'); }}
                    fullWidth variant="outlined" sx={{ justifyContent: 'flex-start' }}>
              המנוי והחיוב של הגן
            </Button>
          )}

          <Divider sx={{ pt: 1 }} />
          <DeleteAccountRequest />
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Verify against the old menu, role by role**

Run `node server/scripts/nav-model.test.js` — it must still pass.

Then in the browser, for each demo login (`900000001` admin, `900000002` accountant, `900000003` viewer, `900000004` branch manager, all `demo1234`), confirm the rail lists the same screens the old dropdowns did, and that the gear offers fingerprint enrolment to every one of them.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layout/Sidebar.jsx client/src/components/layout/navIcons.js client/src/components/layout/AccountMenu.jsx
git commit -m "feat(nav): the sidebar

Every screen a person may open, visible at once and grouped as TAB_GROUPS
already groups them, instead of two clicks and a guess behind a category
dropdown. Badges hang off tab ids, so a screen never has to know it is counted.

The icon map moves out of Header.jsx and is completed: it covered about half
the tabs, and a missing icon in a rail of forty entries reads as a broken row
rather than a neutral one.

Fingerprint enrolment and the account-deletion request come across into a
dialog off the gear, reachable by everyone. They could not go to /account:
that route is the gan's billing screen, gated to system_admin, and the people
who sign in with a fingerprint are the branch managers and teachers on a
phone."
```

---

### Task 6: The AppShell

**Files:**
- Create: `client/src/components/layout/AppShell.jsx`
- Modify: `client/src/App.jsx:2` and `:103` (swap `Layout` for `AppShell`)
- Delete: `client/src/components/layout/Layout.jsx`, `client/src/components/layout/Header.jsx`

**Interfaces:**
- Consumes: `Sidebar`, `SIDEBAR_WIDTH` (Task 5).
- Produces: `<AppShell />` rendering `<Sidebar />` beside an `<Outlet />`. Same position in the route tree `Layout` held, so every child route is unchanged.

- [ ] **Step 1: Inventory what Layout and Header did beyond navigation**

Read both files and list everything mounted there that is not the menu. From the current source that is: `ClassPopupPoller`, `SetPasswordDialog`, `PunchEntryTaskGate`, `MyDecisionsPopup` (in `Layout.jsx:1-10`), and in `Header.jsx` the WebAuthn biometric enrolment and `DeleteAccountRequest`.

Every one of these must survive the swap. The four poller/gate components move to `AppShell` unchanged.

The other two need somewhere to live, and **`/account` is not it.** That route is `MyAccount.jsx`, the gan's commercial screen — what they pay and why — and `App.jsx:257` gates it to `system_admin`. Biometric enrolment put there would vanish for every branch manager, teacher and assistant, which is precisely the group that signs in from a phone and wants it. Account deletion would vanish for everyone who might request it.

They go instead into an `AccountMenu` dialog opened by the gear already in the sidebar's foot: no new route, no permission question, reachable by every signed-in user.

- [ ] **Step 2: Write the AppShell**

Create `client/src/components/layout/AppShell.jsx`:

```jsx
import { Box } from '@mui/material';
import { Outlet } from 'react-router-dom';
import Sidebar, { SIDEBAR_WIDTH } from './Sidebar';
import MobileNav, { MOBILE_NAV_HEIGHT } from './MobileNav';
import ClassPopupPoller from '../classes/ClassPopupPoller';
import SetPasswordDialog from '../shared/SetPasswordDialog';
import PunchEntryTaskGate from '../attendance/PunchEntryTaskGate';
import { MyDecisionsPopup } from '../payroll/MyDecisions';

/**
 * The shell: a fixed rail and everything else.
 *
 * What is gone from here on purpose — four blurred ellipses that drifted
 * across every screen behind the content, a per-branch background tint, and
 * the WIDE_ROUTES list that granted three routes a wider container because
 * the other seventy were capped at 1200px. The workspace is now simply as
 * wide as the window; the tables that needed the exception were the reason
 * for the exception.
 */
export default function AppShell() {
  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Sidebar />
      </Box>

      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          px: { xs: 2, md: 3 },
          py: { xs: 2, md: 2.5 },
          pb: { xs: `calc(${MOBILE_NAV_HEIGHT}px + 16px)`, md: 2.5 },
        }}
      >
        <Outlet />
      </Box>

      <MobileNav />

      {/* Mounted app-wide, exactly as Layout mounted them. */}
      <ClassPopupPoller />
      <SetPasswordDialog />
      <PunchEntryTaskGate />
      <MyDecisionsPopup />
    </Box>
  );
}
```

Note: `SIDEBAR_WIDTH` is imported for the mobile drawer in Task 7; if Task 7 is not yet done, create a placeholder `MobileNav.jsx` exporting `MOBILE_NAV_HEIGHT = 56` and `export default function MobileNav() { return null; }` so this task is independently runnable.

- [ ] **Step 3: Swap it into the route tree**

In `client/src/App.jsx`:

- Line 2: `import Layout from './components/layout/Layout';` → `import AppShell from './components/layout/AppShell';`
- Line 103: `<Layout />` → `<AppShell />`

It sits inside `ConfirmProvider > BranchProvider > WorkMonthProvider > ProtectedRoute`. Leave that nesting exactly as it is — `Sidebar` reads `useBranch`, so it must stay inside `BranchProvider`. Change nothing else: no path, no child route, no ordering.

- [ ] **Step 4: Confirm the two account features already have a home**

Task 5 built `AccountMenu.jsx` and wired the sidebar's gear to it, so the WebAuthn enrolment and `DeleteAccountRequest` are already carried across. Verify here rather than move anything: open the gear as a **non-admin** demo user and confirm fingerprint enrolment is offered. If Task 5 was skipped or stubbed, go back and finish it — deleting `Header.jsx` in Step 5 is what makes the loss permanent.

- [ ] **Step 5: Delete the old shell**

```bash
git rm client/src/components/layout/Layout.jsx client/src/components/layout/Header.jsx
```

Then confirm nothing still imports them:

```bash
grep -rn "layout/Layout\|layout/Header" client/src
```

Expected: no output.

- [ ] **Step 6: Verify**

Run `npm --prefix client run dev` against the demo server. Sign in as each of the four demo users and check:

- Every screen that role had is reachable from the rail.
- The gear opens `AccountMenu` for **all four**, biometric enrolment included — this is the regression Step 4 exists to prevent, so test it as the branch manager (`900000004`), not only as the admin.
- "המנוי והחיוב של הגן" appears for the admin and for nobody else.
- The class popup, set-password dialog, punch gate and decisions popup still appear when their conditions hold.
- No console errors.

- [ ] **Step 7: Commit**

```bash
git add -A client/src/components/layout client/src/App.jsx
git commit -m "feat(shell): the rail replaces the top bar

Layout and Header retire together. Gone with them: four blurred ellipses that
drifted behind every screen, the per-branch background tint, and the
WIDE_ROUTES list that widened three routes because the other seventy were
capped — the workspace is now as wide as the window.

The four app-wide pollers and dialogs move across unchanged. Biometric
enrolment and the account-deletion request move into a dialog off the rail
rather than to /account: that route is the gan's billing screen and is gated
to system_admin, so putting them there would have taken fingerprint login
away from every branch manager and teacher — the people who sign in on a
phone and actually use it."
```

---

### Task 7: The mobile bar

**Files:**
- Create: `client/src/components/layout/MobileNav.jsx` (replacing the Task 6 placeholder)

**Interfaces:**
- Consumes: `buildNavModel` (Task 4), `iconFor` (Task 5).
- Produces: `<MobileNav />` and `export const MOBILE_NAV_HEIGHT = 56`.

- [ ] **Step 1: Write it**

Create `client/src/components/layout/MobileNav.jsx`:

```jsx
import { useMemo, useState } from 'react';
import { Box, Drawer, Typography } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { buildNavModel } from '../../config/nav';
import { iconFor } from './navIcons';
import { useAuth } from '../../hooks/useAuth';

export const MOBILE_NAV_HEIGHT = 56;

/**
 * The four screens that are actually used from a phone, standing in a room:
 * the infant board, what ran out, the punch clock, and the camera roll. The
 * office screens are all still reachable through "עוד" — they are simply not
 * what someone holding a phone in a gan is reaching for.
 *
 * Filtered through the same nav model as the rail, so a role without one of
 * these gets a shorter bar rather than a tab that goes nowhere.
 */
const PHONE_FIRST = ['nursery', 'supplies', 'attendance', 'photos'];

export default function MobileNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const model = useMemo(() => buildNavModel(user), [user]);

  const all = useMemo(() => model.flatMap((g) => g.items), [model]);
  const primary = useMemo(
    () => PHONE_FIRST.map((id) => all.find((i) => i.id === id)).filter(Boolean),
    [all]
  );

  if (all.length === 0) return null;

  const go = (path) => { setMoreOpen(false); navigate(path); };

  const cell = (active) => ({
    flex: 1,
    minHeight: 44,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.25,
    border: 0,
    bgcolor: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.625rem',
    color: active ? 'primary.main' : 'text.secondary',
  });

  return (
    <>
      <Box
        component="nav"
        aria-label="ניווט"
        sx={{
          display: { xs: 'flex', md: 'none' },
          position: 'fixed',
          insetInline: 0,
          bottom: 0,
          height: MOBILE_NAV_HEIGHT,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          zIndex: (t) => t.zIndex.appBar,
          pb: 'env(safe-area-inset-bottom)',
        }}
      >
        {primary.map((item) => {
          const Icon = iconFor(item.id);
          const active = pathname === item.path;
          return (
            <Box component="button" key={item.id} onClick={() => go(item.path)}
                 aria-current={active ? 'page' : undefined} sx={cell(active)}>
              <Icon sx={{ fontSize: 20 }} />
              {item.label}
            </Box>
          );
        })}
        <Box component="button" onClick={() => setMoreOpen(true)} sx={cell(false)} aria-label="עוד מסכים">
          <MoreHorizIcon sx={{ fontSize: 20 }} />
          עוד
        </Box>
      </Box>

      <Drawer anchor="bottom" open={moreOpen} onClose={() => setMoreOpen(false)}
              PaperProps={{ sx: { maxHeight: '80dvh', borderTopLeftRadius: 12, borderTopRightRadius: 12 } }}>
        <Box sx={{ p: 2 }}>
          {model.map((group) => (
            <Box key={group.label} sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: '0.6875rem', color: 'text.secondary', mb: 0.5 }}>
                {group.label}
              </Typography>
              {group.items.map((item) => {
                const Icon = iconFor(item.id);
                return (
                  <Box component="button" key={item.id} onClick={() => go(item.path)}
                       sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: '100%',
                             minHeight: 44, px: 1, border: 0, bgcolor: 'transparent',
                             cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem',
                             textAlign: 'inherit', color: 'text.primary' }}>
                    <Icon sx={{ fontSize: 18, color: 'text.secondary' }} />
                    {item.label}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Drawer>
    </>
  );
}
```

- [ ] **Step 2: Verify at 375px**

In the browser, emulate 375×812 and check: the bar shows only tabs this role has, targets are at least 44px, "עוד" opens the full grouped list, content is not hidden behind the bar, and the rail is not rendered.

Then check 768px and 1440px: at 768 and above the rail is back and the bar is gone.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/layout/MobileNav.jsx
git commit -m "feat(shell): a bottom bar for the phone

The rail does not fit a phone, and the staff who work from one are in the
rooms rather than the office: the infant board, what ran out, the punch clock
and the camera roll. Those four get the bar; everything else stays one tap
away under עוד.

Filtered through the same nav model as the rail, so a role without one of the
four gets a shorter bar rather than a tab that goes nowhere."
```

---

### Task 8: The foundation audit

**Files:**
- Create: `docs/design/stage-3-breakages.md`

- [ ] **Step 1: Run every test**

```bash
node server/scripts/design-tokens.test.js
node server/scripts/design-hex-budget.test.js
node server/scripts/nav-model.test.js
node server/scripts/tabs-constant-sync.test.js
node server/scripts/viewer-e2e.test.js
node server/scripts/custom-roles.test.js
```

Expected: all pass. The last three are existing tests and prove the permission model was not disturbed.

- [ ] **Step 2: Walk every route at three widths**

Against the demo server as the admin demo user, visit every path in `App.jsx` at 1440, 768 and 375. For each, record: renders yes/no, horizontal overflow yes/no, unreadable text yes/no, console errors.

- [ ] **Step 3: Write the breakage list**

Create `docs/design/stage-3-breakages.md` listing every screen that needs work, ordered by traffic: `רישום חיצוני`, `שכר`, `החתמות`, `עובדים`, `גבייה`, then the rest. One line per screen naming the specific problem. This is the input to the next plan.

- [ ] **Step 4: Commit and push the branch**

```bash
git add docs/design/stage-3-breakages.md
git commit -m "docs(design): what the new theme broke, screen by screen

The input to stage 3. Ordered by how much the screen is used, not by how bad
it looks: a small wrong thing on החתמות costs more than a large one on a
screen opened twice a year."
git push -u origin feat/design-system
```

**Do not merge to `main`.** `main` deploys to Render automatically. Merging is a separate decision, taken with the user, after they have seen the branch running.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Palette table | 1 |
| Type | 1, 2 |
| Shape and depth | 1, 2 |
| Motion + reduced-motion | 1, 2 |
| Direction (rail, full width) | 5, 6 |
| Mobile | 7 |
| Component vocabulary | *Deferred to the stage-3 plan* — `AppShell` and `Sidebar` are built here; `PageHeader`, `StatRow`, `DataTable`, `StatusDot`, `Tag`, `Toolbar` are built alongside the first screen that needs them, so their interfaces are drawn from a real screen rather than guessed. |
| Migration stage 1 | 2 |
| Migration stage 2 | 5, 6, 7 |
| Migration stage 3 | *Next plan*, seeded by Task 8's breakage list |
| Migration stage 4 | *Next plan* |
| Verification | 8 |
| Risk: `sx` fights the theme | 2 (Step 3), 8 |
| Risk: permission drift | 4, 5, 8 |
| Risk: hex creep | 3 |

**Placeholder scan:** two steps instruct copying existing code rather than reprinting it, and both name exactly what to copy and from where: Task 5 Step 1 (`ICON_BY_TAB`, `Header.jsx:48-79` plus the icon imports at `:9-36`) and Task 5 Step 3 (`handleSetupBiometric`, from `Header.jsx`). Everything else carries its content inline.

**Correction made during review:** an earlier draft moved biometric enrolment and the account-deletion request to `/account`. Reading `App.jsx:257` showed that route is `MyAccount.jsx` — the gan's billing screen — gated to `system_admin`, so this would have removed fingerprint login from every branch manager, teacher and assistant while `Header.jsx` was deleted in the same task. They now live in `AccountMenu`, built in Task 5 and verified for a non-admin in Task 6 Step 4.

**Type consistency:** `buildNavModel(user)` returns `[{label, items:[{id,label,path}]}]` — defined in Task 4, consumed with those exact property names in Tasks 5 and 7. `iconFor(tabId)` defined in Task 5 Step 1, used in Tasks 5 and 7. `SIDEBAR_WIDTH` and `MOBILE_NAV_HEIGHT` exported in Tasks 5 and 7, imported in Task 6. `COLOR`, `RADIUS`, `SPACING_UNIT`, `TYPE`, `MOTION` exported in Task 1, imported in Task 2.

**Ordering note:** Task 6 imports `MobileNav` before Task 7 creates it, which is why Task 6 Step 2 specifies the placeholder. Tasks 6 and 7 may also be done together.
