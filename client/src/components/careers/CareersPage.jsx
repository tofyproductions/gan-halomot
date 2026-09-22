import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../../api/client';
import { BRANDS, PERKS, ROLES, GALLERY, CONTACTS } from './careersContent';
import ApplyForm from './ApplyForm';
import { startAdTags, stopAdTags } from './adTags';

/**
 * דרושים — the public hiring page.
 *
 * Rebuilt from the static GitHub Pages site the Facebook campaign used to
 * point at. The design is deliberately the SAME design: it was working, the
 * ads were built around it, and a stranger who clicked an ad should land
 * somewhere that looks like what they clicked. What changed is underneath —
 * the form posts into this system and a manager sees the person within the
 * second, instead of the old chain of Apps Script → email → a pull somebody
 * had to remember to press.
 *
 * Standalone on purpose. No MUI, no app theme, no layout chrome: this is the
 * first thing anyone ever sees of גן החלומות and it must not look like an
 * admin panel. It is also why `components/careers/` is exempt from the hex
 * budget — see scripts/design-hex-budget.test.js.
 */

const C = BRANDS;

/** One shared "rise in as you reach it" observer for the whole page. */
function useReveal() {
  const seen = useRef(null);
  useEffect(() => {
    // No IntersectionObserver (old WebView, or a headless crawler) must never
    // mean an invisible page — the elements start visible and this only ever
    // removes that.
    if (typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.dataset.shown = '1'; io.unobserve(e.target); }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('[data-reveal]').forEach((el) => {
      el.dataset.shown = '0';
      io.observe(el);
    });
    seen.current = io;
    return () => io.disconnect();
  }, []);
}

