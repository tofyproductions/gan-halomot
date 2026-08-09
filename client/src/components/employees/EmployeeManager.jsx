import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Button, Stack, MenuItem, Dialog, DialogTitle, DialogContent,
  DialogActions, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, Chip, IconButton, Tooltip, TextField, Divider, InputAdornment, Alert,
  ToggleButton, ToggleButtonGroup, Switch, FormControlLabel,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ScheduleIcon from '@mui/icons-material/Schedule';
import GavelIcon from '@mui/icons-material/Gavel';
import DescriptionIcon from '@mui/icons-material/Description';
import { useNavigate } from 'react-router-dom';
import EmploymentContractDialog, { CONTRACT_STATUS } from './EmploymentContractDialog';
import LinkIcon from '@mui/icons-material/Link';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useBranch } from '../../hooks/useBranch';
import { branchColor } from '../../utils/branchColors';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatCurrency } from '../../utils/hebrewYear';
import HoursReportDialog from './HoursReportDialog';
import ClockMatchDialog from './ClockMatchDialog';
import EmployeeChangeRequests from './EmployeeChangeRequests';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import Badge from '@mui/material/Badge';

// Job titles carry gender in Hebrew, so the list follows the employee's own.
// Pairs, not two lists, so switching gender can translate the title already on
// the card instead of blanking a select whose value is no longer an option.
const POSITION_PAIRS = [
  { f: 'גננת', m: 'גנן' },
  { f: 'מובילת כיתה', m: 'מוביל כיתה' },
  { f: 'מטפלת', m: 'מטפל' },
  { f: 'סייעת', m: 'סייע' },
  { f: 'מבשלת', m: 'טבח' },
  { f: 'מנהלת', m: 'מנהל' },
  { f: 'אחר', m: 'אחר' },
];
const positionsFor = (gender) => POSITION_PAIRS.map(p => (gender === 'male' ? p.m : p.f));
/** The same title in the other gender, or the value untouched if unrecognised. */
const translatePosition = (value, gender) => {
  const pair = POSITION_PAIRS.find(p => p.f === value || p.m === value);
  if (!pair) return value;
  return gender === 'male' ? pair.m : pair.f;
};

const EMPTY_FORM = {
  full_name: '',
  israeli_id: '',
  branch_id: '',
  phone: '',
  email: '',
  // Almost the entire staff is female; a new card starts there and is changed
  // for the exceptions, rather than leaving every new hire ungendered.
  gender: 'female',
  position: '',
  start_date: '',
  salary_type: 'hourly',
  salary_is_net: false,
  // First-amuta rates — simplified single-amuta view. The full
  // amuta_distribution is preserved on the object and restored on save.
  hourly_rate: '',
  global_salary: '',
  global_ot_rate: '',
  required_hours: '',
  travel_mode: 'per_day',
  travel_per_day: 16,
  travel_monthly_flat: 0,
  travel_allowance: 0,
  meal_vouchers: 0,
  recreation_annual: 0,
  pension_exempt: false,
  bituach_leumi_exempt: false,
  work_days: [0, 1, 2, 3, 4],
  is_active: true,
  // Paid by default. Turning this off makes the person a role-holder only:
  // on the org chart, on the clock, able to manage a branch — but absent from
  // the salary table and the accountant export until it is turned back on.
  receives_salary: true,
  notes: '',
};

// Weekday picker options (Saturday is always off, so not selectable).
const WEEKDAY_OPTIONS = [
  { value: 0, label: 'א' },
  { value: 1, label: 'ב' },
  { value: 2, label: 'ג' },
  { value: 3, label: 'ד' },
  { value: 4, label: 'ה' },
  { value: 5, label: 'ו' },
];

/**
 * Extract editable rate fields from the first amuta in the distribution.
 * We keep the rest of the distribution untouched and only write back to the
 * same slot, so adding a new distribution UI later doesn't break existing data.
 */
function flattenPrimaryAmuta(emp) {
  const dist = emp?.amuta_distribution || [];
  const first = dist[0] || {};
  return {
    hourly_rate: first.hourly_rate ?? '',
    global_salary: first.global_salary ?? '',
    global_ot_rate: first.global_ot_rate ?? '',
    required_hours: first.required_hours ?? '',
  };
}

/**
 * Merge the edited primary-amuta fields back into the distribution array.
 *
 * If there is no existing distribution AND the user entered a rate, we build a
 * new entry with a null amuta_id. The server resolves the amuta from the
 * employee's branch (with an org-default fallback), so the operator never has
 * to pick an amuta manually.
 */
function mergePrimaryAmuta(existing, form) {
  const hasRateInput = form.hourly_rate !== '' || form.global_salary !== '' ||
                       form.global_ot_rate !== '' || form.required_hours !== '';
  const dist = Array.isArray(existing?.amuta_distribution) ? [...existing.amuta_distribution] : [];

  if (dist.length === 0) {
    if (!hasRateInput) return []; // no distribution, no input → OK to send empty
    return [{
      amuta_id: null, // resolved server-side from the branch amuta
      hourly_rate: form.hourly_rate === '' ? null : Number(form.hourly_rate),
      global_salary: form.global_salary === '' ? null : Number(form.global_salary),
      global_ot_rate: form.global_ot_rate === '' ? null : Number(form.global_ot_rate),
      required_hours: form.required_hours === '' ? null : Number(form.required_hours),
    }];
  }

  const first = { ...dist[0] };
  // Strip the populated amuta object (from populate('amuta_distribution.amuta_id'))
  // back to just the ObjectId so the server accepts it on PUT.
  if (first.amuta_id && typeof first.amuta_id === 'object') {
    first.amuta_id = first.amuta_id._id || first.amuta_id.id;
  }
  first.hourly_rate = form.hourly_rate === '' ? null : Number(form.hourly_rate);
  first.global_salary = form.global_salary === '' ? null : Number(form.global_salary);
  first.global_ot_rate = form.global_ot_rate === '' ? null : Number(form.global_ot_rate);
  first.required_hours = form.required_hours === '' ? null : Number(form.required_hours);
  dist[0] = first;
  // Also strip populated amuta_id from the rest of the distribution.
  for (let i = 1; i < dist.length; i++) {
    if (dist[i].amuta_id && typeof dist[i].amuta_id === 'object') {
      dist[i] = { ...dist[i], amuta_id: dist[i].amuta_id._id || dist[i].amuta_id.id };
    }
  }
  return dist;
}


