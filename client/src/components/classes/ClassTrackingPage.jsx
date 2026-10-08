import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, IconButton,
  Chip, Table, TableHead, TableBody, TableRow, TableCell, Tabs, Tab, Badge,
  Menu, Collapse, Tooltip, Divider, Alert, CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PeopleIcon from '@mui/icons-material/People';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import ProvidersDialog from './ProvidersDialog';
import ClassInvoiceDialog from './ClassInvoiceDialog';
import IcountFileDialog from '../expenses/IcountFileDialog';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים', 'קבוצה'];
const STATUS = {
  scheduled: { label: 'מתוכנן', color: 'default' },
  occurred: { label: 'התקיים', color: 'success' },
  partial: { label: 'חלקית', color: 'warning' },
  no_show: { label: 'לא הגיע', color: 'error' },
  postponed: { label: 'נדחה', color: 'warning' },
};
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const ils = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;

/**
 * Mirrors the server's VAT_RATE. The rate stored on a program is always the
 * pre-VAT figure (see ClassProvider.vat_mode); what the screen SAYS is what
 * leaves the bank, so a registered provider's figures are shown with the VAT
 * already on top and labelled as such.
 */
const VAT_RATE = 0.18;
const withVat = (n, vatMode) => vatMode === 'registered' ? (Number(n) || 0) * (1 + VAT_RATE) : (Number(n) || 0);
const rateLabel = (rate, vatMode) => vatMode === 'registered'
  ? `${ils(withVat(rate, vatMode))}/מפגש כולל מע״מ`
  : `${ils(rate)}/מפגש`;

/**
 * Each program's color — the same tint its cell wears on the gantt, so a class
 * is the same color wherever it appears.
 */
const progColor = (p) => p?.color || '#fce7f3';
const ColorDot = ({ color }) => (
  <Box component="span" sx={{
    width: 13, height: 13, borderRadius: '50%', bgcolor: color,
    border: '1px solid rgba(0,0,0,0.25)', display: 'inline-block', flexShrink: 0,
  }} />
);
/** The chips worth a glance — group, day, hour — filled in the class's color and bold. */
const boldChip = (color) => ({ bgcolor: color, fontWeight: 700, border: '1px solid rgba(0,0,0,0.12)' });


// ---------- What each provider is owed this month ----------
/**
 * Grouped by provider, not by class, because that is what gets invoiced: one
 * instructor who takes three groups at two rates sends one bill. The per-group
 * rows stay underneath for the month somebody questions in February — which is
 * exactly why the old spreadsheet kept its blocks above the summary.
 */
