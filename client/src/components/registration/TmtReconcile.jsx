import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Card, Stack, Chip, Button, TextField, InputAdornment, MenuItem,
  Table, TableHead, TableBody, TableRow, TableCell, Dialog, DialogTitle, DialogContent,
  DialogActions, Alert, AlertTitle, CircularProgress, Tooltip, IconButton, Divider,
  ToggleButton, ToggleButtonGroup, List, ListItem, ListItemText, Popover,
  TableContainer,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import HistoryIcon from '@mui/icons-material/History';
import UndoIcon from '@mui/icons-material/Undo';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import CheckIcon from '@mui/icons-material/Check';
import ReplayIcon from '@mui/icons-material/Replay';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import { toast } from 'react-toastify';
import api from '../../api/client';
import StatBoard from '../ui/StatBoard';
import { formatAcademicYear, getEnrollmentYear } from '../../hooks/useAcademicYear';
import DebtDocumentsDialog from './DebtDocumentsDialog';

/**
 * הצלבת תמ"ת מול קליקטאק.
 *
 * A child enrolls in a ministry-supervised מעון only if BOTH are true: משרד
 * התמ"ת approved them for this gan, and the family completed the registration
 * in ClickTac. The two systems never speak to each other, so every July
 * somebody compares two spreadsheets by hand and decides who is in, who has to
 * be called, and whose place goes to the next family in line.
 *
 * This screen is that comparison. It shows the conclusion per child, the
 * anomalies behind it, and what moved since the last file was uploaded —
 * because both lists are republished through the summer and the question is
 * always "what changed", not "what does it say".
 */

const VERDICT_STYLE = {
  approved: { color: 'success', short: 'מאושר/ת' },
  missing_registration: { color: 'error', short: 'לא נרשם אצלנו' },
  missing_approval: { color: 'error', short: 'אין אישור תמ"ת' },
  cancelled: { color: 'warning', short: 'ביטל/ה רישום' },
  withdrawn: { color: 'error', short: 'הוסר/ה מרשימת תמ״ת' },
  not_approved: { color: 'error', short: 'תמ"ת לא אישר' },
  private: { color: 'secondary', short: 'בגן ללא תמ"ת' },
  gone: { color: 'default', short: 'הוסר/ה מכל הרשימות' },
};

/**
 * מאזן — the child's account in ClickTac, one cell.
 *
 * Signed as the vendor signs it: below zero the family owes, above zero the
 * gan does. Red and bold only for a debt; a credit is green; zero is grey and
 * says so, because "—" would read as "the file had no column", which is the
 * other case and is drawn as "—".
 */
function BalanceCell({ balance, family }) {
  if (balance == null) return <Typography variant="caption" color="text.disabled">—</Typography>;
  const owes = balance < 0;
  const credit = balance > 0;
  // The word and the figure are two things: "חוב 1,410 ₪" in one cell means a
  // column of balances never aligns on its digits. The label carries the sense,
  // the number carries the comparison.
  const word = owes ? 'חוב' : credit ? 'זכות' : '';
  const text = owes ? fmtMoney(-balance) : credit ? fmtMoney(balance) : '0 ₪';
  const tip = family != null && family !== balance
    ? `מאזן משפחתי (כולל אחים): ${family < 0 ? `חוב ${fmtMoney(-family)}` : fmtMoney(family)}` : '';
  return (
    <Tooltip title={tip}>
      <Typography variant="body2" component="span" sx={{ ...NOWRAP, display: 'inline-flex', alignItems: 'baseline', gap: 0.5 }}
        color={owes ? 'error.main' : credit ? 'success.main' : 'text.secondary'}
        fontWeight={owes ? 700 : 400}>
        {word && (
          <Box component="span" sx={{ fontSize: '0.6875rem', fontWeight: 500, opacity: 0.75 }}>{word}</Box>
        )}
        <Box component="span" className="num">{text}</Box>
      </Typography>
    </Tooltip>
  );
}

/**
 * חריגה = צבע. ONE COLOUR PER KIND OF FINDING, served by the server with the
 * finding itself (see ISSUES in enrollment-reconcile.service) — the chip below
 * only paints it. The severity used to pick the colour, and three different
 * remarks in one blue on one row read as one remark. `urgent` is the one the
 * owner wants shouted, and it is filled where every other chip is outlined.
 */
function IssueChip({ issue, sx }) {
  const color = issue.color || '#757575';
  const filled = !!issue.urgent;
  // A finding a person closed and a later file reopened: dashed, with the
  // date it was closed in the tooltip (the server puts it in the detail).
  const reopened = !!issue.changed_since_resolved;
  return (
    <Tooltip title={issue.detail || ''}>
      <Chip size="small" variant={filled ? 'filled' : 'outlined'}
        icon={reopened ? <ReplayIcon sx={{ fontSize: 14, color: `${color} !important` }} /> : undefined}
        label={filled ? `${issue.label} — דחוף` : issue.label}
        sx={{
          ...TIGHT_CHIP,
          ...(filled
            ? { bgcolor: color, color: '#fff', fontWeight: 700 }
            : { borderColor: color, color, fontWeight: issue.severity === 'note' ? 400 : 600 }),
          ...(reopened ? { borderStyle: 'dashed', borderWidth: 2 } : {}),
          ...sx,
        }} />
    </Tooltip>
  );
}

/**
 * What a person can say about one finding, in one row of buttons.
 *
 * Names get the real choice — whose spelling is right — because the choice
 * is what the child is then called everywhere. Everything else is "I looked,
 * it is fine": the finding is hidden until a later file moves the values.
 */
const RESOLVE_OPTIONS = {
  name_mismatch: [['tmt', 'השם לפי תמ"ת'], ['clicktac', 'השם לפי קליקטאק'], ['ok', 'שני השמות בסדר']],
  name_partial: [['tmt', 'השם לפי תמ"ת'], ['clicktac', 'השם לפי קליקטאק'], ['ok', 'שני השמות בסדר']],
  tmt_contact_unknown: [['ok', 'הטלפונים בקליקטאק נכונים']],
  id_mismatch: [['ok', 'בדקתי — אותו ילד/ה']],
  birth_date_mismatch: [['ok', 'בדקתי — תקין']],
  age_group_mismatch: [['ok', 'טופל — השכבה תוקנה']],
};
const DEFAULT_RESOLVE = [['ok', 'בדקתי — תקין']];

/**
 * אמצעי התשלום — צבע לכל שיטה.
 *
 * ONE COLOUR PER METHOD, AND THE EYE DOES THE READING. Sixty rows of Hebrew
 * free text in a narrow column are not something anybody reads; a column of
 * colours is. Green is the method the gan wants (הוראת קבע), blue and teal are
 * methods it accepts without a word (אשראי, העברה בנקאית), orange is the one
 * it accepts and would rather not (צ'ק), and red is the two that stop the
 * money — מזומן, which is refused, and a family that never chose at all, which
 * is drawn as an outline because there is nothing there rather than something
 * wrong. Grey is a label the vendor invented since this was written.
 *
 * `variant` is part of the encoding, not decoration: the two reds have to be
 * told apart at a glance, and so do "the office decided nothing" and "the
 * family decided nothing".
 */
const METHOD_STYLE = {
  standing_order: { color: 'success', variant: 'filled' },
  credit_card: { color: 'primary', variant: 'filled' },
  bank_transfer: { color: 'info', variant: 'filled' },
  cheque: { color: 'warning', variant: 'filled' },
  cash: { color: 'error', variant: 'filled' },
  none: { color: 'error', variant: 'outlined' },
  other: { color: 'default', variant: 'outlined' },
};

/**
 * The legend under the cards — the same order the chips are ranked in.
 *
 * `other` is labelled by what it MEANS rather than by "אחר", because no chip in
 * the table ever says "אחר": an unrecognised method keeps the vendor's own text
 * as its label (see classifyPaymentMethod), so a legend entry reading "אחר"
 * describes a chip nobody can find. The grey chips are the file's own words.
 */
const METHOD_LEGEND = [
  ['standing_order', 'הוראת קבע'],
  ['credit_card', 'כרטיס אשראי'],
  ['bank_transfer', 'העברה בנקאית'],
  ['cheque', "צ'ק"],
  ['cash', 'מזומן'],
  ['none', 'לא הוגדר'],
  ['other', 'אחר (טקסט מהקובץ)'],
];

/** The three groups a child can be placed in. The state's brackets, our rooms. */
const AGE_GROUPS = ['תינוק', 'פעוט', 'בוגר'];

const fmtMoney = (n) => `${Number(n || 0).toLocaleString('he-IL')} ₪`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('he-IL') : '—');

/**
 * הגיל בשתי צורות — אחת לעמודה, אחת ל־tooltip.
 *
 * "שנתיים ו-4 חודשים (28 חודשים)" is the right sentence and the wrong cell: at
 * 1440px it wrapped to four lines and pushed every row in the table to four
 * lines with it, which is what made the screen unreadable once the contract
 * columns arrived. The cell gets "2 ש׳ 4 ח׳" — same information, one line —
 * and the sentence stays one hover away.
 */
const compactAge = (a) => {
  if (!a) return '—';
  if (!a.years) return `${a.months} ח׳`;
  return a.months_remainder ? `${a.years} ש׳ ${a.months_remainder} ח׳` : `${a.years} ש׳`;
};

/** Every cell that must never wrap: identity and numbers, which are read across. */
const NOWRAP = { whiteSpace: 'nowrap' };

/** Chips inside a one-line row — the table's own size, not MUI's. */
const TIGHT_CHIP = { height: 20, fontSize: '0.7rem' };

/** הו"ק — קיימת או חסרה, ולעולם לא פרטי הבנק. See paymentTermsFor on the server. */
const SO_LABEL = { complete: 'קיימת', missing: 'חסרה' };

/**
 * תנאי התשלום כטקסט — the same block in the row's tooltip and in the dialog.
 *
 * Returned as lines rather than as JSX so the tooltip and the card can each
 * lay it out their own way: the tooltip wants it dense, the dialog wants it
 * spaced. The bank fields are not here because they never left the server.
 */
function paymentTermLines(terms) {
  if (!terms) return [];
  // Defensive: the server already stores only the last 4 digits, but this
  // truncates again so a full card number never renders even if that ever
  // regresses upstream.
  const card = (v) => {
    const digits = String(v || '').replace(/\D/g, '').slice(-4);
    return digits ? ` · כרטיס ****${digits}` : '';
  };
  const lines = [
    `שכ"ל: ${terms.tuition_method || 'לא נרשם'}${card(terms.tuition_card_last4)}`,
  ];
  // הקובץ אומר "דמי רישום" רק כשיש שיטת תשלום לצידה — אחרת "סכום בקובץ" הוא
  // סתם עמודת סכום כללית שאין שום דבר שמייחס אותה לדמי רישום, ולכן היא
  // מוצגת כשורה נפרדת ומשלה, ולא כחלק מהמשפט על דמי הרישום.
  if (terms.registration_fee_method) {
    lines.push([
      `דמי רישום: ${terms.registration_fee_method}`,
      terms.receipt_number ? `קבלה ${terms.receipt_number}` : '',
    ].filter(Boolean).join(' · '));
  }
  if (terms.amount_in_file) {
    lines.push(`סכום בקובץ: ${fmtMoney(terms.amount_in_file)}`);
  }
  if (terms.standing_order_status) {
    lines.push(`הו"ק: ${SO_LABEL[terms.standing_order_status] || terms.standing_order_status}`);
  }
  if (terms.voucher_number) lines.push(`שובר: ${terms.voucher_number}`);
  lines.push(`${terms.continuing ? 'ילד/ה ממשיך/ה' : 'רישום חדש'}`
    + (terms.second_signer ? ` · חותם שני: ${terms.second_signer}` : ''));
  return lines;
}

