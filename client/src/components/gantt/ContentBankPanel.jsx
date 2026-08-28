import { useState, useEffect, useMemo } from 'react';
import {
  Box, Typography, Stack, Chip, Drawer, IconButton, TextField, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, MenuItem,
  Accordion, AccordionSummary, AccordionDetails, Tooltip, CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import InventoryIcon from '@mui/icons-material/Inventory2';
import { useDraggable } from '@dnd-kit/core';
import { toast } from 'react-toastify';
import api from '../../api/client';

export const BANK_ROWS = [
  { key: 'meeting', label: 'מפגש', color: '#dbeafe' },
  { key: 'activity', label: 'פעילות', color: '#dcfce7' },
  { key: 'creation', label: 'יצירה', color: '#fce7f3' },
  { key: 'story', label: 'סיפור', color: '#fef9c3' },
  { key: 'misc', label: 'שונות', color: '#ede9fe' },
];

const ROW_COLOR = Object.fromEntries(BANK_ROWS.map(r => [r.key, r.color]));

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
export default function ContentBankPanel({
  open, onClose, ageGroup, weeks, onFillWeek,
}) {
  const [themes, setThemes] = useState([]);
  const [theme, setTheme] = useState('');
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ theme: '', category: 'activity', title: '', materials: '' });

  const [fill, setFill] = useState({ open: false, weekIdx: 0, offset: 0, preview: null, busy: false });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    api.get('/content-bank/themes')
      .then(res => setThemes(res.data.themes || []))
      .catch(() => toast.error('שגיאה בטעינת הנושאים'));
  }, [open]);

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

  const addItem = async () => {
    const title = draft.title.trim();
    const themeName = (draft.theme || theme).trim();
    if (!themeName || !title) return toast.error('נושא וכותרת הם שדות חובה');
    try {
      await api.post('/content-bank', {
        theme: themeName,
        category: draft.category,
        title,
        materials: draft.materials.split(',').map(s => s.trim()).filter(Boolean),
        age_groups: ageGroup ? [ageGroup] : [],
      });
      toast.success('נוסף לבנק');
      setAddOpen(false);
      setDraft({ theme: '', category: 'activity', title: '', materials: '' });
      if (themeName === theme) refresh(); else setTheme(themeName);
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
    try {
      const res = await api.post('/content-bank/suggest', { theme, age: ageGroup || '', offset });
      setFill(f => ({ ...f, preview: res.data, busy: false }));
    } catch (err) {
      setFill(f => ({ ...f, open: false, busy: false }));
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const applyWeek = () => {
    if (!fill.preview) return;
    onFillWeek(fill.weekIdx, fill.preview, theme);
    setFill({ open: false, weekIdx: 0, offset: 0, preview: null, busy: false });
    onClose();
  };

  const previewByRow = useMemo(() => {
    const cells = fill.preview?.cells || [];
    return BANK_ROWS
      .map(r => ({ ...r, days: cells.filter(c => c.row_key === r.key).sort((a, b) => a.day_index - b.day_index) }))
      .filter(r => r.days.length);
  }, [fill.preview]);

  return (
    <>
      <Drawer anchor="left" open={open} onClose={onClose} PaperProps={{ sx: { width: 380 } }}>
        <Box sx={{ p: 2 }} dir="rtl">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>בנק תוכן</Typography>
            <Stack direction="row">
              <Tooltip title="הוספת רעיון משלך">
                <IconButton size="small" onClick={() => { setDraft(d => ({ ...d, theme: theme || '' })); setAddOpen(true); }}>
                  <AddIcon />
                </IconButton>
              </Tooltip>
              <IconButton size="small" onClick={onClose}><CloseIcon /></IconButton>
            </Stack>
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            בחרי נושא, גררי רעיון לתא — או מלאי שבוע שלם בלחיצה.
            {ageGroup ? ` מותאם ל${ageGroup}.` : ''}
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
            {themes.map(t => (
              <Chip
                key={t.theme} size="small"
                label={`${t.theme} (${t.count})`}
                color={theme === t.theme ? 'primary' : 'default'}
                onClick={() => setTheme(t.theme)}
              />
            ))}
          </Box>

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
                    <Stack key={item.id} direction="row" alignItems="center" spacing={0.5}>
                      <Box sx={{ flex: 1, minWidth: 0 }}><DraggableIdea item={item} /></Box>
                      <IconButton size="small" onClick={() => removeItem(item)}>
                        <DeleteIcon sx={{ fontSize: 14, color: '#94a3b8' }} />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      </Drawer>

      {/* Whole-week proposal, shown before anything touches the plan */}
      <Dialog open={fill.open} onClose={() => setFill(f => ({ ...f, open: false }))} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>
          הצעה לשבוע {weeks?.[fill.weekIdx]?.week_number} — {theme}
        </DialogTitle>
        <DialogContent>
          {fill.busy && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

          {!fill.busy && fill.preview && (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {previewByRow.map(row => (
                <Box key={row.key}>
                  <Typography sx={{ fontWeight: 800, fontSize: '0.85rem', mb: 0.5 }}>{row.label}</Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {row.days.map(c => (
                      <Chip key={c.day_index} size="small" label={c.content}
                        sx={{ bgcolor: row.color, fontWeight: 600, height: 'auto', py: 0.4,
                          '& .MuiChip-label': { whiteSpace: 'normal' } }} />
                    ))}
                  </Stack>
                </Box>
              ))}

              {fill.preview.thin_rows?.length > 0 && (
                <Typography variant="caption" sx={{ color: '#b45309' }}>
                  הבנק דל בנושא זה בשורות: {fill.preview.thin_rows.join(', ')} — יש חזרות, כדאי לערוך.
                </Typography>
              )}

              {fill.preview.materials?.length > 0 && (
                <Box sx={{ bgcolor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 2, p: 1.5 }}>
                  <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
                    <InventoryIcon sx={{ fontSize: 16, color: '#475569' }} />
                    <Typography sx={{ fontWeight: 800, fontSize: '0.85rem' }}>ציוד לשבוע</Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ color: '#475569' }}>
                    {fill.preview.materials.join(' · ')}
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
          <Button onClick={() => setFill(f => ({ ...f, open: false }))}>ביטול</Button>
          <Button onClick={() => askWeek(fill.weekIdx, fill.offset + 1)} disabled={fill.busy}>הצע אחרת</Button>
          <Button variant="contained" onClick={applyWeek} disabled={fill.busy || !fill.preview?.cells?.length}>
            שבץ בשבוע
          </Button>
        </DialogActions>
      </Dialog>

      {/* The gan's own addition */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>הוספת רעיון לבנק</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="נושא" fullWidth value={draft.theme}
              onChange={e => setDraft(d => ({ ...d, theme: e.target.value }))}
              helperText="למשל: פסח, הגינה, חורף" />
            <TextField label="שורה בגאנט" select fullWidth value={draft.category}
              onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}>
              {BANK_ROWS.map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
            </TextField>
            <TextField label="הרעיון" fullWidth value={draft.title}
              onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
            <TextField label="ציוד נדרש" fullWidth value={draft.materials}
              onChange={e => setDraft(d => ({ ...d, materials: e.target.value }))}
              helperText="מופרד בפסיקים. אפשר להשאיר ריק" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>ביטול</Button>
          <Button variant="contained" onClick={addItem}>הוסף</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
