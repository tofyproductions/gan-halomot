import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, TextField, Button, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Chip, IconButton, Tooltip, Menu, MenuItem, Drawer,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PrintIcon from '@mui/icons-material/Print';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PaletteIcon from '@mui/icons-material/Palette';
import MergeIcon from '@mui/icons-material/CallMerge';
import SportsIcon from '@mui/icons-material/FitnessCenter';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { DndContext, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const MONTH_NAMES = {1:'ינואר',2:'פברואר',3:'מרץ',4:'אפריל',5:'מאי',6:'יוני',7:'יולי',8:'אוגוסט',9:'ספטמבר',10:'אוקטובר',11:'נובמבר',12:'דצמבר'};
const CELL_COLORS = [
  { label: 'ללא', value: '' }, { label: 'צהוב', value: '#fef9c3' },
  { label: 'ירוק', value: '#dcfce7' }, { label: 'כחול', value: '#dbeafe' },
  { label: 'ורוד', value: '#fce7f3' }, { label: 'סגול', value: '#ede9fe' },
  { label: 'כתום', value: '#ffedd5' },
];

// Draggable activity chip
function DraggableActivity({ activity }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `activity-${activity._id || activity.id}`,
    data: { type: 'activity', activity },
  });
  return (
    <Chip
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      icon={<DragIndicatorIcon sx={{ fontSize: 14 }} />}
      label={activity.name}
      size="small"
      sx={{
        cursor: 'grab', fontWeight: 600, mb: 0.5,
        bgcolor: activity.color || '#dbeafe',
        opacity: isDragging ? 0.4 : 1,
        '&:active': { cursor: 'grabbing' },
      }}
    />
  );
}

