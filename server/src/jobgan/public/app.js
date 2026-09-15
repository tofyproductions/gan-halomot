/*
 * ג׳וב חלום — the whole front end, in one file, with no build step.
 *
 * WHY NOT REACT. client/ is shared: the same application is served to גן
 * החלומות and to every customer, and adding a public jobs board to it would
 * put this feature inside the bundle four gans run their day on. That is the
 * exact risk the separate service exists to avoid, and it would be undone by
 * importing one component. So: plain files, served by the jobgan process, that
 * cannot affect anything else.
 */

const API = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

// ---------- session ----------------------------------------------------------

const store = {
  get seekerToken() { return localStorage.getItem('jg_seeker') || null; },
  set seekerToken(v) { v ? localStorage.setItem('jg_seeker', v) : localStorage.removeItem('jg_seeker'); },
  get employerToken() { return localStorage.getItem('jg_employer') || null; },
  set employerToken(v) { v ? localStorage.setItem('jg_employer', v) : localStorage.removeItem('jg_employer'); },
};

let META = { areas: [], roles: [], scopes: [], salary_units: [] };
let SEEKER = null;
let EMPLOYER = null;

const labelOf = (list, id) => (list.find(x => x.id === id) || {}).label || id;
const areaLabel = id => labelOf(META.areas, id);
const roleLabel = id => labelOf(META.roles, id);
const scopeLabel = id => labelOf(META.scopes, id);
const unitLabel = id => labelOf(META.salary_units, id);

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const fmtPay = (j) => `${j.salary_min}–${j.salary_max} ₪ ${unitLabel(j.salary_unit)}`;

async function api(path, { method = 'GET', body, as } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = as === 'seeker' ? store.seekerToken : as === 'employer' ? store.employerToken : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && as) {
    // The token expired or was revoked. Drop it rather than loop on failures.
    if (as === 'seeker') { store.seekerToken = null; SEEKER = null; }
    else { store.employerToken = null; EMPLOYER = null; }
  }
  return { status: res.status, ok: res.ok, json: json || {} };
}

// ---------- shared bits ------------------------------------------------------

function notice(kind, text) {
  return el('div', { class: `notice notice-${kind}` }, text);
}

/**
 * A field that can carry a server-side error.
 *
 * The server answers with { error, field } precisely so the message lands on
 * the input that caused it. A red banner at the top of a form makes somebody
 * hunt for which of eight boxes is wrong — which is where people give up.
 */
function field(label, input, { hint, id } = {}) {
  const wrap = el('div', { class: 'field' },
    el('label', id ? { for: id } : {}, label),
    input,
    hint ? el('span', { class: 'hint' }, hint) : null,
  );
  return wrap;
}
function showFieldError(form, fieldName, message) {
  form.querySelectorAll('.err').forEach(n => n.remove());
  form.querySelectorAll('[aria-invalid]').forEach(n => n.removeAttribute('aria-invalid'));
  const input = fieldName ? form.querySelector(`[name="${fieldName}"]`) : null;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.closest('.field').append(el('span', { class: 'err' }, message));
    input.focus();
  } else {
    form.prepend(notice('bad', message));
  }
}

