import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, Stack, MenuItem, TextField,
  Chip, Grid, Button,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAcademicYear, getHebrewYearFromStart } from '../../hooks/useAcademicYear';
import { COLOR } from '../../theme/tokens';
import GanttMultiPrintDialog from './GanttMultiPrintDialog';

const MONTH_NAMES = {
  9: 'ספטמבר', 10: 'אוקטובר', 11: 'נובמבר', 12: 'דצמבר',
  1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 4: 'אפריל',
  5: 'מאי', 6: 'יוני', 7: 'יולי', 8: 'אוגוסט',
};

const ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8];

const STATUS_COLORS = {
  approved: '#dcfce7',
  pending: '#fef3c7',
  draft: '#f1f5f9',
  missing: '#fee2e2',
};

export default function GanttCalendar() {
  const navigate = useNavigate();
  const { selectedBranch, branches, isAllBranches } = useBranch();
  const { years } = useAcademicYear();
  const [classrooms, setClassrooms] = useState([]);
  const [selectedClassroom, setSelectedClassroom] = useState('');
  // Which gan's rooms to show when the GLOBAL scope is "all branches". Without
  // this, the class picker mixed every branch's rooms into one list — three
  // unlabelled "בוגרים" and no way to tell whose plan you are about to open.
  const [ganttBranch, setGanttBranch] = useState('');
  const [archive, setArchive] = useState([]);
  const [multiPrintOpen, setMultiPrintOpen] = useState(false);

  // Rooms visible under the current in-screen gan choice.
  const visibleClassrooms = (isAllBranches && ganttBranch)
    ? classrooms.filter(c => String(c.branch_id) === String(ganttBranch))
    : classrooms;

  // The plan is written for the year the gan is in, and only that one. There
  // used to be a picker here offering four years back and two ahead; a month
  // saved under last year's rooms then vanished the day this year's rooms
  // opened, and nobody could say where it went. The year is a fact now, not a
  // choice, and the server refuses any other.
  const y1 = years.current.value;
  const y2 = y1 + 1;
  const yearLabel = `${getHebrewYearFromStart(y1)} (${y1}-${y2})`;

  useEffect(() => {
    // This year's rooms. A branch that has not opened them yet falls back to
    // its newest rooms, so the screen is never empty.
    const pick = (cls) => {
      setClassrooms(cls);
      if (cls.length > 0 && !selectedClassroom) setSelectedClassroom(cls[0]._id || cls[0].id);
    };
    api.get('/classrooms', { params: { year: years.current.range } }).then(res => {
      const cls = res.data.classrooms || [];
      if (cls.length) return pick(cls);
      return api.get('/classrooms').then(r2 => pick(r2.data.classrooms || []));
    }).catch(() => {});
  }, []);

  // Keep the in-screen gan and the selected room coherent:
  //   - leaving all-branches mode clears the in-screen choice (the global
  //     picker is the scope again);
  //   - entering it defaults to the gan owning the current room, so the
  //     screen doesn't jump;
  //   - choosing a different gan moves the room selection into that gan.
  useEffect(() => {
    if (!isAllBranches) { if (ganttBranch) setGanttBranch(''); return; }
    if (!classrooms.length) return;
    if (!ganttBranch) {
      const current = classrooms.find(c => (c._id || c.id) === selectedClassroom);
      const first = current?.branch_id || classrooms[0].branch_id;
      if (first) setGanttBranch(String(first));
      return;
    }
    const inScope = classrooms.filter(c => String(c.branch_id) === String(ganttBranch));
    if (inScope.length && !inScope.some(c => (c._id || c.id) === selectedClassroom)) {
      setSelectedClassroom(inScope[0]._id || inScope[0].id);
    }
  }, [isAllBranches, ganttBranch, classrooms, selectedClassroom]);

  useEffect(() => {
    if (!selectedClassroom) return;
    api.get('/gantt/archive', { params: { classroom: selectedClassroom } })
      .then(res => setArchive(res.data.archive || []))
      .catch(() => {});
  }, [selectedClassroom]);

  const getMonthStatus = (month) => {
    const yr = month >= 9 ? y1 : y2;
    const found = archive.find(a => a.month === month && a.year === yr);
    return found?.status || 'missing';
  };

  const openEditor = (month) => {
    const yr = month >= 9 ? y1 : y2;
    navigate(`/gantt/edit?classroom=${selectedClassroom}&month=${month}&year=${yr}`);
  };

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>תוכנית עבודה שנתית</Typography>
        <Stack direction="row" spacing={2}>
          <Chip label={`שנת לימודים ${yearLabel}`} sx={{ fontWeight: 700, alignSelf: 'center' }} />
          {isAllBranches && (
            /* The global scope is "every branch", so the class list would mix
               every gan's rooms — three unlabelled "בוגרים" and no way to know
               whose plan opens. This picker narrows the screen to one gan. */
            <TextField select size="small" value={ganttBranch} label="גן"
              onChange={e => setGanttBranch(e.target.value)} sx={{ minWidth: 160 }}
            >
              {branches
                .filter(b => (b._id || b.id) !== 'all')
                .map(b => (
                  <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
                ))}
            </TextField>
          )}
          <TextField select size="small" value={selectedClassroom} label="כיתה"
            onChange={e => setSelectedClassroom(e.target.value)} sx={{ minWidth: 180 }}
          >
            {visibleClassrooms.map(c => (
              <MenuItem key={c._id || c.id} value={c._id || c.id}>{c.name}</MenuItem>
            ))}
          </TextField>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={() => setMultiPrintOpen(true)}>
            הדפסת חודש לכל הכיתות
          </Button>
        </Stack>
      </Stack>

      <GanttMultiPrintDialog open={multiPrintOpen} onClose={() => setMultiPrintOpen(false)}
        y1={y1} yearRange={years.current.range} />

      {/* Legend */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <Chip size="small" label="מאושר" sx={{ bgcolor: STATUS_COLORS.approved }} />
        <Chip size="small" label="ממתין לאישור" sx={{ bgcolor: STATUS_COLORS.pending }} />
        <Chip size="small" label="טיוטה" sx={{ bgcolor: STATUS_COLORS.draft }} />
        <Chip size="small" label="חסר" sx={{ bgcolor: STATUS_COLORS.missing }} />
      </Stack>

      {/* Month Grid */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2 }}>
        {ACADEMIC_MONTHS.map(month => {
          const status = getMonthStatus(month);
          const yr = month >= 9 ? y1 : y2;

          return (
            <Card
              key={month}
              sx={{
                cursor: 'pointer',
                bgcolor: STATUS_COLORS[status],
                border: '2px solid transparent',
                '&:hover': { borderColor: COLOR.primary.light, transform: 'scale(1.02)' },
                transition: (t) => `all ${t.motion.base}`,
              }}
              onClick={() => openEditor(month)}
            >
              <CardContent sx={{ textAlign: 'center', py: 3 }}>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>
                  {MONTH_NAMES[month]}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {yr}
                </Typography>
                <Chip
                  size="small"
                  label={status === 'approved' ? 'מאושר' : status === 'pending' ? 'ממתין' : status === 'draft' ? 'טיוטה' : 'טרם הוזן'}
                  sx={{ mt: 1, fontWeight: 600 }}
                  color={status === 'approved' ? 'success' : status === 'pending' ? 'warning' : 'default'}
                  variant="outlined"
                />
              </CardContent>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
}
