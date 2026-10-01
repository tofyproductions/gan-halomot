import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, Alert, TextField, Chip, IconButton, Tooltip,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api, { apiError } from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';
import { formatDay, formatILS, docAmountText, DOC_TYPE_LABEL } from './expenseFormat';
import { IcountSourceChip } from './ExpenseCards';

/** One independent block: its own load, its own error — a failing block never hides the others. */
function useLoad(url, pick) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const { data } = await api.get(url);
      if (my === seq.current) setState({ loading: false, error: '', data: pick(data) });
    } catch (err) {
      if (my === seq.current) setState({ loading: false, error: apiError(err, 'הטעינה נכשלה'), data: null });
    }
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

function Block({ title, state, reload, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>{title}</Typography>
      {state.error ? (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={reload}>נסו שוב</Button>}>{state.error}</Alert>
      ) : state.loading && state.data == null ? (
        <Typography variant="body2" color="text.secondary">טוען…</Typography>
      ) : children}
    </Paper>
  );
}

function Intake({ canWrite, onChanged }) {
  const [state, reload] = useLoad('/expenses/intake/status', d => d);
  const [busy, setBusy] = useState(false);
  const pull = async () => {
    setBusy(true);
    try {
      const { data: r } = await api.post('/expenses/intake/pull');
      toast[r.errors ? 'warning' : 'success'](`נמשכו ${r.fetched} · נוספו ${r.created} · דולגו ${r.skipped}${r.skipped_old ? ` · ${r.skipped_old} לפני תאריך ההתחלה` : ''}${r.errors ? ` · ${r.errors} שגיאות` : ''}`);
      reload(); onChanged();
    } catch (err) { toast.error(apiError(err, 'המשיכה נכשלה')); }
    finally { setBusy(false); }
  };
  const s = state.data;
  return (
    <Block title="📨 משיכה ממיון המיילים" state={state} reload={reload}>
      {s && (
        <Stack spacing={1}>
          {!s.mail_sorter_configured && <Alert severity="warning">מיון המיילים לא מוגדר בשרת — מסמכים נכנסים רק ידנית.</Alert>}
          <Typography variant="body2">
            משיכה אחרונה: {s.last_pulled_at ? new Date(s.last_pulled_at).toLocaleString('he-IL') : 'עוד לא נמשך דבר'}
          </Typography>
          <Typography variant="body2">ממתינים לבדיקת קריאה: {s.needs_review}</Typography>
          <Typography variant="caption" color="text.secondary">המשיכה רצה לבד כל 6 שעות.</Typography>
          {canWrite && s.mail_sorter_configured && (
            <Box><BusyButton variant="outlined" loading={busy} loadingText="מושך…" onClick={pull}>משוך עכשיו</BusyButton></Box>
          )}
        </Stack>
      )}
    </Block>
  );
}