// Droppable gantt cell wrapper
function DroppableCell({ id, children, ...props }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <TableCell ref={setNodeRef} {...props} sx={{
      ...props.sx,
      outline: isOver ? '2px solid #f59e0b' : 'none',
      transition: 'outline 0.15s',
    }}>
      {children}
    </TableCell>
  );
}

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
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [classroomName, setClassroomName] = useState('');
  const [colorMenu, setColorMenu] = useState({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });
  const [showBank, setShowBank] = useState(false);
  const [activityDialog, setActivityDialog] = useState({ open: false, name: '', color: '#dbeafe', fixed_day: '' });
  const [draggingActivity, setDraggingActivity] = useState(null);
  // Merge selection
  const [mergeStart, setMergeStart] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);

  useEffect(() => {
    if (!classroomId || !month || !year) return;
    api.get('/gantt', { params: { classroom: classroomId, month, year, branch: selectedBranch } })
      .then(res => { setGantt(res.data.gantt); setHolidays(res.data.holidays || []); })
      .catch(() => toast.error('שגיאה'))
      .finally(() => setLoading(false));
    api.get('/classrooms').then(res => {
      const cls = (res.data.classrooms || []).find(c => (c._id || c.id) === classroomId);
      if (cls) setClassroomName(cls.name);
    }).catch(() => {});
    api.get('/activities').then(res => setActivities(res.data.activities || [])).catch(() => {});
  }, [classroomId, month, year, selectedBranch]);

  const isHoliday = (date) => {
    if (!date) return null;
    const d = new Date(date);
    return holidays.find(h => d >= new Date(h.start_date) && d <= new Date(h.end_date));
  };

  // Cell helpers
  const getCell = (wk, rk, di) => gantt?.weeks?.[wk]?.cells?.find(c => c.row_key === rk && c.day_index === di);
  const getVal = (wk, rk, di, field) => getCell(wk, rk, di)?.[field] || (field === 'col_span' || field === 'row_span' ? 1 : '');

  const isCellHidden = (wk, rk, di) => {
    const rows = gantt?.row_definitions || [];
    const rowIdx = rows.findIndex(r => r.key === rk);
    // Hidden by colSpan from left
    for (let d = 0; d < di; d++) {
      const cs = getVal(wk, rk, d, 'col_span');
      if (cs > 1 && d + cs > di) return true;
    }
    // Hidden by rowSpan from above
    for (let r = 0; r < rowIdx; r++) {
      const rs = getVal(wk, rows[r].key, di, 'row_span');
      if (rs > 1 && r + rs > rowIdx) return true;
    }
    return false;
  };

  const updateCell = (wk, rk, di, updates) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      if (!weeks[wk]) return prev;
      const cells = [...(weeks[wk].cells || [])];
      const idx = cells.findIndex(c => c.row_key === rk && c.day_index === di);
      const base = { row_key: rk, day_index: di, content: '', color: '', col_span: 1, row_span: 1 };
      const existing = idx >= 0 ? { ...base, ...cells[idx] } : base;
      const updated = { ...existing, ...updates };
      if (idx >= 0) cells[idx] = updated; else cells.push(updated);
      weeks[wk] = { ...weeks[wk], cells };
      return { ...prev, weeks };
    });
  };

  const updateWeek = (wk, field, value) => {
    setGantt(prev => {
      const weeks = [...(prev.weeks || [])];
      weeks[wk] = { ...weeks[wk], [field]: value };
      return { ...prev, weeks };
    });
  };

  // Merge: 2D
  const handleMergeClick = (wk, rk, di) => {
    if (!mergeMode) return;
    if (!mergeStart) {
      setMergeStart({ wk, rk, di });
      return;
    }
    if (mergeStart.wk !== wk) { toast.error('רק באותו שבוע'); setMergeStart(null); return; }

    const rows = gantt?.row_definitions || [];
    const r1 = rows.findIndex(r => r.key === mergeStart.rk);
    const r2 = rows.findIndex(r => r.key === rk);
    const d1 = Math.min(mergeStart.di, di);
    const d2 = Math.max(mergeStart.di, di);
    const rStart = Math.min(r1, r2);
    const rEnd = Math.max(r1, r2);

    const colSpan = d2 - d1 + 1;
    const rowSpan = rEnd - rStart + 1;

    if (colSpan === 1 && rowSpan === 1) {
      // Unmerge
      updateCell(wk, rows[rStart].key, d1, { col_span: 1, row_span: 1 });
    } else {
      updateCell(wk, rows[rStart].key, d1, { col_span: colSpan, row_span: rowSpan });
      // Clear hidden cells
      for (let r = rStart; r <= rEnd; r++) {
        for (let d = d1; d <= d2; d++) {
          if (r === rStart && d === d1) continue;
          updateCell(wk, rows[r].key, d, { content: '', col_span: 1, row_span: 1 });
        }
      }
      toast.success(`${colSpan}×${rowSpan} תאים אוחדו`);
    }
    setMergeStart(null);
    setMergeMode(false);
  };

  // DnD handler
  const handleDragEnd = (event) => {
    setDraggingActivity(null);
    const { active, over } = event;
    if (!over || !active.data.current?.activity) return;

    const activity = active.data.current.activity;
    // over.id format: "cell-weekIdx-rowKey-dayIdx"
    const parts = over.id.split('-');
    if (parts[0] !== 'cell') return;
    const wk = parseInt(parts[1]);
    const rk = parts.slice(2, -1).join('-');
    const di = parseInt(parts[parts.length - 1]);

    updateCell(wk, rk, di, { content: activity.name, color: activity.color || '#dbeafe' });
  };

  const handleDragStart = (event) => {
    const act = event.active.data.current?.activity;
    if (act) setDraggingActivity(act);
  };

  const addRow = () => { const l = prompt('שם:'); if (l) setGantt(prev => ({ ...prev, row_definitions: [...(prev.row_definitions||[]), { key: 'c_'+Date.now(), label: l }] })); };
  const removeRow = (k) => setGantt(prev => ({ ...prev, row_definitions: (prev.row_definitions||[]).filter(r => r.key !== k) }));

  const handleSave = async (status = 'draft') => {
    setSaving(true);
    try {
      await api.post('/gantt', {
        branch_id: selectedBranch, classroom_id: classroomId,
        academic_year: `${month >= 9 ? year : year-1}-${month >= 9 ? year+1 : year}`,
        month, year, row_definitions: gantt.row_definitions, weeks: gantt.weeks, status,
      });
      toast.success(status === 'pending' ? 'נשלח לאישור' : 'נשמר');
      if (status === 'pending') navigate('/gantt');
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
    finally { setSaving(false); }
  };

  const handleApprove = async () => {
    if (!gantt?._id) return toast.error('שמור קודם');
    try { await api.post(`/gantt/${gantt._id}/approve`); toast.success('אושר!'); setGantt(p => ({...p, status:'approved'})); }
    catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const addActivity = async () => {
    const { name, color, fixed_day } = activityDialog;
    if (!name) return toast.error('שם חובה');
    try {
      await api.post('/activities', { branch_id: selectedBranch, name, color, fixed_day: fixed_day !== '' ? parseInt(fixed_day) : null });
      toast.success('חוג נוסף');
      setActivityDialog({ open: false, name: '', color: '#dbeafe', fixed_day: '' });
      api.get('/activities').then(res => setActivities(res.data.activities || []));
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  if (loading) return <Typography sx={{ textAlign: 'center', py: 10 }}>טוען...</Typography>;
  if (!gantt) return <Typography>גאנט לא נמצא</Typography>;

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <Box dir="rtl">
        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 800 }}>
              תוכנית עבודה - {MONTH_NAMES[month]} {year}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {classroomName}
              {gantt.status !== 'draft' && <Chip label={gantt.status === 'approved' ? 'מאושר' : 'ממתין'} color={gantt.status === 'approved' ? 'success' : 'warning'} size="small" sx={{ ml: 1 }} />}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Button size="small" startIcon={<PrintIcon />} onClick={() => window.print()}>הדפסה</Button>
            <Button size="small" startIcon={<SportsIcon />} onClick={() => setShowBank(true)} color="secondary">בנק חוגים</Button>
            <Button size="small" startIcon={<AddIcon />} onClick={addRow}>שורה</Button>
            <Button size="small" startIcon={<MergeIcon />} color={mergeMode ? 'warning' : 'inherit'}
              onClick={() => { setMergeMode(!mergeMode); setMergeStart(null); if (!mergeMode) toast.info('לחץ על 2 תאים לאיחוד'); }}
            >{mergeMode ? 'בטל איחוד' : 'אחד תאים'}</Button>
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
          const rows = gantt.row_definitions || [];

          return (
            <Card key={weekIdx} sx={{ mb: 3, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', borderRadius: 3, overflow: 'hidden' }}>
              <Box sx={{ bgcolor: '#1e3a5f', color: 'white', px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 2 }}>
                <Chip label={`שבוע ${week.week_number}`} size="small" sx={{ bgcolor: '#f59e0b', color: 'white', fontWeight: 700 }} />
                <Typography sx={{ opacity: 0.8, fontSize: '0.85rem' }}>
                  {new Date(week.start_date).toLocaleDateString('he-IL')} - {new Date(week.end_date).toLocaleDateString('he-IL')}
                </Typography>
                <Box sx={{ flex: 1, textAlign: 'center' }}>
                  <TextField size="small" placeholder="נושא שבועי" value={week.topic || ''}
                    onChange={e => updateWeek(weekIdx, 'topic', e.target.value)}
                    variant="standard" sx={{ minWidth: 300 }}
                    inputProps={{ style: { color: 'white', fontSize: '1rem', fontWeight: 700, textAlign: 'center' } }}
                    InputProps={{ disableUnderline: false, sx: { '&:before': { borderColor: 'rgba(255,255,255,0.4)' } } }}
                  />
                </Box>
              </Box>

              <TableContainer>
                <Table size="small" sx={{ tableLayout: 'fixed' }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ bgcolor: '#1e3a5f', color: 'white', fontWeight: 700, textAlign: 'center', width: 90, p: 1 }}></TableCell>
                      {DAY_NAMES.map((day, di) => {
                        const dd = new Date(weekStart); dd.setDate(dd.getDate() + di);
                        const hol = isHoliday(dd);
                        return (
                          <TableCell key={di} sx={{ bgcolor: hol ? '#92400e' : di===5 ? '#5b21b6' : '#1e3a5f', color: 'white', fontWeight: 700, textAlign: 'center', p: 1 }}>
                            <Box sx={{ fontWeight: 800 }}>{day}</Box>
                            <Box sx={{ fontSize: '0.8rem', opacity: 0.8 }}>{dd.toLocaleDateString('he-IL', { day:'numeric', month:'numeric' })}</Box>
                            {hol && <Box sx={{ fontSize: '0.7rem', color: '#fde68a' }}>{hol.name}</Box>}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row, rowIdx) => (
                      <TableRow key={row.key}>
                        <TableCell sx={{ bgcolor: '#f1f5f9', fontWeight: 800, fontSize: '0.9rem', textAlign: 'center', borderLeft: '2px solid #cbd5e1', p: 1 }}>
                          <Stack direction="row" justifyContent="center" alignItems="center" spacing={0.5}>
                            <span>{row.label}</span>
                            {row.key.startsWith('c') && row.key.includes('_') && (
                              <IconButton size="small" onClick={() => removeRow(row.key)} sx={{ p: 0 }}>
                                <DeleteIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                              </IconButton>
                            )}
                          </Stack>
                        </TableCell>
                        {DAY_NAMES.map((_, di) => {
                          if (isCellHidden(weekIdx, row.key, di)) return null;
                          const dd = new Date(weekStart); dd.setDate(dd.getDate() + di);
                          const hol = isHoliday(dd);
                          const isFri = di === 5;
                          const cc = getVal(weekIdx, row.key, di, 'color');
                          const cs = getVal(weekIdx, row.key, di, 'col_span');
                          const rs = getVal(weekIdx, row.key, di, 'row_span');
                          const isSelected = mergeStart?.wk === weekIdx && mergeStart?.rk === row.key && mergeStart?.di === di;
                          const cellId = `cell-${weekIdx}-${row.key}-${di}`;

                          // Friday specials
                          if (isFri && row.key === 'meeting') {
                            return <TableCell key={di} colSpan={cs} rowSpan={rs} sx={{ bgcolor: '#ede9fe', textAlign: 'center', p: 1, fontWeight: 800, fontSize: '1rem', color: '#5b21b6', border: '1px solid #e2e8f0' }}>קבלת שבת</TableCell>;
                          }
                          if (isFri && row.key === 'activity') {
                            return (
                              <TableCell key={di} colSpan={cs} rowSpan={rs} sx={{ bgcolor: '#ede9fe', p: 1.5, border: '1px solid #e2e8f0' }}>
                                <Stack spacing={1}>
                                  <Box>
                                    <Typography sx={{ fontSize: '0.8rem', color: '#5b21b6', fontWeight: 700 }}>אבא של שבת:</Typography>
                                    <TextField size="small" variant="outlined" fullWidth placeholder="שם הילד"
                                      value={week.friday_parent_father || ''} onChange={e => updateWeek(weekIdx, 'friday_parent_father', e.target.value)}
                                      inputProps={{ style: { fontSize: '0.85rem', textAlign: 'center', fontWeight: 600, padding: '6px 8px' } }}
                                      sx={{ bgcolor: 'white', borderRadius: 1 }}
                                    />
                                  </Box>
                                  <Box>
                                    <Typography sx={{ fontSize: '0.8rem', color: '#5b21b6', fontWeight: 700 }}>אמא של שבת:</Typography>
                                    <TextField size="small" variant="outlined" fullWidth placeholder="שם הילדה"
                                      value={week.friday_parent_mother || ''} onChange={e => updateWeek(weekIdx, 'friday_parent_mother', e.target.value)}
                                      inputProps={{ style: { fontSize: '0.85rem', textAlign: 'center', fontWeight: 600, padding: '6px 8px' } }}
                                      sx={{ bgcolor: 'white', borderRadius: 1 }}
                                    />
                                  </Box>
                                </Stack>
                              </TableCell>
                            );
                          }

                          return (
                            <DroppableCell key={di} id={cellId} colSpan={cs} rowSpan={rs}
                              onClick={() => mergeMode && handleMergeClick(weekIdx, row.key, di)}
                              sx={{
                                bgcolor: cc || (hol ? '#fef3c7' : isFri ? '#f5f3ff' : 'white'),
                                border: isSelected ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                                p: 1, verticalAlign: 'top', cursor: mergeMode ? 'crosshair' : 'default',
                                position: 'relative', '&:hover .ca': { opacity: 1 },
                              }}
                            >
                              <TextField size="small" multiline maxRows={5} fullWidth variant="standard"
                                value={getVal(weekIdx, row.key, di, 'content')}
                                onChange={e => updateCell(weekIdx, row.key, di, { content: e.target.value })}
                                inputProps={{ style: { fontSize: '0.9rem', textAlign: 'center', lineHeight: 1.5, padding: '4px 0' } }}
                                InputProps={{ disableUnderline: true }}
                              />
                              <Box className="ca" sx={{ position: 'absolute', top: 0, left: 0, opacity: 0, transition: '0.2s', display: 'flex', gap: '1px' }}>
                                <IconButton size="small" sx={{ p: '2px' }} onClick={e => { e.stopPropagation(); setColorMenu({ anchor: e.currentTarget, weekIdx, rowKey: row.key, dayIdx: di }); }}>
                                  <PaletteIcon sx={{ fontSize: 13, color: '#94a3b8' }} />
                                </IconButton>
                              </Box>
                              {(cs > 1 || rs > 1) && (
                                <IconButton size="small" sx={{ position: 'absolute', bottom: 0, left: 0, p: '2px' }}
                                  onClick={() => updateCell(weekIdx, row.key, di, { col_span: 1, row_span: 1 })}>
                                  <Typography sx={{ fontSize: '0.55rem', color: '#94a3b8' }}>✕</Typography>
                                </IconButton>
                              )}
                            </DroppableCell>
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

        {/* Color menu */}
        <Menu anchorEl={colorMenu.anchor} open={Boolean(colorMenu.anchor)}
          onClose={() => setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null })}>
          {CELL_COLORS.map(c => (
            <MenuItem key={c.value} onClick={() => {
              updateCell(colorMenu.weekIdx, colorMenu.rowKey, colorMenu.dayIdx, { color: c.value });
              setColorMenu({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });
            }} sx={{ gap: 1 }}>
              <Box sx={{ width: 18, height: 18, borderRadius: 1, bgcolor: c.value || '#fff', border: '1px solid #ddd' }} />
              {c.label}
            </MenuItem>
          ))}
        </Menu>

        {/* Activity Bank Drawer */}
        <Drawer anchor="left" open={showBank} onClose={() => setShowBank(false)}>
          <Box sx={{ width: 280, p: 2 }} dir="rtl">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>בנק חוגים</Typography>
              <IconButton size="small" onClick={() => setActivityDialog({ open: true, name: '', color: '#dbeafe', fixed_day: '' })}>
                <AddIcon />
              </IconButton>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
              גרור חוג לתא בגאנט
            </Typography>
            <Stack spacing={0.5}>
              {activities.length === 0 && <Typography variant="body2" color="text.secondary">אין חוגים. הוסף חוג חדש.</Typography>}
              {activities.map(a => (
                <Stack key={a._id || a.id} direction="row" alignItems="center" spacing={1}>
                  <DraggableActivity activity={a} />
                  {a.fixed_day != null && (
                    <Typography variant="caption" color="text.secondary">{DAY_NAMES[a.fixed_day]}</Typography>
                  )}
                  <IconButton size="small" onClick={async () => {
                    await api.delete(`/activities/${a._id || a.id}`);
                    setActivities(prev => prev.filter(x => (x._id||x.id) !== (a._id||a.id)));
                  }}>
                    <DeleteIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          </Box>
        </Drawer>

        {/* Add Activity Dialog */}
        <Dialog open={activityDialog.open} onClose={() => setActivityDialog({ open: false, name: '', color: '#dbeafe', fixed_day: '' })} dir="rtl" maxWidth="xs" fullWidth>
          <DialogTitle sx={{ fontWeight: 700 }}>הוסף חוג</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField label="שם החוג" value={activityDialog.name} onChange={e => setActivityDialog(p => ({...p, name: e.target.value}))} fullWidth />
              <TextField label="יום קבוע (אופציונלי)" select value={activityDialog.fixed_day} onChange={e => setActivityDialog(p => ({...p, fixed_day: e.target.value}))} fullWidth>
                <MenuItem value="">ללא - גמיש</MenuItem>
                {DAY_NAMES.map((d, i) => <MenuItem key={i} value={i}>{d}</MenuItem>)}
              </TextField>
              <Box>
                <Typography variant="body2" sx={{ mb: 1 }}>צבע:</Typography>
                <Stack direction="row" spacing={0.5}>
                  {CELL_COLORS.filter(c => c.value).map(c => (
                    <Box key={c.value} onClick={() => setActivityDialog(p => ({...p, color: c.value}))}
                      sx={{ width: 28, height: 28, borderRadius: 1, bgcolor: c.value, cursor: 'pointer',
                        border: activityDialog.color === c.value ? '2px solid #333' : '1px solid #ddd' }} />
                  ))}
                </Stack>
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setActivityDialog({ open: false, name: '', color: '#dbeafe', fixed_day: '' })}>ביטול</Button>
            <Button variant="contained" onClick={addActivity}>הוסף</Button>
          </DialogActions>
        </Dialog>

        {/* Drag overlay */}
        <DragOverlay>
          {draggingActivity && (
            <Chip label={draggingActivity.name} sx={{ bgcolor: draggingActivity.color, fontWeight: 700, boxShadow: 3 }} />
          )}
        </DragOverlay>
      </Box>
    </DndContext>
  );
}
