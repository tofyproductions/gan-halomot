import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Button, IconButton, Typography, Alert, CircularProgress } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useUrlState } from '../../hooks/useUrlState';
import useFetchSeq from '../../hooks/useFetchSeq';
import PageHeader from '../ui/PageHeader';
import ShiftGrid from './ShiftGrid';
import EntryDialog from './EntryDialog';
import PrimaryClassDialog from './PrimaryClassDialog';
import ShiftSettingsDialog from './ShiftSettingsDialog';
import EditRequestsPanel from './EditRequestsPanel';
import ConstraintsPanel from './ConstraintsPanel';
import FutureConstraintsDialog from './FutureConstraintsDialog';
import CrossBranchPanel from './CrossBranchPanel';
import RateRequestDialog from './RateRequestDialog';
import AttendanceReportDialog from './AttendanceReportDialog';
import { describe } from './constraintLabels';
import { exportPdf, exportPng } from './shiftExport';
import { buildRows, buildAwayRow, switchedSet, fmtDate } from './shiftRows';

const NO_DEFAULTS = {};

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

  const [draft, setDraft] = useState(null);          // working entries while editing
  const [dlg, setDlg] = useState({ open: false, entry: null, defaults: null });
  const [primaryOpen, setPrimaryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [futureOpen, setFutureOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
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
    const m = new Map();
    for (const c of board?.constraints || []) {
      if (!['open', 'accepted', 'pending_broadcast', 'broadcast'].includes(c.status)) continue;
      const key = `${c.employee_id}|${c.date}`;
      m.set(key, [...(m.get(key) || []), describe(c)]);
    }
    return m;
  }, [board]);
  const closed = useMemo(() => new Set(board?.closed_dates || []), [board]);

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
      : [...shown, { ...form, tmp: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }];
    closeDlg();
    persist(next);
  };
  const deleteEntry = (entry) => {
    closeDlg();
    persist(shown.filter(e => !sameEntry(e, entry)));
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
          ...(board?.can_edit ? [{ label: 'הגדרות', onClick: () => setSettingsOpen(true) }] : []),
          { label: 'אילוצים עתידיים', onClick: () => setFutureOpen(true) },
          { label: 'דוח נוכחות אתמול', onClick: () => setReportDate(yesterdayYmd()) },
        ]}
        menu={board ? [
          { label: board.has_unpublished_changes ? 'ייצוא PDF (כולל שינויים שלא פורסמו)' : 'ייצוא PDF להדפסה', onClick: () => exportPdf(exportArgs) },
          { label: 'ייצוא תמונה (PNG)', onClick: () => exportPng(exportArgs) },
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
                {holiday ? `${fmtDate(d)} — חג` : manual ? `${fmtDate(d)} — סגור (פתיחה)` : `סגירת ${fmtDate(d)}`}
              </Button>
            );
          })}
        </Stack>
      )}
      {board?.can_edit && <EditRequestsPanel requests={board.edit_requests} onDecided={load} />}
      {board && <CrossBranchPanel board={board} onChanged={load} />}
      {board && <ConstraintsPanel constraints={board.constraints} canEdit={!!board.can_edit} onChanged={load} />}
      {board && (
        <ShiftGrid
          dates={board.dates} rows={gridRows} closedDates={closed} warnings={board.warnings}
          switched={switched} editable={editable} alerts={alerts}
          onCellClick={(row, date) => setDlg({ open: true, entry: null, defaults: { date, area: row.area, classroom_id: row.classroom_id } })}
          onEntryClick={(entry) => setDlg({ open: true, entry, defaults: null })}
        />
      )}

      <EntryDialog open={dlg.open} onClose={closeDlg}
        entry={dlg.entry} defaults={dlg.defaults || NO_DEFAULTS} employees={board?.employees || []} rows={rows}
        onSave={saveEntry} onDelete={deleteEntry}
        onRequestRate={board?.can_edit ? () => { closeDlg(); setRateEmployeeId(null); setRateOpen(true); } : undefined} />
      <RateRequestDialog open={rateOpen} onClose={() => setRateOpen(false)} candidates={board?.foreign_candidates}
        hostBranchId={board?.branch_id} initialEmployeeId={rateEmployeeId}
        onSent={() => { setRateOpen(false); load(); }} />
      <AttendanceReportDialog open={!!reportDate} onClose={() => setReportDate(null)} branchId={board?.branch_id} date={reportDate} />
      {board && <PrimaryClassDialog open={primaryOpen}
        onClose={() => { primaryDismissed.current.add(selectedBranch); setPrimaryOpen(false); }}
        pending={board.pending_primary} classrooms={board.classrooms}
        onDone={() => { primaryDismissed.current.add(selectedBranch); setPrimaryOpen(false); load(); }} />}
      <FutureConstraintsDialog open={futureOpen} onClose={() => setFutureOpen(false)} branchId={board?.branch_id} canEdit={!!board?.can_edit} />
      <ShiftSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} board={board} onChanged={load} />
    </Box>
  );
}
