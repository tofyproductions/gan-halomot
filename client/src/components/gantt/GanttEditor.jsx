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
import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { DndContext, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ContentBankPanel, { BANK_ROWS } from './ContentBankPanel';
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

/**
 * A gantt cell: a drop target, and — once it has text — a drag source too.
 *
 * Moving a box from Tuesday to Thursday used to mean selecting the text,
 * cutting it, clicking the other box and pasting, then remembering to clear the
 * first one. It is the single most common edit a gananet makes to a plan, so it
 * is a drag.
 *
 * The grip is a small handle rather than the whole cell, deliberately: the cell
 * is a text field, and making the text itself draggable takes away her ability
 * to select a word inside it.
 */
function GanttCell({ id, dragId, dragPayload, canDrag, children, ...props }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id });
  const {
    attributes, listeners, setNodeRef: setDragRef, isDragging,
  } = useDraggable({ id: dragId, data: { type: 'cell', cell: dragPayload }, disabled: !canDrag });

  return (
    <TableCell
      ref={setDropRef}
      {...props}
      sx={{
        ...props.sx,
        outline: isOver ? '2px solid #f59e0b' : 'none',
        opacity: isDragging ? 0.45 : 1,
        transition: 'outline 0.15s, opacity 0.15s',
      }}
    >
      {canDrag && (
        <Box
          ref={setDragRef}
          {...listeners}
          {...attributes}
          className="ca"
          sx={{
            // insetInlineEnd, not `right`. The app's emotion RTL plugin rewrites
            // physical left/right, so a handle written as `right: 2` silently
            // lands on the left — which is where the colour button already is.
            // The logical property says the corner and survives the rewrite.
            position: 'absolute', top: 2, insetInlineEnd: 2,
            opacity: 0, transition: '0.2s',
            cursor: 'grab', lineHeight: 0, '&:active': { cursor: 'grabbing' },
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 13, color: '#94a3b8' }} />
        </Box>
      )}
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
  const [classroomCategory, setClassroomCategory] = useState('');
  const [classSessions, setClassSessions] = useState([]); // read-only reflection from מעקב חוגים
  const [colorMenu, setColorMenu] = useState({ anchor: null, weekIdx: null, rowKey: null, dayIdx: null });
  const [showBank, setShowBank] = useState(false);
  const [showContentBank, setShowContentBank] = useState(false);
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
      if (cls) { setClassroomName(cls.name); setClassroomCategory(cls.category || ''); }
    }).catch(() => {});
    api.get('/activities').then(res => setActivities(res.data.activities || [])).catch(() => {});
    // Reflect class-tracking sessions for this branch+month onto the gantt days.
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    api.get('/classes/sessions', { params: { branch: selectedBranch, month: ym } })
      .then(res => setClassSessions(res.data.sessions || []))
      .catch(() => setClassSessions([]));
  }, [classroomId, month, year, selectedBranch]);

  const isHoliday = (date) => {
    if (!date) return null;
    const d = new Date(date);
    return holidays.find(h => d >= new Date(h.start_date) && d <= new Date(h.end_date));
  };

  // Read-only reflection of מעקב-חוגים sessions onto gantt days. A session shows
  // on this classroom's gantt when its program category matches this classroom
  // (or either side is unset = general). Purely informational; never saved.
  const localYmd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const sessionsOnDate = (dd) => {
    const ymd = localYmd(dd);
    return classSessions.filter(s => s.date === ymd
      && (!classroomCategory || !s.program_id?.classroom_category || s.program_id.classroom_category === classroomCategory));
  };
  const SESSION_TINT = { occurred: '#dcfce7', no_show: '#fee2e2', postponed: '#ffedd5', scheduled: '#f1f5f9' };

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

  // "cell-<weekIdx>-<rowKey>-<dayIdx>". The row key is rejoined rather than
  // taken as one part, because a row added by hand is keyed "c_1724…".
  const parseCellId = (id) => {
    const parts = String(id).split('-');
    if (parts[0] !== 'cell') return null;
    return {
      wk: parseInt(parts[1]),
      rk: parts.slice(2, -1).join('-'),
      di: parseInt(parts[parts.length - 1]),
    };
  };

  const handleDragEnd = (event) => {
    setDraggingActivity(null);
    const { active, over } = event;
    if (!over) return;

    const target = parseCellId(over.id);
    if (!target) return;

    // From one of the banks: fill the box.
    const activity = active.data.current?.activity;
    if (activity) {
      updateCell(target.wk, target.rk, target.di, {
        content: activity.name, color: activity.color || '#dbeafe',
      });
      return;
    }

    // From another box in the plan: SWAP, never overwrite. Moving Tuesday onto
    // a full Thursday and losing Thursday is the one outcome she cannot undo,
    // and a swap is what she meant every time — the two ideas trade places.
    const from = active.data.current?.cell;
    if (!from) return;
    if (from.wk === target.wk && from.rk === target.rk && from.di === target.di) return;

    const to = getCell(target.wk, target.rk, target.di);
    updateCell(target.wk, target.rk, target.di, { content: from.content, color: from.color });
    updateCell(from.wk, from.rk, from.di, { content: to?.content || '', color: to?.color || '' });
  };

  const handleDragStart = (event) => {
    const act = event.active.data.current?.activity;
    if (act) { setDraggingActivity(act); return; }
    const cell = event.active.data.current?.cell;
    if (cell) setDraggingActivity({ name: cell.content, color: cell.color || '#e2e8f0' });
  };

  /**
   * Drop a whole week of proposed content into the plan.
   *
   * Three rules, and each one is there because the opposite would lose work:
   *
   *   - a box the gananet has already written in is never overwritten. She may
   *     be filling the gaps around three days she already planned, and a
   *     "fill week" that wipes them is a button nobody presses twice.
   *   - Friday is skipped. It is קבלת שבת and the parent-of-the-week fields,
   *     and the editor renders it specially — content written there is invisible.
   *   - a row the proposal uses but this month's plan does not have is added.
   *     Gantts saved before יצירה existed have four rows, and the creation
   *     ideas would otherwise be written into cells that are never drawn.
   */
  const fillWeekFromBank = (weekIdx, proposal, theme) => {
    const cells = proposal?.cells || [];
    if (!cells.length) return;

    let added = 0;
    let skipped = 0;

    setGantt(prev => {
      const rows = [...(prev.row_definitions || [])];
      for (const key of [...new Set(cells.map(c => c.row_key))]) {
        if (rows.some(r => r.key === key)) continue;
        const known = BANK_ROWS.find(r => r.key === key);
        rows.push({ key, label: known?.label || key });
      }

      const weeks = [...(prev.weeks || [])];
      const week = weeks[weekIdx];
      if (!week) return prev;

      const next = [...(week.cells || [])];
      for (const c of cells) {
        if (c.day_index > 4) continue;                    // Friday is not ours
        const idx = next.findIndex(x => x.row_key === c.row_key && x.day_index === c.day_index);
        if (idx >= 0 && String(next[idx].content || '').trim()) { skipped += 1; continue; }

        const base = { row_key: c.row_key, day_index: c.day_index, content: '', color: '', col_span: 1, row_span: 1 };
        const merged = { ...base, ...(idx >= 0 ? next[idx] : {}), content: c.content };
        if (idx >= 0) next[idx] = merged; else next.push(merged);
        added += 1;
      }

      weeks[weekIdx] = { ...week, cells: next, topic: week.topic || theme || '' };
      return { ...prev, row_definitions: rows, weeks };
    });

    toast.success(
      skipped
        ? `שובצו ${added} תאים. ${skipped} תאים שכבר היה בהם תוכן לא נדרסו`
        : `שובצו ${added} תאים. לא לשכוח לשמור`,
    );
  };

  const addRow = () => { const l = prompt('שם:'); if (l) setGantt(prev => ({ ...prev, row_definitions: [...(prev.row_definitions||[]), { key: 'c_'+Date.now(), label: l }] })); };
  const removeRow = (k) => setGantt(prev => ({ ...prev, row_definitions: (prev.row_definitions||[]).filter(r => r.key !== k) }));

  /**
   * Everything she wrote herself, back into the bank.
   *
   * The bank is only worth having in three years if it keeps growing, and the
   * ideas worth having are the ones she writes this year. Asking her to re-type
   * them into a second screen means it never happens — so saving the plan is
   * what saves them, filed under each week's own subject.
   *
   * Runs per week, because the subject is per week. A week with no subject
   * contributes nothing: there would be nothing to find it by later.
   *
   * The server drops anything that names a child and anything the bank already
   * holds, and it never fails the save — a plan that refused to save because
   * the bank was unhappy would be an absurd thing to explain.
   */
  const captureTypedContent = async () => {
    const rowKeys = new Set(BANK_ROWS.map(r => r.key));
    let added = 0;

    for (const week of gantt.weeks || []) {
      const topic = String(week.topic || '').trim();
      if (!topic) continue;

      const items = (week.cells || [])
        // Friday is קבלת שבת and the parent-of-the-week names. Never banked.
        .filter(c => c.day_index <= 4 && rowKeys.has(c.row_key) && String(c.content || '').trim())
        .map(c => ({ category: c.row_key, title: String(c.content).trim() }));
      if (!items.length) continue;

      try {
        const res = await api.post('/content-bank/capture', {
          theme: topic, age: classroomCategory || '', items,
        });
        added += res.data?.added || 0;
      } catch { /* the plan is saved; the bank is a bonus */ }
    }
    return added;
  };

  const handleSave = async (status = 'draft') => {
    setSaving(true);
    try {
      await api.post('/gantt', {
        branch_id: selectedBranch, classroom_id: classroomId,
        academic_year: `${month >= 9 ? year : year-1}-${month >= 9 ? year+1 : year}`,
        month, year, row_definitions: gantt.row_definitions, weeks: gantt.weeks, status,
      });

      const banked = await captureTypedContent();
      const bankNote = banked === 0 ? ''
        : banked === 1 ? ' · רעיון אחד חדש נוסף לבנק'
        : ` · ${banked} רעיונות חדשים נוספו לבנק`;
      toast.success(`${status === 'pending' ? 'נשלח לאישור' : 'נשמר'}${bankNote}`);
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
            <Button size="small" variant="contained" startIcon={<AutoStoriesIcon />}
              onClick={() => setShowContentBank(true)} color="primary">בנק תוכן</Button>
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
                    {/* Read-only class-tracking lane (מעקב חוגים reflection) */}
                    {(() => {
                      const dayCells = DAY_NAMES.map((_, di) => {
                        const dd = new Date(weekStart); dd.setDate(dd.getDate() + di);
                        return { di, sessions: sessionsOnDate(dd) };
                      });
                      if (!dayCells.some(c => c.sessions.length)) return null;
                      return (
                        <TableRow>
                          <TableCell sx={{ bgcolor: '#fdf2f8', fontWeight: 800, fontSize: '0.82rem', textAlign: 'center', borderLeft: '2px solid #fbcfe8', color: '#9d174d', p: 1 }}>חוגים</TableCell>
                          {dayCells.map(({ di, sessions }) => (
                            <TableCell key={di} sx={{ bgcolor: '#fdf2f8', border: '1px solid #fce7f3', p: 0.5, verticalAlign: 'top' }}>
                              <Stack spacing={0.4}>
                                {sessions.map(s => (
                                  <Box key={s._id} sx={{
                                    bgcolor: SESSION_TINT[s.status] || '#f1f5f9', borderRadius: 1, px: 0.6, py: 0.2,
                                    fontSize: '0.68rem', fontWeight: 700, color: '#334155',
                                    textDecoration: s.status === 'postponed' ? 'line-through' : 'none',
                                  }}>
                                    {s.program_id?.name || 'חוג'}{s.time ? ` ${s.time}` : ''}
                                    {s.status === 'postponed' && s.postponed_to_date ? ` → ${s.postponed_to_date.slice(5)}` : ''}
                                  </Box>
                                ))}
                              </Stack>
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })()}
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

                          const cellContent = getVal(weekIdx, row.key, di, 'content');

                          return (
                            <GanttCell key={di} id={cellId} colSpan={cs} rowSpan={rs}
                              dragId={`move-${cellId}`}
                              dragPayload={{ wk: weekIdx, rk: row.key, di, content: cellContent, color: cc }}
                              canDrag={!mergeMode && Boolean(String(cellContent).trim())}
                              onClick={() => mergeMode && handleMergeClick(weekIdx, row.key, di)}
                              sx={{
                                bgcolor: cc || (hol ? '#fef3c7' : isFri ? '#f5f3ff' : 'white'),
                                border: isSelected ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                                p: 1, verticalAlign: 'top', cursor: mergeMode ? 'crosshair' : 'default',
                                position: 'relative', '&:hover .ca': { opacity: 1 },
                              }}
                            >
                              <TextField size="small" multiline maxRows={5} fullWidth variant="standard"
                                value={cellContent}
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
                            </GanttCell>
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

        {/* בנק תוכן — ideas by weekly subject, and whole-week fill */}
        <ContentBankPanel
          open={showContentBank}
          onClose={() => setShowContentBank(false)}
          ageGroup={classroomCategory}
          weeks={gantt.weeks || []}
          onFillWeek={fillWeekFromBank}
        />

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
