import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, TextField, Button, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Chip, IconButton, Tooltip, Menu, MenuItem,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PrintIcon from '@mui/icons-material/Print';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PaletteIcon from '@mui/icons-material/Palette';
import MergeIcon from '@mui/icons-material/CallMerge';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const MONTH_NAMES = {1:'ינואר',2:'פברואר',3:'מרץ',4:'אפריל',5:'מאי',6:'יוני',7:'יולי',8:'אוגוסט',9:'ספטמבר',10:'אוקטובר',11:'נובמבר',12:'דצמבר'};

const CELL_COLORS = [
  { label: 'ללא', value: '' },
  { label: 'צהוב', value: '#fef9c3' },
  { label: 'ירוק', value: '#dcfce7' },
  { label: 'כחול', value: '#dbeafe' },
  { label: 'ורוד', value: '#fce7f3' },
  { label: 'סגול', value: '#ede9fe' },
  { label: 'כתום', value: '#ffedd5' },
];

// Font sizes
const FONT = { cell: '0.9rem', header: '0.9rem', label: '0.9rem', friday: '0.85rem' };

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
  // Merge selection: track selected cells
  const [mergeStart, setMergeStart] = useState(null); // { weekIdx, rowKey, dayIdx }

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

  // Cell helpers
  const getCell = (weekIdx, rowKey, dayIdx) =>
    gantt?.weeks?.[weekIdx]?.cells?.find(c => c.row_key === rowKey && c.day_index === dayIdx);
  const getCellContent = (weekIdx, rowKey, dayIdx) => getCell(weekIdx, rowKey, dayIdx)?.content || '';
  const getCellColor = (weekIdx, rowKey, dayIdx) => getCell(weekIdx, rowKey, dayIdx)?.color || '';
  const getCellMerge = (weekIdx, rowKey, dayIdx) => getCell(weekIdx, rowKey, dayIdx)?.merge_span || 0;
  const isCellHidden = (weekIdx, rowKey, dayIdx) => {
    // Check if this cell is covered by a merge from a cell to the right (lower dayIdx in RTL)
    for (let d = 0; d < dayIdx; d++) {
      const span = getCellMerge(weekIdx, rowKey, d);
      if (span > 0 && d + span > dayIdx) return true;
    }
    return false;
  };

  const updateCell = (weekIdx, rowKey, dayIdx, updates) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      if (!weeks[weekIdx]) return prev;
      const cells = [...(weeks[weekIdx].cells || [])];
      const idx = cells.findIndex(c => c.row_key === rowKey && c.day_index === dayIdx);
      const existing = idx >= 0 ? cells[idx] : { row_key: rowKey, day_index: dayIdx, content: '', color: '', merge_span: 0 };
      const updated = { ...existing, ...updates };
      if (idx >= 0) cells[idx] = updated; else cells.push(updated);
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

  // Merge cells
  const handleMerge = (weekIdx, rowKey, dayIdx) => {
    if (!mergeStart) {
      setMergeStart({ weekIdx, rowKey, dayIdx });
      toast.info('בחר את התא האחרון לאיחוד (באותה שורה)');
      return;
    }

    if (mergeStart.weekIdx !== weekIdx || mergeStart.rowKey !== rowKey) {
      toast.error('ניתן לאחד תאים רק באותה שורה ושבוע');
      setMergeStart(null);
      return;
    }

    const startDay = Math.min(mergeStart.dayIdx, dayIdx);
    const endDay = Math.max(mergeStart.dayIdx, dayIdx);
    const span = endDay - startDay + 1;

    if (span <= 1) {
      // Unmerge
      updateCell(weekIdx, rowKey, startDay, { merge_span: 0 });
      setMergeStart(null);
      return;
    }

    // Set merge on the first cell (rightmost in RTL = lowest index)
    updateCell(weekIdx, rowKey, startDay, { merge_span: span });
    // Clear content of hidden cells
    for (let d = startDay + 1; d <= endDay; d++) {
      updateCell(weekIdx, rowKey, d, { content: '', merge_span: 0 });
    }

    toast.success(`${span} תאים אוחדו`);
    setMergeStart(null);
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
      toast.success(status === 'pending' ? 'נשלח לאישור' : 'נשמר');
      if (status === 'pending') navigate('/gantt');
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
    finally { setSaving(false); }
  };

  const handleApprove = async () => {
    if (!gantt?._id) return toast.error('שמור קודם');
    try {
      await api.post(`/gantt/${gantt._id}/approve`);
      toast.success('גאנט אושר!');
      setGantt(prev => ({ ...prev, status: 'approved' }));
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
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
            {gantt.status === 'pending' && <Chip label="ממתין" color="warning" size="small" sx={{ ml: 1 }} />}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<PrintIcon />} onClick={() => window.print()}>הדפסה</Button>
          <Button size="small" startIcon={<AddIcon />} onClick={addRow}>שורה</Button>
          <Button size="small" startIcon={<MergeIcon />}
            color={mergeStart ? 'warning' : 'inherit'}
            onClick={() => { if (mergeStart) { setMergeStart(null); toast.info('איחוד בוטל'); } else toast.info('לחץ על שני תאים באותה שורה לאיחוד'); }}
          >
            {mergeStart ? 'בטל איחוד' : 'אחד תאים'}
          </Button>
          <Button variant="outlined" startIcon={<SaveIcon />} onClick={() => handleSave('draft')} disabled={saving}>שמור</Button>
          <Button variant="contained" color="warning" onClick={() => handleSave('pending')} disabled={saving}>לאישור</Button>
          {isManager && gantt._id && gantt.status !== 'approved' && (
            <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} onClick={handleApprove}>אשר</Button>
          )}
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/gantt')}>חזרה</Button>
        </Stack>
      </Stack>

      {/* Weeks */}
      {(gantt.weeks || []).map((week, weekIdx) => {
        const weekStart = new Date(week.start_date);

        return (
          <Card key={weekIdx} sx={{ mb: 3, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', borderRadius: 3, overflow: 'hidden' }}>
            {/* Week title */}
            <Box sx={{ bgcolor: '#1e3a5f', color: 'white', px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 2 }}>
              <Chip label={`שבוע ${week.week_number}`} size="small" sx={{ bgcolor: '#f59e0b', color: 'white', fontWeight: 700 }} />
              <Typography sx={{ opacity: 0.8, fontSize: '0.85rem' }}>
                {new Date(week.start_date).toLocaleDateString('he-IL')} - {new Date(week.end_date).toLocaleDateString('he-IL')}
              </Typography>
              <Box sx={{ flex: 1, textAlign: 'center' }}>
                <TextField
                  size="small" placeholder="נושא שבועי" value={week.topic || ''}
                  onChange={e => updateWeek(weekIdx, 'topic', e.target.value)}
                  variant="standard"
                  sx={{ minWidth: 300 }}
                  inputProps={{ style: { color: 'white', fontSize: '1rem', fontWeight: 700, textAlign: 'center' } }}
                  InputProps={{ disableUnderline: false, sx: { '&:before': { borderColor: 'rgba(255,255,255,0.4)' } } }}
                />
              </Box>
            </Box>

            <TableContainer>
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ bgcolor: '#1e3a5f', color: 'white', fontWeight: 700, fontSize: FONT.header, textAlign: 'center', width: 90, p: 1 }}></TableCell>
                    {DAY_NAMES.map((day, dayIdx) => {
                      const dayDate = new Date(weekStart);
                      dayDate.setDate(dayDate.getDate() + dayIdx);
                      const holiday = isHoliday(dayDate);
                      const isFri = dayIdx === 5;

                      return (
                        <TableCell key={dayIdx} sx={{
                          bgcolor: holiday ? '#92400e' : isFri ? '#5b21b6' : '#1e3a5f',
                          color: 'white', fontWeight: 700, fontSize: FONT.header, textAlign: 'center', p: 1,
                        }}>
                          <Box sx={{ fontWeight: 800 }}>{day}</Box>
                          <Box sx={{ fontSize: '0.8rem', opacity: 0.8 }}>
                            {dayDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}
                          </Box>
                          {holiday && <Box sx={{ fontSize: '0.7rem', color: '#fde68a' }}>{holiday.name}</Box>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(gantt.row_definitions || []).map(row => (
                    <TableRow key={row.key}>
                      {/* Row label */}
                      <TableCell sx={{
                        bgcolor: '#f1f5f9', fontWeight: 800, fontSize: FONT.label,
                        textAlign: 'center', borderLeft: '2px solid #cbd5e1', p: 1,
                      }}>
                        <Stack direction="row" justifyContent="center" alignItems="center" spacing={0.5}>
                          <span>{row.label}</span>
                          {row.key.startsWith('custom_') && (
                            <IconButton size="small" onClick={() => removeRow(row.key)} sx={{ p: 0 }}>
                              <DeleteIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                            </IconButton>
                          )}
                        </Stack>
                      </TableCell>

                      {/* Day cells */}
                      {DAY_NAMES.map((_, dayIdx) => {
                        // Skip if hidden by merge
                        if (isCellHidden(weekIdx, row.key, dayIdx)) return null;

                        const dayDate = new Date(weekStart);
                        dayDate.setDate(dayDate.getDate() + dayIdx);
                        const holiday = isHoliday(dayDate);
                        const isFri = dayIdx === 5;
                        const cellColor = getCellColor(weekIdx, row.key, dayIdx);
                        const mergeSpan = getCellMerge(weekIdx, row.key, dayIdx);
                        const colSpan = mergeSpan > 1 ? mergeSpan : 1;
                        const isSelected = mergeStart?.weekIdx === weekIdx && mergeStart?.rowKey === row.key && mergeStart?.dayIdx === dayIdx;

                        // Friday special cells
                        if (isFri && row.key === 'meeting') {
                          return (
                            <TableCell key={dayIdx} colSpan={colSpan} sx={{
                              bgcolor: '#ede9fe', textAlign: 'center', p: 1,
                              fontWeight: 800, fontSize: '1rem', color: '#5b21b6',
                              border: '1px solid #e2e8f0',
                            }}>
                              קבלת שבת
                            </TableCell>
                          );
                        }

                        if (isFri && row.key === 'activity') {
                          return (
                            <TableCell key={dayIdx} colSpan={colSpan} sx={{
                              bgcolor: '#ede9fe', p: 1.5, border: '1px solid #e2e8f0',
                            }}>
                              <Stack spacing={1.5}>
                                <Box>
                                  <Typography sx={{ fontSize: '0.8rem', color: '#5b21b6', fontWeight: 700, mb: 0.5 }}>
                                    אבא של שבת:
                                  </Typography>
                                  <TextField
                                    size="small" variant="outlined" fullWidth
                                    placeholder="שם הילד"
                                    value={week.friday_parent_father || ''}
                                    onChange={e => updateWeek(weekIdx, 'friday_parent_father', e.target.value)}
                                    inputProps={{ style: { fontSize: FONT.friday, textAlign: 'center', fontWeight: 600, padding: '6px 8px' } }}
                                    sx={{ bgcolor: 'white', borderRadius: 1 }}
                                  />
                                </Box>
                                <Box>
                                  <Typography sx={{ fontSize: '0.8rem', color: '#5b21b6', fontWeight: 700, mb: 0.5 }}>
                                    אמא של שבת:
                                  </Typography>
                                  <TextField
                                    size="small" variant="outlined" fullWidth
                                    placeholder="שם הילדה"
                                    value={week.friday_parent_mother || ''}
                                    onChange={e => updateWeek(weekIdx, 'friday_parent_mother', e.target.value)}
                                    inputProps={{ style: { fontSize: FONT.friday, textAlign: 'center', fontWeight: 600, padding: '6px 8px' } }}
                                    sx={{ bgcolor: 'white', borderRadius: 1 }}
                                  />
                                </Box>
                              </Stack>
                            </TableCell>
                          );
                        }

                        // Regular cell
                        return (
                          <TableCell
                            key={dayIdx}
                            colSpan={colSpan}
                            onClick={() => mergeStart ? handleMerge(weekIdx, row.key, dayIdx) : null}
                            sx={{
                              bgcolor: cellColor || (holiday ? '#fef3c7' : isFri ? '#f5f3ff' : 'white'),
                              border: isSelected ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                              p: 1, verticalAlign: 'top', position: 'relative',
                              cursor: mergeStart ? 'pointer' : 'default',
                              minHeight: 60,
                              '&:hover .cell-actions': { opacity: 1 },
                            }}
                          >
                            {holiday && !getCellContent(weekIdx, row.key, dayIdx) ? (
                              <Typography sx={{ fontSize: '0.85rem', color: '#92400e', textAlign: 'center', fontStyle: 'italic' }}>
                                {holiday.name}
                              </Typography>
                            ) : (
                              <TextField
                                size="small" multiline maxRows={5} fullWidth variant="standard"
                                value={getCellContent(weekIdx, row.key, dayIdx)}
                                onChange={e => updateCell(weekIdx, row.key, dayIdx, { content: e.target.value })}
                                inputProps={{ style: {
                                  fontSize: FONT.cell, textAlign: 'center', lineHeight: 1.5,
                                  fontFamily: '"Assistant", sans-serif', padding: '4px 0',
                                } }}
                                InputProps={{ disableUnderline: true }}
                              />
                            )}
                            {/* Cell action buttons */}
                            <Box className="cell-actions" sx={{
                              position: 'absolute', top: 1, left: 1,
                              opacity: 0, transition: '0.2s',
                              display: 'flex', gap: '1px',
                            }}>
                              <IconButton size="small" sx={{ p: '2px' }}
                                onClick={(e) => { e.stopPropagation(); setColorMenu({ anchor: e.currentTarget, weekIdx, rowKey: row.key, dayIdx }); }}
                              >
                                <PaletteIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                              </IconButton>
                              <IconButton size="small" sx={{ p: '2px' }}
                                onClick={(e) => { e.stopPropagation(); handleMerge(weekIdx, row.key, dayIdx); }}
                              >
                                <MergeIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                              </IconButton>
                            </Box>
                            {mergeSpan > 1 && (
                              <Tooltip title="ביטול איחוד">
                                <IconButton size="small" sx={{ position: 'absolute', bottom: 1, left: 1, p: '2px' }}
                                  onClick={() => updateCell(weekIdx, row.key, dayIdx, { merge_span: 0 })}
                                >
                                  <Typography sx={{ fontSize: '0.6rem', color: '#94a3b8' }}>✕</Typography>
                                </IconButton>
                              </Tooltip>
                            )}
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

      {/* Color picker */}
      <Menu anchorEl={colorMenu.anchor} open={Boolean(colorMenu.anchor)}
        onClose={() => setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null })}
      >
        {CELL_COLORS.map(c => (
          <MenuItem key={c.value} onClick={() => {
            updateCell(colorMenu.weekIdx, colorMenu.rowKey, colorMenu.dayIdx, { color: c.value });
            setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });
          }} sx={{ gap: 1 }}>
            <Box sx={{ width: 20, height: 20, borderRadius: 1, bgcolor: c.value || '#fff', border: '1px solid #ddd' }} />
            {c.label}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}
