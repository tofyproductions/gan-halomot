import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Table, TableHead, TableRow, TableCell, TableBody, Alert, LinearProgress } from '@mui/material';
import api from '../../api/client';
import { fmtDate } from './shiftRows';

/** Yesterday's rota against punches: absent / late more than 30 minutes. */
export default function AttendanceReportDialog({ open, onClose, branchId, date }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || !branchId || !date) return;
    setData(null); setError(false);
    api.get('/shifts/report', { params: { branch: branchId, date } }).then(r => setData(r.data)).catch(() => setError(true));
  }, [open, branchId, date]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>נוכחות מול סידור — {date ? fmtDate(date) : ''}</DialogTitle>
      <DialogContent>
        {!data && !error && <LinearProgress />}
        {error && <Alert severity="error">לא הצלחנו לטעון את הדוח</Alert>}
        {data && data.rows.length === 0 && <Alert severity="success">כולן הגיעו בזמן.</Alert>}
        {data && data.rows.length > 0 && (
          <Table size="small">
            <TableHead><TableRow><TableCell>עובדת</TableCell><TableCell>משובצת מ-</TableCell><TableCell>החתמה ראשונה</TableCell><TableCell>מצב</TableCell></TableRow></TableHead>
            <TableBody>
              {data.rows.map(r => (
                <TableRow key={r.employee_id}>
                  <TableCell>{r.employee_name}</TableCell>
                  <TableCell dir="ltr">{r.scheduled_start}</TableCell>
                  <TableCell dir="ltr">{r.first_punch || '—'}</TableCell>
                  <TableCell>{r.kind === 'absent' ? 'לא הגיעה' : `איחור ${r.minutes} דקות`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגירה</Button></DialogActions>
    </Dialog>
  );
}
