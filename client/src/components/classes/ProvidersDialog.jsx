import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, TextField, MenuItem, IconButton, Table, TableHead, TableBody,
  TableRow, TableCell, Chip, Divider, Alert, Select, OutlinedInput, Checkbox,
  ListItemText, InputLabel, FormControl, InputAdornment, CircularProgress,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];
const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים', 'קבוצה'];
const bid = (b) => String(b._id || b.id);

/**
 * ספקי גנים — the people who run the classes, and the arrangement each of them
 * has with the gan.
 *
 * The arrangement is the point. A provider is not really "a name and a phone":
 * she is "Tuesdays at משה דיין — תינוקייה at 09:00 for 180, צעירים at 09:30 for
 * 360 — and Thursdays at הרצוג". That is one decision a person makes once, and
 * until now it was four separate "חוג חדש" dialogs with the branch and her name
 * retyped on each; miss one and there is a group that never gets a session and
 * never gets paid for, with nothing anywhere saying so.
 *
 * So this screen has two levels: the list, and one provider open — her details
 * and every line of her week in one table, saved together. "חוג חדש" on the
 * tracking page opens it too; there is no second dialog, because there was
 * never a second decision.
 *
 * `focus` says where to land: '' the list, 'new' the add form, or a provider's
 * id to open straight onto her week — which is what the pencil beside a class
 * sends, so editing a class and editing its provider are the same click.
 */
