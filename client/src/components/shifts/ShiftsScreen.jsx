import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Stack, Button, IconButton, Typography, Alert, CircularProgress, Chip, Paper, ToggleButton, ToggleButtonGroup } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useUrlState } from '../../hooks/useUrlState';
import useFetchSeq from '../../hooks/useFetchSeq';
import PageHeader from '../ui/PageHeader';
import ShiftGrid from './ShiftGrid';
import EmployeeSidebar from './EmployeeSidebar';
import EntryDialog from './EntryDialog';
import PrimaryClassDialog from './PrimaryClassDialog';
import OvertimeStrip from './OvertimeStrip';
import StaffBalanceStrip from './StaffBalanceStrip';
import ManualConstraintDialog from './ManualConstraintDialog';
import FillSuggestions from './FillSuggestions';
import ShiftSettingsDialog from './ShiftSettingsDialog';
import EditRequestsPanel from './EditRequestsPanel';
import ConstraintsPanel from './ConstraintsPanel';
import FutureConstraintsDialog from './FutureConstraintsDialog';
import CrossBranchPanel from './CrossBranchPanel';
import RateRequestDialog from './RateRequestDialog';
import AttendanceReportDialog from './AttendanceReportDialog';
import { exportPdf, exportPng, shareWhatsApp } from './shiftExport';
import { buildRows, buildAwayRow, switchedSet, fmtDate, rowKeyOf, toMin } from './shiftRows';

const NO_DEFAULTS = {};
const newTmp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const entryRowKey = (e) => rowKeyOf({ ...e, classroom_id: e.classroom_id ? String(e.classroom_id) : null });
const weekdayOf = (ymd) => new Date(`${ymd}T12:00`).getDay();
// The board's one noon: 14:00, the same line the בוקר/צהריים switch cuts on.
const PM_MIN = 14 * 60;

/** The Sunday of the week containing `date` (local), as YYYY-MM-DD. */
function sundayOf(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return sundayOf(new Date(y, m - 1, d + n));
}

