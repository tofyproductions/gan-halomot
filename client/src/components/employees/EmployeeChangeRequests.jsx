import { useEffect, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Table, TableHead, TableBody, TableRow, TableCell,
  Alert, CircularProgress, Divider, Paper,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

const fmtDate = (d) => { try { return new Date(d).toLocaleString('he-IL'); } catch { return ''; } };

// Render a stored value readably (objects/arrays are shown compactly).
function show(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  if (Array.isArray(v) || typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Review queue for employee-card edits filed by branch managers. Accountant /
 * system_admin approve (writes the values to the Employee) or reject. Managers
 * can open it read-only to see what they filed is still pending.
 */
export default function EmployeeChangeRequests({ open, onClose, onDecided }) {
  const { isAdmin, isAccountant } = useAuth();
  const canDecide = isAdmin || isAccountant;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll/employee-change-requests', { params: { status: 'pending' } })
      .then(r => setRequests(r.data.requests || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const decide = (r, approve) => {
    setBusy(b => ({ ...b, [r.id]: true }));
    api.post(`/payroll/employee-change-requests/${r.id}/decide`, { approve })
      .then(() => {
        toast.success(approve ? 'השינויים אושרו והוחלו' : 'הבקשה נדחתה');
        load();
        onDecided && onDecided();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setBusy(b => ({ ...b, [r.id]: false })));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <FactCheckIcon color="warning" /> שינויי עובדים ממתינים לאישור
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
        ) : requests.length === 0 ? (
          <Alert severity="success">אין שינויים ממתינים.</Alert>
        ) : (
          <Stack spacing={2}>
            {!canDecide && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                תצוגה בלבד — רק הנהלת חשבונות או מנהל מערכת יכולים לאשר.
              </Alert>
            )}
            {requests.map(r => (
              <Paper key={r.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography sx={{ fontWeight: 800 }}>{r.employee_name}</Typography>
                  {r.branch_name && <Chip size="small" variant="outlined" label={r.branch_name} />}
                  <Chip size="small" color="warning" label={`${r.changes.length} שינויים`} />
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    {r.requested_by_name} · {fmtDate(r.created_at)}
                  </Typography>
                </Stack>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>שדה</TableCell>
                      <TableCell>לפני</TableCell>
                      <TableCell>אחרי</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {r.changes.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell sx={{ fontWeight: 700 }}>{c.label || c.field}</TableCell>
                        <TableCell sx={{ color: 'text.secondary', textDecoration: 'line-through', maxWidth: 220, overflowWrap: 'anywhere' }}>
                          {show(c.before)}
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'success.dark', maxWidth: 220, overflowWrap: 'anywhere' }}>
                          {show(c.after)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {canDecide && (
                  <>
                    <Divider sx={{ my: 1 }} />
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button size="small" color="error" startIcon={<CloseIcon />}
                        disabled={busy[r.id]} onClick={() => decide(r, false)}>דחה</Button>
                      <Button size="small" variant="contained" color="success" startIcon={<CheckIcon />}
                        disabled={busy[r.id]} onClick={() => decide(r, true)}>אשר והחל</Button>
                    </Stack>
                  </>
                )}
              </Paper>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}
