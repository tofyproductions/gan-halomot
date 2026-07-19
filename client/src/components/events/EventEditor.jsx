import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Stack,
  Typography, IconButton, Box, Divider, Alert, Table, TableBody, TableRow, TableCell,
  TableHead, Tooltip, FormGroup, FormControlLabel, Checkbox, Chip,
  ToggleButtonGroup, ToggleButton, Switch,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Create / edit a gan event.
 *   mode='create' → pick one or more branches + meta + item list. Each branch
 *                   gets its own instance (own list, link, claims) in one campaign.
 *   mode='meta'   → edit campaign details (name/date/time/description) — propagates
 *                   to every branch. PUT on `instance.id`.
 *   mode='items'  → edit ONE branch's item list. PUT on `instance.id`.
 * The item list is edited as display GROUPS ({ name, qty }).
 */
export default function EventEditor({ open, mode = 'create', instance, campaign, branches = [], defaultBranchId, onClose, onSaved }) {
  const [meta, setMeta] = useState({ name: '', event_date: '', event_time: '', description: '' });
  const [groups, setGroups] = useState([]);      // [{ name, qty }]
  const [branchIds, setBranchIds] = useState([]);
  const [distribution, setDistribution] = useState('copy'); // 'copy' | 'split'
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', qty: 1 });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Meta prefill comes from the campaign (branch summaries don't carry it);
    // create starts blank. Items come from the specific branch instance.
    const m = mode === 'create' ? {} : (campaign || {});
    setMeta({ name: m.name || '', event_date: m.event_date || '', event_time: m.event_time || '', description: m.description || '' });
    setGroups((instance?.groups || []).map((g) => ({ name: g.name, qty: g.total })));
    setBranchIds(defaultBranchId && defaultBranchId !== 'all' ? [String(defaultBranchId)] : []);
    setDistribution('copy');
    setAllowMultiple(mode === 'create' ? false : !!(campaign?.allow_multiple_per_parent));
    setNewItem({ name: '', qty: 1 });
  }, [open, mode, instance, campaign, defaultBranchId]);

  const toggleBranch = (id) => setBranchIds((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]));

  const addItem = () => {
    const name = newItem.name.trim();
    if (!name) return;
    const qty = Math.max(1, parseInt(newItem.qty, 10) || 1);
    setGroups((prev) => {
      const idx = prev.findIndex((g) => g.name === name);
      if (idx >= 0) { const copy = [...prev]; copy[idx] = { ...copy[idx], qty: copy[idx].qty + qty }; return copy; }
      return [...prev, { name, qty }];
    });
    setNewItem({ name: '', qty: 1 });
  };
  const setQty = (i, v) => setGroups((prev) => prev.map((g, idx) => (idx === i ? { ...g, qty: Math.max(1, parseInt(v, 10) || 1) } : g)));
  const removeItem = (i) => setGroups((prev) => prev.filter((_, idx) => idx !== i));

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post('/gan-events/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const imported = res.data.groups || [];
      setGroups((prev) => {
        const map = new Map(prev.map((g) => [g.name, { ...g }]));
        for (const g of imported) { if (map.has(g.name)) map.get(g.name).qty += g.qty; else map.set(g.name, { name: g.name, qty: g.qty }); }
        return Array.from(map.values());
      });
      toast.success(`יובאו ${imported.length} פריטים`);
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בייבוא הקובץ'); }
    finally { setImporting(false); }
  };

  const save = async (publish) => {
    if (!meta.name.trim()) return toast.error('שם אירוע נדרש');
    if (mode === 'create' && branchIds.length === 0) return toast.error('בחר לפחות סניף אחד');
    setSaving(true);
    try {
      let res;
      const metaPayload = { ...meta, name: meta.name.trim() };
      if (mode === 'create') {
        res = await api.post('/gan-events', {
          ...metaPayload, branch_ids: branchIds, items: groups,
          distribution: branchIds.length > 1 ? distribution : 'copy',
          allow_multiple_per_parent: allowMultiple,
          ...(publish !== undefined ? { status: publish ? 'published' : 'draft' } : {}),
        });
      } else if (mode === 'meta') {
        // Details edit only — never touches the publish status.
        res = await api.put(`/gan-events/${instance.id}`, { ...metaPayload, allow_multiple_per_parent: allowMultiple });
      } else { // items
        res = await api.put(`/gan-events/${instance.id}`, { items: groups });
      }
      toast.success('נשמר');
      onSaved(res.data.event, publish);
      onClose();
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשמירה'); }
    finally { setSaving(false); }
  };

  const totalSlots = groups.reduce((s, g) => s + g.qty, 0);
  const showItems = mode !== 'meta';
  const showBranches = mode === 'create';
  const showMeta = mode !== 'items';
  const title = mode === 'create' ? 'אירוע חדש בגן' : mode === 'meta' ? 'עריכת פרטי האירוע'
    : `עריכת רשימה — ${instance?.branch_name || ''}`;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {showMeta && (
            <>
              <TextField size="small" label="שם האירוע" value={meta.name}
                onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} fullWidth autoFocus />
              <Stack direction="row" spacing={2}>
                <TextField size="small" type="date" label="תאריך" value={meta.event_date}
                  onChange={(e) => setMeta((m) => ({ ...m, event_date: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
                <TextField size="small" type="time" label="שעה" value={meta.event_time}
                  onChange={(e) => setMeta((m) => ({ ...m, event_time: e.target.value }))} InputLabelProps={{ shrink: true }} fullWidth />
              </Stack>
              <TextField size="small" label="פרטים להורים (אופציונלי)" value={meta.description}
                onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} multiline minRows={2} fullWidth />
              <FormControlLabel
                control={<Switch checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />}
                label={<Box>
                  <Typography variant="body2">אפשר להורה לבחור יותר מפריט אחד</Typography>
                  <Typography variant="caption" color="text.secondary">כברירת מחדל כל הורה מתחייב לפריט אחד בלבד.</Typography>
                </Box>} />
            </>
          )}

          {showBranches && (
            <Box>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                <StorefrontIcon fontSize="small" color="action" />
                <Typography variant="subtitle2">סניפים ({branchIds.length})</Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">כל סניף מקבל רשימה וקישור נפרדים משלו.</Typography>
              <Box sx={{ maxHeight: 150, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.5, mt: 0.5 }}>
                <FormGroup>
                  {branches.map((b) => {
                    const id = String(b._id || b.id);
                    return (
                      <FormControlLabel key={id}
                        control={<Checkbox size="small" checked={branchIds.includes(id)} onChange={() => toggleBranch(id)} />}
                        label={b.name} />
                    );
                  })}
                </FormGroup>
              </Box>

              {/* Copy vs split — only meaningful for 2+ branches */}
              {branchIds.length > 1 && (
                <Box sx={{ mt: 1.5 }}>
                  <ToggleButtonGroup exclusive size="small" fullWidth value={distribution}
                    onChange={(e, v) => v && setDistribution(v)} color="primary">
                    <ToggleButton value="copy"><ContentCopyIcon fontSize="small" sx={{ ml: 0.5 }} />העתקה לכל סניף</ToggleButton>
                    <ToggleButton value="split"><CallSplitIcon fontSize="small" sx={{ ml: 0.5 }} />פיצול בין הסניפים</ToggleButton>
                  </ToggleButtonGroup>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {distribution === 'copy'
                      ? `כל סניף יקבל את הרשימה המלאה (${branchIds.length} עותקים זהים).`
                      : `הכמות של כל פריט תתחלק בין ${branchIds.length} הסניפים (סך הכל = הרשימה שלמטה).`}
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          {showItems && (
            <>
              <Divider />
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle2">רשימת הפריטים {totalSlots > 0 && `(${totalSlots})`}</Typography>
                <Button component="label" size="small" startIcon={<UploadFileIcon />} disabled={importing}>
                  {importing ? 'מייבא…' : 'העלאת אקסל'}
                  <input hidden type="file" accept=".xlsx,.xls,.csv" onChange={onImport} />
                </Button>
              </Stack>
              <Stack direction="row" spacing={1}>
                <TextField size="small" label="שם פריט" value={newItem.name}
                  onChange={(e) => setNewItem((n) => ({ ...n, name: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} fullWidth />
                <TextField size="small" type="number" label="כמות" value={newItem.qty}
                  onChange={(e) => setNewItem((n) => ({ ...n, qty: e.target.value }))} sx={{ width: 90 }} inputProps={{ min: 1 }} />
                <IconButton color="primary" onClick={addItem}><AddIcon /></IconButton>
              </Stack>
              {groups.length === 0 ? (
                <Alert severity="info">הוסף פריטים ידנית או העלה קובץ אקסל. "כמות" = כמה הורים יכולים להתחייב לאותו פריט.</Alert>
              ) : (
                <Box sx={{ maxHeight: 260, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead><TableRow>
                      <TableCell>פריט</TableCell>
                      <TableCell align="center" sx={{ width: 90 }}>כמות</TableCell>
                      <TableCell align="center" sx={{ width: 48 }} />
                    </TableRow></TableHead>
                    <TableBody>
                      {groups.map((g, i) => (
                        <TableRow key={i} hover>
                          <TableCell>{g.name}</TableCell>
                          <TableCell align="center">
                            <TextField size="small" type="number" value={g.qty} onChange={(e) => setQty(i, e.target.value)}
                              inputProps={{ min: 1, style: { textAlign: 'center', padding: 4 } }} sx={{ width: 64 }} />
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title="הסר"><IconButton size="small" color="error" onClick={() => removeItem(i)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
              {mode === 'items' && <Alert severity="info" sx={{ py: 0 }}>הרשימה הזו שייכת לסניף {instance?.branch_name} בלבד.</Alert>}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>ביטול</Button>
        <Box sx={{ flex: 1 }} />
        {mode === 'items' ? (
          <Button variant="contained" onClick={() => save()} disabled={saving}>שמור רשימה</Button>
        ) : mode === 'meta' ? (
          <Button variant="contained" onClick={() => save()} disabled={saving}>שמור</Button>
        ) : (
          <>
            <Button onClick={() => save(false)} disabled={saving}>שמור כטיוטה</Button>
            <Button variant="contained" onClick={() => save(true)} disabled={saving}>צור ופרסם</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