function select(name, options, value, { placeholder } = {}) {
  const s = el('select', { name, id: name });
  if (placeholder) s.append(el('option', { value: '' }, placeholder));
  for (const o of options) {
    const opt = el('option', { value: o.id }, o.label);
    if (o.id === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

/** Multi-choice as tappable pills. A <select multiple> on a phone is unusable. */
function pillGroup(name, options, selected = []) {
  const chosen = new Set(selected);
  const box = el('div', { class: 'checks' });
  box.getValue = () => [...chosen];
  for (const o of options) {
    const lab = el('label', { class: `check${chosen.has(o.id) ? ' on' : ''}` },
      el('input', { type: 'checkbox', name, value: o.id }), o.label);
    const cb = lab.querySelector('input');
    cb.checked = chosen.has(o.id);
    cb.addEventListener('change', () => {
      if (cb.checked) chosen.add(o.id); else chosen.delete(o.id);
      lab.classList.toggle('on', cb.checked);
    });
    box.append(lab);
  }
  return box;
}

function navBar() {
  const nav = $('#nav');
  nav.replaceChildren();
  if (SEEKER) {
    nav.append(
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/me' }, 'האזור שלי'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { store.seekerToken = null; SEEKER = null; go('/'); } }, 'יציאה'),
    );
  } else if (EMPLOYER) {
    nav.append(
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/employer' }, EMPLOYER.gan_name),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { store.employerToken = null; EMPLOYER = null; go('/'); } }, 'יציאה'),
    );
  } else {
    nav.append(
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/login' }, 'כניסה'),
      el('a', { class: 'btn btn-brand btn-sm', href: '#/employer/login' }, 'פרסום משרה'),
    );
  }
}

// ---------- the board --------------------------------------------------------

const filters = { area: '', role: '', min_salary: '' };

async function viewBoard(view) {
  view.replaceChildren(
    el('div', { class: 'hero' },
      el('div', { class: 'hero-in' },
        el('h1', {}, 'עבודה בגן ילדים, לפי האזור שלך'),
        el('p', {}, 'כל מודעה כאן כוללת טווח שכר. בלי "שכר טוב למתאימות".'),
      )),
  );
  const wrap = el('div', { class: 'wrap' });
  view.append(wrap);

  const areaSel = select('area', META.areas, filters.area, { placeholder: 'כל הארץ' });
  const roleSel = select('role', META.roles, filters.role, { placeholder: 'כל התפקידים' });
  const minInput = el('input', { name: 'min_salary', type: 'number', inputmode: 'numeric', min: '0', placeholder: 'לא משנה', value: filters.min_salary });

  const results = el('div', { class: 'jobs' }, el('div', { class: 'loading' }, 'טוען משרות…'));

  async function load() {
    filters.area = areaSel.value;
    filters.role = roleSel.value;
    filters.min_salary = minInput.value;
    results.replaceChildren(el('div', { class: 'loading' }, 'טוען משרות…'));
    const qs = new URLSearchParams();
    if (filters.area) qs.set('area', filters.area);
    if (filters.role) qs.set('role', filters.role);
    if (filters.min_salary) qs.set('min_salary', filters.min_salary);
    const { json } = await api(`/jobs?${qs}`);
    const jobs = json.jobs || [];
    if (!jobs.length) {
      results.replaceChildren(el('div', { class: 'empty' },
        el('strong', {}, 'אין כרגע משרות שמתאימות לסינון'),
        'אפשר להרחיב את האזור או את התפקיד. הלוח מתעדכן כל הזמן.',
      ));
      return;
    }
    results.replaceChildren(
      el('p', { class: 'meter' }, `${json.total} משרות`),
      ...jobs.map(jobCard),
    );
  }

  [areaSel, roleSel].forEach(s => s.addEventListener('change', load));
  let t; minInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 350); });

  wrap.append(
    el('div', { class: 'filters' },
      field('אזור', areaSel, { id: 'area' }),
      field('תפקיד', roleSel, { id: 'role' }),
      field('שכר מינימלי', minInput, { id: 'min_salary' }),
      el('button', { class: 'btn btn-brand', onclick: load }, 'חיפוש'),
    ),
    results,
  );
  await load();
}

function jobCard(j) {
  return el('a', { class: `job${j.promoted ? ' promoted' : ''}`, href: `#/job/${j.id}` },
    el('h3', {}, j.title),
    el('p', { class: 'gan' }, [j.gan_name, j.city].filter(Boolean).join(' · ')),
    el('div', { class: 'facts' },
      el('span', { class: 'tag area' }, areaLabel(j.area)),
      el('span', { class: 'tag' }, roleLabel(j.role)),
      el('span', { class: 'tag' }, scopeLabel(j.scope)),
    ),
    el('div', { class: 'pay' }, fmtPay(j)),
  );
}

async function viewJob(view, id) {
  view.replaceChildren(el('div', { class: 'wrap' }, el('div', { class: 'loading' }, 'טוען…')));
  const { status, json } = await api(`/jobs/${id}`);
  const wrap = el('div', { class: 'wrap' });
  view.replaceChildren(wrap);
  if (status !== 200) {
    wrap.append(notice('warn', 'המשרה כבר לא פעילה.'), el('a', { class: 'btn btn-brand', href: '#/' }, 'חזרה ללוח'));
    return;
  }
  const j = json.job;
  const panel = el('div', { class: 'panel' },
    el('h2', {}, j.title),
    el('p', { class: 'sub' }, [j.gan_name, j.city].filter(Boolean).join(' · ')),
    el('div', { class: 'facts' },
      el('span', { class: 'tag area' }, areaLabel(j.area)),
      el('span', { class: 'tag' }, roleLabel(j.role)),
      el('span', { class: 'tag' }, scopeLabel(j.scope)),
    ),
    el('dl', { class: 'kv' },
      el('dt', {}, 'שכר'), el('dd', { class: 'pay' }, fmtPay(j)),
      el('dt', {}, 'תחילת עבודה'), el('dd', {}, fmtDate(j.starts_on)),
    ),
    j.description ? el('p', { style: 'margin-top:.9rem;white-space:pre-wrap' }, j.description) : null,
  );
  wrap.append(panel);

  if (!SEEKER) {
    panel.append(
      notice('info', 'כדי להגיש מועמדות צריך חשבון. ההרשמה לוקחת כדקה.'),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn-primary', href: `#/register?job=${j.id}` }, 'הרשמה והגשת מועמדות'),
        el('a', { class: 'btn btn-ghost', href: `#/login?job=${j.id}` }, 'יש לי כבר חשבון'),
      ),
    );
    return;
  }
  const msg = el('textarea', { name: 'message', maxlength: '1000', placeholder: 'אפשר להוסיף כמה מילים לגן (לא חובה)' });
  const out = el('div');
  panel.append(
    el('hr', { style: 'border:0;border-top:1px solid var(--rule);margin:1.1rem 0' }),
    field('הודעה לגן', msg, { hint: 'הגן יראה את פרטייך רק כשיפתח את המועמדות.' }),
    out,
    el('button', {
      class: 'btn btn-primary',
      onclick: async (e) => {
        e.target.disabled = true;
        const r = await api(`/jobs/${j.id}/apply`, { method: 'POST', as: 'seeker', body: { message: msg.value } });
        if (r.status === 201) {
          out.replaceChildren(notice('good', r.json.message || 'המועמדות נשלחה.'));
          e.target.remove();
        } else {
          out.replaceChildren(notice('bad', r.json.error || 'לא הצלחנו לשלוח.'));
          e.target.disabled = false;
        }
      },
    }, 'הגשת מועמדות'),
  );
}