function Rules({ canWrite, onChanged }) {
  const confirm = useConfirm();
  const [state, reload] = useLoad('/expenses/rules', d => d.rules || []);
  const [form, setForm] = useState({ label: '', pattern: '', note: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const add = async (e) => {
    e.preventDefault();
    if (form.pattern.trim().length < 2) { toast.error('התבנית קצרה מדי'); return; }
    setBusy(true);
    try {
      await api.post('/expenses/rules', form);
      toast.success('הכלל נוסף');
      setForm({ label: '', pattern: '', note: '' });
      reload(); onChanged();
    } catch (err) { toast.error(apiError(err, 'הוספת הכלל נכשלה')); }
    finally { setBusy(false); }
  };
  const remove = async (rule) => {
    if (!(await confirm({ title: 'מחיקת כלל', message: `למחוק את "${rule.label}"? חיובים שהוא תפס יחזרו לרשימת החיובים בלי מסמך.`, confirm_label: 'מחק', danger: true }))) return;
    try { await api.delete(`/expenses/rules/${rule._id}`); toast.success('הכלל נמחק'); reload(); onChanged(); }
    catch (err) { toast.error(apiError(err, 'המחיקה נכשלה')); }
  };

  return (
    <Block title="📏 חיובים שלא צריכים חשבונית" state={state} reload={reload}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        חיוב שתיאורו מכיל את התבנית לא יוצע לשיוך (עמלות, משכורות, מסים). הכלל לא סוגר מסמך.
      </Typography>
      <Stack spacing={0.75}>
        {(state.data || []).map(r => (
          <Stack key={r._id} direction="row" spacing={1} alignItems="center" justifyContent="space-between"
            sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{r.label} <Typography component="span" variant="caption" color="text.secondary">· "{r.pattern}"</Typography></Typography>
              {r.note && <Typography variant="caption" color="text.secondary">{r.note}</Typography>}
            </Box>
            {r.built_in ? <Chip size="small" label="מובנה" /> : canWrite && (
              <Tooltip title="מחיקה"><IconButton size="small" aria-label="מחיקת כלל" onClick={() => remove(r)}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
            )}
          </Stack>
        ))}
        {state.data && !state.data.length && <Typography variant="body2" color="text.secondary">אין כללים.</Typography>}
      </Stack>
      {canWrite && (
        <Box component="form" onSubmit={add} sx={{ mt: 1.5, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr auto' } }}>
          <TextField size="small" label="תבנית (מתוך תיאור החיוב)" value={form.pattern} onChange={set('pattern')} required />
          <TextField size="small" label="שם" value={form.label} onChange={set('label')} />
          <TextField size="small" label="הערה" value={form.note} onChange={set('note')} />
          <BusyButton type="submit" variant="contained" loading={busy}>הוסף כלל</BusyButton>
        </Box>
      )}
    </Block>
  );
}

function MissingTaxId() {
  const [state, reload] = useLoad('/expenses/suppliers-missing-tax-id', d => d.suppliers || []);
  return (
    <Block title="🏷️ ספקים בלי מספר עוסק" state={state} reload={reload}>
      {state.data && !state.data.length ? (
        <Typography variant="body2" color="text.secondary">לכל הספקים עם מסמכים יש מספר עוסק ✓</Typography>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            בלי מספר עוסק הספק מזוהה רק לפי השם. אפשר להשלים במסך הספקים.
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {(state.data || []).map(s => <Chip key={s._id} size="small" variant="outlined" label={s.name} />)}
          </Stack>
        </>
      )}
    </Block>
  );
}

function StartDate({ canWrite, onChanged }) {
  const [state, reload] = useLoad('/expenses/settings/start-date', d => d.start_date || '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state.data) setValue(state.data); }, [state.data]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/expenses/settings/start-date', { start_date: value });
      toast.success('תאריך ההתחלה נשמר');
      reload(); onChanged();
    } catch (err) { toast.error(apiError(err, 'השמירה נכשלה')); }
    finally { setBusy(false); }
  };
  return (
    <Block title="📅 תאריך התחלה" state={state} reload={reload}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        מסמכים וחיובים לפני התאריך הזה לא מוצגים ולא נמשכים
      </Typography>
      {canWrite ? (
        <Stack component="form" onSubmit={save} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <TextField size="small" type="date" label="מתאריך" value={value} onChange={e => setValue(e.target.value)}
            InputLabelProps={{ shrink: true }} required />
          <BusyButton type="submit" variant="outlined" loading={busy} disabled={!value || value === state.data}>שמור</BusyButton>
        </Stack>
      ) : (
        <Typography variant="body2">מתאריך: {formatDay(state.data)}</Typography>
      )}
    </Block>
  );
}

/** Credit notes: never owed and never paired — listed here so they are not lost. */
function Credits() {
  const [state, reload] = useLoad('/expenses/credits', d => d.documents || []);
  return (
    <Block title="↩️ זיכויים" state={state} reload={reload}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        חשבוניות זיכוי לא משויכות לחיובים ולא נספרות כחוב.
      </Typography>
      {state.data && !state.data.length ? (
        <Typography variant="body2" color="text.secondary">אין זיכויים.</Typography>
      ) : (
        <Stack spacing={0.75}>
          {(state.data || []).map(d => (
            <Stack key={d._id} direction="row" spacing={1} alignItems="center" justifyContent="space-between"
              sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography variant="body2" noWrap>{d.vendor_name || '—'}</Typography>
                  <IcountSourceChip doc={d} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {[DOC_TYPE_LABEL[d.doc_type], d.doc_number && `מס׳ ${d.doc_number}`, formatDay(d.doc_date)].filter(Boolean).join(' · ')}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{docAmountText(d)}</Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Block>
  );
}

// ── iCount ──────────────────────────────────────────────────────────────────
const when = (v) => (v ? new Date(v).toLocaleString('he-IL') : '—');
const yesNo = (b) => (b ? 'כן' : 'לא');
// A full pull walks every supplier in iCount; it may take minutes.
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

function PullResult({ r }) {
  const p = r.pull || {};
  const b = r.bridge;
  return (
    <Alert severity={p.partial ? 'warning' : 'success'} sx={{ mt: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 700 }}>{p.partial ? 'המשיכה הסתיימה חלקית' : 'המשיכה הסתיימה'}</Typography>
      <Typography variant="body2">
        {p.suppliers || 0} ספקים · {p.fetched || 0} מסמכים נקראו · {p.upserted || 0} נשמרו · {p.gone || 0} נעלמו מאייקאונט
      </Typography>
      {b && (
        <Typography variant="body2">
          קושרו למסמכים שלנו {b.linked} · נוצרו חדשים מאייקאונט {b.created} · שאלות "זה אותו מסמך?" {b.probable}
          {b.voided ? ` · בוטלו ${b.voided}` : ''}{b.kept_gone ? ` · נשארו עם סימון "נמחק" ${b.kept_gone}` : ''}{b.restored ? ` · חזרו ${b.restored}` : ''}
        </Typography>
      )}
      {(p.errors || []).length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, paddingInlineStart: '20px' }}>
          {p.errors.slice(0, 8).map((e, i) => <li key={i}><Typography variant="caption">{e}</Typography></li>)}
          {p.errors.length > 8 && <li><Typography variant="caption">ועוד {p.errors.length - 8}…</Typography></li>}
        </Box>
      )}
    </Alert>
  );
}

function IcountConnection({ canWrite, onPulled }) {
  const [state, reload] = useLoad('/expenses/icount/status', d => d);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const pull = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/expenses/icount/pull', {}, { timeout: PULL_TIMEOUT_MS });
      setResult(data);
      toast[data.pull?.partial ? 'warning' : 'success'](data.pull?.partial ? 'המשיכה מאייקאונט הסתיימה חלקית' : 'המשיכה מאייקאונט הסתיימה');
      onPulled();
    } catch (err) {
      if (err?.code === 'ECONNABORTED') toast.info('המשיכה עדיין רצה בשרת — רעננו את המסך בעוד כמה דקות');
      else toast.error(apiError(err, 'המשיכה מאייקאונט נכשלה'));
    } finally { setBusy(false); reload(); }
  };
  const s = state.data;
  const last = s && s.last_pull;
  return (
    <Block title="🔗 אייקאונט — מצב חיבור" state={state} reload={reload}>
      {s && (
        <Stack spacing={0.75}>
          {!s.configured && (
            <Alert severity="warning">אייקאונט לא מחובר — פרטי החיבור של הגן עוד לא הוכנסו בשרת. עד אז שום דבר לא נשלח ולא נמשך.</Alert>
          )}
          <Typography variant="body2">פרטי חיבור בשרת: {yesNo(s.configured)}</Typography>
          {s.configured && <Typography variant="body2">מחובר כרגע: {s.logged_in ? 'כן' : 'לא (יתחבר לבד בפעולה הבאה)'}</Typography>}
          <Typography variant="body2">
            משיכה אחרונה: {last ? `${when(last.started_at)} · ${last.complete ? 'מלאה' : `חלקית${last.failed_suppliers ? ` — ${last.failed_suppliers} ספקים לא נקראו` : ''}`}` : 'עוד לא נמשך דבר'}
          </Typography>
          {last && (
            <Typography variant="caption" color="text.secondary">
              {last.suppliers_read ?? 0}/{last.suppliers_total ?? 0} ספקים · {last.rows_seen ?? 0} מסמכים · {last.upserted ?? 0} נשמרו · {last.gone ?? 0} נעלמו
            </Typography>
          )}
          {last && !last.complete && <Typography variant="body2">משיכה מלאה אחרונה: {when(s.last_complete_pull_at)}</Typography>}
          <Typography variant="caption" color="text.secondary">המשיכה רצה לבד פעם ביום. רק מסמכים מתאריך ההתחלה ואילך.</Typography>
          {canWrite && s.configured && (
            <Box><BusyButton variant="outlined" loading={busy} loadingText="מושך מאייקאונט…" onClick={pull}>משוך מאייקאונט עכשיו</BusyButton></Box>
          )}
          {canWrite && !s.configured && <Typography variant="caption" color="text.secondary">אי אפשר למשוך עד שהחיבור יוגדר.</Typography>}
          {result && <PullResult r={result} />}
        </Stack>
      )}
    </Block>
  );
}

function IcountExpenseType({ canWrite }) {
  const [state, reload] = useLoad('/expenses/icount/settings', d => ({ id: d.expense_type_id ?? null }));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = state.data && state.data.id != null ? String(state.data.id) : '';
  useEffect(() => { if (state.data) setValue(saved); }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (e) => {
    e.preventDefault();
    const v = value.trim();
    if (v && !(Number.isInteger(Number(v)) && Number(v) > 0)) { toast.error('סוג ההוצאה הוא מספר שלם חיובי'); return; }
    setBusy(true);
    try {
      await api.put('/expenses/icount/settings', { expense_type_id: v ? Number(v) : null });
      toast.success(v ? 'סוג ההוצאה נשמר' : 'סוג ההוצאה נמחק — ההעלאה לאייקאונט חסומה עד שיוגדר');
      reload();
    } catch (err) { toast.error(apiError(err, 'השמירה נכשלה')); }
    finally { setBusy(false); }
  };
  return (
    <Block title="🔢 סוג הוצאה באייקאונט" state={state} reload={reload}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        המספר שאורלי בוחרת באייקאונט לסוג ההוצאה. כל מסמך שעולה מקבל אותו (אפשר לשנות למסמך אחד בתצוגה שלפני ההעלאה).
        בלי מספר — ההעלאה חסומה.
      </Typography>
      {canWrite ? (
        <Stack component="form" onSubmit={save} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <TextField size="small" label="מספר סוג ההוצאה" value={value} onChange={e => setValue(e.target.value)} inputProps={{ inputMode: 'numeric' }} />
          <BusyButton type="submit" variant="outlined" loading={busy} disabled={value.trim() === saved}>שמור</BusyButton>
        </Stack>
      ) : (
        <Typography variant="body2">סוג הוצאה: {saved || 'לא הוגדר'}</Typography>
      )}
      {state.data && !saved && <Typography variant="body2" sx={{ color: 'warning.dark', mt: 1 }}>לא הוגדר — אי אפשר להעלות לאייקאונט.</Typography>}
    </Block>
  );
}

function IcountMissingSuppliers() {
  const [state, reload] = useLoad('/expenses/icount/suppliers-missing', d => d.suppliers || []);
  return (
    <Block title="🏪 ספקים שלא נמצאו באייקאונט" state={state} reload={reload}>
      {state.data && !state.data.length ? (
        <Typography variant="body2" color="text.secondary">כל הספקים של המסמכים שעוד לא באייקאונט קיימים שם ✓</Typography>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            מסמכים של הספקים האלה לא יעלו עד שאורלי תפתח אותם באייקאונט. המערכת לא יוצרת ספקים באייקאונט.
          </Typography>
          <Stack spacing={0.5}>
            {(state.data || []).map(s => (
              <Typography key={s.supplier_id} variant="body2">
                {s.name || '—'}{s.tax_id ? ` · ח.פ ${s.tax_id}` : ' · בלי מספר עוסק'} · {s.documents} מסמכים
              </Typography>
            ))}
          </Stack>
        </>
      )}
    </Block>
  );
}

function IdentityQuestion({ q, canWrite, onDone }) {
  const [busy, setBusy] = useState(false);
  const row = q.icount_expense || {};
  const doc = q.document || {};
  const answer = async (same) => {
    setBusy(true);
    try {
      await api.post('/expenses/icount/identity', { document_id: doc._id, icount_expense_id: row._id, same });
      toast.success(same ? 'קושר — זה אותו מסמך' : 'נרשם: מסמכים שונים');
      onDone();
    } catch (err) { toast.error(apiError(err, 'השמירה נכשלה')); }
    finally { setBusy(false); }
  };
  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <Box>
          <Typography variant="caption" color="text.secondary">אצלנו</Typography>
          <Typography variant="body2">{doc.vendor_name || '—'}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {[DOC_TYPE_LABEL[doc.doc_type], doc.doc_number && `מס׳ ${doc.doc_number}`, formatDay(doc.doc_date), docAmountText(doc)].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">באייקאונט</Typography>
          <Typography variant="body2">{row.supplier_name || '—'}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {[row.doc_number && `מס׳ ${row.doc_number}`, formatDay(row.doc_date), formatILS(row.amount_total)].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
      </Box>
      {canWrite && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
          <Button size="small" variant="contained" disabled={busy} onClick={() => answer(true)}>כן, אותו מסמך</Button>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => answer(false)}>לא, מסמכים שונים</Button>
        </Stack>
      )}
    </Box>
  );
}

function IdentityQuestions({ canWrite, onChanged }) {
  const [state, reload] = useLoad('/expenses/icount/identity-questions', d => d.questions || []);
  const done = () => { reload(); onChanged(); };
  return (
    <Block title="❓ זה אותו מסמך?" state={state} reload={reload}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        מסמך באייקאונט שדומה למסמך שלנו (אותו ספק, סכום ותאריך קרובים) — אבל לא בטוח. "כן" מקשר ביניהם; "לא" — מסמך האייקאונט יקבל שורה משלו.
      </Typography>
      {state.data && !state.data.length ? (
        <Typography variant="body2" color="text.secondary">אין שאלות פתוחות.</Typography>
      ) : (
        <Stack spacing={1}>
          {(state.data || []).map(q => (
            <IdentityQuestion key={`${q.icount_expense?._id}:${q.document?._id}`} q={q} canWrite={canWrite} onDone={done} />
          ))}
        </Stack>
      )}
    </Block>
  );
}

/** The iCount blocks; after a pull the lists under it load again. */
function IcountTools({ canWrite, onChanged }) {
  const [tick, setTick] = useState(0);
  const pulled = () => { setTick(t => t + 1); onChanged(); };
  return (
    <>
      <IcountConnection canWrite={canWrite} onPulled={pulled} />
      <IcountExpenseType canWrite={canWrite} />
      <IdentityQuestions key={`q${tick}`} canWrite={canWrite} onChanged={onChanged} />
      <IcountMissingSuppliers key={`s${tick}`} />
    </>
  );
}

/** ⚙️ כלים — start date, the mail-sorter pull, iCount (connection, expense type, "same document?", missing suppliers), no-invoice rules, credit notes, suppliers missing a tax id. */
export default function ToolsTab({ canWrite, onChanged }) {
  return (
    <Stack spacing={2}>
      <StartDate canWrite={canWrite} onChanged={onChanged} />
      <Intake canWrite={canWrite} onChanged={onChanged} />
      <IcountTools canWrite={canWrite} onChanged={onChanged} />
      <Rules canWrite={canWrite} onChanged={onChanged} />
      <Credits />
      <MissingTaxId />
    </Stack>
  );
}
