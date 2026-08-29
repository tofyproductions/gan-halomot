import { useState, useEffect, useMemo, Fragment } from 'react';
import {
  Box, Typography, Stack, Chip, Drawer, IconButton, TextField, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, MenuItem,
  Accordion, AccordionSummary, AccordionDetails, Tooltip, CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import InventoryIcon from '@mui/icons-material/Inventory2';
import { useDraggable } from '@dnd-kit/core';
import { toast } from 'react-toastify';
import api from '../../api/client';

export const BANK_ROWS = [
  { key: 'meeting', label: 'מפגש', color: '#dbeafe' },
  { key: 'activity', label: 'פעילות', color: '#dcfce7' },
  { key: 'creation', label: 'הנגשת חומרים', color: '#fce7f3' },
  { key: 'story', label: 'סיפור', color: '#fef9c3' },
  { key: 'misc', label: 'שונות', color: '#ede9fe' },
];

const ROW_COLOR = Object.fromEntries(BANK_ROWS.map(r => [r.key, r.color]));

// Friday is never proposed over — it is קבלת שבת and the parent-of-the-week.
const PREVIEW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'];

/**
 * One idea, draggable onto a gantt cell.
 *
 * It hands the drag layer the same `{ name, color }` shape the חוגים bank
 * already hands it, so the editor's existing drop handler needs no knowledge
 * that a second bank exists.
 */
function DraggableIdea({ item }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `bank-${item.id}`,
    data: { type: 'activity', activity: { name: item.title, color: ROW_COLOR[item.category] || '#e2e8f0' } },
  });

  const materials = item.materials || [];

  return (
    <Tooltip
      placement="left"
      title={materials.length ? `ציוד: ${materials.join(', ')}` : 'לא נדרש ציוד מיוחד'}
    >
      <Chip
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        icon={<DragIndicatorIcon sx={{ fontSize: 14 }} />}
        label={item.title}
        size="small"
        sx={{
          cursor: 'grab',
          fontWeight: 600,
          justifyContent: 'flex-start',
          maxWidth: '100%',
          height: 'auto',
          py: 0.4,
          bgcolor: ROW_COLOR[item.category] || '#e2e8f0',
          opacity: isDragging ? 0.4 : 1,
          '& .MuiChip-label': { whiteSpace: 'normal', textAlign: 'right', lineHeight: 1.35 },
          '&:active': { cursor: 'grabbing' },
        }}
      />
    </Tooltip>
  );
}

/**
 * בנק תוכן — the drawer a gananet works out of while writing the month.
 *
 * She picks the week's subject, and the bank shows what the gan has actually
 * done for that subject before, grouped by the gantt's own rows. From there
 * she either drags a single idea into a box, or asks for a whole week at once
 * and edits what she does not like.
 *
 * Everything is a proposal held in the editor's state. Nothing here saves the
 * gantt — she still presses שמור, and can still walk away.
 */
