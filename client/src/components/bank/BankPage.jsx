import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
  Chip, IconButton, TextField, MenuItem, Alert, Button, Tooltip, useMediaQuery, Card, CardContent,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import SyncIcon from '@mui/icons-material/Sync';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import api, { apiError } from '../../api/client';
import PageHeader from '../ui/PageHeader';
import EmptyState from '../ui/EmptyState';
import { useAuth } from '../../hooks/useAuth';
import { hasTabAccess } from '../../config/tabs';
import MaxImportDialog from './MaxImportDialog';
import { formatILS, formatDay, thisMonth, shiftMonth, monthLabel } from './bankFormat';

const EMPTY = { transactions: [], totals: { in: 0, out: 0, net: 0 } };

/**
 * תנועות בנק — the gan's bank account (bank-pi agent) and the two Max cards
 * (xlsx upload). Writes (flags, upload, sync) are for system_admin/accountant;
 * admin_viewer reads everything.
 */
export default function BankPage() {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('sm'));
  const { user } = useAuth();
  const canWrite = user?.role === 'system_admin' || user?.role === 'accountant' || hasTabAccess(user, 'bank_write');

  const [month, setMonth] = useState(thisMonth());
  const [accountId, setAccountId] = useState('');
  const [direction, setDirection] = useState('');
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const metaSeq = useRef(0);
  const loadSeq = useRef(0);

  // Accounts/status are context, not the list: if they fail the table stays.
  const loadMeta = useCallback(async () => {
    const seq = ++metaSeq.current;
    try {
      const [a, s] = await Promise.all([api.get('/finance/accounts'), api.get('/finance/status')]);
      if (seq !== metaSeq.current) return;
      setAccounts(a.data.accounts || []);
      setStatus(s.data);
    } catch (err) {
      if (seq === metaSeq.current) toast.error(apiError(err, 'לא הצלחנו לטעון את פרטי החשבונות'));
    }
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true); setLoadError('');
    loadMeta();
    try {
      const params = { month };
      if (accountId) params.account_id = accountId;
      if (direction) params.direction = direction;
      if (q.trim()) params.q = q.trim();
      const { data: tx } = await api.get('/finance/transactions', { params });
      if (seq !== loadSeq.current) return;
      setData({ transactions: tx.transactions || [], totals: tx.totals || EMPTY.totals });
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(apiError(err, 'לא הצלחנו לטעון את התנועות'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [month, accountId, direction, q, loadMeta]);

  // Typing in the search box waits 300ms; every other filter loads at once.
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const toggle = async (t, field) => {
    try {
      await api.patch(`/finance/transactions/${t._id}`, { [field]: !t[field] });
      load(); // totals change when a transfer is flagged, so reload rather than patch one row
    } catch (err) {
      toast.error(apiError(err, 'השמירה נכשלה'));
    }
  };

  const syncNow = async () => {
    setSyncBusy(true);
    try { await api.post('/finance/sync/request'); toast.success('הבקשה נשלחה למחשב הבנק'); await loadMeta(); }
    catch (err) { toast.error(apiError(err, 'הבקשה נכשלה')); }
    finally { setSyncBusy(false); }
  };

  const accountLabel = (id) => accounts.find(a => String(a._id) === String(id))?.label || '';

  const flags = (t) => (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      <Chip size="small" label="העברה פנימית" variant={t.is_internal_transfer ? 'filled' : 'outlined'}
        color={t.is_internal_transfer ? 'info' : 'default'} disabled={!canWrite} onClick={() => toggle(t, 'is_internal_transfer')} />
      <Chip size="small" label="חד פעמי" variant={t.is_one_time ? 'filled' : 'outlined'}
        color={t.is_one_time ? 'warning' : 'default'} disabled={!canWrite} onClick={() => toggle(t, 'is_one_time')} />
      {t.status === 'pending' && <Chip size="small" label="ממתין" />}
    </Stack>
  );

  const amountColor = (t) => (t.amount < 0 ? 'error.main' : 'success.main');
  const hasBank = accounts.some(a => a.type === 'bank');

  return (
    <Box dir="rtl" sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto' }}>
      <PageHeader
        title="תנועות בנק"
        meta={['חשבון הבנק של הגן וכרטיסי האשראי']}
        primary={canWrite ? { label: 'ייבוא חיובי Max', icon: <UploadFileIcon />, onClick: () => setImportOpen(true) } : null}
      />

      {status?.stale && hasBank && (
        <Alert severity="error" sx={{ mb: 2 }}>
          תנועות הבנק לא התעדכנו מאז {status.last_agent_ingest_at ? new Date(status.last_agent_ingest_at).toLocaleString('he-IL') : 'מעולם'}.
          ייתכן שמחשב הבנק צריך פתיחת כספת.
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        {accounts.map(a => (
          <Paper key={a._id} variant="outlined" sx={{ p: 1.5, minWidth: 180, cursor: 'pointer',
            borderColor: String(accountId) === String(a._id) ? 'primary.main' : 'divider' }}
            onClick={() => setAccountId(String(accountId) === String(a._id) ? '' : String(a._id))}>
            <Typography variant="caption" color="text.secondary">{a.type === 'card' ? 'כרטיס' : 'בנק'}</Typography>
            <Typography variant="subtitle2">{a.label}</Typography>
            {a.balance != null && <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatILS(a.balance)}</Typography>}
            <Typography variant="caption" color="text.secondary">תנועה אחרונה: {formatDay(a.last_tx_date)}</Typography>
          </Paper>
        ))}
        {canWrite && (
          <Stack justifyContent="center">
            <Tooltip title={status?.last_request ? `בקשה אחרונה: ${status.last_request.status}${status.last_request.result ? ` · ${status.last_request.result}` : ''}` : ''}>
              <span>
                <Button startIcon={<SyncIcon />} onClick={syncNow} disabled={syncBusy}>סנכרן עכשיו</Button>
              </span>
            </Tooltip>
          </Stack>
        )}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center">
          <IconButton aria-label="החודש הקודם" onClick={() => setMonth(m => shiftMonth(m, -1))}><ChevronRightIcon /></IconButton>
          <Typography sx={{ minWidth: 120, textAlign: 'center', fontWeight: 700 }}>{monthLabel(month)}</Typography>
          <IconButton aria-label="החודש הבא" disabled={month >= thisMonth()} onClick={() => setMonth(m => shiftMonth(m, 1))}><ChevronLeftIcon /></IconButton>
        </Stack>
        <TextField select size="small" label="כיוון" value={direction} onChange={e => setDirection(e.target.value)} sx={{ minWidth: 120 }}>
          <MenuItem value="">הכל</MenuItem>
          <MenuItem value="in">נכנס</MenuItem>
          <MenuItem value="out">יוצא</MenuItem>
        </TextField>
        <TextField size="small" label="חיפוש (תיאור / מוטב)" value={q} onChange={e => setQ(e.target.value)} sx={{ flex: 1 }} />
      </Stack>

      <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap sx={{ mb: 2, fontVariantNumeric: 'tabular-nums' }}>
        <Typography>נכנס: <b>{formatILS(data.totals.in)}</b></Typography>
        <Typography>יוצא: <b>{formatILS(data.totals.out)}</b></Typography>
        <Typography>נטו: <b>{formatILS(data.totals.net)}</b></Typography>
      </Stack>

      {loadError ? (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>נסו שוב</Button>}>{loadError}</Alert>
      ) : loading && !data.transactions.length ? (
        <Typography color="text.secondary">טוען…</Typography>
      ) : !data.transactions.length ? (
        <EmptyState
          state={accounts.length && (accountId || direction || q) ? 'filtered' : 'empty'}
          title={accounts.length ? `אין תנועות ב${monthLabel(month)}` : 'עוד אין חשבונות'}
          hint={accounts.length ? 'נסו חודש אחר או נקו את הסינון.' : "ייבאו קובץ חיובים מ-Max, או לחצו 'סנכרן עכשיו' אחרי חיבור מחשב הבנק."}
        />
      ) : phone ? (
        <Stack spacing={1}>
          {data.transactions.map(t => (
            <Card key={t._id} variant="outlined" sx={{ opacity: t.is_internal_transfer ? 0.6 : 1 }}>
              <CardContent sx={{ py: 1.5 }}>
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <Typography variant="subtitle2">{t.description}</Typography>
                  <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: amountColor(t), whiteSpace: 'nowrap' }}>{formatILS(t.amount)}</Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {formatDay(t.date)} · {accountLabel(t.account_id)}{t.counterparty ? ` · אל: ${t.counterparty}` : ''}
                </Typography>
                <Box sx={{ mt: 1 }}>{flags(t)}</Box>
              </CardContent>
            </Card>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>תאריך</TableCell>
                <TableCell>תיאור</TableCell>
                <TableCell>מוטב</TableCell>
                <TableCell>חשבון</TableCell>
                <TableCell align="left">סכום</TableCell>
                <TableCell>סימונים</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.transactions.map(t => (
                <TableRow key={t._id} hover sx={{ opacity: t.is_internal_transfer ? 0.6 : 1 }}>
                  <TableCell>{formatDay(t.date)}</TableCell>
                  <TableCell>{t.description}</TableCell>
                  <TableCell>{t.counterparty || '—'}</TableCell>
                  <TableCell>{accountLabel(t.account_id)}</TableCell>
                  <TableCell align="left" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: amountColor(t) }}>
                    {formatILS(t.amount)}
                  </TableCell>
                  <TableCell>{flags(t)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <MaxImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
    </Box>
  );
}
