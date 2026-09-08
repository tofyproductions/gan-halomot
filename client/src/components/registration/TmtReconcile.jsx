import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Card, Stack, Chip, Button, TextField, InputAdornment, MenuItem,
  Table, TableHead, TableBody, TableRow, TableCell, Dialog, DialogTitle, DialogContent,
  DialogActions, Alert, AlertTitle, CircularProgress, Tooltip, IconButton, Divider,
  ToggleButton, ToggleButtonGroup, List, ListItem, ListItemText,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import HistoryIcon from '@mui/icons-material/History';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatAcademicYear, getEnrollmentYear } from '../../hooks/useAcademicYear';

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
};

const SEVERITY_COLOR = { critical: 'error', warning: 'warning', info: 'info', ok: 'default' };

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
  const card = (last4) => (last4 ? ` · כרטיס ****${last4}` : '');
  const lines = [
    `שכ"ל: ${terms.tuition_method || 'לא נרשם'}${card(terms.tuition_card_last4)}`,
  ];
  if (terms.registration_fee_method || terms.registration_fee_amount) {
    lines.push([
      `דמי רישום: ${terms.registration_fee_method || 'לא נרשם'}`,
      terms.registration_fee_amount ? fmtMoney(terms.registration_fee_amount) : '',
      terms.receipt_number ? `קבלה ${terms.receipt_number}` : '',
    ].filter(Boolean).join(' · '));
  }
  if (terms.standing_order_status) {
    lines.push(`הו"ק: ${SO_LABEL[terms.standing_order_status] || terms.standing_order_status}`);
  }
  if (terms.voucher_number) lines.push(`שובר: ${terms.voucher_number}`);
  lines.push(`${terms.continuing ? 'ילד/ה ממשיך/ה' : 'רישום חדש'}`
    + (terms.second_signer ? ` · חותם שני: ${terms.second_signer}` : ''));
  return lines;
}

/** A count that is only worth showing when it is not zero. */
function StatCard({ label, value, color, onClick, active, hint }) {
  return (
    <Card
      onClick={onClick}
      sx={{
        p: 1.5, minWidth: 132, cursor: onClick ? 'pointer' : 'default',
        border: 2, borderColor: active ? `${color}.main` : 'transparent',
        bgcolor: active ? `${color}.50` : 'background.paper',
      }}
    >
      <Typography variant="h5" color={`${color}.main`} fontWeight={700}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      {hint && <Typography variant="caption" display="block" color="text.disabled">{hint}</Typography>}
    </Card>
  );
}

/** שני הייצואים של קליקטאק, בשם שהמשרד קורא להם. */
const SOURCE_LABEL = { registrations: 'נרשמים', contracts: 'חוזים' };

