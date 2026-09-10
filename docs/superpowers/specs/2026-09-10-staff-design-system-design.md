# The staff system's design system

Status: approved direction, 10.09.2026
Branch: `feat/design-system` (worktree `gan-halomot-design`)

## The problem, measured

The staff app is 152 screens and 54,603 lines of JSX carrying:

- **799 hard-coded hex colours** written inline in components, `#f59e0b` alone in 32 places, `#f8fafc` in 34.
- **3,861 inline `sx={{ }}` overrides** across 143 files.
- **8 gradient fills**, four of them on buttons, plus a gradient baked into `MuiButton.containedPrimary` in the theme.
- Four decorative animated clouds drifting behind every screen (`Layout.jsx`), plus a per-branch background tint.
- No shared vocabulary: each screen invents its own stat tile, its own chip colours, its own toolbar.

The result reads as many small decisions rather than one product. The single screen that proves it is `רישום חיצוני`: twelve stat tiles in six colours, four gradient buttons, eight coloured filter chips, all above the fold.

Contrast is also wrong in the base theme. `primary.main` is `#f59e0b` with `contrastText: '#fff'` — 2.2:1, failing WCAG AA on every contained primary button in the app. The parent portal already measured and fixed this (`theme/parentTheme.js`); the staff theme never got the correction.

## Scope

**In:** every authenticated staff screen, its shell, and the public lead/registration/contract pages that inherit `rtlTheme`.

**Out:** the parent portal (`components/parent-portal/**`, `theme/parentTheme.js`). It was deliberately redesigned in August with its own warm-paper identity. That separation stays, and it is structural rather than a convention to remember: `RTLProvider` supplies `rtlTheme` at the root in `main.jsx`, and both parent entry points — `ParentLogin.jsx` and `ParentPortal.jsx` — nest their own `ThemeProvider` over it. Rewriting `rtlTheme` therefore cannot reach them. The two systems will share *structure* (spacing scale, component vocabulary, status semantics) and keep separate palettes, which is what they already do.

**Not touched, at any point:**

- Route paths and slugs.
- Tab `id` values in `config/tabs.js`. They are permission keys stored per user in `User.tab_overrides_*`; renaming one revokes a screen from whoever was granted it by hand.
- `hasTabAccess` semantics and every role gate.
- Form field names, API payloads, analytics-visible identifiers.
- Server code. This is a client-only change.

## Direction

**Dark sidebar, full-width workspace.** Chosen from four full-screen comps of the real `רישום חיצוני` screen.

The top-bar dropdown menus go away. All ~40 screens live in a fixed dark rail on the right, grouped exactly as `TAB_GROUPS` already groups them, with the current screen marked. Two consequences that motivated the choice:

1. **Discovery.** Today a screen is two clicks and a guess behind a category dropdown. Staff who use three screens never learn the other thirty-seven exist.
2. **Width.** Payroll and attendance tables are the densest surfaces in the app and currently sit under a 1200px cap with a `WIDE_ROUTES` exception list. A rail plus a fluid workspace retires the exception list.

### Palette

One ground, one accent, semantic status colours. Everything is a token; no screen names a colour.

| Token | Value | Use |
|---|---|---|
| `sidebar.bg` | `#1C1917` | The rail. Warm near-black, not blue-black, so it sits with the brand amber. |
| `sidebar.fg` | `#D6D3D1` | Rail labels. |
| `sidebar.fgActive` | `#FFFFFF` | Current screen. |
| `sidebar.bgActive` | `#292524` | Current screen's pill. |
| `sidebar.marker` | `#F59E0B` | 2px edge on the current screen. Brand amber, on dark, carrying no text: contrast is not at stake. |
| `sidebar.groupLabel` | `#78716C` | Group headings. |
| `background.default` | `#F4F4F2` | Workspace ground. |
| `background.paper` | `#FFFFFF` | Cards, tables, panels. |
| `divider` | `#E7E5E4` | Every hairline. |
| `text.primary` | `#1B1917` | |
| `text.secondary` | `#6B6560` | Labels, column heads. |
| `text.disabled` | `#A8A29E` | Empty cells, placeholders. |
| `primary.main` | `#B4540A` | The one action per screen. |
| `primary.contrastText` | `#FFFFFF` | 4.97:1 against `#B4540A`. Measured, not assumed. |
| `success.main` | `#3F7D53` | |
| `warning.main` | `#9A5B00` | |
| `error.main` | `#B3261E` | |
| `info.main` | `#3A6EA5` | |

`primary.main` moves from `#f59e0b` to `#B4540A` — the same clay the parent portal already proved at 4.97:1. `#f59e0b` survives as `primary.light`, for fills that never carry text.

Soft variants (`success.soft`, `error.soft`, …) back the status tags. Each soft colour ships with its own `on` foreground so a tag's text is never derived per call site.

**Colour discipline:** accent is for the primary action, the current selection, and state. Never decoration. A row that needs attention is tinted; a row that is fine is white. Six tiles in six colours becomes six tiles in one.

### Type

`Assistant` for everything, one family. `Varela Round` is dropped from headings — a display face in product UI labels is noise, and it currently sits on `h1`/`h2` at weight 900.

Fixed rem scale, ratio ~1.15, no fluid clamping: staff view at consistent DPI, and a heading that resizes with the viewport makes a laptop and a desktop feel like two apps.

