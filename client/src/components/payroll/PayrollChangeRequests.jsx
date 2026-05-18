import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Button, Chip, Tabs, Tab,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  TextField, Divider, Alert, CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Accountant/admin view of payroll change requests submitted by branch
 * managers. Each request is a batch of staged manual-field edits. The
 * reviewer can approve/reject the whole batch or individual lines.
 */
const STATUS = {
  pending: { label: 'ממתין', color: 'warning' },
  approved: { label: 'אושר', color: 'success' },
  rejected: { label: 'נדחה', color: 'error' },
  partially_approved: { label: 'אושר חלקית', color: 'info' },
};

function fmtVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') {
    if (v.kind === 'number') return `${v.amount} ₪`;
    if (v.kind === 'text') return v.text;
    if (v.kind === 'empty') return '—';
    return JSON.stringify(v);
  }
  if (v === true) return 'כן';
  if (v === false) return 'לא';
  return String(v);
}

export default function PayrollChangeRequests() {
  const [tab, setTab] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  // per-request: { [reqId]: { decisions: string[], note: string } }
  const [draft, setDraft] = useState({});

  const fetchRequests = useCallback(() => {
    setLoading(true);
    api.get('/payroll-month/change-requests', { params: { status: tab } })
      .then(res => {
        setRequests(res.data.requests || []);
        const d = {};
        for (const r of res.data.requests || []) {
          d[r._id] = {
            decisions: (r.changes || []).map((_, i) => r.change_decisions?.[i] || 'approved'),
            note: r.decision_note || '',
          };
        }
        setDraft(d);
      })
      .catch(() => toast.error('שגיאה בטעינת בקשות'))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const setLineDecision = (reqId, idx, value) => {
    setDraft(prev => ({
      ...prev,
      [reqId]: {
        ...prev[reqId],
        decisions: prev[reqId].decisions.map((d, i) => i === idx ? value : d),
      },
    }));
  };
  const setAll = (reqId, value, count) => {
    setDraft(prev => ({ ...prev, [reqId]: { ...prev[reqId], decisions: Array(count).fill(value) } }));
  };

  const decide = async (req) => {
    const d = draft[req._id];
    try {
      const res = await api.post(`/payroll-month/change-requests/${req._id}/decide`, {
        decisions: d.decisions,
        decision_note: d.note,
      });
      toast.success(`עודכן — הוחלו ${res.data.applied} שינויים`);
      fetchRequests();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  return (
    <Box dir="rtl">
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>בקשות שינוי שכר</Typography>
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} dir="rtl" sx={{ mb: 2 }}>
        <Tab value="pending" label="ממתינות" />
        <Tab value="approved" label="אושרו" />
        <Tab value="partially_approved" label="אושרו חלקית" />
        <Tab value="rejected" label="נדחו" />
      </Tabs>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : requests.length === 0 ? (
        <Card sx={{ borderRadius: 3 }}>
          <CardContent>
            <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
              אין בקשות {STATUS[tab]?.label || ''}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={2}>
          {requests.map(req => {
            const d = draft[req._id] || { decisions: [], note: '' };
            const st = STATUS[req.status] || STATUS.pending;
            const isPending = req.status === 'pending';
            return (
              <Card key={req._id} variant="outlined" sx={{ borderRadius: 3 }}>
                <CardContent>
                  <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                    <Chip label={st.label} color={st.color} size="small" />
                    <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                      {req.requested_by_name || 'מנהל'} · {req.branch_name || '—'}
                    </Typography>
                    <Chip label={`חודש ${req.month}`} size="small" variant="outlined" />
                    <Typography variant="caption" color="text.secondary">
                      נשלח: {new Date(req.created_at).toLocaleString('he-IL')}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    <Chip label={`${req.changes.length} שינויים`} size="small" />
                  </Stack>
                  {req.note && (
                    <Alert severity="info" sx={{ mb: 1, borderRadius: 2 }}>{req.note}</Alert>
                  )}

                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>עובד</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>שדה</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>ערך נוכחי</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>ערך מבוקש</TableCell>
                          {isPending && <TableCell sx={{ fontWeight: 700 }} align="center">החלטה</TableCell>}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {req.changes.map((ch, i) => (
                          <TableRow key={i}>
                            <TableCell sx={{ fontWeight: 600 }}>{ch.employee_name}</TableCell>
                            <TableCell>{ch.field_label}</TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>{fmtVal(ch.current_value)}</TableCell>
                            <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{fmtVal(ch.requested_value)}</TableCell>
                            {isPending ? (
                              <TableCell align="center">
                                <Stack direction="row" spacing={0.5} justifyContent="center">
                                  <Button
                                    size="small"
                                    variant={d.decisions[i] === 'approved' ? 'contained' : 'outlined'}
                                    color="success"
                                    onClick={() => setLineDecision(req._id, i, 'approved')}
                                    sx={{ minWidth: 36, px: 1 }}
                                  >✓</Button>
                                  <Button
                                    size="small"
                                    variant={d.decisions[i] === 'rejected' ? 'contained' : 'outlined'}
                                    color="error"
                                    onClick={() => setLineDecision(req._id, i, 'rejected')}
                                    sx={{ minWidth: 36, px: 1 }}
                                  >✗</Button>
                                </Stack>
                              </TableCell>
                            ) : (
                              <TableCell align="center">
                                <Chip
                                  size="small"
                                  label={req.change_decisions?.[i] === 'approved' ? 'אושר' : req.change_decisions?.[i] === 'rejected' ? 'נדחה' : '—'}
                                  color={req.change_decisions?.[i] === 'approved' ? 'success' : req.change_decisions?.[i] === 'rejected' ? 'error' : 'default'}
                                  variant="outlined"
                                />
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>

                  {isPending && (
                    <Stack spacing={1.5} sx={{ mt: 2 }}>
                      <Stack direction="row" spacing={1}>
                        <Button size="small" onClick={() => setAll(req._id, 'approved', req.changes.length)}>אשר הכל</Button>
                        <Button size="small" color="error" onClick={() => setAll(req._id, 'rejected', req.changes.length)}>דחה הכל</Button>
                      </Stack>
                      <TextField
                        size="small" fullWidth label="הערת החלטה (אופציונלי)"
                        value={d.note}
                        onChange={e => setDraft(prev => ({ ...prev, [req._id]: { ...prev[req._id], note: e.target.value } }))}
                      />
                      <Box>
                        <Button
                          variant="contained"
                          startIcon={<CheckCircleIcon />}
                          onClick={() => decide(req)}
                        >
                          החל החלטה
                        </Button>
                      </Box>
                    </Stack>
                  )}
                  {!isPending && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      טופל ע״י {req.decided_by_name || '—'} ב-{req.decided_at ? new Date(req.decided_at).toLocaleString('he-IL') : '—'}
                      {req.decision_note && ` · ${req.decision_note}`}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