// ---------- seeker: register, login, her own area ----------------------------

function qsParam(name) {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get(name);
}

/**
 * Seven fields, and that is the whole argument.
 *
 * Every question added here costs a percentage of the people who finish, and
 * this is the side that does not pay us and without which there is no board.
 * Experience, training and references live in her own area afterwards, where
 * she can add them at leisure — a gan would rather have somebody who signed up
 * in ninety seconds than a perfect form nobody completed.
 */
async function viewSeekerRegister(view) {
  const backTo = qsParam('job');
  const areas = pillGroup('areas', META.areas);
  const roles = pillGroup('roles', META.roles);
  const form = el('form', { class: 'panel' },
    el('h2', {}, 'הרשמה'),
    el('p', { class: 'sub' }, 'שבעה שדות. אפשר להשלים פרטים אחר כך.'),
    field('שם מלא', el('input', { name: 'full_name', required: true, autocomplete: 'name' }), { id: 'full_name' }),
    field('טלפון', el('input', { name: 'phone', type: 'tel', inputmode: 'tel', required: true, autocomplete: 'tel', placeholder: '0501234567' }), { id: 'phone' }),
    field('אימייל', el('input', { name: 'email', type: 'email', autocomplete: 'email' }), { hint: 'לא חובה. משמש רק לעדכונים על המועמדויות שלך.', id: 'email' }),
    field('סיסמה', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' }), { hint: 'לפחות 8 תווים.', id: 'password' }),
    field('אזורים שמתאימים לך', areas),
    field('תפקידים שאת מחפשת', roles),
    field('היקף משרה', select('scope', META.scopes, 'full'), { id: 'scope' }),
    field('מתי תוכלי להתחיל', el('input', { name: 'available_from', type: 'date' }), { id: 'available_from' }),
    field('קצת עלייך', el('textarea', { name: 'about', maxlength: '600', placeholder: 'שלוש שורות — ניסיון, מה חשוב לך' }), { id: 'about' }),
    el('label', { class: 'check', style: 'align-self:start' },
      el('input', { type: 'checkbox', name: 'wants_job_alerts' }), 'לקבל עדכון על משרות חדשות באזור שלי'),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'הרשמה'),
    el('p', { class: 'hint', style: 'margin:.8rem 0 0' },
      'בהרשמה את מאשרת את ',
      el('a', { href: '#/terms' }, 'תנאי השימוש'), ' ו', el('a', { href: '#/privacy' }, 'מדיניות הפרטיות'),
      '. הפרטים שלך נמסרים רק לגן שאליו תגישי מועמדות.'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = {
      full_name: fd.full_name, phone: fd.phone, email: fd.email, password: fd.password,
      areas: areas.getValue(), roles: roles.getValue(), scope: fd.scope,
      available_from: fd.available_from || null, about: fd.about,
      wants_job_alerts: Boolean(fd.wants_job_alerts),
    };
    const r = await api('/seekers/register', { method: 'POST', body });
    if (r.status === 201) {
      store.seekerToken = r.json.token; SEEKER = r.json.seeker; navBar();
      go(backTo ? `/job/${backTo}` : '/me');
    } else {
      showFieldError(form, r.json.field, r.json.error || 'ההרשמה נכשלה.');
    }
  });
  view.replaceChildren(el('div', { class: 'wrap' }, form));
}

