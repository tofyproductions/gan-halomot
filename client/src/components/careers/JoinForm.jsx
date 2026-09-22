import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import { BRANDS as C } from './careersContent';

/**
 * רישום עובד/ת חדש/ה — what somebody who was already hired fills in about
 * themselves, once, instead of over four WhatsApp threads.
 *
 * Shares the careers page's look on purpose. It is the second thing the same
 * person sees from this gan — an ad, then a call, then this — and landing on
 * an admin form after a designed page reads as a different company.
 *
 * NOTHING HERE MAKES AN EMPLOYEE. The link is permanent and will be forwarded;
 * a submission waits in a queue for somebody in accounting. The form says so
 * at the bottom, because a person handing over their bank details and a
 * photograph of their ת"ז deserves to know where those went.
 */

const MAX_MB = 8;

const FIELD = {
  width: '100%', boxSizing: 'border-box',
  padding: '13px 16px', borderRadius: 14,
  border: '2px solid rgba(108,92,231,.18)',
  background: 'rgba(255,255,255,.92)',
  font: 'inherit', fontSize: '1rem', color: C.ink, outline: 'none',
};
const LABEL = { display: 'block', marginBottom: 8, fontWeight: 700, fontSize: '.97rem', color: C.ink };
const REQ = <span style={{ color: '#d63031' }}>*</span>;

const SECTION = {
  margin: '8px 0 -4px', fontWeight: 800, color: C.primary, fontSize: '1.05rem',
};

const EMPTY = {
  full_name: '', israeli_id: '', phone: '', email: '', address: '', birth_date: '',
  branch_id: '', position: '',
  bank_number: '', bank_branch: '', bank_account: '', bank_account_holder: '',
  emergency_name: '', emergency_phone: '', emergency_relation: '',
  note: '',
};

/** One labelled file slot. Kept separate so each says what it is for. */
function FilePick({ label, file, onPick, onClear }) {
  const ref = useRef(null);
  return (
    <div>
      <span style={LABEL}>{label}</span>
      <input
        ref={ref} type="file" style={{ display: 'none' }}
        accept=".pdf,.doc,.docx,image/*"
        onChange={(e) => {
          const f = e.target.files?.[0] || null;
          e.target.value = '';
          if (f && f.size > MAX_MB * 1024 * 1024) { onPick(null, `${label}: הקובץ גדול מ-${MAX_MB}MB`); return; }
          onPick(f, '');
        }}
      />
      <button
        type="button" onClick={() => ref.current?.click()}
        style={{ ...FIELD, cursor: 'pointer', textAlign: 'start', color: file ? C.ink : C.muted, fontWeight: file ? 700 : 400 }}
      >
        {file ? `📎 ${file.name}` : 'בחרו קובץ'}
      </button>
      {file && (
        <button
          type="button" onClick={onClear}
          style={{ marginTop: 6, border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: '#d63031', fontWeight: 700, padding: 0 }}
        >
          הסרה
        </button>
      )}
    </div>
  );
}