/** The counts behind one upload, on one line. */
function ImportLine({ imp }) {
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      {imp.file_name} · {imp.parsed} שורות · חדשים {imp.created} · עודכנו {imp.updated} ·
      {' '}ללא שינוי {imp.unchanged}
      {/* The contracts export never reports anyone as gone — its silence about
          a child is not evidence, since the two files list different
          populations at different moments. */}
      {imp.export_type === 'contracts' ? '' : ` · הוסרו ${imp.missing}`}
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

  const [uploadDlg, setUploadDlg] = useState({ open: false, file: null, saving: false, result: null });
  const [detail, setDetail] = useState(null);
  const [applyDlg, setApplyDlg] = useState({ open: false, saving: false, result: null, error: null });
  const [historyDlg, setHistoryDlg] = useState({ open: false, loading: false, imports: [] });
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

  const rows = data?.rows || [];
  const summary = data?.summary || {};

  const visible = useMemo(() => rows.filter(r => {
    if (verdictFilter && r.verdict !== verdictFilter) return false;
    if (issueFilter && !r.issues.some(i => i.code === issueFilter)) return false;
    if (missingParentsOnly && !r.clicktac?.missing_parents) return false;
    // Errors only — the card counts errors only, and a filter that shows more
    // rows than the number on the card it sits under is a bug the office
    // reports as "the screen is lying".
    if (paymentAlertOnly && r.clicktac?.payment_alert?.severity !== 'error') return false;
    if (chequeOnly && r.clicktac?.payment_method_kind?.kind !== 'cheque') return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.child_name.toLowerCase().includes(q) || String(r.id_number).includes(q);
  }), [rows, verdictFilter, issueFilter, missingParentsOnly, paymentAlertOnly, chequeOnly, search]);

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

  return (
    <Box sx={{ p: 2 }}>
      {!embedded && (
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" sx={{ mb: 2 }}>
          <Typography variant="h5" fontWeight={700}>הצלבת תמ"ת מול קליקטאק</Typography>
          <TextField
            select size="small" label="סניף" value={branchId}
            onChange={e => setBranchId(e.target.value)} sx={{ minWidth: 200 }}
          >
            {branches.map(b => (
              <MenuItem key={b.id || b._id} value={b.id || b._id}>{b.name}</MenuItem>
            ))}
          </TextField>
          <Chip variant="outlined" label={`שנת ${formatAcademicYear(year)}`} />
          <Box sx={{ flex: 1 }} />
          <Button startIcon={<UploadFileIcon />} variant="contained"
            onClick={() => setUploadDlg({ open: true, file: null, saving: false, result: null })}>
            העלאת קובץ תמ"ת
          </Button>
          <Tooltip title="רענון"><span>
            <IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton>
          </span></Tooltip>
        </Stack>
      )}

      <Alert severity="info" sx={{ mb: 2 }}>
        ילד נקלט לשנה הבאה רק אם הוא מופיע גם ברשימת האישורים של משרד התמ"ת וגם ברישום בקליקטאק.
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

      {data && !loading && (
        <>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <StatCard label="מאושרים לשנה הבאה" value={summary.approved || 0} color="success"
              active={verdictFilter === 'approved'} hint={`${summary.clean || 0} ללא חריגות`}
              onClick={() => setVerdictFilter(verdictFilter === 'approved' ? '' : 'approved')} />
            <StatCard label='אושר בתמ"ת — לא נרשם' value={summary.missing_registration || 0} color="error"
              active={verdictFilter === 'missing_registration'} hint="להתקשר להורים"
              onClick={() => setVerdictFilter(verdictFilter === 'missing_registration' ? '' : 'missing_registration')} />
            <StatCard label='נרשם — אין אישור תמ"ת' value={summary.missing_approval || 0} color="error"
              active={verdictFilter === 'missing_approval'} hint="לא ניתן לקלוט"
              onClick={() => setVerdictFilter(verdictFilter === 'missing_approval' ? '' : 'missing_approval')} />
            <StatCard label="ביטלו רישום" value={summary.cancelled || 0} color="warning"
              active={verdictFilter === 'cancelled'} hint={`${summary.places_freed || 0} מקומות התפנו`}
              onClick={() => setVerdictFilter(verdictFilter === 'cancelled' ? '' : 'cancelled')} />
            <StatCard label='ללא אישור בתמ"ת' value={summary.not_approved || 0} color="error"
              active={verdictFilter === 'not_approved'}
              onClick={() => setVerdictFilter(verdictFilter === 'not_approved' ? '' : 'not_approved')} />
            <StatCard label='הוסרו מרשימת התמ"ת' value={summary.withdrawn || 0} color="error"
              active={verdictFilter === 'withdrawn'} hint="האישור בוטל"
              onClick={() => setVerdictFilter(verdictFilter === 'withdrawn' ? '' : 'withdrawn')} />
            <StatCard label='להזין תאריך כניסה בתמ"ת' value={summary.needs_absorption_date || 0} color="warning"
              active={issueFilter === 'needs_absorption_date'} hint={`${summary.absorbed || 0} כבר עם תאריך`}
              onClick={() => setIssueFilter(issueFilter === 'needs_absorption_date' ? '' : 'needs_absorption_date')} />
            {/* Registered in ClickTac's CONTRACTS export and nowhere else.
                Not "call these families" — there is nobody to call yet, since
                the contracts export has no parent in it. The fix is the other
                upload, and the hint says so. */}
            <StatCard label="חסר פרטי הורים" value={summary.missing_parents || 0} color="error"
              active={missingParentsOnly} hint="להעלות גם את ייצוא הנרשמים"
              onClick={() => setMissingParentsOnly(v => !v)} />
            {/* מזומן אינו מתקבל, ומשפחה בלי אמצעי תשלום צריכה טלפון — שתי
                עובדות שהיו בקובץ מהיום הראשון ואף אחד לא ראה אותן. Red only
                when there is something to do: a branch where every family is
                on a credit card should not have a red card sitting there.

                The cheques ride in the hint rather than in the number: they
                are accepted, and the number on this card is the list of calls
                that have to be made. */}
            <StatCard label="אמצעי תשלום" value={summary.payment_alerts || 0}
              color={summary.payment_alerts ? 'error' : 'info'}
              active={paymentAlertOnly}
              hint={`לטיפול ${summary.payment_alerts || 0} · צ'קים ${summary.payment_warnings || 0}`}
              onClick={() => setPaymentAlertOnly(v => !v)} />
            <StatCard label="שובצו ידנית" value={summary.placed_by_hand || 0} color="info"
              hint="החלטה שלך על הכיתה" />
            <StatCard label="נקלטו כבר למערכת" value={summary.already_imported || 0} color="info" />
          </Stack>

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
                <ToggleButton key={code} value={code}>
                  {data.dictionaries?.issues?.[code]?.label || code} ({count})
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
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
            <Button size="small" startIcon={<HistoryIcon />} onClick={openHistory}>היסטוריית העלאות</Button>
            <Button size="small" startIcon={<ContactPhoneIcon />} onClick={openContacts}>דף קשר</Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={handleExport}>ייצוא לאקסל</Button>
            {canImport && (
              <Button size="small" variant="outlined" color="warning" startIcon={<PlaylistAddCheckIcon />}
                onClick={() => setApplyDlg({ open: true, saving: false, result: null, error: null })}>
                החלת המסקנות
              </Button>
            )}
          </Stack>

          {(lastTmt || lastCt) && (
            <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <Card sx={{ p: 1.5, flex: 1, minWidth: 280 }}>
                <Typography variant="subtitle2" fontWeight={700}>
                  קובץ תמ"ת אחרון — {lastTmt ? fmtDateTime(lastTmt.created_at) : 'טרם הועלה'}
                </Typography>
                {lastTmt && <ImportLine imp={lastTmt} />}
                {!!lastTmt?.details?.missing?.length && (
                  <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                    ירדו מהרשימה: {lastTmt.details.missing.join(', ')}
                  </Alert>
                )}
              </Card>

              {/* Two lines, because there are two ClickTac files and they are
                  uploaded separately. A branch current on one and stale on the
                  other used to read as "up to date". */}
              <Card sx={{ p: 1.5, flex: 1, minWidth: 280 }}>
                <Typography variant="subtitle2" fontWeight={700}>קובץ קליקטאק אחרון</Typography>
                {[['נרשמים', lastCtReg], ['חוזים', lastCtContracts]].map(([label, imp]) => (
                  <Box key={label} sx={{ mt: 0.5 }}>
                    <Typography variant="body2" fontWeight={600}
                      color={imp ? 'text.primary' : 'text.disabled'}>
                      {label} — {imp ? fmtDateTime(imp.created_at) : 'טרם הועלה'}
                    </Typography>
                    {imp && <ImportLine imp={imp} />}
                  </Box>
                ))}
                {!!lastCtReg?.details?.missing?.length && (
                  <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                    ירדו מהרשימה: {lastCtReg.details.missing.join(', ')}
                  </Alert>
                )}
              </Card>
            </Stack>
          )}

          {/* ELEVEN COLUMNS DO NOT FIT IN 1440px AND SHOULD NOT TRY. Squeezing
              them wrapped the name to two lines, the age to four and the dates
              to two, and a table whose every row is four lines tall cannot be
              scanned — which is the whole job of this screen. The table keeps
              its natural width and the container scrolls sideways. */}
          <Card sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 1320 }}>
              <TableHead>
                <TableRow sx={{ '& th': NOWRAP }}>
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
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(r => (
                  <TableRow key={r.id_number} hover>
                    <TableCell sx={NOWRAP}>{r.child_name}</TableCell>
                    <TableCell sx={NOWRAP}>{r.id_number}</TableCell>
                    {/* The source of the birth date used to be a second line
                        under every date in the table — sixty repetitions of
                        "לפי תמ"ת" to answer a question asked about two rows.
                        It is a tooltip now. */}
                    <TableCell sx={NOWRAP}>
                      <Tooltip title={r.age_source ? `תאריך הלידה לפי ${r.age_source}` : ''}>
                        <span>{fmtDate(r.birth_date)}</span>
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
                        {r.issues.map(i => (
                          <Tooltip key={i.code} title={i.detail || ''}>
                            <Chip size="small" variant="outlined" label={i.label}
                              color={SEVERITY_COLOR[i.severity] || 'default'} sx={TIGHT_CHIP} />
                          </Tooltip>
                        ))}
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
                            <Typography variant="body2" sx={NOWRAP}>{r.clicktac.status}</Typography>
                            {/* The row exists because a contract was signed and
                                nothing else — no parent, no phone, no payment
                                method. It cannot be promoted, and saying so
                                here is cheaper than finding out at the import
                                button. */}
                            {r.clicktac.missing_parents && (
                              <Tooltip title="הילד/ה מופיע/ה רק בייצוא החוזים של קליקטאק. יש לקלוט גם את ייצוא הנרשמים כדי לקבל הורים, טלפון ואמצעי תשלום.">
                                <Chip size="small" color="error" label="חסר פרטי הורים" sx={TIGHT_CHIP} />
                              </Tooltip>
                            )}
                            {/* מאיזה קובץ הגיע/ה — פר שורה, ולא רק כתאריך
                                בכרטיס למעלה. שתי השורות נראות זהות בטבלה, וזה
                                מה שמסביר למה לאחת יש דרגה ולשנייה טלפון. */}
                            <Stack direction="row" spacing={0.5}>
                              {(r.clicktac.sources || []).map(src => (
                                <Chip key={src} size="small" variant="outlined"
                                  sx={{ height: 18, fontSize: '0.65rem' }}
                                  label={SOURCE_LABEL[src] || src} />
                              ))}
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
                      <IconButton size="small" onClick={() => setDetail(r)}><VisibilityIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {!visible.length && (
                  <TableRow><TableCell colSpan={12} align="center" sx={{ py: 3 }}>
                    <Typography color="text.secondary">אין רשומות להצגה</Typography>
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
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
      <Dialog open={!!detail} onClose={() => setDetail(null)} maxWidth="md" fullWidth>
        {detail && (
          <>
            <DialogTitle>
              {detail.child_name}
              <Chip size="small" sx={{ mr: 1 }} label={detail.verdict_label}
                color={VERDICT_STYLE[detail.verdict]?.color || 'default'} />
            </DialogTitle>
            <DialogContent>
              <Alert severity={detail.verdict === 'approved' ? 'success' : 'warning'} sx={{ mb: 2 }}>
                {detail.verdict_action}
              </Alert>

              {!!detail.issues.length && (
                <Card variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>חריגות</Typography>
                  {detail.issues.map(i => (
                    <Typography key={i.code} variant="body2">
                      • {i.label}{i.detail ? ` — ${i.detail}` : ''}
                    </Typography>
                  ))}
                </Card>
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
                      <Typography variant="body2">
                        {detail.clicktac.parent1_name} · {detail.clicktac.parent1_phone}
                      </Typography>
                      <Typography variant="body2">
                        {detail.clicktac.parent2_name} · {detail.clicktac.parent2_phone}
                      </Typography>
                      <Typography variant="body2">{detail.clicktac.address}</Typography>

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
            </DialogContent>
            <DialogActions><Button onClick={() => setDetail(null)}>סגירה</Button></DialogActions>
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
                  <TableCell>ירדו</TableCell><TableCell>מי העלה</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {historyDlg.imports.map(i => (
                  <TableRow key={i.id}>
                    <TableCell>{i.source === 'tmt' ? 'תמ"ת' : 'קליקטאק'}</TableCell>
                    <TableCell>{fmtDateTime(i.created_at)}</TableCell>
                    <TableCell>{i.file_name}</TableCell>
                    <TableCell>{i.parsed}</TableCell>
                    <TableCell>{i.created}</TableCell>
                    <TableCell>{i.updated}</TableCell>
                    <TableCell>{i.missing}</TableCell>
                    <TableCell>{i.imported_by_name}</TableCell>
                  </TableRow>
                ))}
                {!historyDlg.imports.length && (
                  <TableRow><TableCell colSpan={8} align="center">אין העלאות</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryDlg({ open: false, loading: false, imports: [] })}>סגירה</Button>
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
    </Box>
  );
}