/* What this employee record still lacks. Blocking gaps stop the month being
   paid or the person being identified; the rest just make later steps harder.
   Shown as a count so the column stays narrow, with the actual list on hover —
   a full-width red row per employee would make the table unreadable. */
function MissingChip({ missing }) {
  const list = missing || [];
  if (list.length === 0) {
    return <Chip size="small" color="success" variant="outlined" label="✓" sx={{ height: 20, fontSize: 11 }} />;
  }
  const blocking = list.filter((m) => m.level === 'blocking');
  const warn = list.filter((m) => m.level !== 'blocking');
  return (
    <Tooltip
      title={
        <Box sx={{ fontSize: 12 }}>
          {blocking.length > 0 && <><b>חוסם תשלום:</b><br />{blocking.map((m) => `• ${m.label}`).join('\n').split('\n').map((t, i) => <span key={i}>{t}<br /></span>)}</>}
          {warn.length > 0 && <><b>חסר:</b><br />{warn.map((m) => `• ${m.label}`).join('\n').split('\n').map((t, i) => <span key={i}>{t}<br /></span>)}</>}
        </Box>
      }
    >
      <Stack direction="row" spacing={0.25} justifyContent="center">
        {blocking.length > 0 && <Chip size="small" color="error" label={blocking.length} sx={{ height: 20, fontSize: 11, fontWeight: 800 }} />}
        {warn.length > 0 && <Chip size="small" color="warning" variant="outlined" label={warn.length} sx={{ height: 20, fontSize: 11 }} />}
      </Stack>
    </Tooltip>
  );
}

