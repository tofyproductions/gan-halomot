import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, Alert, TextField, Chip, IconButton, Tooltip,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api, { apiError } from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';
import { formatDay, docAmountText, DOC_TYPE_LABEL } from './expenseFormat';

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
                <Typography variant="body2" noWrap>{d.vendor_name || '—'}</Typography>
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

/** ⚙️ כלים — start date, the mail-sorter pull, no-invoice rules, credit notes, suppliers missing a tax id. */
export default function ToolsTab({ canWrite, onChanged }) {
  return (
    <Stack spacing={2}>
      <StartDate canWrite={canWrite} onChanged={onChanged} />
      <Intake canWrite={canWrite} onChanged={onChanged} />
      <Rules canWrite={canWrite} onChanged={onChanged} />
      <Credits />
      <MissingTaxId />
    </Stack>
  );
}