Numbers get `font-variant-numeric: tabular-nums` and `unicode-bidi: isolate` everywhere. Israeli ID numbers, phone numbers and currency inside RTL text currently reorder on screen; isolation is the fix and it is missing today.

### Shape and depth

One radius scale, applied everywhere: `6px` inputs and buttons, `8px` cards and tables, `999px` filter pills only. No mixed systems.

Depth is a hairline, not a shadow. `MuiCard`'s current two-layer shadow goes; a card is white on `#F4F4F2` with a `1px #E7E5E4` border. Shadows are reserved for things that genuinely float: menus, dialogs, the detail panel.

### Motion

150–250ms, `transform` and `opacity` only. Motion conveys state — a panel opening, a row selecting, a toast arriving. The drifting clouds are removed: four fixed 30px-blurred elements repainting behind every scroll is both decoration and a mobile frame-rate cost.

`prefers-reduced-motion` collapses every transition.

## Component vocabulary

Seven shared components replace the per-screen inventions. They live in `components/ui/`.

| Component | Replaces |
|---|---|
| `AppShell` | `Layout.jsx` clouds, tints, `WIDE_ROUTES` |
| `Sidebar` | `Header.jsx` dropdown menus + drawer |
| `PageHeader` | Every screen's hand-rolled title + button row |
| `StatRow` | Every screen's coloured stat tiles |
| `DataTable` | Per-screen `Table` + `TableContainer` styling |
| `StatusDot` / `Tag` | Coloured `Chip`s used for state |
| `Toolbar` | Per-screen search + filter chip rows |

Each ships with default, hover, focus, active, disabled, loading and empty states. Loading is a skeleton shaped like the final content, not a centred spinner. Empty states say what to do next.

`DataTable` owns the sticky header, the tabular-numeric column type, the RTL isolation, row selection and the responsive collapse. This is where the density work pays for itself: 152 screens stop each solving it.

## Mobile

The rail collapses below `md` into a bottom tab bar carrying four screens plus "עוד", which opens the full grouped list. The four are the ones staff use from a phone in the rooms: `לוח תינוקייה`, `מה חסר`, `החתמות`, `תמונות`. Each is filtered by `hasTabAccess` like any other entry, so a role without one gets a shorter bar rather than a dead tab. Those screens get finger-sized targets (44px minimum) and card layouts instead of tables.

Every table declares its own `< 768px` behaviour explicitly — horizontal scroll inside its own container, or a card list. No screen is left to "Tailwind will handle it".

## Migration strategy

Four stages, each shippable on its own and verifiable in the browser.

**Stage 1 — the theme.** Rewrite `theme/rtlTheme.js` with the tokens and component defaults above. Zero screens edited. Every screen changes appearance because MUI defaults change under it. Risk: screens whose inline `sx` fights the new defaults will look wrong until stage 3. Verify: walk every route in the browser, screenshot, list the breakages.

**Stage 2 — the shell.** `AppShell` + `Sidebar` built from `TAB_GROUPS`, `Layout.jsx` and `Header.jsx` retired. Badges (`pendingProposals`, new leads) move to the rail. Branch selector, user menu and logout move to the rail's foot. Verify: every tab reachable, every role sees exactly the tabs it saw before, badges still count.

**Stage 3 — the vocabulary, screen by screen.** Highest-traffic first: `רישום חיצוני`, `שכר`, `החתמות`, `עובדים`, `גבייה`, then the rest. Each screen: swap in the shared components, delete its hex colours and its `sx` overrides. This is the 799 and the 3,861 coming down.

**Stage 4 — the audit.** Contrast pass, keyboard pass, reduced-motion pass, mobile pass at 375/768/1440, console clean.

Stages 1 and 2 land together as one visible change. Stage 3 lands per screen so a regression is one screen wide, never the app.

## Verification

There is no client test suite and no visual-regression baseline in this repo. Verification is therefore explicit and manual, driven through the browser against the demo server:

```
npm --prefix server run demo:viewer     # DEMO_CLICKTAC=1 for the enrollment cohort
```

Per screen, before it is called done: renders with real seeded data; every interactive control works; 375px, 768px and 1440px show no overflow or overlap; console clean; every role that has the tab can still reach and use it.

Server tests (`server/scripts/*.test.js`) must stay green. They are untouched by a client-only change, and running them is the proof of that.

## Risks

- **`sx` fights the theme.** 3,861 overrides written against the old defaults. Mitigated by stage 1 landing before any screen edit, so the damage is visible and enumerated rather than discovered late.
- **A screen's colour carried meaning.** Somewhere a hex was semantic, not decorative — a branch tint, a payment-method colour. Stage 3 reads each screen before deleting its colours, and semantic ones become tokens.
- **Permission drift in the rail.** Mitigated by building `Sidebar` from `TAB_GROUPS` + `hasTabAccess` and changing neither.
- **Four other worktrees are live** (`punch`, `reconcile`, `terms`, `viewer`). A shell rewrite conflicts with anything touching `Layout.jsx`/`Header.jsx`. Those branches touch neither today; if one starts to, it merges before stage 2.

## Deliberately not in this work

Bundle splitting, the 404 page, per-screen tab titles, breadcrumbs, `robots.txt`, and the lead pages' public metadata. All real, all agreed, all after the design lands.