export default function EmployeeManager() {
  const { isAdmin, isManager, isAccountant } = useAuth();
  const navigate = useNavigate();
  // Accountant (הנה"ח) manages employees with the same add/edit rights as a
  // manager — only the visible tab set differs (handled by tab access config).
  const canManage = isManager || isAccountant;
  const { branches, selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState({ open: false, mode: 'add', data: { ...EMPTY_FORM }, original: null });
  const [confirm, setConfirm] = useState({ open: false, id: null });
  const [hoursDialog, setHoursDialog] = useState({ open: false, employee: null });
  // Employment contract — status per employee, and the per-employee dialog.
  const [contractDialog, setContractDialog] = useState({ open: false, employee: null });
  const [contractStatuses, setContractStatuses] = useState({});
  const fetchContractStatuses = useCallback(() => {
    api.get('/employment-contracts/status')
      .then(res => setContractStatuses(res.data.statuses || {}))
      .catch(() => {});
  }, []);
  useEffect(() => { fetchContractStatuses(); }, [fetchContractStatuses]);

  const [clockMatchOpen, setClockMatchOpen] = useState(false);
  const [changeReqOpen, setChangeReqOpen] = useState(false);
  const [pendingChanges, setPendingChanges] = useState(0);
  // Inline editing: { empId, field, value }
  const [inlineEdit, setInlineEdit] = useState(null);
  const [search, setSearch] = useState('');
  // Narrow the roster to records that are still missing something.
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const fetchEmployees = useCallback(() => {
    if (!selectedBranch) { setEmployees([]); setLoading(false); return; }
    setLoading(true);
    const params = { branch: selectedBranch };
    if (!showArchived) params.active = 'true';
    api.get('/payroll/employees', { params })
      .then(res => setEmployees(res.data.employees || []))
      .catch((err) => {
        console.error(err);
        toast.error('שגיאה בטעינת עובדים');
      })
      .finally(() => setLoading(false));
  }, [selectedBranch, showArchived]);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  // Count of employee-card edits waiting for the accountant (badge on the toolbar).
  const fetchPendingChanges = useCallback(() => {
    api.get('/payroll/employee-change-requests', { params: { status: 'pending' } })
      .then(r => setPendingChanges((r.data.requests || []).length))
      .catch(() => setPendingChanges(0));
  }, []);
  useEffect(() => { fetchPendingChanges(); }, [fetchPendingChanges]);

  const openAdd = () => setDialog({
    open: true,
    mode: 'add',
    data: { ...EMPTY_FORM, branch_id: isAllBranches ? '' : selectedBranch },
    original: null,
  });

  const openEdit = (emp) => {
    const primary = flattenPrimaryAmuta(emp);
    setDialog({
      open: true,
      mode: 'edit',
      data: {
        full_name: emp.full_name || '',
        israeli_id: emp.israeli_id || '',
        branch_id: emp.branch_id || '',
        phone: emp.phone || '',
        email: emp.email || '',
        gender: emp.gender || '',
        position: emp.position || '',
        start_date: emp.start_date ? new Date(emp.start_date).toISOString().slice(0, 10) : '',
        salary_type: emp.salary_type || 'hourly',
        salary_is_net: !!emp.salary_is_net,
        travel_mode: emp.travel_mode || 'per_day',
        travel_per_day: emp.travel_per_day ?? 16,
        travel_monthly_flat: emp.travel_monthly_flat || 0,
        travel_allowance: emp.travel_allowance || 0,
        meal_vouchers: emp.meal_vouchers || 0,
        recreation_annual: emp.recreation_annual || 0,
        pension_exempt: !!emp.pension_exempt,
        bituach_leumi_exempt: !!emp.bituach_leumi_exempt,
        work_days: Array.isArray(emp.work_days) ? emp.work_days : [0, 1, 2, 3, 4],
        is_active: emp.is_active !== false,
        receives_salary: emp.receives_salary !== false,
        notes: emp.notes || '',
        is_pregnant: !!emp.is_pregnant,
        due_date: emp.due_date ? new Date(emp.due_date).toISOString().slice(0, 10) : '',
        gave_birth_date: emp.gave_birth_date ? new Date(emp.gave_birth_date).toISOString().slice(0, 10) : '',
        on_pregnancy_bedrest: !!emp.on_pregnancy_bedrest,
        on_maternity_leave: !!emp.on_maternity_leave,
        maternity_leave_from: emp.maternity_leave_from ? new Date(emp.maternity_leave_from).toISOString().slice(0, 10) : '',
        maternity_leave_to: emp.maternity_leave_to ? new Date(emp.maternity_leave_to).toISOString().slice(0, 10) : '',
        id: emp._id || emp.id,
        branch_rates: (emp.branch_rates || []).map(br => ({
          branch_id: String(br.branch_id?._id || br.branch_id),
          hourly_rate: br.hourly_rate ?? '',
          global_salary: br.global_salary ?? '',
          global_ot_rate: br.global_ot_rate ?? '',
          required_hours: br.required_hours ?? '',
        })),
        hourly_bonuses: (emp.hourly_bonuses || []).map(hb => ({
          branch_id: String(hb.branch_id?._id || hb.branch_id),
          rate: hb.rate ?? '',
          reason: hb.reason || '',
        })),
        ...primary,
      },
      original: emp,
    });
  };

  const closeDialog = () => setDialog({ open: false, mode: 'add', data: { ...EMPTY_FORM }, original: null });

  const handleSave = async () => {
    const { mode, data, original } = dialog;
    if (!data.full_name?.trim()) return toast.error('שם מלא חובה');
    if (!data.branch_id) return toast.error('סניף חובה');

    const distribution = mergePrimaryAmuta(original, data);

    const payload = {
      full_name: data.full_name.trim(),
      israeli_id: (data.israeli_id || '').trim(),
      branch_id: data.branch_id,
      phone: data.phone || '',
      email: data.email || '',
      gender: data.gender || '',
      position: data.position || '',
      start_date: data.start_date || null,
      salary_type: data.salary_type,
      salary_is_net: data.salary_is_net,
      travel_mode: data.travel_mode || 'per_day',
      travel_per_day: Number(data.travel_per_day) || 0,
      travel_monthly_flat: Number(data.travel_monthly_flat) || 0,
      travel_allowance: Number(data.travel_allowance) || 0,
      meal_vouchers: Number(data.meal_vouchers) || 0,
      recreation_annual: Number(data.recreation_annual) || 0,
      pension_exempt: data.pension_exempt,
      bituach_leumi_exempt: data.bituach_leumi_exempt,
      work_days: Array.isArray(data.work_days) ? [...data.work_days].sort((a, b) => a - b) : [0, 1, 2, 3, 4],
      is_active: data.is_active !== false,
      receives_salary: data.receives_salary !== false,
      notes: data.notes || '',
      // Pregnancy / maternity status (display + alerts only, no auto pay effect).
      is_pregnant: !!data.is_pregnant,
      due_date: data.due_date || null,
      gave_birth_date: data.gave_birth_date || null,
      on_pregnancy_bedrest: !!data.on_pregnancy_bedrest,
      on_maternity_leave: !!data.on_maternity_leave,
      maternity_leave_from: data.maternity_leave_from || null,
      maternity_leave_to: data.maternity_leave_to || null,
    };
    // Only include amuta_distribution in the payload if we can actually
    // modify it safely (existing distribution, or genuinely empty).
    if (Array.isArray(distribution)) {
      payload.amuta_distribution = distribution;
    }
    // Per-branch rate overrides for cross-branch workers.
    payload.branch_rates = (data.branch_rates || [])
      .filter(br => br.branch_id && (br.hourly_rate || br.global_salary))
      .map(br => ({
        branch_id: br.branch_id,
        hourly_rate: br.hourly_rate === '' ? null : Number(br.hourly_rate),
        global_salary: br.global_salary === '' ? null : Number(br.global_salary),
        global_ot_rate: br.global_ot_rate === '' ? null : Number(br.global_ot_rate),
        required_hours: br.required_hours === '' ? null : Number(br.required_hours),
      }));
    // Personal per-branch hourly bonuses.
    payload.hourly_bonuses = (data.hourly_bonuses || [])
      .filter(hb => hb.branch_id && Number(hb.rate) > 0)
      .map(hb => ({
        branch_id: hb.branch_id,
        rate: Number(hb.rate) || 0,
        reason: hb.reason || '',
      }));

    try {
      if (mode === 'add') {
        await api.post('/payroll/employees', payload);
        toast.success('עובד נוסף');
      } else {
        const res = await api.put(`/payroll/employees/${data.id}`, payload);
        // Branch-manager edits don't apply directly — they wait for the accountant.
        if (res.data?.pending_approval) {
          toast.info(`השינויים (${res.data.changes_count}) נשלחו לאישור הנהלת החשבונות`, { autoClose: 6000 });
        } else if (res.data?.no_changes) {
          toast.info('לא בוצעו שינויים');
        } else {
          toast.success('עובד עודכן');
        }
      }
      closeDialog();
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/payroll/employees/${confirm.id}`);
      toast.success('עובד הוסר');
      setConfirm({ open: false, id: null });
      fetchEmployees();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const updateField = (key, value) => {
    setDialog(prev => ({ ...prev, data: { ...prev.data, [key]: value } }));
  };

  // Inline editing: save on Enter/blur, cancel on Escape
  const startInlineEdit = (empId, field, currentValue) => {
    setInlineEdit({ empId, field, value: String(currentValue ?? '') });
  };
  const saveInlineEdit = async () => {
    if (!inlineEdit) return;
    const { empId, field, value } = inlineEdit;
    setInlineEdit(null);
    try {
      await api.put(`/payroll/employees/${empId}`, { [field]: value });
      fetchEmployees();
    } catch (err) {
      toast.error('שגיאה בעדכון');
    }
  };
  const cancelInlineEdit = () => setInlineEdit(null);

  /**
   * Render an inline-editable cell. Shows text normally; on double-click shows
   * a small TextField. Enter saves, Escape cancels.
   */
  const EditableCell = ({ empId, field, value, displayValue, align, dir, sx }) => {
    const isEditing = inlineEdit?.empId === empId && inlineEdit?.field === field;
    if (isEditing) {
      return (
        <TableCell align={align} dir={dir} sx={sx}>
          <TextField
            size="small"
            autoFocus
            variant="standard"
            value={inlineEdit.value}
            onChange={e => setInlineEdit({ ...inlineEdit, value: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') saveInlineEdit(); if (e.key === 'Escape') cancelInlineEdit(); }}
            onBlur={saveInlineEdit}
            inputProps={{ dir: dir || 'rtl', style: { fontSize: '0.85rem', padding: '2px 4px', textAlign: align || 'right' } }}
            sx={{ width: '100%', minWidth: 60 }}
          />
        </TableCell>
      );
    }
    return (
      <TableCell
        align={align}
        dir={dir}
        sx={{ ...sx, cursor: 'pointer', '&:hover': { bgcolor: '#fef3c7' } }}
        onDoubleClick={() => startInlineEdit(empId, field, value)}
      >
        {displayValue || value || '—'}
      </TableCell>
    );
  };

  const { totalCount, missingIdCount } = useMemo(() => ({
    totalCount: employees.length,
    missingIdCount: employees.filter(e => !e.israeli_id).length,
  }), [employees]);

  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (onlyIncomplete) list = list.filter(e => (e.missing_fields || []).length > 0);
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter(e =>
      (e.full_name || '').toLowerCase().includes(q) ||
      (e.israeli_id || '').includes(q) ||
      (e.position || '').toLowerCase().includes(q) ||
      (e.phone || '').includes(q) ||
      (e.email || '').toLowerCase().includes(q)
    );
  }, [employees, search, onlyIncomplete]);

  // How much of the roster is unusable as-is. Blocking gaps mean the month
  // cannot be paid for that person, so they get counted separately.
  const gapStats = useMemo(() => {
    let blocking = 0, warning = 0;
    for (const e of employees) {
      const m = e.missing_fields || [];
      if (m.some(x => x.level === 'blocking')) blocking++;
      else if (m.length) warning++;
    }
    return { blocking, warning };
  }, [employees]);

  // Group filtered employees by branch (only used when "all branches" view).
  const employeesByBranch = useMemo(() => {
    if (!isAllBranches) return null;
    const groups = new Map();
    for (const e of filteredEmployees) {
      const bid = String(e.branch_id || 'no-branch');
      if (!groups.has(bid)) groups.set(bid, []);
      groups.get(bid).push(e);
    }
    return groups;
  }, [filteredEmployees, isAllBranches]);

  const branchById = useMemo(() => {
    const m = new Map();
    (branches || []).forEach((b, idx) => m.set(String(b._id || b.id), { branch: b, idx }));
    return m;
  }, [branches]);

  return (
    <Box dir="rtl" sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול עובדים</Typography>
          <Typography variant="caption" color="text.secondary">
            {totalCount} עובדים
            {missingIdCount > 0 && ` • ${missingIdCount} בלי ת״ז`}
          </Typography>
          {(gapStats.blocking > 0 || gapStats.warning > 0) && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }} alignItems="center">
              {gapStats.blocking > 0 && (
                <Chip size="small" color="error" label={`${gapStats.blocking} חוסמים תשלום`} sx={{ fontWeight: 700 }} />
              )}
              {gapStats.warning > 0 && (
                <Chip size="small" color="warning" variant="outlined" label={`${gapStats.warning} עם נתונים חסרים`} />
              )}
              <Button size="small" onClick={() => setOnlyIncomplete(v => !v)} sx={{ fontSize: 12 }}>
                {onlyIncomplete ? 'הצג את כולם' : 'הצג רק חסרים'}
              </Button>
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            placeholder="חיפוש שם / ת״ז / תפקיד / טלפון"
            size="small"
            value={search}
            onChange={e => setSearch(e.target.value)}
            sx={{ width: 280 }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearch('')}><ClearIcon fontSize="small" /></IconButton>
                </InputAdornment>
              ) : null,
            }}
          />
          <Tooltip title={showArchived ? 'מציג עובדים פעילים + ארכיון' : 'מציג עובדים פעילים בלבד'}>
            <Button
              size="small"
              variant={showArchived ? 'contained' : 'outlined'}
              color={showArchived ? 'warning' : 'inherit'}
              onClick={() => setShowArchived(v => !v)}
            >
              {showArchived ? 'כולל ארכיון' : 'הצג ארכיון'}
            </Button>
          </Tooltip>
          {canManage && (
            <>
              <Badge color="warning" badgeContent={pendingChanges} max={99}>
                <Button
                  variant="outlined" color="warning" startIcon={<FactCheckIcon />}
                  onClick={() => setChangeReqOpen(true)}
                >
                  {isAdmin || isAccountant ? 'שינויים לאישור' : 'שינויים שהגשתי'}
                </Button>
              </Badge>
              <Button variant="outlined" startIcon={<LinkIcon />} onClick={() => setClockMatchOpen(true)}>
                שיוך לשעון
              </Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
                הוסף עובד
              </Button>
            </>
          )}
        </Stack>
      </Stack>

      {missingIdCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          {missingIdCount} עובדים עדיין ללא תעודת זהות. החתמות שלהם לא יקושרו אוטומטית עד שתעדכן את ה-ת״ז.
        </Alert>
      )}

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>ת״ז</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>תפקיד</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>טלפון</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>אימייל</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>סוג שכר</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">שכר / תעריף</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">שעות חובה</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">נסיעות</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">שלמות</TableCell>
              {canManage && <TableCell align="center">פעולות</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {(() => {
              const renderEmp = (emp) => {
                const empId = emp._id || emp.id;
                const rate = emp._display_rate;
                const unpaidRole = emp.receives_salary === false;
                const rateLabel = unpaidRole
                  ? 'ללא שכר'
                  : emp.salary_type === 'global'
                    ? (rate ? `${formatCurrency(rate)}/חודש` : '—')
                    : (rate ? `₪${rate}/שעה` : '—');
                return (
                  <TableRow key={empId} hover sx={!emp.is_active ? { bgcolor: 'rgba(0,0,0,0.04)', opacity: 0.75 } : undefined}>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {emp.full_name}
                      {!emp.is_active && <Chip label="ארכיון" size="small" sx={{ ml: 1, height: 18, fontSize: '0.65rem' }} />}
                      {unpaidRole && (
                        <Tooltip title="בעל/ת תפקיד ללא שכר — לא מופיע/ה בטבלת השכר, בייצוא לרו״ח או בבעיות בהחתמה">
                          <Chip label="ללא שכר" size="small" color="warning" variant="outlined"
                            sx={{ ml: 1, height: 18, fontSize: '0.65rem', fontWeight: 700 }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell dir="ltr" sx={{ fontFamily: 'monospace', color: emp.israeli_id ? 'text.primary' : 'warning.main', fontSize: '0.8rem' }}>
                      {emp.israeli_id || '—'}
                    </TableCell>
                    <TableCell>{emp.position || '—'}</TableCell>
                    <EditableCell empId={empId} field="phone" value={emp.phone} displayValue={emp.phone || '—'} dir="ltr" />
                    <EditableCell empId={empId} field="email" value={emp.email} displayValue={emp.email || '—'} dir="ltr"
                      sx={{ fontSize: '0.8rem', color: emp.email ? 'text.primary' : 'warning.main' }} />
                    <TableCell>
                      <Chip
                        label={emp.salary_type === 'global' ? 'תקן' : 'שעתי'}
                        size="small"
                        color={emp.salary_type === 'global' ? 'primary' : 'default'}
                        variant="outlined"
                      />
                      {emp.salary_is_net && <Chip label="נטו" size="small" sx={{ ml: 0.5 }} />}
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700 }}>{rateLabel}</TableCell>
                    <TableCell align="center" sx={{ color: emp.salary_type === 'global' && emp._display_required_hours ? 'text.primary' : 'text.disabled', fontSize: '0.85rem' }}>
                      {emp._display_required_hours ? `${emp._display_required_hours}h` : '—'}
                    </TableCell>
                    <EditableCell empId={empId} field="travel_allowance" value={emp.travel_allowance} displayValue={emp.travel_allowance ? `₪${emp.travel_allowance}` : '—'} align="center" />
                    <TableCell align="center"><MissingChip missing={emp.missing_fields} /></TableCell>
                    {canManage && (
                      <TableCell align="center">
                        <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                          <Tooltip title={emp.is_active ? 'עובד פעיל — לחץ לכיבוי' : 'לא פעיל — לחץ להפעלה'}>
                            <Switch
                              size="small"
                              checked={!!emp.is_active}
                              onChange={async (e) => {
                                try {
                                  await api.put(`/payroll/employees/${empId}`, { is_active: e.target.checked });
                                  toast.success(e.target.checked ? 'העובד הופעל' : 'העובד כובה');
                                  fetchEmployees();
                                } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
                              }}
                            />
                          </Tooltip>
                          <Tooltip title="דוח שעות">
                            <IconButton size="small" onClick={() => setHoursDialog({ open: true, employee: emp })}>
                              <ScheduleIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={(() => {
                            const st = contractStatuses[String(empId)]?.status;
                            return st ? `הסכם העסקה — ${CONTRACT_STATUS[st]?.label || st}` : 'הסכם העסקה — לא הונפק';
                          })()}>
                            <IconButton
                              size="small"
                              color={(() => {
                                const st = contractStatuses[String(empId)]?.status;
                                if (st === 'approved') return 'success';
                                if (st === 'signed' || st === 'uploaded') return 'warning';
                                if (st === 'sent') return 'info';
                                if (st === 'waived') return 'default';
                                return 'error';
                              })()}
                              onClick={() => setContractDialog({ open: true, employee: emp })}
                            >
                              <GavelIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="הנפקת מסמכים (שימוע / פיטורין / אישור העסקה)">
                            <IconButton size="small" sx={{ color: '#b45309' }}
                              onClick={() => navigate(`/employee-letters?employee=${empId}`)}>
                              <DescriptionIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="ערוך">
                            <IconButton size="small" onClick={() => openEdit(emp)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          {!emp.is_active ? (
                            <Tooltip title="החזר לפעילים">
                              <IconButton
                                size="small" color="success"
                                onClick={async () => {
                                  try {
                                    await api.put(`/payroll/employees/${empId}`, { is_active: true });
                                    toast.success('הוחזר לפעילים');
                                    fetchEmployees();
                                  } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
                                }}
                              >
                                <RestoreFromTrashIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : (
                            <Tooltip title="הסר">
                              <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, id: emp._id || emp.id })}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                    )}
                  </TableRow>
                );
              };
              if (loading) return <TableRow><TableCell colSpan={11} sx={{ textAlign: 'center', py: 4 }}>טוען…</TableCell></TableRow>;
              const out = [];
              if (employeesByBranch) {
                const ordered = (branches || [])
                  .map(b => String(b._id || b.id))
                  .filter(id => employeesByBranch.has(id));
                if (employeesByBranch.has('no-branch')) ordered.push('no-branch');
                for (const bid of ordered) {
                  const info = branchById.get(bid);
                  const color = info ? branchColor(info.branch, info.idx) : { header: '#f1f5f9', accent: '#475569', border: '#cbd5e1' };
                  const list = employeesByBranch.get(bid) || [];
                  out.push(
                    <TableRow key={`hdr-${bid}`} sx={{ bgcolor: color.header }}>
                      <TableCell colSpan={canManage ? 11 : 10} sx={{
                        fontWeight: 900, fontSize: '0.9rem', py: 1,
                        color: color.accent, borderTop: '3px solid', borderColor: color.border,
                      }}>
                        🏠 {info?.branch?.name || 'ללא סניף'} <Chip size="small" label={`${list.length} עובדים`} sx={{ ml: 1, bgcolor: 'background.paper' }} />
                      </TableCell>
                    </TableRow>
                  );
                  for (const emp of list) out.push(renderEmp(emp));
                }
                if (out.length === 0) {
                  out.push(<TableRow key="empty"><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.disabled' }}>אין עובדים תואמים את החיפוש</TableCell></TableRow>);
                }
                return out;
              }
              // Single-branch view: simple flat list
              if (filteredEmployees.length === 0) {
                return <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.disabled' }}>{search ? 'אין עובדים תואמים את החיפוש' : 'אין עובדים בסניף זה'}</TableCell></TableRow>;
              }
              return filteredEmployees.map(renderEmp);
            })()}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Employee Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.mode === 'add' ? 'הוסף עובד' : `ערוך עובד — ${dialog.data.full_name}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>פרטים אישיים</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="שם מלא" value={dialog.data.full_name || ''} onChange={e => updateField('full_name', e.target.value)} fullWidth required />
              <TextField label="ת״ז" value={dialog.data.israeli_id || ''} onChange={e => updateField('israeli_id', e.target.value)} fullWidth
                inputProps={{ dir: 'ltr', maxLength: 9 }}
                helperText="9 ספרות; חייב להתאים ל-userId בשעון"
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="טלפון" value={dialog.data.phone || ''} onChange={e => updateField('phone', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
              <TextField label="אימייל" value={dialog.data.email || ''} onChange={e => updateField('email', e.target.value)} fullWidth inputProps={{ dir: 'ltr' }} />
              {/* Drives the wording of every generated document. Left unset the
                  letters stay feminine, which is how the office's own templates
                  are written — a name is not a reliable way to infer this. */}
              <TextField label="מין" select value={dialog.data.gender || ''}
                onChange={e => {
                  const g = e.target.value;
                  setDialog(d => ({
                    ...d,
                    data: { ...d.data, gender: g, position: translatePosition(d.data.position, g) },
                  }));
                }}
                fullWidth
                helperText="קובע לשון פנייה ושם התפקיד"
              >
                <MenuItem value="">לא הוגדר (נקבה כברירת מחדל)</MenuItem>
                <MenuItem value="female">נקבה</MenuItem>
                <MenuItem value="male">זכר</MenuItem>
              </TextField>
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="תפקיד" select value={dialog.data.position || ''} onChange={e => updateField('position', e.target.value)} fullWidth>
                <MenuItem value="">—</MenuItem>
                {positionsFor(dialog.data.gender).map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
                {/* A title already on the card that isn't in the gendered list
                    (legacy free text) must stay selectable, or saving would
                    silently wipe it. */}
                {dialog.data.position && !positionsFor(dialog.data.gender).includes(dialog.data.position) && (
                  <MenuItem value={dialog.data.position}>{dialog.data.position}</MenuItem>
                )}
              </TextField>
              <TextField label="תאריך התחלה" type="date" value={dialog.data.start_date || ''} onChange={e => updateField('start_date', e.target.value)} fullWidth InputLabelProps={{ shrink: true }} />
            </Stack>
            <Stack direction="row" spacing={2}>
              {(isAdmin || isAllBranches) && (
                <TextField label="סניף ראשי" select required value={dialog.data.branch_id || ''}
                  onChange={e => updateField('branch_id', e.target.value)} fullWidth
                  helperText={!dialog.data.branch_id ? 'בחר סניף ראשי לעובד' : ' '}>
                  {branches.map(b => <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>)}
                </TextField>
              )}
            </Stack>

            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                ימי עבודה בשבוע (שבת תמיד חופש) — משמש לחישוב ימי מחלה/היעדרות
              </Typography>
              <ToggleButtonGroup
                size="small"
                value={Array.isArray(dialog.data.work_days) ? dialog.data.work_days : []}
                onChange={(_e, next) => updateField('work_days', next)}
                aria-label="ימי עבודה"
              >
                {WEEKDAY_OPTIONS.map(d => (
                  <ToggleButton key={d.value} value={d.value} sx={{ width: 44, fontWeight: 700 }}>
                    {d.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>

            <FormControlLabel
              control={<Switch checked={dialog.data.is_active !== false} onChange={e => updateField('is_active', e.target.checked)} />}
              label={dialog.data.is_active !== false ? 'עובד פעיל' : 'עובד לא פעיל (לא יופיע בהחתמות)'}
            />

            {/* A role-holder who draws nothing — on the org chart and on the
                clock, but never in the salary table. Reversible at any time. */}
            <FormControlLabel
              control={
                <Switch
                  color="warning"
                  checked={dialog.data.receives_salary === false}
                  onChange={e => updateField('receives_salary', !e.target.checked)}
                />
              }
              label="בעל/ת תפקיד ללא שכר (לא מקבל/ת שכר מהמערכת)"
            />

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'secondary.main' }}>הריון ולידה</Typography>
            <FormControlLabel
              control={<Switch color="secondary" checked={!!dialog.data.is_pregnant} onChange={e => updateField('is_pregnant', e.target.checked)} />}
              label="עובדת בהריון 🤰"
            />
            {dialog.data.is_pregnant && (
              <Stack spacing={2} sx={{ pr: 2, borderRight: '3px solid', borderColor: 'secondary.light' }}>
                <TextField
                  label="צפי לידה" type="date" size="small"
                  value={dialog.data.due_date || ''} onChange={e => updateField('due_date', e.target.value)}
                  InputLabelProps={{ shrink: true }} sx={{ maxWidth: 240 }}
                  helperText="קובע את חלון ספירת 40 שעות הבדיקות"
                />
                <FormControlLabel
                  control={<Switch color="secondary" checked={!!dialog.data.on_pregnancy_bedrest} onChange={e => updateField('on_pregnancy_bedrest', e.target.checked)} />}
                  label="בשמירת הריון (ממומן ע״י ביטוח לאומי — לא מנכה ממאזן המחלה)"
                />
                <Button
                  variant="outlined" color="secondary" size="small" sx={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    const today = new Date().toISOString().slice(0, 10);
                    updateField('gave_birth_date', today);
                    updateField('is_pregnant', false);
                    updateField('on_pregnancy_bedrest', false);
                    updateField('on_maternity_leave', true);
                    if (!dialog.data.maternity_leave_from) updateField('maternity_leave_from', today);
                  }}
                >
                  🍼 עדכני שילדה (פותח חופשת לידה)
                </Button>
              </Stack>
            )}
            <FormControlLabel
              control={<Switch color="secondary" checked={!!dialog.data.on_maternity_leave} onChange={e => updateField('on_maternity_leave', e.target.checked)} />}
              label="בחופשת לידה"
            />
            {dialog.data.on_maternity_leave && (
              <Stack direction="row" spacing={2} sx={{ pr: 2, borderRight: '3px solid', borderColor: 'secondary.light' }}>
                <TextField
                  label="מתאריך" type="date" size="small"
                  value={dialog.data.maternity_leave_from || ''} onChange={e => updateField('maternity_leave_from', e.target.value)}
                  InputLabelProps={{ shrink: true }} fullWidth
                />
                <TextField
                  label="עד תאריך" type="date" size="small"
                  value={dialog.data.maternity_leave_to || ''} onChange={e => updateField('maternity_leave_to', e.target.value)}
                  InputLabelProps={{ shrink: true }} fullWidth
                />
              </Stack>
            )}
            {dialog.data.gave_birth_date && (
              <Typography variant="caption" color="text.secondary">
                תאריך לידה מעודכן: {dialog.data.gave_birth_date}
              </Typography>
            )}

            {dialog.data.receives_salary === false && (
              <Alert severity="info" sx={{ mt: 1 }}>
                בעל/ת תפקיד ללא שכר — לא יופיע/תופיע בטבלת השכר, בייצוא לרו״ח או בבעיות בהחתמה.
                אפשר להחתים בשעון לצורכי נוכחות. כדי להתחיל לשלם, כבה/י את המתג ומלא/י תעריף —
                התשלום יתחיל מאותו חודש, ללא צורך בהקמה מחדש.
              </Alert>
            )}

            {/* Everything below is money. For an unpaid role-holder it is
                disabled rather than removed, so the values she WILL be paid by
                are visible in advance and survive the switch being flipped. */}
            <Box
              component="fieldset"
              disabled={dialog.data.receives_salary === false}
              sx={{
                border: 0, p: 0, m: 0, minWidth: 0,
                display: 'flex', flexDirection: 'column', gap: 2,
                opacity: dialog.data.receives_salary === false ? 0.45 : 1,
                // A disabled fieldset natively disables real inputs, but MUI's
                // Select is a div — it would still open. Kill pointer events so
                // the whole money block is genuinely inert, not just greyed.
                pointerEvents: dialog.data.receives_salary === false ? 'none' : 'auto',
              }}
            >
            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>שכר</Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="סוג שכר" select value={dialog.data.salary_type} onChange={e => updateField('salary_type', e.target.value)} fullWidth>
                <MenuItem value="hourly">שעתי</MenuItem>
                <MenuItem value="global">תקן</MenuItem>
              </TextField>
              <TextField label="נטו/ברוטו" select value={dialog.data.salary_is_net ? 'net' : 'gross'}
                onChange={e => updateField('salary_is_net', e.target.value === 'net')} fullWidth>
                <MenuItem value="gross">ברוטו</MenuItem>
                <MenuItem value="net">נטו</MenuItem>
              </TextField>
            </Stack>
            {dialog.data.salary_type === 'hourly' ? (
              <TextField label="תעריף שעתי" type="number" value={dialog.data.hourly_rate}
                onChange={e => updateField('hourly_rate', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
            ) : (
              <Stack direction="row" spacing={2}>
                <TextField label="שכר תקן חודשי" type="number" value={dialog.data.global_salary}
                  onChange={e => updateField('global_salary', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                />
                <TextField label="שעות נדרשות בחודש" type="number" value={dialog.data.required_hours}
                  onChange={e => updateField('required_hours', e.target.value)} fullWidth
                />
                <TextField label="תעריף שעה נוספת" type="number" value={dialog.data.global_ot_rate}
                  onChange={e => updateField('global_ot_rate', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                />
              </Stack>
            )}

            <Divider />
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>תעריפים פר־סניף (עבודה רב-סניפית)</Typography>
              <Chip size="small" label="אופציונלי" variant="outlined" />
            </Stack>
            <Alert severity="info" sx={{ borderRadius: 2, py: 0.5 }}>
              עובדת בכמה סניפים? הוסף שורה לכל סניף נוסף עם התעריף שלה שם.
              ההחתמות שתבצע באותו סניף יחושבו לפי התעריף המוגדר כאן.
            </Alert>
            {(dialog.data.branch_rates || []).map((br, i) => (
              <Stack key={i} direction="row" spacing={1} alignItems="center">
                <TextField select label="סניף" size="small" sx={{ width: 200 }}
                  value={br.branch_id || ''}
                  onChange={e => {
                    const arr = [...(dialog.data.branch_rates || [])];
                    arr[i].branch_id = e.target.value;
                    updateField('branch_rates', arr);
                  }}
                >
                  {(branches || []).map(b => (
                    <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
                  ))}
                </TextField>
                {dialog.data.salary_type === 'hourly' ? (
                  <TextField label="תעריף שעתי" type="number" size="small" sx={{ width: 140 }}
                    value={br.hourly_rate}
                    onChange={e => {
                      const arr = [...(dialog.data.branch_rates || [])];
                      arr[i].hourly_rate = e.target.value;
                      updateField('branch_rates', arr);
                    }}
                    InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  />
                ) : (
                  <>
                    <TextField label="שכר תקן" type="number" size="small" sx={{ width: 130 }}
                      value={br.global_salary}
                      onChange={e => {
                        const arr = [...(dialog.data.branch_rates || [])];
                        arr[i].global_salary = e.target.value;
                        updateField('branch_rates', arr);
                      }}
                    />
                    <TextField label="שעות נדרשות" type="number" size="small" sx={{ width: 130 }}
                      value={br.required_hours}
                      onChange={e => {
                        const arr = [...(dialog.data.branch_rates || [])];
                        arr[i].required_hours = e.target.value;
                        updateField('branch_rates', arr);
                      }}
                    />
                  </>
                )}
                <IconButton color="error" onClick={() => {
                  const arr = (dialog.data.branch_rates || []).filter((_, idx) => idx !== i);
                  updateField('branch_rates', arr);
                }}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button
              startIcon={<AddIcon />}
              size="small"
              variant="outlined"
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => updateField('branch_rates', [
                ...(dialog.data.branch_rates || []),
                { branch_id: '', hourly_rate: '', global_salary: '', global_ot_rate: '', required_hours: '' },
              ])}
            >
              הוסף תעריף לסניף נוסף
            </Button>

            {dialog.data.salary_type === 'hourly' && (
              <>
                <Divider />
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>בונוס אישי לפי סניף</Typography>
                  <Chip size="small" label="אופציונלי" variant="outlined" />
                </Stack>
                <Alert severity="info" sx={{ borderRadius: 2, py: 0.5 }}>
                  בונוס אישי לשעה לסניף מסוים (למשל +3₪ בהרצליה). הבונוס = הסכום × שעות שעבדה באותו סניף, ומתווסף אוטומטית לשכר ולעמודת הבונוס בטבלה.
                </Alert>
                {(dialog.data.hourly_bonuses || []).map((hb, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center">
                    <TextField select label="סניף" size="small" sx={{ width: 200 }}
                      value={hb.branch_id || ''}
                      onChange={e => { const arr = [...(dialog.data.hourly_bonuses || [])]; arr[i] = { ...arr[i], branch_id: e.target.value }; updateField('hourly_bonuses', arr); }}
                    >
                      {(branches || []).map(b => (
                        <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
                      ))}
                    </TextField>
                    <TextField label="₪ לשעה" type="number" size="small" sx={{ width: 120 }}
                      value={hb.rate}
                      onChange={e => { const arr = [...(dialog.data.hourly_bonuses || [])]; arr[i] = { ...arr[i], rate: e.target.value }; updateField('hourly_bonuses', arr); }}
                      InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                    />
                    <TextField label="סיבה/תיאור" size="small" sx={{ flex: 1, minWidth: 140 }}
                      value={hb.reason || ''}
                      onChange={e => { const arr = [...(dialog.data.hourly_bonuses || [])]; arr[i] = { ...arr[i], reason: e.target.value }; updateField('hourly_bonuses', arr); }}
                    />
                    <IconButton color="error" onClick={() => updateField('hourly_bonuses', (dialog.data.hourly_bonuses || []).filter((_, idx) => idx !== i))}>
                      <DeleteIcon />
                    </IconButton>
                  </Stack>
                ))}
                <Button
                  startIcon={<AddIcon />} size="small" variant="outlined" sx={{ alignSelf: 'flex-start' }}
                  onClick={() => updateField('hourly_bonuses', [...(dialog.data.hourly_bonuses || []), { branch_id: '', rate: '', reason: '' }])}
                >
                  הוסף בונוס לסניף
                </Button>
              </>
            )}

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main' }}>תוספות קבועות</Typography>
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="מודל נסיעות"
                value={dialog.data.travel_mode}
                onChange={e => updateField('travel_mode', e.target.value)}
                sx={{ minWidth: 180 }}
                SelectProps={{ native: true }}
              >
                <option value="per_day">פר יום עבודה</option>
                <option value="monthly_flat">סכום קבוע לחודש</option>
              </TextField>
              {dialog.data.travel_mode === 'per_day' ? (
                <TextField label="נסיעות פר יום" type="number" value={dialog.data.travel_per_day}
                  onChange={e => updateField('travel_per_day', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  helperText="ברירת מחדל: 16 ₪/יום"
                />
              ) : (
                <TextField label="נסיעות חודשי" type="number" value={dialog.data.travel_monthly_flat}
                  onChange={e => updateField('travel_monthly_flat', e.target.value)} fullWidth
                  InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
                  helperText="סכום קבוע בלי תלות בימי עבודה"
                />
              )}
              <TextField label="סיבוס" type="number" value={dialog.data.meal_vouchers}
                onChange={e => updateField('meal_vouchers', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
              <TextField label="הבראה (שנתי)" type="number" value={dialog.data.recreation_annual}
                onChange={e => updateField('recreation_annual', e.target.value)} fullWidth
                InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
              />
            </Stack>
            </Box>

            <Divider />
            <TextField label="הערות" multiline rows={3} value={dialog.data.notes}
              onChange={e => updateField('notes', e.target.value)} fullWidth
              helperText="הלוואות, פטורים, תנאים מיוחדים — כרגע עריכה חופשית. מודלים מובנים יתווספו בהמשך."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSave}>שמור</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={confirm.open} onClose={() => setConfirm({ open: false, id: null })}
        onConfirm={handleDelete} title="הסרת עובד" message="להסיר את העובד מהמערכת? (ההחתמות ההיסטוריות נשמרות)"
      />

      <HoursReportDialog
        open={hoursDialog.open}
        employee={hoursDialog.employee}
        onClose={() => setHoursDialog({ open: false, employee: null })}
      />

      <EmploymentContractDialog
        open={contractDialog.open}
        employee={contractDialog.employee}
        role={isAdmin ? 'system_admin' : isAccountant ? 'accountant' : 'branch_manager'}
        onClose={() => setContractDialog({ open: false, employee: null })}
        onChanged={fetchContractStatuses}
      />

      <ClockMatchDialog
        open={clockMatchOpen}
        branchId={selectedBranch}
        branchName={selectedBranchName}
        onClose={() => setClockMatchOpen(false)}
        onSaved={fetchEmployees}
      />
      <EmployeeChangeRequests
        open={changeReqOpen}
        onClose={() => { setChangeReqOpen(false); fetchPendingChanges(); }}
        onDecided={() => { fetchEmployees(); fetchPendingChanges(); }}
      />
    </Box>
  );
}
