import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Button, Card, CardContent, Stack, Chip, TextField, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, AlertTitle,
  CircularProgress, IconButton, Tooltip, Table, TableHead, TableRow, TableCell,
  TableBody, Tabs, Tab,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import DescriptionIcon from '@mui/icons-material/Description';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import GroupsIcon from '@mui/icons-material/Groups';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'react-toastify';
import api, { openApiFile, apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import { FilePickButton, BusyButton } from '../shared/UploadControls';
import { useConfirm } from '../shared/ConfirmProvider';

/**
 * קורסים והכשרות — the tracking sheet, alive.
 *
 * A matrix: every active employee, one column per course, the cell coloured by
 * how much time the certificate has left. Clicking a cell opens the תעודה —
 * the one-click requirement this screen exists for. The "זימון קבוצתי" dialog
 * answers the other question the sheet couldn't: who can share one course.
 */

// The two that expire come first — they are what the screen is for.
const MATRIX_COLUMNS = ['first_aid', 'safe_conduct', 'caregiver', 'advanced_caregiver'];

const STATUS_STYLE = {
  expired: { label: 'פג תוקף', color: 'error' },
  expiring: { label: 'נדרש חידוש', color: 'warning' },
  ok: { label: 'בתוקף', color: 'success' },
  no_expiry: { label: 'יש תעודה', color: 'default' },
};

const FILTERS = [
  { key: 'all', label: 'הכל' },
  { key: 'attention', label: 'לטיפול' },
  { key: 'expired', label: 'פג תוקף' },
  { key: 'missing', label: 'חסר קורס' },
];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');
const toInputDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** The live course of this type, or null — the matrix cell's contents. */
const courseOf = (emp, type) => emp.courses.find(c => c.course_type === type) || null;

/** Does this employee need attention on the expiring courses? */
function worstOf(emp) {
  const statuses = ['first_aid', 'safe_conduct'].map(t => {
    const c = courseOf(emp, t);
    return c ? c.status : 'missing';
  });
  if (statuses.includes('expired')) return 'expired';
  if (statuses.includes('missing')) return 'missing';
  if (statuses.includes('expiring')) return 'expiring';
  return 'ok';
}

const EMPTY_FORM = {
  course_type: 'first_aid', label: '', completed_at: '', expires_at: '',
  external_url: '', status_note: '', notes: '', file: null,
};

export default function CoursesPage() {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [branchFilter, setBranchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState(0);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);   // {employee, mode:'create'|'edit', id?, ...EMPTY_FORM}
  const [saving, setSaving] = useState(false);
  const [groups, setGroups] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/employee-courses');
      setData(res.data);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בטעינת הקורסים'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const courseTypes = data?.course_types || {};

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim();
    const fkey = FILTERS[statusFilter].key;
    return data.employees.filter(e => {
      if (branchFilter && e.branch_id !== branchFilter) return false;
      if (q && !e.full_name.includes(q)) return false;
      const worst = worstOf(e);
      if (fkey === 'attention') return ['expired', 'expiring', 'missing'].includes(worst);
      if (fkey === 'expired') return worst === 'expired';
      if (fkey === 'missing') return worst === 'missing';
      return true;
    });
  }, [data, branchFilter, statusFilter, search]);

  const byBranch = useMemo(() => {
    const m = new Map();
    for (const e of filtered) {
      const k = e.branch_name || 'ללא סניף';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
  }, [filtered]);

  /** Who needs the same course — the list a group course is booked from. */
  const groupLists = useMemo(() => {
    if (!data) return [];
    return ['first_aid', 'safe_conduct'].map(type => ({
      type,
      label: courseTypes[type] || type,
      people: data.employees
        .map(e => ({ emp: e, c: courseOf(e, type) }))
        .filter(({ c }) => !c || ['expired', 'expiring'].includes(c.status))
        .map(({ emp, c }) => ({
          name: emp.full_name,
          branch: emp.branch_name,
          phone: emp.phone,
          expires_at: c?.expires_at || null,
          missing: !c,
        }))
        .sort((a, b) => (a.expires_at ? new Date(a.expires_at) : 0) - (b.expires_at ? new Date(b.expires_at) : 0)),
    }));
  }, [data, courseTypes]);

  const openCert = (row) => {
    if (row.has_file) {
      openApiFile(`/employee-courses/${row.id}/file`, { filename: row.file_name });
    } else if (row.external_url) {
      window.open(row.external_url, '_blank', 'noopener');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        course_type: form.course_type,
        label: form.label,
        completed_at: form.completed_at || null,
        expires_at: form.expires_at || null,
        external_url: form.external_url,
        status_note: form.status_note,
        notes: form.notes,
        ...(form.file ? {
          file_data: form.file.data, file_name: form.file.name, file_mimetype: form.file.mimetype,
        } : {}),
      };
      const opts = form.file ? { timeout: UPLOAD_TIMEOUT_MS } : {};
      if (form.mode === 'edit') {
        await api.put(`/employee-courses/${form.id}`, body, opts);
      } else {
        await api.post('/employee-courses', { ...body, employee_id: form.employee.id }, opts);
      }
      toast.success('נשמר');
      setForm(null);
      load();
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בשמירה'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({
      title: 'מחיקת רשומת קורס',
      message: `למחוק את הרשומה של ${form.employee.full_name}? המחיקה סופית.`,
      danger: true,
    }))) return;
    try {
      await api.delete(`/employee-courses/${form.id}`);
      toast.success('נמחק');
      setForm(null);
      load();
    } catch (err) {
      toast.error(apiError(err, 'שגיאה במחיקה'));
    }
  };

  const copyGroup = (g) => {
    const lines = g.people.map(p =>
      `${p.name} (${p.branch})${p.phone ? ` — ${p.phone}` : ''} — ${p.missing ? 'אין קורס' : `תוקף עד ${fmtDate(p.expires_at)}`}`);
    navigator.clipboard.writeText(`${g.label} — לזימון:\n${lines.join('\n')}`)
      .then(() => toast.success('הרשימה הועתקה'))
      .catch(() => toast.error('ההעתקה נכשלה'));
  };

  if (loading && !data) return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;
  if (!data) return null;

  const attention = data.employees.filter(e => ['expired', 'expiring', 'missing'].includes(worstOf(e))).length;

  /** One matrix cell. */
  const cell = (emp, type) => {
    const c = courseOf(emp, type);
    const expiring = type === 'first_aid' || type === 'safe_conduct';
    if (!c) {
      return (
        <Chip size="small" variant="outlined"
          color={expiring ? 'error' : 'default'}
          label={expiring ? 'חסר' : '—'}
          onClick={() => setForm({ mode: 'create', employee: emp, ...EMPTY_FORM, course_type: type })}
        />
      );
    }
    const st = STATUS_STYLE[c.status];
    const text = c.expires_at
      ? fmtDate(c.expires_at)
      : (c.status_note || st.label);
    return (
      <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="flex-end">
        <Tooltip title={[
          c.status === 'expiring' && c.days_left != null ? `נדרש חידוש — בעוד ${c.days_left} ימים` : st.label,
          c.status_note,
          (c.has_file || c.external_url) ? 'לחיצה פותחת את התעודה' : 'אין תעודה מצורפת',
        ].filter(Boolean).join(' · ')}>
          <Chip
            size="small"
            color={expiring ? st.color : 'default'}
            variant={c.status === 'ok' || !expiring ? 'outlined' : 'filled'}
            icon={(c.has_file || c.external_url)
              ? (c.has_file ? <DescriptionIcon /> : <OpenInNewIcon />)
              : undefined}
            label={text}
            onClick={(c.has_file || c.external_url) ? () => openCert(c) : undefined}
          />
        </Tooltip>
        <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setForm({
          mode: 'edit', id: c.id, employee: emp,
          course_type: c.course_type, label: c.label,
          completed_at: toInputDate(c.completed_at), expires_at: toInputDate(c.expires_at),
          external_url: c.external_url, status_note: c.status_note, notes: c.notes, file: null,
        })}>
          <EditIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Stack>
    );
  };

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>קורסים והכשרות</Typography>
          <Typography variant="body2" color="text.secondary">
            עזרה ראשונה והתנהלות בטוחה לכל עובדת — תוקף, תעודה בלחיצה, וזימון קבוצתי.
            התראה במייל נשלחת {data.warn_days} ימים לפני פקיעה.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField select size="small" label="סניף" value={branchFilter}
            onChange={e => setBranchFilter(e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="">כל הסניפים</MenuItem>
            {data.branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <TextField size="small" placeholder="חיפוש שם" value={search}
            onChange={e => setSearch(e.target.value)} sx={{ minWidth: 160 }} />
          <Button variant="outlined" startIcon={<GroupsIcon />} onClick={() => setGroups(true)}>
            זימון קבוצתי
          </Button>
        </Stack>
      </Stack>

      {attention > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>{attention} עובדות דורשות טיפול</AlertTitle>
          פג תוקף, עומד לפוג, או שאין קורס רשום כלל. אפשר לרכז אותן לקורס אחד דרך "זימון קבוצתי".
        </Alert>
      )}

      <Tabs value={statusFilter} onChange={(_, v) => setStatusFilter(v)} sx={{ mb: 2 }}>
        {FILTERS.map(f => <Tab key={f.key} label={f.label} />)}
      </Tabs>

      <Stack spacing={2}>
        {byBranch.map(([branchName, emps]) => (
          <Card key={branchName} variant="outlined">
            <CardContent>
              <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', mb: 1 }}>
                {branchName} ({emps.length})
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell align="right">עובדת</TableCell>
                      <TableCell align="right">תפקיד</TableCell>
                      {MATRIX_COLUMNS.map(t => (
                        <TableCell key={t} align="right">{courseTypes[t] || t}</TableCell>
                      ))}
                      <TableCell align="left" />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {emps.map(emp => (
                      <TableRow key={emp.id}>
                        <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {emp.full_name}
                        </TableCell>
                        <TableCell align="right">{emp.position}</TableCell>
                        {MATRIX_COLUMNS.map(t => (
                          <TableCell key={t} align="right">{cell(emp, t)}</TableCell>
                        ))}
                        <TableCell align="left">
                          <Tooltip title="הוספת קורס / תעודה">
                            <IconButton size="small" onClick={() => setForm({
                              mode: 'create', employee: emp, ...EMPTY_FORM,
                            })}>
                              <AddIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </CardContent>
          </Card>
        ))}
        {!filtered.length && (
          <Box sx={{ textAlign: 'center', py: 8 }}>
            <Typography color="text.secondary">אין עובדות ברשימה הזו</Typography>
          </Box>
        )}
      </Stack>

      {/* ---- הוספה / עריכה ---- */}
      <Dialog open={!!form} onClose={() => setForm(null)} maxWidth="sm" fullWidth dir="rtl">
        <DialogTitle>
          {form?.mode === 'edit' ? 'עריכת קורס' : 'הוספת קורס'} — {form?.employee?.full_name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {form?.mode === 'create' && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                תעודה חדשה מאותו סוג מחליפה את הקודמת — הישנה נשמרת בהיסטוריה.
              </Alert>
            )}
            <TextField select label="קורס" value={form?.course_type || ''} fullWidth
              disabled={form?.mode === 'edit'}
              onChange={e => setForm(v => ({ ...v, course_type: e.target.value }))}>
              {Object.entries(courseTypes).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
            {form?.course_type === 'other' && (
              <TextField label="שם הקורס" value={form?.label || ''} fullWidth
                onChange={e => setForm(v => ({ ...v, label: e.target.value }))} />
            )}
            <Stack direction="row" spacing={2}>
              <TextField type="date" label="הושלם בתאריך" InputLabelProps={{ shrink: true }} fullWidth
                value={form?.completed_at || ''} onChange={e => setForm(v => ({ ...v, completed_at: e.target.value }))} />
              <TextField type="date" label="בתוקף עד" InputLabelProps={{ shrink: true }} fullWidth
                value={form?.expires_at || ''} onChange={e => setForm(v => ({ ...v, expires_at: e.target.value }))}
                helperText="קורס מטפלות — אפשר להשאיר ריק" />
            </Stack>
            <Stack direction="row" spacing={2} alignItems="center">
              <FilePickButton
                onPick={file => setForm(v => ({ ...v, file }))}
                hasFile={!!form?.file}
                label="העלאת התעודה" replaceLabel="החלפת התעודה"
                onError={msg => toast.error(msg)}
              />
              {form?.file && <Typography variant="body2" color="text.secondary">{form.file.name}</Typography>}
            </Stack>
            <TextField label="או קישור לתעודה קיימת (Drive)" value={form?.external_url || ''} fullWidth
              dir="ltr" placeholder="https://drive.google.com/…"
              onChange={e => setForm(v => ({ ...v, external_url: e.target.value }))} />
            <TextField label="סטטוס (למשל: רשומה לקורס בספטמבר)" value={form?.status_note || ''} fullWidth
              onChange={e => setForm(v => ({ ...v, status_note: e.target.value }))} />
            <TextField label="הערות" multiline minRows={2} value={form?.notes || ''} fullWidth
              onChange={e => setForm(v => ({ ...v, notes: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          {form?.mode === 'edit' && (
            <Button color="error" startIcon={<DeleteIcon />} onClick={remove} sx={{ ml: 'auto' }}>
              מחיקה
            </Button>
          )}
          <Button onClick={() => setForm(null)}>ביטול</Button>
          <BusyButton variant="contained" loading={saving} onClick={save}>שמירה</BusyButton>
        </DialogActions>
      </Dialog>

      {/* ---- זימון קבוצתי ---- */}
      <Dialog open={groups} onClose={() => setGroups(false)} maxWidth="md" fullWidth dir="rtl">
        <DialogTitle>זימון קבוצתי — מי צריכה קורס</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            כל מי שפג לה התוקף, עומד לפוג בקרוב, או שאין לה קורס רשום — ממוינות לפי דחיפות.
            כפתור ההעתקה מכין רשימה לשליחה למרכז הקורסים.
          </Typography>
          <Stack spacing={3}>
            {groupLists.map(g => (
              <Box key={g.type}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography sx={{ fontWeight: 800 }}>{g.label} — {g.people.length} עובדות</Typography>
                  <Box sx={{ flex: 1 }} />
                  {g.people.length > 0 && (
                    <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => copyGroup(g)}>
                      העתקת הרשימה
                    </Button>
                  )}
                </Stack>
                {g.people.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">כולן בתוקף 🎉</Typography>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell align="right">עובדת</TableCell>
                        <TableCell align="right">סניף</TableCell>
                        <TableCell align="right">טלפון</TableCell>
                        <TableCell align="right">תוקף</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {g.people.map((p, i) => (
                        <TableRow key={i}>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>{p.name}</TableCell>
                          <TableCell align="right">{p.branch}</TableCell>
                          <TableCell align="right" dir="ltr">{p.phone}</TableCell>
                          <TableCell align="right">
                            {p.missing
                              ? <Chip size="small" color="error" variant="outlined" label="אין קורס רשום" />
                              : <Chip size="small"
                                  color={new Date(p.expires_at) < new Date() ? 'error' : 'warning'}
                                  label={fmtDate(p.expires_at)} />}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setGroups(false)}>סגירה</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
