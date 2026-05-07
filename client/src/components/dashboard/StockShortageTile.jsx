import { useState, useEffect } from 'react';
import { Card, CardContent, Box, Typography, Stack, Chip, Button, Skeleton, Alert } from '@mui/material';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

export default function StockShortageTile() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { changeBranch } = useBranch();

  useEffect(() => {
    api.get('/stock/shortages-by-branch')
      .then(res => setData(res.data.branches || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  function gotoBranch(branch_id) {
    if (changeBranch) changeBranch(branch_id);
    else localStorage.setItem('selectedBranch', branch_id);
    navigate('/stock');
    setTimeout(() => window.location.reload(), 50);
  }

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Skeleton variant="text" width={120} />
          <Skeleton variant="rectangular" height={80} sx={{ mt: 1 }} />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) return null;

  const totals = data.reduce((acc, b) => ({
    red: acc.red + b.red,
    warn: acc.warn + b.warn,
  }), { red: 0, warn: 0 });

  if (totals.red === 0 && totals.warn === 0) {
    return (
      <Card sx={{ borderRight: '4px solid #10b981' }}>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Inventory2Icon sx={{ color: '#10b981' }} />
            <Typography variant="body2" sx={{ fontWeight: 700 }}>מלאי תקין</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">כל הסניפים מעל סף האזהרה</Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ borderRight: `4px solid ${totals.red > 0 ? '#dc2626' : '#f59e0b'}` }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Inventory2Icon sx={{ color: totals.red > 0 ? '#dc2626' : '#f59e0b' }} />
          <Typography variant="body2" sx={{ fontWeight: 800 }}>מצב מלאי</Typography>
          <Box sx={{ flex: 1 }} />
          {totals.red > 0 && <Chip size="small" label={`${totals.red} אדום`} sx={{ bgcolor: '#fee2e2', color: '#991b1b', fontWeight: 700 }} />}
          {totals.warn > 0 && <Chip size="small" label={`${totals.warn} כתום`} sx={{ bgcolor: '#fef3c7', color: '#92400e', fontWeight: 700 }} />}
        </Stack>
        <Stack spacing={0.5}>
          {data.map(b => (
            <Box
              key={b.branch_id}
              onClick={() => gotoBranch(b.branch_id)}
              sx={{
                p: 1, borderRadius: 1,
                cursor: 'pointer',
                bgcolor: b.red > 0 ? '#fef2f2' : b.warn > 0 ? '#fffbeb' : '#f0fdf4',
                '&:hover': { filter: 'brightness(0.96)' },
                display: 'flex', alignItems: 'center', gap: 1,
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700, flex: 1 }}>{b.branch_name}</Typography>
              {b.red > 0 && <Chip size="small" label={b.red} sx={{ bgcolor: '#dc2626', color: '#fff', fontWeight: 700, height: 20 }} />}
              {b.warn > 0 && <Chip size="small" label={b.warn} sx={{ bgcolor: '#f59e0b', color: '#fff', fontWeight: 700, height: 20 }} />}
              {b.red === 0 && b.warn === 0 && (
                <Typography variant="caption" sx={{ color: '#065f46', fontWeight: 700 }}>תקין</Typography>
              )}
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
