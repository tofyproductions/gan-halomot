import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, Chip, IconButton, Tooltip, Menu, MenuItem,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PrintIcon from '@mui/icons-material/Print';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PaletteIcon from '@mui/icons-material/Palette';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const MONTH_NAMES = {
  1:'ינואר',2:'פברואר',3:'מרץ',4:'אפריל',5:'מאי',6:'יוני',
  7:'יולי',8:'אוגוסט',9:'ספטמבר',10:'אוקטובר',11:'נובמבר',12:'דצמבר',
};

const CELL_COLORS = [
  { label: 'ללא', value: '' },
  { label: 'צהוב', value: '#fef9c3' },
  { label: 'ירוק', value: '#dcfce7' },
  { label: 'כחול', value: '#dbeafe' },
  { label: 'ורוד', value: '#fce7f3' },
  { label: 'סגול', value: '#ede9fe' },
  { label: 'כתום', value: '#ffedd5' },
];

const GANTT_STYLES = {
  cell: {
    border: '1px solid #e2e8f0',
    p: '6px 8px',
    verticalAlign: 'top',
    fontSize: '0.8rem',
    fontFamily: '"Assistant", "Heebo", sans-serif',
  },
  headerCell: {
    bgcolor: '#1e3a5f',
    color: 'white',
    fontWeight: 700,
    fontSize: '0.8rem',
    textAlign: 'center',
    p: '8px 6px',
    fontFamily: '"Assistant", "Heebo", sans-serif',
  },
  rowLabel: {
    bgcolor: '#f8fafc',
    fontWeight: 700,
    fontSize: '0.8rem',
    minWidth: 80,
    textAlign: 'center',
    borderLeft: '2px solid #cbd5e1',
  },
  topicRow: {
    bgcolor: '#fefce8',
    fontWeight: 700,
    fontSize: '0.85rem',
  },
  fridayCol: {
    bgcolor: '#f5f3ff',
  },
  holidayCell: {
    bgcolor: '#fef3c7',
  },
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
  const [colorMenu, setColorMenu] = useState({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });

  useEffect(() => {
    if (!classroomId || !month || !year) return;
    api.get('/gantt', { params: { classroom: classroomId, month, year, branch: selectedBranch } })
      .then(res => { setGantt(res.data.gantt); setHolidays(res.data.holidays || []); })
      .catch(() => toast.error('שגיאה בטעינת גאנט'))
      .finally(() => setLoading(false));

    api.get('/classrooms').then(res => {
      const cls = (res.data.classrooms || []).find(c => (c._id || c.id) === classroomId);
      if (cls) setClassroomName(cls.name);
    }).catch(() => {});
  }, [classroomId, month, year, selectedBranch]);

  const isHoliday = (date) => {
    if (!date) return null;
    const d = new Date(date);
    return holidays.find(h => d >= new Date(h.start_date) && d <= new Date(h.end_date));
  };

  const getCellContent = (weekIdx, rowKey, dayIndex) => {
    const cell = gantt?.weeks?.[weekIdx]?.cells?.find(c => c.row_key === rowKey && c.day_index === dayIndex);
    return cell?.content || '';
  };

  const getCellColor = (weekIdx, rowKey, dayIndex) => {
    const cell = gantt?.weeks?.[weekIdx]?.cells?.find(c => c.row_key === rowKey && c.day_index === dayIndex);
    return cell?.color || '';
  };

  const updateCell = (weekIdx, rowKey, dayIndex, content, color) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      if (!weeks[weekIdx]) return prev;
      const cells = [...(weeks[weekIdx].cells || [])];
      const idx = cells.findIndex(c => c.row_key === rowKey && c.day_index === dayIndex);
      const cellData = { row_key: rowKey, day_index: dayIndex, content: content ?? getCellContent(weekIdx, rowKey, dayIndex), color: color ?? getCellColor(weekIdx, rowKey, dayIndex) };
      if (idx >= 0) cells[idx] = cellData; else cells.push(cellData);
      weeks[weekIdx] = { ...weeks[weekIdx], cells };
      return { ...prev, weeks };
    });
  };

  const updateWeek = (weekIdx, field, value) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      weeks[weekIdx] = { ...weeks[weekIdx], [field]: value };
      return { ...prev, weeks };
    });
  };

  const addRow = () => {
    const label = prompt('שם השורה החדשה:');
    if (!label) return;
    setGantt(prev => ({
      ...prev,
      row_definitions: [...(prev.row_definitions || []), { key: 'custom_' + Date.now(), label }],
    }));
  };

  const removeRow = (key) => {
    setGantt(prev => ({
      ...prev,
      row_definitions: (prev.row_definitions || []).filter(r => r.key !== key),
    }));
  };

  const handleSave = async (status = 'draft') => {
    setSaving(true);
    try {
      await api.post('/gantt', {
        branch_id: selectedBranch, classroom_id: classroomId,
        academic_year: `${month >= 9 ? year : year - 1}-${month >= 9 ? year + 1 : year}`,
        month, year, row_definitions: gantt.row_definitions,
        weeks: gantt.weeks, status,
      });
      toast.success(status === 'pending' ? 'נשלח לאישור' : 'נשמר כטיוטה');
      if (status === 'pending') navigate('/gantt');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setSaving(false); }
  };

  const handleApprove = async () => {
    if (!gantt?._id) return toast.error('יש לשמור קודם');
    try {
      await api.post(`/gantt/${gantt._id}/approve`);
      toast.success('גאנט אושר!');
      setGantt(prev => ({ ...prev, status: 'approved' }));
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const handleColorPick = (color) => {
    const { weekIdx, rowKey, dayIdx } = colorMenu;
    updateCell(weekIdx, rowKey, dayIdx, undefined, color);
    setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });
  };

  if (loading) return <Typography sx={{ textAlign: 'center', py: 10 }}>טוען...</Typography>;
  if (!gantt) return <Typography>גאנט לא נמצא</Typography>;

  return (
    <Box dir="rtl">
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            תוכנית עבודה חודשית - {MONTH_NAMES[month]} {year}
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
          <Button variant="outlined" startIcon={<SaveIcon />} onClick={() => handleSave('draft')} disabled={saving}>טיוטה</Button>
          <Button variant="contained" color="warning" onClick={() => handleSave('pending')} disabled={saving}>שלח לאישור</Button>
          {isManager && gantt._id && gantt.status !== 'approved' && (
            <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} onClick={handleApprove}>אשר</Button>
          )}
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/gantt')}>חזרה</Button>
        </Stack>
      </Stack>

      {/* Weeks */}
      {(gantt.weeks || []).map((week, weekIdx) => {
        const weekStart = new Date(week.start_date);
        const weekEnd = new Date(week.end_date);

        return (
          <Card key={weekIdx} sx={{ mb: 3, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', borderRadius: 3, overflow: 'hidden' }}>
            {/* Week title bar */}
            <Box sx={{ bgcolor: '#1e3a5f', color: 'white', px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 2 }}>
              <Chip label={`שבוע ${week.week_number}`} size="small" sx={{ bgcolor: '#f59e0b', color: 'white', fontWeight: 700 }} />
              <Typography variant="body2" sx={{ opacity: 0.8 }}>
                {weekStart.toLocaleDateString('he-IL')} - {weekEnd.toLocaleDateString('he-IL')}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <TextField
                size="small" placeholder="נושא שבועי" value={week.topic || ''}
                onChange={e => updateWeek(weekIdx, 'topic', e.target.value)}
                variant="standard"
                sx={{ minWidth: 250 }}
                inputProps={{ style: { color: 'white', fontSize: '0.9rem', fontWeight: 700, textAlign: 'center' } }}
                InputProps={{ disableUnderline: false, sx: { '&:before': { borderColor: 'rgba(255,255,255,0.3)' } } }}
              />
            </Box>

            <TableContainer>
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ ...GANTT_STYLES.headerCell, width: 90 }}></TableCell>
                    {DAY_NAMES.map((day, dayIdx) => {
                      const dayDate = new Date(weekStart);
                      dayDate.setDate(dayDate.getDate() + dayIdx);
                      const holiday = isHoliday(dayDate);
                      const dateStr = dayDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
                      const isFri = dayIdx === 5;

                      return (
                        <TableCell key={dayIdx} sx={{
                          ...GANTT_STYLES.headerCell,
                          bgcolor: holiday ? '#b45309' : isFri ? '#4c1d95' : '#1e3a5f',
                        }}>
                          <Box>{day}</Box>
                          <Box sx={{ fontSize: '0.7rem', opacity: 0.7 }}>{dateStr}</Box>
                          {holiday && <Box sx={{ fontSize: '0.65rem', color: '#fde68a' }}>{holiday.name}</Box>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(gantt.row_definitions || []).map(row => (
                    <TableRow key={row.key}>
                      <TableCell sx={{ ...GANTT_STYLES.cell, ...GANTT_STYLES.rowLabel }}>
                        <Stack direction="row" justifyContent="center" alignItems="center" spacing={0.5}>
                          <Typography sx={{ fontSize: '0.8rem', fontWeight: 700 }}>{row.label}</Typography>
                          {row.key.startsWith('custom_') && (
                            <IconButton size="small" onClick={() => removeRow(row.key)} sx={{ p: 0 }}>
                              <DeleteIcon sx={{ fontSize: 12, color: '#94a3b8' }} />
                            </IconButton>
                          )}
                        </Stack>
                      </TableCell>
                      {DAY_NAMES.map((_, dayIdx) => {
                        const dayDate = new Date(weekStart);
                        dayDate.setDate(dayDate.getDate() + dayIdx);
                        const holiday = isHoliday(dayDate);
                        const isFri = dayIdx === 5;
                        const cellColor = getCellColor(weekIdx, row.key, dayIdx);

                        // Friday - קבלת שבת row
                        if (isFri && row.key === 'meeting') {
                          return (
                            <TableCell key={dayIdx} sx={{
                              ...GANTT_STYLES.cell, ...GANTT_STYLES.fridayCol,
                              textAlign: 'center', fontWeight: 700, fontSize: '0.85rem', color: '#4c1d95',
                            }}>
                              קבלת שבת
                            </TableCell>
                          );
                        }

                        // Friday - parent of shabbat
                        if (isFri && row.key === 'activity') {
                          return (
                            <TableCell key={dayIdx} sx={{ ...GANTT_STYLES.cell, ...GANTT_STYLES.fridayCol, p: '4px 6px' }}>
                              <Box sx={{ mb: 0.5 }}>
                                <Typography sx={{ fontSize: '0.65rem', color: '#6b7280', fontWeight: 600 }}>אבא של שבת:</Typography>
                                <TextField size="small" variant="standard" fullWidth
                                  value={week.friday_parent_father || ''}
                                  onChange={e => updateWeek(weekIdx, 'friday_parent_father', e.target.value)}
                                  inputProps={{ style: { fontSize: '0.75rem', textAlign: 'center', fontWeight: 600, padding: '2px 0' } }}
                                  InputProps={{ disableUnderline: true }}
                                />
                              </Box>
                              <Box>
                                <Typography sx={{ fontSize: '0.65rem', color: '#6b7280', fontWeight: 600 }}>אמא של שבת:</Typography>
                                <TextField size="small" variant="standard" fullWidth
                                  value={week.friday_parent_mother || ''}
                                  onChange={e => updateWeek(weekIdx, 'friday_parent_mother', e.target.value)}
                                  inputProps={{ style: { fontSize: '0.75rem', textAlign: 'center', fontWeight: 600, padding: '2px 0' } }}
                                  InputProps={{ disableUnderline: true }}
                                />
                              </Box>
                            </TableCell>
                          );
                        }

                        return (
                          <TableCell
                            key={dayIdx}
                            sx={{
                              ...GANTT_STYLES.cell,
                              bgcolor: cellColor || (holiday ? GANTT_STYLES.holidayCell.bgcolor : isFri ? GANTT_STYLES.fridayCol.bgcolor : 'white'),
                              position: 'relative',
                              '&:hover .color-btn': { opacity: 1 },
                            }}
                          >
                            {holiday && !getCellContent(weekIdx, row.key, dayIdx) ? (
                              <Typography sx={{ fontSize: '0.7rem', color: '#92400e', textAlign: 'center', fontStyle: 'italic' }}>
                                {holiday.name}
                              </Typography>
                            ) : (
                              <TextField
                                size="small" multiline maxRows={4} fullWidth variant="standard"
                                value={getCellContent(weekIdx, row.key, dayIdx)}
                                onChange={e => updateCell(weekIdx, row.key, dayIdx, e.target.value, undefined)}
                                inputProps={{ style: {
                                  fontSize: '0.75rem', textAlign: 'center', lineHeight: 1.4,
                                  fontFamily: '"Assistant", sans-serif', padding: '2px 0',
                                } }}
                                InputProps={{ disableUnderline: true }}
                              />
                            )}
                            {/* Color picker button */}
                            <IconButton
                              className="color-btn"
                              size="small"
                              sx={{ position: 'absolute', top: 0, left: 0, opacity: 0, transition: '0.2s', p: '1px' }}
                              onClick={(e) => setColorMenu({ anchor: e.currentTarget, weekIdx, rowKey: row.key, dayIdx })}
                            >
                              <PaletteIcon sx={{ fontSize: 12, color: '#94a3b8' }} />
                            </IconButton>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        );
      })}

      {/* Color picker menu */}
      <Menu
        anchorEl={colorMenu.anchor}
        open={Boolean(colorMenu.anchor)}
        onClose={() => setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null })}
      >
        {CELL_COLORS.map(c => (
          <MenuItem key={c.value} onClick={() => handleColorPick(c.value)} sx={{ gap: 1 }}>
            <Box sx={{ width: 20, height: 20, borderRadius: 1, bgcolor: c.value || '#fff', border: '1px solid #ddd' }} />
            {c.label}
          </MenuItem>
        ))}
      </Menu>

      {/* Print styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .MuiBox-root { visibility: visible !important; }
          table { visibility: visible !important; }
          td, th { visibility: visible !important; }
        }
      `}</style>
    </Box>
  );
}
