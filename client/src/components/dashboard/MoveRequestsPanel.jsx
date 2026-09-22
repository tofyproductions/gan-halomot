import { useState, useEffect, useCallback } from 'react';
import {
  Paper, Typography, Stack, Chip, Button, Box, Alert, Tooltip,
} from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * מעברי כיתה ממתינים — what a תינוקייה board asked for, waiting on the manager.
 *
 * On the dashboard rather than behind a tab, because it is a decision with a
 * fee behind it and a family waiting on it, and a queue nobody opens is a
 * queue that fills. Empty, it draws nothing at all — the dashboard is busy
 * enough without a panel announcing there is nothing in it.
 *
 * Approving is the move. The child changes room here and nowhere earlier,
 * and if the board asked to keep carrying the child, that starts on approval.
 */
export default function MoveRequestsPanel({ onChanged }) {
  const [rows, setRows] = useState([]);
  const [mayDecide, setMayDecide] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.get('/children/move-requests', { params: { status: 'pending' } })
      .then(res => { setRows(res.data.requests || []); setMayDecide(!!res.data.may_decide); })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (row, verb) => {
    if (verb === 'approve') {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`לאשר את המעבר של ${row.child_name} ל${row.to}?\n\nהילד/ה יועבר/תועבר מיד. המעבר משפיע על התשלום.`)) return;
    }
    let reason = '';
    if (verb === 'reject') {
      // eslint-disable-next-line no-alert
      reason = window.prompt(`לדחות את המעבר של ${row.child_name}? אפשר לרשום סיבה:`, '');
      if (reason === null) return;
    }
    setBusy(row.id);
    try {
      await api.post(`/children/move-requests/${row.id}/${verb}`, { reason });
      toast.success(verb === 'approve' ? 'המעבר בוצע' : 'הבקשה נדחתה');
      load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפעולה נכשלה');
    } finally { setBusy(''); }
  };

  if (rows.length === 0) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, mb: 3, borderColor: 'warning.main', bgcolor: 'warning.soft' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <SwapHorizIcon color="warning" />
        <Typography sx={{ fontWeight: 800, flex: 1 }}>מעברי כיתה ממתינים לאישור</Typography>
        <Chip size="small" color="warning" label={rows.length} />
      </Stack>
      {!mayDecide && (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }} icon={false}>
          מנהלת הסניף מאשרת מעברים — המעבר משפיע על התשלום.
        </Alert>
      )}
      <Stack spacing={1}>
        {rows.map(row => (
          <Paper key={row.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2, opacity: busy === row.id ? 0.5 : 1 }}>
            <Stack direction="row" alignItems="center" spacing={1.2} flexWrap="wrap" useFlexGap>
              <Typography sx={{ fontWeight: 700 }}>{row.child_name}</Typography>
              <Chip size="small" variant="outlined" label={`${row.from} ← ${row.to}`} />
              {row.keep_on_board && (
                <Tooltip title="הגננות ביקשו שהילד/ה יישאר/תישאר בלוח התינוקייה 3 חודשים אחרי המעבר">
                  <Chip size="small" color="secondary" variant="outlined" label="נשאר/ת בלוח" />
                </Tooltip>
              )}
              <Typography variant="caption" color="text.secondary">
                ביקש/ה: {row.requested_by_name || '—'}
              </Typography>
              <Box sx={{ flex: 1 }} />
              {mayDecide && (
                <>
                  <Button
                    size="small" variant="contained" color="success" startIcon={<CheckCircleIcon />}
                    onClick={() => decide(row, 'approve')} disabled={!!busy}
                  >
                    אשר והעבר
                  </Button>
                  <Button
                    size="small" variant="outlined" color="error" startIcon={<CancelIcon />}
                    onClick={() => decide(row, 'reject')} disabled={!!busy}
                  >
                    דחה
                  </Button>
                </>
              )}
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Paper>
  );
}
