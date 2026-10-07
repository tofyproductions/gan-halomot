import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, IconButton,
  Chip, Table, TableHead, TableBody, TableRow, TableCell, Accordion,
  AccordionSummary, AccordionDetails, Dialog, DialogTitle, DialogContent,
  DialogActions, Tooltip, Divider, Alert, CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PeopleIcon from '@mui/icons-material/People';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';
import ProvidersDialog from './ProvidersDialog';

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
function PaymentSummary({ data }) {
  // The fetch moved up to the page: the provider rows below the summary show
  // the same monthly totals in their headers, and two fetches of one figure
  // is two figures.
  const [open, setOpen] = useState(false);

  if (!data || !(data.providers || []).length) return null;

  /**
   * The accountant's table, open by default: one line per provider with what
   * is counted, whether VAT is added, and the figure that leaves the bank.
   * The per-group rows underneath stay behind "פירוט" — they are for the
   * month somebody questions, not for every glance.
   */
  const meetingsOf = (p) => p.programs.reduce((t, g) => t + (g.occurred || 0), 0);
  const partialsOf = (p) => p.programs.reduce((t, g) => t + (g.partial || 0), 0);
  const pendingOf = (p) => p.programs.reduce((t, g) => t + (g.scheduled || 0), 0);
  const totalPending = data.providers.reduce((t, p) => t + pendingOf(p), 0);

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography sx={{ fontWeight: 700 }}>סיכום להנהלת חשבונות — לתשלום בחודש זה</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontWeight: 700 }}>{ils(data.grand_total)}</Typography>
        <Button size="small" onClick={() => setOpen(o => !o)}>{open ? 'סגור פירוט' : 'פירוט לפי קבוצה'}</Button>
      </Stack>

      <Box sx={{ overflowX: 'auto', mt: 1.5 }}>
        <Table size="small" sx={{ minWidth: 640 }}>
          <TableHead><TableRow>
            <TableCell>ספק / חוג</TableCell>
            <TableCell>מעמד</TableCell>
            <TableCell align="center">התקיימו</TableCell>
            <TableCell align="center">טרם סומנו</TableCell>
            <TableCell align="left">לפני מע״מ</TableCell>
            <TableCell align="left">מע״מ</TableCell>
            <TableCell align="left">לתשלום</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {data.providers.map(p => (
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
              </TableRow>
            ))}
            <TableRow>
              <TableCell colSpan={4} sx={{ fontWeight: 700 }}>סה״כ</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(data.grand_subtotal)}</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{data.grand_vat ? ils(data.grand_vat) : '—'}</TableCell>
              <TableCell align="left" sx={{ fontWeight: 700 }}>{ils(data.grand_total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Box>
      {totalPending > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {totalPending} מפגשים עדיין מסומנים "מתוכנן" ואינם נספרים לתשלום עד שמסמנים אם המדריכה הגיעה.
        </Typography>
      )}

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
function ProgramSessions({ program, month, vatMode, onChanged }) {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState([]);
  const [newDate, setNewDate] = useState('');
  const load = useCallback(() => {
    api.get('/classes/sessions', { params: { program_id: program._id, month } })
      .then(r => setSessions(r.data.sessions || [])).catch(() => setSessions([]));
  }, [program._id, month]);
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
  const confirm = useConfirm();
  const [month, setMonth] = useState(thisMonth());
  const [programs, setPrograms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  // Which provider the one screen opens on. '' = the list, 'new' = the add form.
  const [providerFocus, setProviderFocus] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setPrograms([]); return; }
    setLoading(true);
    // Providers are no longer fetched here: the one screen that edits them
    // loads its own list. Two components holding the same list is two lists
    // that drift.
    api.get('/classes/programs', { params: { branch: selectedBranch, active: 'true' } })
      .then(pr => setPrograms(pr.data.programs || []))
      .catch(() => {}).finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);
  useEffect(() => { load(); }, [load, refreshKey]);

  /**
   * The month's payment summary, fetched once for the whole page: the
   * accountant's table at the top and the total on each provider's row are
   * the same figures, so they must come from the same answer.
   */
  const [summary, setSummary] = useState(null);
  const loadSummary = useCallback(() => {
    if (isAllBranches || !selectedBranch) { setSummary(null); return; }
    api.get('/classes/payment-summary', { params: { branch: selectedBranch, month } })
      .then(r => setSummary(r.data)).catch(() => setSummary(null));
  }, [selectedBranch, isAllBranches, month]);
  useEffect(() => { loadSummary(); }, [loadSummary, refreshKey]);

  /**
   * One row per provider, not per program.
   *
   * ליטף with two Wednesday groups and תנועלולה with צעירים ובוגרים used to
   * be four rows that looked like four different arrangements. The invoice is
   * per provider — the summary above already says so — so the list now says
   * the same: one row with the month's total, and each group laid out inside.
   */
  const providerGroups = (() => {
    const m = new Map();
    for (const p of programs) {
      const key = String(p.provider_id?._id || p.provider_id || `name:${p.instructor_name || p.name}`);
      if (!m.has(key)) {
        m.set(key, {
          key,
          provider: p.provider_id && typeof p.provider_id === 'object' ? p.provider_id : null,
          programs: [],
        });
      }
      m.get(key).programs.push(p);
    }
    return [...m.values()];
  })();

  // The provider's monthly line from the summary — total incl. VAT, retainer info.
  const summaryOf = (g) => (summary?.providers || []).find(sp =>
    g.provider
      ? (sp.provider_id && String(sp.provider_id) === String(g.provider._id))
      : (!sp.provider_id && sp.provider_name === (g.programs[0]?.instructor_name || 'ללא ספק'))
  ) || null;

  /**
   * Write this month's meetings from each class's fixed day.
   *
   * A nightly job does the same thing, so this button is for impatience and
   * for the month somebody sets up on the 3rd — not the only way it happens.
   * Pressing it twice is harmless: a date that already has a session is left
   * exactly as it is, answered or not.
   */
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
        // "ראש השנה — 13.9" rather than a gap that looks like a mistake.
        if (closed.length) {
          const names = [...new Set(closed.map(c => c.name))].join(', ');
          toast.info(`דולגו ${closed.length} ימים שהגן סגור: ${names}`);
        }
        setRefreshKey(k => k + 1);
      })
      .catch(err => toast.error(apiError(err, 'המילוי נכשל')))
      .finally(() => setFilling(false));
  };

  const delProgram = async (p) => {
    if (!(await confirm({ title: 'הסרת חוג', message: `להסיר את "${p.name}"?` }))) return;
    api.delete(`/classes/programs/${p._id}`).then(() => load()).catch(err => toast.error(apiError(err, 'המחיקה נכשלה')));
  };

  if (isAllBranches) {
    return <Alert severity="info" sx={{ m: 2 }}>בחר/י סניף ספציפי (למעלה) כדי לנהל מעקב חוגים.</Alert>;
  }

  return (
    <Box dir="rtl">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
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

      <PaymentSummary data={summary} />

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>
      ) : programs.length === 0 ? (
        <Alert severity="info">
          אין חוגים בסניף זה עדיין. לחצ/י "חוג חדש" — מגדירים את הספק ואת כל הלוח
          השבועי שלו/ה במסך אחד, כולל תעריף שונה לכל סניף.
        </Alert>
      ) : (
        providerGroups.map(g => {
          const vatMode = g.provider?.vat_mode || 'exempt';
          const ps = summaryOf(g);
          const single = g.programs.length === 1;
          const first = g.programs[0];
          const catOf = (p) => p.classroom_categories?.length
            ? p.classroom_categories.join(' + ') : (p.classroom_category || '');
          return (
            <Accordion key={g.key} defaultExpanded={providerGroups.length <= 3} sx={{ mb: 1 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ width: '100%' }}>
                  {single && <ColorDot color={progColor(first)} />}
                  <Typography sx={{ fontWeight: 700 }}>{g.provider?.name || first.name}</Typography>
                  {g.provider && (
                    <Chip size="small" variant="outlined"
                      color={vatMode === 'registered' ? 'warning' : 'default'}
                      label={vatMode === 'registered' ? 'עוסק מורשה + מע״מ' : 'עוסק פטור'} />
                  )}
                  {single ? (
                    <>
                      {first.instructor_name && <Chip size="small" label={first.instructor_name} />}
                      {/* "תינוקייה + צעירים" when they sit together — one meeting. */}
                      {catOf(first) && <Chip size="small" sx={boldChip(progColor(first))} label={catOf(first)} />}
                      {first.default_day != null && <Chip size="small" sx={boldChip(progColor(first))}
                        label={`יום ${DAY_NAMES[first.default_day]}`} />}
                      {first.default_time && <Chip size="small" sx={boldChip(progColor(first))} label={first.default_time} />}
                      <Chip size="small" variant="outlined" label={rateLabel(first.default_rate, vatMode)} />
                    </>
                  ) : (
                    <>
                      <Chip size="small" variant="outlined" label={`${g.programs.length} קבוצות`} />
                      {/* One dot per group — the same colors waiting inside. */}
                      {g.programs.map(p => <ColorDot key={p._id} color={progColor(p)} />)}
                    </>
                  )}
                  <Box sx={{ flex: 1 }} />
                  {/* The month's figure, same one as the accountant's table above. */}
                  <Chip size="small" color={ps?.total ? 'success' : 'default'}
                    variant={ps?.total ? 'filled' : 'outlined'} sx={{ fontWeight: 700 }}
                    label={`לתשלום החודש: ${ils(ps?.total || 0)}`} />
                  <Tooltip title="עריכה במסך הספק — שם, סניפים, ימים ותעריפים, הכול יחד">
                    <IconButton size="small" onClick={(e) => {
                      e.stopPropagation();
                      setProviderFocus(String(g.provider?._id || ''));
                      setProvidersOpen(true);
                    }}><EditIcon fontSize="small" /></IconButton>
                  </Tooltip>
                  {single && (
                    <IconButton size="small" color="error"
                      onClick={(e) => { e.stopPropagation(); delProgram(first); }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                {g.programs.map((p, i) => (
                  <Box key={p._id}
                    sx={single ? {} : { borderInlineStart: `4px solid ${progColor(p)}`, paddingInlineStart: 1.5, mt: i > 0 ? 2 : 0 }}>
                    {!single && (
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
                        <ColorDot color={progColor(p)} />
                        <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
                        {p.instructor_name && <Chip size="small" label={p.instructor_name} />}
                        {catOf(p) && <Chip size="small" sx={boldChip(progColor(p))} label={catOf(p)} />}
                        {p.default_day != null && <Chip size="small" sx={boldChip(progColor(p))}
                          label={`יום ${DAY_NAMES[p.default_day]}`} />}
                        {p.default_time && <Chip size="small" sx={boldChip(progColor(p))} label={p.default_time} />}
                        <Chip size="small" variant="outlined" label={rateLabel(p.default_rate, vatMode)} />
                        <Box sx={{ flex: 1 }} />
                        <IconButton size="small" color="error" onClick={() => delProgram(p)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    )}
                    <ProgramSessions program={p} month={month} vatMode={vatMode} onChanged={loadSummary} />
                  </Box>
                ))}
              </AccordionDetails>
            </Accordion>
          );
        })
      )}

      <ProvidersDialog
        open={providersOpen}
        focus={providerFocus}
        onClose={() => { setProvidersOpen(false); setProviderFocus(''); setRefreshKey(k => k + 1); }}
      />
    </Box>
  );
}
