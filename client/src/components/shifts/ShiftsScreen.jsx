import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Stack, Button, IconButton, Typography, Alert, CircularProgress } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useUrlState } from '../../hooks/useUrlState';
import PageHeader from '../ui/PageHeader';
import ShiftGrid from './ShiftGrid';
import { buildRows, switchedSet, fmtDate } from './shiftRows';

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

export default function ShiftsScreen() {
  const { selectedBranch, isAllBranches } = useBranch();
  // Default: next week — the one being planned.
  const [week, setWeek] = useUrlState('week', addDays(sundayOf(), 7));
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedBranch || isAllBranches) return;
    setLoading(true);
    try {
      const { data } = await api.get('/shifts/board', { params: { branch: selectedBranch, week } });
      setBoard(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת הסידור');
    } finally {
      setLoading(false);
    }
  }, [selectedBranch, isAllBranches, week]);
  useEffect(() => { load(); }, [load]);

  const entries = board ? (board.week ? board.week.entries : board.preview) : [];
  const rows = useMemo(() => (board ? buildRows({ entries, classrooms: board.classrooms }) : []), [board, entries]);
  const switched = useMemo(() => switchedSet(entries), [entries]);
  const closed = useMemo(() => new Set(board?.closed_dates || []), [board]);

  const openWeek = async () => {
    try {
      await api.post('/shifts/weeks', { branch: selectedBranch, week });
      toast.success('הסידור נפתח לפי ההתחייבויות');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בפתיחת הסידור'); }
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
        primary={board && !board.week && board.can_edit ? { label: 'פתיחת סידור לשבוע', onClick: openWeek } : undefined}
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
      {board && (
        <ShiftGrid
          dates={board.dates} rows={rows} closedDates={closed} warnings={board.warnings}
          switched={switched} editable={false} onCellClick={() => {}} onEntryClick={() => {}}
        />
      )}
    </Box>
  );
}
