import { useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Table, TableHead, TableBody, TableRow,
  TableCell, TableContainer, Chip, IconButton, Tooltip, TextField, Alert,
  AlertTitle, Divider, CircularProgress, Button, Tabs, Tab, Collapse, Badge,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditNoteIcon from '@mui/icons-material/EditNote';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useWorkMonth } from '../../hooks/useWorkMonth';
import { useConfirm } from '../shared/ConfirmProvider';
import { BusyButton } from '../shared/UploadControls';
import AddUpdateDialog from './AddUpdateDialog';
import {
  TYPE_LABEL, typeColor, STATUS_META, canDecidePayroll, adjustmentValue,
} from './adjustmentTypes';

const fmtDateTime = (d) => { try { return d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''; } catch { return ''; } };

/** number_or_text fields arrive as { kind, amount, text } — render whichever is set. */
function fieldValueText(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') {
    if (v.kind === 'text' && v.text) return v.text;
    if (v.amount !== null && v.amount !== undefined && v.amount !== '') return String(v.amount);
    return '—';
  }
  return String(v);
}

/* ------------------------------------------------------------ employee row */

function EmployeeRow({ emp, month, canDecide, onAdd, onDecide }) {
  const [open, setOpen] = useState(false);
  const adjustments = emp.adjustments || [];
  const pendingFields = emp.pending_fields || [];
  const hasAny = adjustments.length > 0 || pendingFields.length > 0;

  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 40 }}>
          {hasAny && (
            <IconButton size="small" onClick={() => setOpen(o => !o)}>
              {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={{ fontWeight: 600 }}>{emp.full_name}</TableCell>
        <TableCell sx={{ color: 'text.secondary' }}>{emp.branch_name}</TableCell>
        <TableCell align="center">
          {adjustments.length === 0 && pendingFields.length === 0 ? (
            <Typography variant="caption" color="text.disabled">—</Typography>
          ) : (
            <Stack direction="row" spacing={0.5} justifyContent="center" flexWrap="wrap" useFlexGap>
              {emp.pending_count > 0 && <Chip size="small" color="warning" label={`${emp.pending_count} ממתינים`} />}
              {adjustments.filter(a => a.status === 'approved').length > 0 && (
                <Chip size="small" color="success" variant="outlined"
                  label={`${adjustments.filter(a => a.status === 'approved').length} אושרו`} />
              )}
              {pendingFields.length > 0 && (
                <Chip size="small" color="info" variant="outlined" label={`${pendingFields.length} בקשות שדה`} />
              )}
            </Stack>
          )}
        </TableCell>
        <TableCell align="center">
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => onAdd(emp)}>
            הוסף עדכון
          </Button>
        </TableCell>
      </TableRow>

      {hasAny && (
        <TableRow>
          <TableCell colSpan={5} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} unmountOnExit>
              <Box sx={{ py: 1.5, pr: 4 }}>
                {adjustments.map(a => {
                  const st = STATUS_META[a.status] || {};
                  return (
                    <Stack key={a.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap
                      sx={{ py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
                      <Chip size="small" color={typeColor(a.type)} label={TYPE_LABEL[a.type] || a.type} />
                      <Typography sx={{ fontWeight: 700, minWidth: 90 }}>{adjustmentValue(a)}</Typography>
                      <Chip size="small" variant="outlined" color={st.color || 'default'} label={st.label || a.status} />
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                        {a.reason || '—'} · {a.created_by_name} · {fmtDateTime(a.created_at)}
                        {a.decided_by_name && ` · הוכרע ע״י ${a.decided_by_name}`}
                        {a.decided_note && ` — ${a.decided_note}`}
                      </Typography>
                      {canDecide && a.status === 'pending' && (
                        <Stack direction="row" spacing={0.5}>
                          <Tooltip title="אשר">
                            <IconButton size="small" color="success" onClick={() => onDecide(a, true)}>
                              <CheckCircleIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="דחה">
                            <IconButton size="small" color="error" onClick={() => onDecide(a, false)}>
                              <CancelIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      )}
                    </Stack>
                  );
                })}
                {pendingFields.map((f, i) => (
                  <Stack key={`${f.field}-${i}`} direction="row" spacing={1} alignItems="center"
                    sx={{ py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Chip size="small" icon={<EditNoteIcon />} label={f.field_label} />
                    <Typography sx={{ fontWeight: 700 }}>{fieldValueText(f.requested_value)}</Typography>
                    <Chip size="small" variant="outlined" color="warning" label="בקשת שינוי ממתינה" />
                    <Typography variant="caption" color="text.secondary">
                      {f.requested_by_name} · {fmtDateTime(f.created_at)}
                    </Typography>
                  </Stack>
                ))}
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- page */

/**
 * עדכוני שכר — the branch manager's own area.
 *
 * She used to do this from inside the monthly salary table, which meant that
 * adding one bonus put every employee's rate, global salary and net in front
 * of her. None of that is hers to see and none of it is needed to say "this
 * person is owed 200₪ for art supplies". Here she gets her staff, what has
 * been filed about them, and one button.
 *
 * Everything she files is `pending` and stays out of the salary until an
 * accountant approves it — which is also why nothing on this screen deletes:
 * a filed request is a record, and the answer to a wrong one is a rejection
 * with a reason, not an eraser.
 */
export default function PayrollUpdates() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { month, setMonth } = useWorkMonth();
  const canDecide = canDecidePayroll(user);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('all');
  const [addFor, setAddFor] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [denied, setDenied] = useState('');

  const load = () => {
    setLoading(true);
    setDenied('');
    api.get('/payroll-month/my-updates', { params: { month } })
      .then(res => setData(res.data))
      .catch((err) => {
        setData(null);
        // A refusal is an explanation, not a red flash that disappears. The
        // account is either not set up as a manager or holds a stale token,
        // and both are fixed by someone — not by retrying.
        if (err.response?.status === 403) {
          setDenied(err.response?.data?.error || 'אין הרשאה לצפות במסך זה.');
        } else {
          toast.error(err.response?.data?.error || 'שגיאה בטעינה');
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [month]);

  const employees = data?.employees || [];
  const pendingTotal = employees.reduce((s, e) => s + (e.pending_count || 0), 0);

  const shown = useMemo(() => {
    let list = employees;
    if (tab === 'pending') list = list.filter(e => (e.pending_count || 0) > 0 || (e.pending_fields || []).length > 0);
    if (tab === 'any') list = list.filter(e => (e.adjustments || []).length > 0 || (e.pending_fields || []).length > 0);
    const q = search.trim();
    if (q) list = list.filter(e => e.full_name.includes(q));
    return list;
  }, [employees, tab, search]);

  const decide = async (adj, approve) => {
    const ok = await confirm({
      title: approve ? 'אישור עדכון שכר' : 'דחיית עדכון שכר',
      message: approve
        ? `לאשר ${TYPE_LABEL[adj.type] || adj.type} ${adjustmentValue(adj)}? העדכון ייכנס לחישוב השכר של החודש.`
        : `לדחות ${TYPE_LABEL[adj.type] || adj.type} ${adjustmentValue(adj)}? הרישום יישמר כנדחה.`,
      danger: !approve,
    });
    if (!ok) return;
    setDeciding(true);
    api.post(`/payroll-month/adjustments/${adj.id}/decide`, { approve })
      .then(() => { toast.success(approve ? 'אושר' : 'נדחה'); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setDeciding(false));
  };

  const approveAllPending = async () => {
    const ids = employees.flatMap(e => (e.adjustments || []).filter(a => a.status === 'pending').map(a => a.id));
    if (ids.length === 0) return;
    if (!(await confirm({
      title: 'אישור כל הממתינים',
      message: `לאשר ${ids.length} עדכונים? כולם ייכנסו לחישוב השכר של ${month}.`,
    }))) return;
    setDeciding(true);
    api.post('/payroll-month/adjustments/decide-bulk', { ids, approve: true })
      .then(res => { toast.success(`אושרו ${res.data.decided}`); load(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'))
      .finally(() => setDeciding(false));
  };

  return (
    <Box dir="rtl" sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <EditNoteIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>עדכוני שכר</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField label="חודש" type="month" size="small" value={month}
          onChange={e => setMonth(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 170 }} />
        <Tooltip title="רענן"><IconButton onClick={load}><RefreshIcon /></IconButton></Tooltip>
      </Stack>

      {denied && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle sx={{ fontWeight: 700 }}>אין גישה למסך</AlertTitle>
          {denied}
        </Alert>
      )}

      {!canDecide && !denied && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle sx={{ fontWeight: 700 }}>איך זה עובד</AlertTitle>
          אפשר להוסיף לכל עובד/ת בסניפים שבניהולך כל עדכון שכר — בונוס, הלוואה, מקדמה, תיקון שעות, החזר קניות,
          גיפט קארד, מילואים ועוד. כל עדכון נרשם על שמך ומועבר לאישור הנהלת החשבונות, ולא משפיע על השכר עד שיאושר.
          לא ניתן למחוק עדכון שנרשם — אם נפלה טעות, הנהלת החשבונות תדחה אותו עם הסבר.
          <Box component="span" sx={{ display: 'block', mt: 0.5 }}>
            שינוי או השלמה של החתמות נעשים בלשונית <b>החתמות</b>, ועוברים לאישור באותו אופן.
          </Box>
        </Alert>
      )}

      <Card sx={{ borderRadius: 3 }}>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)}>
              <Tab value="all" label={`כל העובדים (${employees.length})`} />
              <Tab value="any" label="עם עדכונים" />
              <Tab
                value="pending"
                label={<Badge color="warning" badgeContent={pendingTotal} max={99}><Box sx={{ pl: 2 }}>ממתינים</Box></Badge>}
              />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            <TextField size="small" label="חיפוש עובד/ת" value={search} onChange={e => setSearch(e.target.value)} />
            {canDecide && pendingTotal > 0 && (
              <BusyButton variant="contained" color="success" loading={deciding} loadingText="מאשר…"
                startIcon={<CheckCircleIcon />} onClick={approveAllPending}>
                אשר הכל ({pendingTotal})
              </BusyButton>
            )}
          </Stack>

          <Divider sx={{ mb: 1 }} />

          {loading ? (
            <Box sx={{ textAlign: 'center', py: 5 }}><CircularProgress /></Box>
          ) : employees.length === 0 ? (
            <Alert severity="warning">
              {data?.scope_branch_count === 0
                ? 'לא משויכים אליך סניפים לניהול, ולכן אין עובדים להצגה. מנהל המערכת צריך לשייך לך סניפים במסך ההרשאות.'
                : data?.out_of_scope_branch
                  ? 'הסניף שנבחר בראש המסך אינו אחד מהסניפים שבניהולך. החלף/י סניף בבורר שלמעלה.'
                  : 'אין עובדים פעילים בסניפים שבניהולך.'}
            </Alert>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 40 }} />
                    <TableCell sx={{ fontWeight: 700 }}>עובד/ת</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">עדכוני החודש</TableCell>
                    <TableCell sx={{ fontWeight: 700 }} align="center">פעולה</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {shown.map(emp => (
                    <EmployeeRow
                      key={emp.employee_id}
                      emp={emp}
                      month={month}
                      canDecide={canDecide}
                      onAdd={setAddFor}
                      onDecide={decide}
                    />
                  ))}
                  {shown.length === 0 && (
                    <TableRow><TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                      אין רשומות להצגה
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <AddUpdateDialog
        open={!!addFor}
        employee={addFor}
        month={month}
        canDecide={canDecide}
        requestableFields={data?.requestable_fields || []}
        leaveKinds={data?.leave_kinds || []}
        onClose={() => setAddFor(null)}
        onSaved={load}
      />
    </Box>
  );
}
