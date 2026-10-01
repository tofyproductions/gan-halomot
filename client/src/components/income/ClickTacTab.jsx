import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, TextField, MenuItem, Chip, Link, Collapse,
} from '@mui/material';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { BusyButton, FilePickButton } from '../shared/UploadControls';
import { formatILS, ymLabel, useLoad, LoadGate, Section, ResponsiveTable } from './incomeUi';

const isKaplan = (b) => /קפלן/.test(b?.name || '');

/** Upload a ClickTac debt_contract_export for one branch (never קפלן — it is not collected through ClickTac). */
function Upload({ branches, onDone }) {
  const options = branches.filter(b => !isKaplan(b));
  const [branchId, setBranchId] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const missing = !branchId ? 'בחרו סניף' : !file ? 'בחרו קובץ' : '';

  const upload = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/income/clicktac/import', { branch_id: branchId, file_data: file.data, file_name: file.name });
      toast.success(`נקלטו ${data.rows} ילדים ל${ymLabel(data.month)}${data.replaced ? ` · הוחלפה גרסה קודמת (${data.replaced} שורות)` : ''}${data.skipped ? ` · ${data.skipped} שורות של סניפים אחרים דולגו` : ''}`);
      setFile(null);
      onDone();
    } catch (err) { toast.error(apiError(err, 'הקליטה נכשלה')); }
    finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>📥 קליטת דוח גבייה מקליקטאק</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        הדוח מקליקטאק: debt_contract_export (שורה לכל ילד בחודש). חודש אחד בכל העלאה; העלאה חוזרת לאותו סניף וחודש מחליפה את הקודמת.
        הקליטה לא נוגעת ברישום החיצוני ובהתאמת תמ״ת.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
        <TextField select size="small" label="סניף" value={branchId} onChange={e => setBranchId(e.target.value)} sx={{ minWidth: 200 }}
          helperText="כפר סבא = משה דיין">
          {options.map(b => <MenuItem key={b._id} value={b._id}>{b.name}</MenuItem>)}
        </TextField>
        <FilePickButton accept=".xlsx,.xls" label="בחירת קובץ" hasFile={!!file} maxSizeMB={10} onPick={setFile} onError={(m) => toast.error(m)} disabled={busy} />
        <BusyButton variant="contained" loading={busy} loadingText="קולט…" disabled={!!missing} onClick={upload}>קליטה</BusyButton>
      </Stack>
      {file && <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>קובץ: {file.name}</Typography>}
      {missing && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>כדי לקלוט: {missing}</Typography>}
    </Paper>
  );
}

const unpaidCols = [
  {
    key: 'child_name', label: 'ילד/ה', title: true,
    render: r => (r.child_link
      ? <Link component={RouterLink} to={`/edit-registration/${r.child_link}`} underline="hover">{r.child_name || r.child_id_number}</Link>
      : (r.child_name || '—')),
  },
  { key: 'child_id_number', label: 'ת.ז.' },
  { key: 'status', label: 'סטטוס', render: r => r.status || '—' },
  { key: 'target', label: 'יעד', num: true },
  { key: 'paid', label: 'שולם', num: true },
  { key: 'gap', label: 'פער', num: true },
  { key: 'collection_status', label: 'סטטוס גבייה', render: r => r.collection_status || '—' },
  {
    key: 'payment_method', label: 'אמצעי תשלום',
    render: r => (r.payment_method ? r.payment_method : <Chip size="small" color="warning" variant="outlined" label="אין אמצעי תשלום" />),
  },
];

function MonthGroup({ g, branchName }) {
  const [open, setOpen] = useState(false);
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 2 }} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" sx={{ minWidth: 180 }}>{branchName} · {ymLabel(g.month)}</Typography>
        <Typography variant="body2">יעד {formatILS(g.target)}</Typography>
        <Typography variant="body2">שולם {formatILS(g.paid)}</Typography>
        <Typography variant="body2" sx={{ color: g.gap > 0 ? 'error.main' : 'success.dark', fontWeight: 700 }}>פער {formatILS(g.gap)}</Typography>
        <Typography variant="body2">{g.unpaid_count} לא שילמו</Typography>
        {g.no_method_count > 0 && <Chip size="small" color="warning" variant="outlined" label={`${g.no_method_count} בלי אמצעי תשלום`} />}
        {g.unpaid_count > 0 && (
          <Button size="small" onClick={() => setOpen(o => !o)} sx={{ ms: { sm: 'auto' } }}>
            {open ? 'הסתר' : 'מי לא שילם'}
          </Button>
        )}
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1.5 }}>
          <ResponsiveTable columns={unpaidCols} rows={g.unpaid} rowKey={r => r.child_id_number}
            cardTitle={r => unpaidCols[0].render(r)} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>שם הילד הוא קישור לרישום כשהילד נמצא במערכת לפי ת.ז.</Typography>
        </Box>
      </Collapse>
    </Paper>
  );
}

/** קליקטאק — monthly collection report per branch (spec §2). */
export default function ClickTacTab({ branches, canWrite }) {
  const [filter, setFilter] = useState('');
  const [state, reload] = useLoad('/income/clicktac/summary', filter ? { branch_id: filter } : {});
  const summary = state.data?.summary || [];
  const nameOf = (id) => branches.find(b => String(b._id) === String(id))?.name || 'סניף';
  const options = branches.filter(b => !isKaplan(b));

  return (
    <Box>
      {canWrite && <Upload branches={branches} onDone={reload} />}
      <Section title="📋 גבייה לפי סניף וחודש" hint="יעד, שולם ופער מתוך קובץ קליקטאק האחרון שנקלט לכל סניף וחודש. ״לא שילמו״ = שולם פחות מהיעד.">
        <TextField select size="small" label="סניף" value={filter} onChange={e => setFilter(e.target.value)} sx={{ minWidth: 200, mb: 1.5 }}>
          <MenuItem value="">כל הסניפים</MenuItem>
          {options.map(b => <MenuItem key={b._id} value={b._id}>{b.name}</MenuItem>)}
        </TextField>
        <LoadGate state={state} reload={reload}>
          {!summary.length ? (
            <EmptyState state={filter ? 'filtered' : 'empty'} title={filter ? 'לסניף הזה עוד לא נקלט דוח' : 'עוד לא נקלט דוח קליקטאק'}
              hint={canWrite ? 'קלטו את קובץ debt_contract_export למעלה.' : undefined} />
          ) : (
            <Stack spacing={1}>
              {summary.map(g => <MonthGroup key={`${g.branch_id}|${g.month}`} g={g} branchName={nameOf(g.branch_id)} />)}
            </Stack>
          )}
        </LoadGate>
      </Section>
    </Box>
  );
}
