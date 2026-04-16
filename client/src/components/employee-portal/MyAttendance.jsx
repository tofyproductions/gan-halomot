import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';

export default function MyAttendance() {
  const { user } = useAuth();
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [month] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  useEffect(() => {
    api.get(`/payroll/my-punches?month=${month}`)
      .then(res => setPunches(res.data.punches || []))
      .catch(() => setPunches([]))
      .finally(() => setLoading(false));
  }, [month]);

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <AccessTimeIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב ההחתמות שלי</Typography>
      </Stack>

      <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
        חודש נוכחי: {month}
      </Typography>

      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : punches.length > 0 ? (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell sx={{ fontWeight: 700 }}>תאריך</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>כניסה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>יציאה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>שעות</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {punches.map((p, i) => (
                <TableRow key={i} hover>
                  <TableCell>{p.date}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{p.in_time || '-'}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{p.out_time || '-'}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{p.hours || '-'}</TableCell>
                  <TableCell>
                    {p.branch && <Chip label={p.branch} size="small" variant="outlined" />}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={p.out_time ? 'שלם' : 'חסר יציאה'}
                      size="small"
                      color={p.out_time ? 'success' : 'warning'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">
          אין החתמות לחודש הנוכחי. אם אתה חושב שזו טעות, פנה למנהלת.
        </Typography>
      )}
    </Box>
  );
}
