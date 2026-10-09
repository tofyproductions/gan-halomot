import { useEffect, useRef, useState } from 'react';

/**
 * תפריט הנגישות (05.10.2026) — on every screen, staff and public alike.
 *
 * Israeli service-accessibility regulations (תקנות שוויון זכויות לאנשים עם
 * מוגבלות (התאמות נגישות לשירות), התשע"ג-2013, pointing at ת"י 5568 / WCAG
 * level AA) expect a site that serves the public to offer accessibility
 * adjustments and to publish an accessibility statement with a way to report
 * problems. This widget is that: text size, contrast, grayscale, link
 * underlining, a readable font, keyboard-focus highlighting, a big cursor,
 * motion off — plus the statement itself. Ported from חברים של טופי
 * (tofy-friends 69a6ad5d), restyled plain so it looks the same under both of
 * this app's UI versions and on the login screen, where no MUI theme is up.
 *
 * Mounted once in main.jsx, OUTSIDE the router, so it is on every page by
 * construction and no new screen can forget it.
 *
 * The adjustments are classes on <html>; the stylesheet below is injected by
 * this component, so the whole feature is one file. Settings survive reload
 * through localStorage.
 *
 * Two implementation choices that are easy to get wrong (learned at טופי):
 * - Text size is `zoom`, not a root font-size: MUI and the app size plenty of
 *   text in px, which rem scaling would silently miss.
 * - Contrast/grayscale are a click-through fixed overlay with backdrop-filter,
 *   never `filter` on body/html — a filter there makes the element the
 *   containing block for every position:fixed descendant and pins dialogs,
 *   bottom bars and this very widget to the page instead of the screen.
 */

const DEFAULTS = {
  fontScale: 0, contrast: false, grayscale: false, underlineLinks: false,
  readableFont: false, focusHighlight: false, bigCursor: false, noMotion: false,
};

const STORE_KEY = 'gan.a11y.v1';

/**
 * Where the button sits, and how to get it out of the way.
 *
 * It is pinned to the bottom-left corner, which on a phone is where the save
 * and cancel buttons of a dialog are, and where the bottom navigation bar is
 * — so on those screens it covered the very control somebody was reaching
 * for. An accessibility button that blocks a button is not an accessibility
 * feature.
 *
 * Three places rather than free dragging: dragging on a touch screen fights
 * the page's own scrolling, and the problem is not that this corner is wrong
 * for everybody — it is that it is wrong on some screens, and the person
 * needs it moved, not positioned to the pixel.
 *
 * Kept in its own key, not in the settings object: it is not an accessibility
 * preference and should not be swept away by "reset settings", which would
 * move the button back under the save button without being asked to.
 */
const PLACE_KEY = 'gan.a11y.placement';
/**
 * The styles live in A11Y_CSS classes, not inline: the phone's bottom
 * navigation bar is a fixed strip this button used to sit ON — covering the
 * "עוד" dots, the one control it must never block. A media query raises the
 * default placement above the bar, and `html:has(nav)` scopes that to pages
 * where the bar actually exists (the parent portal has none, and there the
 * corner stays a corner). Inline `bottom` would out-rank all of that.
 */
const PLACEMENTS = {
  bottom: { label: 'למטה' },
  raised: { label: 'גבוה יותר' },
  tucked: { label: 'מוצמד לצד' },
};

function readPlacement() {
  try {
    const v = localStorage.getItem(PLACE_KEY);
    return PLACEMENTS[v] ? v : 'bottom';
  } catch { return 'bottom'; }
}

