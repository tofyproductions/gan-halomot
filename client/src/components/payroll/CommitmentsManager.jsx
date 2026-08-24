import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Button, IconButton, Chip, Table, TableHead,
  TableRow, TableCell, TableBody, TextField, Tooltip, Dialog, DialogTitle,
  DialogContent, DialogActions, Select, MenuItem, FormControl, InputLabel,
  Alert, Divider, Autocomplete,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import EditIcon from '@mui/icons-material/Edit';
import LinkIcon from '@mui/icons-material/Link';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * Manage weekly work commitments per employee. Loads / shows / edits the
 * EmployeeCommitment collection. Supports CSV import from the bookkeeper's
 * "התחייבות שעות עבודה" spreadsheet — matches by name, surfaces unmatched
 * rows for manual linking.
 */

const DAY_LABELS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'"];

function emptyDays() {
  return [0, 1, 2, 3, 4, 5].map(d => ({ day: d, is_off: true, start_hhmm: '', end_hhmm: '' }));
}

// Always return a full Sun–Fri (0–5) array, merging any existing day data so the
// editor shows every day (missing days render as "off"), never a blank form.
function fullDays(days) {
  const byDay = new Map((days || []).map(d => [d.day, d]));
  return [0, 1, 2, 3, 4, 5].map(d => {
    const ex = byDay.get(d);
    return ex
      ? { day: d, is_off: !!ex.is_off, start_hhmm: ex.start_hhmm || '', end_hhmm: ex.end_hhmm || '' }
      : { day: d, is_off: true, start_hhmm: '', end_hhmm: '' };
  });
}

// Build an editable draft from an existing commitment record.
function draftFromCommitment(c) {
  return {
    employee_id: c.employee_id?._id || c.employee_id,
    classroom: c.classroom || '',
    days: fullDays(c.days),
    is_alternating_off: c.is_alternating_off,
    alternating_day: c.alternating_day,
    alternating_per_month: c.alternating_per_month ?? null,
    notes: c.notes || '',
  };
}

