import { useState } from 'react';
import { toast } from 'react-toastify';
import { Box, Stack, Typography, Paper, TextField, Chip, IconButton } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api, { apiError } from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';
import { useLoad, LoadGate } from './incomeUi';

/** ⚙️ — "not parent income" rules: an incoming bank line whose text contains the pattern is never proposed as a parent's payment. */
export default function IncomeToolsTab({ canWrite }) {
  const confirm = useConfirm();
  const [state, reload] = useLoad('/income/rules');
  const [form, setForm] = useState({ label: '', pattern: '', note: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const rules = state.data?.rules || [];

  const add = async (e) => {
    e.preventDefault();
    if (form.pattern.trim().length < 2) { toast.error('התבנית קצרה מדי'); return; }
    setBusy(true);
    try {
      await api.post('/income/rules', form);
      toast.success('הכלל נוסף');
      setForm({ label: '', pattern: '', note: '' });
      reload();
    } catch (err) { toast.error(apiError(err, 'הוספת הכלל נכשלה')); }
    finally { setBusy(false); }
  };
  const remove = async (rule) => {
    if (!(await confirm({ title: 'מחיקת כלל', message: `למחוק את "${rule.label}"? תנועות שהוא תפס יחזרו להצעות השיוך בקפלן.`, confirm_label: 'מחק', danger: true }))) return;
    try { await api.delete(`/income/rules/${rule._id}`); toast.success('הכלל נמחק'); reload(); }
    catch (err) { toast.error(apiError(err, 'המחיקה נכשלה')); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>📏 לא הכנסת הורים</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        תנועה נכנסת שהתיאור או שם המוטב שלה מכילים את התבנית לא תוצע כתשלום של הורה בקפלן (ריבית, החזרים, ההעברה מאמונה).
        כללים מובנים אי אפשר למחוק.
      </Typography>
      <LoadGate state={state} reload={reload}>
        <Stack spacing={0.75}>
          {rules.map(r => (
            <Stack key={r._id} direction="row" spacing={1} alignItems="center" justifyContent="space-between"
              sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, opacity: r.is_active === false ? 0.6 : 1 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{r.label} <Typography component="span" variant="caption" color="text.secondary">· "{r.pattern}"</Typography></Typography>
                {r.note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.note}</Typography>}
                {r.is_active === false && <Typography variant="caption" sx={{ color: 'warning.dark' }}>כבוי</Typography>}
              </Box>
              {r.built_in ? <Chip size="small" label="מובנה" /> : canWrite && (
                <IconButton size="small" aria-label={`מחיקת הכלל ${r.label}`} onClick={() => remove(r)}><DeleteOutlineIcon fontSize="small" /></IconButton>
              )}
            </Stack>
          ))}
          {state.data && !rules.length && <Typography variant="body2" color="text.secondary">אין כללים.</Typography>}
        </Stack>
      </LoadGate>
      {canWrite && (
        <Box component="form" onSubmit={add} sx={{ mt: 1.5, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr auto' } }}>
          <TextField size="small" label="תבנית (מתוך תיאור התנועה)" value={form.pattern} onChange={set('pattern')} required />
          <TextField size="small" label="שם" value={form.label} onChange={set('label')} />
          <TextField size="small" label="הערה" value={form.note} onChange={set('note')} />
          <BusyButton type="submit" variant="contained" loading={busy}>הוסף כלל</BusyButton>
        </Box>
      )}
    </Paper>
  );
}
