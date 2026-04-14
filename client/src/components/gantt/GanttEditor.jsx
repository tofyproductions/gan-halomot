import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, Chip, IconButton, Tooltip, Divider, Alert,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PrintIcon from '@mui/icons-material/Print';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

const MONTH_NAMES = {
  1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 4: 'אפריל', 5: 'מאי', 6: 'יוני',
  7: 'יולי', 8: 'אוגוסט', 9: 'ספטמבר', 10: 'אוקטובר', 11: 'נובמבר', 12: 'דצמבר',
};

export default function GanttEditor() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { selectedBranch } = useBranch();
  const { isManager } = useAuth();

  const classroomId = searchParams.get('classroom');
  const month = parseInt(searchParams.get('month'));
  const year = parseInt(searchParams.get('year'));

  const [gantt, setGantt] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [classroomName, setClassroomName] = useState('');

  useEffect(() => {
    if (!classroomId || !month || !year) return;

    api.get('/gantt', { params: { classroom: classroomId, month, year, branch: selectedBranch } })
      .then(res => {
        setGantt(res.data.gantt);
        setHolidays(res.data.holidays || []);
      })
      .catch(() => toast.error('שגיאה בטעינת גאנט'))
      .finally(() => setLoading(false));

    // Get classroom name
    api.get('/classrooms').then(res => {
      const cls = (res.data.classrooms || []).find(c => (c._id || c.id) === classroomId);
      if (cls) setClassroomName(cls.name);
    }).catch(() => {});
  }, [classroomId, month, year, selectedBranch]);

  // Check if a date is a holiday
  const isHoliday = (date) => {
    if (!date) return null;
    const d = new Date(date);
    return holidays.find(h => d >= new Date(h.start_date) && d <= new Date(h.end_date));
  };

  // Get cell content
  const getCellContent = (weekIdx, rowKey, dayIndex) => {
    if (!gantt?.weeks?.[weekIdx]) return '';
    const cell = gantt.weeks[weekIdx].cells?.find(
      c => c.row_key === rowKey && c.day_index === dayIndex
    );
    return cell?.content || '';
  };

  // Update cell content
  const updateCell = (weekIdx, rowKey, dayIndex, content) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      if (!weeks[weekIdx]) return prev;

      const cells = [...(weeks[weekIdx].cells || [])];
      const existingIdx = cells.findIndex(c => c.row_key === rowKey && c.day_index === dayIndex);

      if (existingIdx >= 0) {
        cells[existingIdx] = { ...cells[existingIdx], content };
      } else {
        cells.push({ row_key: rowKey, day_index: dayIndex, content });
      }

      weeks[weekIdx] = { ...weeks[weekIdx], cells };
      return { ...prev, weeks };
    });
  };

  // Update week fields
  const updateWeek = (weekIdx, field, value) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      weeks[weekIdx] = { ...weeks[weekIdx], [field]: value };
      return { ...prev, weeks };
    });
  };

  // Add custom row
  const addRow = () => {
    const label = prompt('שם השורה החדשה:');
    if (!label) return;
    const key = 'custom_' + Date.now();
    setGantt(prev => ({
      ...prev,
      row_definitions: [...(prev.row_definitions || []), { key, label }],
    }));
  };

  // Remove row
  const removeRow = (key) => {
    setGantt(prev => ({
      ...prev,
      row_definitions: (prev.row_definitions || []).filter(r => r.key !== key),
    }));
  };

  // Save
  const handleSave = async (status = 'draft') => {
    setSaving(true);
    try {
      await api.post('/gantt', {
        branch_id: selectedBranch,
        classroom_id: classroomId,
        academic_year: `${month >= 9 ? year : year - 1}-${month >= 9 ? year + 1 : year}`,
        month, year,
        row_definitions: gantt.row_definitions,
        weeks: gantt.weeks,
        status,
      });
      toast.success(status === 'pending' ? 'נשלח לאישור' : 'נשמר כטיוטה');
      if (status === 'pending') navigate('/gantt');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setSaving(false);
    }
  };

  // Approve
  const handleApprove = async () => {
    if (!gantt?._id) return toast.error('יש לשמור את הגאנט קודם');
    try {
      await api.post(`/gantt/${gantt._id}/approve`);
      toast.success('גאנט אושר!');
      setGantt(prev => ({ ...prev, status: 'approved' }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  if (loading) return <Typography sx={{ textAlign: 'center', py: 10 }}>טוען...</Typography>;
  if (!gantt) return <Typography>גאנט לא נמצא</Typography>;

  return (
    <Box dir="rtl">
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            תוכנית עבודה - {MONTH_NAMES[month]} {year}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {classroomName}
            {gantt.status === 'approved' && <Chip label="מאושר" color="success" size="small" sx={{ ml: 1 }} />}
            {gantt.status === 'pending' && <Chip label="ממתין לאישור" color="warning" size="small" sx={{ ml: 1 }} />}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<PrintIcon />} onClick={() => window.print()}>הדפסה</Button>
          <Button size="small" startIcon={<AddIcon />} onClick={addRow}>הוסף שורה</Button>
          <Button variant="outlined" startIcon={<SaveIcon />} onClick={() => handleSave('draft')} disabled={saving}>
            שמור טיוטה
          </Button>
          <Button variant="contained" color="warning" onClick={() => handleSave('pending')} disabled={saving}>
            שלח לאישור
          </Button>
          {isManager && gantt._id && gantt.status !== 'approved' && (
            <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} onClick={handleApprove}>
              אשר
            </Button>
          )}
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/gantt')}>חזרה</Button>
        </Stack>
      </Stack>

      {/* Weeks */}
      {(gantt.weeks || []).map((week, weekIdx) => {
        const weekStart = new Date(week.start_date);
        const weekEnd = new Date(week.end_date);

        return (
          <Card key={weekIdx} sx={{ mb: 3 }}>
            <CardContent sx={{ p: 1 }}>
              {/* Week header */}
              <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1, p: 1, bgcolor: '#f8fafc', borderRadius: 2 }}>
                <Chip label={`שבוע ${week.week_number}`} size="small" color="primary" />
                <Typography variant="body2" color="text.secondary">
                  {weekStart.toLocaleDateString('he-IL')} - {weekEnd.toLocaleDateString('he-IL')}
                </Typography>
                <TextField
                  size="small" label="נושא שבועי" value={week.topic || ''}
                  onChange={e => updateWeek(weekIdx, 'topic', e.target.value)}
                  sx={{ flex: 1 }}
                />
              </Stack>

              {/* Grid */}
              <TableContainer>
                <Table size="small" sx={{ '& td, & th': { border: '1px solid #e2e8f0', p: 0.5 } }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, width: 100, bgcolor: '#f1f5f9' }}></TableCell>
                      {DAY_NAMES.map((day, dayIdx) => {
                        // Calculate actual date for this day
                        const dayDate = new Date(weekStart);
                        dayDate.setDate(dayDate.getDate() + dayIdx);
                        const holiday = isHoliday(dayDate);
                        const dateStr = dayDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });

                        return (
                          <TableCell key={dayIdx} align="center" sx={{
                            fontWeight: 700, fontSize: '0.75rem',
                            bgcolor: holiday ? '#fef3c7' : dayIdx === 5 ? '#ede9fe' : '#f1f5f9',
                          }}>
                            {day} {dateStr}
                            {holiday && <Box sx={{ fontSize: '0.65rem', color: '#92400e' }}>{holiday.name}</Box>}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(gantt.row_definitions || []).map(row => (
                      <TableRow key={row.key}>
                        <TableCell sx={{ fontWeight: 700, bgcolor: '#f8fafc', fontSize: '0.8rem' }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            {row.label}
                            {row.key.startsWith('custom_') && (
                              <IconButton size="small" onClick={() => removeRow(row.key)}>
                                <DeleteIcon sx={{ fontSize: 14 }} />
                              </IconButton>
                            )}
                          </Stack>
                        </TableCell>
                        {DAY_NAMES.map((_, dayIdx) => {
                          const dayDate = new Date(weekStart);
                          dayDate.setDate(dayDate.getDate() + dayIdx);
                          const holiday = isHoliday(dayDate);
                          const isFriday = dayIdx === 5;

                          // Friday special: show קבלת שבת for מפגש row
                          if (isFriday && row.key === 'meeting') {
                            return (
                              <TableCell key={dayIdx} sx={{ bgcolor: '#ede9fe', textAlign: 'center', fontSize: '0.75rem', fontWeight: 600 }}>
                                קבלת שבת
                              </TableCell>
                            );
                          }

                          // Friday: parent of shabbat for פעילות row
                          if (isFriday && row.key === 'activity') {
                            return (
                              <TableCell key={dayIdx} sx={{ bgcolor: '#ede9fe', p: 0.5 }}>
                                <TextField size="small" placeholder="אבא של שבת"
                                  value={week.friday_parent_father || ''}
                                  onChange={e => updateWeek(weekIdx, 'friday_parent_father', e.target.value)}
                                  inputProps={{ style: { fontSize: '0.7rem', padding: '2px 4px' } }}
                                  fullWidth variant="standard"
                                />
                                <TextField size="small" placeholder="אמא של שבת"
                                  value={week.friday_parent_mother || ''}
                                  onChange={e => updateWeek(weekIdx, 'friday_parent_mother', e.target.value)}
                                  inputProps={{ style: { fontSize: '0.7rem', padding: '2px 4px' } }}
                                  fullWidth variant="standard"
                                />
                              </TableCell>
                            );
                          }

                          return (
                            <TableCell key={dayIdx} sx={{
                              bgcolor: holiday ? '#fef3c7' : isFriday ? '#ede9fe' : 'white',
                              p: 0.5,
                            }}>
                              {holiday && !getCellContent(weekIdx, row.key, dayIdx) ? (
                                <Typography variant="caption" sx={{ color: '#92400e', fontSize: '0.7rem' }}>
                                  {holiday.name}
                                </Typography>
                              ) : (
                                <TextField
                                  size="small" multiline maxRows={3}
                                  value={getCellContent(weekIdx, row.key, dayIdx)}
                                  onChange={e => updateCell(weekIdx, row.key, dayIdx, e.target.value)}
                                  inputProps={{ style: { fontSize: '0.7rem', padding: '2px 4px', lineHeight: 1.3 } }}
                                  fullWidth variant="standard"
                                  sx={{ '& .MuiInput-underline:before': { borderBottom: 'none' } }}
                                />
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        );
      })}
    </Box>
  );
}