function CommitmentEditor({ open, initial, employees, commitments = [], onClose, onSaved }) {
  const [draft, setDraft] = useState({ employee_id: '', classroom: '', days: emptyDays() });

  useEffect(() => {
    if (open) {
      setDraft(initial
        ? { ...initial, days: fullDays(initial.days) }
        : { employee_id: '', classroom: '', days: emptyDays() });
    }
  }, [open, initial]);

  // When adding (no fixed employee), picking an employee who already has a
  // commitment loads their existing hours for editing instead of a blank form.
  const onPickEmployee = (v) => {
    const id = v?._id || '';
    const existing = id && commitments.find(c => String(c.employee_id?._id || c.employee_id) === String(id));
    if (existing) setDraft(draftFromCommitment(existing));
    else setDraft(d => ({ ...d, employee_id: id }));
  };

  const updateDay = (dayIdx, patch) => {
    setDraft(d => ({
      ...d,
      days: d.days.map((x, i) => i === dayIdx ? { ...x, ...patch } : x),
    }));
  };

  const save = () => {
    if (!draft.employee_id) return toast.error('יש לבחור עובד');
    api.put('/payroll/commitments', draft)
      .then(res => { onSaved(res.data.commitment); onClose(); toast.success('נשמר'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  if (!open) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth dir="rtl">
      <DialogTitle>
        {(initial?.employee_id || commitments.some(c => String(c.employee_id?._id || c.employee_id) === String(draft.employee_id)))
          ? 'עריכת התחייבות' : 'הוספת התחייבות חדשה'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            disabled={!!initial?.employee_id}
            options={employees}
            getOptionLabel={(e) => `${e.full_name}${e.israeli_id ? ` (${e.israeli_id})` : ''}`}
            value={employees.find(e => e._id === draft.employee_id) || null}
            onChange={(_, v) => onPickEmployee(v)}
            renderInput={(params) => <TextField {...params} label="עובד" size="small" />}
          />
          <TextField label="כיתה" size="small" value={draft.classroom || ''}
            onChange={e => setDraft(d => ({ ...d, classroom: e.target.value }))} />

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>לוח שבועי</Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>יום</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>חופש?</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>התחלה</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סיום</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {draft.days.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontWeight: 700 }}>{DAY_LABELS[d.day]}</TableCell>
                    <TableCell>
                      <Select size="small" value={d.is_off ? 'off' : 'work'}
                        onChange={e => updateDay(i, { is_off: e.target.value === 'off' })}>
                        <MenuItem value="work">עבודה</MenuItem>
                        <MenuItem value="off">חופש</MenuItem>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <TextField type="time" size="small" disabled={d.is_off}
                        value={d.start_hhmm || ''}
                        onChange={e => updateDay(i, { start_hhmm: e.target.value })}
                        InputLabelProps={{ shrink: true }} />
                    </TableCell>
                    <TableCell>
                      <TextField type="time" size="small" disabled={d.is_off}
                        value={d.end_hhmm || ''}
                        onChange={e => updateDay(i, { end_hhmm: e.target.value })}
                        InputLabelProps={{ shrink: true }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>

          <FormControl size="small">
            <Stack direction="row" spacing={1} alignItems="center">
              <Select value={draft.is_alternating_off ? 'yes' : 'no'}
                onChange={e => setDraft(d => ({ ...d, is_alternating_off: e.target.value === 'yes' }))}>
                <MenuItem value="no">אין חופש לסרוגין</MenuItem>
                <MenuItem value="yes">חופש לסרוגין</MenuItem>
              </Select>
              {draft.is_alternating_off && (
                <Select value={draft.alternating_day ?? ''}
                  onChange={e => setDraft(d => ({ ...d, alternating_day: e.target.value }))}
                  displayEmpty>
                  <MenuItem value="">— יום —</MenuItem>
                  {DAY_LABELS.map((l, i) => <MenuItem key={i} value={i}>{l}</MenuItem>)}
                </Select>
              )}
              {draft.is_alternating_off && (
                <Select value={draft.alternating_per_month ?? ''}
                  onChange={e => setDraft(d => ({ ...d, alternating_per_month: e.target.value === '' ? null : Number(e.target.value) }))}
                  displayEmpty>
                  <MenuItem value="">כל שבועיים (ברירת מחדל)</MenuItem>
                  <MenuItem value={1}>פעם בחודש</MenuItem>
                  <MenuItem value={2}>פעמיים בחודש</MenuItem>
                  <MenuItem value={3}>3 פעמים בחודש</MenuItem>
                  <MenuItem value={4}>4 פעמים בחודש</MenuItem>
                </Select>
              )}
            </Stack>
          </FormControl>
          {draft.is_alternating_off && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
              היום הנבחר לא ייספר כהיעדרות. השעות החודשיות = מספר הפעמים × שעות אותו יום.
            </Typography>
          )}

          <TextField label="הערות" size="small" multiline minRows={2} value={draft.notes || ''}
            onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

function ImportDialog({ open, onClose, onDone, employees }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [linking, setLinking] = useState({});

  const submit = () => {
    if (!csv.trim()) return toast.error('יש להדביק טקסט CSV');
    api.post('/payroll/commitments/import', { csv })
      .then(res => { setResult(res.data); toast.success(`${res.data.matched.length} שורות נשמרו, ${res.data.unmatched.length} לא זוהו`); onDone(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(reader.result);
    reader.readAsText(file, 'utf-8');
  };

  const link = (row, employee_id) => {
    api.post('/payroll/commitments/link', {
      employee_id,
      classroom: row.classroom,
      days: row.days,
      is_alternating_off: row.is_alternating_off,
      alternating_day: row.alternating_day,
    })
      .then(() => {
        toast.success('חובר');
        setResult(prev => ({ ...prev, unmatched: prev.unmatched.filter(u => u !== row) }));
        onDone();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth dir="rtl">
      <DialogTitle>ייבוא התחייבויות מ-CSV</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          הדבק את תוכן הקובץ או העלה אותו. השדה הראשון בכל שורה = שם, אחר כך כיתה, ואז 6 זוגות התחלה/סיום (יום א׳..יום ו׳).
          "חופש" בעמודת התחלה = יום חופש.
        </Alert>
        <Stack spacing={2}>
          <Button component="label" startIcon={<UploadFileIcon />} variant="outlined">
            העלה קובץ CSV
            <input hidden type="file" accept=".csv" onChange={handleFile} />
          </Button>
          <TextField label="או הדבק טקסט CSV כאן" multiline minRows={6} fullWidth
            value={csv} onChange={e => setCsv(e.target.value)} />
          <Button variant="contained" onClick={submit}>ייבא</Button>

          {result && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                ✓ זוהו ונשמרו: {result.matched.length}
              </Typography>
              {result.unmatched.length > 0 && (
                <>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'error.main' }}>
                    שורות שלא זוהו ({result.unmatched.length}) — חבר ידנית:
                  </Typography>
                  <Stack spacing={1}>
                    {result.unmatched.map((row, idx) => (
                      <Paper key={idx} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box sx={{ flex: 1 }}>
                            <Typography sx={{ fontWeight: 700 }}>{row.raw_name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              כיתה: {row.classroom || '—'} • שורה {row.row_number}
                            </Typography>
                          </Box>
                          <Autocomplete
                            sx={{ width: 300 }} size="small"
                            options={employees}
                            getOptionLabel={(e) => `${e.full_name}${e.israeli_id ? ` (${e.israeli_id})` : ''}`}
                            value={linking[idx] || null}
                            onChange={(_, v) => setLinking(prev => ({ ...prev, [idx]: v }))}
                            renderInput={(p) => <TextField {...p} placeholder="בחר עובד" />}
                          />
                          <Button
                            variant="contained" startIcon={<LinkIcon />}
                            disabled={!linking[idx]}
                            onClick={() => link(row, linking[idx]._id)}
                          >חבר</Button>
                        </Stack>
                      </Paper>
                    ))}
                  </Stack>
                </>
              )}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function CommitmentsManager() {
  const confirm = useConfirm();
  const { selectedBranch, isAllBranches } = useBranch();
  const [commitments, setCommitments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState({ open: false, initial: null });
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (selectedBranch && !isAllBranches) params.branch = selectedBranch;
    Promise.all([
      api.get('/payroll/commitments', { params }),
      // `params` already carries the selected branch — the commitments call
      // uses it and this one did not, so choosing a branch narrowed half the
      // screen and downloaded every employee in the customer for the other
      // half. Harmless at four branches, and at two thousand it is the whole
      // roster fetched to render one branch's table.
      api.get('/payroll/employees', { params: { ...params, active: 'true' } }),
    ])
      .then(([cRes, eRes]) => {
        setCommitments(cRes.data.commitments || []);
        setEmployees(eRes.data.employees || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);

  useEffect(() => { load(); }, [load]);

  const remove = async (id) => {
    if (!(await confirm({ title: 'הסרת התחייבות', message: 'להסיר התחייבות זו?', danger: true, remember_key: 'remove-commitment' }))) return;
    api.delete(`/payroll/commitments/${id}`)
      .then(() => load())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const employeesWithoutCommitment = useMemo(() => {
    const set = new Set(commitments.map(c => String(c.employee_id?._id || c.employee_id)));
    return employees.filter(e => !set.has(String(e._id)));
  }, [employees, commitments]);

  // Filter by search, then group by branch (sorted), employees sorted by name.
  const branchGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = commitments.filter(c => {
      if (!q) return true;
      return (c.employee_id?.full_name || '').toLowerCase().includes(q)
        || (c.branch_id?.name || '').toLowerCase().includes(q)
        || (c.classroom || '').toLowerCase().includes(q)
        || String(c.employee_id?.israeli_id || '').includes(q);
    });
    const map = new Map();
    for (const c of filtered) {
      const name = c.branch_id?.name || 'ללא סניף';
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(c);
    }
    const groups = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
    for (const [, arr] of groups) {
      arr.sort((a, b) => (a.employee_id?.full_name || '').localeCompare(b.employee_id?.full_name || '', 'he'));
    }
    return groups;
  }, [commitments, search]);
  const filteredCount = branchGroups.reduce((s, [, arr]) => s + arr.length, 0);

  return (
    <Box dir="rtl">
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 1.5, mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="h6" sx={{ fontWeight: 800 }}>התחייבויות שעות עבודה</Typography>
          <TextField
            size="small" placeholder="חיפוש לפי שם / סניף / כיתה / ת״ז"
            value={search} onChange={e => setSearch(e.target.value)}
            sx={{ flex: 1, minWidth: 200 }}
          />
          <Chip label={`${search ? `${filteredCount}/` : ''}${commitments.length} עובדות`} color="primary" variant="outlined" />
          {employeesWithoutCommitment.length > 0 && (
            <Chip label={`${employeesWithoutCommitment.length} ללא התחייבות`} color="warning" variant="outlined" />
          )}
          <Button startIcon={<UploadFileIcon />} variant="outlined" onClick={() => setImportOpen(true)}>ייבא מ-CSV</Button>
          <Button variant="contained" onClick={() => setEditor({ open: true, initial: null })}>הוסף התחייבות</Button>
        </Stack>
      </Paper>

      <Paper sx={{ borderRadius: 3, overflow: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ bgcolor: 'grey.50' }}>
              <TableCell align="center" sx={{ fontWeight: 700, width: 44 }}>#</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>כיתה</TableCell>
              {DAY_LABELS.map((l, i) => (
                <TableCell key={i} align="center" sx={{ fontWeight: 700 }}>יום {l}</TableCell>
              ))}
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={11} align="center" sx={{ py: 3 }}>טוען…</TableCell></TableRow>}
            {!loading && commitments.length === 0 && (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.disabled' }}>
                אין התחייבויות מוגדרות. לחץ "ייבא מ-CSV" או "הוסף התחייבות".
              </TableCell></TableRow>
            )}
            {!loading && commitments.length > 0 && filteredCount === 0 && (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.disabled' }}>
                לא נמצאו תוצאות לחיפוש "{search}".
              </TableCell></TableRow>
            )}
            {!loading && (() => {
              const rows = [];
              let serial = 0;
              for (const [branchName, list] of branchGroups) {
                rows.push(
                  <TableRow key={`hdr-${branchName}`} sx={{ bgcolor: 'grey.200' }}>
                    <TableCell colSpan={11} sx={{ fontWeight: 900, py: 0.75 }}>
                      🏠 {branchName} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8rem' }}>• {list.length}</Box>
                    </TableCell>
                  </TableRow>
                );
                for (const c of list) {
                  serial += 1;
                  rows.push(
                    <TableRow key={c.id} hover>
                      <TableCell align="center" sx={{ color: 'text.secondary' }}>{serial}</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>{c.employee_id?.full_name || '—'}</TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" label={c.branch_id?.name || '—'} />
                      </TableCell>
                      <TableCell>{c.classroom || '—'}</TableCell>
                      {DAY_LABELS.map((_, dayIdx) => {
                        const day = (c.days || []).find(d => d.day === dayIdx);
                        if (!day) return <TableCell key={dayIdx} align="center"><span style={{ opacity: 0.3 }}>—</span></TableCell>;
                        if (day.is_off) {
                          return (
                            <TableCell key={dayIdx} align="center">
                              <Chip size="small" label={c.is_alternating_off && c.alternating_day === dayIdx ? 'לסירוגין' : 'חופש'}
                                color={c.is_alternating_off && c.alternating_day === dayIdx ? 'secondary' : 'default'}
                                sx={{ height: 18, fontSize: '0.65rem' }} />
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={dayIdx} align="center" sx={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                            {day.start_hhmm}<br />{day.end_hhmm}
                          </TableCell>
                        );
                      })}
                      <TableCell align="left">
                        <Tooltip title="ערוך">
                          <IconButton size="small" onClick={() => setEditor({ open: true, initial: draftFromCommitment(c) })}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="מחק">
                          <IconButton size="small" color="error" onClick={() => remove(c.id)}>
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                }
              }
              return rows;
            })()}
          </TableBody>
        </Table>
      </Paper>

      <CommitmentEditor
        open={editor.open}
        initial={editor.initial}
        employees={employees}
        commitments={commitments}
        onClose={() => setEditor({ open: false, initial: null })}
        onSaved={() => load()}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={load}
        employees={employees}
      />
    </Box>
  );
}
