import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Paper, Stack, Typography, TextField, Select, MenuItem, IconButton, Button,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Tooltip,
  Chip, Autocomplete, Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton, ToggleButtonGroup,
  CircularProgress, RadioGroup, FormControlLabel, Radio, Checkbox, FormControl, FormLabel,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import NoteAltIcon from '@mui/icons-material/NoteAlt';
import NumbersIcon from '@mui/icons-material/Numbers';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import TuneIcon from '@mui/icons-material/Tune';
import RestaurantMenuIcon from '@mui/icons-material/RestaurantMenu';
import PaymentsIcon from '@mui/icons-material/Payments';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import { ganMarkerByName as ganMarker } from '../../utils/branchColors';
import SalaryAdjustmentDialog from './SalaryAdjustmentDialog';
import VacationDetailDialog from './VacationDetailDialog';
import SickDetailDialog from './SickDetailDialog';
import HolidayPayDetailDialog from './HolidayPayDetailDialog';
import LoansDialog from './LoansDialog';
import CibusImportDialog from './CibusImportDialog';
import EmployeeDetailDialog from './EmployeeDetailDialog';

/* ─────────────────────────────────────────────────────────────────────────
   Monthly payroll table — auto-calculated per-amuta hours from punches,
   editable manual fields per employee per month, and admin-defined custom
   columns specific to a month (or all months).
   ──────────────────────────────────────────────────────────────────────── */

// Hebrew labels for staged change-request items (branch-manager flow).
const FIELD_LABELS = {
  sick_days: 'מחלה',
  absence_days: 'היעדרות',
  vacation_days: 'חופשה',
  holiday_pay: 'דמי חגים',
  gift_card: 'GIFT CARD',
  recreation: 'הבראה',
  cibus: 'סיבוס',
  miluim: 'מילואים',
  notes: 'הערות',
  advance_deduction_text: 'קיזוז מקדמה',
  advance_deduction_preset_id: 'קיזוז מקדמה',
  travel_override: 'נסיעות',
  include_salary_completion: 'השלמת שכר',
  custom_values: 'עמודה מותאמת',
};

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtNum(n) {
  if (n == null || n === '' || n === 0) return '';
  const v = Number(n);
  if (Number.isNaN(v)) return String(n);
  return v % 1 === 0 ? v.toString() : v.toFixed(2);
}

function fmtCurrency(n) {
  if (n == null) return '';
  return Math.round(Number(n) || 0).toLocaleString('he-IL');
}

function computeTravel(row) {
  // Manual override takes precedence and skips the monthly free-pass cap —
  // admin entered a specific value on purpose.
  if (row.manual.travel_override != null) return row.manual.travel_override;
  const days = row.breakdown?.hours?.days_worked || 0;
  if (row.travel_mode === 'per_day') {
    const perDay = row.travel_per_day || 16;
    return Math.min(perDay * days, 315);
  }
  if (row.travel_mode === 'monthly_flat') return row.travel_monthly_flat || 0;
  return Math.min(16 * days, 315);
}

/* ─── Inline editors ────────────────────────────────────────────────── */

function NumberCell({ value, onSave, disabled, placeholder = '—' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const begin = () => {
    if (disabled) return;
    setDraft(value == null || value === 0 ? '' : String(value));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const n = draft === '' ? 0 : Number(draft);
    if (Number.isNaN(n)) return;
    if (n !== Number(value || 0)) onSave(n);
  };
  if (editing) {
    return (
      <TextField
        autoFocus size="small" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false); }}
        variant="standard"
        inputProps={{ style: { textAlign: 'center', fontSize: '0.8rem', padding: 2 } }}
        sx={{ width: '100%' }}
      />
    );
  }
  const display = value == null || value === 0 || value === '' ? placeholder : fmtNum(value);
  return (
    <Box
      onClick={begin}
      sx={{
        cursor: disabled ? 'default' : 'text', minHeight: 24, fontSize: '0.8rem',
        color: value ? 'text.primary' : 'text.disabled', textAlign: 'center',
        '&:hover': { bgcolor: disabled ? undefined : 'action.hover' },
      }}
    >
      {display}
    </Box>
  );
}

function TextCell({ value, onSave, disabled, placeholder = '—' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const begin = () => { if (disabled) return; setDraft(value || ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    if (String(draft) !== String(value || '')) onSave(draft);
  };
  if (editing) {
    return (
      <TextField
        autoFocus size="small" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false); }}
        variant="standard"
        inputProps={{ style: { textAlign: 'center', fontSize: '0.78rem', padding: 2 } }}
        sx={{ width: '100%' }}
      />
    );
  }
  const display = value ? value : placeholder;
  return (
    <Box
      onClick={begin}
      sx={{
        cursor: disabled ? 'default' : 'text', minHeight: 24, fontSize: '0.78rem',
        color: value ? 'text.primary' : 'text.disabled', textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        '&:hover': { bgcolor: disabled ? undefined : 'action.hover' },
      }}
    >
      {display}
    </Box>
  );
}