const A11Y_CSS = `
.a11y-launcher.a11y-place-bottom { bottom: 16px; left: 16px; }
.a11y-launcher.a11y-place-raised { bottom: 104px; left: 16px; }
.a11y-launcher.a11y-place-tucked { bottom: 104px; left: -22px; opacity: 0.45; }
.a11y-panel.a11y-from-bottom { bottom: 76px; }
.a11y-panel.a11y-from-raised, .a11y-panel.a11y-from-tucked { bottom: 164px; }
@media (max-width: 899.95px) {
  html:has(nav[aria-label="ניווט"]) .a11y-launcher.a11y-place-bottom { bottom: calc(68px + env(safe-area-inset-bottom, 0px)); }
  html:has(nav[aria-label="ניווט"]) .a11y-panel.a11y-from-bottom { bottom: calc(128px + env(safe-area-inset-bottom, 0px)); }
}
html.a11y-zoom-1 { zoom: 1.1; }
html.a11y-zoom-2 { zoom: 1.25; }
html.a11y-zoom-3 { zoom: 1.4; }

html.a11y-contrast { --a11y-filter: contrast(1.25); }
html.a11y-grayscale { --a11y-filter: grayscale(1); }
html.a11y-contrast.a11y-grayscale { --a11y-filter: contrast(1.25) grayscale(1); }
html.a11y-contrast::before,
html.a11y-grayscale::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  -webkit-backdrop-filter: var(--a11y-filter);
  backdrop-filter: var(--a11y-filter);
}

html.a11y-links a,
html.a11y-links button {
  text-decoration: underline !important;
  text-underline-offset: 2px;
}

html.a11y-readable body,
html.a11y-readable body * {
  font-family: Arial, 'Segoe UI', sans-serif !important;
  letter-spacing: 0.01em;
}

html.a11y-focus *:focus {
  outline: 3px solid #b45309 !important;
  outline-offset: 2px !important;
}

html.a11y-cursor,
html.a11y-cursor body,
html.a11y-cursor * {
  cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 24 24'><path d='M4 2l16 11h-7l4 7-3 2-4-7-6 5z' fill='black' stroke='white' stroke-width='1.6'/></svg>") 4 2, auto !important;
}

html.a11y-no-motion *,
html.a11y-no-motion *::before,
html.a11y-no-motion *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}

.a11y-row {
  display: flex; width: 100%; align-items: center; justify-content: space-between;
  border-radius: 10px; padding: 8px 12px; font-size: 13px; font-weight: 700;
  border: 1px solid #e2e8f0; background: #fff; color: #334155; cursor: pointer;
  text-align: start; font-family: inherit;
}
.a11y-row[aria-checked="true"] { background: #ecfdf5; color: #047857; border-color: #10b98166; }
.a11y-btn {
  height: 32px; width: 32px; border-radius: 10px; background: #fff; color: #334155;
  border: 1px solid #cbd5e1; font-size: 16px; font-weight: 900; cursor: pointer;
}
.a11y-btn:disabled { opacity: .3; cursor: default; }
`;

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch { return { ...DEFAULTS }; }
}

/** The classes are the single source of truth for the CSS; applied in one place. */
function applySettings(s) {
  const el = document.documentElement;
  el.classList.remove('a11y-zoom-1', 'a11y-zoom-2', 'a11y-zoom-3');
  if (s.fontScale > 0) el.classList.add(`a11y-zoom-${Math.min(3, s.fontScale)}`);
  el.classList.toggle('a11y-contrast', s.contrast);
  el.classList.toggle('a11y-grayscale', s.grayscale);
  el.classList.toggle('a11y-links', s.underlineLinks);
  el.classList.toggle('a11y-readable', s.readableFont);
  el.classList.toggle('a11y-focus', s.focusHighlight);
  el.classList.toggle('a11y-cursor', s.bigCursor);
  el.classList.toggle('a11y-no-motion', s.noMotion);
}

const isDefault = (s) => JSON.stringify(s) === JSON.stringify(DEFAULTS);