const MONTH_NAMES = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export default function ContentBankPanel({
  open, onClose, ageGroup, weeks, onFillWeek, month,
}) {
  const [themes, setThemes] = useState([]);
  const [theme, setTheme] = useState('');
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // One dialog for both "add" and "edit" — the fields are identical, and two
  // dialogs that differ only in their title drift apart.
  const [editor, setEditor] = useState(null);

  const [fill, setFill] = useState({ open: false, weekIdx: 0, offset: 0, busy: false });
  // The proposal, held here and editable, so she can move Tuesday to Thursday
  // BEFORE any of it touches the plan.
  const [proposal, setProposal] = useState(null);
  const [picked, setPicked] = useState(null);   // first half of a swap
  // The box whose text she is fixing, and the text as it stands.
  const [editingCell, setEditingCell] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showAllThemes, setShowAllThemes] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/content-bank/themes', { params: { month: month || '' } })
      .then(res => setThemes(res.data.themes || []))
      .catch(() => toast.error('שגיאה בטעינת הנושאים'));
  }, [open, month]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/content-bank', { params: { theme, q, age: ageGroup || '' } })
      .then(res => { setGroups(res.data.groups || []); setTotal(res.data.total || 0); })
      .catch(() => toast.error('שגיאה בטעינת הבנק'))
      .finally(() => setLoading(false));
  }, [open, theme, q, ageGroup, reloadKey]);

  // Re-fetch on demand. Not `setQ(v => v)` — React bails out when the value is
  // unchanged, so that never re-runs the effect and a freshly added item does
  // not appear until the drawer is closed and reopened.
  const refresh = () => setReloadKey(k => k + 1);

  // Which subjects this month is actually about, from six years of the gan's
  // own work plans. Writing October means סוכות and שמחת תורה; finding them
  // alphabetically between מספרים and פורים is the difference between a bank
  // and a filing cabinet.
  const inSeason = useMemo(() => themes.filter(t => t.in_season), [themes]);
  const offSeason = useMemo(() => themes.filter(t => !t.in_season), [themes]);

  const openAdd = () => setEditor({
    id: null, theme: theme || '', category: 'activity', title: '', materials: '', origin: 'own',
  });

  const openEdit = (item) => setEditor({
    id: item.id,
    theme: item.theme,
    category: item.category,
    title: item.title,
    materials: (item.materials || []).join(', '),
    origin: item.origin,
  });

  const saveItem = async () => {
    const title = editor.title.trim();
    const themeName = editor.theme.trim();
    if (!themeName || !title) return toast.error('נושא וטקסט הם שדות חובה');

    const body = {
      theme: themeName,
      category: editor.category,
      title,
      materials: editor.materials.split(',').map(s => s.trim()).filter(Boolean),
    };

    try {
      if (editor.id) {
        await api.put(`/content-bank/${editor.id}`, body);
        // A shipped item cannot be changed in place — the server hides it and
        // stores the edit as this gan's own. She does not need to know that,
        // but she does need to know it now belongs to her gan.
        toast.success(editor.origin === 'seed' ? 'נשמר כרעיון של הגן' : 'נשמר');
      } else {
        await api.post('/content-bank', { ...body, age_groups: ageGroup ? [ageGroup] : [] });
        toast.success('נוסף לבנק');
      }
      setEditor(null);
      if (themeName === theme || !theme) refresh(); else setTheme(themeName);
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const removeItem = async (item) => {
    try {
      await api.delete(`/content-bank/${item.id}`, {
        params: { theme: item.theme, category: item.category, title: item.title },
      });
      setGroups(prev => prev.map(g => ({ ...g, items: g.items.filter(i => i.id !== item.id) })));
      setTotal(t => Math.max(t - 1, 0));
      toast.success(item.origin === 'own' ? 'נמחק' : 'הוסתר מהבנק של הגן');
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const askWeek = async (weekIdx, offset) => {
    if (!theme) return toast.error('בחרי נושא קודם');
    setFill(f => ({ ...f, open: true, weekIdx, offset, busy: true }));
    setPicked(null);
    try {
      const res = await api.post('/content-bank/suggest', { theme, age: ageGroup || '', offset });
      setProposal(res.data);
      setFill(f => ({ ...f, busy: false }));
    } catch (err) {
      setFill(f => ({ ...f, open: false, busy: false }));
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const closeFill = () => {
    setFill({ open: false, weekIdx: 0, offset: 0, busy: false });
    setProposal(null);
    setPicked(null);
    setEditingCell(null);
  };

  const applyWeek = () => {
    if (!proposal) return;
    // Only boxes that still have text. A box she emptied in the preview is a
    // box she wants to write herself.
    onFillWeek(fill.weekIdx, {
      ...proposal,
      cells: proposal.cells
        .map(c => ({ ...c, content: String(c.content || '').trim() }))
        .filter(c => c.content),
    }, theme);
    closeFill();
    onClose();
  };

  /**
   * Move a proposed idea from one day to another, before any of it is applied.
   *
   * Tap the box, then tap where it should go — the two trade places, which is
   * also how "move it to the empty Thursday" works, since an empty box swapped
   * in leaves the original empty. Swaps stay inside one row on purpose: a story
   * in the מפגש row is not a plan, it is a mistake that took two taps.
   */
  const tapCell = (rowKey, dayIdx) => {
    if (!picked) { setPicked({ rowKey, dayIdx }); return; }
    if (picked.rowKey !== rowKey) {
      toast.info('אפשר להחליף רק בתוך אותה שורה');
      setPicked({ rowKey, dayIdx });
      return;
    }
    if (picked.dayIdx === dayIdx) { setPicked(null); return; }

    setProposal(p => {
      const cells = [...p.cells];
      const at = (d) => cells.findIndex(c => c.row_key === rowKey && c.day_index === d);
      const iA = at(picked.dayIdx);
      const iB = at(dayIdx);
      const blank = (d) => ({ row_key: rowKey, day_index: d, content: '', materials: [] });

      const a = iA >= 0 ? cells[iA] : blank(picked.dayIdx);
      const b = iB >= 0 ? cells[iB] : blank(dayIdx);

      const newA = { ...b, day_index: picked.dayIdx };
      const newB = { ...a, day_index: dayIdx };
      if (iA >= 0) cells[iA] = newA; else cells.push(newA);
      if (iB >= 0) cells[iB] = newB; else cells.push(newB);
      return { ...p, cells };
    });
    setPicked(null);
  };

  /**
   * Fix the wording of one box, here, before it is applied.
   *
   * Six years of hand-typed workbooks carry six years of typos — "ניצור\\ר יונת
   * שלום" is a real cell — and until now the only way to fix one was to apply
   * the week and then edit it in the plan. That works, but it means applying
   * something you can see is wrong, which nobody wants to press.
   *
   * This changes THIS WEEK only. The bank keeps its own text, and the pencil
   * beside the idea in the drawer is what changes that — editing a plan should
   * never quietly rewrite content the whole gan reads.
   */
  const setCellText = (rowKey, dayIdx, text) => {
    setProposal(p => {
      const cells = [...p.cells];
      const i = cells.findIndex(c => c.row_key === rowKey && c.day_index === dayIdx);
      if (i < 0) return p;
      cells[i] = { ...cells[i], content: text };
      return { ...p, cells };
    });
  };

  const clearCell = (rowKey, dayIdx) => {
    setProposal(p => ({
      ...p,
      cells: p.cells.filter(c => !(c.row_key === rowKey && c.day_index === dayIdx)),
    }));
    setPicked(null);
  };

  // The proposal as a grid: every row that has anything, every working day.
  const previewGrid = useMemo(() => {
    const cells = proposal?.cells || [];
    return BANK_ROWS
      .filter(r => cells.some(c => c.row_key === r.key))
      .map(r => ({
        ...r,
        days: [0, 1, 2, 3, 4].map(d => cells.find(c => c.row_key === r.key && c.day_index === d) || null),
      }));
  }, [proposal]);

  // Recomputed from what is on screen, not from what the server proposed —
  // she has been moving and clearing boxes, and the shopping list has to match
  // the week she is actually about to apply.
  const previewMaterials = useMemo(() => (
    [...new Set((proposal?.cells || []).flatMap(c => c.materials || []))]
      .sort((a, b) => a.localeCompare(b, 'he'))
  ), [proposal]);

  return (
    <>
      {/* Full width on a phone, a side panel on a laptop. A 380px drawer on a
          375px screen leaves a five-pixel sliver of the plan behind it, which
          is worse than either. */}
      <Drawer anchor="left" open={open} onClose={onClose}
        PaperProps={{ sx: { width: { xs: '100%', sm: 400 }, maxWidth: '100%' } }}>
        <Box sx={{ p: 2 }} dir="rtl">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>בנק תוכן</Typography>
            <Stack direction="row">
              <Tooltip title="הוספת רעיון משלך">
                <IconButton size="small" onClick={openAdd}>
                  <AddIcon />
                </IconButton>
              </Tooltip>
              <IconButton size="small" onClick={onClose}><CloseIcon /></IconButton>
            </Stack>
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            בחרי נושא, גררי רעיון לתא — או מלאי שבוע שלם בלחיצה.
            {ageGroup ? ` מותאם ל${ageGroup}.` : ''}
            {month && inSeason.length > 0
              ? ` הנושאים של ${MONTH_NAMES[month]} ראשונים.`
              : ''}
          </Typography>

          <TextField
            size="small" fullWidth placeholder="חיפוש חופשי"
            value={q} onChange={e => setQ(e.target.value)}
            InputProps={{ startAdornment: <SearchIcon sx={{ fontSize: 18, color: '#94a3b8', ml: 0.5 }} /> }}
            sx={{ mb: 1.5 }}
          />

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
            <Chip
              label="הכל" size="small"
              color={theme === '' ? 'primary' : 'default'}
              onClick={() => setTheme('')}
            />
            {inSeason.map(t => (
              <Chip
                key={t.theme} size="small"
                label={`${t.theme} (${t.count})`}
                color={theme === t.theme ? 'primary' : 'default'}
                variant={theme === t.theme ? 'filled' : 'outlined'}
                onClick={() => setTheme(t.theme)}
                sx={{ fontWeight: 700, borderColor: '#f59e0b' }}
              />
            ))}
          </Box>

          {/* The rest, folded away. Thirty-five subjects laid flat is a wall;
              the five or six this month belongs to is a choice. */}
          {offSeason.length > 0 && (
            <Accordion disableGutters elevation={0} expanded={showAllThemes}
              onChange={() => setShowAllThemes(v => !v)}
              sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent', mb: 1.5 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 32, px: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: '#64748b' }}>
                  שאר הנושאים ({offSeason.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0.5 }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {offSeason.map(t => (
                    <Chip
                      key={t.theme} size="small"
                      label={`${t.theme} (${t.count})`}
                      color={theme === t.theme ? 'primary' : 'default'}
                      onClick={() => setTheme(t.theme)}
                    />
                  ))}
                </Box>
              </AccordionDetails>
            </Accordion>
          )}

          {theme && weeks?.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                מילוי שבוע שלם בנושא "{theme}"
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {weeks.map((w, i) => (
                  <Button key={i} size="small" variant="outlined" onClick={() => askWeek(i, 0)}>
                    שבוע {w.week_number}
                  </Button>
                ))}
              </Stack>
              <Divider sx={{ my: 1.5 }} />
            </>
          )}

          {loading && <Stack alignItems="center" sx={{ py: 3 }}><CircularProgress size={22} /></Stack>}

          {!loading && total === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
              אין תוצאות. נסי נושא אחר, או הוסיפי רעיון משלך.
            </Typography>
          )}

          {!loading && groups.filter(g => g.items.length).map(g => (
            <Accordion key={g.category} defaultExpanded disableGutters elevation={0}
              sx={{ '&:before': { display: 'none' }, border: '1px solid #e2e8f0', borderRadius: 2, mb: 1 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ bgcolor: ROW_COLOR[g.category], borderRadius: 2, minHeight: 40 }}>
                <Typography sx={{ fontWeight: 800, fontSize: '0.9rem' }}>
                  {g.label} <span style={{ opacity: 0.6, fontWeight: 500 }}>({g.items.length})</span>
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 1 }}>
                <Stack spacing={0.5}>
                  {g.items.map(item => (
                    <Stack key={item.id} direction="row" alignItems="center" spacing={0.25}>
                      <Box sx={{ flex: 1, minWidth: 0 }}><DraggableIdea item={item} /></Box>
                      <Tooltip title="עריכה">
                        <IconButton size="small" onClick={() => openEdit(item)}>
                          <EditIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={item.origin === 'own' ? 'מחיקה' : 'הסתרה מהבנק של הגן'}>
                        <IconButton size="small" onClick={() => removeItem(item)}>
                          <DeleteIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      </Drawer>

      {/* The proposed week, editable, before any of it touches the plan */}
      {/* Above the drawer, explicitly. Both are MUI modals and default to the
          same z-index, so which one wins is decided by portal order — and on a
          phone, where the drawer is the full width of the screen, losing that
          race hides the dialog completely. */}
      <Dialog open={fill.open} onClose={closeFill} dir="rtl" maxWidth="lg" fullWidth
        sx={{
          zIndex: (t) => t.zIndex.modal + 10,
          '& .MuiDialog-paper': { m: { xs: 1, sm: 4 }, width: { xs: 'calc(100% - 16px)', sm: 'auto' } },
        }}>
        <DialogTitle sx={{ fontWeight: 800, pb: 0.5 }}>
          הצעה לשבוע {weeks?.[fill.weekIdx]?.week_number} — {theme}
        </DialogTitle>
        <DialogContent>
          {fill.busy && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}

          {!fill.busy && proposal && (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {picked
                  ? 'עכשיו לחצי על היום שאליו להעביר — השניים יתחלפו.'
                  : 'לחצי על תוכן ואז על יום אחר כדי להחליף ביניהם. לחיצה כפולה, או העיפרון, לתיקון הכתוב. ✕ מרוקן תיבה.'}
              </Typography>

              <Box sx={{ overflowX: 'auto' }}>
                {/* On a phone this is a five-column table nobody can read, so
                    it scrolls as one rather than reflowing into something that
                    is no longer a week. The row labels stay put. */}
                <Box sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '84px repeat(5, minmax(112px, 1fr))', sm: '110px repeat(5, minmax(130px, 1fr))' },
                  gap: 0.5, minWidth: { xs: 640, sm: 760 },
                }}>
                  <Box />
                  {PREVIEW_DAYS.map(d => (
                    <Box key={d} sx={{
                      textAlign: 'center', fontWeight: 800, fontSize: '0.8rem',
                      color: '#475569', pb: 0.5,
                    }}>{d}</Box>
                  ))}

                  {previewGrid.map(row => (
                    <Fragment key={row.key}>
                      <Box sx={{
                        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                        fontWeight: 800, fontSize: '0.82rem', pl: 1, color: '#334155',
                      }}>{row.label}</Box>

                      {[0, 1, 2, 3, 4].map(d => {
                        const cell = row.days[d];
                        const isPicked = picked?.rowKey === row.key && picked?.dayIdx === d;
                        const isEditing = editingCell?.rowKey === row.key && editingCell?.dayIdx === d;

                        if (isEditing) {
                          return (
                            <Box key={d} sx={{
                              minHeight: 52, borderRadius: 1.5, p: 0.4,
                              bgcolor: row.color, border: '2px solid #f59e0b',
                              display: 'flex', alignItems: 'center',
                            }}>
                              <TextField
                                autoFocus multiline maxRows={4} fullWidth variant="standard"
                                // Written straight into the proposal on every
                                // keystroke. Holding the text in local state and
                                // committing it on blur loses the edit whenever
                                // the blur does not arrive — which is what
                                // happens when the dialog is closed, or a button
                                // is pressed that re-renders first. There is no
                                // commit step to miss this way.
                                value={cell.content}
                                onChange={e => setCellText(row.key, d, e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={e => {
                                  // Shift+Enter is a line break — some of these
                                  // really are two lines.
                                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditingCell(null); }
                                  if (e.key === 'Escape') setEditingCell(null);
                                }}
                                InputProps={{ disableUnderline: true }}
                                inputProps={{ style: { fontSize: '0.78rem', fontWeight: 600, textAlign: 'center', lineHeight: 1.35 } }}
                              />
                            </Box>
                          );
                        }

                        return (
                          <Box
                            key={d}
                            onClick={() => tapCell(row.key, d)}
                            onDoubleClick={() => cell && setEditingCell({ rowKey: row.key, dayIdx: d })}
                            sx={{
                              position: 'relative', minHeight: 52, borderRadius: 1.5, p: 0.8,
                              cursor: 'pointer', userSelect: 'none',
                              bgcolor: cell ? row.color : '#f8fafc',
                              border: isPicked ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                              fontSize: '0.78rem', fontWeight: 600, lineHeight: 1.35,
                              color: cell ? '#1e293b' : '#cbd5e1',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              textAlign: 'center',
                              '&:hover': { borderColor: '#f59e0b' },
                              '&:hover .act': { opacity: 1 },
                            }}
                          >
                            {cell ? cell.content : '—'}
                            {cell && (
                              <Stack className="act" direction="row" spacing={0.3} sx={{
                                position: 'absolute', top: 0, insetInlineStart: 2,
                                opacity: 0, transition: '0.2s',
                              }}>
                                <Box
                                  onClick={(e) => { e.stopPropagation(); setEditingCell({ rowKey: row.key, dayIdx: d }); }}
                                  sx={{ cursor: 'pointer', lineHeight: 0 }}
                                >
                                  <EditIcon sx={{ fontSize: 12, color: '#64748b' }} />
                                </Box>
                                <Box
                                  onClick={(e) => { e.stopPropagation(); clearCell(row.key, d); }}
                                  sx={{ fontSize: '0.7rem', color: '#64748b', cursor: 'pointer', lineHeight: 1 }}
                                >✕</Box>
                              </Stack>
                            )}
                          </Box>
                        );
                      })}
                    </Fragment>
                  ))}
                </Box>
              </Box>

              {proposal.thin_rows?.length > 0 && (
                <Typography variant="caption" sx={{ color: '#b45309' }}>
                  הבנק דל בנושא זה בשורות: {proposal.thin_rows.join(', ')} — יש ימים ריקים, מלאי אותם בעצמך.
                </Typography>
              )}

              {previewMaterials.length > 0 && (
                <Box sx={{ bgcolor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 2, p: 1.5 }}>
                  <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
                    <InventoryIcon sx={{ fontSize: 16, color: '#475569' }} />
                    <Typography sx={{ fontWeight: 800, fontSize: '0.85rem' }}>ציוד לשבוע</Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ color: '#475569' }}>
                    {previewMaterials.join(' · ')}
                  </Typography>
                </Box>
              )}

              <Typography variant="caption" color="text.secondary">
                השיבוץ ממלא ראשון–חמישי. שישי נשאר קבלת שבת. תאים שכבר כתוב בהם משהו לא יידרסו.
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeFill}>ביטול</Button>
          <Button onClick={() => askWeek(fill.weekIdx, fill.offset + 1)} disabled={fill.busy}>הצע אחרת</Button>
          <Button variant="contained" onClick={applyWeek}
            disabled={fill.busy || !proposal?.cells?.some(c => String(c.content || '').trim())}>
            שבץ בשבוע
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add, and edit — the same fields either way */}
      <Dialog open={Boolean(editor)} onClose={() => setEditor(null)} dir="rtl" maxWidth="xs" fullWidth
        sx={{ zIndex: (t) => t.zIndex.modal + 10 }}>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {editor?.id ? 'עריכת רעיון' : 'הוספת רעיון לבנק'}
        </DialogTitle>
        <DialogContent>
          {editor && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {editor.origin === 'seed' && (
                <Typography variant="caption" sx={{ color: '#b45309' }}>
                  זהו רעיון שהגיע עם המערכת. השמירה תיצור ממנו גרסה של הגן שלכם,
                  והמקורית תוסתר. לגנים אחרים לא ישתנה דבר.
                </Typography>
              )}
              <TextField label="נושא" fullWidth value={editor.theme}
                onChange={e => setEditor(d => ({ ...d, theme: e.target.value }))}
                helperText="למשל: פסח, הגינה, חורף" />
              <TextField label="שורה בגאנט" select fullWidth value={editor.category}
                onChange={e => setEditor(d => ({ ...d, category: e.target.value }))}>
                {BANK_ROWS.map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
              </TextField>
              <TextField label="הרעיון" fullWidth multiline maxRows={4} value={editor.title}
                onChange={e => setEditor(d => ({ ...d, title: e.target.value }))} />
              <TextField label="ציוד נדרש" fullWidth value={editor.materials}
                onChange={e => setEditor(d => ({ ...d, materials: e.target.value }))}
                helperText="מופרד בפסיקים. אפשר להשאיר ריק" />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditor(null)}>ביטול</Button>
          <Button variant="contained" onClick={saveItem}>{editor?.id ? 'שמור' : 'הוסף'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
