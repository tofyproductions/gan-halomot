import { useState, useRef } from 'react';
import api from '../../api/client';
import { BRANDS as C } from './careersContent';

/**
 * הגשת מועמדות.
 *
 * The form is the only part of this page that is not a rewrite of the old one.
 * It used to POST to a Google Apps Script which mailed the office; now it
 * posts here and the candidate exists before the button finishes animating.
 *
 * Three questions were added because they are the three a manager asked on
 * every single call before she could decide whether the call was worth having:
 * where the person lives, whether they can reach a branch that is not walking
 * distance, and whether they have ever worked in a גן. Each is one tap, all
 * three are optional, and an unanswered one is recorded as unanswered rather
 * than as "no" — a blank must never become a fact about somebody.
 *
 * Everything else here is about not losing an applicant on the last step: the
 * errors say which field and why, the phone is checked before the upload
 * starts, and a submit that fails leaves every value where the person typed it.
 */

const MAX_CV_MB = 8;

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '13px 16px',
  borderRadius: 14,
  border: '2px solid rgba(108,92,231,.18)',
  background: 'rgba(255,255,255,.92)',
  font: 'inherit',
  fontSize: '1rem',
  color: C.ink,
  outline: 'none',
};

const LABEL = {
  display: 'block',
  marginBottom: 8,
  fontWeight: 700,
  fontSize: '.97rem',
  color: C.ink,
};

/** A two-way question answered with a tap, not a dropdown. */
function Choice({ label, value, onChange, name }) {
  const opt = (v, text) => {
    const on = value === v;
    return (
      <button
        key={v} type="button" onClick={() => onChange(on ? '' : v)}
        aria-pressed={on}
        style={{
          flex: 1, cursor: 'pointer', font: 'inherit', fontWeight: 700,
          padding: '12px 10px', borderRadius: 14,
          border: `2px solid ${on ? 'transparent' : 'rgba(108,92,231,.18)'}`,
          background: on ? C.rule : 'rgba(255,255,255,.92)',
          color: on ? '#fff' : C.muted,
          transition: 'all .15s ease',
        }}
      >
        {text}
      </button>
    );
  };
  return (
    <div>
      <span style={LABEL} id={`${name}-label`}>{label}</span>
      <div style={{ display: 'flex', gap: 10 }} role="group" aria-labelledby={`${name}-label`}>
        {opt('yes', 'כן')}
        {opt('no', 'לא')}
      </div>
    </div>
  );
}

const EMPTY = {
  full_name: '', phone: '', branch: '', city: '',
  mobility: '', gan_experience: '', email: '', message: '',
};