async function viewSeekerLogin(view) {
  const backTo = qsParam('job');
  const form = el('form', { class: 'panel' },
    el('h2', {}, 'כניסה'),
    el('p', { class: 'sub' }, 'עם הטלפון שאיתו נרשמת.'),
    field('טלפון', el('input', { name: 'phone', type: 'tel', inputmode: 'tel', required: true, autocomplete: 'tel' }), { id: 'phone' }),
    field('סיסמה', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' }), { id: 'password' }),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'כניסה'),
    el('p', { style: 'margin:.9rem 0 0' }, 'אין לך חשבון? ', el('a', { href: '#/register' }, 'להרשמה')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('/seekers/login', { method: 'POST', body: { phone: fd.phone, password: fd.password, rememberMe: true } });
    if (r.ok) {
      store.seekerToken = r.json.token; SEEKER = r.json.seeker; navBar();
      go(backTo ? `/job/${backTo}` : '/me');
    } else {
      showFieldError(form, null, r.json.error || 'הכניסה נכשלה.');
    }
  });
  view.replaceChildren(el('div', { class: 'wrap' }, form));
}

const APP_STATUS = {
  new:        ['pill-wait', 'ממתינה לתשובה'],
  invited:    ['pill-ok', 'הוזמנת לראיון'],
  rejected:   ['pill-off', 'לא מתאים כרגע'],
  job_closed: ['pill-off', 'המשרה נסגרה'],
  withdrawn:  ['pill-off', 'ביטלת'],
};

async function viewSeekerHome(view) {
  const wrap = el('div', { class: 'wrap' });
  view.replaceChildren(wrap);
  const apps = (await api('/seekers/me/applications', { as: 'seeker' })).json.applications || [];
  const c = SEEKER.completeness || { filled: 0, total: 7 };

  wrap.append(
    el('div', { class: 'panel' },
      el('h2', {}, `שלום ${SEEKER.full_name}`),
      el('p', { class: 'meter' }, 'הפרופיל שלך: ', el('b', {}, `${c.filled} מתוך ${c.total}`), ' — גנים רואים את זה.'),
      el('div', { class: 'btn-row', style: 'margin-top:.8rem' },
        el('a', { class: 'btn btn-brand', href: '#/' }, 'חיפוש משרות'),
        el('a', { class: 'btn btn-ghost', href: '#/profile' }, 'עריכת הפרופיל'),
      ),
    ),
    el('div', { class: 'panel' },
      el('h2', {}, 'המועמדויות שלי'),
      apps.length
        ? el('div', {}, ...apps.map(a => {
          const [cls, label] = APP_STATUS[a.status] || ['pill-wait', a.status];
          return el('div', { class: 'rowitem' },
            el('div', { class: 'head' },
              el('h4', {}, a.job_title),
              el('span', { class: `pill ${cls}` }, label)),
            el('p', { class: 'meter', style: 'margin:.3rem 0 0' },
              [a.area, a.role].filter(Boolean).join(' · '), ' · הוגשה ', fmtDate(a.created_at)));
        }))
        : el('div', { class: 'empty' }, el('strong', {}, 'עוד לא הגשת מועמדות'), 'המשרות מחכות בלוח.'),
    ),
  );
}

async function viewSeekerProfile(view) {
  const s = SEEKER;
  const areas = pillGroup('areas', META.areas, s.areas);
  const roles = pillGroup('roles', META.roles, s.roles);
  const out = el('div');

  const form = el('form', { class: 'panel' },
    el('h2', {}, 'הפרופיל שלי'),
    el('p', { class: 'sub' }, 'כל מה שכאן אופציונלי חוץ מהשם והטלפון.'),
    out,
    field('שם מלא', el('input', { name: 'full_name', value: s.full_name, required: true })),
    field('אימייל', el('input', { name: 'email', type: 'email', value: s.email || '' })),
    field('אזורים', areas),
    field('תפקידים', roles),
    field('היקף משרה', select('scope', META.scopes, s.scope)),
    field('זמינות להתחלה', el('input', { name: 'available_from', type: 'date', value: s.available_from ? String(s.available_from).slice(0, 10) : '' })),
    field('קצת עלייך', el('textarea', { name: 'about', maxlength: '600' }, s.about || '')),
    field('שנות ניסיון', el('input', { name: 'experience_years', type: 'number', min: '0', value: s.experience_years ?? '' })),
    field('הכשרה והשכלה', el('input', { name: 'training', value: s.training || '' })),
    field('ממליצים', el('input', { name: 'references', value: s.references || '' })),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'שמירה'),
  );
  form.querySelector('textarea[name="about"]').value = s.about || '';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('/seekers/me', {
      method: 'PATCH', as: 'seeker',
      body: {
        full_name: fd.full_name, email: fd.email, scope: fd.scope,
        areas: areas.getValue(), roles: roles.getValue(),
        available_from: fd.available_from || null, about: fd.about,
        experience_years: fd.experience_years === '' ? null : Number(fd.experience_years),
        training: fd.training, references: fd.references,
      },
    });
    if (r.ok) { SEEKER = r.json.seeker; out.replaceChildren(notice('good', 'נשמר.')); }
    else out.replaceChildren(notice('bad', r.json.error || 'השמירה נכשלה.'));
  });

  // The declaration, and the sentence that has to sit beside it. The document
  // is never uploaded — there is no route that would accept one — and the gan
  // is the one required to see the certificate itself.
  const certOut = el('div');
  const cert = el('form', { class: 'panel' },
    el('h2', {}, 'אישור היעדר עבירות מין'),
    el('p', { class: 'sub' }, 'סימון בלבד. איננו מבקשים את המסמך ולא שומרים אותו. הגן חייב לבדוק אותו בעצמו לפני העסקה.'),
    certOut,
    el('label', { class: 'check', style: 'align-self:start' },
      el('input', { type: 'checkbox', name: 'declared' }), 'יש ברשותי אישור בתוקף'),
    el('div', { class: 'stack two' },
      field('בתוקף מתאריך', el('input', { name: 'from', type: 'date', value: s.police_cert_valid_from ? String(s.police_cert_valid_from).slice(0, 10) : '' })),
      field('בתוקף עד תאריך', el('input', { name: 'to', type: 'date', value: s.police_cert_valid_to ? String(s.police_cert_valid_to).slice(0, 10) : '' })),
    ),
    el('button', { class: 'btn btn-brand', type: 'submit' }, 'שמירת הסימון'),
  );
  cert.querySelector('input[name="declared"]').checked = Boolean(s.police_cert_declared);
  cert.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(cert));
    const r = await api('/seekers/me', {
      method: 'PATCH', as: 'seeker',
      body: {
        police_cert_declared: Boolean(fd.declared),
        police_cert_valid_from: fd.from || null,
        police_cert_valid_to: fd.to || null,
      },
    });
    if (r.ok) { SEEKER = r.json.seeker; certOut.replaceChildren(notice('good', 'נשמר.')); }
    else certOut.replaceChildren(notice('bad', r.json.error || 'השמירה נכשלה.'));
  });

  const delOut = el('div');
  const danger = el('div', { class: 'panel' },
    el('h2', {}, 'מחיקת החשבון'),
    el('p', { class: 'sub' }, 'המחיקה מיידית. גן שכבר קיבל את פנייתך מחזיק עותק אצלו — נעדכן אותו בבקשה, אך לא נוכל לאכוף אותה עליו.'),
    delOut,
    el('button', {
      class: 'btn btn-ghost',
      onclick: async () => {
        if (!confirm('למחוק את החשבון? הפעולה אינה הפיכה.')) return;
        const r = await api('/seekers/me', { method: 'DELETE', as: 'seeker' });
        if (r.ok) {
          store.seekerToken = null; SEEKER = null; navBar();
          view.replaceChildren(el('div', { class: 'wrap' }, el('div', { class: 'panel' },
            el('h2', {}, 'החשבון נמחק'),
            el('p', { class: 'sub' }, r.json.notice || ''),
            el('a', { class: 'btn btn-brand', href: '#/' }, 'ללוח המשרות'))));
        } else delOut.replaceChildren(notice('bad', r.json.error || 'המחיקה נכשלה.'));
      },
    }, 'מחיקת החשבון שלי'),
  );

  view.replaceChildren(el('div', { class: 'wrap' }, form, cert, danger));
}