function Section({ title, subtitle, children, tint = 'light', id }) {
  return (
    <section
      id={id}
      style={{
        padding: 'clamp(48px, 8vw, 92px) 20px',
        background: tint === 'tinted' ? C.tintBg : 'transparent',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        {title && (
          <header data-reveal style={{ textAlign: 'center', marginBottom: 'clamp(28px, 5vw, 52px)' }}>
            <h2 style={{
              margin: 0,
              fontSize: 'clamp(1.75rem, 4.5vw, 2.7rem)',
              fontWeight: 800,
              color: C.ink,
              letterSpacing: '-0.02em',
            }}>
              {title}
            </h2>
            <div style={{
              width: 110, height: 4, margin: '14px auto 0', borderRadius: 4,
              background: C.rule,
            }} />
            {subtitle && (
              <p style={{
                margin: '16px auto 0', maxWidth: 620, color: C.muted,
                fontSize: 'clamp(1rem, 2.2vw, 1.12rem)', lineHeight: 1.6,
              }}>
                {subtitle}
              </p>
            )}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}

/** The glass card the whole page is built out of. */
function Card({ children, style, delay = 0 }) {
  return (
    <div
      data-reveal
      style={{
        position: 'relative',
        background: C.glass,
        border: `1px solid ${C.glassEdge}`,
        borderRadius: 22,
        padding: 'clamp(20px, 3vw, 28px)',
        boxShadow: C.shadow,
        overflow: 'hidden',
        transitionDelay: `${delay}ms`,
        ...style,
      }}
    >
      <span style={{
        position: 'absolute', insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: 5,
        background: C.rule,
      }} />
      {children}
    </div>
  );
}

export default function CareersPage() {
  const [branches, setBranches] = useState([]);
  const [office, setOffice] = useState(null);
  const formRef = useRef(null);

  useReveal();

  // The campaign's measurement, mounted with the page it measures and taken
  // down with it. See adTags.js for why it is not in index.html.
  useEffect(() => {
    startAdTags();
    return stopAdTags;
  }, []);

  useEffect(() => {
    document.title = 'דרושים גן החלומות | הצטרפו למשפחה שלנו';
    const meta = document.querySelector('meta[name="description"]')
      || Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'description' });
    meta.content = 'גן החלומות מגייס מובילות כיתה, מטפלות וסייעות בכפר סבא, הרצליה ותל אביב. הגישו מועמדות בדקה.';
  }, []);

  useEffect(() => {
    api.get('/public/careers/branches')
      .then((res) => {
        setBranches(res.data.branches || []);
        setOffice(res.data.office || null);
      })
      // The dropdown falling over must not take the page with it — the
      // telephone numbers further down still work, and they are the fallback
      // this page had before it had a form at all.
      .catch(() => { setBranches([]); setOffice(null); });
  }, []);

  const toForm = useCallback(() => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div dir="rtl" style={{
      fontFamily: '"Assistant", "Segoe UI", Tahoma, sans-serif',
      color: C.ink,
      background: C.pageBg,
      minHeight: '100vh',
      overflowX: 'hidden',
    }}>
      <style>{`
        [data-reveal] { opacity: 1; transform: none; }
        [data-reveal][data-shown="0"] { opacity: 0; transform: translateY(22px); }
        [data-reveal][data-shown="1"] {
          opacity: 1; transform: none;
          transition: opacity .6s ease, transform .6s cubic-bezier(.2,.7,.3,1);
        }
        @media (prefers-reduced-motion: reduce) {
          [data-reveal] { opacity: 1 !important; transform: none !important; transition: none !important; }
          html { scroll-behavior: auto; }
        }
        .cta-lift { transition: transform .18s ease, box-shadow .18s ease; }
        .cta-lift:hover { transform: translateY(-2px); }
        .cta-lift:active { transform: translateY(0); }
        .ph { transition: transform .5s cubic-bezier(.2,.7,.3,1); }
        .ph:hover { transform: scale(1.04); }
      `}</style>

      {/* ——— ribbon + logo ———
          A three-column grid rather than a centred flex row with an absolutely
          positioned logo: absolute put the logo over the ribbon's own text on
          a narrow screen, and most of this page's traffic arrives from a phone. */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: C.ribbonBg,
        backdropFilter: 'blur(10px)',
        borderBottom: `1px solid ${C.glassEdge}`,
        padding: '8px clamp(10px, 3vw, 20px)',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center', gap: 12,
      }}>
        <img
          src="/careers/logo.webp" alt="גן החלומות"
          width="96" height="64"
          style={{ height: 'clamp(34px, 7vw, 48px)', width: 'auto' }}
        />
        <button
          type="button" onClick={toForm} className="cta-lift"
          style={{
            justifySelf: 'center',
            border: 'none', cursor: 'pointer', color: '#fff', fontWeight: 800,
            fontFamily: 'inherit',
            fontSize: 'clamp(.72rem, 2.3vw, 1rem)',
            padding: 'clamp(7px, 1.6vw, 10px) clamp(12px, 3vw, 24px)',
            borderRadius: 999,
            background: C.rule,
            boxShadow: '0 6px 18px rgba(108,92,231,.35)',
            lineHeight: 1.25,
          }}
        >
          🌟 מצטרפים למשפחה? אנחנו מחפשים אותך! 🌟
        </button>
        {/* Balances the grid so the ribbon's text is centred on the PAGE and
            not merely on the space the logo left over. */}
        <span aria-hidden="true" style={{ width: 'clamp(34px, 7vw, 48px)' }} />
      </div>

      {/* ——— hero ——— */}
      <section style={{
        background: C.hero,
        padding: 'clamp(64px, 12vw, 132px) 20px clamp(96px, 14vw, 168px)',
        textAlign: 'center',
        position: 'relative',
        clipPath: 'ellipse(140% 100% at 50% 0%)',
      }}>
        <h1 style={{
          margin: 0, color: '#fff', fontWeight: 800,
          fontSize: 'clamp(2.2rem, 8vw, 5rem)',
          letterSpacing: '-0.03em',
          textShadow: '0 4px 30px rgba(0,0,0,.18)',
        }}>
          מצטרפים למשפחה?
        </h1>
        <p style={{
          margin: 'clamp(20px, 3vw, 30px) auto 0', maxWidth: 760,
          color: 'rgba(255,255,255,.95)',
          fontSize: 'clamp(1.02rem, 2.6vw, 1.38rem)', lineHeight: 1.65, fontWeight: 500,
        }}>
          בואו לעשות שינוי במקום שבו הכל מתחיל. גן החלומות מגייס את הדור הבא של המחנכות
          והמטפלות — מקום שהוא משפחה, עבודה שהיא שליחות.
        </p>
        <button
          type="button" onClick={toForm} className="cta-lift"
          style={{
            marginTop: 'clamp(28px, 4vw, 44px)', cursor: 'pointer',
            border: 'none', fontFamily: 'inherit',
            background: '#fff', color: C.primary,
            fontWeight: 800, fontSize: 'clamp(1rem, 2.6vw, 1.22rem)',
            padding: '17px 44px', borderRadius: 999,
            boxShadow: '0 14px 40px rgba(0,0,0,.20)',
          }}
        >
          להגשת מועמדות מהירה
        </button>
      </section>

      {/* ——— why us ——— */}
      <Section title="למה כדאי לעבוד אצלנו?" subtitle="יותר מסתם עבודה — מקום שהוא בית">
        <div style={{
          display: 'grid', gap: 22,
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        }}>
          {PERKS.map((p, i) => (
            <Card key={p.title} delay={i * 70}>
              <div style={{ fontSize: '2rem', marginBottom: 10 }} aria-hidden="true">{p.icon}</div>
              <h3 style={{ margin: '0 0 10px', fontSize: '1.24rem', fontWeight: 800, color: C.primary }}>
                {p.title}
              </h3>
              <p style={{ margin: 0, color: C.muted, lineHeight: 1.65 }}>{p.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* ——— who we want ——— */}
      <Section title="את מי אנחנו מחפשים?" subtitle="אנשים עם לב רחב ונשמה גדולה" tint="tinted">
        <div style={{
          display: 'grid', gap: 22,
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        }}>
          {ROLES.map((r, i) => (
            <Card key={r.title} delay={i * 90}>
              <h3 style={{ margin: '0 0 12px', fontSize: '1.4rem', fontWeight: 800, color: C.primary }}>
                {r.icon} {r.title}
              </h3>
              <p style={{ margin: 0, color: C.muted, lineHeight: 1.7 }}>{r.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* ——— about ——— */}
      <Section title="קצת עלינו" subtitle="הלב מאחורי גן החלומות">
        <Card style={{ maxWidth: 880, margin: '0 auto', textAlign: 'center' }}>
          <p style={{
            margin: 0, color: C.muted, lineHeight: 1.9,
            fontSize: 'clamp(1rem, 2.2vw, 1.1rem)',
          }}>
            גן החלומות הוא רשת גני ילדים מובילה המעניקה סביבה חינוכית תומכת, אוהבת ומפתחת
            לקטנטנים. אנו מאמינים שהצוות שלנו הוא הלב הפועם של הגן, ולכן אנו משקיעים
            במקצועיות, ביחס אישי ובאווירה משפחתית לכל עובד ועובדת. הצטרפו אלינו למקום שבו
            עבודה היא שליחות, והחיוך של הילדים הוא השכר הגדול ביותר.
          </p>
        </Card>
      </Section>

      {/* ——— gallery ——— */}
      <Section title="🏡 הגנים שלנו 🏡" subtitle="סיור בסניפים המדהימים שלנו" tint="tinted">
        <div style={{
          display: 'grid', gap: 20,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}>
          {GALLERY.map((g, i) => (
            <figure
              key={g.src} data-reveal
              style={{
                margin: 0, borderRadius: 20, overflow: 'hidden',
                boxShadow: C.shadow, background: '#fff',
                transitionDelay: `${i * 80}ms`,
              }}
            >
              <img
                className="ph" src={g.src} alt={g.alt} loading="lazy" decoding="async"
                style={{ display: 'block', width: '100%', height: 300, objectFit: 'cover' }}
              />
              <figcaption style={{
                padding: '13px 16px', fontWeight: 700, color: C.muted, fontSize: '.95rem',
              }}>
                {g.caption}
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      {/* ——— branches ——— */}
      <Section title="📍 הסניפים שלנו 📍" subtitle="מצאו את הסניף הקרוב אליכם וצרו קשר ישיר">
        <div style={{
          display: 'grid', gap: 22,
          gridTemplateColumns: 'repeat(auto-fit, minmax(255px, 1fr))',
        }}>
          {CONTACTS.map((b, i) => (
            <Card key={b.name} delay={i * 70} style={{ textAlign: 'center' }}>
              <h3 style={{ margin: '0 0 14px', fontSize: '1.28rem', fontWeight: 800, color: C.primary }}>
                {b.name}
              </h3>
              <p style={{ margin: '0 0 6px', fontWeight: 700 }}>{b.manager}</p>
              <p style={{ margin: '0 0 6px', fontWeight: 700 }}>
                טלפון: <a href={`tel:${b.tel}`} style={{ color: C.ink, textDecoration: 'none' }}>{b.phone}</a>
              </p>
              <p style={{ margin: '0 0 18px', color: C.muted, fontSize: '.95rem' }}>{b.address}</p>
              <a
                href={b.whatsapp} target="_blank" rel="noopener noreferrer" className="cta-lift"
                style={{
                  display: 'block', textDecoration: 'none', color: '#fff', fontWeight: 800,
                  padding: '12px 18px', borderRadius: 999,
                  background: b.office ? C.officeBtn : C.waBtn,
                  boxShadow: '0 8px 20px rgba(0,0,0,.12)',
                }}
              >
                {b.cta}
              </a>
            </Card>
          ))}
        </div>
      </Section>

      {/* ——— the form ——— */}
      <div ref={formRef} id="apply" style={{ scrollMarginTop: 80 }}>
        <ApplyForm branches={branches} office={office} />
      </div>

      <footer style={{
        background: C.footer, color: 'rgba(255,255,255,.92)',
        textAlign: 'center', padding: '34px 20px', marginTop: 8,
      }}>
        <p style={{ margin: 0, fontWeight: 700 }}>© {new Date().getFullYear()} גן החלומות — כל הזכויות שמורות</p>
        <p style={{ margin: '6px 0 0', opacity: .85 }}>מעצבים את דור העתיד באהבה</p>
      </footer>
    </div>
  );
}
