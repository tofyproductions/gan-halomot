import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, IconButton, Tooltip,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useAuth } from '../../hooks/useAuth';
import api, { openApiFile } from '../../api/client';

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
                <TableCell sx={{ fontWeight: 700 }}>מסמכים</TableCell>
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
                    {/* Both routes sit behind the bearer token, so a plain href
                        would 401 — fetch them with the token instead. */}
                    <Stack direction="row" spacing={0.5}>
                      {p.file_url && (
                        <Tooltip title="הורד תלוש">
                          <IconButton size="small" onClick={() => openApiFile(p.file_url, { filename: `תלוש_${p.year_month}.pdf` })}>
                            <DownloadIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                      {p.hours_report_url && (
                        <Tooltip title="הורד דוח שעות">
                          <IconButton size="small" color="secondary"
                            onClick={() => openApiFile(p.hours_report_url, { filename: `דוח_שעות_${p.year_month}.pdf` })}>
                            <ScheduleIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
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
