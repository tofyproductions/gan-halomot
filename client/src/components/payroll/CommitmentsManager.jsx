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

function CommitmentEditor({ open, initial, employees, onClose, onSaved }) {
  const [draft, setDraft] = useState(initial || { employee_id: '', classroom: '', days: emptyDays() });

  useEffect(() => {
    if (open) {
      setDraft(initial || { employee_id: '', classroom: '', days: emptyDays() });
    }
  }, [open, initial]);

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
      <DialogTitle>{initial?.employee_id ? 'עריכת התחייבות' : 'הוספת התחייבות חדשה'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            disabled={!!initial?.employee_id}
            options={employees}
            getOptionLabel={(e) => `${e.full_name}${e.israeli_id ? ` (${e.israeli_id})` : ''}`}
            value={employees.find(e => e._id === draft.employee_id) || null}
            onChange={(_, v) => setDraft(d => ({ ...d, employee_id: v?._id || '' }))}
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
            </Stack>
          </FormControl>

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
  const { selectedBranch, isAllBranches } = useBranch();
  const [commitments, setCommitments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState({ open: false, initial: null });
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (selectedBranch && !isAllBranches) params.branch = selectedBranch;
    Promise.all([
      api.get('/payroll/commitments', { params }),
      api.get('/payroll/employees', { params: { active: 'true' } }),
    ])
      .then(([cRes, eRes]) => {
        setCommitments(cRes.data.commitments || []);
        setEmployees(eRes.data.employees || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedBranch, isAllBranches]);

  useEffect(() => { load(); }, [load]);

  const remove = (id) => {
    if (!confirm('להסיר התחייבות זו?')) return;
    api.delete(`/payroll/commitments/${id}`)
      .then(() => load())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const employeesWithoutCommitment = useMemo(() => {
    const set = new Set(commitments.map(c => String(c.employee_id?._id || c.employee_id)));
    return employees.filter(e => !set.has(String(e._id)));
  }, [employees, commitments]);

  return (
    <Box dir="rtl">
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 1.5, mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="h6" sx={{ fontWeight: 800, flex: 1 }}>התחייבויות שעות עבודה</Typography>
          <Chip label={`${commitments.length} עובדות`} color="primary" variant="outlined" />
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
            {!loading && commitments.map(c => (
              <TableRow key={c.id} hover>
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
                    <IconButton size="small" onClick={() => setEditor({
                      open: true,
                      initial: {
                        employee_id: c.employee_id?._id || c.employee_id,
                        classroom: c.classroom,
                        days: c.days?.length ? c.days : emptyDays(),
                        is_alternating_off: c.is_alternating_off,
                        alternating_day: c.alternating_day,
                        notes: c.notes,
                      },
                    })}><EditIcon fontSize="small" /></IconButton>
                  </Tooltip>
                  <Tooltip title="מחק">
                    <IconButton size="small" color="error" onClick={() => remove(c.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <CommitmentEditor
        open={editor.open}
        initial={editor.initial}
        employees={employees}
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