export default function ApplyForm({ branches = [], office = null }) {
  const [v, setV] = useState(EMPTY);
  const [cv, setCv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const fileRef = useRef(null);

  const set = (k) => (e) => setV(s => ({ ...s, [k]: e.target.value }));

  const pickFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_CV_MB * 1024 * 1024) {
      setError(`הקובץ גדול מדי — עד ${MAX_CV_MB}MB`);
      e.target.value = '';
      return;
    }
    setError('');
    setCv(f);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;

    if (!v.full_name.trim()) return setError('נא למלא שם מלא');
    // Checked here as well as on the server so nobody waits out an 8MB upload
    // to be told their phone number was short.
    if (v.phone.replace(/\D/g, '').length < 9) return setError('מספר הטלפון קצר מדי — בדקו שוב');
    if (!v.branch) return setError('נא לבחור סניף מבוקש');

    setError('');
    setBusy(true);
    try {
      const body = new FormData();
      Object.entries(v).forEach(([k, val]) => val && body.append(k, val));
      if (cv) body.append('cv', cv);
      await api.post('/public/careers/apply', body);
      setDone(true);
      // Tell the ad platforms a lead landed. Guarded: neither tag is loaded
      // on a staff device, and a page without them must still submit.
      try { window.fbq?.('track', 'Lead'); } catch { /* no pixel here */ }
      try { window.gtag?.('event', 'generate_lead'); } catch { /* no tag here */ }
    } catch (err) {
      setError(err.response?.data?.error || 'השליחה נכשלה. נסו שוב, או התקשרו אלינו ישירות.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section style={{ padding: 'clamp(48px, 8vw, 92px) 20px' }}>
        <div style={{
          maxWidth: 560, margin: '0 auto', textAlign: 'center',
          background: C.glass, border: `1px solid ${C.glassEdge}`,
          borderRadius: 24, padding: 'clamp(32px, 6vw, 52px)', boxShadow: C.shadow,
        }}>
          <div style={{ fontSize: '3.4rem', marginBottom: 10 }} aria-hidden="true">🌈</div>
          <h2 style={{ margin: '0 0 12px', fontSize: '1.8rem', fontWeight: 800, color: C.primary }}>
            קיבלנו את המועמדות שלך!
          </h2>
          <p style={{ margin: 0, color: C.muted, lineHeight: 1.75, fontSize: '1.05rem' }}>
            הפרטים הגיעו ישירות למנהלת הסניף. נחזור אליך בהקדם — בדרך כלל תוך יום-יומיים.
          </p>
          <p style={{ margin: '18px 0 0', color: C.muted }}>
            רוצה שנדבר עכשיו? הטלפונים של הסניפים נמצאים למעלה בעמוד.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section style={{ padding: 'clamp(48px, 8vw, 92px) 20px' }}>
      <form
        onSubmit={submit} noValidate
        style={{
          maxWidth: 620, margin: '0 auto',
          borderRadius: 24, overflow: 'hidden',
          boxShadow: '0 18px 50px rgba(31,38,135,.16)',
          background: 'rgba(255,255,255,.96)',
        }}
      >
        <header style={{ background: C.rule, color: '#fff', padding: 'clamp(24px, 4vw, 34px) 24px', textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800 }}>הגשת מועמדות</h2>
          <p style={{ margin: '8px 0 0', opacity: .95 }}>מלאו את הפרטים ונחזור אליכם בהקדם</p>
        </header>

        <div style={{ padding: 'clamp(22px, 4vw, 34px)', display: 'grid', gap: 20 }}>
          <div>
            <label style={LABEL} htmlFor="ap-name">שם מלא <span style={{ color: '#d63031' }}>*</span></label>
            <input
              id="ap-name" style={FIELD} value={v.full_name} onChange={set('full_name')}
              placeholder="הקלידו שם מלא" autoComplete="name" required
            />
          </div>

          <div>
            <label style={LABEL} htmlFor="ap-phone">מספר טלפון <span style={{ color: '#d63031' }}>*</span></label>
            <input
              id="ap-phone" style={FIELD} value={v.phone} onChange={set('phone')}
              placeholder="050-0000000" type="tel" inputMode="tel" autoComplete="tel" required
            />
          </div>

          <div>
            <label style={LABEL} htmlFor="ap-branch">סניף מבוקש <span style={{ color: '#d63031' }}>*</span></label>
            <select id="ap-branch" style={FIELD} value={v.branch} onChange={set('branch')} required>
              <option value="">בחרו סניף</option>
              {branches.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
              {office && <option value={office.value}>{office.label}</option>}
            </select>
          </div>

          <div>
            <label style={LABEL} htmlFor="ap-city">עיר מגורים</label>
            <input
              id="ap-city" style={FIELD} value={v.city} onChange={set('city')}
              placeholder="לדוגמה: כפר סבא" autoComplete="address-level2"
            />
          </div>

          <Choice
            name="mobility" label="האם יש לך רכב / ניידות?"
            value={v.mobility} onChange={(x) => setV(s => ({ ...s, mobility: x }))}
          />

          <Choice
            name="experience" label="יש לך ניסיון בעבודה בגן ילדים?"
            value={v.gan_experience} onChange={(x) => setV(s => ({ ...s, gan_experience: x }))}
          />

          <div>
            <label style={LABEL} htmlFor="ap-email">אימייל (לא חובה)</label>
            <input
              id="ap-email" style={FIELD} value={v.email} onChange={set('email')}
              placeholder="נשלח אליכם אישור שהפנייה נקלטה" type="email" autoComplete="email"
            />
          </div>

          <div>
            <span style={LABEL}>צירוף קורות חיים (לא חובה)</span>
            <input
              ref={fileRef} type="file" onChange={pickFile}
              accept=".pdf,.doc,.docx,image/*"
              style={{ display: 'none' }}
            />
            <button
              type="button" onClick={() => fileRef.current?.click()}
              style={{
                ...FIELD, cursor: 'pointer', textAlign: 'start',
                color: cv ? C.ink : C.muted, fontWeight: cv ? 700 : 400,
              }}
            >
              {cv ? `📎 ${cv.name}` : 'בחרו קובץ — PDF, Word או תמונה'}
            </button>
            {cv && (
              <button
                type="button"
                onClick={() => { setCv(null); if (fileRef.current) fileRef.current.value = ''; }}
                style={{
                  marginTop: 8, border: 'none', background: 'none', cursor: 'pointer',
                  font: 'inherit', color: '#d63031', fontWeight: 700, padding: 0,
                }}
              >
                הסרת הקובץ
              </button>
            )}
          </div>

          <div>
            <label style={LABEL} htmlFor="ap-msg">הודעה נוספת</label>
            <textarea
              id="ap-msg" style={{ ...FIELD, minHeight: 110, resize: 'vertical' }}
              value={v.message} onChange={set('message')}
              placeholder="ספרו לנו קצת על עצמכם…"
            />
          </div>

          {error && (
            <p role="alert" style={{
              margin: 0, padding: '12px 16px', borderRadius: 12,
              background: 'rgba(214,48,49,.08)', color: '#b02525', fontWeight: 700,
            }}>
              {error}
            </p>
          )}

          <button
            type="submit" disabled={busy} className="cta-lift"
            style={{
              border: 'none', cursor: busy ? 'progress' : 'pointer', font: 'inherit',
              fontWeight: 800, fontSize: '1.12rem', color: '#fff',
              padding: '17px 20px', borderRadius: 999,
              background: C.rule,
              opacity: busy ? .7 : 1,
              boxShadow: '0 12px 30px rgba(108,92,231,.32)',
            }}
          >
            {busy ? 'שולח…' : 'שליחת המועמדות'}
          </button>
        </div>
      </form>
    </section>
  );
}