/** Local yesterday (Friday when today is Sunday) as YYYY-MM-DD. */
function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1); // Saturday is not a working day: use Friday
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ShiftsScreen() {
  const { selectedBranch, isAllBranches } = useBranch();
  // Default: next week — the one being planned.
  const [weekParam, setWeek] = useUrlState('week', addDays(sundayOf(), 7));
  // Whatever is in the URL, work with the Sunday of that week.
  const week = /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? addDays(weekParam, 0) : addDays(sundayOf(), 7);
  const { begin, isCurrent } = useFetchSeq();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedBranch || isAllBranches) return;
    const seq = begin();
    setLoading(true);
    try {
      const { data } = await api.get('/shifts/board', { params: { branch: selectedBranch, week } });
      if (!isCurrent(seq)) return; // a newer request exists — drop this answer
      setBoard(data);
    } catch (err) {
      if (!isCurrent(seq)) return;
      toast.error(err.response?.data?.error || 'שגיאה בטעינת הסידור');
      setBoard(null);
    } finally {
      if (isCurrent(seq)) setLoading(false);
    }
  }, [selectedBranch, isAllBranches, week, begin, isCurrent]);
  useEffect(() => { load(); }, [load]);

  // What the clock recorded this week ({ employee_id: { date: { in, out } } }) — drawn on the chips.
  const [actual, setActual] = useState({});
  useEffect(() => {
    if (!board?.branch_id) { setActual({}); return undefined; }
    let on = true;
    api.get('/shifts/actual', { params: { branch: board.branch_id, week } })
      .then(res => { if (on) setActual(res.data.actual || {}); })
      .catch(() => { if (on) setActual({}); });
    return () => { on = false; };
  }, [board, week]);

  // בוקר / צהריים — dims shifts outside the window; the cuts live in ShiftGrid
  // (morning starts before 13:00, afternoon means staying past 14:00).
  const [shiftView, setShiftView] = useState('all');

  // The floating copy of the view pill: shown once its in-flow anchor scrolls
  // off screen, so the switch is reachable from the bottom of a long board.
  const viewPillAnchor = useRef(null);
  const [pillFloating, setPillFloating] = useState(false);
  useEffect(() => {
    const el = viewPillAnchor.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(([entry]) => setPillFloating(!entry.isIntersecting));
    obs.observe(el);
    return () => obs.disconnect();
  }, [board]);

  const viewPill = (
    <Paper elevation={6} sx={{
      display: 'inline-flex', borderRadius: 999, px: 0.5, py: 0.4,
      border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper',
    }}>
      <ToggleButtonGroup size="small" exclusive value={shiftView}
        onChange={(_, v) => setShiftView(v || 'all')}
        sx={{
          '& .MuiToggleButton-root': {
            border: 0, borderRadius: 999, px: 1.5, fontWeight: 700, whiteSpace: 'nowrap',
          },
          '& .MuiToggleButton-root.Mui-selected': {
            bgcolor: 'primary.main', color: 'primary.contrastText',
            '&:hover': { bgcolor: 'primary.dark' },
          },
        }}>
        <ToggleButton value="all">הכל</ToggleButton>
        <ToggleButton value="am">☀️ בוקר (עד 14:00)</ToggleButton>
        <ToggleButton value="pm">🌙 צהריים (אחרי 14:00)</ToggleButton>
      </ToggleButtonGroup>
    </Paper>
  );

  const [draft, setDraft] = useState(null);          // working entries while editing
  const [dlg, setDlg] = useState({ open: false, entry: null, defaults: null });
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const [placementOpen, setPlacementOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [futureOpen, setFutureOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [manualConstraintOpen, setManualConstraintOpen] = useState(false);
  const [rateEmployeeId, setRateEmployeeId] = useState(null);
  const [reportDate, setReportDate] = useState(() => {
    const r = new URLSearchParams(window.location.search).get('report');
    return r && /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : null;
  });
  const primaryDismissed = useRef(new Set());         // branches where she chose "later"
  useEffect(() => { setDraft(board?.week ? board.week.entries : null); }, [board]);
  useEffect(() => {
    if (board?.can_edit && board.pending_primary.length && !primaryDismissed.current.has(selectedBranch)) setPrimaryOpen(true);
  }, [board, selectedBranch]);

  const entries = board ? (board.week ? board.week.entries : board.preview) : [];
  const editable = !!(board?.week && (board.can_edit || board.can_request));
  const shown = draft || entries;
  const dirty = !!(draft && board?.week && draft !== board.week.entries);
  const rows = useMemo(() => (board ? buildRows({ entries: shown, classrooms: board.classrooms }) : []), [board, shown]);
  const gridRows = useMemo(() => [...rows, ...(board?.away?.length ? [buildAwayRow(board.away)] : [])], [rows, board]);
  const switched = useMemo(() => switchedSet(shown), [shown]);
  const alerts = useMemo(() => {
    // Constraint OBJECTS, not text: the grid decides per entry whether one
    // actually stands in its way (a morning shift does not conflict with an
    // approved 14:00–16:00 window), so an applied constraint stops nagging.
    const m = new Map();
    for (const c of board?.constraints || []) {
      if (!['open', 'accepted', 'pending_broadcast', 'broadcast'].includes(c.status)) continue;
      const key = `${c.employee_id}|${c.date}`;
      m.set(key, [...(m.get(key) || []), c]);
    }
    return m;
  }, [board]);
  const closed = useMemo(() => new Set(board?.closed_dates || []), [board]);

  // Sick days per employee+date, ranges unrolled. 'approved' outranks a
  // pending status for the label when two requests overlap.
  const sickDays = useMemo(() => {
    const m = new Map();
    for (const s of board?.sick_days || []) {
      for (const d of board.dates || []) {
        if (s.from_date <= d && d <= s.to_date) {
          const key = `${s.employee_id}|${d}`;
          if (!m.has(key) || s.status === 'approved') m.set(key, s.status);
        }
      }
    }
    return m;
  }, [board]);

  const exportArgs = board && { branchName: board.branch_name, dates: board.dates, rows, switched, closedDates: closed };

  const openWeek = async () => {
    try {
      await api.post('/shifts/weeks', { branch: selectedBranch, week });
      toast.success('הסידור נפתח לפי ההתחייבויות');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בפתיחת הסידור'); }
  };

  const closeDlg = () => setDlg({ open: false, entry: null, defaults: null });
  const sameEntry = (a, b) => a === b || (a._id && a._id === b._id) || (a.tmp && a.tmp === b.tmp);
  const clean = (list) => list.map(({ tmp, ...e }) => e);

  const persist = async (next) => {
    if (board.can_edit) {
      try {
        const { data } = await api.put(`/shifts/weeks/${board.week._id}/entries`, { entries: clean(next) });
        setDraft(data.week.entries);
        load();
      } catch (err) {
        toast.error(err.response?.data?.error || 'שמירה נכשלה');
        if (err.response?.data?.needs_rate && board.can_edit) { setRateEmployeeId(String(err.response.data.needs_rate)); setRateOpen(true); }
      }
    } else {
      setDraft(next); // office: edits stay local until sent as a request
    }
  };
  const saveEntry = (form) => {
    const next = form._id || form.tmp
      ? shown.map(e => (sameEntry(e, form) ? form : e))
      : [...shown, { ...form, tmp: newTmp() }];
    closeDlg();
    persist(next);
  };

  /**
   * The dialog's split: one block becomes two at the chosen hour — the first
   * keeps its room and ends at the cut, the second starts there, ends where
   * the whole shift used to, and lives in the chosen row. Any hour, any row
   * — the 14:00 drag-split is the shortcut, this is the general tool.
   */
  const splitEntry = (entry, { at, area, classroom_id }) => {
    closeDlg();
    const next = shown.map(e => (sameEntry(e, entry) ? { ...e, end_hhmm: at } : e));
    persist([...next, {
      employee_id: entry.employee_id, employee_name: entry.employee_name,
      date: entry.date, area, classroom_id, start_hhmm: at, end_hhmm: entry.end_hhmm, tmp: newTmp(),
    }]);
  };

  // 🤒 → she filed a sick day here, and still chose to work: the manager
  // confirms it on the entry itself. A second click takes it back.
  const toggleSickOk = (entry) => {
    const q = entry.sick_ok
      ? `לבטל את האישור? השיבוץ של ${entry.employee_name} ב-${entry.date} יסומן שוב כמתנגש עם יום המחלה.`
      : `${entry.employee_name} הגישה מחלה ליום הזה. היא בחרה לעבוד בכל זאת — לאשר את השיבוץ?`;
    if (!window.confirm(q)) return;
    persist(shown.map(e => (sameEntry(e, entry) ? { ...e, sick_ok: !entry.sick_ok } : e)));
  };
  const deleteEntry = (entry) => {
    closeDlg();
    persist(shown.filter(e => !sameEntry(e, entry)));
  };
  // One click on a fill suggestion — added with her committed hours for that weekday.
  const addSuggested = (emp, date, classroomId) => {
    const hours = (emp.commitment || {})[weekdayOf(date)] || { start_hhmm: '07:00', end_hhmm: '16:00' };
    persist([...shown, {
      employee_id: emp._id, employee_name: emp.full_name, date,
      area: 'class', classroom_id: classroomId,
      start_hhmm: hours.start_hhmm, end_hhmm: hours.end_hhmm, tmp: newTmp(),
    }]);
  };
  // Drag and drop on the board: move a shift (Shift = her whole week in that
  // row), or drop someone from the side list (Shift = every open day she is
  // committed to). Saved through persist like any other edit.
  const onDropToCell = (row, date, payload, { shiftKey } = {}) => {
    const target = { area: row.area, classroom_id: row.area === 'class' ? row.classroom_id : null };
    const targetKey = entryRowKey(target);
    if (payload.kind === 'entry') {
      const dragged = shown.find(e => String(e._id || e.tmp) === payload.key);
      if (!dragged) return;
      if (shiftKey) {
        const fromKey = entryRowKey(dragged);
        if (fromKey === targetKey) return;
        const next = shown.map(e => (String(e.employee_id) === String(dragged.employee_id) && entryRowKey(e) === fromKey ? { ...e, ...target } : e));
        persist(next);
      } else {
        if (dragged.date === date && entryRowKey(dragged) === targetKey) return;
        /**
         * The split, undone: dragging one of her entries onto a row where
         * she already stands THAT DAY folds the two back into one shift —
         * earliest start to latest end, living in the target row.
         */
        const counterpart = shown.find(e =>
          e !== dragged && String(e.employee_id) === String(dragged.employee_id) &&
          e.date === date && entryRowKey(e) === targetKey);
        if (counterpart) {
          const starts = [dragged, counterpart].sort((x, y) => (toMin(x.start_hhmm) ?? 0) - (toMin(y.start_hhmm) ?? 0));
          const ends = [dragged, counterpart].sort((x, y) => (toMin(y.end_hhmm) ?? 0) - (toMin(x.end_hhmm) ?? 0));
          if (!window.confirm(
            `לאחד את שתי המשמרות של ${dragged.employee_name || 'העובדת'}?
` +
            `תיווצר משמרת אחת ${starts[0].start_hhmm}–${ends[0].end_hhmm} ב"${row.label}".`,
          )) return;
          persist(shown
            .filter(e => e !== dragged)
            .map(e => (e === counterpart ? { ...e, start_hhmm: starts[0].start_hhmm, end_hhmm: ends[0].end_hhmm } : e)));
          return;
        }
        persist(shown.map(e => (e === dragged ? { ...e, ...target, date } : e)));
      }
      return;
    }
    if (payload.kind === 'employee') {
      const emp = (board.employees || []).find(e => String(e._id) === String(payload.employee_id));
      if (!emp) return;
      const commitment = emp.commitment || {};
      const make = (d) => {
        const hours = commitment[weekdayOf(d)] || { start_hhmm: '07:00', end_hhmm: '16:00' };
        return { employee_id: emp._id, employee_name: emp.full_name, date: d, ...target, start_hhmm: hours.start_hhmm, end_hhmm: hours.end_hhmm, tmp: newTmp() };
      };
      if (shiftKey) {
        const has = new Set(shown.filter(e => String(e.employee_id) === String(emp._id)).map(e => e.date));
        const added = board.dates.filter(d => !closed.has(d) && commitment[weekdayOf(d)] && !has.has(d)).map(make);
        if (!added.length) { toast.info('אין ימי התחייבות פנויים לשבץ אותה השבוע'); return; }
        persist([...shown, ...added]);
      } else {
        /**
         * A full-day worker dropped onto ANOTHER group on a day she is
         * already placed is the mid-day split: morning stays where it is,
         * the afternoon (from 14:00) moves to the new group. Two entries,
         * no overlap — the board and the export already draw her ⇄.
         * Dropped somewhere she is NOT placed that day: a plain placement,
         * exactly as before. Hours stay editable per entry afterwards.
         */
        const existing = shown.find(e =>
          String(e.employee_id) === String(emp._id) && e.date === date && entryRowKey(e) !== targetKey);
        const a = existing ? toMin(existing.start_hhmm) : null;
        const b = existing ? toMin(existing.end_hhmm) : null;
        if (existing && a != null && b != null && a < PM_MIN && b > PM_MIN) {
          if (!window.confirm(
            `לפצל את המשמרת של ${emp.full_name}?
` +
            `בוקר (${existing.start_hhmm}–14:00) יישאר במקום הנוכחי,
` +
            `וצהריים (14:00–${existing.end_hhmm}) יעבור ל"${row.label}".`,
          )) return;
          const next = shown.map(e => (e === existing ? { ...e, end_hhmm: '14:00' } : e));
          persist([...next, {
            employee_id: emp._id, employee_name: emp.full_name, date, ...target,
            start_hhmm: '14:00', end_hhmm: existing.end_hhmm, tmp: newTmp(),
          }]);
          return;
        }
        persist([...shown, make(date)]);
      }
    }
  };
  const toggleClosed = async (date, closedNow) => {
    if (!closedNow && !window.confirm('סגירת היום תמחק את כל השיבוצים בו. להמשיך?')) return;
    try { await api.post(`/shifts/weeks/${board.week._id}/closed-days`, { date, closed: !closedNow }); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const publish = async () => {
    try {
      const { data } = await api.post(`/shifts/weeks/${board.week._id}/publish`);
      toast.success(data.notified ? `הסידור נסגר — ${data.notified} עובדות קיבלו התראה` : 'הסידור נסגר');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  // Pending prompt rows carry the suggestion; the card fields come from the employee list.
  const pendingItems = useMemo(() => (board ? board.pending_primary.map(p => {
    const emp = board.employees.find(e => e._id === p.employee_id) || {};
    return { ...emp, ...p };
  }) : []), [board]);
  // "אין צורך בשעות התחייבות ושיבוץ" (set on the commitments screen) — off the rota entirely.
  const rotaEmployees = useMemo(() => (board ? board.employees.filter(e => e.shift_area !== 'none') : []), [board]);
  const placementItems = useMemo(() => rotaEmployees.filter(e => !e.foreign).map(e => ({ ...e, employee_id: e._id })), [rotaEmployees]);
  const unassignedCount = (board?.week?.entries || []).filter(e => e.area === 'unassigned').length;
  const autoPlace = async () => {
    try {
      const { data } = await api.post(`/shifts/weeks/${board.week._id}/auto-place`);
      toast[data.placed ? 'success' : 'info'](data.placed
        ? `${data.placed} משמרות שובצו לפי הכרטיסים`
        : data.unplaced
          ? `${data.unplaced} משמרות עדיין ללא כיתה — קבעו להן כיתות קבועות`
          : 'הכל כבר משובץ לפי הכרטיסים');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'הפעולה נכשלה'); }
  };
  const sendRequest = async () => {
    try { await api.post(`/shifts/weeks/${board.week._id}/edit-requests`, { entries: clean(draft) }); toast.success('הבקשה נשלחה למנהלת הסניף'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'שליחה נכשלה'); }
  };

  if (isAllBranches) return <Alert severity="info">בחרו סניף אחד כדי לראות את הסידור שלו.</Alert>;

  return (
    <Box>
      <PageHeader
        title="סידור עבודה"
        meta={[
          board && { label: board.branch_name, strong: true },
          board && { label: `שבוע ${fmtDate(board.dates[0])}–${fmtDate(board.dates[5])}` },
          board?.week && { label: board.week.published_at ? (board.has_unpublished_changes ? 'יש שינויים שלא פורסמו' : 'פורסם') : 'טיוטה' },
        ]}
        primary={!board ? undefined
          : !board.week ? (board.can_edit ? { label: 'פתיחת סידור לשבוע', onClick: openWeek } : undefined)
          : board.can_edit ? { label: board.week.published_at ? 'סגירת סידור (פרסום שינויים)' : 'סגירת סידור ופרסום', onClick: publish, disabled: !board.has_unpublished_changes }
          : board.can_request ? { label: 'שליחת בקשת שינוי למנהלת', onClick: sendRequest, disabled: !dirty } : undefined}
        actions={[
          ...(board?.can_edit ? [{ label: 'כיתות קבועות', onClick: () => setPlacementOpen(true) }] : []),
          ...(board?.can_edit && board.week ? [{ label: unassignedCount ? `שיבוץ לפי הכרטיסים (${unassignedCount} ללא כיתה)` : 'שיבוץ לפי הכרטיסים', onClick: autoPlace }] : []),
          ...(board?.can_edit ? [{ label: 'הגדרות', onClick: () => setSettingsOpen(true) }] : []),
          { label: 'אילוצים עתידיים', onClick: () => setFutureOpen(true) },
          ...(board?.can_edit ? [{ label: 'אילוץ ידני (העובדת לא שלחה)', onClick: () => setManualConstraintOpen(true) }] : []),
          { label: 'דוח נוכחות אתמול', onClick: () => setReportDate(yesterdayYmd()) },
        ]}
        menu={board ? [
          { label: board.has_unpublished_changes ? 'ייצוא PDF (כולל שינויים שלא פורסמו)' : 'ייצוא PDF להדפסה', onClick: () => exportPdf(exportArgs) },
          { label: 'ייצוא תמונה (PNG)', onClick: () => exportPng(exportArgs) },
          { label: 'שליחה בוואטסאפ', onClick: () => shareWhatsApp(exportArgs) },
        ] : []}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <IconButton onClick={() => setWeek(addDays(week, -7))} aria-label="שבוע קודם"><ChevronRightIcon /></IconButton>
          <Typography fontWeight={700}>{board ? `${fmtDate(board.dates[0])} – ${fmtDate(board.dates[5])}` : ''}</Typography>
          <IconButton onClick={() => setWeek(addDays(week, 7))} aria-label="שבוע הבא"><ChevronLeftIcon /></IconButton>
          <Button size="small" onClick={() => setWeek(addDays(sundayOf(), 7))}>השבוע הבא</Button>
        </Stack>
      </PageHeader>

      {loading && !board && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}
      {board && !board.week && (
        <Alert severity="info" sx={{ mb: 2 }}>
          הסידור לשבוע הזה עוד לא נפתח. זו תצוגה מקדימה לפי ההתחייבויות של העובדות.
        </Alert>
      )}
      {board?.can_edit && board.week && (
        <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }} useFlexGap>
          {board.dates.map((d) => {
            const manual = board.week.closed_days.includes(d);
            const holiday = closed.has(d) && !manual;
            return (
              <Button key={d} size="small" variant={manual ? 'contained' : 'outlined'} color="inherit" disabled={holiday}
                onClick={() => toggleClosed(d, manual)}>
                {holiday ? `${fmtDate(d)} — לוח חופשות` : manual ? `${fmtDate(d)} — סגור (פתיחה)` : `סגירת ${fmtDate(d)}`}
              </Button>
            );
          })}
        </Stack>
      )}
      {board?.stale_enrolled > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>{board.stale_enrolled} ילדים פעילים לא נספרים בתקן:</strong> הם עדיין משויכים
          לכיתות של שנה קודמת (או לכיתה סגורה). זו הסיבה שמספר הילדים על הלוח נמוך מהרישום —
          יש להעביר אותם לכיתות השנה במסך רישום ← שיבוץ לכיתות.
        </Alert>
      )}
      {board?.can_edit && <EditRequestsPanel requests={board.edit_requests} onDecided={load} />}
      {board && <CrossBranchPanel board={board} onChanged={load} />}
      {board && <ConstraintsPanel constraints={board.constraints} canEdit={!!board.can_edit} onChanged={load} entries={shown} />}
      {board && (
        <StaffBalanceStrip rows={rows} dates={board.dates} closedDates={closed}
          ratios={board.ratios} pmCaps={board.pm_caps} />
      )}
      {board && <OvertimeStrip employees={board.employees} entries={shown} dates={board.dates} />}
      {board && <FillSuggestions board={board} entries={shown} closed={closed} onAdd={addSuggested} />}
      {board?.can_edit && (() => {
        const missing = board.employees.filter(e => !e.foreign && !e.has_commitment && e.shift_area !== 'none');
        if (!missing.length) return null;
        return (
          <Alert severity="info" sx={{ mb: 1, alignItems: 'center' }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <span>ללא התחייבות שעות (לא ייכנסו לסידור עד שתוגדר, או שיסומנו "לא בסידור"):</span>
              {missing.map(e => (
                <Chip key={e._id} size="small" clickable component={RouterLink}
                  to={`/payroll?tab=commitments&employee=${e._id}`} label={e.full_name} />
              ))}
            </Stack>
          </Alert>
        );
      })()}
      {board && (
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 1.5, alignItems: { md: 'flex-start' }, minWidth: 0 }}>
          {editable && (
            <Box sx={{ width: { xs: '100%', md: 220 }, flexShrink: 0, minWidth: 0 }}>
              <EmployeeSidebar employees={rotaEmployees} entries={shown} dates={board.dates}
                onRequestRate={board.can_edit ? () => { setRateEmployeeId(null); setRateOpen(true); } : undefined} />
            </Box>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {/* הבורר צף: מי שעובדת על משמרת בתחתית הדף מחליפה בוקר/צהריים
                בלי לגלול חזרה למעלה. position:sticky נשבר כאן (ל-Layout יש
                overflow:hidden), אז כשהעוגן יוצא מהמסך מופיע עותק קבוע
                במרכז למעלה. */}
            <Box ref={viewPillAnchor} sx={{ mb: 0.75, display: 'flex' }}>{viewPill}</Box>
            {pillFloating && (
              <Box sx={{ position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}>
                {viewPill}
              </Box>
            )}
            <ShiftGrid
              dates={board.dates} rows={gridRows} closedDates={closed} warnings={board.warnings}
              switched={switched} editable={editable} alerts={alerts} actual={actual} shiftFilter={shiftView} ratios={board.ratios} pmCaps={board.pm_caps}
              sickDays={sickDays} onSickOk={editable ? toggleSickOk : undefined}
              onCellClick={(row, date) => setDlg({ open: true, entry: null, defaults: { date, area: row.area, classroom_id: row.classroom_id } })}
              onEntryClick={(entry) => setDlg({ open: true, entry, defaults: null })}
              onDropToCell={onDropToCell}
            />
          </Box>
        </Box>
      )}

      <EntryDialog open={dlg.open} onClose={closeDlg}
        entry={dlg.entry} defaults={dlg.defaults || NO_DEFAULTS} employees={rotaEmployees} rows={rows}
        onSave={saveEntry} onDelete={deleteEntry}
        onSplit={splitEntry}
        onRequestRate={board?.can_edit ? () => { closeDlg(); setRateEmployeeId(null); setRateOpen(true); } : undefined} />
      <ManualConstraintDialog
        open={manualConstraintOpen}
        onClose={() => setManualConstraintOpen(false)}
        onSaved={() => { setManualConstraintOpen(false); load(); }}
        employees={rotaEmployees.filter(e => !e.foreign)}
        defaultDate={board?.dates?.[0] || ''}
      />
      <RateRequestDialog open={rateOpen} onClose={() => setRateOpen(false)} candidates={board?.foreign_candidates}
        hostBranchId={board?.branch_id} initialEmployeeId={rateEmployeeId}
        onSent={() => { setRateOpen(false); load(); }} />
      <AttendanceReportDialog open={!!reportDate} onClose={() => setReportDate(null)} branchId={board?.branch_id} date={reportDate} />
      {board && <PrimaryClassDialog open={primaryOpen}
        onClose={() => { primaryDismissed.current.add(selectedBranch); setPrimaryOpen(false); }}
        items={pendingItems} classrooms={board.classrooms}
        onDone={() => { primaryDismissed.current.add(selectedBranch); setPrimaryOpen(false); load(); }} />}
      {board && <PrimaryClassDialog manage open={placementOpen} onClose={() => setPlacementOpen(false)}
        items={placementItems} classrooms={board.classrooms}
        onDone={() => { setPlacementOpen(false); load(); }} />}
      <FutureConstraintsDialog open={futureOpen} onClose={() => setFutureOpen(false)} branchId={board?.branch_id} canEdit={!!board?.can_edit} />
      <ShiftSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} board={board} onChanged={load} />
    </Box>
  );
}