// ---------- employer ---------------------------------------------------------

async function viewEmployerLogin(view) {
  const login = el('form', { class: 'panel' },
    el('h2', {}, 'כניסת גנים'),
    field('אימייל', el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('סיסמה', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    el('button', { class: 'btn btn-brand', type: 'submit' }, 'כניסה'),
    el('p', { style: 'margin:.9rem 0 0' }, 'גן חדש? ', el('a', { href: '#/employer/register' }, 'הרשמה — פרסום חינם')),
  );
  login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(login));
    const r = await api('/employers/login', { method: 'POST', body: { email: fd.email, password: fd.password, rememberMe: true } });
    if (r.ok) { store.employerToken = r.json.token; EMPLOYER = r.json.employer; navBar(); go('/employer'); }
    else showFieldError(login, null, r.json.error || 'הכניסה נכשלה.');
  });
  view.replaceChildren(el('div', { class: 'wrap' }, login));
}

async function viewEmployerRegister(view) {
  const form = el('form', { class: 'panel' },
    el('h2', {}, 'הרשמת גן'),
    el('p', { class: 'sub' }, 'הפרסום חינם. פתוח לכל גן בישראל.'),
    field('שם הגן', el('input', { name: 'gan_name', required: true })),
    field('שם איש הקשר', el('input', { name: 'contact_name', required: true, autocomplete: 'name' })),
    field('טלפון', el('input', { name: 'contact_phone', type: 'tel', inputmode: 'tel', required: true, autocomplete: 'tel' })),
    field('אימייל', el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' }), { hint: 'לכאן יגיעו ההודעות על מועמדויות.' }),
    field('מספר עוסק / ח.פ. / עמותה', el('input', { name: 'business_id' }), { hint: 'לא חובה, ומזרז את הבדיקה.' }),
    field('סיסמה', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' }), { hint: 'לפחות 8 תווים.' }),
    el('button', { class: 'btn btn-brand', type: 'submit' }, 'הרשמה'),
    el('p', { class: 'hint', style: 'margin:.8rem 0 0' },
      'ההרשמה כפופה ל', el('a', { href: '#/terms' }, 'תנאי השימוש'),
      '. פרטי מועמדת מיועדים לבחינת מועמדותה למשרה בלבד.'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('/employers/register', { method: 'POST', body: fd });
    if (r.status === 201) {
      store.employerToken = r.json.token; EMPLOYER = r.json.employer; navBar();
      go('/employer');
    } else showFieldError(form, r.json.field, r.json.error || 'ההרשמה נכשלה.');
  });
  view.replaceChildren(el('div', { class: 'wrap' }, form));
}

const JOB_STATUS = {
  published: ['pill-ok', 'מפורסמת'],
  pending:   ['pill-wait', 'בבדיקה'],
  draft:     ['pill-off', 'לא פורסמה'],
  closed:    ['pill-off', 'סגורה'],
};

async function viewEmployerHome(view) {
  const wrap = el('div', { class: 'wrap' });
  view.replaceChildren(wrap);

  const tabs = el('div', { class: 'tabs' });
  const body = el('div', {}, el('div', { class: 'loading' }, 'טוען…'));
  const which = qsParam('tab') || 'jobs';

  for (const [id, label] of [['jobs', 'המשרות שלי'], ['inbox', 'מועמדויות'], ['new', 'פרסום משרה']]) {
    tabs.append(el('button', {
      class: `tab${which === id ? ' on' : ''}`,
      onclick: () => go(`/employer?tab=${id}`),
    }, label));
  }

  wrap.append(
    el('div', { class: 'panel', style: 'padding-bottom:.6rem' },
      el('h2', {}, EMPLOYER.gan_name),
      EMPLOYER.status === 'pending'
        ? notice('warn', 'המודעה הראשונה שלך נבדקת על ידינו ותפורסם עד שלושה ימי עסקים. זו בדיקה חד־פעמית — המודעות הבאות יתפרסמו מיד.')
        : null,
      EMPLOYER.is_customer
        ? null
        : notice('info', 'הגן אינו מנוי על מערכת חלום. מועמדויות מגיעות במייל. ללקוחות המערכת המועמדות נכנסת ישירות למסך הגיוס והופכת לעובדת בלחיצה.'),
    ),
    tabs, body,
  );

  if (which === 'jobs') await tabJobs(body);
  else if (which === 'inbox') await tabInbox(body);
  else await tabNewJob(body);
}

async function tabJobs(body) {
  const { json } = await api('/employers/jobs', { as: 'employer' });
  const jobs = json.jobs || [];
  if (!jobs.length) {
    body.replaceChildren(el('div', { class: 'empty' },
      el('strong', {}, 'עוד לא פרסמת משרה'),
      el('a', { class: 'btn btn-primary', href: '#/employer?tab=new', style: 'margin-top:.8rem' }, 'פרסום משרה')));
    return;
  }
  body.replaceChildren(...jobs.map((j) => {
    const [cls, label] = JOB_STATUS[j.status] || ['pill-wait', j.status];
    const row = el('div', { class: 'rowitem' },
      el('div', { class: 'head' },
        el('h4', {}, j.title),
        el('span', { class: `pill ${cls}` }, label),
        j.applications.new ? el('span', { class: 'pill pill-new' }, `${j.applications.new} חדשות`) : null),
      el('p', { class: 'meter', style: 'margin:.3rem 0 .5rem' },
        `${areaLabel(j.area)} · ${roleLabel(j.role)} · ${j.salary_min}–${j.salary_max} ₪ ${unitLabel(j.salary_unit)}`,
        j.expires_at && j.status === 'published' ? ` · נסגרת ב־${fmtDate(j.expires_at)}` : ''),
      j.flagged_grounds && j.flagged_grounds.length
        ? notice('bad', `המודעה לא פורסמה. נוסח שדורש או מעדיף לפי ${j.flagged_grounds.join(', ')} אסור על פי חוק שוויון ההזדמנויות בעבודה.`)
        : null,
    );
    if (j.status !== 'closed') {
      row.append(el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn-ghost btn-sm', href: `#/employer?tab=inbox&job=${j._id}` }, `מועמדויות (${j.applications.total})`),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: async (e) => {
            if (!confirm('לסגור את המודעה? מועמדויות שממתינות ייסגרו והמועמדות יעודכנו.')) return;
            e.target.disabled = true;
            const r = await api(`/employers/jobs/${j._id}/close`, { method: 'POST', as: 'employer', body: { reason: 'filled' } });
            if (r.ok) go('/employer?tab=jobs');
          },
        }, 'סגירת המודעה')));
    }
    return row;
  }));
}