export default function AccessibilityWidget() {
  const [settings, setSettings] = useState(readSettings);
  const [placement, setPlacement] = useState(readPlacement);
  const [open, setOpen] = useState(false);
  const [statementOpen, setStatementOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  // On mount too, so a saved preference holds before the menu is ever opened.
  useEffect(() => {
    applySettings(settings);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* not remembered */ }
  }, [settings]);

  useEffect(() => {
    try { localStorage.setItem(PLACE_KEY, placement); } catch { /* not remembered */ }
  }, [placement]);

  // Escape closes; a click outside closes. The statement dialog traps its own Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (statementOpen) { setStatementOpen(false); return; }
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e) => {
      if (statementOpen) return;
      const t = e.target;
      if (panelRef.current && !panelRef.current.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open, statementOpen]);

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const toggle = (k) => set({ [k]: !settings[k] });

  const Row = ({ label, active, onPress }) => (
    <button type="button" role="switch" aria-checked={active} onClick={onPress} className="a11y-row">
      <span>{label}</span>
      <span aria-hidden="true" style={{ fontSize: 11, fontWeight: 900, color: active ? '#059669' : '#cbd5e1' }}>
        {active ? '✓ פעיל' : 'כבוי'}
      </span>
    </button>
  );

  const font = { fontFamily: 'inherit' };

  return (
    <div dir="rtl">
      <style>{A11Y_CSS}</style>

      {/* The trigger, wherever the person has put it — see PLACEMENTS. */}
      <button
        ref={buttonRef}
        type="button"
        aria-label={placement === 'tucked' ? 'החזרת כפתור הנגישות' : 'תפריט נגישות'}
        aria-expanded={placement === 'tucked' ? undefined : open}
        aria-haspopup={placement === 'tucked' ? undefined : 'dialog'}
        // Tucked away, the first press brings it back rather than opening the
        // menu: somebody who pushed it aside and now wants it has to be able
        // to get it without knowing that pressing a half-hidden circle opens
        // something.
        onClick={() => (placement === 'tucked' ? setPlacement('raised') : setOpen((v) => !v))}
        className={`a11y-launcher a11y-place-${placement}`}
        style={{
          position: 'fixed', zIndex: 2000,
          height: 48, width: 48, borderRadius: '50%', border: 'none',
          background: '#0b57a4', color: '#fff', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 14px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.7)',
          transition: 'bottom .18s ease, left .18s ease, opacity .18s ease',
        }}
      >
        {/* The international accessibility mark, drawn inline so it always loads. */}
        <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="4.4" r="2.1" />
          <path d="M12 7.2c-.6 0-1.1.5-1.1 1.1v4.5l-3.6 5.3a1.1 1.1 0 0 0 1.8 1.2l3-4.4 3 4.4a1.1 1.1 0 1 0 1.8-1.2l-3.7-5.3V11l3.3-.8a1 1 0 1 0-.4-2l-3.5.9h-1.2l-3.5-.9a1 1 0 1 0-.4 2l3.4.8v-2.7c0-.6.5-1.1 1.1-1.1z" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="הגדרות נגישות"
          className={`a11y-panel a11y-from-${placement}`}
          style={{
            position: 'fixed', zIndex: 2000, left: 16,
            width: 300, maxWidth: 'calc(100vw - 2rem)', borderRadius: 16,
            border: '1px solid #e2e8f0', background: '#fff', padding: 12,
            boxShadow: '0 20px 50px rgba(0,0,0,.3)', ...font,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 900, color: '#0f172a' }}>נגישות</h2>
            <button type="button" aria-label="סגור תפריט נגישות"
              onClick={() => { setOpen(false); buttonRef.current?.focus(); }}
              style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 700, color: '#64748b', cursor: 'pointer', borderRadius: 8, padding: '4px 8px' }}>
              ✕
            </button>
          </div>

          {/* Text size — the one adjustment with steps rather than a switch. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderRadius: 10, background: '#f8fafc', padding: '8px 12px',
            border: '1px solid #e2e8f0', marginBottom: 8,
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>גודל טקסט</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button type="button" aria-label="הקטן טקסט" className="a11y-btn"
                disabled={settings.fontScale === 0}
                onClick={() => set({ fontScale: Math.max(0, settings.fontScale - 1) })}>
                −
              </button>
              <span aria-live="polite" style={{ width: 34, textAlign: 'center', fontSize: 12, fontWeight: 900, color: '#475569' }}>
                {settings.fontScale === 0 ? 'רגיל' : `+${settings.fontScale}`}
              </span>
              <button type="button" aria-label="הגדל טקסט" className="a11y-btn"
                disabled={settings.fontScale === 3}
                onClick={() => set({ fontScale: Math.min(3, settings.fontScale + 1) })}>
                +
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row label="ניגודיות גבוהה" active={settings.contrast} onPress={() => toggle('contrast')} />
            <Row label="גווני אפור" active={settings.grayscale} onPress={() => toggle('grayscale')} />
            <Row label="הדגשת קישורים וכפתורים" active={settings.underlineLinks} onPress={() => toggle('underlineLinks')} />
            <Row label="פונט קריא" active={settings.readableFont} onPress={() => toggle('readableFont')} />
            <Row label="הדגשת מיקוד מקלדת" active={settings.focusHighlight} onPress={() => toggle('focusHighlight')} />
            <Row label="סמן עכבר גדול" active={settings.bigCursor} onPress={() => toggle('bigCursor')} />
            <Row label="עצירת אנימציות" active={settings.noMotion} onPress={() => toggle('noMotion')} />
          </div>

          {/*
            Where the button itself sits.

            In the menu rather than on the button, because it is a setting and
            not an action — and because a second control ON a 48px circle
            would be a target nobody can hit, which is the opposite of the
            point. "מוצמד לצד" pushes it half off the screen; pressing it
            there brings it back rather than opening this menu.
          */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#475569', marginBottom: 6 }}>
              מיקום הכפתור
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {Object.entries(PLACEMENTS).map(([key, p]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={placement === key}
                  onClick={() => setPlacement(key)}
                  style={{
                    flex: 1, padding: '7px 4px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                    cursor: 'pointer',
                    border: `1px solid ${placement === key ? '#10b98166' : '#cbd5e1'}`,
                    background: placement === key ? '#ecfdf5' : '#fff',
                    color: placement === key ? '#047857' : '#334155',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 5 }}>
              אם הכפתור מסתיר כפתור שמירה או ביטול — הזיזו אותו מכאן.
            </div>
          </div>

          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <button type="button" onClick={() => setSettings({ ...DEFAULTS })} disabled={isDefault(settings)}
              style={{
                border: 'none', background: 'none', borderRadius: 8, padding: '6px 12px',
                fontSize: 12, fontWeight: 700, color: '#b91c1c',
                cursor: isDefault(settings) ? 'default' : 'pointer', opacity: isDefault(settings) ? 0.3 : 1,
              }}>
              איפוס הגדרות
            </button>
            <button type="button" onClick={() => setStatementOpen(true)}
              style={{
                border: 'none', background: 'none', borderRadius: 8, padding: '6px 12px',
                fontSize: 12, fontWeight: 700, color: '#0b57a4', cursor: 'pointer',
              }}>
              הצהרת נגישות
            </button>
          </div>
        </div>
      )}

      {statementOpen && (
        <div
          onClick={() => setStatementOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="הצהרת נגישות"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxHeight: '85vh', width: '100%', maxWidth: 560, overflowY: 'auto',
              borderRadius: 16, background: '#fff', padding: 20,
              boxShadow: '0 25px 60px rgba(0,0,0,.4)', ...font,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: '#0f172a' }}>הצהרת נגישות</h2>
              <button type="button" aria-label="סגור הצהרת נגישות" onClick={() => setStatementOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 700, color: '#64748b', cursor: 'pointer', borderRadius: 8, padding: '4px 8px' }}>
                ✕
              </button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: '#334155', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0 }}>
                <b>עמותת גן החלומות</b> רואה חשיבות רבה במתן שירות שוויוני ונגיש לכלל
                המשתמשים, ההורים והעובדים, לרבות אנשים עם מוגבלות, ופועלת להנגשת
                המערכת בהתאם לתקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות
                לשירות), התשע״ג-2013, ולתקן הישראלי ת״י 5568 ברמה AA.
              </p>
              <div>
                <b>התאמות הנגישות במערכת:</b>
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                  <li>תפריט נגישות בכל עמוד: הגדלת טקסט, ניגודיות גבוהה, גווני אפור, הדגשת קישורים, פונט קריא, הדגשת מיקוד מקלדת, סמן גדול ועצירת אנימציות</li>
                  <li>תמיכה בניווט באמצעות מקלדת</li>
                  <li>מבנה עמודים ותיוג רכיבים התומכים בקוראי מסך</li>
                  <li>ההעדפות נשמרות במכשיר וחלות על כל העמודים</li>
                </ul>
              </div>
              <p style={{ margin: 0 }}>
                אנו ממשיכים לשפר את נגישות המערכת באופן שוטף. ייתכן שתימצאנה רכיבים או
                עמודים שטרם הונגשו במלואם — ואנו מתחייבים לטפל בכל פנייה בנושא.
              </p>
              <p style={{ margin: 0 }}>
                <b>נתקלתם בבעיה? נשמח לשמוע:</b><br />
                דוא״ל: <a href="mailto:totofy10@gmail.com" style={{ fontWeight: 700, color: '#0b57a4' }}>totofy10@gmail.com</a><br />
                נא לציין את העמוד שבו נתקלתם בקושי ואת מהות הבעיה, ונחזור אליכם בהקדם.
              </p>
              <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>ההצהרה עודכנה לאחרונה: אוקטובר 2026</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
