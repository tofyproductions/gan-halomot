import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, Stack, MenuItem, TextField,
  Chip, Grid,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAcademicYear } from '../../hooks/useAcademicYear';

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
  const { selectedBranch } = useBranch();
  const { years } = useAcademicYear();
  const [classrooms, setClassrooms] = useState([]);
  const [selectedClassroom, setSelectedClassroom] = useState('');
  const [archive, setArchive] = useState([]);

  const academicYear = years.current.range;
  const [y1, y2] = academicYear.split('-').map(Number);

  useEffect(() => {
    api.get('/classrooms').then(res => {
      const cls = res.data.classrooms || [];
      setClassrooms(cls);
      if (cls.length > 0 && !selectedClassroom) setSelectedClassroom(cls[0]._id || cls[0].id);
    }).catch(() => {});
  }, []);

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
        <TextField select size="small" value={selectedClassroom} label="כיתה"
          onChange={e => setSelectedClassroom(e.target.value)} sx={{ minWidth: 180 }}
        >
          {classrooms.map(c => (
            <MenuItem key={c._id || c.id} value={c._id || c.id}>{c.name}</MenuItem>
          ))}
        </TextField>
      </Stack>

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
                '&:hover': { borderColor: '#f59e0b', transform: 'scale(1.02)' },
                transition: 'all 0.2s',
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