async function tabInbox(body) {
  const jobFilter = qsParam('job');
  const { json } = await api(`/employers/applications${jobFilter ? `?job_id=${jobFilter}` : ''}`, { as: 'employer' });
  const apps = json.applications || [];
  if (!apps.length) {
    body.replaceChildren(el('div', { class: 'empty' },
      el('strong', {}, 'אין מועמדויות עדיין'),
      'נשלח לך מייל ברגע שתגיע מועמדות.'));
    return;
  }
  body.replaceChildren(...apps.map(a => applicationRow(a)));
}

/**
 * Before opening: no name, no telephone. The policy promises her that her
 * details appear when the gan OPENS the application, and a list that shows the
 * name has already broken it — so the card genuinely has nothing to show until
 * the button is pressed, and pressing it is recorded.
 */
function applicationRow(a) {
  const [cls, label] = APP_STATUS[a.status] || ['pill-wait', a.status];
  const row = el('div', { class: 'rowitem' });
  const details = el('div');

  const renderOpen = (app) => {
    details.replaceChildren(
      app.deleted_by_seeker
        ? notice('warn', 'המועמדת מחקה את חשבונה.')
        : el('dl', { class: 'kv' },
          el('dt', {}, 'שם'), el('dd', {}, app.full_name),
          el('dt', {}, 'טלפון'), el('dd', {}, el('a', { href: `tel:${app.phone}` }, app.phone)),
          app.email ? el('dt', {}, 'אימייל') : null, app.email ? el('dd', {}, app.email) : null,
          el('dt', {}, 'אזורים'), el('dd', {}, (app.areas || []).join(', ') || '—'),
          el('dt', {}, 'תפקידים'), el('dd', {}, (app.roles || []).join(', ') || '—'),
          el('dt', {}, 'זמינות'), el('dd', {}, fmtDate(app.available_from) || '—'),
          app.experience_years != null ? el('dt', {}, 'ניסיון') : null,
          app.experience_years != null ? el('dd', {}, `${app.experience_years} שנים`) : null,
          app.training ? el('dt', {}, 'הכשרה') : null, app.training ? el('dd', {}, app.training) : null,
          el('dt', {}, 'אישור משטרה'),
          el('dd', {}, app.police_cert_declared
            ? `הצהירה שיש בתוקף${app.police_cert_valid_to ? ` עד ${fmtDate(app.police_cert_valid_to)}` : ''}`
            : 'לא סימנה'),
          app.about ? el('dt', {}, 'עליה') : null, app.about ? el('dd', {}, app.about) : null,
          app.message ? el('dt', {}, 'הודעה') : null, app.message ? el('dd', {}, app.message) : null,
        ),
      notice('warn', 'החובה לקבל ולבדוק אישור היעדר עבירות מין חלה על הגן המעסיק. הסימון כאן אינו מסמך ואינו מחליף בדיקה.'),
    );
  };

  row.append(
    el('div', { class: 'head' },
      el('h4', {}, a.job_title || 'משרה'),
      el('span', { class: `pill ${cls}` }, label),
      a.deletion_requested ? el('span', { class: 'pill pill-off' }, 'ביקשה מחיקה') : null),
    el('p', { class: 'meter', style: 'margin:.3rem 0 .5rem' },
      `הוגשה ${fmtDate(a.created_at)} · פרופיל ${a.completeness.filled} מתוך ${a.completeness.total}`),
    details,
  );

  const actions = el('div', { class: 'btn-row' });
  if (!a.opened) {
    actions.append(el('button', {
      class: 'btn btn-brand btn-sm',
      onclick: async (e) => {
        e.target.disabled = true;
        const r = await api(`/employers/applications/${a.id}/open`, { method: 'POST', as: 'employer' });
        if (r.ok) { renderOpen(r.json.application); e.target.remove(); addAnswerButtons(); }
      },
    }, 'פתיחת המועמדות'));
  } else {
    renderOpen(a);
  }

  function addAnswerButtons() {
    if (a.status !== 'new') return;
    for (const [status, text, cls2] of [['invited', 'מזמינים לראיון', 'btn-primary'], ['rejected', 'לא מתאים כרגע', 'btn-ghost']]) {
      actions.append(el('button', {
        class: `btn ${cls2} btn-sm`,
        onclick: async () => {
          const r = await api(`/employers/applications/${a.id}/answer`, { method: 'POST', as: 'employer', body: { status } });
          if (r.ok) { actions.replaceChildren(notice('good', 'התשובה נשלחה למועמדת.')); }
          else actions.replaceChildren(notice('bad', r.json.error || 'לא הצלחנו לשלוח.'));
        },
      }, text));
    }
  }
  if (a.opened) addAnswerButtons();
  row.append(actions);
  return row;
}