/** שני הייצואים של קליקטאק, בשם שהמשרד קורא להם. */
const SOURCE_LABEL = { registrations: 'נרשמים', contracts: 'חוזים' };

/** The counts behind one upload, on one line. */
function ImportLine({ imp }) {
  const other = imp.details?.other_institution?.length || 0;
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      {imp.file_name} · {imp.parsed} שורות · חדשים {imp.created} · עודכנו {imp.updated} ·
      {' '}ללא שינוי {imp.unchanged} · הוסרו {imp.missing}
      {/* Rows of another מעון the file carried and this branch did not take. */}
      {other ? ` · מעון אחר ${other}` : ''}
      {imp.imported_by_name ? ` · ${imp.imported_by_name}` : ''}
    </Typography>
  );
}

/**
 * `embedded` — rendered inside רישום לאמונה, which owns the branch, the year
 * and both uploads. The screen then drops its own copies of those controls.
 */
export default function TmtReconcile({
  branchId: propBranch, year: propYear, embedded = false, reloadKey = 0,
  // Acting is a narrower grant than seeing — the page above works them out and
  // the server enforces the same split.
  canImport = true, canPlace = true,
} = {}) {
  // The intake year — fixed, never picked. See getEnrollmentYear().
  const year = embedded ? propYear : getEnrollmentYear();
  const [branches, setBranches] = useState([]);
  const [ownBranchId, setOwnBranchId] = useState(localStorage.getItem('selectedBranch') || '');
  const branchId = embedded ? propBranch : ownBranchId;
  const setBranchId = setOwnBranchId;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
  /**
   * "Show me only the children with a contract and no family."
   *
   * Kept apart from `issueFilter` on purpose: the issues are the ministry's
   * anomalies, computed from comparing the two LISTS. This is a statement
   * about which FILES have been uploaded, and it would read as a data problem
   * with the child if it sat among them.
   */
  const [missingParentsOnly, setMissingParentsOnly] = useState(false);
  /**
   * "Show me only the families whose payment method needs handling."
   *
   * Alongside `missingParentsOnly` and for the same reason: מזומן, לא הוגדר
   * and הו"ק ללא בנק are facts about how the family pays, not anomalies in the
   * ministry's comparison, and filing them among the issues would read as a
   * problem with the child's record.
   */
  const [paymentAlertOnly, setPaymentAlertOnly] = useState(false);
  /**
   * "Show me the families paying by cheque."
   *
   * Its own filter and not part of the one above, because it is not the same
   * errand. The alert list is phone calls that have to happen before September;
   * this is a list somebody works through when there is time, to move families
   * onto a standing order. Merging them would bury the urgent half.
   */
  const [chequeOnly, setChequeOnly] = useState(false);
  /**
   * "Show me the children who left every list."
   *
   * Not a filter over the table — a different table. A child gone from the
   * ministry's list AND from both ClickTac exports is not a finding anybody
   * acts on, so the server keeps those rows apart (`archived`) and the screen
   * shows one set or the other, never both mixed.
   */
  const [showArchived, setShowArchived] = useState(false);
  /** "Show me the families who owe money in ClickTac." A fact, not a finding. */
  const [balanceDueOnly, setBalanceDueOnly] = useState(false);

  const [uploadDlg, setUploadDlg] = useState({ open: false, file: null, saving: false, result: null });
  /**
   * The open card is the ROW ID, not the row: every decision saved from the
   * card reloads the comparison, and the card has to show the reloaded row
   * rather than the one it was opened with.
   */
  const [detailId, setDetailId] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [parentsDraft, setParentsDraft] = useState(null);   // { parent1: {name, phone}, parent2 } while editing
  const [privateReason, setPrivateReason] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [applyDlg, setApplyDlg] = useState({ open: false, saving: false, result: null, error: null });
  const [historyDlg, setHistoryDlg] = useState({ open: false, loading: false, imports: [] });
  /**
   * "קבצים אחרונים" — hidden until asked for.
   *
   * This used to be two full-width Cards sitting above the table on every
   * load: file names, four counts each, every warning spelled out — for a
   * fact the office checks once in a while, not every time the screen opens.
   * A small button now opens the same information as a Popover; closed, it
   * costs one line.
   */
  const [filesAnchor, setFilesAnchor] = useState(null);
  /**
   * שליחת בדיקה לעינת — a REAL SMS and REAL email, on demand.
   *
   * The provider credentials (SMS4Free, GAS/Resend/SMTP) live only on this
   * server, so this is the one way to prove either alert actually arrives.
   * `force: true` on the server side, always — a test that silently no-ops
   * because "this month is already sent" would not have told anyone anything.
   */
  const [testAlertsDlg, setTestAlertsDlg] = useState({ open: false, sending: false, result: null, error: null });
  const [undoDlg, setUndoDlg] = useState({ open: false, imp: null, saving: false, result: null, error: null });
  const [contactsDlg, setContactsDlg] = useState({ open: false, loading: false, rows: [] });
  const [saving, setSaving] = useState({});

  useEffect(() => {
    if (embedded) return;   // the page above already chose the branch
    api.get('/branches')
      .then(res => {
        const all = res.data.branches || [];
        // קפלן is not under the ministry — it registers directly with us and
        // has no approval list, so it is not offered here at all.
        const supervised = all.filter(b => (b.tmt_supervised ?? !/קפלן/.test(b.name || '')));
        setBranches(supervised);
        if (!branchId && supervised.length) setBranchId(supervised[0].id || supervised[0]._id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded]);

  const fetchData = useCallback(() => {
    if (!branchId || !year) return;
    setLoading(true);
    setError('');
    api.get('/tmt/reconcile', { params: { branch: branchId, year } })
      .then(res => setData(res.data))
      .catch(err => {
        setData(null);
        setError(err.response?.data?.error || 'שגיאה בטעינת ההצלבה');
      })
      .finally(() => setLoading(false));
    // reloadKey: the page above uploaded a file or undid one.
  }, [branchId, year, reloadKey]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rows = useMemo(
    () => (showArchived ? (data?.archived || []) : (data?.rows || [])),
    [data, showArchived],
  );
  const summary = data?.summary || {};
  const issueDict = data?.dictionaries?.issues || {};
  const detail = useMemo(() => {
    if (!detailId || !data) return null;
    return [...(data.rows || []), ...(data.archived || [])].find(r => r.id_number === detailId) || null;
  }, [data, detailId]);
  const openDetail = (r) => {
    setDetailId(r.id_number);
    setNoteDraft(r.decision?.note || '');
    setParentsDraft(null);
    setPrivateReason(r.decision?.verdict_override?.reason || '');
  };

  const visible = useMemo(() => rows.filter(r => {
    if (verdictFilter && r.verdict !== verdictFilter) return false;
    if (issueFilter && !r.issues.some(i => i.code === issueFilter)) return false;
    if (missingParentsOnly && !r.clicktac?.missing_parents) return false;
    if (balanceDueOnly && !(typeof r.clicktac?.balance === 'number' && r.clicktac.balance < 0)) return false;
    // Errors only — the card counts errors only, and a filter that shows more
    // rows than the number on the card it sits under is a bug the office
    // reports as "the screen is lying".
    if (paymentAlertOnly && r.clicktac?.payment_alert?.severity !== 'error') return false;
    if (chequeOnly && r.clicktac?.payment_method_kind?.kind !== 'cheque') return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.child_name.toLowerCase().includes(q) || String(r.id_number).includes(q);
  }), [rows, verdictFilter, issueFilter, missingParentsOnly, balanceDueOnly, paymentAlertOnly, chequeOnly, search]);

  /* ---- החלטות — what the card lets a person say about a child ---- */
  const decisionCall = async (fn, okMessage) => {
    setDeciding(true);
    try {
      await fn();
      if (okMessage) toast.success(okMessage);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירת ההחלטה');
    } finally {
      setDeciding(false);
    }
  };
  const scope = { branch_id: branchId, academic_year: year };
  // The child whose attached papers are open — the same dialog the חייבים
  // table uses, on the same record.
  const [docsRow, setDocsRow] = useState(null);
  const saveNote = (row) => decisionCall(
    () => api.put(`/tmt/decisions/${row.id_number}`, { ...scope, note: noteDraft }),
    'ההערה נשמרה',
  );
  const setPrivate = (row, on) => decisionCall(
    () => api.put(`/tmt/decisions/${row.id_number}`, {
      ...scope, verdict_override: on ? { kind: 'private', reason: privateReason } : null,
    }),
    on ? `${row.child_name} — מסומן/ת כילד/ה בגן ללא תמ"ת` : 'הסימון בוטל',
  );
  const saveParents = (row) => decisionCall(
    () => api.put(`/tmt/decisions/${row.id_number}`, { ...scope, parent_overrides: parentsDraft }),
    'פרטי ההורים עודכנו — זכרו לתקן גם בקליקטאק',
  ).then(() => setParentsDraft(null));
  const clearParents = (row) => decisionCall(
    () => api.put(`/tmt/decisions/${row.id_number}`, { ...scope, parent_overrides: null }),
    'התיקון בוטל — חוזרים לפרטים מהקובץ',
  );
  const resolve = (row, code, choice) => decisionCall(
    () => api.post(`/tmt/decisions/${row.id_number}/resolve`, { ...scope, code, choice }),
    'החריגה נסגרה',
  );
  const sendTestAlerts = async () => {
    setTestAlertsDlg(d => ({ ...d, sending: true, error: null }));
    try {
      const res = await api.post('/tmt/alerts/test');
      setTestAlertsDlg(d => ({ ...d, sending: false, result: res.data }));
    } catch (err) {
      setTestAlertsDlg(d => ({ ...d, sending: false, error: err.response?.data?.error || 'שגיאה בשליחה' }));
    }
  };

  const reopen = (row, code) => decisionCall(
    () => api.delete(`/tmt/decisions/${row.id_number}/resolve/${code}`, { params: { branch: branchId, year } }),
    'החריגה נפתחה מחדש',
  );

  const handleUpload = async () => {
    if (!uploadDlg.file) return toast.error('יש לבחור קובץ');
    if (!branchId) return toast.error('יש לבחור סניף');
    setUploadDlg(d => ({ ...d, saving: true, result: null }));
    try {
      const form = new FormData();
      form.append('file', uploadDlg.file);
      form.append('branch_id', branchId);
      form.append('academic_year', year);
      const res = await api.post('/tmt/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setUploadDlg(d => ({ ...d, saving: false, result: res.data }));
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error
        || `שגיאה בקליטת הקובץ (${err.response?.status || 'אין תגובה מהשרת'})`);
      setUploadDlg(d => ({ ...d, saving: false }));
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/tmt/reconcile/export', {
        params: { branch: branchId, year }, responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `הצלבת תמת ${data?.branch_name || ''} ${year}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('שגיאה בייצוא');
    }
  };

  const openHistory = async () => {
    setHistoryDlg({ open: true, loading: true, imports: [] });
    try {
      const res = await api.get('/tmt/imports', { params: { branch: branchId, year } });
      setHistoryDlg({ open: true, loading: false, imports: res.data.imports || [] });
    } catch {
      setHistoryDlg({ open: false, loading: false, imports: [] });
      toast.error('שגיאה בטעינת ההיסטוריה');
    }
  };

  /**
   * Which uploads can be undone: the LATEST of each kind (ministry list,
   * ClickTac registrations, ClickTac contracts). An older one cannot — a
   * later file has moved the rows on, and putting the older snapshot back
   * would erase that file's work. The server enforces the same rule; this is
   * only so the button does not appear where it would be refused.
   */
  const undoableIds = useMemo(() => {
    const seen = new Set();
    const ids = new Set();
    for (const imp of historyDlg.imports) {
      const kind = imp.source === 'tmt' ? 'tmt' : `clicktac:${imp.export_type || 'registrations'}`;
      if (seen.has(kind)) continue;
      seen.add(kind);
      ids.add(imp.id);
    }
    return ids;
  }, [historyDlg.imports]);

  const handleUndo = async () => {
    const imp = undoDlg.imp;
    if (!imp) return;
    setUndoDlg(d => ({ ...d, saving: true, error: null }));
    try {
      const base = imp.source === 'tmt' ? '/tmt/imports' : '/external-enrollments/imports';
      const res = await api.delete(`${base}/${imp.id}`);
      setUndoDlg(d => ({ ...d, saving: false, result: res.data }));
      toast.success(`ההעלאה "${imp.file_name}" בוטלה`);
      fetchData();
      openHistory();
    } catch (err) {
      const data = err.response?.data;
      setUndoDlg(d => ({ ...d, saving: false, error: data?.error || 'שגיאה בביטול ההעלאה', names: data?.names || [] }));
    }
  };

  const openContacts = async () => {
    setContactsDlg({ open: true, loading: true, rows: [] });
    try {
      const res = await api.get('/tmt/contacts', { params: { branch: branchId, year, verdict: 'approved' } });
      setContactsDlg({ open: true, loading: false, rows: res.data.contacts || [] });
    } catch (err) {
      setContactsDlg({ open: false, loading: false, rows: [] });
      toast.error(err.response?.data?.error || 'שגיאה בטעינת דף הקשר');
    }
  };

  /**
   * Which group this child actually joins.
   *
   * The ministry's שכבת גיל is a funding bracket and ClickTac's is a form
   * field. Neither is a placement — a child of 22 months can belong with the
   * בוגרים in one gan and the צעירים in another, and that is the manager's
   * call, made against the age on 1 September shown next to it. Once made it
   * decides the fee column and the classroom at import, and it survives the
   * next file.
   */
  const setPlacement = async (row, group) => {
    if (!row.clicktac) {
      return toast.info('אפשר לקבוע שכבת גיל רק לילד/ה שנרשמו בקליקטאק');
    }
    setSaving(s => ({ ...s, [row.id_number]: true }));
    try {
      await api.put(`/external-enrollments/${row.clicktac.id}/placement`, { age_group: group });
      toast.success(group
        ? `${row.child_name} — שכבת הגיל נקבעה ל${group}`
        : `${row.child_name} — חזרה לשכבה לפי הגיל`);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בקביעת שכבת הגיל');
    } finally {
      setSaving(s => ({ ...s, [row.id_number]: false }));
    }
  };

  /**
   * `confirmDropAll` is passed only after the server has refused once and the
   * operator has read what it refused over. It is deliberately not a checkbox
   * sitting open on the dialog: the case it covers — every waiting child
   * rejected at once — should be reached by being stopped, not by ticking past.
   */
  const handleApply = async (confirmDropAll = false) => {
    setApplyDlg(d => ({ ...d, saving: true, error: null }));
    try {
      const res = await api.post('/tmt/apply', {
        branch_id: branchId,
        academic_year: year,
        ...(confirmDropAll ? { confirm_drop_all: true } : {}),
      });
      setApplyDlg({ open: true, saving: false, result: res.data, error: null });
      fetchData();
    } catch (err) {
      const data = err.response?.data;
      // Shown inside the dialog, not as a toast. These refusals explain why a
      // cohort is about to be written off, and that does not belong in a
      // message that disappears on its own after four seconds.
      setApplyDlg(d => ({
        ...d,
        saving: false,
        error: {
          code: data?.code || '',
          message: data?.error || 'שגיאה בהחלת המסקנות',
          queueSize: data?.queue_size || 0,
        },
      }));
    }
  };

  const lastTmt = data?.last_import?.tmt;
  /**
   * ClickTac publishes TWO exports and they are uploaded independently: the
   * registrations export carries the family, the contracts export carries the
   * class and the דרגה. "The last ClickTac file" is therefore two dates, and
   * one of them being three weeks old is exactly the thing this card exists to
   * show. `clicktac` (the newer of the two) is still read as a fallback, so a
   * branch whose history predates the split still sees its date.
   */
  const lastCtReg = data?.last_import?.clicktac_registrations ?? data?.last_import?.clicktac;
  const lastCtContracts = data?.last_import?.clicktac_contracts;
  const lastCt = lastCtReg || lastCtContracts;
  const lastPrevYear = data?.last_import?.previous_year;

  return (
    <Box sx={{ p: 2 }}>
      {/*
        * This screen is ALWAYS embedded — EmunahEnrollment owns the page header,
        * its title, its branch and year line and its one filled button, and
        * renders this component underneath. There is no second header here, and
        * a `!embedded` branch that drew one would be a header nobody ever sees.
        *
        * The standing note about how a child qualifies is a caption, not an
        * Alert. It is true on every load and about nothing in particular, and an
        * alert that is always on is not an alert — it is a sentence wearing a
        * blue box, taking 56px off the top of the table every time.
        */}
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
        ילד נקלט לשנה הבאה רק אם הוא מופיע גם ברשימת האישורים של משרד התמ"ת וגם ברישום בקליקטאק.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

      {data && !loading && (
        <>
          {/* The numbers, arranged by what somebody is meant to do with them.
              These were fourteen identical cards in one flat row: the count of
              children safely approved, the count nobody has phoned yet and the
              count already filed, all the same size, weight and grey. Every one
              of them was already a filter over the table below — they simply
              did not look like controls, and nothing on the row claimed to
              matter more than anything else. See components/ui/StatBoard. */}
          <StatBoard
            hero={{
              id: 'approved',
              label: 'מאושרים לשנה הבאה',
              value: summary.approved || 0,
              hint: `${summary.clean || 0} ללא חריגות`,
              tone: 'success',
              active: verdictFilter === 'approved',
              onClick: () => setVerdictFilter(verdictFilter === 'approved' ? '' : 'approved'),
            }}
            attention={[
              {
                id: 'missing_registration',
                label: 'אושר בתמ"ת — לא נרשם',
                value: summary.missing_registration || 0,
                hint: 'להתקשר להורים',
                active: verdictFilter === 'missing_registration',
                onClick: () => setVerdictFilter(verdictFilter === 'missing_registration' ? '' : 'missing_registration'),
              },
              {
                id: 'missing_approval',
                label: 'נרשם — אין אישור תמ"ת',
                value: summary.missing_approval || 0,
                hint: 'לא ניתן לקלוט',
                active: verdictFilter === 'missing_approval',
                onClick: () => setVerdictFilter(verdictFilter === 'missing_approval' ? '' : 'missing_approval'),
              },
              {
                id: 'not_approved',
                label: 'ללא אישור בתמ"ת',
                value: summary.not_approved || 0,
                active: verdictFilter === 'not_approved',
                onClick: () => setVerdictFilter(verdictFilter === 'not_approved' ? '' : 'not_approved'),
              },
              {
                id: 'withdrawn',
                label: 'הוסרו מרשימת התמ"ת',
                value: summary.withdrawn || 0,
                hint: 'האישור בוטל',
                active: verdictFilter === 'withdrawn',
                onClick: () => setVerdictFilter(verdictFilter === 'withdrawn' ? '' : 'withdrawn'),
              },
              {
                // Registered in ClickTac's CONTRACTS export and nowhere else.
                // Not "call these families" — there is nobody to call yet, since
                // the contracts export carries no parent. The fix is the other
                // upload, and the hint says so.
                id: 'missing_parents',
                label: 'חסר פרטי הורים',
                value: summary.missing_parents || 0,
                hint: 'להעלות גם את ייצוא הנרשמים',
                active: missingParentsOnly,
                onClick: () => setMissingParentsOnly(v => !v),
              },
              {
                // מזומן אינו מתקבל, ומשפחה בלי אמצעי תשלום צריכה טלפון — two
                // facts that were in the file from day one and nobody saw. The
                // cheques ride in the hint rather than in the number: they are
                // accepted, and this number is the list of calls to make.
                id: 'payment_alerts',
                label: 'אמצעי תשלום',
                value: summary.payment_alerts || 0,
                hint: `צ'קים ${summary.payment_warnings || 0}`,
                active: paymentAlertOnly,
                onClick: () => setPaymentAlertOnly(v => !v),
              },
              {
                // מאזן שלילי בקליקטאק — a fact about the family's account, from
                // the contracts export.
                id: 'balance_due',
                label: 'יתרות חוב בקליקטאק',
                value: summary.balance_due || 0,
                hint: 'לפי עמודת מאזן בקובץ החוזים',
                active: balanceDueOnly,
                onClick: () => setBalanceDueOnly(v => !v),
              },
              summary.prev_year_loaded && {
                id: 'prev_year_debt',
                label: 'חוב משנה שעברה',
                value: summary.prev_year_debtors || 0,
                hint: `${summary.prev_year_returning || 0} היו בקובץ ${data.previous_year_label || ''}`,
                active: issueFilter === 'prev_year_debt',
                onClick: () => setIssueFilter(issueFilter === 'prev_year_debt' ? '' : 'prev_year_debt'),
              },
              {
                id: 'needs_absorption_date',
                label: 'להזין תאריך כניסה בתמ"ת',
                value: summary.needs_absorption_date || 0,
                hint: `${summary.absorbed || 0} כבר עם תאריך`,
                tone: 'warning',
                active: issueFilter === 'needs_absorption_date',
                onClick: () => setIssueFilter(issueFilter === 'needs_absorption_date' ? '' : 'needs_absorption_date'),
              },
              {
                id: 'cancelled',
                label: 'ביטלו רישום',
                value: summary.cancelled || 0,
                hint: `${summary.places_freed || 0} מקומות התפנו`,
                tone: 'warning',
                active: verdictFilter === 'cancelled',
                onClick: () => setVerdictFilter(verdictFilter === 'cancelled' ? '' : 'cancelled'),
              },
              !!summary.reopened && {
                id: 'reopened',
                label: 'נפתחו מחדש',
                value: summary.reopened,
                hint: 'חריגות שנסגרו וקובץ חדש שינה',
                tone: 'warning',
              },
            ].filter(Boolean)}
            facts={[
              { id: 'placed_by_hand', label: 'שובצו ידנית', value: summary.placed_by_hand || 0 },
              { id: 'already_imported', label: 'נקלטו כבר למערכת', value: summary.already_imported || 0 },
              !!summary.private && {
                id: 'private',
                label: 'בגן ללא תמ"ת',
                value: summary.private,
                active: verdictFilter === 'private',
                onClick: () => setVerdictFilter(verdictFilter === 'private' ? '' : 'private'),
              },
            ].filter(Boolean)}
          />

          {/* The key to the חריגות column — only the kinds that actually
              appear, in the server's own colours, so it can be read down
              without hovering over anything. */}
          {!!Object.keys(summary.issues || {}).length && (
            <Stack direction="row" spacing={0.75} sx={{ mb: 1, overflowX: 'auto', pb: 0.5 }}
              flexWrap="nowrap" alignItems="center">
              <Typography variant="caption" color="text.secondary" sx={NOWRAP}>חריגות:</Typography>
              {Object.entries(summary.issues || {}).map(([code, count]) => (
                <IssueChip key={code} sx={{ height: 18, fontSize: '0.65rem', cursor: 'pointer' }}
                  issue={{ ...(issueDict[code] || {}), code, label: `${issueDict[code]?.label || code} (${count})`, detail: '' }} />
              ))}
            </Stack>
          )}

          {/* The key to the colours in the אמצעי תשלום column. Written out
              once here rather than left to be learned from tooltips: the whole
              point of colouring the column is that it can be read without
              hovering over anything. */}
          {/* ONE LINE, and it scrolls rather than wraps. A legend that reflows
              onto a second row pushes the table down and reads as content;
              this is a ruler, and a ruler belongs at the edge of the page. */}
          <Stack direction="row" spacing={0.75} sx={{ mb: 1.5, overflowX: 'auto', pb: 0.5 }}
            flexWrap="nowrap" alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={NOWRAP}>אמצעי תשלום:</Typography>
            {METHOD_LEGEND.map(([kind, label]) => (
              <Chip key={kind} size="small" label={label}
                color={METHOD_STYLE[kind].color} variant={METHOD_STYLE[kind].variant}
                sx={{ height: 18, fontSize: '0.65rem' }} />
            ))}
          </Stack>

          <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
            <TextField
              size="small" placeholder="חיפוש שם או ת״ז" value={search}
              onChange={e => setSearch(e.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              sx={{ minWidth: 220 }}
            />
            <ToggleButtonGroup size="small" exclusive value={issueFilter}
              onChange={(e, v) => setIssueFilter(v || '')}>
              {Object.entries(summary.issues || {}).map(([code, count]) => (
                <ToggleButton key={code} value={code}
                  sx={{ borderBottom: 3, borderBottomColor: issueDict[code]?.color || 'transparent' }}>
                  {issueDict[code]?.label || code} ({count})
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {showArchived && (
              <Chip size="small" color="secondary" icon={<Inventory2OutlinedIcon />}
                label={`ארכיון — הוסרו מכל הרשימות (${summary.archived || 0})`}
                onDelete={() => setShowArchived(false)} />
            )}
            {!!summary.missing_parents && (
              <Chip size="small" color="error"
                variant={missingParentsOnly ? 'filled' : 'outlined'}
                label={`חסר פרטי הורים (${summary.missing_parents})`}
                onClick={() => setMissingParentsOnly(v => !v)} />
            )}
            {!!summary.payment_alerts && (
              <Chip size="small" color="error"
                variant={paymentAlertOnly ? 'filled' : 'outlined'}
                label={`אמצעי תשלום — התרעה (${summary.payment_alerts})`}
                onClick={() => setPaymentAlertOnly(v => !v)} />
            )}
            {/* Beside the alert chip and never inside it — accepted, and worth
                a call when there is time. */}
            {!!summary.payment_warnings && (
              <Chip size="small" color="warning"
                variant={chequeOnly ? 'filled' : 'outlined'}
                label={`צ'קים (${summary.payment_warnings})`}
                onClick={() => setChequeOnly(v => !v)} />
            )}
            <Box sx={{ flex: 1 }} />
            <Tooltip title="קבצים אחרונים">
              <IconButton size="small" onClick={e => setFilesAnchor(e.currentTarget)}
                color={filesAnchor ? 'primary' : 'default'}>
                <InfoOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Button size="small" startIcon={<HistoryIcon />} onClick={openHistory}>היסטוריית העלאות</Button>
            <Button size="small" startIcon={<ContactPhoneIcon />} onClick={openContacts}>דף קשר</Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={handleExport}>ייצוא לאקסל</Button>
            {/* The action the whole screen exists to reach.
                It was a small outlined button at the end of four others, which
                put "apply everything you just reviewed" at the same weight as
                "export to Excel". It cannot move to the page header — that
                belongs to EmunahEnrollment, which knows nothing about this
                dialog — and it should not: it acts on the table below it, and
                this is the last thing you touch before that table changes. */}
            {canImport && (
              <Button variant="contained" color="warning" startIcon={<PlaylistAddCheckIcon />}
                sx={{ ml: 0.5 }}
                onClick={() => setApplyDlg({ open: true, saving: false, result: null, error: null })}>
                החלת המסקנות
              </Button>
            )}
          </Stack>

          {/* ---- קבצים אחרונים ----
              A Popover rather than a page fixture: the same facts as before
              (file, date, counts, warnings), read on demand instead of taking
              two Cards' worth of height on every load. */}
          <Popover
            open={!!filesAnchor} anchorEl={filesAnchor} onClose={() => setFilesAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 400 }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" display="block" sx={{ mb: 1 }}>
                קבצים אחרונים
              </Typography>

              <Typography variant="body2" fontWeight={600}
                color={lastTmt ? 'text.primary' : 'text.disabled'}>
                תמ"ת — {lastTmt ? fmtDateTime(lastTmt.created_at) : 'טרם הועלה'}
              </Typography>
              {lastTmt && <ImportLine imp={lastTmt} />}
              {!!lastTmt?.details?.missing?.length && (
                <Typography variant="caption" color="warning.main" display="block">
                  ירדו מהרשימה: {lastTmt.details.missing.join(', ')}
                </Typography>
              )}

              <Divider sx={{ my: 1 }} />

              {/* Two lines, because there are two ClickTac files and they are
                  uploaded separately. A branch current on one and stale on the
                  other used to read as "up to date". */}
              {[['נרשמים', lastCtReg], ['חוזים', lastCtContracts]].map(([label, imp]) => (
                <Box key={label} sx={{ mt: 0.5 }}>
                  <Typography variant="body2" fontWeight={600}
                    color={imp ? 'text.primary' : 'text.disabled'}>
                    קליקטאק · {label} — {imp ? fmtDateTime(imp.created_at) : 'טרם הועלה'}
                  </Typography>
                  {imp && <ImportLine imp={imp} />}
                </Box>
              ))}
              {!!lastCtReg?.details?.missing?.length && (
                <Typography variant="caption" color="warning.main" display="block">
                  ירדו מקובץ הנרשמים: {lastCtReg.details.missing.join(', ')}
                </Typography>
              )}
              {!!lastCtContracts?.details?.missing?.length && (
                <Typography variant="caption" color="warning.main" display="block">
                  ירדו מקובץ החוזים: {lastCtContracts.details.missing.join(', ')}
                </Typography>
              )}
              {!!lastCtContracts?.details?.other_institution?.length && (
                <Typography variant="caption" color="info.main" display="block">
                  לא נקלטו — מעון אחר ({lastCtContracts.details.other_institution.length})
                </Typography>
              )}

              <Divider sx={{ my: 1 }} />

              {/* Last year's file — the fact behind "ממשיך" and the source
                  of last year's debts. Uploaded through the same button with
                  the "שנה קודמת" box ticked. */}
              <Typography variant="body2" fontWeight={600}
                color={lastPrevYear ? 'text.primary' : 'text.disabled'}>
                שנה קודמת ({data.previous_year_label || '—'}) — {lastPrevYear ? fmtDateTime(lastPrevYear.created_at) : 'טרם הועלה'}
              </Typography>
              {lastPrevYear
                ? <ImportLine imp={lastPrevYear} />
                : (
                  <Typography variant="caption" color="text.secondary">
                    להעלאה: "קליטת קובץ קליקטאק" ← לסמן "זהו קובץ של שנה קודמת"
                  </Typography>
                )}

              {canImport && (
                <>
                  <Divider sx={{ my: 1 }} />
                  <Button size="small" fullWidth color="secondary" variant="outlined"
                    onClick={() => { setFilesAnchor(null); setTestAlertsDlg({ open: true, sending: false, result: null, error: null }); }}>
                    שליחת בדיקה לעינת (SMS + מייל)
                  </Button>
                </>
              )}
            </Box>
          </Popover>

          {/* ---- שליחת בדיקה לעינת ----
              A real SMS and a real email, right now — see sendTestAlerts.
              The dialog says so before the button is live, because the
              action is not reversible: she gets a text either way. */}
          <Dialog open={testAlertsDlg.open}
            onClose={() => setTestAlertsDlg({ open: false, sending: false, result: null, error: null })}
            maxWidth="sm" fullWidth>
            <DialogTitle>שליחת בדיקה לעינת</DialogTitle>
            <DialogContent>
              {!testAlertsDlg.result && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  זו שליחה אמיתית — SMS לטלפון של עינת רוה ומייל לכתובת שהוגדרה,
                  לא סימולציה. משמש לוודא שההתראות באמת מגיעות.
                </Alert>
              )}
              {testAlertsDlg.error && <Alert severity="error" sx={{ mb: 2 }}>{testAlertsDlg.error}</Alert>}
              {testAlertsDlg.result && (
                <Stack spacing={1.5}>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>תזכורת חודשית — קליקטאק</Typography>
                    <Typography variant="body2" color={testAlertsDlg.result.reminder?.sms?.ok ? 'success.main' : 'error.main'}>
                      SMS: {testAlertsDlg.result.reminder?.sms?.ok
                        ? `נשלח ל-${testAlertsDlg.result.reminder.sms.to}`
                        : (testAlertsDlg.result.reminder?.sms?.error || 'לא נשלח')}
                    </Typography>
                    <Typography variant="body2" color={testAlertsDlg.result.reminder?.email?.ok ? 'success.main' : 'error.main'}>
                      מייל: {testAlertsDlg.result.reminder?.email?.ok
                        ? `נשלח ל-${(testAlertsDlg.result.reminder.email.to || []).join(', ')}`
                        : (testAlertsDlg.result.reminder?.email?.error || 'לא נשלח')}
                    </Typography>
                  </Card>
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>דיגסט — שכבת גיל שונה</Typography>
                    {testAlertsDlg.result.digest?.empty ? (
                      <Typography variant="body2" color="text.secondary">אין כרגע אף חריגה פתוחה — לא נשלח מייל, וזה תקין.</Typography>
                    ) : (
                      <Typography variant="body2" color={testAlertsDlg.result.digest?.sent ? 'success.main' : 'error.main'}>
                        {testAlertsDlg.result.digest?.sent
                          ? `נשלח ל-${(testAlertsDlg.result.digest.to || []).join(', ')} (${testAlertsDlg.result.digest.total} ילדים)`
                          : (testAlertsDlg.result.digest?.error || 'לא נשלח')}
                      </Typography>
                    )}
                  </Card>
                </Stack>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setTestAlertsDlg({ open: false, sending: false, result: null, error: null })}>סגירה</Button>
              {!testAlertsDlg.result && (
                <Button variant="contained" color="warning" onClick={sendTestAlerts} disabled={testAlertsDlg.sending}>
                  {testAlertsDlg.sending ? 'שולח…' : 'שליחה אמיתית עכשיו'}
                </Button>
              )}
            </DialogActions>
          </Dialog>

          {/* ELEVEN COLUMNS DO NOT FIT IN 1440px AND SHOULD NOT TRY. Squeezing
              them wrapped the name to two lines, the age to four and the dates
              to two, and a table whose every row is four lines tall cannot be
              scanned — which is the whole job of this screen. The table keeps
              its natural width and the container scrolls sideways. */}
          {/* The header stays. A table of 260 children scrolled sideways AND
              downwards, and by row twenty the column names were gone — so the
              seventh column was "some date" and the ninth was "some chip".
              maxHeight is what makes `stickyHeader` do anything at all; without
              a scrolling box there is nothing for the header to stick to. */}
          <Card>
            <TableContainer sx={{ maxHeight: 'calc(100vh - 260px)' }}>
              <Table size="small" stickyHeader sx={{ minWidth: 1320 }}>
              <TableHead>
                <TableRow sx={{ '& th': { ...NOWRAP, bgcolor: 'background.paper' } }}>
                  <TableCell>שם הילד/ה</TableCell>
                  <TableCell>ת״ז</TableCell>
                  <TableCell>תאריך לידה</TableCell>
                  <TableCell>גיל ב־1.9</TableCell>
                  {/* NOT a classroom. This column sets תינוק/פעוט/בוגר — the
                      funding bracket that decides which fee column applies —
                      and the request it sends carries `age_group` and nothing
                      else. Calling it "שיבוץ לכיתה" made a manager reasonably
                      ask why the gan has no classrooms yet the screen let her
                      place children: she was placing them in a price band. */}
                  <TableCell>שכבת גיל</TableCell>
                  <TableCell>מסקנה</TableCell>
                  <TableCell>חריגות</TableCell>
                  <TableCell>תמ"ת</TableCell>
                  <TableCell>קליקטאק</TableCell>
                  {/* ITS OWN COLUMN AS OF THIS WEEK. The method chip used to
                      ride inside חריגות, which put it in a different place on
                      every row — after nought, one or four anomaly chips — and
                      made it invisible on exactly the rows that have none. A
                      column of colours can be read down; a chip that moves
                      cannot be read at all. */}
                  <TableCell>תשלום</TableCell>
                  <TableCell>כיתה / דרגה</TableCell>
                  {/* The child's account in ClickTac, for every row — a family
                      that owes is seen before it is promoted, and a family
                      in credit is seen too. See BalanceCell. */}
                  <TableCell>מאזן</TableCell>
                  {/* The eye/detail button — pinned to the inline-end edge
                      (physically the left in this RTL table) so it survives
                      the sideways scroll the table above is built for. Below
                      ~1320px the eleven columns push it off the visible
                      width entirely; sticky keeps every row one click away
                      no matter how far right the horizontal scroll sits. */}
                  <TableCell sx={{ position: 'sticky', insetInlineEnd: 0, bgcolor: 'background.paper', zIndex: 1 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(r => (
                  <TableRow
                    key={r.id_number}
                    hover
                    /**
                     * The row itself says whether it needs somebody.
                     *
                     * COLOR.row.attention was defined with a comment explaining
                     * that this is how a table should work — "a row that needs
                     * attention is tinted; a row that is fine is white" — and
                     * then used nowhere, so finding the one problem row still
                     * meant scanning coloured chips across thirteen columns.
                     */
                    sx={r.verdict && r.verdict !== 'approved' && r.verdict !== 'private'
                      ? { bgcolor: 'row.attention' }
                      : undefined}
                  >
                    <TableCell sx={NOWRAP}>
                      {r.child_name}
                      {r.has_note && (
                        <Tooltip title={r.decision?.note || ''}>
                          <StickyNote2OutlinedIcon fontSize="inherit" color="warning"
                            sx={{ mr: 0.5, verticalAlign: 'middle', cursor: 'pointer' }}
                            onClick={() => openDetail(r)} />
                        </Tooltip>
                      )}
                      {r.name_source && (
                        <Tooltip title={`השם נבחר לפי ${r.name_source === 'tmt' ? 'תמ"ת' : r.name_source === 'clicktac' ? 'קליקטאק' : 'הזנה ידנית'}`}>
                          <CheckIcon fontSize="inherit" color="success" sx={{ mr: 0.5, verticalAlign: 'middle' }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell sx={NOWRAP} className="num">{r.id_number}</TableCell>
                    {/* The source of the birth date used to be a second line
                        under every date in the table — sixty repetitions of
                        "לפי תמ"ת" to answer a question asked about two rows.
                        It is a tooltip now. */}
                    <TableCell sx={NOWRAP}>
                      <Tooltip title={r.age_source ? `תאריך הלידה לפי ${r.age_source}` : ''}>
                        <span className="num">{fmtDate(r.birth_date)}</span>
                      </Tooltip>
                    </TableCell>
                    {/* Compact on the line, complete on hover. See compactAge. */}
                    <TableCell sx={NOWRAP}>
                      <Tooltip title={[
                        r.age_at_year_start?.label || '',
                        `לפי הגיל: ${r.age_at_year_start?.suggested_group || '—'}`,
                        r.age_group && r.age_group !== r.age_at_year_start?.suggested_group
                          ? `בקבצים: ${r.age_group}` : '',
                      ].filter(Boolean).join(' · ')}>
                        <Typography variant="body2" fontWeight={600} component="span">
                          {compactAge(r.age_at_year_start)}
                        </Typography>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <TextField
                        select size="small" variant="standard"
                        sx={{ minWidth: 110 }}
                        disabled={!canPlace || !r.clicktac || !!saving[r.id_number]
                          || r.clicktac?.review_status === 'imported'}
                        value={r.age_group_override || ''}
                        onChange={e => setPlacement(r, e.target.value)}
                      >
                        <MenuItem value="">
                          לפי הגיל ({r.age_at_year_start?.suggested_group || '—'})
                        </MenuItem>
                        {AGE_GROUPS.map(g => <MenuItem key={g} value={g}>{g}</MenuItem>)}
                      </TextField>
                      {r.clicktac?.review_status === 'imported' && (
                        <Typography variant="caption" color="text.disabled" display="block">
                          נקלט/ה — משנים במסך הכיתות
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={VERDICT_STYLE[r.verdict]?.short || r.verdict}
                        color={VERDICT_STYLE[r.verdict]?.color || 'default'} />
                    </TableCell>
                    {/* ANOMALIES ONLY. The payment chip used to live here and
                        it was never an anomaly — it is a fact about every
                        family, and filing it among the ministry's findings
                        both hid it and made the rows with real findings look
                        worse than they are. It has its own column now. */}
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {r.issues.map(i => <IssueChip key={i.code} issue={i} />)}
                        {!r.issues.length && (
                          <Typography variant="caption" color="text.disabled">—</Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell sx={NOWRAP}>
                      {r.tmt
                        ? `${r.tmt.decision}${r.tmt.is_present ? '' : ' (הוסר/ה)'}`
                        : <Typography variant="caption" color="error">לא ברשימה</Typography>}
                    </TableCell>
                    <TableCell>
                      {r.clicktac
                        ? (
                          <Stack spacing={0.5} alignItems="flex-start">
                            <Typography variant="body2" sx={NOWRAP}
                              color={r.clicktac.live === false ? 'error' : 'text.primary'}>
                              {r.clicktac.status}
                              {r.clicktac.live === false ? ' (הוסר/ה)' : ''}
                            </Typography>
                            {/* The row exists because a contract was signed and
                                nothing else — no parent, no phone, no payment
                                method. It cannot be promoted, and saying so
                                here is cheaper than finding out at the import
                                button. */}
                            {r.clicktac.missing_parents && (
                              <Tooltip title="אין טלפון הורה באף קובץ של קליקטאק. יש לקלוט את ייצוא הנרשמים, או ייצוא חוזים עדכני שכולל את ההורים.">
                                <Chip size="small" color="error" label="חסר פרטי הורים" sx={TIGHT_CHIP} />
                              </Tooltip>
                            )}
                            {/* מאיזה קובץ הגיע/ה — פר שורה, ולא רק כתאריך
                                בכרטיס למעלה. שתי השורות נראות זהות בטבלה, וזה
                                מה שמסביר למה לאחת יש דרגה ולשנייה טלפון. */}
                            <Stack direction="row" spacing={0.5}>
                              {(r.clicktac.sources || []).map(src => {
                                // Struck through when the LATEST upload of that
                                // export no longer lists the child.
                                const gone = src === 'registrations'
                                  ? r.clicktac.is_present === false
                                  : r.clicktac.contract_present === false;
                                return (
                                  <Tooltip key={src} title={gone ? 'לא בקובץ האחרון מסוג זה' : ''}>
                                    <Chip size="small" variant="outlined"
                                      color={gone ? 'error' : 'default'}
                                      sx={{ height: 18, fontSize: '0.65rem', textDecoration: gone ? 'line-through' : 'none' }}
                                      label={SOURCE_LABEL[src] || src} />
                                  </Tooltip>
                                );
                              })}
                            </Stack>
                          </Stack>
                        )
                        : <Typography variant="caption" color="error">לא נרשם</Typography>}
                    </TableCell>
                    {/* ---- תשלום ---- */}
                    <TableCell sx={NOWRAP}>
                      {r.clicktac?.payment_method_kind ? (
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          {/* HOW THE FAMILY PAYS. The colour is the whole
                              message (see METHOD_STYLE); the tooltip carries
                              the vendor's own wording — the rule matches on a
                              substring and the office has to be able to see
                              what it matched — and, since this week, the terms
                              behind it. */}
                          <Tooltip title={(
                            <Box>
                              <Box sx={{ fontWeight: 700, mb: 0.5 }}>
                                {r.clicktac.payment_method
                                  ? `צורת תשלום בקליקטאק: ${r.clicktac.payment_method}`
                                  : 'בקליקטאק לא נרשמה צורת תשלום כלל'}
                              </Box>
                              {paymentTermLines(r.clicktac.payment_terms).map((l, i) => (
                                <Box key={i}>{l}</Box>
                              ))}
                              {/* The soft advice sits here rather than as a
                                  second chip — "מומלץ לעבור להו"ק" is a
                                  suggestion, and a table is not the place to
                                  argue with sixty families at once. */}
                              {r.clicktac.payment_alert?.severity === 'warning' && (
                                <Box sx={{ mt: 0.5 }}>{r.clicktac.payment_alert.label}</Box>
                              )}
                            </Box>
                          )}>
                            <Chip size="small" sx={TIGHT_CHIP}
                              color={METHOD_STYLE[r.clicktac.payment_method_kind.kind]?.color || 'default'}
                              variant={METHOD_STYLE[r.clicktac.payment_method_kind.kind]?.variant || 'outlined'}
                              label={r.clicktac.payment_method_kind.label} />
                          </Tooltip>
                          {/* And the verdict on it, when there is one. Kept
                              separate from the chip above: "הו"ק" and "הו"ק
                              ללא פרטי בנק" are two different facts, and
                              folding them into one chip loses the first.
                              Errors only — a cheque already says everything it
                              has to say in orange. */}
                          {r.clicktac.payment_alert?.severity === 'error' && (
                            <Chip size="small" color="error" sx={TIGHT_CHIP}
                              label={r.clicktac.payment_alert.label} />
                          )}
                        </Stack>
                      ) : <Typography variant="caption" color="text.disabled">—</Typography>}
                    </TableCell>
                    {/* From the contracts export, and nowhere else in either
                        system: the class ClickTac put the child in and the
                        subsidy tier the whole fee hangs on. On ONE line —
                        "דרגה 7 · 1,410 ₪", because the tier alone is a number
                        nobody can act on ("דרגה 4" means nothing without the
                        branch's matrix in front of you) and the two of them
                        stacked cost three lines on every contract row. */}
                    <TableCell>
                      {r.clicktac?.class_name || r.clicktac?.tier ? (
                        <Tooltip title={r.clicktac.tuition_type || ''}>
                          <Box>
                            <Typography variant="body2" sx={NOWRAP}>
                              {r.clicktac.class_name || '—'}
                            </Typography>
                            <Typography variant="caption" sx={NOWRAP}
                              color={r.clicktac.fee_by_tier != null ? 'success.main' : 'text.secondary'}
                              fontWeight={r.clicktac.fee_by_tier != null ? 700 : 400}>
                              דרגה {r.clicktac.tier === '' ? '—' : r.clicktac.tier}
                              {r.clicktac.fee_by_tier != null ? ` · ${fmtMoney(r.clicktac.fee_by_tier)}` : ''}
                            </Typography>
                          </Box>
                        </Tooltip>
                      ) : <Typography variant="caption" color="text.disabled">—</Typography>}
                    </TableCell>
                    <TableCell>
                      <BalanceCell balance={r.clicktac?.balance} family={r.clicktac?.family_balance} />
                      {/* Last year's debt, under this year's balance — the
                          one number the office asked to see before it takes
                          a returning family. */}
                      {typeof r.prev_year?.balance === 'number' && r.prev_year.balance < 0 && (
                        <Typography variant="caption" color="error.main" display="block" sx={NOWRAP}>
                          שנה שעברה: חוב {fmtMoney(-r.prev_year.balance)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ position: 'sticky', insetInlineEnd: 0, bgcolor: 'background.paper', zIndex: 1 }}>
                      <IconButton size="small" onClick={() => openDetail(r)}><VisibilityIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {!visible.length && (
                  <TableRow><TableCell colSpan={13} align="center" sx={{ py: 3 }}>
                    <Typography color="text.secondary">
                      {showArchived ? 'הארכיון ריק — אף ילד/ה לא הוסר/ה מכל הרשימות' : 'אין רשומות להצגה'}
                    </Typography>
                  </TableCell></TableRow>
                )}
              </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </>
      )}

      {/* ---- העלאת קובץ תמ"ת ---- */}
      <Dialog open={uploadDlg.open} onClose={() => setUploadDlg(d => ({ ...d, open: false }))} maxWidth="sm" fullWidth>
        <DialogTitle>העלאת קובץ אישורים מתמ"ת</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            הקובץ מורד מהפורטל של משרד התמ"ת בנפרד לכל מעון ואינו כולל את שם הסניף,
            ולכן הוא נקלט לסניף <b>{branches.find(b => (b.id || b._id) === branchId)?.name || ''}</b> ולשנת {formatAcademicYear(year)}.
          </Alert>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            בחירת קובץ
            <input hidden type="file" accept=".xls,.xlsx"
              onChange={e => setUploadDlg(d => ({ ...d, file: e.target.files[0] }))} />
          </Button>
          {uploadDlg.file && <Typography sx={{ mt: 1 }}>{uploadDlg.file.name}</Typography>}

          {uploadDlg.result && (
            <Alert severity="success" sx={{ mt: 2 }}>
              <AlertTitle>נקלטו {uploadDlg.result.parsed} שורות</AlertTitle>
              חדשים: {uploadDlg.result.created} · עודכנו: {uploadDlg.result.updated} ·
              {' '}ללא שינוי: {uploadDlg.result.unchanged} · ירדו מהרשימה: {uploadDlg.result.missing}
              {!!uploadDlg.result.details?.missing?.length && (
                <Box sx={{ mt: 1 }}>
                  <b>ירדו מרשימת התמ"ת:</b> {uploadDlg.result.details.missing.join(', ')}
                </Box>
              )}
              {!!uploadDlg.result.details?.updated?.length && (
                <Box sx={{ mt: 1 }}>
                  <b>שינויים:</b>
                  <List dense>
                    {uploadDlg.result.details.updated.slice(0, 20).map((u, i) => (
                      <ListItem key={i} sx={{ py: 0 }}>
                        <ListItemText primary={u.name} secondary={u.changes.join(' · ')} />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadDlg(d => ({ ...d, open: false }))}>סגירה</Button>
          <Button variant="contained" onClick={handleUpload} disabled={uploadDlg.saving || !uploadDlg.file}>
            {uploadDlg.saving ? 'קולט…' : 'קליטה'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- כרטיס ילד: שני הצדדים זה מול זה ---- */}
      <Dialog open={!!detail} onClose={() => setDetailId(null)} maxWidth="md" fullWidth>
        {detail && (
          <>
            <DialogTitle>
              {detail.child_name}
              <Chip size="small" sx={{ mr: 1 }} label={detail.verdict_label}
                color={VERDICT_STYLE[detail.verdict]?.color || 'default'} />
            </DialogTitle>
            <DialogContent>
              <Alert severity={['approved', 'private'].includes(detail.verdict) ? 'success' : 'warning'} sx={{ mb: 2 }}>
                {detail.verdict_action}
                {detail.decision?.verdict_override && (
                  <Box sx={{ mt: 0.5 }}>
                    <b>סומן/ה כילד/ה בגן ללא תמ"ת</b>
                    {detail.decision.verdict_override.reason ? ` — ${detail.decision.verdict_override.reason}` : ''}
                    {detail.decision.verdict_override.by_name ? ` (${detail.decision.verdict_override.by_name}, ${fmtDate(detail.decision.verdict_override.at)})` : ''}
                  </Box>
                )}
              </Alert>

              {/* ---- הערה ומסמכים ----
                  Free text that survives every upload — see ReconcileDecision.
                  The papers hang off the same record, so an agreement attached
                  from the חייבים table is here too, and the other way round. */}
              <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography variant="subtitle2" fontWeight={700}>הערה</Typography>
                  <Button
                    size="small" startIcon={<AttachFileIcon fontSize="small" />}
                    onClick={() => setDocsRow({
                      id_number: detail.id_number,
                      child_name: detail.child_name,
                      branch_id: branchId,
                      branch_name: branches.find(b => String(b.id || b._id) === String(branchId))?.name || '',
                      academic_year: year,
                    })}
                  >
                    מסמכים
                  </Button>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <TextField fullWidth multiline minRows={1} maxRows={4} size="small"
                    placeholder='למשל: ילד אריתראי — לא יכול להיות בתמ"ת, כן בגן'
                    value={noteDraft} onChange={e => setNoteDraft(e.target.value)} disabled={!canPlace} />
                  <Button variant="contained" size="small" disabled={!canPlace || deciding || noteDraft === (detail.decision?.note || '')}
                    onClick={() => saveNote(detail)}>שמירה</Button>
                </Stack>
                {/* ---- בגן ללא תמ"ת ----
                    Offered only where it means something: a child ClickTac
                    has and the ministry does not approve. */}
                {['missing_approval', 'not_approved', 'private'].includes(detail.verdict) && canPlace && (
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                    {detail.verdict === 'private' ? (
                      <Button size="small" color="secondary" variant="outlined" disabled={deciding}
                        onClick={() => setPrivate(detail, false)}>
                        ביטול הסימון "בגן ללא תמ"ת"
                      </Button>
                    ) : (
                      <>
                        <TextField size="small" placeholder="סיבה (לא חובה)" value={privateReason}
                          onChange={e => setPrivateReason(e.target.value)} sx={{ minWidth: 220 }} />
                        <Button size="small" color="secondary" variant="contained" disabled={deciding}
                          onClick={() => setPrivate(detail, true)}>
                          סימון: בגן ללא תמ"ת
                        </Button>
                        <Typography variant="caption" color="text.secondary">
                          הילד/ה לא במסגרת המשרד — לא ייחשב/תיחשב "ללא אישור" ולא יורד/תרד מתור הקליטה
                        </Typography>
                      </>
                    )}
                  </Stack>
                )}
              </Card>

              {!!detail.issues.length && (
                <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>חריגות</Typography>
                  {detail.issues.map(i => (
                    <Stack key={i.code} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }} flexWrap="wrap" useFlexGap>
                      <IssueChip issue={{ ...i, detail: '' }} />
                      <Typography variant="body2" sx={{ flex: 1, minWidth: 160 }}>{i.detail || ''}</Typography>
                      {/* One answer per finding — see RESOLVE_OPTIONS. */}
                      {canPlace && (RESOLVE_OPTIONS[i.code] || DEFAULT_RESOLVE).map(([choice, label]) => (
                        <Button key={choice} size="small" variant="outlined" disabled={deciding}
                          startIcon={<CheckIcon />} onClick={() => resolve(detail, i.code, choice)}>
                          {label}
                        </Button>
                      ))}
                    </Stack>
                  ))}
                </Card>
              )}
              {/* ---- נסגרו ----
                  Findings a person closed. Listed so the decision can be
                  seen, and undone. */}
              {!!detail.resolved_issues?.length && (
                <Card variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'action.hover' }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>חריגות שנסגרו</Typography>
                  {detail.resolved_issues.map(i => (
                    <Stack key={i.code} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
                      <Typography variant="body2" color="text.secondary" sx={{ textDecoration: 'line-through' }}>
                        {i.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {i.resolution?.choice === 'tmt' ? 'לפי תמ"ת' : i.resolution?.choice === 'clicktac' ? 'לפי קליקטאק'
                          : i.resolution?.choice === 'custom' ? `ידני: ${i.resolution.value}` : 'תקין'}
                        {i.resolution?.by_name ? ` · ${i.resolution.by_name}` : ''}
                        {i.resolution?.at ? ` · ${fmtDate(i.resolution.at)}` : ''}
                      </Typography>
                      {canPlace && (
                        <Button size="small" disabled={deciding} startIcon={<ReplayIcon />}
                          onClick={() => reopen(detail, i.code)}>פתיחה מחדש</Button>
                      )}
                    </Stack>
                  ))}
                </Card>
              )}
              {detail.gone_since && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  הוסר/ה מכל הרשימות ב־{fmtDate(detail.gone_since)}. יימחק/תימחק מהארכיון 30 יום אחרי כן.
                </Alert>
              )}

              <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                  גיל בפתיחת השנה
                </Typography>
                <Typography variant="body2">
                  ב־1 בספטמבר: <b>{detail.age_at_year_start?.label || '—'}</b>
                  {detail.age_source ? ` (לפי תאריך הלידה ב${detail.age_source})` : ''}
                </Typography>
                <Typography variant="body2">
                  לפי הגיל בלבד: {detail.age_at_year_start?.suggested_group || '—'} ·
                  {' '}בקבצים: {detail.age_group || '—'}
                  {detail.age_group_override ? ` · שובץ ידנית ל${detail.age_group_override}` : ''}
                </Typography>
              </Card>

              {/* ---- שנה שעברה ----
                  Only once last year's file is here; then for every child,
                  including the ones who were not in it — that is the point. */}
              {detail.prev_year && (
                <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                    שנה שעברה ({data.previous_year_label || detail.prev_year.year})
                  </Typography>
                  {detail.prev_year.present ? (
                    <Typography variant="body2">
                      היה/תה בגן
                      {detail.prev_year.class_name ? ` · כיתה ${detail.prev_year.class_name}` : ''}
                      {detail.prev_year.status ? ` · ${detail.prev_year.status}` : ''}
                      {typeof detail.prev_year.balance === 'number' ? (
                        <Box component="span" sx={{ mr: 1, fontWeight: detail.prev_year.balance < 0 ? 700 : 400 }}
                          color={detail.prev_year.balance < 0 ? 'error.main' : 'text.primary'}>
                          {' · '}
                          {detail.prev_year.balance < 0 ? `חוב ${fmtMoney(-detail.prev_year.balance)}`
                            : detail.prev_year.balance > 0 ? `זכות ${fmtMoney(detail.prev_year.balance)}` : 'מאוזן'}
                        </Box>
                      ) : ''}
                    </Typography>
                  ) : (
                    <Typography variant="body2" color="text.secondary">לא היה/תה בקובץ של שנה שעברה — רישום חדש</Typography>
                  )}
                </Card>
              )}

              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                <Card variant="outlined" sx={{ p: 1.5, flex: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>משרד התמ"ת</Typography>
                  {detail.tmt ? (
                    <>
                      <Typography variant="body2">שם: {detail.tmt.full_name}</Typography>
                      <Typography variant="body2">תאריך לידה: {fmtDate(detail.tmt.birth_date)}</Typography>
                      <Typography variant="body2">קבוצת גיל: {detail.tmt.age_group}</Typography>
                      <Typography variant="body2">החלטה: {detail.tmt.decision}</Typography>
                      <Typography variant="body2">
                        תאריך כניסה לגן: {detail.tmt.absorbed_at
                          ? fmtDate(detail.tmt.absorbed_at)
                          : 'טרם הוזן בפורטל התמ"ת'}
                      </Typography>
                      <Typography variant="body2">ילד ממשיך: {detail.tmt.continuing == null ? '—' : (detail.tmt.continuing ? 'כן' : 'לא')}</Typography>
                      <Typography variant="body2">ילד רווחה: {detail.tmt.welfare == null ? '—' : (detail.tmt.welfare ? 'כן' : 'לא')}</Typography>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="body2">איש קשר: {detail.tmt.contact_name || '—'}</Typography>
                      <Typography variant="body2">טלפון: {detail.tmt.contact_phone || '—'}</Typography>
                      <Typography variant="body2">מייל: {detail.tmt.contact_email || '—'}</Typography>
                      {!detail.tmt.is_present && (
                        <Alert severity="error" sx={{ mt: 1 }}>
                          ירד/ה מרשימת התמ"ת בתאריך {fmtDate(detail.tmt.missing_since)}
                        </Alert>
                      )}
                    </>
                  ) : <Typography color="error">לא מופיע/ה ברשימת התמ"ת</Typography>}
                </Card>

                <Card variant="outlined" sx={{ p: 1.5, flex: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>קליקטאק</Typography>
                  {detail.clicktac ? (
                    <>
                      <Typography variant="body2">שם: {detail.clicktac.full_name}</Typography>
                      <Typography variant="body2">תאריך לידה: {fmtDate(detail.clicktac.birth_date)}</Typography>
                      <Typography variant="body2">שכבת גיל: {detail.clicktac.age_group}</Typography>
                      <Typography variant="body2">סטטוס: {detail.clicktac.status}</Typography>
                      <Typography variant="body2">חותם שני: {detail.clicktac.second_signer || '—'}</Typography>
                      <Typography variant="body2">תאריך הרשמה: {fmtDate(detail.clicktac.registered_at)}</Typography>
                      <Divider sx={{ my: 1 }} />
                      {/* ---- ההורים ----
                          Editable in place. A correction lives in
                          ReconcileDecision, beats the file everywhere, and
                          carries a reminder until ClickTac catches up. */}
                      {parentsDraft ? (
                        <Stack spacing={1}>
                          {['parent1', 'parent2'].map((k, idx) => (
                            <Stack key={k} direction="row" spacing={1}>
                              <TextField size="small" label={`הורה ${idx + 1} — שם`} value={parentsDraft[k]?.name || ''}
                                onChange={e => setParentsDraft(d => ({ ...d, [k]: { ...d[k], name: e.target.value } }))} />
                              <TextField size="small" label="טלפון" value={parentsDraft[k]?.phone || ''}
                                onChange={e => setParentsDraft(d => ({ ...d, [k]: { ...d[k], phone: e.target.value } }))} />
                            </Stack>
                          ))}
                          <Stack direction="row" spacing={1}>
                            <Button size="small" variant="contained" disabled={deciding} onClick={() => saveParents(detail)}>שמירה</Button>
                            <Button size="small" disabled={deciding} onClick={() => setParentsDraft(null)}>ביטול</Button>
                          </Stack>
                        </Stack>
                      ) : (
                        <>
                          {[['parent1', detail.clicktac.parent1_name, detail.clicktac.parent1_phone, detail.clicktac.parent1_override],
                            ['parent2', detail.clicktac.parent2_name, detail.clicktac.parent2_phone, detail.clicktac.parent2_override]]
                            .map(([k, name, phone, ov]) => (
                              <Typography key={k} variant="body2">
                                {name || '—'} · {phone || '—'}
                                {ov?.pending && (
                                  <Tooltip title={`בקובץ: ${ov.file_name || '—'} · ${ov.file_phone || '—'}`}>
                                    <Chip size="small" color="warning" label="תוקן כאן — לתקן בקליקטאק" sx={{ ...TIGHT_CHIP, mr: 1 }} />
                                  </Tooltip>
                                )}
                                {ov && !ov.pending && (
                                  <Chip size="small" color="success" variant="outlined" label="הקובץ עודכן" sx={{ ...TIGHT_CHIP, mr: 1 }} />
                                )}
                              </Typography>
                            ))}
                          {canPlace && (
                            <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                              <Button size="small" onClick={() => setParentsDraft({
                                parent1: { name: detail.clicktac.parent1_name, phone: detail.clicktac.parent1_phone },
                                parent2: { name: detail.clicktac.parent2_name, phone: detail.clicktac.parent2_phone },
                              })}>עריכת פרטי ההורים</Button>
                              {detail.decision?.parent_overrides && (
                                <Button size="small" color="warning" disabled={deciding} onClick={() => clearParents(detail)}>ביטול התיקון</Button>
                              )}
                            </Stack>
                          )}
                        </>
                      )}
                      <Typography variant="body2">{detail.clicktac.address}</Typography>
                      {detail.clicktac.contract_present === false && (
                        <Alert severity="error" sx={{ mt: 1, py: 0 }}>
                          ירד/ה מקובץ החוזים בתאריך {fmtDate(detail.clicktac.contract_missing_since)}
                        </Alert>
                      )}
                      {detail.clicktac.is_present === false && (
                        <Alert severity="error" sx={{ mt: 1, py: 0 }}>
                          ירד/ה מקובץ הנרשמים בתאריך {fmtDate(detail.clicktac.missing_since)}
                        </Alert>
                      )}

                      {/* ---- מאזן בקליקטאק ----
                          The child's account as the contracts export carries
                          it. Negative is what the family owes; shown in red,
                          and only when the file had the column at all. */}
                      {detail.clicktac.balance != null && (
                        <>
                          <Divider sx={{ my: 1 }} />
                          <Typography variant="body2"
                            color={detail.clicktac.balance < 0 ? 'error.main' : 'text.primary'}
                            fontWeight={detail.clicktac.balance < 0 ? 700 : 400}>
                            מאזן בקליקטאק: {detail.clicktac.balance < 0
                              ? `חוב ${fmtMoney(-detail.clicktac.balance)}`
                              : (detail.clicktac.balance > 0 ? `זכות ${fmtMoney(detail.clicktac.balance)}` : 'מאוזן')}
                            {detail.clicktac.family_balance != null && detail.clicktac.family_balance !== detail.clicktac.balance
                              ? ` · משפחתי ${fmtMoney(detail.clicktac.family_balance)}` : ''}
                          </Typography>
                          {detail.clicktac.tuition_amount != null && (
                            <Typography variant="body2">
                              שכ"ל בחוזה: {fmtMoney(detail.clicktac.tuition_amount)}
                              {detail.clicktac.continuing_contract != null
                                ? ` · ${detail.clicktac.continuing_contract ? 'ממשיך/ה משנה קודמת' : 'רישום חדש'} (לפי החוזה)` : ''}
                            </Typography>
                          )}
                        </>
                      )}

                      {/* ---- תנאי תשלום ----
                          Everything the office needs before it picks up the
                          phone, in the one place a person opens when they are
                          about to. The bank details are NOT here and never
                          travelled — the list response carries "קיימת / חסרה"
                          and nothing else (see paymentTermsFor on the server);
                          the record screen is where a הו"ק is actually filed. */}
                      {detail.clicktac.payment_terms && (
                        <>
                          <Divider sx={{ my: 1 }} />
                          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                            תנאי תשלום
                          </Typography>
                          {paymentTermLines(detail.clicktac.payment_terms).map((l, i) => (
                            <Typography key={i} variant="body2">{l}</Typography>
                          ))}
                          {detail.clicktac.payment_alert && (
                            <Alert sx={{ mt: 1, py: 0 }}
                              severity={detail.clicktac.payment_alert.severity === 'error' ? 'error' : 'warning'}>
                              {detail.clicktac.payment_alert.label}
                            </Alert>
                          )}
                        </>
                      )}

                      {detail.clicktac.review_status === 'imported' && (
                        <Alert severity="info" sx={{ mt: 1 }}>הרשומה כבר נקלטה למערכת כרישום</Alert>
                      )}
                    </>
                  ) : <Typography color="error">לא נרשם/ה בקליקטאק</Typography>}
                </Card>
              </Stack>

              {!!detail.tmt?.changes?.length && (
                <Card variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>שינויים בין העלאות תמ"ת</Typography>
                  {detail.tmt.changes.map((c, i) => (
                    <Typography key={i} variant="body2">
                      {fmtDateTime(c.at)} — {c.field}: {c.from} ← {c.to}
                    </Typography>
                  ))}
                </Card>
              )}
              {!!detail.clicktac?.changes?.length && (
                <Card variant="outlined" sx={{ p: 1.5, mt: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>שינויים בין העלאות קליקטאק</Typography>
                  {detail.clicktac.changes.map((c, i) => (
                    <Typography key={i} variant="body2">
                      {fmtDateTime(c.at)} — {c.field}: {c.from} ← {c.to}
                    </Typography>
                  ))}
                </Card>
              )}
            </DialogContent>
            <DialogActions><Button onClick={() => setDetailId(null)}>סגירה</Button></DialogActions>
          </>
        )}
      </Dialog>

      {/* ---- החלת המסקנות ---- */}
      <Dialog open={applyDlg.open} onClose={() => setApplyDlg({ open: false, saving: false, result: null, error: null })} maxWidth="sm" fullWidth>
        <DialogTitle>החלת מסקנות ההצלבה</DialogTitle>
        <DialogContent>
          {applyDlg.error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              <AlertTitle>
                {applyDlg.error.code === 'WOULD_DROP_ALL'
                  ? 'ההצלבה פוסלת את כולם — נעצר'
                  : 'לא ניתן להחיל את המסקנות'}
              </AlertTitle>
              {applyDlg.error.message}
            </Alert>
          )}
          {!applyDlg.result ? (
            <>
              <Alert severity="warning" sx={{ mb: 2 }}>
                <AlertTitle>מה תעשה הפעולה</AlertTitle>
                כל מי שההצלבה פוסלת — נרשם ללא אישור תמ"ת, ביטל רישום, או החלטת תמ"ת שאינה אישור —
                יסומן בתור קליקטאק כ"לא רלוונטי" עם הסיבה, ולא יוצע יותר לקליטה.
                כל מי שמאושר ונפסל בעבר בטעות — יוחזר לרשימת הממתינים.
              </Alert>
              <Alert severity="info">
                ילדים שכבר נקלטו למערכת כרישום <b>לא ישונו</b>. הוצאת ילד שכבר נקלט משמעה סגירת רישום,
                ביטול הוראת קבע ופינוי מקום בכיתה — הפעולה תציג אותם ברשימה נפרדת להחלטה שלך.
              </Alert>
            </>
          ) : (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>
                סומנו כלא רלוונטיים: {applyDlg.result.dropped} · הוחזרו לממתינים: {applyDlg.result.restored}
              </Alert>
              {!!applyDlg.result.needs_manual?.length && (
                <Alert severity="warning">
                  <AlertTitle>דורש טיפול ידני — כבר נקלטו למערכת</AlertTitle>
                  {applyDlg.result.needs_manual.map(m => (
                    <Typography key={m.id_number} variant="body2">
                      {m.child_name} ({m.id_number}) — {m.verdict_label}
                    </Typography>
                  ))}
                </Alert>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApplyDlg({ open: false, saving: false, result: null, error: null })}>סגירה</Button>
          {!applyDlg.result && applyDlg.error?.code === 'WOULD_DROP_ALL' && (
            <Button variant="outlined" color="error" disabled={applyDlg.saving}
              onClick={() => handleApply(true)}>
              {applyDlg.saving ? 'מחיל…' : `בדקתי — לפסול את כל ${applyDlg.error.queueSize}`}
            </Button>
          )}
          {!applyDlg.result && applyDlg.error?.code !== 'WOULD_DROP_ALL' && (
            <Button variant="contained" color="warning" onClick={() => handleApply()} disabled={applyDlg.saving}>
              {applyDlg.saving ? 'מחיל…' : 'החלה'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* ---- היסטוריית העלאות ---- */}
      <Dialog open={historyDlg.open} onClose={() => setHistoryDlg({ open: false, loading: false, imports: [] })} maxWidth="md" fullWidth>
        <DialogTitle>היסטוריית העלאות</DialogTitle>
        <DialogContent>
          {historyDlg.loading ? <CircularProgress /> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מקור</TableCell><TableCell>תאריך</TableCell><TableCell>קובץ</TableCell>
                  <TableCell>שורות</TableCell><TableCell>חדשים</TableCell><TableCell>עודכנו</TableCell>
                  <TableCell>ירדו</TableCell><TableCell>מעון אחר</TableCell><TableCell>מי העלה</TableCell>
                  {canImport && <TableCell />}
                </TableRow>
              </TableHead>
              <TableBody>
                {historyDlg.imports.map(i => (
                  <TableRow key={i.id}>
                    <TableCell sx={NOWRAP}>
                      {i.source === 'tmt' ? 'תמ"ת' : `קליקטאק — ${SOURCE_LABEL[i.export_type || 'registrations']}`}
                    </TableCell>
                    <TableCell sx={NOWRAP}>{fmtDateTime(i.created_at)}</TableCell>
                    <TableCell>{i.file_name}</TableCell>
                    <TableCell>{i.parsed}</TableCell>
                    <TableCell>{i.created}</TableCell>
                    <TableCell>{i.updated}</TableCell>
                    <TableCell>{i.missing}</TableCell>
                    <TableCell>{i.details?.other_institution?.length || ''}</TableCell>
                    <TableCell>{i.imported_by_name}</TableCell>
                    {/* Only the latest upload of each kind can be undone — see
                        undoableIds. */}
                    {canImport && (
                      <TableCell>
                        {undoableIds.has(i.id) && (
                          <Tooltip title="ביטול ההעלאה — מחיקת מה שנוצר והחזרת מה שהשתנה">
                            <IconButton size="small" color="error"
                              onClick={() => setUndoDlg({ open: true, imp: i, saving: false, result: null, error: null })}>
                              <UndoIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {!historyDlg.imports.length && (
                  <TableRow><TableCell colSpan={10} align="center">אין העלאות</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryDlg({ open: false, loading: false, imports: [] })}>סגירה</Button>
        </DialogActions>
      </Dialog>

      {/* ---- ביטול העלאה ---- */}
      <Dialog open={undoDlg.open} onClose={() => setUndoDlg({ open: false, imp: null, saving: false, result: null, error: null })} maxWidth="sm" fullWidth>
        <DialogTitle>ביטול העלאה</DialogTitle>
        <DialogContent>
          {undoDlg.imp && !undoDlg.result && (
            <>
              <Alert severity="warning" sx={{ mb: 2 }}>
                <AlertTitle>{undoDlg.imp.file_name}</AlertTitle>
                הועלה ב־{fmtDateTime(undoDlg.imp.created_at)}
                {undoDlg.imp.imported_by_name ? ` על ידי ${undoDlg.imp.imported_by_name}` : ''}.
                <Box sx={{ mt: 1 }}>
                  הביטול ימחק את <b>{undoDlg.imp.created}</b> הרשומות שהקובץ יצר,
                  יחזיר את <b>{undoDlg.imp.updated}</b> הרשומות שהוא שינה למצבן הקודם,
                  ויחזיר לרשימה את <b>{undoDlg.imp.missing}</b> הרשומות שהוא סימן כמי שירדו.
                </Box>
              </Alert>
              {!undoDlg.imp.exact_undo && (undoDlg.imp.updated > 0 || undoDlg.imp.missing > 0) && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  העלאה זו נעשתה לפני שהמערכת שמרה עותק של השורות ששונו. הביטול ימחק רק את מה שנוצר;
                  שורות שעודכנו יישארו כפי שהן.
                </Alert>
              )}
              {undoDlg.error && (
                <Alert severity="error">
                  {undoDlg.error}
                  {!!undoDlg.names?.length && <Box sx={{ mt: 0.5 }}>{undoDlg.names.join(', ')}</Box>}
                </Alert>
              )}
            </>
          )}
          {undoDlg.result && (
            <Alert severity="success">
              <AlertTitle>ההעלאה בוטלה</AlertTitle>
              נמחקו {undoDlg.result.deleted} רשומות · הוחזרו {undoDlg.result.restored} רשומות למצבן הקודם
              {!!undoDlg.result.names?.length && <Box sx={{ mt: 0.5 }}>{undoDlg.result.names.join(', ')}</Box>}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUndoDlg({ open: false, imp: null, saving: false, result: null, error: null })}>סגירה</Button>
          {!undoDlg.result && (
            <Button variant="contained" color="error" onClick={handleUndo} disabled={undoDlg.saving}>
              {undoDlg.saving ? 'מבטל…' : 'ביטול ההעלאה'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* ---- דף קשר ---- */}
      <Dialog open={contactsDlg.open} onClose={() => setContactsDlg({ open: false, loading: false, rows: [] })} maxWidth="lg" fullWidth>
        <DialogTitle>דף קשר — מאושרים לשנה הבאה ({contactsDlg.rows.length})</DialogTitle>
        <DialogContent>
          {contactsDlg.loading ? <CircularProgress /> : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ילד/ה</TableCell><TableCell>שכבה</TableCell>
                  <TableCell>הורה 1</TableCell><TableCell>טלפון</TableCell>
                  <TableCell>הורה 2</TableCell><TableCell>טלפון</TableCell>
                  <TableCell>מייל</TableCell><TableCell>כתובת</TableCell>
                  <TableCell>איש קשר תמ"ת</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {contactsDlg.rows.map(c => (
                  <TableRow key={c.id_number}>
                    <TableCell>{c.child_name}</TableCell>
                    <TableCell>{c.age_group}</TableCell>
                    <TableCell>{c.parent1_name}</TableCell>
                    <TableCell>{c.parent1_phone}</TableCell>
                    <TableCell>{c.parent2_name}</TableCell>
                    <TableCell>{c.parent2_phone}</TableCell>
                    <TableCell>{c.parent1_email}</TableCell>
                    <TableCell>{c.address}</TableCell>
                    <TableCell>{c.tmt_contact_name} {c.tmt_contact_phone}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button startIcon={<DownloadIcon />} onClick={handleExport}>ייצוא לאקסל</Button>
          <Button onClick={() => setContactsDlg({ open: false, loading: false, rows: [] })}>סגירה</Button>
        </DialogActions>
      </Dialog>

      {/* The same papers the חייבים table shows, on the same record. */}
      <DebtDocumentsDialog
        open={Boolean(docsRow)}
        row={docsRow}
        canEdit={canImport}
        onClose={() => setDocsRow(null)}
      />
    </Box>
  );
}