export default function JoinForm() {
  const [v, setV] = useState(EMPTY);
  const [branches, setBranches] = useState([]);
  const [files, setFiles] = useState({ id_document: null, bank_details: null, certificate: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const set = (k) => (e) => setV(s => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    document.title = 'רישום עובד/ת — גן החלומות';
    api.get('/public/employee-registration/branches')
      .then(res => setBranches(res.data.branches || []))
      .catch(() => setBranches([]));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!v.full_name.trim()) return setError('נא למלא שם מלא');
    const id = v.israeli_id.replace(/\D/g, '');
    if (id.length < 8 || id.length > 9) return setError('תעודת זהות צריכה להיות 9 ספרות');
    if (v.phone.replace(/\D/g, '').length < 9) return setError('מספר הטלפון קצר מדי');
    if (!v.branch_id) return setError('נא לבחור סניף');

    setError('');
    setBusy(true);
    try {
      const body = new FormData();
      Object.entries(v).forEach(([k, val]) => val && body.append(k, val));
      // The field name carries what the file IS, so the server files it on the
      // right shelf of the employee's תיק without anybody choosing again.
      Object.entries(files).forEach(([kind, f]) => { if (f) body.append(kind, f); });
      await api.post('/public/employee-registration', body);
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'השליחה נכשלה. נסו שוב, או פנו למשרד.');
    } finally {
      setBusy(false);
    }
  };

  const wrap = (children) => (
    <div dir="rtl" style={{
      fontFamily: '"Assistant", "Segoe UI", Tahoma, sans-serif',
      background: C.pageBg, minHeight: '100vh', color: C.ink,
      padding: 'clamp(24px, 5vw, 56px) 16px',
    }}>
      {children}
    </div>
  );

  if (done) {
    return wrap(
      <div style={{
        maxWidth: 560, margin: '0 auto', textAlign: 'center',
        background: C.glass, border: `1px solid ${C.glassEdge}`,
        borderRadius: 24, padding: 'clamp(32px, 6vw, 52px)', boxShadow: C.shadow,
      }}>
        <div style={{ fontSize: '3.4rem', marginBottom: 10 }} aria-hidden="true">✅</div>
        <h2 style={{ margin: '0 0 12px', fontSize: '1.8rem', fontWeight: 800, color: C.primary }}>
          הפרטים נקלטו
        </h2>
        <p style={{ margin: 0, color: C.muted, lineHeight: 1.75, fontSize: '1.05rem' }}>
          תודה! הפרטים הגיעו למשרד ויעברו בדיקה. אם משהו חסר — ניצור קשר.
        </p>
      </div>,
    );
  }

  return wrap(
    <form
      onSubmit={submit} noValidate
      style={{
        maxWidth: 660, margin: '0 auto', borderRadius: 24, overflow: 'hidden',
        boxShadow: '0 18px 50px rgba(31,38,135,.16)', background: 'rgba(255,255,255,.96)',
      }}
    >
      <header style={{ background: C.rule, color: '#fff', padding: 'clamp(24px, 4vw, 34px) 24px', textAlign: 'center' }}>
        <img
          src="/careers/logo.webp" alt="גן החלומות" width="96" height="64"
          style={{ height: 44, width: 'auto', marginBottom: 10 }}
        />
        <h1 style={{ margin: 0, fontSize: 'clamp(1.45rem, 4vw, 1.95rem)', fontWeight: 800 }}>
          רישום עובד/ת חדש/ה
        </h1>
        <p style={{ margin: '8px 0 0', opacity: .95 }}>ברוכים הבאים למשפחה — נשאר רק למלא פרטים</p>
      </header>

      <div style={{ padding: 'clamp(22px, 4vw, 34px)', display: 'grid', gap: 20 }}>
        <p style={SECTION}>פרטים אישיים</p>

        <div>
          <label style={LABEL} htmlFor="j-name">שם מלא {REQ}</label>
          <input id="j-name" style={FIELD} value={v.full_name} onChange={set('full_name')} autoComplete="name" />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-id">תעודת זהות {REQ}</label>
          <input
            id="j-id" style={FIELD} value={v.israeli_id} onChange={set('israeli_id')}
            inputMode="numeric" placeholder="9 ספרות"
          />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-phone">טלפון {REQ}</label>
          <input id="j-phone" style={FIELD} value={v.phone} onChange={set('phone')} type="tel" inputMode="tel" autoComplete="tel" />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-email">אימייל</label>
          <input id="j-email" style={FIELD} value={v.email} onChange={set('email')} type="email" autoComplete="email" />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-addr">כתובת מגורים</label>
          <input id="j-addr" style={FIELD} value={v.address} onChange={set('address')} autoComplete="street-address" />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-birth">תאריך לידה</label>
          <input id="j-birth" style={FIELD} value={v.birth_date} onChange={set('birth_date')} type="date" />
        </div>
        <div>
          <label style={LABEL} htmlFor="j-branch">סניף {REQ}</label>
          <select id="j-branch" style={FIELD} value={v.branch_id} onChange={set('branch_id')}>
            <option value="">בחרו סניף</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={LABEL} htmlFor="j-pos">תפקיד</label>
          <input id="j-pos" style={FIELD} value={v.position} onChange={set('position')} placeholder="לדוגמה: מטפלת" />
        </div>

        <p style={SECTION}>פרטי בנק למשכורת</p>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div>
            <label style={LABEL} htmlFor="j-bank">בנק</label>
            <input id="j-bank" style={FIELD} value={v.bank_number} onChange={set('bank_number')} inputMode="numeric" placeholder="קוד או שם" />
          </div>
          <div>
            <label style={LABEL} htmlFor="j-bbranch">סניף</label>
            <input id="j-bbranch" style={FIELD} value={v.bank_branch} onChange={set('bank_branch')} inputMode="numeric" />
          </div>
          <div>
            <label style={LABEL} htmlFor="j-acct">מספר חשבון</label>
            <input id="j-acct" style={FIELD} value={v.bank_account} onChange={set('bank_account')} inputMode="numeric" />
          </div>
        </div>
        <div>
          <label style={LABEL} htmlFor="j-holder">שם בעל/ת החשבון</label>
          <input id="j-holder" style={FIELD} value={v.bank_account_holder} onChange={set('bank_account_holder')} placeholder="אם החשבון אינו על שמך" />
        </div>

        <p style={SECTION}>איש קשר לחירום</p>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div>
            <label style={LABEL} htmlFor="j-ename">שם</label>
            <input id="j-ename" style={FIELD} value={v.emergency_name} onChange={set('emergency_name')} />
          </div>
          <div>
            <label style={LABEL} htmlFor="j-ephone">טלפון</label>
            <input id="j-ephone" style={FIELD} value={v.emergency_phone} onChange={set('emergency_phone')} type="tel" inputMode="tel" />
          </div>
          <div>
            <label style={LABEL} htmlFor="j-erel">קרבה</label>
            <input id="j-erel" style={FIELD} value={v.emergency_relation} onChange={set('emergency_relation')} placeholder="בן/בת זוג, הורה…" />
          </div>
        </div>

        <p style={SECTION}>מסמכים</p>
        <FilePick
          label="צילום תעודת זהות"
          file={files.id_document}
          onPick={(f, msg) => { setFiles(s => ({ ...s, id_document: f })); if (msg) setError(msg); }}
          onClear={() => setFiles(s => ({ ...s, id_document: null }))}
        />
        <FilePick
          label="אישור ניהול חשבון בנק"
          file={files.bank_details}
          onPick={(f, msg) => { setFiles(s => ({ ...s, bank_details: f })); if (msg) setError(msg); }}
          onClear={() => setFiles(s => ({ ...s, bank_details: null }))}
        />
        <FilePick
          label="תעודה או הסמכה"
          file={files.certificate}
          onPick={(f, msg) => { setFiles(s => ({ ...s, certificate: f })); if (msg) setError(msg); }}
          onClear={() => setFiles(s => ({ ...s, certificate: null }))}
        />

        <div>
          <label style={LABEL} htmlFor="j-note">הערה</label>
          <textarea
            id="j-note" style={{ ...FIELD, minHeight: 90, resize: 'vertical' }}
            value={v.note} onChange={set('note')} placeholder="משהו שכדאי שנדע…"
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
          type="submit" disabled={busy}
          style={{
            border: 'none', cursor: busy ? 'progress' : 'pointer', font: 'inherit',
            fontWeight: 800, fontSize: '1.12rem', color: '#fff',
            padding: '17px 20px', borderRadius: 999, background: C.rule,
            opacity: busy ? .7 : 1, boxShadow: '0 12px 30px rgba(108,92,231,.32)',
          }}
        >
          {busy ? 'שולח…' : 'שליחת הפרטים'}
        </button>

        <p style={{ margin: 0, color: C.muted, fontSize: '.86rem', lineHeight: 1.6, textAlign: 'center' }}>
          הפרטים נשמרים אצלנו לצורך העסקה בלבד, ממתינים לבדיקה במשרד, ואינם נמסרים לאף גורם אחר.
        </p>
      </div>
    </form>,
  );
}