async function tabNewJob(body) {
  const out = el('div');
  const form = el('form', {},
    out,
    field('כותרת המשרה', el('input', { name: 'title', required: true, placeholder: 'גננת לגן פרטי' })),
    el('div', { class: 'stack two' },
      field('אזור', select('area', META.areas, '', { placeholder: 'בחרי אזור' })),
      field('תפקיד', select('role', META.roles, '', { placeholder: 'בחרי תפקיד' })),
    ),
    el('div', { class: 'stack two' },
      field('היקף משרה', select('scope', META.scopes, 'full')),
      field('יישוב', el('input', { name: 'city', placeholder: 'כפר סבא' })),
    ),
    el('div', { class: 'stack two' },
      field('שכר — מ', el('input', { name: 'salary_min', type: 'number', inputmode: 'numeric', min: '0', required: true })),
      field('שכר — עד', el('input', { name: 'salary_max', type: 'number', inputmode: 'numeric', min: '0', required: true })),
    ),
    field('השכר הוא', select('salary_unit', META.salary_units, 'hourly')),
    field('תחילת עבודה', el('input', { name: 'starts_on', type: 'date', required: true })),
    field('תיאור', el('textarea', { name: 'description', maxlength: '4000', placeholder: 'על הגן, על הצוות, על המשרה' })),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'פרסום המשרה'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('/employers/jobs', { method: 'POST', as: 'employer', body: fd });
    if (r.status === 201) {
      out.replaceChildren(notice('good', r.json.message));
      setTimeout(() => go('/employer?tab=jobs'), 900);
    } else if (r.status === 200 && r.json.blocked) {
      // Not a rejection. Most gan managers do not know these phrases are
      // unlawful, and a refusal that explains is the half a Facebook group
      // will never give them.
      out.replaceChildren(notice('bad', r.json.message));
      out.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      showFieldError(form, r.json.field, r.json.error || 'הפרסום נכשל.');
    }
  });

  body.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, 'פרסום משרה'),
    el('p', { class: 'sub' }, 'טווח שכר הוא שדה חובה. מודעה בלי שכר כמעט אף פעם לא נענית.'),
    form));
}

