import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, Chip, Tabs, Tab,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  TextField, Alert, CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ReplayIcon from '@mui/icons-material/Replay';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * Writes a viewer ("מנהל מערכת - לצפייה בלבד") asked for and may not make.
 * The office approves — which re-issues the request as the approver — or
 * rejects with a note. A replay that failed stays here with the server's
 * reason and a retry. `applying` is a replay in flight, already claimed by
 * an approver: it lives with the pending rows but shows only its chip —
 * no buttons, since nobody else should act on it while it runs.
 */
const STATUS = {
  pending: { label: 'ממתין', color: 'warning' },
  applying: { label: 'מתבצע', color: 'info' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
  failed: { label: 'נכשל', color: 'error' },
};
const APPROVER = { accountant: 'הנה"ח', system_admin: 'מנהל המערכת' };

function ProposalCard({ item, canDecide, onDecided }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const st = STATUS[item.status] || { label: item.status, color: 'default' };

  const act = async (path, body) => {
    setBusy(true);
    try {
      const res = await api.post(`/proposed-changes/${item._id}/${path}`, body);
      const p = res.data.proposal;
      if (p.status === 'approved') toast.success('השינוי בוצע');
      else if (p.status === 'rejected') toast.info('ההצעה נדחתה');
      else toast.error(`הביצוע נכשל: ${p.apply_error || 'שגיאה'}`);
      onDecided(p);
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפעולה נכשלה');
    } finally { setBusy(false); }
  };

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
          <Typography sx={{ fontWeight: 800 }}>{item.screen_label || 'מסך אחר'}</Typography>
          {item.branch_name && <Chip size="small" label={item.branch_name} />}
          <Chip size="small" color={st.color} label={st.label} />
          <Chip size="small" variant="outlined" label={`ל${APPROVER[item.approver] || 'משרד'}`} />
          <Typography variant="body2" color="text.secondary">
            {item.requested_by_name} · {new Date(item.created_at).toLocaleString('he-IL')}
          </Typography>
          <Typography variant="caption" color="text.disabled" dir="ltr">{item.method} {item.path}</Typography>
        </Stack>

        {item.summary?.length > 0 ? (
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 1 }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>שדה</TableCell><TableCell>ערך מבוקש</TableCell></TableRow></TableHead>
              <TableBody>
                {item.summary.map(r => (
                  <TableRow key={r.key}><TableCell>{r.label}</TableCell><TableCell>{r.value}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Alert severity="info" sx={{ mb: 1 }}>אין שדות להצגה (למשל מחיקה) — המסך והנתיב למעלה אומרים מה יקרה.</Alert>
        )}

        {item.status === 'failed' && (
          <Alert severity="error" sx={{ mb: 1 }}>הביצוע נכשל: {item.apply_error || 'שגיאה לא ידועה'}</Alert>
        )}
        {item.status !== 'pending' && item.status !== 'failed' && item.status !== 'applying' && (
          <Typography variant="body2" color="text.secondary">
            {st.label} ע"י {item.decided_by_name || '—'} · {item.decided_at ? new Date(item.decided_at).toLocaleString('he-IL') : ''}
            {item.decision_note ? ` · ${item.decision_note}` : ''}
          </Typography>
        )}

        {canDecide && item.status === 'pending' && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <TextField size="small" label="הערה (לא חובה)" value={note} onChange={e => setNote(e.target.value)} sx={{ minWidth: 240 }} />
            <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} disabled={busy}
              onClick={() => act('decide', { decision: 'approve', note })}>אשר ובצע</Button>
            <Button variant="outlined" color="error" startIcon={<CancelIcon />} disabled={busy}
              onClick={() => act('decide', { decision: 'reject', note })}>דחה</Button>
            {busy && <CircularProgress size={18} />}
          </Stack>
        )}
        {canDecide && item.status === 'failed' && (
          <Button variant="outlined" startIcon={<ReplayIcon />} disabled={busy} onClick={() => act('retry', {})}>נסה שוב</Button>
        )}
      </CardContent>
    </Card>
  );
}

// Mirrors the server's own "open" bucket (status=pending returns pending +
// applying) plus `failed`, so a replay that failed after approval keeps
// showing in "ממתינים" instead of silently vanishing on the next refetch.
const isOpen = (s) => s === 'pending' || s === 'applying' || s === 'failed';

export default function ProposedChanges() {
  const { isAdmin, isAccountant } = useAuth();
  const canDecide = isAdmin || isAccountant;
  const [tab, setTab] = useState('pending');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const reqId = ++reqRef.current;
    setLoading(true);
    api.get('/proposed-changes')
      .then(res => {
        if (reqRef.current !== reqId) return;
        setItems(res.data.items);
      })
      .catch(() => {
        if (reqRef.current !== reqId) return;
        setItems([]);
        toast.error('טעינת ההצעות נכשלה');
      })
      .finally(() => {
        if (reqRef.current !== reqId) return;
        setLoading(false);
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const onDecided = (p) => setItems(list => list.map(i => (i._id === p._id ? p : i)));

  const visible = items.filter(i => (tab === 'pending' ? isOpen(i.status) : !isOpen(i.status)));

  return (
    <Box dir="rtl">
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>שינויים לאישור</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {canDecide
          ? 'שינויים שביקש מנהל מערכת לצפייה בלבד. אישור מבצע את השינוי בשמך; דחייה — לא.'
          : 'השינויים שביקשת ומצב האישור שלהם.'}
      </Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="pending" label="ממתינים" />
        <Tab value="history" label="היסטוריה" />
      </Tabs>
      {loading ? <CircularProgress /> : visible.length === 0
        ? <Alert severity="success">{tab === 'pending' ? 'אין שינויים שממתינים לאישור' : 'אין היסטוריה עדיין'}</Alert>
        : visible.map(it => <ProposalCard key={it._id} item={it} canDecide={canDecide} onDecided={onDecided} />)}
    </Box>
  );
}
