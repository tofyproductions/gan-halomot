import { useState, useRef } from 'react';
import {
  Box, Stack, Typography, Paper, Button, Alert, TextField, Chip, List, ListItemButton, ListItem,
} from '@mui/material';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { BusyButton } from '../shared/UploadControls';
import { formatILS, formatDay, LANE_LABEL, LANE_TAB, GENERAL, NO_BRANCH } from './expenseFormat';

const KIND_ICON = { invoice: '🧾', receipt: '🧾', credit: '↩️', bank: '🏦', card: '💳' };
const LIMIT = 200;

function amountText(row) {
  if (row.currency && row.currency !== 'ILS') {
    return `${Number(row.amount || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 })} ${row.currency}`;
  }
  return formatILS(row.amount);
}

function ResultRow({ row, onJump }) {
  const tab = row.lane ? LANE_TAB[row.lane] : null;
  const content = (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
      <Typography aria-hidden>{KIND_ICON[row.kind] || '•'}</Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>{row.title || '—'}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>{row.subtitle}</Typography>
      </Box>
      <Stack alignItems="flex-end" sx={{ flexShrink: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{amountText(row)}</Typography>
        <Typography variant="caption" color="text.secondary">{formatDay(row.date)}</Typography>
      </Stack>
      {row.source === 'icount' && <Chip size="small" color="info" variant="outlined" label="מאייקאונט" sx={{ flexShrink: 0 }} />}
      <Chip size="small" variant="outlined" label={row.lane ? (LANE_LABEL[row.lane] || row.lane) : 'מחוץ למסך'} sx={{ flexShrink: 0 }} />
    </Stack>
  );
  return tab
    ? <ListItemButton divider onClick={() => onJump(tab)}>{content}</ListItemButton>
    : <ListItem divider>{content}</ListItem>;
}

/** 🔎 חיפוש — documents and charges by text, number, tax id and amount range. */
export default function SearchTab({ branch, onJump }) {
  const [form, setForm] = useState({ q: '', min: '', max: '' });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const realBranch = branch && branch !== GENERAL && branch !== NO_BRANCH;

  const run = async (e) => {
    e?.preventDefault();
    const my = ++seq.current;
    setLoading(true); setError('');
    try {
      const params = {};
      if (form.q.trim()) params.q = form.q.trim();
      if (form.min !== '') params.min = form.min;
      if (form.max !== '') params.max = form.max;
      // "כללי" / "בלי סניף" are not branch ids — the search filters by a real branch only.
      if (realBranch) params.branch = branch;
      const { data } = await api.get('/expenses/search', { params });
      if (my === seq.current) setResult({ documents: data.documents || [], charges: data.charges || [] });
    } catch (err) {
      if (my === seq.current) setError(apiError(err, 'החיפוש נכשל'));
    } finally { if (my === seq.current) setLoading(false); }
  };

  const count = (list) => (list.length >= LIMIT ? `${LIMIT}+` : list.length);

  return (
    <Box>
      <Paper component="form" variant="outlined" onSubmit={run} sx={{ p: 1.5, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField size="small" label="טקסט חופשי" placeholder="ספק, תיאור, מס׳ מסמך, ח.פ, אסמכתא…" value={form.q} onChange={set('q')} sx={{ flex: 1 }} />
          <TextField size="small" label="סכום מ-" value={form.min} onChange={set('min')} inputProps={{ inputMode: 'decimal' }} sx={{ width: { md: 120 } }} />
          <TextField size="small" label="סכום עד" value={form.max} onChange={set('max')} inputProps={{ inputMode: 'decimal' }} sx={{ width: { md: 120 } }} />
          <BusyButton type="submit" variant="contained" loading={loading} loadingText="מחפש…">🔎 חפש</BusyButton>
        </Stack>
        {branch && !realBranch && <Typography variant="caption" color="text.secondary">בחיפוש אפשר לסנן רק לפי סניף מסוים — מוצגים כל הסניפים.</Typography>}
        {realBranch && <Typography variant="caption" color="text.secondary">מסונן לפי סניף — חיובי בנק אינם שייכים לסניף ולא יוצגו.</Typography>}
      </Paper>

      {error ? (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={run}>נסו שוב</Button>}>{error}</Alert>
      ) : !result ? (
        <Typography color="text.secondary">הקלידו מה לחפש ולחצו "חפש".</Typography>
      ) : !result.documents.length && !result.charges.length ? (
        <EmptyState state="filtered" title="לא נמצא דבר" hint="נסו מילה אחרת או טווח סכום רחב יותר." />
      ) : (
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>מסמכים ({count(result.documents)})</Typography>
            {result.documents.length ? (
              <Paper variant="outlined"><List dense disablePadding>{result.documents.map(r => <ResultRow key={r.key} row={r} onJump={onJump} />)}</List></Paper>
            ) : <Typography variant="body2" color="text.secondary">אין.</Typography>}
          </Box>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>חיובים ({count(result.charges)})</Typography>
            {result.charges.length ? (
              <Paper variant="outlined"><List dense disablePadding>{result.charges.map(r => <ResultRow key={r.transaction_id} row={r} onJump={onJump} />)}</List></Paper>
            ) : <Typography variant="body2" color="text.secondary">אין.</Typography>}
          </Box>
        </Stack>
      )}
    </Box>
  );
}
