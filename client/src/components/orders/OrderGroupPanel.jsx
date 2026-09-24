import { useEffect, useState } from 'react';
import { Box, Typography, Stack, Chip, Alert, LinearProgress } from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';
import api from '../../api/client';
import { formatCurrencyExact } from '../../utils/hebrewYear';

/**
 * Who is ordering together, as numbers. Each branch sees the others' totals
 * and item counts — never their items — and the joint total against the
 * supplier's minimum, which is the reason the branches are ordering together.
 */
export default function OrderGroupPanel({ orderId, refreshKey = 0, onLoaded }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!orderId) return undefined;
    let alive = true;
    api.get(`/orders/${orderId}/group`)
      .then(res => { if (alive) { setData(res.data); onLoaded?.(res.data); } })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
    // onLoaded is deliberately left out: it's an unmemoised callback prop, and
    // including it would refetch on every parent render.
  }, [orderId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !data.group_id) return null;

  const min = data.supplier?.min_order_amount || 0;
  const total = data.total_with_items || 0;
  const short = min > 0 && total < min;
  const pct = min > 0 ? Math.min(100, Math.round((total / min) * 100)) : 100;
  const activeCount = data.members.filter(m => m.status !== 'cancelled').length;
  // The row this page is about. `is_mine` marks every row for the office, so it
  // is only the fallback for a server that does not send `is_this` yet.
  const isThis = (m) => (m.is_this !== undefined ? m.is_this : m.is_mine);

  return (
    <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'background.sunken' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <GroupsIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
          הזמנה משותפת · {activeCount} סניפים
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {data.members.map(m => (
          <Stack key={m.id} direction="row" justifyContent="space-between" alignItems="center">
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Typography variant="body2" sx={{ fontWeight: isThis(m) ? 800 : 500 }}>{m.branch_name}</Typography>
              {isThis(m) && <Chip label="שלי" size="small" color="primary" variant="outlined" />}
              {m.status === 'cancelled' && <Chip label="בוטל" size="small" color="error" variant="outlined" />}
              {m.status === 'draft' && m.items_count === 0 && <Chip label="עדיין לא הוסיף" size="small" variant="outlined" />}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {m.items_count} פריטים · {formatCurrencyExact(m.total_amount)}
            </Typography>
          </Stack>
        ))}
      </Stack>
      {min > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" sx={{ fontWeight: 700 }}>סה"כ משותף {formatCurrencyExact(total)}</Typography>
            <Typography variant="body2" color="text.secondary">מינימום {formatCurrencyExact(min)}</Typography>
          </Stack>
          <LinearProgress variant="determinate" value={pct} color={short ? 'warning' : 'success'} sx={{ mt: 0.5, borderRadius: 1 }} />
          {short && (
            <Alert severity="warning" sx={{ mt: 1, borderRadius: 2 }}>
              חסרים {formatCurrencyExact(min - total)} למינימום ההזמנה
            </Alert>
          )}
        </Box>
      )}
    </Box>
  );
}