function PaymentSummary({ data, payments, accounting, branch, month, onPaymentsChanged }) {
  // The fetch moved up to the page: the provider rows below the summary show
  // the same monthly totals in their headers, and two fetches of one figure
  // is two figures.
  const [open, setOpen] = useState(false);
  const [invoiceFor, setInvoiceFor] = useState(null); // { provider_id, provider_name, amount }
  const [icountDoc, setIcountDoc] = useState(null);   // the linked ExpenseDocument, for the filing dialog
  const [togglingKey, setTogglingKey] = useState('');

  // The money box is accounting's room: only system_admin / accountant see it
  // at all (the server refuses /payments to anyone else anyway).
  if (!accounting) return null;
  if (!data || !(data.providers || []).length) return null;

  /**
   * The accountant's table, open by default: one line per provider with what
   * is counted, whether VAT is added, the figure that leaves the bank — and
   * now whether it actually left: שולם, the invoice, and iCount.
   * The per-group rows underneath stay behind "פירוט" — they are for the
   * month somebody questions, not for every glance.
   */
  const meetingsOf = (p) => p.programs.reduce((t, g) => t + (g.occurred || 0), 0);
  const partialsOf = (p) => p.programs.reduce((t, g) => t + (g.partial || 0), 0);
  const pendingOf = (p) => p.programs.reduce((t, g) => t + (g.scheduled || 0), 0);
  const totalPending = data.providers.reduce((t, p) => t + pendingOf(p), 0);

  // The same key the server stores — a provider's id, or 'name:<שם>' for the
  // name-only instructor — so a summary row finds exactly its payment row.
  const keyOf = (p) => (p.provider_id ? String(p.provider_id) : `name:${p.provider_name}`);
  const paymentOf = (p) => (payments || []).find(r => r.provider_key === keyOf(p)) || null;
  const unpaidCount = data.providers.filter(p => p.total > 0 && !paymentOf(p)?.paid).length;

  const togglePaid = async (p) => {
    const key = keyOf(p);
    const pay = paymentOf(p);
    setTogglingKey(key);
    try {
      await api.post('/classes/payments/mark', {
        branch_id: branch, month,
        provider_id: p.provider_id || null,
        provider_name: p.provider_name,
        paid: !pay?.paid,
      });
      onPaymentsChanged?.();
    } catch (err) {
      toast.error(apiError(err, 'עדכון התשלום נכשל'));
    } finally { setTogglingKey(''); }
  };

  return (
    <Paper sx={{
      p: 2, mb: 2,
      border: '2px solid', borderColor: 'warning.main',
      bgcolor: '#fff8e1', // the accountant's box wears its own color — nobody scrolls past it
    }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography sx={{ fontWeight: 800 }}>💰 הנהלת חשבונות — תשלומי חוגים</Typography>
        {unpaidCount > 0
          ? <Chip size="small" color="error" label={`${unpaidCount} טרם שולמו`} />
          : <Chip size="small" color="success" label="הכול שולם" />}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontWeight: 800 }}>{ils(data.grand_total)}</Typography>
        <Button size="small" onClick={() => setOpen(o => !o)}>{open ? 'סגור פירוט' : 'פירוט לפי קבוצה'}</Button>
      </Stack>

      <Box sx={{ overflowX: 'auto', mt: 1.5 }}>
        <Table size="small" sx={{ minWidth: 900, '& td, & th': { bgcolor: 'transparent' } }}>
          <TableHead><TableRow>
            <TableCell>ספק / חוג</TableCell>
            <TableCell>מעמד</TableCell>
            <TableCell align="center">התקיימו</TableCell>
            <TableCell align="center">טרם סומנו</TableCell>
            <TableCell align="left">לפני מע״מ</TableCell>
            <TableCell align="left">מע״מ</TableCell>
            <TableCell align="left">לתשלום</TableCell>
            <TableCell align="center">שולם?</TableCell>
            <TableCell align="center">חשבונית</TableCell>
            <TableCell align="center">אייקאונט</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {data.providers.map(p => {
              const pay = paymentOf(p);
              const doc = pay?.document || null;
              const inIcount = !!(doc && (doc.icount_id || doc.icount_docnum));
              return (
                <TableRow key={p.provider_id || p.provider_name}>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {p.provider_name}
                    {p.retainer && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'info.main' }}>
                        חודשי קבוע · {p.retainer.held_this_month} מתוך {p.retainer.meetings_per_month} מפגשים
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined"
                      color={p.vat_mode === 'registered' ? 'warning' : 'default'}
                      label={p.vat_mode === 'registered' ? 'עוסק מורשה + מע״מ' : 'עוסק פטור'} />
                  </TableCell>
                  <TableCell align="center">
                    {meetingsOf(p)}{partialsOf(p) ? ` (+${partialsOf(p)} חלקית)` : ''}
                  </TableCell>
                  <TableCell align="center" sx={{ color: pendingOf(p) ? 'warning.main' : 'text.secondary' }}>
                    {pendingOf(p) || '—'}
                  </TableCell>
                  <TableCell align="left">{ils(p.subtotal)}</TableCell>
                  <TableCell align="left">{p.vat ? ils(p.vat) : '—'}</TableCell>
                  <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(p.total)}</TableCell>
                  <TableCell align="center">
                    <Tooltip title={pay?.paid
                      ? `סומן שולם${pay.paid_at ? ` · ${new Date(pay.paid_at).toLocaleDateString('he-IL')}` : ''}`
                      : accounting ? 'לחיצה מסמנת ששולם' : 'טרם שולם'}>
                      <Chip size="small"
                        color={pay?.paid ? 'success' : 'error'}
                        variant={pay?.paid ? 'filled' : 'outlined'}
                        sx={{ fontWeight: 700, ...(accounting ? { cursor: 'pointer' } : {}) }}
                        label={pay?.paid ? 'שולם ✓' : 'לא שולם'}
                        disabled={togglingKey === keyOf(p)}
                        onClick={accounting ? () => togglePaid(p) : undefined} />
                    </Tooltip>
                  </TableCell>
                  <TableCell align="center">
                    {doc ? (
                      <Tooltip title={`${doc.doc_number ? `מס׳ ${doc.doc_number} · ` : ''}${ils(doc.amount_total)} — המסמך במסך הוצאות`}>
                        <Chip size="small" color="success" variant="outlined" label={`✓ ${doc.doc_number || 'חשבונית'}`} />
                      </Tooltip>
                    ) : accounting ? (
                      <Button size="small" variant="outlined"
                        onClick={() => setInvoiceFor({ provider_id: p.provider_id || null, provider_name: p.provider_name, amount: p.total })}>
                        צרף חשבונית
                      </Button>
                    ) : '—'}
                  </TableCell>
                  <TableCell align="center">
                    {inIcount ? (
                      <Chip size="small" color="success"
                        label={doc.icount_docnum ? `באייקאונט · ${doc.icount_docnum}` : 'באייקאונט ✓'} />
                    ) : doc && accounting ? (
                      <Button size="small" variant="contained" color="warning"
                        onClick={() => setIcountDoc(doc)}>
                        ⬆ העלאה
                      </Button>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell colSpan={4} sx={{ fontWeight: 700 }}>סה״כ</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(data.grand_subtotal)}</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{data.grand_vat ? ils(data.grand_vat) : '—'}</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(data.grand_total)}</TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </TableBody>
        </Table>
      </Box>
      {totalPending > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {totalPending} מפגשים עדיין מסומנים "מתוכנן" ואינם נספרים לתשלום עד שמסמנים אם המדריכה הגיעה.
        </Typography>
      )}
      {accounting && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          חשבונית שמצורפת כאן נשמרת גם במסך הוצאות; חודש שלא סומן "שולם" מסומן שם "עוד לא שולמה", ולכן אפשר להעלות אותו לאייקאונט מיד.
        </Typography>
      )}

      <ClassInvoiceDialog
        open={!!invoiceFor}
        onClose={() => setInvoiceFor(null)}
        onSaved={onPaymentsChanged}
        provider={invoiceFor}
        branch={branch}
        month={month}
        suggestedAmount={invoiceFor?.amount || 0}
      />
      <IcountFileDialog
        doc={icountDoc}
        open={!!icountDoc}
        onClose={() => setIcountDoc(null)}
        onDone={() => onPaymentsChanged?.()}
      />

      {open && (
        <Box sx={{ mt: 1.5 }}>
          <Divider sx={{ mb: 1.5 }} />
          {data.providers.map(p => (
            <Box key={p.provider_id || p.provider_name} sx={{ mb: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography sx={{ fontWeight: 600 }}>{p.provider_name}</Typography>
                <Chip size="small" variant="outlined"
                  label={p.vat_mode === 'registered' ? 'עוסק מורשה' : 'פטור'} />
                {/* A retainer is paid flat; the meetings beside it feed the year-end settlement. */}
                {p.retainer && (
                  <Chip size="small" color="info" variant="outlined"
                    label={`חודשי קבוע · ${p.retainer.held_this_month} מתוך ${p.retainer.meetings_per_month} מפגשים החודש`} />
                )}
                <Box sx={{ flex: 1 }} />
                <Typography variant="body2" color="text.secondary">
                  {p.vat ? `${ils(p.subtotal)} + מע״מ ${ils(p.vat)} = ` : ''}
                </Typography>
                <Typography sx={{ fontWeight: 700 }}>{ils(p.total)}</Typography>
              </Stack>
              {/* Seven columns do not fit a phone; scroll the table, not the page. */}
              <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 560 }}>
                <TableHead><TableRow>
                  <TableCell>קבוצה</TableCell><TableCell>חוג</TableCell>
                  <TableCell align="center">התקיימו</TableCell>
                  <TableCell align="center">חלקית</TableCell>
                  <TableCell align="center">לא הגיע</TableCell>
                  <TableCell align="center">נדחו</TableCell>
                  <TableCell align="left">סכום</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {p.programs.map(g => (
                    <TableRow key={g.program_id}>
                      <TableCell>{g.classroom_category || '—'}</TableCell>
                      <TableCell>{g.program_name}</TableCell>
                      <TableCell align="center">{g.occurred || 0}</TableCell>
                      <TableCell align="center">{g.partial || 0}</TableCell>
                      <TableCell align="center">{g.no_show || 0}</TableCell>
                      <TableCell align="center">{g.postponed || 0}</TableCell>
                      <TableCell align="left">{ils(g.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}

/**
 * The "חוג חדש" dialog used to live here, and it was the second half of one
 * decision.
 *
 * Setting a class up meant this screen AND the provider screen: her name and
 * phone over there, her day and rate over here, and the two never knew about
 * each other — a provider at two branches with two different rates needed two
 * passes through a dialog that only ever held one. Worse, it could create a
 * class with no provider at all, which then had no phone number, no VAT status
 * and nothing to invoice against.
 *
 * It is one screen now: ProvidersDialog. The provider and her whole week —
 * every branch, every group, every rate — are saved together, and "חוג חדש"
 * opens it.
 */
// ---------- One program's monthly sessions ----------
function ProgramSessions({ program, month, vatMode, onChanged, version }) {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState([]);
  const [newDate, setNewDate] = useState('');
  const load = useCallback(() => {
    api.get('/classes/sessions', { params: { program_id: program._id, month } })
      .then(r => setSessions(r.data.sessions || [])).catch(() => setSessions([]));
    // version: the page's refresh counter — a mark made on the board above
    // must show in this open detail table too.
  }, [program._id, month, version]);
  useEffect(() => { load(); }, [load]);

  const [addingDate, setAddingDate] = useState(false);
  const addDate = () => {
    if (addingDate) return; // double-tap = duplicate session
    if (!newDate) return;
    setAddingDate(true);
    api.post('/classes/sessions', { program_id: program._id, date: newDate })
      .then(() => { setNewDate(''); load(); onChanged && onChanged(); })
      .catch(e => toast.error(e.response?.data?.error || 'שגיאה'))
      .finally(() => setAddingDate(false));
  };
  const setStatus = (s, status) => {
    // Manual status set (occurred / no_show) — reuses the answer endpoint.
    api.post(`/classes/sessions/${s._id}/answer`, { arrived: status === 'occurred', reason: '' })
      .then(() => { load(); onChanged && onChanged(); }).catch(e => toast.error(e.response?.data?.error || 'שגיאה'));
  };
  const del = async (s) => {
    if (!(await confirm({ title: 'מחיקת מפגש', message: `למחוק את המפגש ${s.date}?` }))) return;
    api.delete(`/classes/sessions/${s._id}`).then(() => { load(); onChanged && onChanged(); }).catch(err => toast.error(apiError(err, 'המחיקה נכשלה')));
  };

  const occurred = sessions.filter(s => s.status === 'occurred');
  const subtotal = occurred.reduce((sum, s) => sum + (Number(s.rate) || 0), 0);
  const total = withVat(subtotal, vatMode);

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <TextField size="small" type="date" value={newDate} onChange={e => setNewDate(e.target.value)} InputLabelProps={{ shrink: true }} />
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addDate} disabled={addingDate}>הוסף מפגש</Button>
        <Box sx={{ flex: 1 }} />
        <Chip color="success" sx={{ fontWeight: 700 }}
          label={vatMode === 'registered'
            ? `סה״כ לתשלום: ${ils(total)} כולל מע״מ (${occurred.length} מפגשים)`
            : `סה״כ לתשלום: ${ils(total)} (${occurred.length} מפגשים)`} />
      </Stack>
      {sessions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">אין מפגשים בחודש זה.</Typography>
      ) : (
        <Table size="small">
          <TableHead><TableRow>
            <TableCell>תאריך</TableCell><TableCell>שעה</TableCell><TableCell align="center">תעריף</TableCell>
            <TableCell align="center">סטטוס</TableCell><TableCell align="center">פעולות</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {sessions.map(s => (
              <TableRow key={s._id}>
                <TableCell>{s.date}</TableCell>
                <TableCell>{s.time || '—'}</TableCell>
                <TableCell align="center">{ils(s.rate)}</TableCell>
                <TableCell align="center">
                  <Chip size="small" color={STATUS[s.status]?.color || 'default'} label={STATUS[s.status]?.label || s.status} />
                  {s.status === 'postponed' && s.postponed_to_date && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'warning.main' }}>→ {s.postponed_to_date}</Typography>
                  )}
                  {s.status === 'occurred' && s.answered_by_lead && !s.manager_confirmed && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'info.main' }}>ממתין לאישור מנהל</Typography>
                  )}
                </TableCell>
                <TableCell align="center">
                  <Stack direction="row" spacing={0.5} justifyContent="center">
                    {s.status !== 'occurred' && <Tooltip title="סמן שהתקיים"><Button size="small" color="success" onClick={() => setStatus(s, 'occurred')}>הגיע</Button></Tooltip>}
                    {s.status !== 'no_show' && s.status !== 'postponed' && <Tooltip title="סמן שלא הגיע"><Button size="small" color="error" onClick={() => setStatus(s, 'no_show')}>לא</Button></Tooltip>}
                    <IconButton size="small" onClick={() => del(s)}><DeleteIcon fontSize="small" /></IconButton>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

export default function ClassTrackingPage() {
  const { selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const { user } = useAuth();
  // Who may touch the money: the paid toggle, the invoice, iCount — and the
  // whole תשלומים tab, which is simply not rendered for anyone else.
  const accounting = ['system_admin', 'accountant'].includes(user?.role);
  const confirm = useConfirm();
  const [month, setMonth] = useState(thisMonth());
  const [tab, setTab] = useState('track');
  const [programs, setPrograms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  // Which provider the one screen opens on. '' = the list, 'new' = the add form.
  const [providerFocus, setProviderFocus] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  // One switch for the whole page: programs, sessions, summary and payments
  // all answer to it, so a mark made anywhere shows everywhere at once.
  const refreshAll = useCallback(() => setRefreshKey(k => k + 1), []);

  const load = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setPrograms([]); return; }
    setLoading(true);
    api.get('/classes/programs', { params: { branch: selectedBranch, active: 'true' } })
      .then(pr => setPrograms(pr.data.programs || []))
      .catch(() => {}).finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);
  useEffect(() => { load(); }, [load, refreshKey]);

  /**
   * The month's payment summary, fetched once for the whole page: the
   * accountant's table and the per-row figure on the board are the same
   * numbers, so they must come from the same answer.
   */
  const [summary, setSummary] = useState(null);
  const loadSummary = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setSummary(null); return; }
    api.get('/classes/payment-summary', { params: { branch: selectedBranch, month } })
      .then(r => setSummary(r.data)).catch(() => setSummary(null));
  }, [selectedBranch, isAllBranches, month]);
  useEffect(() => { loadSummary(); }, [loadSummary, refreshKey]);

  const [payments, setPayments] = useState([]);
  const loadPayments = useCallback(() => {
    // Accounting's data: the server answers 403 to anyone else, so don't ask.
    if (!accounting || isAllBranches || !selectedBranch) { setPayments([]); return; }
    api.get('/classes/payments', { params: { branch: selectedBranch, month } })
      .then(r => setPayments(r.data.payments || [])).catch(() => setPayments([]));
  }, [accounting, selectedBranch, isAllBranches, month]);
  useEffect(() => { loadPayments(); }, [loadPayments, refreshKey]);

  /**
   * Every session of the month in one fetch — the board needs them all at
   * once to lay a program's dates side by side. The per-program fetch still
   * lives in ProgramSessions for the opened row's detail table.
   */
  const [sessions, setSessions] = useState([]);
  const loadSessions = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setSessions([]); return; }
    api.get('/classes/sessions', { params: { branch: selectedBranch, month } })
      .then(r => setSessions(r.data.sessions || [])).catch(() => setSessions([]));
  }, [selectedBranch, isAllBranches, month]);
  useEffect(() => { loadSessions(); }, [loadSessions, refreshKey]);

  /**
   * The month's closed days — "סוכות", "יום כיפור" — so a week with no
   * meeting says why, instead of looking like a hole somebody forgot to fill.
   */
  const [closedDays, setClosedDays] = useState([]);
  const loadClosed = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setClosedDays([]); return; }
    api.get('/classes/closed-days', { params: { branch: selectedBranch, month } })
      .then(r => setClosedDays(r.data.closed || [])).catch(() => setClosedDays([]));
  }, [selectedBranch, isAllBranches, month]);
  useEffect(() => { loadClosed(); }, [loadClosed]);
  const closedByDate = new Map(closedDays.map(c => [c.date, c.name]));

  const today = thisMonth() === month
    ? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })
    : (month < thisMonth() ? '9999-99-99' : '0000-00-00');

  // program_id -> its month of sessions, already date-sorted by the server.
  const sessionsOf = (() => {
    const m = new Map();
    for (const s of sessions) {
      const pid = String(s.program_id?._id || s.program_id);
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid).push(s);
    }
    return m;
  })();

  // A meeting whose day has passed and nobody said if the instructor came.
  const pending = sessions.filter(s => s.status === 'scheduled' && s.date <= today);

  // All the dates this weekday falls on this month — the board's real columns.
  const occurrencesOf = (day) => {
    const [y, m] = month.split('-').map(Number);
    const out = [];
    const days = new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      if (new Date(y, m - 1, d).getDay() === day) out.push(`${month}-${String(d).padStart(2, '0')}`);
    }
    return out;
  };

  /**
   * A program's row, cell by cell, anchored to its fixed day's real weeks —
   * so שבוע 3 is the third week even when סוכות ate the second. A session
   * lands on its own week, a closed day says the holiday's name, and a date
   * with no session yet stays an honest dash. Meetings moved off the fixed
   * day are appended at the end, in date order.
   */
  const rowCells = (p) => {
    const list = [...(sessionsOf.get(String(p._id)) || [])];
    if (p.default_day == null) return list.map(s => ({ session: s }));
    const cells = [];
    for (const date of occurrencesOf(p.default_day)) {
      const i = list.findIndex(s => s.date === date);
      if (i >= 0) cells.push({ session: list.splice(i, 1)[0] });
      else if (closedByDate.has(date)) cells.push({ closed: closedByDate.get(date), date });
      else cells.push({ missing: date });
    }
    for (const s of list) cells.push({ session: s });
    return cells;
  };
  const cellsByProgram = new Map(programs.map(p => [String(p._id), rowCells(p)]));
  const maxCols = Math.max(1, ...[...cellsByProgram.values()].map(l => l.length));

  // The program's month figure out of the same summary the accountant reads.
  const amountOf = (pid) => {
    for (const pr of summary?.providers || []) {
      for (const g of pr.programs || []) {
        if (String(g.program_id) === String(pid)) return g.amount || 0;
      }
    }
    return 0;
  };

  // The red count on the תשלומים tab — same rule as inside the box.
  const unpaidCount = (accounting && summary)
    ? summary.providers.filter(p => {
        if (!(p.total > 0)) return false;
        const key = p.provider_id ? String(p.provider_id) : `name:${p.provider_name}`;
        return !(payments || []).find(r => r.provider_key === key)?.paid;
      }).length
    : 0;

  /**
   * One mark menu for the whole board: a dot on the grid and a chip on the
   * waiting strip both open it, anchored where the click was.
   */
  const [menu, setMenu] = useState(null); // { anchorEl, session }
  const closeMenu = () => setMenu(null);
  const mark = (s, arrived) => {
    closeMenu();
    api.post(`/classes/sessions/${s._id}/answer`, { arrived, reason: '' })
      .then(() => refreshAll())
      .catch(err => toast.error(apiError(err, 'הסימון נכשל')));
  };
  const delSession = async (s) => {
    closeMenu();
    if (!(await confirm({ title: 'מחיקת מפגש', message: `למחוק את המפגש ${s.date}?` }))) return;
    api.delete(`/classes/sessions/${s._id}`)
      .then(() => refreshAll())
      .catch(err => toast.error(apiError(err, 'המחיקה נכשלה')));
  };

  // Which program rows are opened to their full detail table.
  const [openRows, setOpenRows] = useState({});
  const toggleRow = (pid) => setOpenRows(o => ({ ...o, [pid]: !o[pid] }));

  const [filling, setFilling] = useState(false);
  const fillMonth = async () => {
    /**
     * A month already behind us is written only on purpose. The server skips
     * past dates by default — the popup must not open on a week nobody was
     * tracking — so reconstructing September is a deliberate act, said out
     * loud: every meeting it writes still has to be answered, one by one.
     */
    const isPast = month < thisMonth();
    if (isPast && !(await confirm({
      title: 'שחזור חודש שעבר',
      message: 'המפגשים ייכתבו לפי היום הקבוע של כל חוג, בלי ימים שהגן היה סגור. כל מפגש יישאר "מתוכנן" עד שמסמנים אם המדריכה הגיעה. להמשיך?',
    }))) return;
    setFilling(true);
    api.post('/classes/sessions/fill-month', { month, include_past: isPast })
      .then(r => {
        const { created, skipped, closed = [] } = r.data;
        toast.success(created
          ? `נוצרו ${created} מפגשים`
          : `הכול כבר קיים${skipped ? ` (${skipped} מפגשים)` : ''}`);
        if (closed.length) {
          const names = [...new Set(closed.map(c => c.name))].join(', ');
          toast.info(`דולגו ${closed.length} ימים שהגן סגור: ${names}`);
        }
        refreshAll();
      })
      .catch(err => toast.error(apiError(err, 'המילוי נכשל')))
      .finally(() => setFilling(false));
  };

  const delProgram = async (p) => {
    if (!(await confirm({ title: 'הסרת חוג', message: `להסיר את "${p.name}"?` }))) return;
    api.delete(`/classes/programs/${p._id}`).then(() => refreshAll()).catch(err => toast.error(apiError(err, 'המחיקה נכשלה')));
  };

  const dayMonth = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

  /**
   * One board cell. The glyphs carry the month at a glance: ✓ came, ✗ did
   * not, ◐ partial, ← postponed, ? waiting for someone to say. A future date
   * stays a quiet gray date — nothing to do there yet.
   */
  const cellFor = (s) => {
    const dm = dayMonth(s.date);
    const open = (e) => { e.stopPropagation(); setMenu({ anchorEl: e.currentTarget, session: s }); };
    const glyph = (char, color, title, bold = false) => (
      <Tooltip title={title}>
        <Box component="span" onClick={open} sx={{
          cursor: 'pointer', fontWeight: bold ? 800 : 700, fontSize: 16,
          color, px: 0.75, py: 0.25, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' },
        }}>{char}</Box>
      </Tooltip>
    );
    switch (s.status) {
      case 'occurred':
        return glyph('✓', 'success.main', `התקיים · ${dm}${s.answered_by_lead && !s.manager_confirmed ? ' · ממתין לאישור מנהל' : ''}`);
      case 'no_show':
        return glyph('✗', 'error.main', `לא הגיע · ${dm}`);
      case 'partial':
        return glyph('◐', 'warning.main', `חלקית · ${dm}`);
      case 'postponed':
        return glyph('←', 'warning.main', `נדחה · ${dm}${s.postponed_to_date ? ` → ${dayMonth(s.postponed_to_date)}` : ''}`);
      default:
        return s.date <= today
          ? glyph('?', 'warning.main', `ממתין לסימון · ${dm} — לחיצה לסימון`, true)
          : glyph(dm, 'text.disabled', `מתוכנן · ${dm}`);
    }
  };

  // A cell that is not a session: a named holiday, or a hole in the month.
  const renderCell = (c) => {
    if (c.session) return cellFor(c.session);
    if (c.closed) return (
      <Tooltip title={`הגן סגור · ${c.closed} · ${dayMonth(c.date)}`}>
        <Typography variant="caption" noWrap sx={{
          color: 'info.main', fontWeight: 600, maxWidth: 76,
          display: 'inline-block', verticalAlign: 'middle',
        }}>{c.closed}</Typography>
      </Tooltip>
    );
    return (
      <Tooltip title={`אין מפגש ב-${dayMonth(c.missing)} — "מלא את החודש" ישלים`}>
        <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
      </Tooltip>
    );
  };

  const catOf = (p) => p.classroom_categories?.length
    ? p.classroom_categories.join(' + ') : (p.classroom_category || '');

  /**
   * The board is read group-first — "מה יש לבוגרים החודש" — so the rows sit
   * under a heading per קבוצה. A class that takes two groups together
   * ("תינוקייה + צעירים") is one meeting, not two: it gets a heading of its
   * own rather than a duplicate row under each group. Inside a group, the
   * week's order: Sunday's classes first.
   */
  const byDay = (a, b) =>
    ((a.default_day ?? 9) - (b.default_day ?? 9)) ||
    String(a.default_time || '').localeCompare(String(b.default_time || ''));
  const groups = (() => {
    const m = new Map();
    for (const p of programs) {
      const label = catOf(p) || 'ללא קבוצה';
      if (!m.has(label)) m.set(label, []);
      m.get(label).push(p);
    }
    // Section order follows the gan's own order of groups; a combined
    // section sits right after the first group it contains.
    const rank = (label) => {
      const i = CATEGORIES.indexOf(label.split(' + ')[0]);
      return (i < 0 ? 99 : i) + (label.includes(' + ') ? 0.5 : 0);
    };
    return [...m.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([label, list]) => ({ label, list: [...list].sort(byDay) }));
  })();

  if (isAllBranches) {
    return <Alert severity="info" sx={{ m: 2 }}>בחר/י סניף ספציפי (למעלה) כדי לנהל מעקב חוגים.</Alert>;
  }

  return (
    <Box dir="rtl">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>מעקב חוגים — {selectedBranchName}</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField size="small" type="month" label="חודש" value={month} onChange={e => setMonth(e.target.value)} InputLabelProps={{ shrink: true }} />
        <Button variant="outlined" startIcon={<PeopleIcon />} onClick={() => setProvidersOpen(true)}>ספקי גנים</Button>
        <Tooltip title="יוצר את כל המפגשים של החודש לפי היום הקבוע של כל חוג. בטוח ללחוץ שוב — מה שקיים לא משתנה.">
          <span>
            <Button variant="outlined" onClick={fillMonth} disabled={filling || programs.length === 0}>
              {filling ? 'ממלא…' : 'מלא את החודש'}
            </Button>
          </span>
        </Tooltip>
        <Button variant="contained" startIcon={<AddIcon />}
          onClick={() => { setProviderFocus('new'); setProvidersOpen(true); }}>
          חוג חדש
        </Button>
      </Stack>

      {/* Two rooms, one door each: the daily marking board, and accounting's
          money table. They used to share one scroll and bury each other. */}
      {accounting && (
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="track" label="מעקב חודשי" />
          <Tab value="pay" label={
            <Badge color="error" badgeContent={unpaidCount} sx={{ '& .MuiBadge-badge': { insetInlineEnd: -14, top: 2 } }}>
              תשלומים
            </Badge>
          } />
        </Tabs>
      )}

      {tab === 'pay' && accounting ? (
        <PaymentSummary data={summary} payments={payments} accounting={accounting}
          branch={selectedBranch} month={month} onPaymentsChanged={loadPayments} />
      ) : (
        <>
          {/* What needs a human first — gone the moment it is empty. */}
          {pending.length > 0 && (
            <Paper sx={{ p: 1.5, mb: 2, bgcolor: '#fff8e1', border: '1px solid', borderColor: 'warning.main' }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 700, color: 'warning.dark' }}>
                  {pending.length === 1 ? 'מפגש אחד ממתין לסימון' : `${pending.length} מפגשים ממתינים לסימון`}
                </Typography>
                {pending.map(s => (
                  <Chip key={s._id} size="small" variant="outlined" color="warning"
                    sx={{ fontWeight: 600, bgcolor: 'background.paper' }}
                    label={`${s.program_id?.name || 'חוג'} · ${dayMonth(s.date)}`}
                    onClick={(e) => setMenu({ anchorEl: e.currentTarget, session: s })} />
                ))}
              </Stack>
            </Paper>
          )}

          {loading ? (
            <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
          ) : programs.length === 0 ? (
            <Alert severity="info">
              אין חוגים בסניף זה עדיין. לחצ/י "חוג חדש" — מגדירים את הספק ואת כל הלוח
              השבועי שלו/ה במסך אחד, כולל תעריף שונה לכל סניף.
            </Alert>
          ) : (
            <Paper sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 520 + maxCols * 64 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ minWidth: 220 }}>חוג</TableCell>
                    {Array.from({ length: maxCols }, (_, i) => (
                      <TableCell key={i} align="center" sx={{ color: 'text.secondary' }}>שבוע {i + 1}</TableCell>
                    ))}
                    <TableCell align="left" sx={{ minWidth: 90 }}>לתשלום</TableCell>
                    <TableCell align="center" sx={{ width: 44 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {groups.map(({ label, list: progs }) => [
                    <TableRow key={`head-${label}`}>
                      <TableCell colSpan={maxCols + 3} sx={{ bgcolor: 'action.selected', py: 0.75 }}>
                        <Typography sx={{ fontWeight: 800 }}>{label}</Typography>
                      </TableCell>
                    </TableRow>,
                    ...progs.map(p => {
                    const pid = String(p._id);
                    const list = cellsByProgram.get(pid) || [];
                    const provider = p.provider_id && typeof p.provider_id === 'object' ? p.provider_id : null;
                    const vatMode = provider?.vat_mode || 'exempt';
                    const isOpen = !!openRows[pid];
                    const sub = [
                      provider && provider.name !== p.name ? provider.name : null,
                      p.instructor_name || null,
                      p.default_day != null ? `יום ${DAY_NAMES[p.default_day]}${p.default_time ? ` ${p.default_time}` : ''}` : (p.default_time || null),
                    ].filter(Boolean).join(' · ');
                    return [
                      <TableRow key={pid} hover sx={{ cursor: 'pointer', '& td': { borderBottom: isOpen ? 'none' : undefined } }}
                        onClick={() => toggleRow(pid)}>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <ColorDot color={progColor(p)} />
                            <Box>
                              <Typography sx={{ fontWeight: 700, lineHeight: 1.2 }}>{p.name}</Typography>
                              {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
                            </Box>
                          </Stack>
                        </TableCell>
                        {list.length === 0 ? (
                          <TableCell colSpan={maxCols} align="center">
                            <Typography variant="caption" color="text.secondary">אין מפגשים החודש — "מלא את החודש" או פתח/י את השורה</Typography>
                          </TableCell>
                        ) : (
                          Array.from({ length: maxCols }, (_, i) => (
                            <TableCell key={i} align="center" sx={{ p: 0.5 }}>
                              {list[i] ? renderCell(list[i]) : ''}
                            </TableCell>
                          ))
                        )}
                        <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(amountOf(pid))}</TableCell>
                        <TableCell align="center" sx={{ p: 0 }}>
                          <ExpandMoreIcon fontSize="small" sx={{
                            color: 'text.secondary', verticalAlign: 'middle',
                            transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
                          }} />
                        </TableCell>
                      </TableRow>,
                      <TableRow key={`${pid}-detail`}>
                        <TableCell colSpan={maxCols + 3} sx={{ p: 0, border: 0 }}>
                          <Collapse in={isOpen} timeout="auto" unmountOnExit>
                            <Box sx={{ px: 2, py: 1.5, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider' }}>
                              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                                {provider && (
                                  <Chip size="small" variant="outlined"
                                    color={vatMode === 'registered' ? 'warning' : 'default'}
                                    label={vatMode === 'registered' ? 'עוסק מורשה + מע״מ' : 'עוסק פטור'} />
                                )}
                                <Chip size="small" variant="outlined" label={rateLabel(p.default_rate, vatMode)} />
                                <Box sx={{ flex: 1 }} />
                                <Tooltip title="עריכה במסך הספק — שם, סניפים, ימים ותעריפים, הכול יחד">
                                  <Button size="small" startIcon={<EditIcon />} onClick={() => {
                                    setProviderFocus(String(provider?._id || ''));
                                    setProvidersOpen(true);
                                  }}>עריכה</Button>
                                </Tooltip>
                                <Button size="small" color="error" startIcon={<DeleteIcon />}
                                  onClick={() => delProgram(p)}>הסרת חוג</Button>
                              </Stack>
                              <ProgramSessions program={p} month={month} vatMode={vatMode}
                                version={refreshKey} onChanged={refreshAll} />
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>,
                    ];
                  }),
                  ])}
                </TableBody>
              </Table>
            </Paper>
          )}

          {programs.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              <Box component="span" sx={{ color: 'success.main', fontWeight: 700 }}>✓</Box> התקיים ·{' '}
              <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>✗</Box> לא הגיע ·{' '}
              <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>◐</Box> חלקית ·{' '}
              <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>←</Box> נדחה ·{' '}
              <Box component="span" sx={{ color: 'warning.main', fontWeight: 800 }}>?</Box> ממתין לסימון ·{' '}
              תאריך אפור — מפגש עתידי · שם בכחול — הגן סגור (חופשה) · — אין מפגש.
              לחיצה על סימן פותחת סימון; לחיצה על שורה פותחת את כל המפגשים.
            </Typography>
          )}
        </>
      )}

      <Menu anchorEl={menu?.anchorEl} open={!!menu} onClose={closeMenu}>
        {menu && (
          <Typography variant="caption" sx={{ px: 2, py: 0.5, display: 'block', color: 'text.secondary' }}>
            {menu.session.program_id?.name || 'חוג'} · {dayMonth(menu.session.date)}
          </Typography>
        )}
        {menu && menu.session.status !== 'occurred' && (
          <MenuItem onClick={() => mark(menu.session, true)}>
            <Box component="span" sx={{ color: 'success.main', fontWeight: 700, ml: 1 }}>✓</Box> הגיע/ה
          </MenuItem>
        )}
        {menu && menu.session.status !== 'no_show' && menu.session.status !== 'postponed' && (
          <MenuItem onClick={() => mark(menu.session, false)}>
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, ml: 1 }}>✗</Box> לא הגיע/ה
          </MenuItem>
        )}
        <Divider />
        {menu && (
          <MenuItem sx={{ color: 'error.main' }} onClick={() => delSession(menu.session)}>
            <DeleteIcon fontSize="small" sx={{ ml: 1 }} /> מחק מפגש
          </MenuItem>
        )}
      </Menu>

      <ProvidersDialog
        open={providersOpen}
        focus={providerFocus}
        onClose={() => { setProvidersOpen(false); setProviderFocus(''); refreshAll(); }}
      />
    </Box>
  );
}