function NumberOrTextCell({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState('number');
  const [draft, setDraft] = useState('');

  const begin = () => {
    if (disabled) return;
    const k = value?.kind === 'empty' ? 'number' : (value?.kind || 'number');
    setKind(k);
    setDraft(k === 'number' ? (value?.amount ?? '') : (value?.text ?? ''));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    let next;
    if (draft === '' || draft == null) {
      next = { kind: 'empty', amount: null, text: '' };
    } else if (kind === 'number') {
      const n = Number(draft);
      if (Number.isNaN(n)) return;
      next = { kind: 'number', amount: n, text: '' };
    } else {
      next = { kind: 'text', amount: null, text: String(draft) };
    }
    const same = (next.kind === (value?.kind || 'empty')) &&
                 (next.amount === (value?.amount ?? null)) &&
                 (next.text === (value?.text || ''));
    if (!same) onSave(next);
  };
  if (editing) {
    return (
      <Stack direction="row" alignItems="center" spacing={0.3} sx={{ width: '100%' }}>
        <ToggleButtonGroup
          size="small" value={kind} exclusive onChange={(_, v) => v && setKind(v)}
          sx={{ '& button': { padding: '2px 4px', minWidth: 22, height: 22 } }}
        >
          <ToggleButton value="number"><NumbersIcon sx={{ fontSize: 13 }} /></ToggleButton>
          <ToggleButton value="text"><TextFieldsIcon sx={{ fontSize: 13 }} /></ToggleButton>
        </ToggleButtonGroup>
        <TextField
          autoFocus size="small" variant="standard" value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' && kind === 'number') commit(); else if (e.key === 'Escape') setEditing(false); }}
          sx={{ flex: 1, minWidth: 0 }}
          inputProps={{ style: { textAlign: 'center', fontSize: '0.78rem', padding: 2 } }}
        />
      </Stack>
    );
  }
  const display = (() => {
    if (!value || value.kind === 'empty') return '—';
    if (value.kind === 'number') return fmtCurrency(value.amount);
    return value.text;
  })();
  const isEmpty = !value || value.kind === 'empty';
  return (
    <Box
      onClick={begin}
      sx={{
        cursor: disabled ? 'default' : 'text', minHeight: 24, fontSize: '0.78rem',
        color: isEmpty ? 'text.disabled' : 'text.primary', textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        '&:hover': { bgcolor: disabled ? undefined : 'action.hover' },
      }}
    >
      {display}
    </Box>
  );
}

/* ─── Advance-deduction Autocomplete ────────────────────────────────── */

function AdvanceDeductionCell({ row, presets, onSavePresetId, onSaveText, onCreatePreset, disabled }) {
  const value = row.manual.advance_deduction_preset?.label || row.manual.advance_deduction_text || '';
  const handleChange = (_, v) => {
    if (!v) { onSavePresetId(null); onSaveText(''); return; }
    if (typeof v === 'string') { onCreatePreset(v, (c) => onSavePresetId(c.id)); return; }
    if (v.inputValue) { onCreatePreset(v.inputValue, (c) => onSavePresetId(c.id)); return; }
    onSavePresetId(v.id);
  };
  return (
    <Autocomplete
      size="small" freeSolo disabled={disabled} options={presets}
      value={value || null}
      isOptionEqualToValue={(opt, val) => (opt?.label || opt) === (val?.label || val)}
      getOptionLabel={opt => typeof opt === 'string' ? opt : opt.label}
      filterOptions={(opts, params) => {
        const filtered = opts.filter(o => o.label.toLowerCase().includes(params.inputValue.toLowerCase()));
        if (params.inputValue !== '' && !filtered.some(o => o.label === params.inputValue)) {
          filtered.push({ inputValue: params.inputValue, label: `+ הוסף "${params.inputValue}"` });
        }
        return filtered;
      }}
      onChange={handleChange}
      renderInput={(params) => (
        <TextField {...params} variant="standard" placeholder="בחר…" InputProps={{ ...params.InputProps, style: { fontSize: '0.76rem' } }} />
      )}
      sx={{ width: '100%' }}
    />
  );
}

/* ─── Dialogs ───────────────────────────────────────────────────────── */

function NotesDialog({ open, row, onClose, onSave }) {
  const [text, setText] = useState('');
  useEffect(() => { if (row) setText(row.manual.notes || ''); }, [row]);
  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>הערות — {row.full_name}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth multiline minRows={5} value={text}
          onChange={e => setText(e.target.value)}
          placeholder="הערות חופשי על העובד החודש…"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => { onSave(text); onClose(); }}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

function AddColumnDialog({ open, month, onClose, onCreated }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('number');
  const [persistent, setPersistent] = useState(false);

  useEffect(() => { if (open) { setLabel(''); setKind('number'); setPersistent(false); } }, [open]);

  const save = () => {
    if (!label.trim()) return toast.error('יש להזין שם עמודה');
    api.post('/payroll-month/custom-columns', { month, label: label.trim(), kind, persistent })
      .then(res => { onCreated(res.data.column); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>הוסף עמודה ל-{month}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField autoFocus label="שם העמודה" value={label} onChange={e => setLabel(e.target.value)} fullWidth />
          <FormControl>
            <FormLabel>סוג ערך בתאים</FormLabel>
            <RadioGroup value={kind} onChange={e => setKind(e.target.value)}>
              <FormControlLabel value="number"          control={<Radio />} label="מספרים (סכום בשקלים)" />
              <FormControlLabel value="text"            control={<Radio />} label="טקסט חופשי" />
              <FormControlLabel value="number_or_text"  control={<Radio />} label="מספרים או טקסט (כפתור החלפה בכל תא)" />
            </RadioGroup>
          </FormControl>
          <FormControlLabel
            control={<Checkbox checked={persistent} onChange={e => setPersistent(e.target.checked)} />}
            label="קבע עמודה זו לכל החודשים"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save}>הוסף</Button>
      </DialogActions>
    </Dialog>
  );
}

/* ─── Branch colour palette ─────────────────────────────────────────── */

const BRANCH_PALETTE = [
  { name: 'blue',   header: '#dbeafe', sub: '#eff6ff', cell: '#f8fafc', accent: '#1e40af', border: '#93c5fd' },
  { name: 'green',  header: '#d1fae5', sub: '#ecfdf5', cell: '#f7fef9', accent: '#065f46', border: '#86efac' },
  { name: 'purple', header: '#ede9fe', sub: '#f5f3ff', cell: '#fbfaff', accent: '#5b21b6', border: '#c4b5fd' },
  { name: 'orange', header: '#ffedd5', sub: '#fff7ed', cell: '#fffbf6', accent: '#9a3412', border: '#fdba74' },
  { name: 'rose',   header: '#ffe4e6', sub: '#fff1f2', cell: '#fffafa', accent: '#9f1239', border: '#fda4af' },
  { name: 'teal',   header: '#ccfbf1', sub: '#f0fdfa', cell: '#f6fefc', accent: '#115e59', border: '#5eead4' },
];
function branchColor(idx) { return BRANCH_PALETTE[idx % BRANCH_PALETTE.length]; }

/* Per-gan marker colours live in utils/branchColors (single source of truth).
 * `ganMarker` is the name-keyed lookup, aliased for the existing call sites. */

/* ─── Main component ────────────────────────────────────────────────── */

export default function PayrollMonthTable() {
  const { selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const { isAdmin, isAccountant } = useAuth();
  // Branch managers can't write PayrollMonth directly. They stage edits
  // locally and submit them as one change request to the accountant.
  const isReviewer = isAdmin || isAccountant;
  const stagingMode = !isReviewer;
  const confirm = useConfirm();
  // key `${employeeId}::${field}` → change item
  const [staged, setStaged] = useState({});
  const [submittingReq, setSubmittingReq] = useState(false);
  const [month, setMonth] = useState(currentYearMonth());
  const [ganFilter, setGanFilter] = useState([]); // [] = show all gans (only used in "all branches" view)
  const [viewMode, setViewMode] = useState('branch'); // 'branch' | 'amuta'
  const [selectedAmuta, setSelectedAmuta] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [presets, setPresets] = useState([]);
  const [notes, setNotes] = useState({ open: false, row: null });
  const [addCol, setAddCol] = useState(false);
  const [adjustments, setAdjustments] = useState({ open: false, row: null });
  const [vacation, setVacation] = useState({ open: false, row: null });
  const [sick, setSick] = useState({ open: false, row: null });
  const [empSearch, setEmpSearch] = useState('');
  const [holidayPay, setHolidayPay] = useState({ open: false, row: null });
  const [loansDlg, setLoansDlg] = useState({ open: false, row: null });
  const [cibusDlg, setCibusDlg] = useState(false);
  const [empDetail, setEmpDetail] = useState({ open: false, employeeId: null });

  const isFinalized = useMemo(() => {
    if (!data?.rows?.length) return false;
    return data.rows.every(r => r.status === 'finalized');
  }, [data]);

  useEffect(() => {
    api.get('/payroll-month/presets', { params: { field_name: 'advance_deduction' } })
      .then(res => setPresets(res.data.options || []))
      .catch(() => {});
  }, []);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params = { month };
    if (viewMode === 'branch') {
      if (selectedBranch && !isAllBranches) params.branch = selectedBranch;
    } else if (viewMode === 'amuta' && selectedAmuta) {
      params.amuta = selectedAmuta;
    }
    api.get('/payroll-month', { params })
      .then(res => setData(res.data))
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת טבלת שכר'); })
      .finally(() => setLoading(false));
  }, [month, viewMode, selectedBranch, isAllBranches, selectedAmuta]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const patchManual = useCallback((employeeId, patch) => {
    if (stagingMode) {
      // Stage the edit locally + apply optimistically so the manager sees it.
      const row = data?.rows?.find(r => r.employee_id === employeeId);
      setStaged(prev => {
        const next = { ...prev };
        for (const [field, value] of Object.entries(patch)) {
          next[`${employeeId}::${field}`] = {
            employee_id: employeeId,
            employee_name: row?.full_name || '',
            field,
            field_label: FIELD_LABELS[field] || field,
            current_value: row?.manual?.[field] ?? null,
            requested_value: value,
          };
        }
        return next;
      });
      setData(prev => prev && {
        ...prev,
        rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, manual: { ...r.manual, ...patch } } : r),
      });
      return;
    }
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, manual: { ...r.manual, ...patch } } : r),
      };
    });
    api.patch(`/payroll-month/${employeeId}`, { manual: patch }, { params: { month } })
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [month, fetchData, stagingMode, data]);

  const submitChangeRequest = useCallback(async () => {
    const changes = Object.values(staged);
    if (changes.length === 0) return;
    if (!(await confirm({
      title: 'שליחת בקשת שינוי',
      message: `לשלוח ${changes.length} שינויים לאישור הנה״ח?`,
    }))) return;
    setSubmittingReq(true);
    try {
      await api.post('/payroll-month/change-requests', { month, changes });
      toast.success('הבקשה נשלחה להנה״ח');
      setStaged({});
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשליחת הבקשה');
    } finally {
      setSubmittingReq(false);
    }
  }, [staged, month, confirm, fetchData]);

  const discardStaged = useCallback(async () => {
    if (!(await confirm({ title: 'ביטול שינויים', message: 'לבטל את כל השינויים שטרם נשלחו?', danger: true }))) return;
    setStaged({});
    fetchData();
  }, [confirm, fetchData]);

  const patchCustomValue = useCallback((employeeId, colId, value) => {
    const row = data.rows.find(r => r.employee_id === employeeId);
    const nextCustom = { ...(row?.manual.custom_values || {}), [colId]: value };
    patchManual(employeeId, { custom_values: nextCustom });
  }, [data, patchManual]);

  const createPresetAndUse = useCallback((label, cb) => {
    api.post('/payroll-month/presets', { field_name: 'advance_deduction', label, action: 'custom' })
      .then(res => {
        const created = res.data.option;
        setPresets(prev => prev.some(p => p.id === created.id) ? prev : [...prev, created]);
        cb && cb(created);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  }, []);

  const removeColumn = async (colId) => {
    if (!(await confirm({ title: 'הסרת עמודה', message: 'להסיר את העמודה? הנתונים שהוזנו לעובדים יישמרו בבסיס הנתונים.', danger: true, remember_key: 'remove-payroll-column' }))) return;
    api.delete(`/payroll-month/custom-columns/${colId}`)
      .then(() => fetchData())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const applyAutoHolidays = async () => {
    if (!(await confirm({ title: 'החלת דמי חגים', message: 'להחיל דמי חגים אוטומטית לכל הזכאים? לא ידרסו ערכים שכבר הוזנו ידנית.', remember_key: 'apply-auto-holidays' }))) return;
    const params = {};
    if (viewMode === 'branch' && selectedBranch && !isAllBranches) params.branch = selectedBranch;
    api.post(`/payroll-month/${month}/apply-auto-holidays`, null, { params })
      .then(res => {
        const { updated, skipped_already_set, skipped_not_eligible } = res.data;
        toast.success(`עודכן: ${updated} • דילגתי על קיימים: ${skipped_already_set} • לא זכאים: ${skipped_not_eligible}`);
        fetchData();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const applyKindergartenVacation = async () => {
    if (!(await confirm({ title: 'החלת ימי חופשה מלוח', message: 'להחיל ימי חופשה מלוח חופשות הגן לכל העובדים? לא ידרסו ערכים שכבר הוזנו ידנית.', remember_key: 'apply-kindergarten-vacation' }))) return;
    const params = {};
    if (viewMode === 'branch' && selectedBranch && !isAllBranches) params.branch = selectedBranch;
    api.post(`/payroll-month/${month}/apply-kindergarten-vacation`, null, { params })
      .then(res => {
        const { updated, skipped_already_set, no_kindergarten_holidays } = res.data;
        toast.success(`עודכן: ${updated} • דילגתי על קיימים: ${skipped_already_set} • בלי חגי גן: ${no_kindergarten_holidays}`);
        fetchData();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const applyVacationRequests = async () => {
    if (!(await confirm({ title: 'סנכרון בקשות חופש', message: 'לסנכרן בקשות חופש מאושרות מהחודש הזה לטבלת השכר?', remember_key: 'sync-vacation-requests' }))) return;
    const params = {};
    if (viewMode === 'branch' && selectedBranch && !isAllBranches) params.branch = selectedBranch;
    api.post(`/payroll-month/${month}/apply-vacation-requests`, null, { params })
      .then(res => {
        const { updated, skipped_already_applied, requests_examined } = res.data;
        toast.success(`סונכרנו ${updated} בקשות (${skipped_already_applied} כבר היו) מתוך ${requests_examined}`);
        fetchData();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const finalize = async () => {
    if (!(await confirm({ title: 'נעילת חודש', message: 'לנעול את החודש? לא ניתן יהיה לערוך עד ביטול הנעילה.', danger: true, remember_key: 'finalize-month' }))) return;
    const params = {};
    if (viewMode === 'branch' && selectedBranch && !isAllBranches) params.branch = selectedBranch;
    api.post(`/payroll-month/${month}/finalize`, null, { params })
      .then(() => { toast.success('חודש ננעל'); fetchData(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בנעילה'));
  };
  const reopen = () => {
    const params = {};
    if (viewMode === 'branch' && selectedBranch && !isAllBranches) params.branch = selectedBranch;
    api.post(`/payroll-month/${month}/reopen`, null, { params })
      .then(() => { toast.success('חודש נפתח לעריכה'); fetchData(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  // Branch column groups — coloured per branch. In amuta view we filter to
  // branches under the selected amuta; otherwise show all branches that have
  // data (or are in the current scope filter).
  const visibleBranches = useMemo(() => {
    if (!data) return [];
    const list = data.branches_in_view || [];
    if (viewMode === 'amuta' && selectedAmuta) {
      return list.filter(b => b.amuta_id === selectedAmuta);
    }
    return list;
  }, [data, viewMode, selectedAmuta]);

  const customColumns = data?.custom_columns || [];

  // Per-branch hours × rate breakdown for cross-branch hourly employees — so the
  // accountant can reconcile the estimated total with each branch's rate.
  const branchNameOf = (id) => (data?.branches || []).find(b => b.id === String(id))?.name || 'אחר';
  const perBranchBreakdown = (r) => {
    if (r.salary_type !== 'hourly') return [];
    const pb = r.breakdown?.per_branch || {};
    const out = [];
    for (const [bid, bk] of Object.entries(pb)) {
      const hours = Math.round(((bk.regular_hours || 0) + (bk.ot_125_hours || 0) + (bk.ot_150_hours || 0)) * 10) / 10;
      if (hours > 0) out.push({ name: branchNameOf(bid), hours, rate: bk.hourly_rate || 0 });
    }
    return out;
  };
  // Show the breakdown only when it adds info: worked at >1 branch, or a single
  // branch whose rate differs from the employee's standard rate.
  const breakdownIsInformative = (r, lines) =>
    lines.length > 1 || (lines.length === 1 && lines[0].rate !== (r.breakdown?.rates?.hourly_rate || lines[0].rate));
  const breakdownText = (lines) => lines.map(o => `${o.name}: ${o.hours}ש׳ × ₪${o.rate}`).join(' | ');

  /* Build the full export matrix (header + one row per employee) with every
     column including notes. Reused by CSV / Excel / PDF exports. */
  const buildExportMatrix = () => {
    const cols = ['ימי עבודה', 'שעות רגילות', 'שע"נ א\'', 'שע"נ ב\'', 'שכר שעתי', 'שכר תקן', 'שע"נ תקן', 'שעות התחייבות'];
    const headerTop = ['סניף', 'שם העובד', 'ת"ז', ...cols,
      'שכר בסיס', 'השלמת שכר', 'תוספת שכר',
      'נסיעות', 'מחלה', 'היעדרות', 'חופשה', 'דמי חגים', 'קיזוז מקדמה', 'GIFT CARD', 'הבראה', 'סיבוס', 'מילואים', 'הלוואות', 'שכר משוער'];
    for (const c of customColumns) headerTop.push(c.label);
    headerTop.push('פירוט שעות לפי סניף');
    headerTop.push('הערות');
    const rowsAcc = [headerTop];

    for (const r of data.rows) {
      const cells = [r.branch_name, r.full_name, r.israeli_id || ''];
      const bk = r.breakdown.per_branch?.[r.branch_id];
      if (bk) {
        cells.push(bk.days_worked, bk.regular_hours, bk.ot_125_hours, bk.ot_150_hours, bk.hourly_rate || '', bk.global_salary || '', bk.global_ot_rate || '');
      } else {
        cells.push(r.breakdown.hours.days_worked, r.breakdown.hours.regular, r.breakdown.hours.ot_125, r.breakdown.hours.ot_150,
          r.breakdown.rates?.hourly_rate || '', r.breakdown.rates?.global_salary || '', r.breakdown.rates?.global_ot_rate || '');
      }
      cells.push(r.commitment?.committed_hours ?? '');
      const tb = r.breakdown?.components?.teken_breakdown;
      const completionEffective = (r.manual.include_salary_completion !== false) ? (tb?.completion || 0) : 0;
      cells.push(
        r.salary_type === 'global' && tb ? Math.round(tb.base_part) : '',
        r.salary_type === 'global' && tb ? Math.round(completionEffective) : '',
        r.salary_type === 'global' && tb ? Math.round(tb.ot_part) : '',
        computeTravel(r),
        r.manual.sick_days || '', r.manual.absence_days || '', r.manual.vacation_days || '', r.manual.holiday_pay || '',
        r.manual.advance_deduction_preset?.label || r.manual.advance_deduction_text || '',
        r.manual.gift_card?.kind === 'number' ? r.manual.gift_card.amount : (r.manual.gift_card?.text || ''),
        r.manual.recreation?.kind === 'number' ? r.manual.recreation.amount : (r.manual.recreation?.text || ''),
        r.manual.cibus?.kind === 'number' ? r.manual.cibus.amount : (r.manual.cibus?.text || ''),
        r.manual.miluim?.kind === 'number' ? r.manual.miluim.amount : (r.manual.miluim?.text || ''),
        r.loans_info?.month_deduction ? -Math.round(r.loans_info.month_deduction) : '',
        r.breakdown?.estimated_total != null ? Math.round(r.breakdown.estimated_total) : '',
      );
      for (const c of customColumns) {
        const v = r.manual.custom_values?.[c.id];
        if (!v || v.kind === 'empty') cells.push('');
        else if (v.kind === 'number') cells.push(v.amount);
        else cells.push(v.text);
      }
      const bLines = perBranchBreakdown(r);
      cells.push(breakdownIsInformative(r, bLines) ? breakdownText(bLines) : '');
      cells.push(r.manual.notes || '');
      rowsAcc.push(cells);
    }
    return rowsAcc;
  };

  const exportLabel = () => (viewMode === 'amuta'
    ? (data.amutot.find(x => x.id === selectedAmuta)?.name || 'amuta')
    : (selectedBranchName || (isAllBranches ? 'all-branches' : 'branch')));

  const downloadBlob = (blob, ext) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `payroll-${exportLabel()}-${month}.${ext}`; a.click();
    URL.revokeObjectURL(url);
  };

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const exportCSV = () => {
    if (!data) return;
    const m = buildExportMatrix();
    const csv = '﻿' + m.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'csv');
  };

  const exportExcel = () => {
    if (!data) return;
    const m = buildExportMatrix();
    const head = `<tr>${m[0].map(c => `<th style="background:#fde68a;border:1px solid #999;padding:4px;font-weight:bold">${esc(c)}</th>`).join('')}</tr>`;
    const body = m.slice(1).map(row => `<tr>${row.map(c => `<td style="border:1px solid #ccc;padding:3px;mso-number-format:'\\@'">${esc(c)}</td>`).join('')}</tr>`).join('');
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table dir="rtl" border="1">${head}${body}</table></body></html>`;
    downloadBlob(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8' }), 'xls');
  };

  const exportPDF = () => {
    if (!data) return;
    const m = buildExportMatrix();
    const head = `<tr>${m[0].map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
    const body = m.slice(1).map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
    const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>שכר ${esc(exportLabel())} ${month}</title>
      <style>
        body{font-family:Arial,'Heebo',sans-serif;direction:rtl;padding:12px}
        h1{font-size:16px;margin:0 0 8px}
        table{border-collapse:collapse;width:100%;font-size:7pt}
        th,td{border:1px solid #bbb;padding:2px 3px;text-align:center;white-space:nowrap}
        th{background:#fde68a}
        tr:nth-child(even) td{background:#f8fafc}
        @page{size:landscape;margin:8mm}
      </style></head><body>
      <h1>טבלת שכר — ${esc(exportLabel())} — ${month}</h1>
      <table>${head}${body}</table>
      <script>window.onload=()=>{window.print()}<\/script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast.error('חלון ההדפסה נחסם — אפשר חלונות קופצים'); return; }
    w.document.write(html); w.document.close();
  };

  /* ─── Render ────────────────────────────────────────────────────── */

  // Approx column widths so borders sit right
  const W = {
    name: 180,            // sticky right column
    amutaCell: 68,        // each of 7 cols per amuta/branch
    travel: 78,
    days: 60,
    advance: 180,
    money: 82,
    teken: 95,            // base / completion / OT addition (תקן breakdown)
    notes: 240,           // inline notes — readable without click
    custom: 110,
    adjust: 110,
  };

  // Group rows by branch_id so we can insert section headers instead of
  // repeating the branch name on every row.
  const rowsByBranch = useMemo(() => {
    if (!data?.rows) return [];
    const groups = new Map();
    for (const r of data.rows) {
      const key = r.branch_id || 'no-branch';
      if (!groups.has(key)) groups.set(key, { branch_id: key, branch_name: r.branch_name, rows: [] });
      groups.get(key).rows.push(r);
    }
    return [...groups.values()];
  }, [data]);

  return (
    <Box dir="rtl">
      {stagingMode && (
        <Box sx={{ mb: 1.5, p: 1.5, borderRadius: 3, bgcolor: 'info.50', border: '1px solid', borderColor: 'info.light' }}>
          <Typography variant="body2" sx={{ fontWeight: 700, color: 'info.dark' }}>
            ✏️ מצב עריכה לבקשת אישור — כל שינוי שתבצע יישלח להנה״ח לאישור
          </Typography>
          <Typography variant="caption" color="text.secondary">
            ערוך את התאים כרגיל. בסיום לחץ "שלח לאישור הנה״ח". השינויים ייכנסו לתוקף רק אחרי אישור.
          </Typography>
        </Box>
      )}
      {stagingMode && Object.keys(staged).length > 0 && (
        <Box sx={{
          position: 'sticky', top: 8, zIndex: 20, mb: 1.5, p: 1.5, borderRadius: 3,
          bgcolor: 'warning.light', border: '2px solid', borderColor: 'warning.main',
          display: 'flex', alignItems: 'center', gap: 2,
        }}>
          <Typography variant="body2" sx={{ fontWeight: 800, flex: 1 }}>
            {Object.keys(staged).length} שינויים ממתינים לשליחה
          </Typography>
          <Button size="small" color="inherit" onClick={discardStaged}>בטל הכל</Button>
          <Button
            size="small" variant="contained" color="primary"
            onClick={submitChangeRequest} disabled={submittingReq}
          >
            {submittingReq ? 'שולח…' : 'שלח לאישור הנה״ח'}
          </Button>
        </Box>
      )}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 1.5, mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <TextField type="month" size="small" label="חודש" value={month} onChange={e => setMonth(e.target.value)} sx={{ width: 160 }} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="חיפוש עובד" placeholder="שם העובד" value={empSearch}
            onChange={e => setEmpSearch(e.target.value)} sx={{ width: 200 }} />
          {/* Scope is the global branch picker — show as a read-only chip so
              the current view is obvious. Removed the amuta/branch toggle:
              rows are always grouped by branch via section headers, so the
              extra dimension was just confusing. */}
          <Chip
            size="small"
            color={isAllBranches ? 'primary' : 'default'}
            variant={isAllBranches ? 'filled' : 'outlined'}
            label={isAllBranches ? 'כל הסניפים' : (selectedBranchName || 'סניף נבחר')}
            sx={{ fontWeight: 600 }}
          />
          {isAllBranches && rowsByBranch.length > 1 && (
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <Select
                multiple
                displayEmpty
                value={ganFilter}
                onChange={(e) => setGanFilter(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                renderValue={(sel) => {
                  if (!sel.length) return <Typography variant="body2" color="text.secondary">סינון גנים: הכל</Typography>;
                  return (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4 }}>
                      {sel.map(id => {
                        const g = rowsByBranch.find(x => x.branch_id === id);
                        const mk = ganMarker(g?.branch_name);
                        return <Chip key={id} size="small" label={g?.branch_name || id}
                          sx={{ height: 20, fontSize: '0.7rem', bgcolor: mk?.strip, color: mk?.stripText, fontWeight: 700 }} />;
                      })}
                    </Box>
                  );
                }}
              >
                {rowsByBranch.map(g => {
                  const mk = ganMarker(g.branch_name);
                  return (
                    <MenuItem key={g.branch_id} value={g.branch_id} sx={{ py: 0.5 }}>
                      <Checkbox size="small" checked={ganFilter.includes(g.branch_id)} />
                      <Box sx={{ width: 12, height: 12, borderRadius: '3px', bgcolor: mk?.strip || 'grey.400', mr: 1, ml: 0.5, flexShrink: 0 }} />
                      <Typography variant="body2">{g.branch_name} <Box component="span" sx={{ color: 'text.disabled', fontSize: '0.72rem' }}>• {g.rows.length}</Box></Typography>
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
          )}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {data ? `${data.rows.length} עובדים • ${Math.round(data.totals.hours || 0)} שעות` : ''}
          </Typography>
          <Button startIcon={<AddCircleOutlineIcon />} size="small" onClick={() => setAddCol(true)} variant="outlined" disabled={stagingMode}>הוסף עמודה</Button>
          <Button startIcon={<RestaurantMenuIcon />} size="small" onClick={() => setCibusDlg(true)} variant="outlined" color="success" disabled={stagingMode}>ייבוא סיבוס</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyAutoHolidays} variant="outlined" color="warning" disabled={stagingMode}>החל דמי חגים</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyKindergartenVacation} variant="outlined" color="primary" disabled={stagingMode}>חופשה מלוח</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyVacationRequests} variant="outlined" color="info" disabled={stagingMode}>סנכרן בקשות</Button>
          <Tooltip title="רענן"><IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton></Tooltip>
          <Button size="small" variant="outlined" color="success" startIcon={<DownloadIcon />} onClick={exportExcel} disabled={!data}>אקסל</Button>
          <Button size="small" variant="outlined" color="error" startIcon={<DownloadIcon />} onClick={exportPDF} disabled={!data}>PDF</Button>
          <Tooltip title="ייצוא CSV"><IconButton onClick={exportCSV} disabled={!data}><DownloadIcon /></IconButton></Tooltip>
          {isFinalized
            ? <Button startIcon={<LockOpenIcon />} onClick={reopen} color="warning" variant="outlined" size="small" disabled={stagingMode}>פתח לעריכה</Button>
            : <Button startIcon={<LockIcon />} onClick={finalize} color="primary" variant="outlined" size="small" disabled={stagingMode}>נעל חודש</Button>}
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ borderRadius: 3, maxHeight: 'calc(100vh - 240px)', overflowX: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
        <Table size="small" stickyHeader sx={{
          tableLayout: 'fixed',
          minWidth: 1100,
          '& td, & th': { fontSize: '0.78rem', borderBottom: '1px solid', borderColor: 'divider', boxSizing: 'border-box', padding: '4px 6px' },
          '& td.auto': { bgcolor: 'grey.50', color: 'text.secondary' },
          '& .ag-divider': { borderLeft: '2px solid', borderColor: 'divider' },
          '& tbody tr:nth-of-type(even) td': { bgcolor: 'rgba(0,0,0,0.015)' },
          '& tbody tr:nth-of-type(even) td.auto': { bgcolor: 'rgba(0,0,0,0.035)' },
          '& tbody tr:hover td': { bgcolor: 'rgba(99,102,241,0.06) !important' },
        }}>
          <colgroup>
            <col style={{ width: W.name }} />
            {/* 8-col hours block: ימי עבודה + 6 hours/rate cols + שעות התחייבות */}
            <col style={{ width: W.days }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            {/* תקן breakdown — 3 new columns: base / completion / OT addition */}
            <col style={{ width: W.teken }} />
            <col style={{ width: W.teken }} />
            <col style={{ width: W.teken }} />
            <col style={{ width: W.travel }} />
            <col style={{ width: W.days }} />
            <col style={{ width: W.days }} />
            <col style={{ width: W.days }} />
            <col style={{ width: W.days }} />
            <col style={{ width: W.advance }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            {customColumns.map(c => <col key={`cc-${c.id}`} style={{ width: W.custom }} />)}
            <col style={{ width: W.adjust }} />
            <col style={{ width: W.notes }} />
          </colgroup>

          <TableHead>
            <TableRow>
              <TableCell rowSpan={2} sx={{
                fontWeight: 800, bgcolor: 'background.paper',
                position: 'sticky', right: 0, zIndex: 4,
                borderLeft: '2px solid', borderColor: 'divider',
              }} className="ag-divider">שם העובד</TableCell>
              <TableCell colSpan={8} align="center" sx={{
                fontWeight: 800, bgcolor: 'primary.50', color: 'primary.dark',
                letterSpacing: 0.2,
              }}>שעות עבודה</TableCell>
              <TableCell colSpan={14 + customColumns.length + 2} align="center" sx={{ fontWeight: 800, bgcolor: 'warning.50' }} className="ag-divider">
                נתונים חודשיים
              </TableCell>
            </TableRow>
            <TableRow>
              <SubHeaderGroup color={{ sub: '#eff6ff', accent: '#1e40af', border: '#93c5fd' }} />
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#e0f2fe' }}>שכר בסיס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#fef9c3' }}>השלמת שכר</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#dcfce7' }}>תוספת שכר</TableCell>
              <TableCell align="center" className="auto ag-divider" sx={{ fontWeight: 700 }}>נסיעות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מחלה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>היעדרות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>חופשה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>דמי חגים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>קיזוז מקדמה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>GIFT CARD</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הבראה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>סיבוס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מילואים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: 'error.50' }}>הלוואות</TableCell>
              {customColumns.map(c => (
                <TableCell key={c.id} align="center" sx={{ fontWeight: 700, position: 'relative', '&:hover .col-del': { opacity: 1 } }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.3 }}>
                    <span>{c.label}</span>
                    <Chip
                      label={c.kind === 'number' ? '#' : c.kind === 'text' ? 'א' : '#/א'}
                      size="small" sx={{ height: 14, fontSize: '0.6rem' }}
                    />
                  </Box>
                  <IconButton
                    size="small" className="col-del"
                    sx={{ position: 'absolute', top: 0, left: 0, opacity: 0, padding: '2px' }}
                    onClick={() => removeColumn(c.id)}
                  ><DeleteOutlineIcon sx={{ fontSize: 14 }} /></IconButton>
                </TableCell>
              ))}
              <TableCell align="center" sx={{ fontWeight: 700 }}>עדכוני שכר</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>

          <TableBody>
            {(() => {
              const totalCols = 1 + 8 + 16 + customColumns.length;
              if (loading) {
                return (<TableRow><TableCell colSpan={totalCols} align="center" sx={{ py: 4 }}><CircularProgress size={28} /></TableCell></TableRow>);
              }
              if (data && data.rows.length === 0) {
                return (<TableRow><TableCell colSpan={totalCols} align="center" sx={{ py: 6, color: 'text.disabled' }}>
                  אין עובדים פעילים בתחום הנבחר. נסה לבחור "כל הסניפים" בראש הדף או חודש אחר.
                </TableCell></TableRow>);
              }
              if (!data) {
                return (<TableRow><TableCell colSpan={totalCols} align="center" sx={{ py: 6, color: 'text.disabled' }}>
                  לא ניתן לטעון את הנתונים. נסה לרענן.
                </TableCell></TableRow>);
              }
              const elements = [];
              const visibleGroups = (isAllBranches && ganFilter.length)
                ? rowsByBranch.filter(g => ganFilter.includes(g.branch_id))
                : rowsByBranch;
              if (visibleGroups.length === 0) {
                return (<TableRow><TableCell colSpan={totalCols} align="center" sx={{ py: 5, color: 'text.disabled' }}>
                  לא נבחרו גנים להצגה. בחר גנים מהסינון למעלה.
                </TableCell></TableRow>);
              }
              const q = empSearch.trim().toLowerCase();
              for (const group of visibleGroups) {
                const rows = q
                  ? group.rows.filter(r => (r.full_name || '').toLowerCase().includes(q))
                  : group.rows;
                if (rows.length === 0) continue; // hide branches with no match while searching
                // Branch section header — wider strip than any data row so it's obvious where the group begins.
                const marker = ganMarker(group.branch_name);
                const branchInfo = data.branches_in_view?.find(b => b.id === group.branch_id);
                const color = branchInfo ? branchColor(branchInfo.color_index || 0) : null;
                // Vivid marker strip when the gan is recognised; otherwise fall
                // back to the soft positional palette.
                const stripBg = marker?.strip || color?.header || 'grey.200';
                const stripText = marker?.stripText || color?.accent || 'text.primary';
                const stripBorder = marker?.accent || color?.border || 'divider';
                const stripCell = {
                  bgcolor: stripBg,
                  color: stripText,
                  fontWeight: 800,
                  fontSize: '0.9rem',
                  py: 1,
                  borderTop: '4px solid',
                  borderBottom: '2px solid',
                  borderColor: stripBorder,
                };
                elements.push(
                  <TableRow key={`grp-${group.branch_id}`}>
                    {/* Sticky name-column segment so the colour strip lines up
                        exactly under the frozen "שם העובד" column. */}
                    <TableCell sx={{
                      ...stripCell,
                      position: 'sticky', right: 0, zIndex: 3,
                      borderLeft: '2px solid', borderLeftColor: stripBorder,
                      whiteSpace: 'nowrap',
                    }}>
                      🏠 {group.branch_name}
                    </TableCell>
                    <TableCell colSpan={totalCols - 1} sx={stripCell}>
                      <Box component="span" sx={{ opacity: 0.9, fontWeight: 700, fontSize: '0.75rem' }}>{rows.length} עובדים</Box>
                    </TableCell>
                  </TableRow>
                );
                for (const r of rows) {
                  const locked = r.status === 'finalized';
                  elements.push(
                    <TableRow key={r.employee_id} sx={marker ? { backgroundColor: marker.rowTint } : undefined}>
                      <TableCell sx={{
                        fontWeight: 700, position: 'sticky', right: 0, zIndex: 1,
                        bgcolor: marker?.nameTint || 'background.paper',
                        borderLeft: marker ? '3px solid' : '2px solid',
                        borderColor: marker?.accent || 'divider',
                      }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Box sx={{ flex: 1, lineHeight: 1.2 }}>
                            <Box
                              component="span"
                              onClick={() => setEmpDetail({ open: true, employeeId: r.employee_id })}
                              sx={{
                                cursor: 'pointer',
                                color: 'primary.main',
                                textDecoration: 'underline',
                                textDecorationStyle: 'dotted',
                                textUnderlineOffset: 3,
                                '&:hover': { color: 'primary.dark', textDecorationStyle: 'solid' },
                              }}
                            >
                              {r.full_name}
                            </Box>
                            {r.israeli_id && (
                              <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled', fontSize: '0.65rem' }}>
                                {r.israeli_id}
                              </Typography>
                            )}
                            {(() => {
                              // Show a chip if this employee also has hours at a
                              // branch other than the section's branch.
                              const pb = r.breakdown.per_branch || {};
                              const otherBranches = Object.entries(pb)
                                .filter(([id, bk]) => id !== r.branch_id && (bk?.regular_hours || 0) + (bk?.ot_125_hours || 0) + (bk?.ot_150_hours || 0) > 0);
                              if (otherBranches.length === 0) return null;
                              const totalOther = otherBranches.reduce((a, [, bk]) => a + (bk.regular_hours || 0) + (bk.ot_125_hours || 0) + (bk.ot_150_hours || 0), 0);
                              // Full per-branch hours×rate breakdown for the tooltip.
                              const lines = perBranchBreakdown(r);
                              return (
                                <Tooltip arrow title={
                                  <Box sx={{ fontSize: '0.72rem' }}>
                                    <b>פירוט שעות לפי סניף</b>
                                    {lines.map((o, i) => (
                                      <div key={i}>{o.name}: {o.hours}ש׳ × ₪{o.rate}</div>
                                    ))}
                                  </Box>
                                }>
                                  <Chip
                                    size="small" color="secondary" variant="outlined"
                                    label={`+${Math.round(totalOther * 10) / 10}h בסניף אחר`}
                                    sx={{ height: 16, fontSize: '0.6rem', mt: 0.3, cursor: 'help' }}
                                  />
                                </Tooltip>
                              );
                            })()}
                          </Box>
                          {locked && <Chip size="small" label="נעול" sx={{ height: 18, fontSize: '0.62rem' }} />}
                        </Box>
                      </TableCell>

                      {(() => {
                        // Hour block uses the home-branch bucket. Cross-branch
                        // hours show in a chip in the name cell (see above).
                        const bk = r.breakdown.per_branch?.[r.branch_id] || r.breakdown.per_branch?.[group.branch_id];
                        const totalBk = bk || {
                          days_worked: r.breakdown.hours.days_worked,
                          regular_hours: r.breakdown.hours.regular,
                          ot_125_hours: r.breakdown.hours.ot_125,
                          ot_150_hours: r.breakdown.hours.ot_150,
                          hourly_rate: r.breakdown.rates?.hourly_rate || 0,
                          global_salary: r.breakdown.rates?.global_salary || 0,
                          global_ot_rate: r.breakdown.rates?.global_ot_rate || 0,
                        };
                        return <BranchGroupCells bk={totalBk} salaryType={r.salary_type} color={{ cell: 'rgba(99,102,241,0.04)', border: '#93c5fd' }} />;
                      })()}

                      {/* שעות התחייבות — contracted hours this month from the schedule */}
                      <TableCell align="center" sx={{ fontWeight: 600, borderLeft: '3px solid', borderColor: '#93c5fd' }}>
                        {r.commitment?.committed_hours != null ? `${r.commitment.committed_hours}h` : '—'}
                      </TableCell>

                      {/* תקן breakdown — base / completion (with toggle) / OT addition */}
                      <TableCell align="center" sx={{ bgcolor: '#f0f9ff' }}>
                        <TekenBasePartCell row={r}
                          onOpenHours={() => setEmpDetail({ open: true, employeeId: r.employee_id, initialTab: 1 })}
                        />
                      </TableCell>
                      <TableCell align="center" sx={{ bgcolor: '#fefce8' }}>
                        <TekenCompletionCell row={r} disabled={locked}
                          onToggle={(v) => patchManual(r.employee_id, { include_salary_completion: v })}
                        />
                      </TableCell>
                      <TableCell align="center" sx={{ bgcolor: '#f0fdf4' }}>
                        <TekenOtCell row={r} />
                      </TableCell>

                      <TableCell align="center" className="auto ag-divider" sx={{ fontWeight: 700 }}>{fmtCurrency(computeTravel(r)) || '—'}</TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important' }} onClick={() => setSick({ open: true, row: r })}>
                        {Number(r.manual.sick_days) ? (
                          <Chip size="small" label={Number(r.manual.sick_days)} color="error" />
                        ) : (
                          <Typography variant="body2" color="text.secondary">—</Typography>
                        )}
                      </TableCell>
                      <TableCell align="center" sx={{ position: 'relative' }}>
                        <NumberCell value={r.manual.absence_days} disabled={locked} onSave={v => patchManual(r.employee_id, { absence_days: v })} />
                        {/* Show the auto-detected absences from commitment vs punches
                            as a small chip when the admin hasn't entered a manual value. */}
                        {(!r.manual.absence_days || r.manual.absence_days === 0) && r.commitment?.net_absent > 0 && (
                          <Tooltip title={
                            <Box sx={{ fontSize: '0.8rem' }}>
                              <Box sx={{ fontWeight: 700 }}>{r.commitment.net_absent} ימי היעדרות אוטומטיים</Box>
                              <Box>חסרה ב: {r.commitment.absent_days.join(', ') || '—'}</Box>
                              {r.commitment.off_day_workdays.length > 0 && (
                                <Box>עבדה בחופש: {r.commitment.off_day_workdays.join(', ')} (קוזז)</Box>
                              )}
                              <Box sx={{ mt: 0.5, opacity: 0.7, fontSize: '0.7rem' }}>לחץ לעריכה ידנית</Box>
                            </Box>
                          }>
                            <Chip
                              size="small" color="warning" variant="outlined"
                              label={`auto: ${r.commitment.net_absent}`}
                              onClick={() => patchManual(r.employee_id, { absence_days: r.commitment.net_absent })}
                              sx={{ height: 14, fontSize: '0.6rem', mt: 0.3, cursor: 'pointer' }}
                            />
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important' }} onClick={() => setVacation({ open: true, row: r })}>
                        <VacationCell row={r} />
                      </TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important' }} onClick={() => setHolidayPay({ open: true, row: r })}>
                        <HolidayPayCell row={r} />
                      </TableCell>
                      <TableCell>
                        <AdvanceDeductionCell
                          row={r} presets={presets} disabled={locked}
                          onSavePresetId={(id) => patchManual(r.employee_id, { advance_deduction_preset_id: id, advance_deduction_text: id ? '' : r.manual.advance_deduction_text })}
                          onSaveText={(text) => patchManual(r.employee_id, { advance_deduction_text: text, advance_deduction_preset_id: null })}
                          onCreatePreset={createPresetAndUse}
                        />
                      </TableCell>
                      <TableCell align="center"><NumberOrTextCell value={r.manual.gift_card}  disabled={locked} onSave={v => patchManual(r.employee_id, { gift_card: v })} /></TableCell>
                      <TableCell align="center"><NumberOrTextCell value={r.manual.recreation} disabled={locked} onSave={v => patchManual(r.employee_id, { recreation: v })} /></TableCell>
                      <TableCell align="center"><NumberOrTextCell value={r.manual.cibus}      disabled={locked} onSave={v => patchManual(r.employee_id, { cibus: v })} /></TableCell>
                      <TableCell align="center"><NumberOrTextCell value={r.manual.miluim}     disabled={locked} onSave={v => patchManual(r.employee_id, { miluim: v })} /></TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', bgcolor: 'error.50' }} onClick={() => setLoansDlg({ open: true, row: r })}>
                        <LoansSummaryCell row={r} />
                      </TableCell>
                      {customColumns.map(c => (
                        <TableCell key={c.id} align="center">
                          <CustomCell column={c} value={r.manual.custom_values?.[c.id]} disabled={locked} onSave={v => patchCustomValue(r.employee_id, c.id, v)} />
                        </TableCell>
                      ))}
                      <TableCell align="center" sx={{ minWidth: 100 }}>
                        <AdjustmentSummary row={r} onOpen={() => setAdjustments({ open: true, row: r })} disabled={locked} />
                      </TableCell>
                      <TableCell
                        onClick={() => setNotes({ open: true, row: r })}
                        sx={{
                          cursor: 'pointer',
                          verticalAlign: 'top',
                          padding: '6px 8px !important',
                          fontSize: '0.72rem',
                          lineHeight: 1.35,
                          color: r.manual.notes ? 'text.primary' : 'text.disabled',
                          whiteSpace: 'pre-wrap',
                          overflow: 'hidden',
                          maxHeight: 140,
                          textOverflow: 'ellipsis',
                          bgcolor: r.manual.notes ? 'rgba(254, 252, 232, 0.55)' : undefined,
                          '&:hover': { bgcolor: 'rgba(254, 252, 232, 0.85)' },
                        }}
                      >
                        {r.manual.notes
                          ? r.manual.notes
                          : <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.disabled' }}>
                              <NoteAltIcon sx={{ fontSize: 14 }} /> הוסף הערה
                            </Box>}
                      </TableCell>
                    </TableRow>
                  );
                }
              }
              return elements;
            })()}
          </TableBody>
        </Table>
      </TableContainer>

      <NotesDialog open={notes.open} row={notes.row} onClose={() => setNotes({ open: false, row: null })}
        onSave={(text) => notes.row && patchManual(notes.row.employee_id, { notes: text })} />
      <AddColumnDialog open={addCol} month={month} onClose={() => setAddCol(false)} onCreated={() => fetchData()} />
      <SalaryAdjustmentDialog
        open={adjustments.open}
        row={adjustments.row}
        month={month}
        onClose={() => setAdjustments({ open: false, row: null })}
        onChanged={fetchData}
      />
      <VacationDetailDialog
        open={vacation.open}
        row={vacation.row}
        month={month}
        onClose={() => setVacation({ open: false, row: null })}
        onSaved={fetchData}
      />
      <SickDetailDialog
        open={sick.open}
        row={sick.row}
        month={month}
        onClose={() => setSick({ open: false, row: null })}
        onSaved={fetchData}
      />
      <HolidayPayDetailDialog
        open={holidayPay.open}
        row={holidayPay.row}
        month={month}
        onClose={() => setHolidayPay({ open: false, row: null })}
        onSaved={fetchData}
      />
      <LoansDialog
        open={loansDlg.open}
        row={loansDlg.row}
        month={month}
        onClose={() => setLoansDlg({ open: false, row: null })}
        onSaved={fetchData}
      />
      <CibusImportDialog
        open={cibusDlg}
        month={month}
        onClose={() => setCibusDlg(false)}
        onImported={fetchData}
      />
      <EmployeeDetailDialog
        open={empDetail.open}
        employeeId={empDetail.employeeId}
        initialMonth={month}
        initialTab={empDetail.initialTab || 0}
        onClose={() => setEmpDetail({ open: false, employeeId: null, initialTab: 0 })}
        onChanged={fetchData}
      />
    </Box>
  );
}

function VacationCell({ row }) {
  const manualVal = Number(row.manual.vacation_days) || 0;
  const auto = row.vacation_days_auto?.total_days || 0;
  const balance = row.vacation_info?.balance_from_payslip;
  const remaining = balance != null ? Math.round((balance - manualVal) * 10) / 10 : null;
  const isGlobal = row.salary_type === 'global';

  if (manualVal > 0) {
    return (
      <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
        <Typography variant="body2" sx={{ fontWeight: 800, fontSize: '0.85rem', color: 'primary.dark' }}>
          {manualVal}
        </Typography>
        {isGlobal && (
          <Typography variant="caption" sx={{ fontSize: '0.58rem', color: 'text.disabled' }}>
            ללא תשלום
          </Typography>
        )}
        {balance != null && (
          <Typography variant="caption" sx={{ fontSize: '0.6rem', color: remaining < 0 ? 'error.main' : 'text.disabled' }}>
            יתרה: {remaining}/{balance}
          </Typography>
        )}
      </Stack>
    );
  }
  if (auto > 0) {
    return (
      <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
        <Tooltip title={`${auto} ימי חופשה מלוח חופשות הגן. לחץ על התא לפירוט ולאישור.`}>
          <Chip
            size="small" color="warning" variant="outlined"
            label={`לוח: ${auto}`}
            sx={{ height: 18, fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', pointerEvents: 'none' }}
          />
        </Tooltip>
        {isGlobal && (
          <Typography variant="caption" sx={{ fontSize: '0.58rem', color: 'text.disabled' }}>
            ללא תשלום
          </Typography>
        )}
        {balance != null && (
          <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
            יתרה: {balance}
          </Typography>
        )}
      </Stack>
    );
  }
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
      <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>
      {balance != null && (
        <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
          יתרה: {balance}
        </Typography>
      )}
    </Stack>
  );
}

function TekenBasePartCell({ row, onOpenHours }) {
  const tb = row.breakdown?.components?.teken_breakdown;
  const baseSalary = row.breakdown?.components?.base_salary || 0;
  const incomplete = row.breakdown?.hours?.incomplete_days || 0;
  const noHours = (row.breakdown?.hours?.total || 0) === 0;

  // Render value: תקן uses base_part, hourly uses computed base_salary
  let mainValue = 0;
  let perHourLabel = null;
  if (row.salary_type === 'global' && tb) {
    mainValue = tb.base_part;
    perHourLabel = `ערך/שעה: ${tb.hourly_value}`;
  } else if (row.salary_type === 'hourly') {
    mainValue = baseSalary;
    const rate = row.breakdown?.rates?.hourly_rate;
    if (rate) perHourLabel = `${rate} ₪/שעה`;
  } else {
    return <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>;
  }

  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      {mainValue > 0 ? (
        <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.82rem' }}>
          {Math.round(mainValue).toLocaleString('he-IL')} ₪
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>
      )}
      {perHourLabel && (
        <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
          {perHourLabel}
        </Typography>
      )}
      {incomplete > 0 && (
        <Tooltip title={`${incomplete} ימים עם החתמה חסרה — לחץ להשלמה`}>
          <Chip
            size="small" color="error" variant="filled"
            label={`${incomplete} חסר`}
            onClick={(e) => { e.stopPropagation(); onOpenHours && onOpenHours(); }}
            sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700, cursor: 'pointer' }}
          />
        </Tooltip>
      )}
      {!incomplete && noHours && row.salary_type === 'hourly' && (
        <Chip
          size="small" color="warning" variant="outlined"
          label="אין החתמות"
          sx={{ height: 14, fontSize: '0.58rem' }}
        />
      )}
    </Stack>
  );
}

function TekenCompletionCell({ row, disabled, onToggle }) {
  const tb = row.breakdown?.components?.teken_breakdown;
  if (row.salary_type !== 'global' || !tb) {
    return <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>;
  }
  const enabled = row.manual.include_salary_completion !== false;
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      <Typography
        variant="body2"
        sx={{ fontWeight: 700, fontSize: '0.82rem', color: enabled ? 'warning.dark' : 'text.disabled', textDecoration: enabled ? 'none' : 'line-through' }}
      >
        {enabled ? `${Math.round(tb.completion).toLocaleString('he-IL')} ₪` : '0 ₪'}
      </Typography>
      <Tooltip title={enabled ? 'בטל השלמת שכר אוטומטית' : 'הפעל השלמת שכר אוטומטית'}>
        <Chip
          size="small"
          color={enabled ? 'success' : 'default'}
          variant={enabled ? 'filled' : 'outlined'}
          label={enabled ? 'פעיל' : 'מבוטל'}
          disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onToggle(!enabled); }}
          sx={{ height: 16, fontSize: '0.6rem', cursor: 'pointer' }}
        />
      </Tooltip>
    </Stack>
  );
}

function TekenOtCell({ row }) {
  const tb = row.breakdown?.components?.teken_breakdown;
  if (row.salary_type !== 'global' || !tb || !tb.ot_part) {
    return <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>;
  }
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.82rem', color: 'success.dark' }}>
        +{Math.round(tb.ot_part).toLocaleString('he-IL')} ₪
      </Typography>
      <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
        שע״נ × ערך/שעה
      </Typography>
    </Stack>
  );
}

function HolidayPayCell({ row }) {
  const auto = row.holiday_pay_auto || { total_days: 0, total_pay: 0, is_eligible: false };
  const manualVal = Number(row.manual.holiday_pay) || 0;
  // If manager entered a manual amount, show it bold; otherwise show eligibility status.
  if (manualVal > 0) {
    return (
      <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
        <Typography variant="body2" sx={{ fontWeight: 800, fontSize: '0.85rem', color: 'success.dark' }}>
          {manualVal.toLocaleString('he-IL')} ₪
        </Typography>
        {auto.is_eligible && (
          <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
            {auto.total_days} ימים
          </Typography>
        )}
      </Stack>
    );
  }
  if (auto.is_eligible) {
    return (
      <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
        <Chip
          size="small" color="success" variant="filled"
          label={`זכאי ${auto.total_days}`}
          sx={{ height: 18, fontSize: '0.7rem', fontWeight: 700 }}
        />
        <Typography variant="caption" sx={{ fontSize: '0.62rem', color: 'success.dark' }}>
          {auto.total_pay} ₪
        </Typography>
      </Stack>
    );
  }
  return (
    <Chip
      size="small" color="default" variant="outlined"
      label="לא זכאי"
      sx={{ height: 18, fontSize: '0.7rem' }}
    />
  );
}

function LoansSummaryCell({ row }) {
  const info = row.loans_info || { count: 0, month_deduction: 0, loans: [] };
  if (info.count === 0 && info.loans.length === 0) {
    return <Box sx={{ color: 'text.disabled', fontSize: '0.78rem' }}>—</Box>;
  }
  const active = info.count;
  const monthDed = info.month_deduction;
  return (
    <Stack spacing={0.3} alignItems="center">
      {monthDed > 0 ? (
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'error.dark', fontSize: '0.78rem' }}>
          -{Math.round(monthDed).toLocaleString('he-IL')} ₪
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.disabled', fontSize: '0.78rem' }}>—</Typography>
      )}
      {active > 0 && (
        <Chip
          size="small" color="error" variant="outlined"
          label={`${active} פעיל${active > 1 ? 'ות' : 'ה'}`}
          sx={{ height: 14, fontSize: '0.6rem' }}
        />
      )}
    </Stack>
  );
}

function AdjustmentSummary({ row, onOpen, disabled }) {
  const totals = row.adj_totals || { money_add: 0, money_deduct: 0, hours_delta: 0 };
  const count = row.adjustments?.length || 0;
  const hasAny = totals.money_add !== 0 || totals.money_deduct !== 0 || totals.hours_delta !== 0;
  return (
    <Stack direction="row" spacing={0.3} alignItems="center" justifyContent="center" flexWrap="wrap" useFlexGap>
      {!hasAny ? (
        <IconButton size="small" onClick={onOpen} disabled={disabled} sx={{ opacity: 0.5 }}>
          <TuneIcon fontSize="small" />
        </IconButton>
      ) : (
        <>
          {totals.money_add > 0 && <Chip size="small" color="success" label={`+${Math.round(totals.money_add)}₪`} sx={{ height: 18, fontSize: '0.7rem' }} />}
          {totals.money_deduct > 0 && <Chip size="small" color="error" label={`-${Math.round(totals.money_deduct)}₪`} sx={{ height: 18, fontSize: '0.7rem' }} />}
          {totals.hours_delta !== 0 && <Chip size="small" color="warning" label={`${totals.hours_delta > 0 ? '+' : ''}${totals.hours_delta}h`} sx={{ height: 18, fontSize: '0.7rem' }} />}
          <IconButton size="small" onClick={onOpen} disabled={disabled}><TuneIcon fontSize="small" /></IconButton>
        </>
      )}
      {count > 0 && <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>{count}</Typography>}
    </Stack>
  );
}

function CustomCell({ column, value, onSave, disabled }) {
  if (column.kind === 'text') {
    return <TextCell value={value?.text || ''} disabled={disabled}
      onSave={txt => onSave(txt ? { kind: 'text', amount: null, text: txt } : { kind: 'empty', amount: null, text: '' })} />;
  }
  if (column.kind === 'number') {
    return <NumberCell value={value?.amount} disabled={disabled}
      onSave={n => onSave(n ? { kind: 'number', amount: n, text: '' } : { kind: 'empty', amount: null, text: '' })} />;
  }
  return <NumberOrTextCell value={value} disabled={disabled} onSave={onSave} />;
}

function SubHeaderGroup({ color }) {
  const cells = ['ימי עבודה', 'שעות רגילות', 'שע״נ א\'', 'שע״נ ב\'', 'שכר שעתי', 'שכר תקן', 'שע״נ תקן', 'שעות התחייבות'];
  const last = cells.length - 1;
  return (
    <>
      {cells.map((label, i) => (
        <TableCell
          key={i} align="center"
          sx={{
            fontWeight: 700, fontSize: '0.7rem', lineHeight: 1.1,
            bgcolor: color.sub, color: color.accent,
            borderLeft: i === last ? '3px solid' : undefined,
            borderColor: i === last ? color.border : undefined,
          }}
        >
          {label}
        </TableCell>
      ))}
    </>
  );
}

function BranchGroupCells({ bk, salaryType, color }) {
  const days  = bk?.days_worked || 0;
  const reg   = bk?.regular_hours || 0;
  const ot125 = bk?.ot_125_hours || 0;
  const ot150 = bk?.ot_150_hours || 0;
  const hourly = salaryType === 'hourly' ? (bk?.hourly_rate || 0) : 0;
  const global = salaryType === 'global' ? (bk?.global_salary || 0) : 0;
  const globalOt = salaryType === 'global' ? (bk?.global_ot_rate || 0) : 0;
  const cell = (v, opts = {}) => (
    <TableCell
      align="center"
      sx={{
        bgcolor: color.cell, color: 'text.secondary',
        borderLeft: opts.last ? '3px solid' : undefined,
        borderColor: opts.last ? color.border : undefined,
      }}
    >
      {v ? fmtNum(v) : <span style={{ opacity: 0.3 }}>—</span>}
    </TableCell>
  );
  return (<>
    {cell(days)}
    {cell(reg)}
    {cell(ot125)}
    {cell(ot150)}
    {cell(hourly)}
    {cell(global)}
    {cell(globalOt, { last: true })}
  </>);
}
