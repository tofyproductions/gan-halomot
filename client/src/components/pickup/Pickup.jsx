import { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Chip, Alert, Button,
  ToggleButton, ToggleButtonGroup, CircularProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Table, TableBody, TableCell,
  TableHead, TableRow,
} from '@mui/material';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * מורשי איסוף — who may collect a child.
 *
 * Two lists, and the second one is the point. The QUEUE is what families have
 * asked for; the ROLL is who may actually walk out with a child today, which
 * is what the person at the door needs — and why seeing this screen is a wider
 * grant than deciding on it. A teacher closing the room at five can read it;
 * only a manager can add to it.
 *
 * The screen says what the approval rests on. This system holds a name, a
 * telephone number and a relationship; it cannot verify a person, and the
 * check that matters happens at the door against a document.
 */

const DECIDERS = ['system_admin', 'branch_manager'];

function errText(e, fallback) {
  return e?.response?.data?.error || fallback;
}

function fmt(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('he-IL');
}

export default function Pickup() {
  const { user } = useAuth();
  const canDecide = DECIDERS.includes(user?.role);

  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.get('/pickup', { params: { status } });
      setRows(r.data.people || []);
    } catch (e) {
      setError(errText(e, 'לא הצלחנו לטעון את הרשימה'));
    } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const decide = async (p, approve) => {
    try {
      await api.post(`/pickup/${p.id}/decide`, { approve, reason });
      setRejecting(null); setReason('');
      load();
    } catch (e) { setError(errText(e, 'הפעולה נכשלה')); }
  };

  const revoke = async (p) => {
    try {
      await api.post(`/pickup/${p.id}/revoke`, {});
      load();
    } catch (e) { setError(errText(e, 'הביטול נכשל')); }
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" sx={{ flex: 1 }}>מורשי איסוף</Typography>
        <ToggleButtonGroup size="small" exclusive value={status}
          onChange={(_, v) => v && setStatus(v)}>
          <ToggleButton value="pending">ממתינים</ToggleButton>
          <ToggleButton value="approved">מאושרים</ToggleButton>
          <ToggleButton value="rejected">נדחו</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Alert severity="warning" sx={{ mb: 2 }}>
        <b>הרשימה אינה מזהה אף אחד.</b> היא מחזיקה שם, טלפון וקרבה בלבד. בזמן האיסוף יש לבקש
        תעודת זהות ולהשוות לשם. הורה יכול להסיר מורשה בכל רגע, גם בלי אישור הגן.
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

      {!loading && rows.length === 0 && (
        <Alert severity="info">
          {status === 'pending' ? 'אין בקשות שממתינות לאישור.' : 'אין רשומות ברשימה הזו.'}
        </Alert>
      )}

      {!loading && rows.length > 0 && (
        <Card>
          <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ילד/ה</TableCell>
                  <TableCell>המורשה</TableCell>
                  <TableCell>קרבה</TableCell>
                  <TableCell>טלפון</TableCell>
                  <TableCell>ביקש/ה</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(p => (
                  <TableRow key={p.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{p.child_name}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{p.name}</TableCell>
                    <TableCell>{p.relation || '—'}</TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{p.phone || '—'}</TableCell>
                    <TableCell>
                      {p.added_by_name || '—'}
                      <Typography variant="caption" color="text.secondary" component="div">
                        {fmt(p.created_at)}
                      </Typography>
                    </TableCell>
                    <TableCell align="left">
                      {status === 'pending' && canDecide && (
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button size="small" variant="contained" onClick={() => decide(p, true)}>
                            אישור
                          </Button>
                          <Button size="small" color="error"
                            onClick={() => { setRejecting(p); setReason(''); }}>
                            דחייה
                          </Button>
                        </Stack>
                      )}
                      {status === 'approved' && (
                        <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
                          <Chip size="small" color="success" variant="outlined"
                            label={`אושר ${fmt(p.decided_at)}${p.decided_by_name ? ` · ${p.decided_by_name}` : ''}`} />
                          {canDecide && (
                            <Button size="small" color="error" onClick={() => revoke(p)}>
                              ביטול אישור
                            </Button>
                          )}
                        </Stack>
                      )}
                      {status === 'rejected' && (
                        <Typography variant="caption" color="text.secondary">
                          {p.reject_reason || '—'}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!rejecting} onClose={() => setRejecting(null)} fullWidth maxWidth="xs">
        <DialogTitle>דחיית הבקשה</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth multiline minRows={3} sx={{ mt: 1 }}
            label="למה?" value={reason} onChange={(e) => setReason(e.target.value)}
            helperText="ההורה יראה את זה בפורטל."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejecting(null)}>ביטול</Button>
          <Button color="error" variant="contained" disabled={!reason.trim()}
            onClick={() => decide(rejecting, false)}>
            דחייה
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