export default function ProvidersDialog({ open, onClose, focus = '' }) {
  const { branches } = useBranch();
  const confirm = useConfirm();
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);   // the open provider, or null for the list
  const [rows, setRows] = useState([]);           // her programs, as editable rows
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ name: '', field: '', phone: '' });

  const load = () => api.get('/classes/providers')
    .then(r => { setProviders(r.data.providers || []); return r.data.providers || []; })
    .catch(() => []);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    load().then((list) => {
      if (!focus || focus === 'new') return;
      const p = list.find(x => String(x._id) === String(focus));
      if (p) openProvider(p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focus]);

  const branchName = (id) => branches.find(b => bid(b) === String(id))?.name || '—';

  // ---------------------------------------------------------------- list
  /**
   * Added, then opened — not added and left on a list.
   *
   * A provider with no branches, no days and no rates runs no classes and
   * produces no sessions, so stopping at "נוסף" is stopping halfway through
   * the thing somebody came here to do.
   */
  const addProvider = () => {
    if (!draft.name.trim()) return toast.error('שם ספק נדרש');
    api.post('/classes/providers', draft)
      .then(({ data }) => {
        toast.success('נוסף — עכשיו הגדירו באילו סניפים, ימים ותעריפים');
        setDraft({ name: '', field: '', phone: '' });
        load();
        if (data?.provider) openProvider(data.provider);
      })
      .catch(err => toast.error(apiError(err, 'ההוספה נכשלה')));
  };

  const removeProvider = async (p) => {
    if (!(await confirm({
      title: 'הסרת ספק',
      message: `להסיר את "${p.name}"? החוגים שלו/ה יכובו, והמפגשים שכבר נרשמו יישארו.`,
    }))) return;
    api.delete(`/classes/providers/${p._id}`).then(load)
      .catch(err => toast.error(apiError(err, 'המחיקה נכשלה')));
  };

  // ------------------------------------------------------------- one provider
  const openProvider = (p) => {
    setLoading(true);
    api.get(`/classes/providers/${p._id}/schedule`)
      .then(r => {
        setEditing({ ...r.data.provider, branch_ids: (r.data.provider.branch_ids || []).map(String) });
        setRows((r.data.programs || []).map(g => ({
          _id: g._id,
          branch_id: String(g.branch_id),
          classroom_category: g.classroom_category || '',
          name: g.name || '',
          instructor_name: g.instructor_name || '',
          default_day: g.default_day == null ? '' : String(g.default_day),
          default_time: g.default_time || '',
          default_rate: g.default_rate ?? '',
        })));
      })
      .catch(err => toast.error(apiError(err, 'הטעינה נכשלה')))
      .finally(() => setLoading(false));
  };

  const setField = (k, v) => setEditing(e => ({ ...e, [k]: v }));
  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  /**
   * A row belongs to a branch from the moment it exists.
   *
   * It used to be added to whichever branch sorted first and the person was
   * told to change it — which is a step that is easy to forget, and forgetting
   * it files a class at the wrong gan with the wrong rate.
   */
  const addRow = (branchId) => setRows(rs => [...rs, {
    branch_id: branchId || editing.branch_ids[0] || (branches[0] ? bid(branches[0]) : ''),
    classroom_category: '', name: editing.name || '', instructor_name: '',
    default_day: '', default_time: '', default_rate: '',
  }]);
  const dropRow = (i) => setRows(rs => rs.filter((_, j) => j !== i));

  const saveProvider = () => {
    const bad = rows.find(r => !r.branch_id);
    if (bad) return toast.error('לכל שורה צריך סניף');
    setSaving(true);
    api.put(`/classes/providers/${editing._id}`, {
      name: editing.name, field: editing.field || '', phone: editing.phone || '',
      email: editing.email || '', notes: editing.notes || '',
    })
      .then(() => api.put(`/classes/providers/${editing._id}/schedule`, {
        branch_ids: editing.branch_ids,
        vat_mode: editing.vat_mode,
        rows: rows.map(r => ({ ...r, default_rate: Number(r.default_rate) || 0 })),
      }))
      .then(() => { toast.success('נשמר'); setEditing(null); load(); })
      .catch(err => toast.error(apiError(err, 'השמירה נכשלה')))
      .finally(() => setSaving(false));
  };

  // Rows are shown grouped by branch, because that is how somebody reads a
  // week: "what does she do at משה דיין", not "row 4".
  const byBranch = editing
    ? (editing.branch_ids.length ? editing.branch_ids : [...new Set(rows.map(r => r.branch_id))])
    : [];

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {editing && (
          <IconButton size="small" onClick={() => setEditing(null)}><ArrowBackIcon /></IconButton>
        )}
        <PeopleIcon color="primary" />
        {editing ? editing.name : 'ספקי גנים'}
      </DialogTitle>

      <DialogContent>
        {loading && <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress /></Box>}

        {/* ------------------------------------------------------ the list */}
        {!editing && !loading && (
          <Box sx={{ mt: 1 }}>
            {providers.length > 0 && (
              <Table size="small">
                <TableHead><TableRow>
                  <TableCell>שם</TableCell><TableCell>תחום</TableCell>
                  <TableCell>סניפים</TableCell><TableCell>טלפון</TableCell>
                  <TableCell align="center">מע״מ</TableCell><TableCell />
                </TableRow></TableHead>
                <TableBody>
                  {providers.map(p => (
                    <TableRow key={p._id} hover>
                      <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                      <TableCell>{p.field || '—'}</TableCell>
                      <TableCell>
                        {(p.branch_ids || []).length
                          ? (p.branch_ids || []).map(id => (
                            <Chip key={String(id)} size="small" variant="outlined"
                              label={branchName(id)} sx={{ ml: 0.5 }} />
                          ))
                          : <Typography variant="caption" color="text.secondary">לא הוגדרו</Typography>}
                      </TableCell>
                      <TableCell dir="ltr">{p.phone || '—'}</TableCell>
                      <TableCell align="center">
                        <Chip size="small" variant="outlined"
                          label={p.vat_mode === 'registered' ? 'עוסק מורשה' : 'פטור'} />
                      </TableCell>
                      <TableCell align="left">
                        <IconButton size="small" onClick={() => openProvider(p)}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" color="error" onClick={() => removeProvider(p)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography sx={{ fontWeight: 700, mb: 1 }}>הוספת ספק</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField size="small" label="שם" value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} fullWidth />
              <TextField size="small" label="תחום" value={draft.field}
                onChange={e => setDraft(d => ({ ...d, field: e.target.value }))} fullWidth />
              <TextField size="small" label="טלפון" value={draft.phone}
                onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} fullWidth />
            </Stack>
            <Button variant="contained" startIcon={<AddIcon />} sx={{ mt: 1.5 }} onClick={addProvider}>
              הוסף
            </Button>
            <Alert severity="info" sx={{ mt: 2 }}>
              אחרי ההוספה פתח/י את הספק כדי להגדיר באילו סניפים הוא עובד, באילו ימים ושעות,
              ומה התעריף לכל קבוצה.
            </Alert>
          </Box>
        )}

        {/* --------------------------------------------- one provider's setup */}
        {editing && !loading && (
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField size="small" label="שם" value={editing.name || ''}
                onChange={e => setField('name', e.target.value)} fullWidth />
              <TextField size="small" label="תחום" value={editing.field || ''}
                onChange={e => setField('field', e.target.value)} fullWidth />
              <TextField size="small" label="טלפון" value={editing.phone || ''}
                onChange={e => setField('phone', e.target.value)} fullWidth />
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel>סניפים</InputLabel>
                <Select
                  multiple value={editing.branch_ids} input={<OutlinedInput label="סניפים" />}
                  onChange={e => setField('branch_ids', e.target.value)}
                  renderValue={(sel) => sel.map(branchName).join(', ')}
                >
                  {branches.map(b => (
                    <MenuItem key={bid(b)} value={bid(b)}>
                      <Checkbox checked={editing.branch_ids.includes(bid(b))} />
                      <ListItemText primary={b.name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                select size="small" label="מע״מ" sx={{ minWidth: 190 }}
                value={editing.vat_mode || 'exempt'}
                onChange={e => setField('vat_mode', e.target.value)}
                helperText="התעריף נרשם תמיד לפני מע״מ"
              >
                <MenuItem value="exempt">עוסק פטור</MenuItem>
                <MenuItem value="registered">עוסק מורשה</MenuItem>
              </TextField>
            </Stack>

            <Divider />
            <Stack direction="row" alignItems="center">
              <Typography sx={{ fontWeight: 700 }}>הלוח השבועי</Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" startIcon={<AddIcon />} onClick={() => addRow()}>שורה</Button>
            </Stack>

            {rows.length === 0 && (
              <Alert severity="info">
                עוד לא הוגדר לוח. כל שורה היא קבוצה אחת בסניף אחד — יום, שעה ותעריף.
                מדריך/ה שעושה שלוש קבוצות באותו בוקר = שלוש שורות,
                <b> והתעריף נקבע לכל שורה בנפרד</b> — אותה מדריכה יכולה לקבל סכום
                אחד בסניף אחד וסכום אחר בשני.
              </Alert>
            )}

            {byBranch.map(branchId => {
              const mine = rows.map((r, i) => ({ r, i })).filter(x => x.r.branch_id === branchId);
              return (
                <Box key={branchId} sx={{ border: '1px solid #e5e7eb', borderRadius: 2, p: 1.5 }}>
                  <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
                    <Typography sx={{ fontWeight: 600 }}>{branchName(branchId)}</Typography>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" startIcon={<AddIcon />} onClick={() => addRow(branchId)}>
                      הוספת קבוצה
                    </Button>
                  </Stack>
                  {mine.length === 0 && (
                    <Typography variant="caption" color="text.secondary">
                      אין קבוצות בסניף הזה. לחצ/י "הוספת קבוצה".
                    </Typography>
                  )}
                  {mine.map(({ r, i }) => (
                    <Stack
                      key={i}
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={1}
                      // Wrap rather than overflow. Eight fields do not fit the
                      // dialog's width, and the one pushed off the edge was the
                      // rate — the only number on the line that costs money,
                      // invisible and still saved.
                      useFlexGap
                      sx={{ mb: 1.5, flexWrap: 'wrap', alignItems: 'center' }}
                    >
                      <TextField select size="small" label="סניף" sx={{ minWidth: 150 }}
                        value={r.branch_id} onChange={e => setRow(i, { branch_id: e.target.value })}>
                        {branches.map(b => <MenuItem key={bid(b)} value={bid(b)}>{b.name}</MenuItem>)}
                      </TextField>
                      <TextField select size="small" label="קבוצה" sx={{ minWidth: 130 }}
                        value={r.classroom_category} onChange={e => setRow(i, { classroom_category: e.target.value })}>
                        {CATEGORIES.map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                      </TextField>
                      <TextField size="small" label="שם החוג" sx={{ minWidth: 130 }}
                        value={r.name} onChange={e => setRow(i, { name: e.target.value })} />
                      <TextField size="small" label="שם המדריך/ה" sx={{ minWidth: 130 }}
                        value={r.instructor_name} onChange={e => setRow(i, { instructor_name: e.target.value })} />
                      <TextField select size="small" label="יום" sx={{ minWidth: 110 }}
                        value={r.default_day} onChange={e => setRow(i, { default_day: e.target.value })}>
                        <MenuItem value="">גמיש</MenuItem>
                        {DAY_NAMES.map((d, n) => <MenuItem key={d} value={String(n)}>{d}</MenuItem>)}
                      </TextField>
                      <TextField size="small" label="שעה" type="time" sx={{ minWidth: 115 }}
                        InputLabelProps={{ shrink: true }}
                        value={r.default_time} onChange={e => setRow(i, { default_time: e.target.value })} />
                      <TextField size="small" label="תעריף" type="number" sx={{ width: 120 }}
                        value={r.default_rate} onChange={e => setRow(i, { default_rate: e.target.value })}
                        InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }} />
                      <IconButton size="small" color="error" onClick={() => dropRow(i)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                </Box>
              );
            })}

            <Alert severity="warning">
              שורה שתוסר כאן תכבה את החוג — המפגשים שכבר נרשמו עליו יישארו, והחודשים
              ששולמו לא משתנים.
            </Alert>
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={editing ? () => setEditing(null) : onClose}>
          {editing ? 'חזרה' : 'סגור'}
        </Button>
        {editing && (
          <Button variant="contained" onClick={saveProvider} disabled={saving}>
            {saving ? 'שומר…' : 'שמירה'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