// ---------- legal pages ------------------------------------------------------

/**
 * ⚠️ PLACEHOLDERS. The real text is a separate draft awaiting a lawyer, and
 * the entity's registered name is awaiting the accountant. These pages exist
 * so the links in the sign-up forms go somewhere rather than nowhere — a
 * consent checkbox pointing at a 404 is worse than no checkbox.
 */
function legalStub(view, title) {
  view.replaceChildren(el('div', { class: 'wrap' },
    el('div', { class: 'panel' },
      el('h2', {}, title),
      notice('warn', 'הנוסח המלא בהכנה ויפורסם לפני ההשקה.'),
      el('p', {}, 'בקצרה, וזה מה שיופיע גם בנוסח המלא:'),
      el('ul', {},
        el('li', {}, 'פרטי מועמדת נמסרים אך ורק לגן שאליו היא הגישה מועמדות. אין מאגר שגנים מעיינים בו.'),
        el('li', {}, 'הפרטים נחשפים בפני הגן רק כשהוא פותח את המועמדות, ונרשם מי פתח ומתי.'),
        el('li', {}, 'פרטי מועמדת שלא התקבלה נשמרים עד שלושה חודשים.'),
        el('li', {}, 'יש כפתור מחיקת חשבון שמוחק מיד. גן שכבר קיבל את הפנייה מחזיק עותק אצלו ומעודכן בבקשת המחיקה.'),
        el('li', {}, 'איננו מבקשים ואיננו שומרים את אישור היעדר עבירות מין. החובה לקבלו ולבדקו חלה על הגן המעסיק.'),
        el('li', {}, 'איננו בודקים מועמדות ואיננו צד ליחסי עבודה.'),
      ),
      el('a', { class: 'btn btn-ghost', href: '#/' }, 'חזרה ללוח'))));
}

// ---------- router -----------------------------------------------------------

function go(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
}

async function render() {
  const view = $('#view');
  const raw = (location.hash || '#/').slice(1);
  const path = raw.split('?')[0] || '/';
  navBar();

  // Gates first, so a bookmarked private page cannot render a shell that then
  // fills with somebody else's data.
  if (path.startsWith('/me') || path.startsWith('/profile')) {
    if (!SEEKER) return go('/login');
  }
  if (path === '/employer' && !EMPLOYER) return go('/employer/login');

  if (path === '/' || path === '') return viewBoard(view);
  if (path.startsWith('/job/')) return viewJob(view, path.slice(5));
  if (path === '/register') return viewSeekerRegister(view);
  if (path === '/login') return viewSeekerLogin(view);
  if (path === '/me') return viewSeekerHome(view);
  if (path === '/profile') return viewSeekerProfile(view);
  if (path === '/employer/login') return viewEmployerLogin(view);
  if (path === '/employer/register') return viewEmployerRegister(view);
  if (path === '/employer') return viewEmployerHome(view);
  if (path === '/privacy') return legalStub(view, 'מדיניות פרטיות');
  if (path === '/terms') return legalStub(view, 'תנאי שימוש');

  view.replaceChildren(el('div', { class: 'wrap' },
    el('div', { class: 'empty' },
      el('strong', {}, 'הדף לא נמצא'),
      el('a', { class: 'btn btn-brand', href: '#/', style: 'margin-top:.8rem' }, 'ללוח המשרות'))));
}

async function boot() {
  // The closed lists come from the server so the front end never holds a
  // second copy of them that can drift out of step with the one that validates.
  const meta = await api('/meta');
  if (meta.ok) META = meta.json;

  // Restore whichever session is present. Both can be, on a shared computer;
  // they are separate keys and separate tokens, and neither opens the other's
  // screens.
  if (store.seekerToken) {
    const r = await api('/seekers/me', { as: 'seeker' });
    SEEKER = r.ok ? r.json.seeker : null;
  }
  if (store.employerToken) {
    const r = await api('/employers/me', { as: 'employer' });
    EMPLOYER = r.ok ? r.json.employer : null;
  }

  window.addEventListener('hashchange', render);
  render();
}

boot();
