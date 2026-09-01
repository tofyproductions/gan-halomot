import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Alert, Table, TableHead, TableBody, TableRow, TableCell,
} from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';

const ils = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;

/**
 * Per-day detail behind "השלמת אוגוסט" — which committed days inside the
 * branch's closure window were materialized, and (global employees only)
 * what she was paid for each. Pure readout of what the server already
 * computed (breakdown.components.closure_completion_bonus / _days) —
 * no fetch, no edit; the toggle itself lives on the table row.
 */
export default function ClosureCompletionDetailDialog({ open, row, month, onClose }) {
  if (!row) return null;
  const isGlobal = row.salary_type === 'global';
  const bonus = row.breakdown?.components?.closure_completion_bonus;
  const days = isGlobal ? (bonus?.days || []) : (row.breakdown?.components?.closure_completion_days || []);
  const totalAmount = isGlobal
    ? Number(bonus?.amount || 0)
    : days.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <EventAvailableIcon color="secondary" />
        השלמת אוגוסט — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'secondary.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">ימים שהושלמו</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>{days.length}</Typography>
            </Box>
            <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">{isGlobal ? 'בונוס אוגוסט' : 'שולם עבורם'}</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, color: 'success.dark' }}>{ils(totalAmount)}</Typography>
            </Box>
          </Stack>

          <Alert severity="info" sx={{ borderRadius: 2 }}>
            {isGlobal
              ? 'עובד/ת בשכר גלובלי: הימים האלה שולמו כבונוס נפרד ("בונוס אוגוסט") ולא נכנסו לחישוב השעות הרגיל — השלמת השכר הרגילה הופחתה באותו סכום כדי שלא ישולם פעמיים.'
              : 'עובד/ת שעתי/ת: הימים האלה כבר נכללים בשעות הרגילות/נוספות בטבלה — הפירוט כאן להצגה בלבד.'}
          </Alert>

          {days.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין ימי השלמת אוגוסט החודש.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>תאריך</TableCell>
                  <TableCell align="center">שעות</TableCell>
                  <TableCell align="center">סכום</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {days.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell>{d.date}</TableCell>
                    <TableCell align="center">{d.hours}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>{ils(d.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
