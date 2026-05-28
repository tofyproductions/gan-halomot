import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, Collapse,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Branch-manager banner showing manual punches that employees submitted and
 * are waiting on review. One-click approve / reject; the action timestamps
 * the manager and immediately removes the row from the list.
 */
export default function PendingPunchApprovals() {
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [reject, setReject] = useState({ open: false, punch: null, note: '' });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll/punches/pending')
      .then(res => setPunches([...(res.data.pending_manager || []), ...(res.data.pending_accountant || [])]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = (id) => {
    api.patch(`/payroll/punches/${id}/approve`)
      .then(() => { toast.success('אושר'); setPunches(p => p.filter(x => x._id !== id)); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };
  const doReject = () => {
    const { punch, note } = reject;
    if (!punch) return;
    api.patch(`/payroll/punches/${punch._id}/reject`, { note })
      .then(() => { toast.success('נדחה'); setPunches(p => p.filter(x => x._id !== punch._id)); setReject({ open: false, punch: null, note: '' }); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  if (loading && punches.length === 0) return null;
  if (punches.length === 0) return null;

  // Group punches by date+employee for compact display
  const grouped = {};
  for (const p of punches) {
    const key = `${p.employee_id?._id || 'no-emp'}-${new Date(p.timestamp).toLocaleDateString('he-IL')}`;
    if (!grouped[key]) {
      grouped[key] = {
        employee_name: p.employee_id?.full_name || '—',
        israeli_id: p.employee_id?.israeli_id || '',
        date: new Date(p.timestamp).toLocaleDateString('he-IL'),
        items: [],
      };
    }
    grouped[key].items.push(p);
  }

  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 3, mb: 2, p: 2, borderColor: 'warning.main', bgcolor: 'warning.50' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: expanded ? 1.5 : 0 }}>
          <PendingActionsIcon color="warning" />
          <Typography variant="subtitle1" sx={{ fontWeight: 800, flex: 1 }}>
            דיווחים ממתינים לאישור
          </Typography>
          <Chip label={`${punches.length} פריטים`} size="small" color="warning" />
          <IconButton size="small" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>

        <Collapse in={expanded}>
          <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }} icon={false}>
            החתמות ידניות הממתינות לאישורך. רק לאחר אישור סופי של הנה״ח הן נכנסות לשכר.
          </Alert>

          <Stack spacing={1}>
            {Object.entries(grouped).map(([key, group]) => (
              <Paper key={key} variant="outlined" sx={{ borderRadius: 2, p: 1.2 }}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                  <Typography sx={{ fontWeight: 700, minWidth: 130 }}>{group.employee_name}</Typography>
                  <Typography variant="caption" color="text.secondary">{group.date}</Typography>
                  <Box sx={{ flex: 1 }} />
                  {group.items.map(p => (
                    <Stack key={p._id} direction="row" spacing={0.5} alignItems="center" sx={{ bgcolor: 'background.paper', borderRadius: 2, px: 1, py: 0.3 }}>
                      <Chip
                        size="small" label={p.state === 0 ? 'כניסה' : 'יציאה'}
                        color={p.state === 0 ? 'primary' : 'default'} variant="outlined"
                      />
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {new Date(p.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                      </Typography>
                      {p.manual_note && (
                        <Tooltip title={p.manual_note}>
                          <Chip size="small" label="הערה" variant="outlined" />
                        </Tooltip>
                      )}
                      <Tooltip title="אשר">
                        <IconButton size="small" color="success" onClick={() => approve(p._id)}>
                          <CheckCircleIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="דחה">
                        <IconButton size="small" color="error" onClick={() => setReject({ open: true, punch: p, note: '' })}>
                          <CancelIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  ))}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Collapse>
      </Paper>

      <Dialog open={reject.open} onClose={() => setReject({ open: false, punch: null, note: '' })} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>דחיית דיווח</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={3}
            label="סיבת הדחייה (אופציונלי)"
            value={reject.note}
            onChange={e => setReject(r => ({ ...r, note: e.target.value }))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReject({ open: false, punch: null, note: '' })}>ביטול</Button>
          <Button variant="contained" color="error" onClick={doReject}>דחה</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
