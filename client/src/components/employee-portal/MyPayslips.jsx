import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, IconButton, Tooltip,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';

export default function MyPayslips() {
  const { user } = useAuth();
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/payroll/my-payslips')
      .then(res => setPayslips(res.data.payslips || []))
      .catch(() => setPayslips([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <DescriptionIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>התלושים שלי</Typography>
      </Stack>

      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : payslips.length > 0 ? (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell sx={{ fontWeight: 700 }}>חודש</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>שנה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סכום נטו</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {payslips.map((p, i) => (
                <TableRow key={i} hover>
                  <TableCell>{p.month_name}</TableCell>
                  <TableCell>{p.year}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{p.net_amount} ₪</TableCell>
                  <TableCell>
                    <Chip
                      label={p.status === 'paid' ? 'שולם' : 'ממתין'}
                      size="small"
                      color={p.status === 'paid' ? 'success' : 'warning'}
                    />
                  </TableCell>
                  <TableCell>
                    {p.file_url && (
                      <Tooltip title="הורד תלוש">
                        <IconButton size="small" href={p.file_url} target="_blank">
                          <DownloadIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">
          אין תלושים זמינים עדיין. תלושים יופיעו כאן לאחר אישור משכורת חודשית.
        </Typography>
      )}
    </Box>
  );
}
