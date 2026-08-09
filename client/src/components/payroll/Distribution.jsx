import { useEffect, useState, useMemo } from 'react';
import {
  Box, Paper, Stack, Typography, Button, Chip, CircularProgress, Divider,
  Table, TableHead, TableBody, TableRow, TableCell, TextField, Alert,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import SupervisorAccountIcon from '@mui/icons-material/SupervisorAccount';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SettingsIcon from '@mui/icons-material/Settings';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useWorkMonth } from '../../hooks/useWorkMonth';
import {
  ManagerDistributionDialog, PayslipDistributionDialog, BranchManagerEmailsDialog,
} from './PayslipAudit';
import HoursDistributionDialog from '../attendance/HoursDistributionDialog';

/**
 * Distribution hub — sends payslips (from an approved audit) and monthly hours
 * reports to branch managers, the office, and employees. Split out of the
 * payslip-audit tool into its own tab.
 */
export default function Distribution() {
  const { month, setMonth } = useWorkMonth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mgrDialog, setMgrDialog] = useState({ open: false, audit: null });
  const [empDialog, setEmpDialog] = useState({ open: false, audit: null });
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/payroll/payslip-audit/history')
      .then(res => setHistory(res.data?.items || []))
      .catch(() => toast.error('שגיאה בטעינת ההיסטוריה'))
      .finally(() => setLoading(false));
  }, []);

  // Only approved ("סבב סופי") audits are ready for distribution.
  const approved = useMemo(
    () => history.filter(h => h.approved).sort((a, b) => (b.year_month || '').localeCompare(a.year_month || '')),
    [history],
  );

  return (
    <Box dir="rtl">
      {/* ── Payslips ── */}
      <Paper variant="outlined" sx={{ borderRadius: 3, mb: 2, p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 800, flex: 1 }}>הפצת תלושי שכר</Typography>
          <Button size="small" startIcon={<SettingsIcon />} onClick={() => setEmailsOpen(true)}>מיילי מנהלי סניפים</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          בחר/י סבב מאושר ("סבב סופי") מביקורת התלושים, ושלח/י את התלושים למנהלי הסניפים / למשרד או ישירות לעובדים.
        </Typography>
        {loading ? (
          <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={26} /></Box>
        ) : approved.length === 0 ? (
          <Alert severity="info" sx={{ mt: 1.5 }}>אין סבבים מאושרים. אשר/י סבב בלשונית "ביקורת תלושים" כדי להפיץ ממנו תלושים.</Alert>
        ) : (
          <Table size="small" sx={{ mt: 1.5 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>חודש</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סניפים</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">תלושים</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">שליחה</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {approved.map(h => (
                <TableRow key={h._id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{h.year_month || '—'}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {(h.branches || []).map(b => <Chip key={b} size="small" variant="outlined" label={b} sx={{ height: 18, fontSize: 10 }} />)}
                    </Stack>
                  </TableCell>
                  <TableCell align="center">{h.summary?.payslips_in_pdf ?? '—'}</TableCell>
                  <TableCell align="center">
                    <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                      <Button size="small" variant="contained" color="secondary" startIcon={<SupervisorAccountIcon />}
                        onClick={() => setMgrDialog({ open: true, audit: h })} sx={{ fontSize: 11 }}>למנהלים / משרד</Button>
                      <Button size="small" variant="contained" color="primary" startIcon={<PeopleIcon />}
                        onClick={() => setEmpDialog({ open: true, audit: h })} sx={{ fontSize: 11 }}>לעובדים</Button>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontSize: 10.5 }}>
                      השליחה לעובדים גם מתייקת את התלוש ב״התלושים שלי״ של כל עובד/ת
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {/* ── Hours reports ── */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>הפצת דוחות שעות</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          דוח שעות חודשי לכל עובד — למנהלי הסניפים, למשרד (כל הסניפים), או ישירות לעובדים. אינו תלוי בביקורת תלושים.
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <TextField label="חודש" type="month" size="small" value={month}
            onChange={e => setMonth(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 180 }} />
          <Button variant="contained" color="success" startIcon={<ScheduleIcon />} onClick={() => setHoursOpen(true)}>
            שליחת דוחות שעות
          </Button>
        </Stack>
      </Paper>

      <ManagerDistributionDialog open={mgrDialog.open} audit={mgrDialog.audit} onClose={() => setMgrDialog({ open: false, audit: null })} />
      <PayslipDistributionDialog open={empDialog.open} audit={empDialog.audit} onClose={() => setEmpDialog({ open: false, audit: null })} />
      <BranchManagerEmailsDialog open={emailsOpen} onClose={() => setEmailsOpen(false)} />
      <HoursDistributionDialog open={hoursOpen} onClose={() => setHoursOpen(false)} month={month} />
    </Box>
  );
}
