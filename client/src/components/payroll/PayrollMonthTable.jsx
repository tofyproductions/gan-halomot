import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box, Paper, Stack, Typography, TextField, Select, MenuItem, IconButton, Button,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Tooltip,
  Chip, Autocomplete, Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton, ToggleButtonGroup,
  CircularProgress, RadioGroup, FormControlLabel, Radio, Checkbox, FormControl, FormLabel,
  InputAdornment, Alert, Menu, Divider, ListItemText, Badge,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import NoteAltIcon from '@mui/icons-material/NoteAlt';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import SendIcon from '@mui/icons-material/Send';
import PrintIcon from '@mui/icons-material/Print';
import ContactMailIcon from '@mui/icons-material/ContactMail';
import NumbersIcon from '@mui/icons-material/Numbers';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import TuneIcon from '@mui/icons-material/Tune';
import RestaurantMenuIcon from '@mui/icons-material/RestaurantMenu';
import PaymentsIcon from '@mui/icons-material/Payments';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CelebrationIcon from '@mui/icons-material/Celebration';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import { toast } from 'react-toastify';
import * as XLSX from 'xlsx';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useWorkMonth } from '../../hooks/useWorkMonth';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import { ganMarkerByName as ganMarker } from '../../utils/branchColors';
import SalaryAdjustmentDialog from './SalaryAdjustmentDialog';
import VacationDetailDialog from './VacationDetailDialog';
import SickDetailDialog from './SickDetailDialog';
import ClosureCompletionDetailDialog from './ClosureCompletionDetailDialog';
import EmployeeDocsDialog from './EmployeeDocsDialog';
import PregnancyDetailDialog from './PregnancyDetailDialog';
import PunchReviewDialog from './PunchReviewDialog';
import PunchIssuesDialog from './PunchIssuesDialog';
import SpecialDaysDialog from './SpecialDaysDialog';
import CibusSyncDialog from './CibusSyncDialog';
import FixedSchedulesDialog from './FixedSchedulesDialog';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import ScheduleIcon from '@mui/icons-material/Schedule';
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
  closure_completion: 'בונוס אוגוסט',
  closure_completion_approved_dates: 'בונוס אוגוסט — ימים מאושרים',
  custom_values: 'עמודה מותאמת',
};

// A manager-requested value can be a number, free text, a boolean, or a
// {kind, amount, text} mixed field (gift_card/cibus etc.) — render it human.
function fmtReqValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  if (typeof v === 'object') {
    if ('kind' in v || 'amount' in v || 'text' in v) {
      if (v.kind === 'text') return v.text || '—';
      if (v.amount != null && v.amount !== '') return `₪${Number(v.amount).toLocaleString('he-IL')}`;
      return v.text || '—';
    }
    return JSON.stringify(v);
  }
  return String(v);
}

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
  // Use the value the salary engine actually paid (it already honours the
  // manager's manual override) so the displayed travel always equals what's paid.
  if (row.breakdown?.components?.travel != null) return row.breakdown.components.travel;
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

// The automatic travel amount, ignoring any manual override — shown so the
// accountant sees what would be paid if no value is entered.
function autoTravel(row) {
  const days = row.breakdown?.hours?.days_worked || 0;
  if (row.travel_mode === 'monthly_flat') return row.travel_monthly_flat || 0;
  const perDay = row.travel_per_day || 16;
  return Math.min(perDay * days, 315);
}
// True when accounting entered a specific travel amount (override wins) — either
// a standing per-employee amount (carries forward) or a one-month override.
function hasTravelOverride(row) {
  return (row.travel_override != null && row.travel_override !== '')
    || (row.manual?.travel_override != null && row.manual?.travel_override !== '');
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

function NotesDialog({ open, row, onClose, onSave, onSavePermanent }) {
  const [text, setText] = useState('');
  const [perm, setPerm] = useState('');
  useEffect(() => {
    if (row) { setText(row.manual.notes || ''); setPerm(row.permanent_note || ''); }
  }, [row]);
  if (!row) return null;
  const committed = row.commitment?.committed_hours;
  const h = row.breakdown?.hours || {};
  const worked = Math.round(((h.regular || 0) + (h.ot_125 || 0) + (h.ot_150 || 0)) * 10) / 10;
  const diff = committed != null ? Math.round((worked - committed) * 10) / 10 : null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>הערות — {row.full_name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {(committed != null || worked > 0) && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              {committed != null && <>📋 התחייבות שעות לחודש: <b>{committed}h</b>{'  •  '}</>}
              ⏱️ עבד בפועל: <b>{worked}h</b>
              {diff != null && (
                <span style={{ color: diff < 0 ? '#b91c1c' : '#15803d' }}>
                  {' '}({diff >= 0 ? '+' : ''}{diff}h)
                </span>
              )}
            </Alert>
          )}
          <TextField
            label="הערה קבועה (תופיע בכל חודש)" fullWidth multiline minRows={2}
            value={perm} onChange={e => setPerm(e.target.value)}
            placeholder="הערה שתישמר ותופיע גם בחודשים הבאים…"
          />
          <TextField
            label="הערה חד-פעמית (החודש בלבד)" fullWidth multiline minRows={3}
            value={text} onChange={e => setText(e.target.value)}
            placeholder="הערה שתיעלם בחודש הבא…"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => {
          if (perm !== (row.permanent_note || '')) onSavePermanent(perm);
          onSave(text);
          onClose();
        }}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

// Prompt for the reason when deactivating an employee.
function InactiveReasonDialog({ open, row, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(row?.inactive_reason || ''); }, [open, row]);
  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>סימון כלא פעיל — {row.full_name}</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2, mt: 1 }}>העובד יסומן כלא פעיל. הסיבה תוצג על שורת העובד.</Alert>
        <TextField
          label="סיבת חוסר הפעילות" fullWidth multiline minRows={2} autoFocus
          value={reason} onChange={e => setReason(e.target.value)}
          placeholder="לדוגמה: סיום העסקה / עזבה / חופשת לידה…"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" color="warning" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>
          סמן כלא פעיל
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Travel cell dialog — accounting enters the travel amount to pay. When set,
// that amount is paid (override); when cleared, the automatic calc is used.
function TravelDialog({ open, row, onClose, onSave, onClear, disabled }) {
  const [val, setVal] = useState('');
  useEffect(() => { if (open) setVal(row?.travel_override ?? row?.manual?.travel_override ?? ''); }, [open, row]);
  if (!row) return null;
  const auto = autoTravel(row);
  const isOverride = hasTravelOverride(row);
  const days = row.breakdown?.hours?.days_worked || 0;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>נסיעות — {row.full_name}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2, mt: 1 }}>
          סכום שמוזן נשמר לעובד ויחול <b>בכל חודש קדימה</b> — עד שינוי יזום. אם השדה ריק — ישולם החישוב האוטומטי.
        </Alert>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          חישוב אוטומטי: <b>{fmtCurrency(auto)}</b>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {row.travel_mode === 'monthly_flat'
              ? ' (סכום חודשי קבוע)'
              : ` (${row.travel_per_day || 16}₪ × ${days} ימים, מוגבל ל-315₪)`}
          </Box>
        </Typography>
        <TextField
          type="number" label="סכום נסיעות קבוע לעובד (₪)" fullWidth size="small" autoFocus
          value={val} onChange={e => setVal(e.target.value)} disabled={disabled}
          placeholder={`אוטומטי: ${auto}`} InputLabelProps={{ shrink: true }}
          helperText="נשמר לעובד ויחול בכל חודש. לחץ 'חזרה לאוטומטי' כדי לבטל."
        />
      </DialogContent>
      <DialogActions>
        {isOverride && <Button color="warning" onClick={onClear} disabled={disabled}>חזרה לחישוב אוטומטי</Button>}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" disabled={disabled || val === '' || isNaN(Number(val))} onClick={() => onSave(Number(val))}>
          שמור סכום ידני
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Employee number (payslip) — saved on the employee, shown every month + export.
function EmployeeNumberDialog({ open, row, onClose, onSave }) {
  const [val, setVal] = useState('');
  useEffect(() => { if (open) setVal(row?.employee_number || ''); }, [open, row]);
  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>מספר עובד — {row.full_name}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2, mt: 1 }}>
          המספר כפי שמופיע בתלוש. נשמר לעובד ומוצג כל חודש ובקבצים לרו״ח — כדי לאתר את העובד לפי מספרו.
        </Alert>
        <TextField
          label="מספר עובד (מהתלוש)" fullWidth size="small" autoFocus
          value={val} onChange={e => setVal(e.target.value)} InputLabelProps={{ shrink: true }}
          placeholder={`ת"ז: ${row.israeli_id || '—'}`}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => onSave(val)}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

// Bank details (sensitive — accounting/admin). Saved on the employee, carries forward.
function BankDialog({ open, row, onClose, onSave }) {
  const [num, setNum] = useState('');
  const [branch, setBranch] = useState('');
  const [acct, setAcct] = useState('');
  const [holder, setHolder] = useState('');
  const [pension, setPension] = useState('');
  const [edu, setEdu] = useState('');
  useEffect(() => {
    if (open) {
      setNum(row?.bank_number || ''); setBranch(row?.bank_branch || ''); setAcct(row?.bank_account || '');
      setHolder(row?.bank_account_holder || '');
      setPension(row?.pension_fund || ''); setEdu(row?.education_fund || '');
    }
  }, [open, row]);
  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>בנק וקופות — {row.full_name}</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2, mt: 1 }}>
          מידע רגיש לתשלום שכר. נשמר על כרטיס העובד ומוצג להנהלת חשבונות בלבד.
        </Alert>
        <Stack spacing={1.5}>
          <TextField label="בנק (קוד)" size="small" value={num} onChange={e => setNum(e.target.value)} InputLabelProps={{ shrink: true }} placeholder="לדוגמה 10" />
          <TextField label="סניף" size="small" value={branch} onChange={e => setBranch(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label="מספר חשבון" size="small" value={acct} onChange={e => setAcct(e.target.value)} InputLabelProps={{ shrink: true }} />
          {/* A minor is often paid into a parent's account. Leaving this blank
              means the account is her own — filling it tells the accountant the
              differing name on the transfer is deliberate, not a typo. */}
          <TextField
            label="בעל/ת החשבון (אם שונה מהעובד/ת)" size="small" value={holder}
            onChange={e => setHolder(e.target.value)} InputLabelProps={{ shrink: true }}
            placeholder="ריק = החשבון על שם העובד/ת"
            helperText={holder.trim() && holder.trim() !== (row.full_name || '').trim()
              ? 'ההעברה תבוצע לחשבון על שם אחר — יופיע בדוח לרו״ח'
              : ' '}
          />
          <Divider />
          <TextField label="קופת פנסיה" size="small" value={pension} onChange={e => setPension(e.target.value)} InputLabelProps={{ shrink: true }} placeholder="שם / מספר הקופה" />
          <TextField label="קרן השתלמות" size="small" value={edu} onChange={e => setEdu(e.target.value)} InputLabelProps={{ shrink: true }} placeholder="שם / מספר הקרן" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => onSave({ bank_number: num.trim(), bank_branch: branch.trim(), bank_account: acct.trim(), bank_account_holder: holder.trim(), pension_fund: pension.trim(), education_fund: edu.trim() })}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

// Bonus cell — shows the effective bonus (auto or manual override) with a
// tooltip breakdown. Click opens BonusDialog.
function BonusCell({ row }) {
  const b = row.bonus || {};
  const eff = b.effective || 0;
  const isManual = b.override_amount != null || b.disabled;
  if (!eff && !b.auto) {
    return <Typography variant="body2" color="text.disabled">—</Typography>;
  }
  return (
    <Tooltip arrow title={
      <Box sx={{ fontSize: '0.72rem' }}>
        {b.lines?.length
          ? b.lines.map((l, i) => <div key={i}>{l.reason || ('בונוס ' + l.branch_name)}: {l.hours}ש׳ × ₪{l.rate} = ₪{l.amount}</div>)
          : <div>אין בונוס אוטומטי</div>}
        {b.note && <div style={{ marginTop: 4, opacity: 0.85 }}>📝 {b.note}</div>}
        <div style={{ marginTop: 4, opacity: 0.7 }}>לחץ לעריכה</div>
      </Box>
    }>
      <Box sx={{ cursor: 'help' }}>
        <Typography variant="body2" sx={{ fontWeight: 700, color: eff ? '#15803d' : 'text.disabled' }}>
          {eff ? fmtCurrency(eff) : '₪0'}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled' }}>
          {b.disabled ? 'בוטל' : (isManual ? 'ידני' : 'אוטומטי')}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function BonusDialog({ open, row, onClose, onSave }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    if (row) {
      const b = row.bonus || {};
      setAmount(b.override_amount != null ? String(b.override_amount) : '');
      setNote(b.note || '');
      setDisabled(!!b.disabled);
    }
  }, [row]);
  if (!row) return null;
  const auto = row.bonus?.auto || 0;
  const autoNote = row.bonus?.auto_note || '';
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>בונוס — {row.full_name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info" sx={{ py: 0.5 }}>
            בונוס אוטומטי: <b>{auto ? fmtCurrency(auto) : '₪0'}</b>{autoNote ? ` — ${autoNote}` : ''}
          </Alert>
          <TextField
            label="סכום ידני (ריק = אוטומטי)" type="number" value={amount}
            onChange={e => setAmount(e.target.value)} disabled={disabled}
            InputProps={{ startAdornment: <InputAdornment position="start">₪</InputAdornment> }}
          />
          <TextField
            label="הערה / עבור מה הבונוס" value={note} multiline minRows={2}
            onChange={e => setNote(e.target.value)} placeholder={autoNote || 'תיאור הבונוס…'}
          />
          <FormControlLabel
            control={<Checkbox checked={disabled} onChange={e => setDisabled(e.target.checked)} />}
            label="בטל בונוס לחודש זה"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => {
          onSave({ override_amount: amount === '' ? null : Number(amount), note: note.trim(), disabled });
          onClose();
        }}>שמור</Button>
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

/* Blend an opaque hex colour toward white by `amt` (0–1), staying opaque. Used
 * to give the frozen name column a light, subtle zebra between rows while still
 * keeping each branch's hue. */
function lightenHex(hex, amt = 0.5) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const L = (c) => Math.min(255, Math.round(c + (255 - c) * amt));
  const r = L((n >> 16) & 255);
  const g = L((n >> 8) & 255);
  const b = L(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/* Manage the accountant recipient list + the office copy (cc) address. The
   monthly "send to accountant" goes to every address here, with the office
   always cc'd. */
function AccountantContactsDialog({ open, onClose }) {
  const [emails, setEmails] = useState([]);
  const [office, setOffice] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/payroll-month/accountant-contacts')
      .then(res => { setEmails(res.data.accountant_emails || []); setOffice(res.data.office_cc || ''); })
      .catch(() => toast.error('שגיאה בטעינת אנשי קשר'))
      .finally(() => setLoading(false));
  }, [open]);
  const addEmail = () => {
    const e = newEmail.trim();
    if (!e) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { toast.error('מייל לא תקין'); return; }
    if (!emails.includes(e)) setEmails(prev => [...prev, e]);
    setNewEmail('');
  };
  const removeEmail = (e) => setEmails(prev => prev.filter(x => x !== e));
  const save = () => {
    setSaving(true);
    api.put('/payroll-month/accountant-contacts', { accountant_emails: emails, office_cc: office.trim() })
      .then(() => { toast.success('נשמר'); onClose(); })
      .catch(() => toast.error('שגיאה בשמירה'))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>נמעני רואה חשבון</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            הטבלה החודשית תישלח לכל הכתובות הבאות. עותק נשלח תמיד למשרד.
          </Typography>
          <Stack spacing={1}>
            {!loading && emails.length === 0 && (
              <Typography variant="caption" color="text.disabled">אין כתובות — הוסף לפחות אחת.</Typography>
            )}
            {emails.map(e => (
              <Stack key={e} direction="row" spacing={1} alignItems="center">
                <Chip label={e} dir="ltr" sx={{ flex: 1, justifyContent: 'space-between', fontFamily: 'monospace' }} />
                <IconButton size="small" color="error" onClick={() => removeEmail(e)}><DeleteOutlineIcon fontSize="small" /></IconButton>
              </Stack>
            ))}
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField size="small" fullWidth label="הוסף מייל רו״ח" value={newEmail} dir="ltr"
              onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }} />
            <Button variant="outlined" onClick={addEmail}>הוסף</Button>
          </Stack>
          <Divider />
          <TextField size="small" fullWidth label="עותק למשרד (CC)" value={office} dir="ltr"
            onChange={e => setOffice(e.target.value)}
            helperText="כתובת זו מקבלת עותק מכל שליחה לרו״ח" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={saving || loading}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

/* Preview the accountant PDF before sending, and choose recipients per-send.
   Renders the same cards HTML the PDF is built from inside an iframe. */
function AccountantPreviewDialog({ open, month, branch, blocked, blockedCount, onClose, onManageContacts }) {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState({});
  const [extra, setExtra] = useState([]);
  const [newEmail, setNewEmail] = useState('');
  const iframeRef = useRef(null);

  // Find-an-employee inside the rendered report: the cards carry
  // data-emp-name, the iframe is same-origin (srcDoc), so we can scroll to and
  // flash a match instead of making the accountant wheel through 80 cards.
  // Repeating the search (Enter / the button) cycles through the matches.
  const [searchQ, setSearchQ] = useState('');
  const searchIdxRef = useRef(0);
  const searchEmployee = (q) => {
    const doc = iframeRef.current?.contentDocument;
    const query = (q ?? searchQ).trim();
    if (!doc || !query) return;
    const cards = [...doc.querySelectorAll('table[data-emp-name]')];
    cards.forEach(t => { t.style.outline = ''; });
    const matches = cards.filter(t => (t.getAttribute('data-emp-name') || '').includes(query));
    if (matches.length === 0) { toast.info(`לא נמצא עובד תואם ל"${query}"`); return; }
    const target = matches[searchIdxRef.current % matches.length];
    searchIdxRef.current += 1;
    target.style.outline = '4px solid #f59e0b';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (matches.length > 1) {
      toast.info(`${matches.length} התאמות — לחיצה נוספת תעבור לבאה`, { autoClose: 2500 });
    }
  };

  // Print the same cards HTML shown in the preview (the accountant report).
  const handlePrint = () => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
  };

  useEffect(() => {
    if (!open) return;
    setData(null); setExtra([]); setNewEmail('');
    setLoading(true);
    const params = {};
    if (branch) params.branch = branch;
    api.get(`/payroll-month/${month}/accountant-preview`, { params })
      .then(res => {
        setData(res.data);
        const sel = {}; (res.data.accountant_emails || []).forEach(e => { sel[e] = true; });
        setSelected(sel);
      })
      .catch(err => { toast.error(err.response?.data?.error || 'שגיאה בטעינת תצוגה מקדימה'); onClose(); })
      .finally(() => setLoading(false));
  }, [open, month, branch]);

  const chosen = [...Object.keys(selected).filter(e => selected[e]), ...extra];
  const addExtra = () => {
    const e = newEmail.trim();
    if (!e) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { toast.error('מייל לא תקין'); return; }
    if (!chosen.includes(e)) setExtra(prev => [...prev, e]);
    setNewEmail('');
  };
  const send = () => {
    if (chosen.length === 0) { toast.error('בחר לפחות נמען אחד'); return; }
    setSending(true);
    const params = {};
    if (branch) params.branch = branch;
    api.post(`/payroll-month/${month}/send-accountant`, { emails: chosen }, { params })
      .then(res => { toast.success(`השליחה יצאה ל-${res.data.sent_to}${res.data.cc ? ` (עותק: ${res.data.cc})` : ''} — הכרטיסים והמסמכים יגיעו תוך כמה דקות`, { autoClose: 6000 }); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בשליחה'))
      .finally(() => setSending(false));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth PaperProps={{ sx: { height: '92vh' } }}>
      <DialogTitle sx={{ fontWeight: 700 }}>
        תצוגה מקדימה — שליחה לרו״ח{data ? ` · ${data.employees} עובדים · ${data.attachments} קבצים מצורפים` : ''}
      </DialogTitle>
      {/* The preview is open for INSPECTION even while punch issues block the
          month — only the send itself stays gated (the server enforces the
          same gate with a 409, this is just the honest UI for it). */}
      {blocked && (
        <Alert severity="error" sx={{ mx: 1.5, mt: 1, borderRadius: 2 }}>
          השליחה חסומה: {blockedCount} ימים עם יותר מ-2 החתמות ממתינים להחלטת הנה״ח.
          אפשר לעיין ולהדפיס — כפתור השליחה יישאר נעול עד שהימים ייפתרו ב"בעיות בהחתמה".
        </Alert>
      )}
      <DialogContent dividers sx={{ display: 'flex', gap: 1.5, p: 1.5 }}>
        <Box sx={{ flex: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: '#fff' }}>
          {loading && <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress /></Box>}
          {!loading && data && <iframe ref={iframeRef} title="preview" srcDoc={data.html} style={{ width: '100%', height: '100%', border: 'none' }} />}
        </Box>
        <Box sx={{ width: 290, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>חיפוש עובד בדוח</Typography>
          <Stack direction="row" spacing={0.5}>
            <TextField
              size="small" fullWidth placeholder="שם עובד…"
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); searchIdxRef.current = 0; }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchEmployee(); } }}
              disabled={loading || !data}
            />
            <Button size="small" variant="outlined" onClick={() => searchEmployee()} disabled={loading || !data}>מצא</Button>
          </Stack>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>נמענים</Typography>
          <Typography variant="caption" color="text.secondary">בחר לאן לשלוח. עותק נשלח תמיד למשרד.</Typography>
          <Box sx={{ flex: 1, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
            {data && (data.accountant_emails || []).length === 0 && extra.length === 0 && (
              <Alert severity="warning" sx={{ fontSize: '0.72rem' }}>לא הוגדרו נמענים. הוסף למטה או דרך ניהול אנשי קשר.</Alert>
            )}
            {data && (data.accountant_emails || []).map(e => (
              <FormControlLabel key={e} sx={{ display: 'flex', m: 0 }}
                control={<Checkbox size="small" checked={!!selected[e]} onChange={ev => setSelected(s => ({ ...s, [e]: ev.target.checked }))} />}
                label={<Typography variant="body2" dir="ltr" sx={{ fontFamily: 'monospace', fontSize: '0.74rem' }}>{e}</Typography>} />
            ))}
            {extra.map(e => (
              <Stack key={e} direction="row" alignItems="center" spacing={0.5}>
                <Checkbox size="small" checked disabled />
                <Typography variant="body2" dir="ltr" sx={{ flex: 1, fontFamily: 'monospace', fontSize: '0.74rem' }}>{e}</Typography>
                <IconButton size="small" onClick={() => setExtra(prev => prev.filter(x => x !== e))}><DeleteOutlineIcon fontSize="small" /></IconButton>
              </Stack>
            ))}
          </Box>
          <Stack direction="row" spacing={0.5}>
            <TextField size="small" fullWidth placeholder="מייל נוסף (חד-פעמי)" value={newEmail} dir="ltr"
              onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }} />
            <Button size="small" variant="outlined" onClick={addExtra}>הוסף</Button>
          </Stack>
          {data && <Typography variant="caption" color="text.secondary">עותק למשרד: <span dir="ltr">{data.office_cc}</span></Typography>}
          <Button size="small" onClick={onManageContacts}>ניהול אנשי קשר קבועים</Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button startIcon={<PrintIcon />} onClick={handlePrint} disabled={loading || !data}>הדפסה</Button>
        <Tooltip title={blocked ? 'חסום עד לפתרון ימי ההחתמה הממתינים — "בעיות בהחתמה"' : ''}>
          <span>
            <Button variant="contained" startIcon={sending ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}
              onClick={send} disabled={loading || sending || chosen.length === 0 || blocked}>
              {blocked ? `שליחה חסומה (${blockedCount})` : 'שלח עכשיו'}
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}

/* ─── Main component ────────────────────────────────────────────────── */

export default function PayrollMonthTable() {
  const { selectedBranch, selectedBranchName, isAllBranches, branches: allBranches } = useBranch();
  const { isAdmin, isAccountant, isManager } = useAuth();
  // Branch managers can't write PayrollMonth directly. They stage edits
  // locally and submit them as one change request to the accountant.
  const isReviewer = isAdmin || isAccountant;
  const stagingMode = !isReviewer;
  const confirm = useConfirm();
  // key `${employeeId}::${field}` → change item
  const [staged, setStaged] = useState({});
  const [submittingReq, setSubmittingReq] = useState(false);
  const { month, setMonth } = useWorkMonth();
  const [ganFilter, setGanFilter] = useState([]); // [] = show all gans (only used in "all branches" view)
  const [viewMode, setViewMode] = useState('branch'); // 'branch' | 'amuta'
  const [selectedAmuta, setSelectedAmuta] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [presets, setPresets] = useState([]);
  const [notes, setNotes] = useState({ open: false, row: null });
  const [docsDlg, setDocsDlg] = useState({ open: false, row: null });
  const [pregnancyDlg, setPregnancyDlg] = useState({ open: false, row: null });
  const [punchDlg, setPunchDlg] = useState({ open: false, row: null });
  // Month-wide gate: the accountant send is blocked while ANY branch still has a
  // >2-punch day without a final decision.
  const [punchGate, setPunchGate] = useState({ blocked: false, count: 0, duplicates_count: 0, missing_count: 0 });
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [specialDaysOpen, setSpecialDaysOpen] = useState(false);
  const [cibusSyncOpen, setCibusSyncOpen] = useState(false);
  const [fixedSchedOpen, setFixedSchedOpen] = useState(false);
  useEffect(() => {
    if (!month) return;
    api.get(`/payroll-month/${month}/punch-issues`)
      .then(r => setPunchGate(r.data || { blocked: false, count: 0, duplicates_count: 0, missing_count: 0 }))
      .catch(() => setPunchGate({ blocked: false, count: 0, duplicates_count: 0, missing_count: 0 }));
  }, [month, data]);
  const [addCol, setAddCol] = useState(false);
  const [adjustments, setAdjustments] = useState({ open: false, row: null });
  const [vacation, setVacation] = useState({ open: false, row: null });
  const [sick, setSick] = useState({ open: false, row: null });
  const [closureDetail, setClosureDetail] = useState({ open: false, row: null });
  // Pending manager change-requests for THIS month, shown inside the table so
  // the accountant compares what the managers asked against the row she's
  // editing — without flipping back and forth to the בקשות שינוי tab.
  const [mgrRequests, setMgrRequests] = useState([]);
  const [mgrReqDlg, setMgrReqDlg] = useState({ open: false, employeeId: null }); // employeeId null → all
  const [highlightEmp, setHighlightEmp] = useState(null);
  const rowRefs = useRef({});
  const [absence, setAbsence] = useState({ open: false, row: null });
  const [partialAbs, setPartialAbs] = useState({ open: false, row: null });
  const [inactiveDlg, setInactiveDlg] = useState({ open: false, row: null });
  const [exportMenu, setExportMenu] = useState(null); // { type:'excel'|'pdf', anchor }
  const [travelDlg, setTravelDlg] = useState({ open: false, row: null, locked: false });
  const [empNumDlg, setEmpNumDlg] = useState({ open: false, row: null });
  const [bankDlg, setBankDlg] = useState({ open: false, row: null });
  const [savedDlg, setSavedDlg] = useState({ open: false, row: null });
  const [empSearch, setEmpSearch] = useState('');
  const [holidayPay, setHolidayPay] = useState({ open: false, row: null });
  const [loansDlg, setLoansDlg] = useState({ open: false, row: null });
  const [bonusDlg, setBonusDlg] = useState({ open: false, row: null });
  // The scrolling box. Same fix as AttendanceMonitor's grid: a full reload sets
  // `loading`, and while loading the table body collapses to one spinner row
  // (line ~1870) — an empty container has nothing to scroll, so the browser
  // resets it. A row 40 employees down that had just been toggled sent whoever
  // clicked it back to row 1, every time.
  const tableContainerRef = useRef(null);
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

  const fetchData = useCallback(({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    const box = tableContainerRef.current;
    const keep = quiet && box ? { left: box.scrollLeft, top: box.scrollTop } : null;
    const params = { month };
    if (viewMode === 'branch') {
      if (selectedBranch && !isAllBranches) params.branch = selectedBranch;
    } else if (viewMode === 'amuta' && selectedAmuta) {
      params.amuta = selectedAmuta;
    }
    api.get('/payroll-month', { params })
      .then(res => {
        setData(res.data);
        if (keep) {
          requestAnimationFrame(() => {
            if (!tableContainerRef.current) return;
            tableContainerRef.current.scrollLeft = keep.left;
            tableContainerRef.current.scrollTop = keep.top;
          });
        }
      })
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת טבלת שכר'); })
      .finally(() => { if (!quiet) setLoading(false); });
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

  // Pending manager requests for the month — refetched whenever the table
  // reloads, so approving/rejecting in the בקשות שינוי tab is reflected here.
  useEffect(() => {
    if (!(isAdmin || isAccountant)) { setMgrRequests([]); return undefined; }
    let alive = true;
    api.get('/payroll-month/change-requests', { params: { status: 'pending', month } })
      .then(res => { if (alive) setMgrRequests(res.data?.requests || []); })
      .catch(() => { /* a failed side-fetch must never take the table down */ });
    return () => { alive = false; };
  }, [month, isAdmin, isAccountant, data]);

  // employee_id → the change items managers asked for (annotated with who/when).
  const mgrReqByEmp = useMemo(() => {
    const m = new Map();
    for (const reqDoc of mgrRequests) {
      for (const ch of (reqDoc.changes || [])) {
        const k = String(ch.employee_id);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({
          ...ch,
          request_id: String(reqDoc._id),
          requested_by_name: reqDoc.requested_by_name,
          branch_name: reqDoc.branch_name,
          created_at: reqDoc.created_at,
          request_note: reqDoc.note || '',
        });
      }
    }
    return m;
  }, [mgrRequests]);

  // Per-request decision note the accountant types before approving/rejecting.
  const [mgrDecisionNotes, setMgrDecisionNotes] = useState({}); // request_id → text

  // Decide a manager's request right from the table dialog — the same
  // endpoint the בקשות שינוי tab uses. Approving APPLIES the requested value
  // to PayrollMonth.manual; rejecting requires a reason, which the manager
  // sees in her "ההחלטות שלי" screen. Either way the request leaves the
  // pending list and the table refreshes.
  const decideMgrRequest = useCallback(async (requestId, decision) => {
    const reqDoc = mgrRequests.find(r => String(r._id) === requestId);
    if (!reqDoc) return;
    const note = (mgrDecisionNotes[requestId] || '').trim();
    if (decision === 'rejected' && !note) {
      toast.error('דחייה מחייבת סיבה — המנהל יראה אותה במסך ההחלטות שלו');
      return;
    }
    try {
      await api.post(`/payroll-month/change-requests/${String(reqDoc._id)}/decide`, {
        decisions: (reqDoc.changes || []).map(() => decision),
        decision_note: note,
      });
      toast.success(decision === 'approved'
        ? 'הבקשה אושרה — הערך המבוקש הוחל בטבלה'
        : 'הבקשה נדחתה — הסיבה תוצג למנהל הסניף');
      setMgrRequests(prev => prev.filter(r => String(r._id) !== requestId));
      setMgrDecisionNotes(prev => { const next = { ...prev }; delete next[requestId]; return next; });
      fetchData({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'ההחלטה נכשלה');
    }
  }, [mgrRequests, mgrDecisionNotes, fetchData]);

  // Close the dialog, scroll the employee's row into view and flash it.
  const jumpToEmployee = useCallback((employeeId) => {
    setMgrReqDlg({ open: false, employeeId: null });
    setHighlightEmp(employeeId);
    setTimeout(() => rowRefs.current[employeeId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    setTimeout(() => setHighlightEmp(null), 4000);
  }, []);

  // בונוס אוגוסט is no longer a one-click toggle that pays everything: the
  // chip only OPENS the edit dialog (ClosureCompletionDetailDialog), and the
  // dialog is where days are approved and saved — nothing is paid before the
  // accountant approves days there.

  // Supplement approvals (manager / accounting) are written DIRECTLY — even for
  // a branch manager (who otherwise stages edits). The server enforces that
  // each role may only set its own flag for its own branches.
  const patchApproval = useCallback((employeeId, patch) => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, manual: { ...r.manual, ...patch } } : r),
    });
    api.patch(`/payroll-month/${employeeId}`, { manual: patch }, { params: { month } })
      .then(() => fetchData())
      .catch(err => { toast.error(err.response?.data?.error || 'האישור נכשל'); fetchData(); });
  }, [month, fetchData]);

  // Activate / deactivate an employee (deactivation records a reason shown on the row).
  const setEmployeeActive = useCallback((employeeId, active, reason = '') => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId
        ? { ...r, is_active: active, inactive_reason: active ? '' : (reason || r.inactive_reason) } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, { is_active: active, inactive_reason: active ? '' : reason })
      .then(() => fetchData())
      .catch(err => { toast.error(err.response?.data?.error || 'עדכון נכשל'); fetchData(); });
  }, [fetchData]);

  // Freelancer: issues an invoice (no payslip) → excluded from the accountant export.
  const setEmployeeFreelancer = useCallback((employeeId, isF) => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, is_freelancer: isF } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, { is_freelancer: isF })
      .then(() => { toast.success(isF ? 'סומן כפרילנסר (לא יישלח לרו״ח)' : 'בוטל סימון פרילנסר'); fetchData(); })
      .catch(err => { toast.error(err.response?.data?.error || 'עדכון נכשל'); fetchData(); });
  }, [fetchData]);

  // Standing travel amount lives on the employee → carries forward every month
  // until changed. amount=null clears it (revert to automatic calc).
  const setEmployeeTravel = useCallback((employeeId, amount) => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, travel_override: amount } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, { travel_override: amount })
      .then(() => { toast.success(amount == null ? 'נסיעות חזרו לחישוב אוטומטי' : 'תשלום נסיעות נשמר לעובד (כל חודש)'); fetchData(); })
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [fetchData]);

  // Payslip employee number lives on the employee → shown every month + export.
  const setEmployeeNumber = useCallback((employeeId, value) => {
    const v = (value || '').trim();
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, employee_number: v } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, { employee_number: v })
      .then(() => { toast.success('מספר העובד נשמר'); fetchData(); })
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [fetchData]);

  // Bank details live on the employee (carry forward); sensitive → accounting/admin.
  const setEmployeeBank = useCallback((employeeId, bank) => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, ...bank } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, bank)
      .then(() => { toast.success('פרטי בנק וקופות נשמרו'); fetchData(); })
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [fetchData]);

  // Permanent note lives on the employee (shown every month), not on the month.
  const savePermanentNote = useCallback((employeeId, text) => {
    setData(prev => prev && {
      ...prev,
      rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, permanent_note: text } : r),
    });
    api.put(`/payroll/employees/${employeeId}`, { permanent_note: text })
      .then(() => toast.success('ההערה הקבועה נשמרה'))
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [fetchData]);

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

  const [acctContactsOpen, setAcctContactsOpen] = useState(false);
  const [acctPreviewOpen, setAcctPreviewOpen] = useState(false);
  const acctBranch = (selectedBranch && !isAllBranches) ? selectedBranch : null;

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
  const branchNameOf = (id) => {
    const s = String(id);
    return (data?.branches || []).find(b => b.id === s)?.name
      || (allBranches || []).find(b => String(b._id || b.id) === s)?.name
      || 'אחר';
  };
  const perBranchBreakdown = (r) => {
    if (r.salary_type !== 'hourly') return [];
    const pb = r.breakdown?.per_branch || {};
    const r1 = (n) => Math.round((n || 0) * 10) / 10;
    const out = [];
    for (const [bid, bk] of Object.entries(pb)) {
      const reg = bk.regular_hours || 0, ot125 = bk.ot_125_hours || 0, ot150 = bk.ot_150_hours || 0;
      const hours = r1(reg + ot125 + ot150);
      if (hours <= 0) continue;
      const rate = bk.hourly_rate || 0;
      // What the accountant should pay for this branch's hours (incl. OT premium).
      const amount = Math.round(reg * rate + ot125 * rate * 1.25 + ot150 * rate * 1.5);
      out.push({ name: branchNameOf(bid), hours, reg: r1(reg), ot125: r1(ot125), ot150: r1(ot150), otHours: r1(ot125 + ot150), rate, amount, hasOT: ot125 + ot150 > 0 });
    }
    return out;
  };
  // Show the breakdown only when it adds info: worked at >1 branch, or a single
  // branch whose rate differs from the employee's standard rate.
  const breakdownIsInformative = (r, lines) =>
    lines.length > 1 || (lines.length === 1 && lines[0].rate !== (r.breakdown?.rates?.hourly_rate || lines[0].rate));
  // One readable line per branch incl. the payable amount, so the accountant
  // sees exactly what to pay for each branch's hours at that branch's rate.
  const branchPayLine = (o) => {
    const r2 = (n) => Math.round(n * 100) / 100;
    const parts = [`רגיל ${o.reg}ש׳×₪${o.rate}`];
    if (o.ot125) parts.push(`שע״נ125% ${o.ot125}ש׳×₪${r2(o.rate * 1.25)}`);
    if (o.ot150) parts.push(`שע״נ150% ${o.ot150}ש׳×₪${r2(o.rate * 1.5)}`);
    return `${o.name}: ${parts.join(' + ')} = ₪${o.amount.toLocaleString('he-IL')}`;
  };
  const breakdownText = (lines) => lines.map(branchPayLine).join('  |  ');

  /* Build the full export matrix (header + one row per employee) with every
     column including notes. Reused by CSV / Excel / PDF exports. */
  const buildExportMatrix = (rows = (data?.rows || [])) => {
    const cols = ['ימי עבודה', 'שעות רגילות', 'שע"נ א\'', 'שע"נ ב\'', 'תעריף לשעה', 'שכר תקן'];
    const headerTop = ['סניף', 'שם העובד', 'ת"ז', 'מספר עובד', ...cols,
      'שכר בסיס', 'שע"נ 125%', 'שע"נ 150%', 'השלמת שכר',
      'נסיעות', 'מחלה', 'היעדרות', 'היעדרות (שעות)', 'חופשה', 'דמי חגים (ימים)', 'קיזוז מקדמה', 'GIFT CARD', 'הבראה', 'סיבוס', 'מילואים', 'הלוואות', 'בונוס', 'שכר משוער'];
    for (const c of customColumns) headerTop.push(c.label);
    headerTop.push('פירוט תשלום לפי סניף');
    headerTop.push('בונוס - פירוט');
    headerTop.push('בנק', 'סניף בנק', 'חשבון בנק', 'קופת פנסיה', 'קרן השתלמות'); // populated only for accounting/admin
    headerTop.push('הערות');
    const rowsAcc = [headerTop];

    for (const r of rows) {
      const nameCell = r.is_active === false
        ? `⛔ ${r.full_name} (לא פעיל${r.inactive_reason ? ` — ${r.inactive_reason}` : ''})`
        : r.full_name;
      const cells = [r.branch_name, nameCell, r.israeli_id || '', r.employee_number || ''];
      const tb = r.breakdown?.components?.teken_breakdown;
      // Per-hour rate paid, for EVERY employee: hourly → the hourly rate;
      // תקן/global → the computed value-per-hour (agreed salary ÷ required hours).
      const perHourRate = r.salary_type === 'global'
        ? (tb?.hourly_value != null ? Math.round(tb.hourly_value * 100) / 100 : '')
        : (r.breakdown.rates?.hourly_rate || '');
      // Consolidated hours across all branches (matches the on-screen table).
      cells.push(r.breakdown.hours.days_worked, r.breakdown.hours.regular, r.breakdown.hours.ot_125, r.breakdown.hours.ot_150,
        perHourRate, r.breakdown.rates?.global_salary || '');
      const completionEffective = (r.manual.include_salary_completion !== false) ? (tb?.completion || 0) : 0;
      const sp = paySplit(r) || { reg: '', ot125: '', ot150: '' };
      const rnd = (v) => (v === '' || v == null) ? '' : Math.round(v);
      // Absence days the accountant should deduct = open days only (a fully
      // approved, non-deductible day is settled and must NOT appear in the report).
      const absEntryBy = new Map((r.absence?.entries || []).map(e => [e.date, e]));
      const openAbsence = (r.absence?.days || []).filter(a => {
        const e = absEntryBy.get(a.date);
        return !(e && !absCat(e.category).deduct); // settled once a non-deductible reason is set
      }).length;
      const vacDays = r.vacation_eff_days != null ? r.vacation_eff_days : (Number(r.manual.vacation_days) || 0);
      const holDays = r.holiday_pay_auto?.total_days || 0; // count only — accountant computes the amount
      cells.push(
        rnd(sp.reg),
        rnd(sp.ot125),
        rnd(sp.ot150),
        r.salary_type === 'global' && tb ? Math.round(completionEffective) : '',
        computeTravel(r),
        r.manual.sick_days || '', openAbsence || '',
        r.partial_absence?.deduction ? -Math.round(r.partial_absence.deduction) : '',
        vacDays || '', holDays || '',
        r.manual.advance_deduction_preset?.label || r.manual.advance_deduction_text || '',
        r.manual.gift_card?.kind === 'number' ? r.manual.gift_card.amount : (r.manual.gift_card?.text || ''),
        r.manual.recreation?.kind === 'number' ? r.manual.recreation.amount : (r.manual.recreation?.text || ''),
        r.manual.cibus?.kind === 'number' ? r.manual.cibus.amount : (r.manual.cibus?.text || ''),
        r.manual.miluim?.kind === 'number' ? r.manual.miluim.amount : (r.manual.miluim?.text || ''),
        r.loans_info?.month_deduction ? -Math.round(r.loans_info.month_deduction) : '',
        r.bonus?.effective ? Math.round(r.bonus.effective) : '',
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
      cells.push(r.bonus?.note || '');           // בונוס - פירוט
      cells.push(r.bank_number || '', r.bank_branch || '', r.bank_account || '', r.pension_fund || '', r.education_fund || ''); // בנק + קופות (authorized roles only)
      cells.push([                                // הערות (התחייבות + קבועה + חד-פעמית)
        r.commitment?.committed_hours != null ? `התחייבות: ${r.commitment.committed_hours}h` : '',
        r.permanent_note || '',
        r.manual.notes || '',
      ].filter(Boolean).join(' · '));
      rowsAcc.push(cells);
    }
    return rowsAcc;
  };

  const exportLabel = () => (viewMode === 'amuta'
    ? (data.amutot.find(x => x.id === selectedAmuta)?.name || 'amuta')
    : (selectedBranchName || (isAllBranches ? 'all-branches' : 'branch')));

  const downloadBlob = (blob, ext, tag) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (tag || exportLabel()).toString().replace(/[\\/:*?"<>|]+/g, '-');
    a.href = url; a.download = `שכר-${name}-${month}.${ext}`; a.click();
    URL.revokeObjectURL(url);
  };

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const exportCSV = () => {
    if (!data) return;
    const m = buildExportMatrix((data.rows || []).filter(r => !r.is_freelancer));
    const csv = '﻿' + m.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'csv');
  };

  // Group rows by branch — each branch becomes its own file / sheet / PDF page.
  // Freelancers are excluded: they invoice us, the accountant doesn't process them.
  const exportGroups = (rows = (data?.rows || [])) => {
    const groups = new Map();
    for (const r of rows.filter(x => !x.is_freelancer)) {
      const k = r.branch_name || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.entries()];
  };

  // Resolve the rows to export for a chosen scope.
  //   'network' → every branch (fetch the full month if the current view is scoped)
  //   'current' → only the branch currently selected
  const resolveExportRows = async (scope) => {
    if (scope === 'current') {
      if (!isAllBranches) return data?.rows || [];
      return (data?.rows || []).filter(r => String(r.branch_id) === String(selectedBranch));
    }
    // network
    if (isAllBranches && data?.rows) return data.rows;
    try {
      // branch:'all' overrides the api-client interceptor that would otherwise
      // inject the currently-selected branch and scope the result.
      const res = await api.get('/payroll-month', { params: { month, branch: 'all' } });
      return res.data.rows || [];
    } catch (e) {
      console.error(e); toast.error('שגיאה בטעינת נתוני כל הרשת'); return [];
    }
  };

  // Run an export (excel/pdf) for a chosen scope (network / current branch).
  const runExport = async (type, scope) => {
    setExportMenu(null);
    const rows = await resolveExportRows(scope);
    if (!rows.length) { toast.info('אין נתונים לייצוא'); return; }
    const label = scope === 'network' ? 'כל-הרשת' : (selectedBranchName || 'סניף');
    if (type === 'excel') exportExcel(rows, label);
    else exportPDF(rows);
  };
  const exportColor = (branchName) => ganMarker(branchName)
    || { strip: '#1e3a8a', stripText: '#ffffff', rowTint: '#f1f5f9', accent: '#1e3a8a' };

  // Build one coloured branch table (header + body + totals) from a row subset.
  // Drops the branch column (the whole file is a single branch).
  const buildBranchTable = (branchRows, color, { excel }) => {
    const m = buildExportMatrix(branchRows);
    const header = m[0];
    const rows = m.slice(1);
    let cols = header.map((_, i) => i).filter(i => i !== 0);
    const parseNum = (c) => {
      if (c === '' || c == null) return null;
      if (typeof c === 'number') return c;
      const s = String(c).replace(/[,₪\s]/g, '');
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
    };
    // Drop columns with no content for THIS branch (all blank or all zero) so the
    // PDF doesn't print empty, irrelevant columns. A few core columns are always
    // kept so every page keeps its identity even if a value happens to be zero.
    const PROTECTED_COLS = new Set(['שם העובד', 'ת"ז', 'מספר עובד', 'שכר משוער', 'שכר בסיס']);
    const colHasContent = (i) => rows.some(r => {
      const v = r[i];
      if (v === '' || v == null || v === '—') return false;
      const n = parseNum(v);
      if (n != null) return n !== 0;      // numeric: content only if non-zero
      return String(v).trim() !== '';     // text: content if non-empty
    });
    cols = cols.filter(i => PROTECTED_COLS.has(header[i]) || colHasContent(i));
    // ID-like text columns must never be treated as numeric (no summing).
    const TEXT_ID_COLS = new Set(['ת"ז', 'מספר עובד', 'בנק', 'סניף בנק', 'חשבון בנק', 'קופת פנסיה', 'קרן השתלמות']);
    const numericCol = {};
    for (const i of cols) {
      let any = false, ok = true;
      for (const r of rows) { const v = r[i]; if (v === '' || v == null) continue; if (parseNum(v) == null) { ok = false; break; } any = true; }
      numericCol[i] = ok && any && i >= 3 && !TEXT_ID_COLS.has(header[i]);
    }
    const totals = {};
    const NO_TOTAL = new Set(['תעריף לשעה']); // summing a per-hour rate is meaningless
    for (const i of cols) if (numericCol[i] && !NO_TOTAL.has(header[i])) totals[i] = rows.reduce((s, r) => s + (parseNum(r[i]) || 0), 0);
    const fmt = (c, i) => { const n = numericCol[i] ? parseNum(c) : null; return n != null ? n.toLocaleString('he-IL') : esc(c); };
    const align = (i) => numericCol[i] ? 'left' : (i <= 2 ? 'right' : 'center');
    const bd = excel ? '#ccc' : '#cbd5e1';
    const ws = excel ? 'nowrap' : 'normal';
    // Fixed, identical column widths for every branch page → uniform tables.
    const colWeight = (label) => {
      if (label === 'שם העובד') return 3.2;
      if (label === 'ת"ז') return 1.7;
      if (label === 'פירוט תשלום לפי סניף' || label === 'הערות') return 2.8;
      if (label === 'בונוס - פירוט') return 1.8;
      if (label === 'שכר משוער') return 1.7;
      if (/שכר בסיס|השלמת שכר|תוספת שכר|שע"נ 125|שע"נ 150|קיזוז|הלוואות|בונוס|נסיעות/.test(label)) return 1.4;
      return 1; // hours / day counts / small money
    };
    const weights = cols.map(i => colWeight(header[i]));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const colgroup = `<colgroup>${weights.map(w => `<col style="width:${(w / wsum * 100).toFixed(3)}%"/>`).join('')}</colgroup>`;
    const th = `<tr>${cols.map(i => `<th style="background:${color.strip};color:${color.stripText};border:1px solid ${color.accent};padding:4px 4px;font-weight:bold;text-align:${align(i)};white-space:${ws};word-break:break-word">${esc(header[i])}</th>`).join('')}</tr>`;
    // Grouped header row (matches the on-screen table's column groups).
    const groupOf = (label) => {
      if (label === 'שם העובד' || label === 'ת"ז' || label === 'מספר עובד') return 'עובד';
      if (['ימי עבודה', 'שעות רגילות', 'שע"נ א\'', 'שע"נ ב\'', 'תעריף לשעה', 'שכר תקן'].includes(label)) return 'שעות עבודה';
      if (label === 'בנק' || label === 'סניף בנק' || label === 'חשבון בנק') return 'פרטי בנק';
      if (label === 'פירוט תשלום לפי סניף' || label === 'בונוס - פירוט' || label === 'הערות'
        || customColumns.some(c => c.label === label)) return 'נתונים נוספים';
      return 'שכר ותשלומים';
    };
    const groupColor = { 'עובד': '#475569', 'שעות עבודה': '#0369a1', 'שכר ותשלומים': '#15803d', 'נתונים נוספים': '#7c3aed' };
    let gh = '<tr>';
    for (let k = 0; k < cols.length;) {
      const g = groupOf(header[cols[k]]);
      let span = 1;
      while (k + span < cols.length && groupOf(header[cols[k + span]]) === g) span++;
      gh += `<th colspan="${span}" style="background:${groupColor[g] || '#334155'};color:#fff;border:1px solid #fff;padding:3px 4px;font-weight:bold;text-align:center;white-space:nowrap;font-size:${excel ? '11px' : '8pt'}">${esc(g)}</th>`;
      k += span;
    }
    gh += '</tr>';
    const body = rows.map((r, ri) => {
      const inactive = branchRows[ri]?.is_active === false;
      const rowBg = inactive ? 'background:#e5e7eb' : (ri % 2 ? `background:${color.rowTint}` : '');
      const rowExtra = inactive ? 'color:#6b7280;font-style:italic' : '';
      return `<tr style="${rowBg};${rowExtra}">${cols.map(i => {
        const numStyle = excel ? "mso-number-format:'\\@'" : '';
        return `<td style="border:1px solid ${bd};padding:3px 4px;text-align:${align(i)};white-space:${ws};word-break:break-word;${numStyle}">${fmt(r[i], i)}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const totalsRow = `<tr>${cols.map((i, idx) => {
      const v = idx === 0 ? 'סה״כ' : (totals[i] != null ? Math.round(totals[i]).toLocaleString('he-IL') : '');
      return `<td style="border:1px solid ${color.accent};padding:4px 4px;background:#fde68a;font-weight:bold;text-align:${align(i)};white-space:${ws};word-break:break-word">${v}</td>`;
    }).join('')}</tr>`;
    return { colgroup, gh, th, body, totalsRow, count: rows.length };
  };

  // Excel: ONE real .xlsx workbook, one colour-named sheet per branch.
  // (Replaces the old HTML-as-.xls hack that produced invalid files and lost
  //  every download after the first because browsers block serial downloads.)
  const exportExcel = (rows, label) => {
    if (!data) return;
    const groups = exportGroups(rows);
    if (!groups.length) { toast.info('אין נתונים לייצוא'); return; }
    const parseNum = (c) => {
      if (c === '' || c == null) return null;
      if (typeof c === 'number') return c;
      const s = String(c).replace(/[,₪\s]/g, '');
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
    };
    const wb = XLSX.utils.book_new();
    const usedNames = new Set();
    for (const [branch, rows] of groups) {
      const m = buildExportMatrix(rows);
      const header = m[0].slice(1);                 // drop the branch column
      const body = m.slice(1).map(r => r.slice(1));
      // Which columns are numeric (sum-able). Index >= 2 to skip name + id.
      // ID / bank columns stay TEXT so leading zeros survive and they're not summed.
      const TEXT_COLS = new Set(['ת"ז', 'מספר עובד', 'בנק', 'סניף בנק', 'חשבון בנק', 'קופת פנסיה', 'קרן השתלמות']);
      const numeric = header.map((_, i) => {
        if (i < 2 || TEXT_COLS.has(header[i])) return false;
        let any = false;
        for (const r of body) { const v = r[i]; if (v === '' || v == null) continue; if (parseNum(v) == null) return false; any = true; }
        return any;
      });
      // Coerce numeric cells to real numbers so Excel treats them as numbers.
      const aoaBody = body.map(r => r.map((v, i) => (numeric[i] ? (parseNum(v) ?? '') : v)));
      const totals = header.map((_, i) => {
        if (i === 0) return 'סה״כ';
        if (!numeric[i] || header[i] === 'תעריף לשעה') return ''; // don't sum a per-hour rate
        return Math.round(body.reduce((s, r) => s + (parseNum(r[i]) || 0), 0));
      });
      const groupOf = (label) => {
        if (label === 'שם העובד' || label === 'ת"ז' || label === 'מספר עובד') return 'עובד';
        if (['ימי עבודה', 'שעות רגילות', 'שע"נ א\'', 'שע"נ ב\'', 'תעריף לשעה', 'שכר תקן'].includes(label)) return 'שעות עבודה';
        if (label === 'בנק' || label === 'סניף בנק' || label === 'חשבון בנק') return 'פרטי בנק';
      if (label === 'פירוט תשלום לפי סניף' || label === 'בונוס - פירוט' || label === 'הערות'
          || customColumns.some(c => c.label === label)) return 'נתונים נוספים';
        return 'שכר ותשלומים';
      };
      const groupRow = header.map(() => '');
      const groupMerges = [];
      for (let k = 0; k < header.length;) {
        const g = groupOf(header[k]); let span = 1;
        while (k + span < header.length && groupOf(header[k + span]) === g) span++;
        groupRow[k] = g;
        if (span > 1) groupMerges.push({ s: { r: 1, c: k }, e: { r: 1, c: k + span - 1 } });
        k += span;
      }
      const titleRow = [`🏠 ${branch} — שכר ${month} · ${body.length} עובדים`];
      const aoa = [titleRow, groupRow, header, ...aoaBody, totals];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }, ...groupMerges];
      ws['!rtl'] = true;
      // Column widths roughly matching the on-screen / PDF weighting.
      ws['!cols'] = header.map((label) => {
        if (label === 'שם העובד') return { wch: 30 };
        if (label === 'הערות' || label === 'פירוט תשלום לפי סניף') return { wch: 34 };
        if (label === 'בונוס - פירוט') return { wch: 20 };
        if (label === 'ת"ז') return { wch: 12 };
        if (/שכר|השלמת|תוספת|נסיעות|הלוואות|קיזוז|בונוס|חגים/.test(label)) return { wch: 13 };
        return { wch: 9 };
      });
      ws['!freeze'] = { xSplit: 0, ySplit: 3 };      // freeze title + group + header rows
      let name = (branch || '—').replace(/[\\/?*[\]:]/g, '-').slice(0, 28).trim() || 'גיליון';
      let n = name, k = 2;
      while (usedNames.has(n)) { n = `${name.slice(0, 25)} ${k++}`; }
      usedNames.add(n);
      XLSX.utils.book_append_sheet(wb, ws, n);
    }
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    downloadBlob(
      new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'xlsx', label || exportLabel(),
    );
    toast.success(groups.length > 1
      ? `קובץ אקסל — ${groups.length} גיליונות (סניף לכל גיליון)`
      : 'קובץ אקסל הורד');
  };

  // PDF: one document, each branch on its own page with a colour-coded banner.
  const exportPDF = (rows) => {
    if (!data) return;
    const groups = exportGroups(rows);
    if (!groups.length) { toast.info('אין נתונים לייצוא'); return; }
    const today = new Date().toLocaleDateString('he-IL');
    const sections = groups.map(([branch, rows], gi) => {
      const c = exportColor(branch);
      const t = buildBranchTable(rows, c, { excel: false });
      return `<section style="page-break-before:${gi > 0 ? 'always' : 'auto'}">
        <div class="hdr" style="border-color:${c.accent}">
          <h1 style="color:${c.accent}"><span class="dot" style="background:${c.strip}"></span> ${esc(branch)} — שכר ${esc(month)}</h1>
          <div class="meta">${t.count} עובדים · הופק ${esc(today)}</div>
        </div>
        <table>${t.colgroup}<thead>${t.gh}${t.th}</thead><tbody>${t.body}${t.totalsRow}</tbody></table>
      </section>`;
    }).join('');
    const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>שכר ${esc(month)}</title>
      <style>
        body{font-family:Arial,'Heebo',sans-serif;direction:rtl;padding:8px;color:#0f172a}
        .hdr{display:flex;justify-content:space-between;align-items:flex-end;margin:0 0 8px;border-bottom:3px solid;padding-bottom:6px}
        .hdr h1{font-size:17px;margin:0;display:flex;align-items:center;gap:7px;font-weight:800}
        .hdr .dot{width:15px;height:15px;border-radius:50%;display:inline-block}
        .hdr .meta{font-size:10px;color:#475569}
        table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8pt}
        td,th{padding:3px 4px;overflow:hidden;vertical-align:middle}
        thead{display:table-header-group}
        tr{break-inside:avoid}
        @page{size:landscape;margin:6mm}
      </style></head><body>${sections}
      <script>window.onload=()=>{window.print()}<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast.error('חלון ההדפסה נחסם — אפשר חלונות קופצים'); return; }
    w.document.write(html); w.document.close();
  };

  /* ─── Render ────────────────────────────────────────────────────── */

  // Approx column widths so borders sit right
  const W = {
    name: 180,            // sticky right column
    amutaCell: 68,        // each of 5 hours cols (days+reg+ot125+ot150+rate)
    travel: 78,
    days: 60,
    absence: 105,         // ימי היעדרות + ניכוי + ממתין
    advance: 180,
    money: 82,
    tekenBase: 210,       // שכר בסיס: amount + net/gross chip + detailed per-branch hour split
    teken: 110,           // completion / supplement (chips)
    notes: 340,           // inline notes — wider so they don't stack too tall
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
          <Button startIcon={<AutorenewIcon />} size="small" onClick={() => setCibusSyncOpen(true)} variant="outlined" sx={{ color: '#0f766e', borderColor: '#5eead4' }}>סיבוס אוטומטי</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyAutoHolidays} variant="outlined" color="warning" disabled={stagingMode}>החל דמי חגים</Button>
          <Button startIcon={<CelebrationIcon />} size="small" onClick={() => setSpecialDaysOpen(true)} variant="outlined" sx={{ color: '#7c3aed', borderColor: '#c4b5fd' }}>ימים מיוחדים</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyKindergartenVacation} variant="outlined" color="primary" disabled={stagingMode}>חופשה מלוח</Button>
          <Button startIcon={<AutoAwesomeIcon />} size="small" onClick={applyVacationRequests} variant="outlined" color="info" disabled={stagingMode}>סנכרן בקשות</Button>
          <Tooltip title="עובדים שמקבלים שעות קבועות ללא החתמה בשעון">
            <Button startIcon={<ScheduleIcon />} size="small" onClick={() => setFixedSchedOpen(true)}
              variant="outlined" color="secondary" disabled={stagingMode}>שעות קבועות</Button>
          </Tooltip>
          {(isAdmin || isAccountant) && mgrRequests.length > 0 && (
            <Tooltip title="בקשות עדכון שכר ממתינות מהמנהלים לחודש זה — השוואה מול הטבלה">
              <Badge badgeContent={mgrRequests.length} color="warning">
                <Button size="small" variant="outlined" color="warning" startIcon={<NoteAltIcon />}
                  onClick={() => setMgrReqDlg({ open: true, employeeId: null })}>
                  בקשות מנהלים
                </Button>
              </Badge>
            </Tooltip>
          )}
          <Tooltip title="רענן"><IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton></Tooltip>
          <Button size="small" variant="outlined" color="success" startIcon={<DownloadIcon />}
            onClick={(e) => setExportMenu({ type: 'excel', anchor: e.currentTarget })} disabled={!data}>אקסל ▾</Button>
          <Button size="small" variant="outlined" color="error" startIcon={<DownloadIcon />}
            onClick={(e) => setExportMenu({ type: 'pdf', anchor: e.currentTarget })} disabled={!data}>PDF ▾</Button>
          <Badge color="error" badgeContent={(punchGate.duplicates_count || 0) + (punchGate.missing_count || 0)} max={99}>
            <Button size="small" variant={punchGate.blocked ? 'contained' : 'outlined'}
              color={punchGate.blocked ? 'error' : 'warning'} startIcon={<ReportProblemIcon />}
              onClick={() => setIssuesOpen(true)} disabled={!data}>
              בעיות בהחתמה
            </Button>
          </Badge>
          <Tooltip title={punchGate.blocked
            ? `${punchGate.count} ימים עם יותר מ-2 החתמות ממתינים להחלטת הנה״ח (בכל הגנים) — התצוגה המקדימה פתוחה לצפייה, אבל השליחה עצמה חסומה עד לפתרון ב"בעיות בהחתמה"`
            : 'שליחת טבלת השכר לרו״ח'}>
            <span>
              <Button size="small" variant="contained" color="primary"
                startIcon={<SendIcon />}
                onClick={() => setAcctPreviewOpen(true)}
                disabled={!data || stagingMode}>
                שלח לרו״ח{punchGate.blocked ? ` (שליחה חסומה — ${punchGate.count})` : ''}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="הגדרת נמעני רו״ח"><span>
            <IconButton size="small" onClick={() => setAcctContactsOpen(true)}><ContactMailIcon fontSize="small" /></IconButton>
          </span></Tooltip>
          <Menu open={!!exportMenu} anchorEl={exportMenu?.anchor} onClose={() => setExportMenu(null)}>
            <MenuItem disabled sx={{ opacity: 1 }}>
              <ListItemText primaryTypographyProps={{ fontSize: '0.72rem', fontWeight: 800, color: 'text.secondary' }}
                primary={exportMenu?.type === 'excel' ? 'הורדת אקסל' : 'הורדת PDF'} />
            </MenuItem>
            <Divider />
            <MenuItem onClick={() => runExport(exportMenu.type, 'network')}>
              <ListItemText primary="כל הרשת — קובץ אחד"
                secondary={exportMenu?.type === 'excel' ? 'גיליון נפרד לכל סניף' : 'עמוד נפרד לכל סניף'} />
            </MenuItem>
            <MenuItem onClick={() => runExport(exportMenu.type, 'current')} disabled={isAllBranches}>
              <ListItemText primary={`סניף נוכחי בלבד${!isAllBranches && selectedBranchName ? ` — ${selectedBranchName}` : ''}`}
                secondary={isAllBranches ? 'בחר סניף מסוים כדי להפעיל' : null} />
            </MenuItem>
          </Menu>
          <Tooltip title="ייצוא CSV"><IconButton onClick={exportCSV} disabled={!data}><DownloadIcon /></IconButton></Tooltip>
          {isFinalized
            ? <Button startIcon={<LockOpenIcon />} onClick={reopen} color="warning" variant="outlined" size="small" disabled={stagingMode}>פתח לעריכה</Button>
            : <Button startIcon={<LockIcon />} onClick={finalize} color="primary" variant="outlined" size="small" disabled={stagingMode}>נעל חודש</Button>}
        </Stack>
      </Paper>

      <TableContainer ref={tableContainerRef} component={Paper} sx={{ borderRadius: 3, maxHeight: 'calc(100vh - 240px)', overflowX: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
        <Table size="small" stickyHeader sx={{
          tableLayout: 'fixed',
          minWidth: 1100,
          '& td, & th': { fontSize: '0.78rem', borderBottom: '1px solid', borderColor: 'divider', boxSizing: 'border-box', padding: '4px 6px', verticalAlign: 'middle' },
          '& td.auto': { bgcolor: 'grey.50', color: 'text.secondary' },
          '& .ag-divider': { borderLeft: '2px solid', borderColor: 'divider' },
          '& tbody tr:nth-of-type(even) td': { bgcolor: 'rgba(0,0,0,0.015)' },
          '& tbody tr:nth-of-type(even) td.auto': { bgcolor: 'rgba(0,0,0,0.035)' },
          '& tbody tr:hover td': { bgcolor: 'rgba(99,102,241,0.06) !important' },
        }}>
          <colgroup>
            <col style={{ width: W.name }} />
            {/* 6-col hours block: ימי עבודה + רגיל + שע"נ א' + שע"נ ב' + תעריף + שכר תקן */}
            <col style={{ width: W.days }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            <col style={{ width: W.amutaCell }} />
            {/* תקן breakdown — 4 columns: base / OT125 / OT150 / completion */}
            <col style={{ width: W.tekenBase }} />
            <col style={{ width: W.teken }} />
            <col style={{ width: W.teken }} />
            <col style={{ width: W.teken }} />
            <col style={{ width: W.travel }} />
            <col style={{ width: W.days }} />{/* מחלה */}
            <col style={{ width: W.absence }} />{/* היעדרות */}
            <col style={{ width: W.absence }} />{/* היעדרות שעות */}
            <col style={{ width: W.days }} />{/* חופשה */}
            <col style={{ width: W.days }} />{/* דמי חגים */}
            <col style={{ width: W.advance }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />
            <col style={{ width: W.money }} />{/* בונוס */}
            {customColumns.map(c => <col key={`cc-${c.id}`} style={{ width: W.custom }} />)}
            <col style={{ width: W.adjust }} />
            <col style={{ width: W.notes }} />
          </colgroup>

          <TableHead>
            <TableRow>
              <TableCell rowSpan={2} sx={{
                fontWeight: 800, bgcolor: 'background.paper',
                // RTL: the stylis rtl plugin flips left<->right, so `left: 0`
                // here renders as `right: 0` — freezing this column to the RTL
                // start (visual right) so the name stays put on sideways scroll.
                position: 'sticky', left: 0, zIndex: 4,
                borderLeft: '2px solid', borderColor: 'divider',
              }} className="ag-divider">שם העובד</TableCell>
              <TableCell colSpan={6} align="center" sx={{
                fontWeight: 800, bgcolor: 'primary.50', color: 'primary.dark',
                letterSpacing: 0.2,
              }}>שעות עבודה</TableCell>
              <TableCell colSpan={17 + customColumns.length + 2} align="center" sx={{ fontWeight: 800, bgcolor: 'warning.50' }} className="ag-divider">
                נתונים חודשיים
              </TableCell>
            </TableRow>
            <TableRow>
              <SubHeaderGroup color={{ sub: '#eff6ff', accent: '#1e40af', border: '#93c5fd' }} />
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#e0f2fe' }}>
                <Tooltip arrow title="תשלום בגין השעות הרגילות בלבד. תקן: שעות רגילות × ערך שעה (שכר תקן ÷ שעות התחייבות). שעתי: שעות רגילות × תעריף. שע״נ מוצג בעמודות הנפרדות.">
                  <span style={{ borderBottom: '1px dotted', cursor: 'help' }}>שכר בסיס ⓘ</span>
                </Tooltip>
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#dbeafe' }}>
                <Tooltip arrow title="תשלום בגין שעות נוספות ב-125% (שעתיים הראשונות מעל 8 ש׳ ביום). תקן: שעות 125% × ערך שעה × 1.25.">
                  <span style={{ borderBottom: '1px dotted', cursor: 'help' }}>שע״נ 125% ⓘ</span>
                </Tooltip>
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#dbeafe' }}>
                <Tooltip arrow title="תשלום בגין שעות נוספות ב-150% (מעל 10 ש׳ ביום). תקן: שעות 150% × ערך שעה × 1.5.">
                  <span style={{ borderBottom: '1px dotted', cursor: 'help' }}>שע״נ 150% ⓘ</span>
                </Tooltip>
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#fef9c3' }}>
                <Tooltip arrow title="עובד תקן בלבד. כשעבדה פחות משעות ההתחייבות — משלים אוטומטית עד השכר המוסכם המלא: max(0, שכר מוסכם − שכר בסיס − שע״נ). שכר בסיס + השלמה = השכר המוסכם בדיוק (השע״נ כלול, לא נוסף מעליו). ברירת מחדל דלוק; ניתן לכבות כדי לשלם רק לפי שעות בפועל.">
                  <span style={{ borderBottom: '1px dotted', cursor: 'help' }}>השלמת שכר ⓘ</span>
                </Tooltip>
              </TableCell>
              <TableCell align="center" className="auto ag-divider" sx={{ fontWeight: 700 }}>נסיעות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מחלה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>היעדרות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#fff7ed' }}>
                <Tooltip arrow title="עובד תקן בלבד. ימים שבהם הגיע/ה אך עבד/ה מעל שעה פחות משעות ההתחייבות. שעה ראשונה חסרה = גרייס (לא מנוכה). מעל שעה — כל השעות החסרות מנוכות יחסית, לאחר אישור הנה״ח לכל יום.">
                  <span style={{ borderBottom: '1px dotted', cursor: 'help' }}>היעדרות (שעות) ⓘ</span>
                </Tooltip>
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>חופשה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>דמי חגים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>קיזוז מקדמה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>GIFT CARD</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הבראה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>סיבוס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מילואים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: 'error.50' }}>הלוואות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, bgcolor: '#dcfce7' }}>בונוס</TableCell>
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
              <TableCell align="center" sx={{ fontWeight: 700 }}>עדכוני שכר חודשי</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>

          <TableBody>
            {(() => {
              const totalCols = 1 + 6 + 19 + customColumns.length;
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
                      position: 'sticky', left: 0, zIndex: 3, // RTL plugin flips to right:0
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
                for (let ri = 0; ri < rows.length; ri++) {
                  const r = rows[ri];
                  const locked = r.status === 'finalized';
                  // Opaque, LIGHT zebra for the frozen name column: a pale branch
                  // tint alternating between two light shades so rows stay
                  // distinguishable while keeping the branch colour (not too dark).
                  const nameBg = marker?.nameTint
                    ? (ri % 2 === 1 ? lightenHex(marker.nameTint, 0.45) : lightenHex(marker.nameTint, 0.7))
                    : (ri % 2 === 1 ? '#f3f4f6' : '#ffffff');
                  elements.push(
                    <TableRow
                      key={r.employee_id}
                      ref={(el) => { rowRefs.current[r.employee_id] = el; }}
                      sx={{
                        ...(marker ? { backgroundColor: marker.rowTint } : {}),
                        ...(r.is_active === false ? { opacity: 0.6 } : {}),
                        ...(highlightEmp === r.employee_id ? { outline: '3px solid #f59e0b', outlineOffset: '-3px' } : {}),
                      }}>
                      <TableCell sx={{
                        fontWeight: 700, position: 'sticky', left: 0, zIndex: 2, // RTL plugin flips to right:0
                        // Forced past the translucent zebra / hover rules (high
                        // specificity + !important) so the frozen column never
                        // reveals the cells scrolling underneath it.
                        '&&&': { backgroundColor: `${nameBg} !important` },
                        borderLeft: marker ? '3px solid' : '2px solid',
                        borderColor: marker?.accent || 'divider',
                      }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', rowGap: 0.4 }}>
                          <Box sx={{ flex: '1 1 100%', minWidth: 0, lineHeight: 1.2 }}>
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
                                ת"ז {r.israeli_id}
                              </Typography>
                            )}
                            <Tooltip title="מספר עובד (כפי שמופיע בתלוש) — לחץ לעריכה">
                              <Box component="span" onClick={(e) => { e.stopPropagation(); setEmpNumDlg({ open: true, row: r }); }}
                                sx={{ display: 'inline-block', mt: 0.2, cursor: 'pointer' }}>
                                {r.employee_number
                                  ? <Chip size="small" color="primary" variant="outlined" label={`מס׳ עובד: ${r.employee_number}`}
                                      sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700 }} />
                                  : <Typography variant="caption" sx={{ color: 'warning.main', fontSize: '0.6rem', textDecoration: 'underline dotted' }}>
                                      + הוסף מס׳ עובד
                                    </Typography>}
                              </Box>
                            </Tooltip>
                            {/* Saved payslips archive + paid badge */}
                            <Box sx={{ display: 'block', mt: 0.2 }}>
                              <Tooltip title="תלושים שמורים — הפקה/ייצוא לכל חודש">
                                <Chip size="small" variant="outlined" color="default" label="תלושים 🗂"
                                  onClick={(e) => { e.stopPropagation(); setSavedDlg({ open: true, row: r }); }}
                                  sx={{ height: 16, fontSize: '0.6rem', cursor: 'pointer', mr: 0.3 }} />
                              </Tooltip>
                              {r.payslip_paid && (
                                <Tooltip title={r.payslip_paid_at ? `אושר ושולם · ${new Date(r.payslip_paid_at).toLocaleDateString('he-IL')}` : 'אושר ושולם'}>
                                  <Chip size="small" color="success" label="✓ שולם" sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700 }} />
                                </Tooltip>
                              )}
                              {mgrReqByEmp.has(r.employee_id) && (
                                <Tooltip title="מנהל הסניף ביקש עדכון שכר לעובדת זו — לחץ/י להשוואה מול הטבלה">
                                  <Chip size="small" color="warning" variant="filled"
                                    label={`📨 בקשת מנהל${mgrReqByEmp.get(r.employee_id).length > 1 ? ` ×${mgrReqByEmp.get(r.employee_id).length}` : ''}`}
                                    onClick={(e) => { e.stopPropagation(); setMgrReqDlg({ open: true, employeeId: r.employee_id }); }}
                                    sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700, cursor: 'pointer' }} />
                                </Tooltip>
                              )}
                            </Box>
                            {/* Bank details — server sends these only to accounting/admin */}
                            {r.bank_account !== undefined && (
                              <Tooltip title="בנק וקופות (פנסיה / השתלמות) לתשלום שכר — לחץ לעריכה (הנהלת חשבונות בלבד)">
                                <Box component="span" onClick={(e) => { e.stopPropagation(); setBankDlg({ open: true, row: r }); }}
                                  sx={{ display: 'block', mt: 0.2, cursor: 'pointer' }}>
                                  {(r.bank_number || r.bank_account || r.pension_fund || r.education_fund)
                                    ? <Stack direction="row" spacing={0.3} flexWrap="wrap" useFlexGap>
                                        {(r.bank_number || r.bank_account) && <Chip size="small" color="default" variant="outlined"
                                          label={`🏦 ${r.bank_number || '?'}-${r.bank_branch || '?'} · ${r.bank_account || '?'}`}
                                          sx={{ height: 16, fontSize: '0.58rem', fontWeight: 600 }} />}
                                        {r.pension_fund && <Chip size="small" color="default" variant="outlined" label={`פנסיה: ${r.pension_fund}`} sx={{ height: 16, fontSize: '0.58rem' }} />}
                                        {r.education_fund && <Chip size="small" color="default" variant="outlined" label={`השתלמות: ${r.education_fund}`} sx={{ height: 16, fontSize: '0.58rem' }} />}
                                      </Stack>
                                    : <Typography variant="caption" sx={{ color: 'warning.main', fontSize: '0.6rem', textDecoration: 'underline dotted' }}>
                                        + הוסף בנק / קופות
                                      </Typography>}
                                </Box>
                              </Tooltip>
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
                                    <b>פירוט תשלום לפי סניף</b>
                                    {lines.map((o, i) => (
                                      <div key={i} style={{ marginTop: 2 }}>{branchPayLine(o)}</div>
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
                          <Tooltip title={r.is_active === false ? 'עובד לא פעיל — לחץ להפעלה' : 'לחץ לסימון כלא פעיל'}>
                            <Chip
                              size="small"
                              color={r.is_active === false ? 'default' : 'success'}
                              variant={r.is_active === false ? 'outlined' : 'filled'}
                              label={r.is_active === false ? 'לא פעיל' : 'פעיל'}
                              onClick={(e) => { e.stopPropagation(); r.is_active === false ? setEmployeeActive(r.employee_id, true) : setInactiveDlg({ open: true, row: r }); }}
                              sx={{ height: 18, fontSize: '0.58rem', fontWeight: 700, cursor: 'pointer' }}
                            />
                          </Tooltip>
                          <Tooltip title={r.is_freelancer ? 'פרילנסרית — מפיקה חשבונית, לא נשלחת לרו״ח. לחץ לביטול' : 'סמן כפרילנסרית (חשבונית, לא תיכלל בייצוא לרו״ח)'}>
                            <Chip
                              size="small"
                              color={r.is_freelancer ? 'warning' : 'default'}
                              variant={r.is_freelancer ? 'filled' : 'outlined'}
                              label={r.is_freelancer ? '🧾 פרילנסר' : 'פרילנסר?'}
                              onClick={(e) => { e.stopPropagation(); setEmployeeFreelancer(r.employee_id, !r.is_freelancer); }}
                              sx={{ height: 18, fontSize: '0.58rem', fontWeight: 700, cursor: 'pointer' }}
                            />
                          </Tooltip>
                          {locked && <Chip size="small" label="נעול" sx={{ height: 18, fontSize: '0.62rem' }} />}
                        </Box>
                      </TableCell>

                      {(() => {
                        // Consolidated hours across ALL branches (uniform), so the
                        // displayed hours match the base pay. The per-branch split
                        // (and any Herzliya-style bonus) shows in the name-cell chip
                        // tooltip and the notes column.
                        const totalBk = {
                          days_worked: r.breakdown.hours.days_worked,
                          regular_hours: r.breakdown.hours.regular,
                          ot_125_hours: r.breakdown.hours.ot_125,
                          ot_150_hours: r.breakdown.hours.ot_150,
                          hourly_rate: r.breakdown.rates?.hourly_rate || 0,
                          global_salary: r.breakdown.rates?.global_salary || 0,
                        };
                        return <BranchGroupCells bk={totalBk} salaryType={r.salary_type} color={{ cell: 'rgba(99,102,241,0.04)', border: '#93c5fd' }} />;
                      })()}

                      {/* שכר בסיס (רגיל) / שע"נ 125% / שע"נ 150% / השלמה */}
                      <TableCell align="center" sx={{ bgcolor: '#f0f9ff' }}>
                        <TekenBasePartCell row={r}
                          branchPay={(() => { const l = perBranchBreakdown(r); return breakdownIsInformative(r, l) ? l : null; })()}
                          onOpenHours={() => setEmpDetail({ open: true, employeeId: r.employee_id, initialTab: 1 })}
                        />
                      </TableCell>
                      <TableCell align="center" sx={{ bgcolor: '#eef6ff' }}>
                        <PayAmountCell value={paySplit(r)?.ot125} />
                      </TableCell>
                      <TableCell align="center" sx={{ bgcolor: '#eef6ff' }}>
                        <PayAmountCell value={paySplit(r)?.ot150} />
                      </TableCell>
                      <TableCell align="center" sx={{ bgcolor: '#fefce8' }}>
                        <TekenCompletionCell row={r} disabled={locked}
                          onToggle={(v) => patchManual(r.employee_id, { include_salary_completion: v })}
                        />
                      </TableCell>
                      <TableCell align="center" className="ag-divider" sx={{ cursor: 'pointer', padding: '6px !important' }}
                        onClick={() => setTravelDlg({ open: true, row: r, locked })}>
                        <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtCurrency(computeTravel(r)) || '—'}</Typography>
                          {hasTravelOverride(r)
                            ? <Chip size="small" color="info" variant="filled" label="ידני" sx={{ height: 14, fontSize: '0.55rem', '& .MuiChip-label': { px: 0.5 } }} />
                            : <Typography variant="caption" sx={{ fontSize: '0.55rem', color: 'text.disabled' }}>אוטומטי</Typography>}
                          {/* What the branch manager wrote about this month's
                              travel. It sets no amount by itself — it is here so
                              the figure beside it can be decided. */}
                          {r.manual?.travel_note && (
                            <Tooltip title={r.manual.travel_note}>
                              <Chip size="small" color="warning" variant="outlined" label="הערת מנהל/ת"
                                sx={{ height: 14, fontSize: '0.5rem', '& .MuiChip-label': { px: 0.5 } }} />
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important' }} onClick={() => setSick({ open: true, row: r })}>
                        {Number(r.manual.sick_days) ? (
                          <Stack spacing={0.25} alignItems="center">
                            <Chip size="small" label={`${Number(r.manual.sick_days)} ימים`} color="error" />
                            {Number(r.sick_info?.pay) > 0 && (
                              <Typography variant="caption" sx={{ fontWeight: 700, color: 'success.main' }}>
                                ₪{Math.round(Number(r.sick_info.pay)).toLocaleString('he-IL')}
                              </Typography>
                            )}
                            {/* The sick pay is real; the completion shrank by
                                it. Say so, or the smaller completion looks
                                like a bug. */}
                            {Number(r.sick_info?.completion_offset) > 0 && (
                              <Tooltip arrow title={`דמי המחלה שולמו במלואם, והשלמת השכר הופחתה ב-₪${Math.round(Number(r.sick_info.completion_offset)).toLocaleString('he-IL')} כדי לא לשלם פעמיים על אותם ימים. סה״כ המשכורת נשאר שכר התקן המלא.`}>
                                <Chip size="small" color="info" variant="outlined" label="מקוזז מההשלמה"
                                  sx={{ height: 14, fontSize: '0.53rem', '& .MuiChip-label': { px: 0.5 } }} />
                              </Tooltip>
                            )}
                          </Stack>
                        ) : (
                          <Typography variant="body2" color="text.secondary">—</Typography>
                        )}
                      </TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important', minWidth: 100 }} onClick={() => setAbsence({ open: true, row: r })}>
                        <AbsenceCell row={r} />
                      </TableCell>
                      <TableCell align="center" sx={{ cursor: 'pointer', padding: '6px !important', minWidth: 90 }} onClick={() => setPartialAbs({ open: true, row: r })}>
                        <PartialAbsenceCell row={r} />
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
                      <TableCell align="center" sx={{ cursor: 'pointer', bgcolor: '#f0fdf4' }} onClick={() => !locked && setBonusDlg({ open: true, row: r })}>
                        <BonusCell row={r} />
                        {/* Only relevant the one month a branch actually closes for the
                            summer — showing it year-round just invites toggling it on
                            in, say, March. */}
                        {month?.slice(5, 7) === '08' && (
                          <Tooltip title={r.manual?.closure_completion
                            ? 'בונוס אוגוסט פעיל — לחץ/י לעריכת הימים המאושרים לתשלום (16–31.8)'
                            : 'בונוס אוגוסט: פתיחת חלון אישור ימי חופשת הקיץ (16–31.8). שום יום לא משולם עד שמאשרים אותו בחלונית'}>
                            <Chip
                              size="small"
                              color={r.manual?.closure_completion ? 'secondary' : 'default'}
                              variant={r.manual?.closure_completion ? 'filled' : 'outlined'}
                              label={r.manual?.closure_completion ? '📋 בונוס אוגוסט' : 'בונוס אוגוסט?'}
                              onClick={(e) => { e.stopPropagation(); setClosureDetail({ open: true, row: r }); }}
                              sx={{ height: 18, fontSize: '0.58rem', fontWeight: 700, cursor: 'pointer', mt: 0.5 }}
                            />
                          </Tooltip>
                        )}
                        {/* Amount actually paid for the approved days — both
                            types get a separate בונוס line (never hours):
                            global carved from the completion, hourly added on
                            top. Click opens the same edit dialog. */}
                        {Number(r.breakdown?.components?.closure_completion_bonus?.amount) > 0 && (
                          <Tooltip title="לחץ/י לעריכת ימי הבונוס">
                            <Chip size="small" color="secondary" variant="filled"
                              label={`📋 בונוס אוגוסט ₪${Math.round(r.breakdown.components.closure_completion_bonus.amount).toLocaleString('he-IL')}`}
                              onClick={(e) => { e.stopPropagation(); setClosureDetail({ open: true, row: r }); }}
                              sx={{ height: 16, fontSize: '0.55rem', mt: 0.3, cursor: 'pointer' }}
                            />
                          </Tooltip>
                        )}
                        {r.salary_type === 'global' && Number(r.breakdown?.components?.closure_completion_bonus?.deduction) > 0 && (
                          <Tooltip title="ימי חופשת קיץ שלא אושרו לתשלום — יורדים מהשכר. לחץ/י לעריכה">
                            <Chip size="small" color="warning" variant="outlined"
                              label={`⚠ לא אושרו −₪${Math.round(r.breakdown.components.closure_completion_bonus.deduction).toLocaleString('he-IL')}`}
                              onClick={(e) => { e.stopPropagation(); setClosureDetail({ open: true, row: r }); }}
                              sx={{ height: 16, fontSize: '0.55rem', mt: 0.3, cursor: 'pointer' }}
                            />
                          </Tooltip>
                        )}
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
                          lineHeight: 1.4,
                          whiteSpace: 'pre-wrap',
                          minWidth: 200,
                          bgcolor: (r.manual.notes || r.permanent_note) ? 'rgba(254, 252, 232, 0.55)' : undefined,
                          '&:hover': { bgcolor: 'rgba(254, 252, 232, 0.85)' },
                        }}
                      >
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.4 }}>
                          <Chip
                            size="small" clickable
                            icon={<AttachFileIcon sx={{ fontSize: 14 }} />}
                            label={r.docs_total > 0 ? `קבצים · ${r.docs_total}` : 'קבצים'}
                            onClick={(e) => { e.stopPropagation(); setDocsDlg({ open: true, row: r }); }}
                            sx={{
                              height: 22, borderRadius: 1.5, fontSize: '0.64rem', fontWeight: 600,
                              color: r.docs_total > 0 ? '#1e40af' : 'primary.main',
                              bgcolor: r.docs_total > 0 ? '#dbeafe' : '#eef2ff',
                              border: `1px solid ${r.docs_total > 0 ? '#93c5fd' : '#c7d2fe'}`,
                              '& .MuiChip-icon': { color: 'primary.main', ml: '6px', mr: '-2px' },
                              '&:hover': { bgcolor: '#e0e7ff' },
                            }}
                          />
                        </Box>
                        {r.pregnancy && (
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4, mb: 0.4 }}>
                            {r.pregnancy.is_pregnant && (
                              <Chip
                                size="small" clickable
                                label="🤰 בהריון · מעקב 40ש׳"
                                onClick={(e) => { e.stopPropagation(); setPregnancyDlg({ open: true, row: r }); }}
                                sx={{ height: 22, borderRadius: 1.5, fontSize: '0.62rem', fontWeight: 700,
                                  color: '#9d174d', bgcolor: '#fce7f3', border: '1px solid #fbcfe8',
                                  '&:hover': { bgcolor: '#fbcfe8' } }}
                              />
                            )}
                            {r.pregnancy.on_pregnancy_bedrest && (
                              <Chip size="small" label="🛏️ שמירת הריון"
                                sx={{ height: 22, borderRadius: 1.5, fontSize: '0.62rem', fontWeight: 700,
                                  color: '#9a3412', bgcolor: '#ffedd5', border: '1px solid #fed7aa' }} />
                            )}
                            {r.pregnancy.on_maternity_leave && (
                              <Chip size="small" label="🍼 חופשת לידה"
                                sx={{ height: 22, borderRadius: 1.5, fontSize: '0.62rem', fontWeight: 700,
                                  color: '#5b21b6', bgcolor: '#ede9fe', border: '1px solid #ddd6fe' }} />
                            )}
                            {r.pregnancy.protected && (
                              <Tooltip title="תקופה מוגנת (§9 חוק עבודת נשים): אסור לפגוע בשכר/היקף חד-צדדית בלי היתר מהממונה במשרד העבודה">
                                <Chip size="small" label="🛡️ תקופה מוגנת"
                                  sx={{ height: 22, borderRadius: 1.5, fontSize: '0.62rem', fontWeight: 700,
                                    color: '#991b1b', bgcolor: '#fee2e2', border: '1px solid #fecaca' }} />
                              </Tooltip>
                            )}
                          </Box>
                        )}
                        {Array.isArray(r.punch_review) && r.punch_review.length > 0 && (() => {
                          const pending = r.punch_review.filter(d => d.status !== 'approved').length;
                          return (
                            <Box
                              onClick={(e) => { e.stopPropagation(); setPunchDlg({ open: true, row: r }); }}
                              sx={{ mb: 0.4, p: '4px 6px', borderRadius: 1, cursor: 'pointer',
                                bgcolor: pending ? '#fef2f2' : '#f0fdf4',
                                border: `1px solid ${pending ? '#fecaca' : '#bbf7d0'}`,
                                '&:hover': { filter: 'brightness(0.97)' } }}
                            >
                              <Box sx={{ color: pending ? '#b91c1c' : '#15803d', fontWeight: 800, fontSize: '0.64rem' }}>
                                {pending ? `\u26A0\uFE0F ${pending} ימים עם יותר מ-2 החתמות — לאישור` : '\u2714\uFE0F החתמות אושרו'}
                              </Box>
                            </Box>
                          );
                        })()}
                        {Array.isArray(r.pending_docs) && r.pending_docs.length > 0 && (
                          <Box
                            onClick={(e) => { e.stopPropagation(); setDocsDlg({ open: true, row: r }); }}
                            sx={{ mb: 0.4, p: '4px 6px', borderRadius: 1, cursor: 'pointer',
                              bgcolor: '#fffbeb', border: '1px solid #fde68a',
                              '&:hover': { bgcolor: '#fef3c7' } }}
                          >
                            {r.pending_docs.map(d => (
                              <Box key={d.id} sx={{ color: '#92400e', fontWeight: 700, fontSize: '0.64rem' }}>
                                📎 {d.source === 'request' ? d.name : `קובץ "${d.name}"`} ממתין בקבצים
                              </Box>
                            ))}
                          </Box>
                        )}
                        {r.commitment?.committed_hours != null && (
                          <Box sx={{ color: '#1d4ed8', fontWeight: 600, fontSize: '0.62rem', opacity: 0.85 }}>📋 התחייבות: {r.commitment.committed_hours}h</Box>
                        )}
                        {r.permanent_note && (
                          <Box sx={{ color: '#7c3aed', fontWeight: 700, mt: 0.3 }}>📌 {r.permanent_note}</Box>
                        )}
                        {r.manual.notes && <Box sx={{ color: 'text.primary', fontWeight: 600, mt: 0.3 }}>{r.manual.notes}</Box>}
                        {!r.commitment?.committed_hours && !r.permanent_note && !r.manual.notes && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.disabled' }}>
                            <NoteAltIcon sx={{ fontSize: 14 }} /> הוסף הערה
                          </Box>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                  if (r.is_active === false) {
                    elements.push(
                      <TableRow key={`inact-${r.employee_id}`}>
                        <TableCell colSpan={totalCols} sx={{ bgcolor: '#fff1f2', color: '#b91c1c', fontSize: '0.72rem', fontWeight: 700, py: 0.4, borderBottom: '2px solid #fecaca' }}>
                          ⛔ עובד לא פעיל{r.inactive_reason ? ` — ${r.inactive_reason}` : ' (לא נרשמה סיבה)'}
                        </TableCell>
                      </TableRow>
                    );
                  }
                }
              }
              return elements;
            })()}
          </TableBody>
        </Table>
      </TableContainer>

      <InactiveReasonDialog
        open={inactiveDlg.open}
        row={inactiveDlg.row}
        onClose={() => setInactiveDlg({ open: false, row: null })}
        onConfirm={(reason) => { if (inactiveDlg.row) setEmployeeActive(inactiveDlg.row.employee_id, false, reason); setInactiveDlg({ open: false, row: null }); }}
      />
      <TravelDialog
        open={travelDlg.open}
        row={travelDlg.row}
        disabled={travelDlg.locked}
        onClose={() => setTravelDlg({ open: false, row: null, locked: false })}
        onSave={(amount) => { if (travelDlg.row) setEmployeeTravel(travelDlg.row.employee_id, amount); setTravelDlg({ open: false, row: null, locked: false }); }}
        onClear={() => { if (travelDlg.row) setEmployeeTravel(travelDlg.row.employee_id, null); setTravelDlg({ open: false, row: null, locked: false }); }}
      />
      <AccountantContactsDialog open={acctContactsOpen} onClose={() => setAcctContactsOpen(false)} />
      <AccountantPreviewDialog open={acctPreviewOpen} month={month} branch={acctBranch}
        blocked={punchGate.blocked} blockedCount={punchGate.count}
        onClose={() => setAcctPreviewOpen(false)} onManageContacts={() => { setAcctPreviewOpen(false); setAcctContactsOpen(true); }} />
      <EmployeeNumberDialog
        open={empNumDlg.open}
        row={empNumDlg.row}
        onClose={() => setEmpNumDlg({ open: false, row: null })}
        onSave={(value) => { if (empNumDlg.row) setEmployeeNumber(empNumDlg.row.employee_id, value); setEmpNumDlg({ open: false, row: null }); }}
      />
      <BankDialog
        open={bankDlg.open}
        row={bankDlg.row}
        onClose={() => setBankDlg({ open: false, row: null })}
        onSave={(bank) => { if (bankDlg.row) setEmployeeBank(bankDlg.row.employee_id, bank); setBankDlg({ open: false, row: null }); }}
      />
      <SavedPayslipsDialog open={savedDlg.open} row={savedDlg.row} onClose={() => setSavedDlg({ open: false, row: null })} />
      <NotesDialog open={notes.open} row={notes.row} onClose={() => setNotes({ open: false, row: null })}
        onSave={(text) => notes.row && patchManual(notes.row.employee_id, { notes: text })}
        onSavePermanent={(text) => notes.row && savePermanentNote(notes.row.employee_id, text)} />
      <BonusDialog open={bonusDlg.open} row={bonusDlg.row} onClose={() => setBonusDlg({ open: false, row: null })}
        onSave={(bonus) => bonusDlg.row && patchManual(bonusDlg.row.employee_id, { bonus })} />
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
      {/* בקשות מנהלים — the managers' asks side by side with the table, with a
          jump-to-row so entering them is one glance and one click, not a tab
          switch. Read-only here: approving/rejecting stays in בקשות שינוי. */}
      <Dialog open={mgrReqDlg.open} onClose={() => setMgrReqDlg({ open: false, employeeId: null })} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          📨 בקשות מנהלים — {month}
          {mgrReqDlg.employeeId && data?.rows && (
            <Typography component="span" variant="body2" sx={{ color: 'text.secondary', mr: 1 }}>
              · {data.rows.find(x => x.employee_id === mgrReqDlg.employeeId)?.full_name || ''}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          {(() => {
            const entries = [...mgrReqByEmp.entries()]
              .filter(([empId]) => !mgrReqDlg.employeeId || empId === mgrReqDlg.employeeId);
            if (entries.length === 0) {
              return <Typography variant="body2" color="text.secondary">אין בקשות ממתינות לחודש זה.</Typography>;
            }
            return (
              <Stack spacing={1.5} sx={{ mt: 0.5 }}>
                <Alert severity="info" sx={{ borderRadius: 2, py: 0.3 }}>
                  ביצעת את העדכון בטבלה? אשר — הערך המבוקש יוחל וייסגר מול המנהל.
                  החלטת שלא לבצע? דחה עם סיבה — המנהל יראה אותה במסך "ההחלטות שלי".
                </Alert>
                {entries.map(([empId, items]) => {
                  // One card per employee, one decision strip per REQUEST (a
                  // request usually carries a single change, but never split a
                  // multi-change request here — that nuance lives in the
                  // בקשות שינוי tab).
                  const groups = [];
                  for (const it of items) {
                    let g = groups.find(x => x.request_id === it.request_id);
                    if (!g) { g = { request_id: it.request_id, items: [] }; groups.push(g); }
                    g.items.push(it);
                  }
                  return (
                    <Paper key={empId} variant="outlined" sx={{ p: 1.2, borderRadius: 2 }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700, flex: 1 }}>
                          {items[0].employee_name || data?.rows?.find(x => x.employee_id === empId)?.full_name || ''}
                        </Typography>
                        <Button size="small" variant="outlined" color="warning"
                          onClick={() => jumpToEmployee(empId)}>
                          הצג בטבלה
                        </Button>
                      </Stack>
                      {groups.map((g, gi) => (
                        <Box key={g.request_id} sx={{ pt: gi > 0 ? 1 : 0, mt: gi > 0 ? 1 : 0, borderTop: gi > 0 ? '1px solid' : 'none', borderColor: 'divider' }}>
                          {g.items.map((ch, i) => (
                            <Box key={i} sx={{ py: 0.5, borderTop: i > 0 ? '1px dashed' : 'none', borderColor: 'divider' }}>
                              <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                                <Chip size="small" variant="outlined" label={ch.field_label || FIELD_LABELS[ch.field] || ch.field}
                                  sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700 }} />
                                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                  נוכחי: <b>{fmtReqValue(ch.current_value)}</b>
                                </Typography>
                                <Typography variant="body2" sx={{ color: 'warning.dark' }}>
                                  מבוקש: <b>{fmtReqValue(ch.requested_value)}</b>
                                </Typography>
                              </Stack>
                              <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
                                {ch.requested_by_name}{ch.branch_name ? ` · ${ch.branch_name}` : ''}
                                {ch.created_at ? ` · ${new Date(ch.created_at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
                                {ch.request_note ? ` · "${ch.request_note}"` : ''}
                              </Typography>
                            </Box>
                          ))}
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.7 }}>
                            <TextField
                              size="small" fullWidth
                              placeholder="הערת החלטה למנהל (חובה בדחייה)"
                              value={mgrDecisionNotes[g.request_id] || ''}
                              onChange={(e) => setMgrDecisionNotes(prev => ({ ...prev, [g.request_id]: e.target.value }))}
                              inputProps={{ style: { fontSize: '0.8rem' } }}
                            />
                            <Button size="small" variant="contained" color="success" sx={{ whiteSpace: 'nowrap' }}
                              onClick={() => decideMgrRequest(g.request_id, 'approved')}>
                              ✓ בוצע — אשר
                            </Button>
                            <Button size="small" variant="outlined" color="error" sx={{ whiteSpace: 'nowrap' }}
                              onClick={() => decideMgrRequest(g.request_id, 'rejected')}>
                              ✗ דחה
                            </Button>
                          </Stack>
                        </Box>
                      ))}
                    </Paper>
                  );
                })}
              </Stack>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMgrReqDlg({ open: false, employeeId: null })}>סגור</Button>
        </DialogActions>
      </Dialog>
      <ClosureCompletionDetailDialog
        open={closureDetail.open}
        row={closureDetail.row}
        month={month}
        locked={closureDetail.row?.status === 'finalized'}
        onClose={() => setClosureDetail({ open: false, row: null })}
        onSaved={() => fetchData({ quiet: true })}
      />
      <SickDetailDialog
        open={sick.open}
        row={sick.row}
        month={month}
        onClose={() => setSick({ open: false, row: null })}
        onSaved={fetchData}
      />
      <EmployeeDocsDialog
        open={docsDlg.open}
        row={docsDlg.row}
        month={month}
        onClose={() => setDocsDlg({ open: false, row: null })}
        onSaved={fetchData}
      />
      <FixedSchedulesDialog
        open={fixedSchedOpen}
        onClose={() => setFixedSchedOpen(false)}
        onChanged={fetchData}
      />
      <CibusSyncDialog
        open={cibusSyncOpen}
        month={month}
        onClose={() => setCibusSyncOpen(false)}
        onChanged={fetchData}
      />
      <SpecialDaysDialog
        open={specialDaysOpen}
        month={month}
        branches={data?.branches || []}
        onClose={() => setSpecialDaysOpen(false)}
        onChanged={fetchData}
      />
      <PunchIssuesDialog
        open={issuesOpen}
        month={month}
        canFix={isAccountant || isAdmin}
        canRemind={isAccountant || isAdmin}
        onClose={() => setIssuesOpen(false)}
        onChanged={fetchData}
      />
      <PunchReviewDialog
        open={punchDlg.open}
        row={punchDlg.row}
        canApprove={isAccountant || isAdmin}
        onClose={() => setPunchDlg({ open: false, row: null })}
        onSaved={fetchData}
      />
      <PregnancyDetailDialog
        open={pregnancyDlg.open}
        row={pregnancyDlg.row}
        canManager={isManager || isAdmin}
        canAccounting={isAccountant || isAdmin}
        onClose={() => setPregnancyDlg({ open: false, row: null })}
        onSaved={fetchData}
      />
      <AbsenceDialog
        open={absence.open}
        row={absence.row}
        disabled={absence.row?.status === 'finalized'}
        canManager={isManager || isAdmin}
        canAccounting={isAccountant || isAdmin}
        onClose={() => setAbsence({ open: false, row: null })}
        onSave={(entries) => absence.row && patchApproval(absence.row.employee_id, { absence_entries: entries })}
        onSaveOffsets={(offsets) => absence.row && patchApproval(absence.row.employee_id, { absence_offset_entries: offsets })}
      />
      <PartialAbsenceDialog
        open={partialAbs.open}
        row={partialAbs.row}
        month={month}
        disabled={partialAbs.row?.status === 'finalized'}
        canAccounting={isAccountant || isAdmin}
        onClose={() => setPartialAbs({ open: false, row: null })}
        onSave={(payload) => partialAbs.row && patchApproval(partialAbs.row.employee_id, payload)}
        onExamRegistered={() => fetchData({ quiet: true })}
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

// Compact, consistent with AbsenceCell: bold day count + a status chip + caption.
function VacationCell({ row }) {
  const manualVal = Number(row.manual.vacation_days) || 0;
  const auto = row.vacation_days_auto?.total_days || 0;
  const days = row.vacation_eff_days != null ? row.vacation_eff_days : (manualVal || auto);
  const balance = row.vacation_info?.balance_from_payslip;
  const remaining = balance != null ? Math.round((balance - days) * 10) / 10 : null;
  const isGlobal = row.salary_type === 'global';
  const pay = row.vacation_pay || 0;
  // Closures she worked through: not drawn from her balance, but the month
  // should still say she came in on a day the gan was listed as shut.
  const workedOnHoliday = row.vacation_days_auto?.worked_on_holiday || [];
  const workedChip = workedOnHoliday.length > 0 && (
    <Tooltip
      arrow
      title={`עבדה בפועל ביום שמוגדר כחופשת גן — לא ירד יום מהצבירה, השכר משולם על השעות: ${
        workedOnHoliday.map(w => `${w.date} (${w.name})`).join(', ')}`}
    >
      <Chip
        size="small" color="info" variant="filled"
        label={`עבדה בחופש ${workedOnHoliday.length}`}
        sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }}
      />
    </Tooltip>
  );
  // August: the calendar's days pay nothing until applied by hand — the cell
  // still shows them as a suggestion so the accountant knows there's a
  // decision waiting behind the click.
  const pendingApply = !!row.vacation_days_auto?.pending_manual_apply;
  if (!days && balance == null && !pendingApply) {
    return workedChip || <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      {workedChip}
      {days > 0 && <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.8rem' }}>{days} ימים</Typography>}
      {pendingApply ? (
        <Tooltip title={`אוגוסט: ${auto} ימי חופשה מלוח החופשות ממתינים לאישור ידני — לא משולמים ולא נשלחים לרו״ח עד שתלחץ/י "החל לטבלת השכר" בחלונית`}>
          <Chip size="small" color="warning" variant="outlined" label={`מלוח ${auto} — לא הוחל`}
            sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }} />
        </Tooltip>
      ) : (manualVal === 0 && auto > 0 && (
        <Chip size="small" color="warning" variant="filled" label={`מלוח ${auto}`} sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }} />
      ))}
      {days > 0 && (isGlobal
        ? <Typography variant="caption" sx={{ fontSize: '0.56rem', color: 'text.secondary' }}>בשכר התקן</Typography>
        : (pay > 0 && <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'success.dark' }}>+₪{Math.round(pay).toLocaleString('he-IL')}</Typography>))}
      {balance != null && (
        <Typography variant="caption" sx={{ fontSize: '0.56rem', color: remaining < 0 ? 'error.main' : 'text.secondary' }}>
          יתרה: {remaining}
        </Typography>
      )}
    </Stack>
  );
}

// Split pay into regular / OT-125% / OT-150% for the salary columns.
// תקן: from teken_breakdown (already capped within the agreed salary).
// שעתי: hours × rate × multiplier.
function paySplit(row) {
  const tb = row.breakdown?.components?.teken_breakdown;
  const h = row.breakdown?.hours || {};
  // The server now decomposes base_salary itself (components.pay_split) and the
  // employee's own preview reads the same numbers. Prefer it, so the two screens
  // cannot drift apart; the branches below stay as the fallback for a row served
  // by an older deploy.
  const ps = row.breakdown?.components?.pay_split;
  if (ps && (row.salary_type === 'hourly' || tb)) {
    return { reg: ps.regular || 0, ot125: ps.ot_125 || 0, ot150: ps.ot_150 || 0 };
  }
  if (row.salary_type === 'global' && tb) {
    return { reg: tb.regular_pay || 0, ot125: tb.ot125_pay || 0, ot150: tb.ot150_pay || 0 };
  }
  if (row.salary_type === 'hourly') {
    // Multi-branch: each branch's hours are paid at THAT branch's rate (matches
    // the server's components.base_salary). A single primary rate would wrongly
    // pay e.g. Herzliya hours (₪45) at the home rate (₪42).
    const pb = row.breakdown?.per_branch;
    if (pb && Object.keys(pb).length) {
      let reg = 0, ot125 = 0, ot150 = 0;
      for (const b of Object.values(pb)) {
        const rt = b.hourly_rate || 0;
        reg += (b.regular_hours || 0) * rt;
        ot125 += (b.ot_125_hours || 0) * rt * 1.25;
        ot150 += (b.ot_150_hours || 0) * rt * 1.5;
      }
      return { reg, ot125, ot150 };
    }
    const rate = row.breakdown?.rates?.hourly_rate || 0;
    return {
      reg: (h.regular || 0) * rate,
      ot125: (h.ot_125 || 0) * rate * 1.25,
      ot150: (h.ot_150 || 0) * rate * 1.5,
    };
  }
  return null;
}

// Plain currency cell (used for the OT-125% / OT-150% pay columns).
function PayAmountCell({ value }) {
  if (!(value > 0)) return <Typography variant="body2" sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>—</Typography>;
  return <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.82rem' }}>{Math.round(value).toLocaleString('he-IL')} ₪</Typography>;
}

function TekenBasePartCell({ row, onOpenHours, branchPay }) {
  const tb = row.breakdown?.components?.teken_breakdown;
  const baseSalary = row.breakdown?.components?.base_salary || 0;
  const incomplete = row.breakdown?.hours?.incomplete_days || 0;
  const noHours = (row.breakdown?.hours?.total || 0) === 0;

  // שכר בסיס = pay for REGULAR hours only. OT (125%/150%) is shown in its own
  // columns; completion / supplement reconcile to the agreed salary.
  const netGross = row.salary_is_net ? 'נטו' : 'ברוטו';
  const split = paySplit(row);
  let mainValue = 0;
  let perHourLabel = null;
  let otNote = null;
  if (row.salary_type === 'global' && tb) {
    mainValue = split ? split.reg : (tb.regular_pay ?? tb.base_part);
    perHourLabel = `ערך/שעה: ${tb.hourly_value}`;
  } else if (row.salary_type === 'global') {
    // Flat global salary (no required_hours — e.g. a manager) — show the full
    // agreed salary so it isn't blank.
    mainValue = baseSalary;
    perHourLabel = 'שכר גלובלי';
  } else if (row.salary_type === 'hourly') {
    mainValue = split ? split.reg : baseSalary;
    const rate = row.breakdown?.rates?.hourly_rate;
    // Multi-branch with a different rate: a single rate label is misleading —
    // the per-branch split below carries each branch's rate instead.
    if (branchPay) perHourLabel = 'תעריף שונה לפי סניף ↓';
    else if (rate) perHourLabel = `${rate} ₪/שעה`;
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
      {(perHourLabel || (row.salary_type === 'global' || row.salary_type === 'hourly')) && (
        <Stack direction="row" spacing={0.4} alignItems="center" sx={{ flexWrap: 'nowrap' }}>
          {perHourLabel && (
            <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled', whiteSpace: 'nowrap' }}>
              {perHourLabel}
            </Typography>
          )}
          <Chip
            size="small"
            color={row.salary_is_net ? 'success' : 'info'}
            variant="filled"
            label={netGross}
            sx={{ height: 15, fontSize: '0.58rem', fontWeight: 800, '& .MuiChip-label': { px: 0.6 } }}
          />
        </Stack>
      )}
      {branchPay && (
        <Box sx={{ mt: 0.3, width: '100%', borderTop: '1px dashed #93c5fd', pt: 0.3 }}>
          {branchPay.map((o, i) => {
            const r2 = (n) => Math.round(n * 100) / 100;
            const lines = [
              { lbl: 'רגיל', h: o.reg, perHour: o.rate },
              { lbl: 'שע״נ 125%', h: o.ot125, perHour: r2(o.rate * 1.25) },
              { lbl: 'שע״נ 150%', h: o.ot150, perHour: r2(o.rate * 1.5) },
            ].filter(l => l.h > 0);
            return (
              <Box key={i} sx={{ mb: 0.4, p: 0.3, bgcolor: i % 2 ? '#f8fafc' : '#eff6ff', borderRadius: 0.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 0.5 }}>
                  <Typography component="span" variant="caption" sx={{ fontSize: '0.6rem', fontWeight: 800, color: 'text.primary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>
                    {o.name}
                  </Typography>
                  <Typography component="span" variant="caption" sx={{ fontSize: '0.62rem', fontWeight: 800, color: '#1d4ed8', whiteSpace: 'nowrap' }}>
                    ₪{o.amount.toLocaleString('he-IL')}
                  </Typography>
                </Box>
                {lines.map((l, j) => (
                  <Box key={j} sx={{ display: 'flex', justifyContent: 'space-between', gap: 0.5, lineHeight: 1.3 }}>
                    <Typography component="span" variant="caption" sx={{ fontSize: '0.54rem', color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      {l.lbl}: {l.h}ש׳ × ₪{l.perHour}
                    </Typography>
                    <Typography component="span" variant="caption" sx={{ fontSize: '0.54rem', fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      ₪{Math.round(l.h * l.perHour).toLocaleString('he-IL')}
                    </Typography>
                  </Box>
                ))}
              </Box>
            );
          })}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 0.5, borderTop: '1px solid #cbd5e1', mt: 0.2, pt: 0.2 }}>
            <Typography component="span" variant="caption" sx={{ fontSize: '0.58rem', fontWeight: 700, color: 'text.secondary' }}>סה״כ בסיס</Typography>
            <Typography component="span" variant="caption" sx={{ fontSize: '0.64rem', fontWeight: 800, color: '#0f172a' }}>
              ₪{branchPay.reduce((s, o) => s + o.amount, 0).toLocaleString('he-IL')}
            </Typography>
          </Box>
        </Box>
      )}
      {otNote && (
        <Typography variant="caption" sx={{ fontSize: '0.58rem', color: 'success.dark' }}>
          {otNote}
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

const ABSENCE_CATEGORIES = [
  { value: 'approved', label: 'מאושר',             deduct: false },
  { value: 'unpaid',   label: 'היעדרות ללא תשלום', deduct: true },
  { value: 'other',    label: 'אחר',               deduct: true },
  { value: 'sick',     label: 'מחלה',              deduct: false },
  { value: 'vacation', label: 'חופשה',             deduct: false },
  { value: 'reserve',  label: 'מילואים',           deduct: false },
  // Justified but employer-unpaid: she is paid pro-rata for the days she worked.
  // Deducts like an unpaid day, but labelled so the accountant sees WHY.
  { value: 'maternity',         label: 'חופשת לידה',        deduct: true },
  // שמירת הריון — paid by ביטוח לאומי, not the employer, and it does NOT draw
  // down her sick-day balance (hence its own category rather than 'sick').
  { value: 'pregnancy_bedrest', label: 'שמירת הריון (ב״ל)', deduct: true },
];
const absCat = (v) => ABSENCE_CATEGORIES.find(c => c.value === v) || ABSENCE_CATEGORIES[0];

// Compact absence summary in the table — count of candidate days + actual
// deduction + how many still await approval. Click opens the AbsenceDialog.
const ABSENCE_SOURCE = {
  holiday: { label: '🏖️ גן סגור / חג', color: 'info' },
  leave:   { label: '✓ חופשה/מחלה מאושרת', color: 'success' },
  unknown: { label: 'ללא סיבה — לסימון מנהל', color: 'warning' },
};

// An employee's archived payslips (created when payslips were sent to them).
// List every saved month, open one, or export several merged into one PDF.
function SavedPayslipsDialog({ open, row, onClose }) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !row) return;
    setLoading(true); setSel({});
    api.get(`/payroll/employees/${row.employee_id}/saved-payslips`)
      .then(res => setList(res.data.payslips || []))
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  }, [open, row]);
  if (!row) return null;
  const openPdf = async (ym, { download } = {}) => {
    try {
      const res = await api.get(`/payroll/employees/${row.employee_id}/saved-payslips/${ym}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      if (download) { const a = document.createElement('a'); a.href = url; a.download = `תלוש-${row.full_name}-${ym}.pdf`; a.click(); }
      else window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בפתיחת התלוש'); }
  };
  const selectedMonths = list.filter(p => sel[p.year_month]).map(p => p.year_month);
  const exportMerged = async () => {
    const months = selectedMonths.length ? selectedMonths : list.map(p => p.year_month);
    if (!months.length) return;
    setBusy(true);
    try {
      const res = await api.post(`/payroll/employees/${row.employee_id}/saved-payslips/export`, { months }, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = `תלושים-${row.full_name}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בייצוא'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>תלושים שמורים — {row.full_name}</DialogTitle>
      <DialogContent dividers>
        {loading ? <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box>
          : list.length === 0 ? <Alert severity="info">אין תלושים שמורים לעובד/ת זה. תלוש נשמר אוטומטית כששולח/ים אותו לעובד/ת.</Alert>
          : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell sx={{ fontWeight: 700 }}>חודש</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>נשלח</TableCell>
                  <TableCell align="center" />
                </TableRow>
              </TableHead>
              <TableBody>
                {list.map(p => (
                  <TableRow key={p.year_month} hover>
                    <TableCell padding="checkbox"><Checkbox size="small" checked={!!sel[p.year_month]} onChange={() => setSel(s => ({ ...s, [p.year_month]: !s[p.year_month] }))} /></TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{p.year_month}</TableCell>
                    <TableCell>{p.branch || '—'}</TableCell>
                    <TableCell><Typography variant="caption">{p.sent_at ? new Date(p.sent_at).toLocaleDateString('he-IL') : '—'}</Typography></TableCell>
                    <TableCell align="center">
                      <Button size="small" onClick={() => openPdf(p.year_month)} sx={{ minWidth: 0, fontSize: 11 }}>הצג</Button>
                      <Button size="small" onClick={() => openPdf(p.year_month, { download: true })} sx={{ minWidth: 0, fontSize: 11 }}>הורד</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </DialogContent>
      <DialogActions>
        <Button onClick={exportMerged} variant="contained" disabled={busy || loading || list.length === 0}>
          ייצא {selectedMonths.length ? `נבחרים (${selectedMonths.length})` : 'הכל'} כ-PDF אחד
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}

function AbsenceCell({ row }) {
  const ab = row.absence;
  const days = ab?.days || [];
  const ded = ab?.deduction || 0;
  const byDate = new Map((ab?.entries || []).map(e => [e.date, e]));
  // A day given a non-deductible reason (מאושר / מחלה / חופשה / מילואים) is
  // settled — it's no longer an open absence and drops out of the count.
  const settled = (a) => {
    const e = byDate.get(a.date);
    return e && !absCat(e.category).deduct;
  };
  const open = days.filter(a => !settled(a));     // still need attention / deduct
  const approvedCount = days.length - open.length;
  if (!open.length && !ded) {
    return approvedCount > 0
      ? <Typography variant="caption" sx={{ color: 'success.dark', fontSize: '0.62rem', fontWeight: 700 }}>✓ מאושר</Typography>
      : <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  const noReason = open.filter(a => { const e = byDate.get(a.date); return !((e?.note || '').trim()); }).length;
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.8rem' }}>{open.length} ימים</Typography>
      {noReason > 0 && <Chip size="small" color="warning" variant="filled" label={`${noReason} ללא סיבה`} sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }} />}
      {ded > 0 && <Typography variant="caption" sx={{ color: 'error.main', fontSize: '0.62rem' }}>−₪{Math.round(ded).toLocaleString('he-IL')}</Typography>}
    </Stack>
  );
}

// Partial-day absence cell: days the employee worked but came up > 1h short of
// their committed hours. Shows approved hours + ₪ deduction + how many days
// still await accounting approval. Click opens PartialAbsenceDialog.
function PartialAbsenceCell({ row }) {
  const pa = row.partial_absence;
  const cands = pa?.candidates || [];
  const extra = pa?.extra_hours || 0; // over-commitment + off-day work
  if (!cands.length && extra <= 0) return <Typography variant="body2" color="text.secondary">—</Typography>;
  const ded = pa.deduction || 0;
  // Total flagged shortfall vs. what actually gets deducted after excused days
  // are removed and the made-up cap applied. Show the DEDUCTIBLE figure — the
  // hours to actually offset per what accounting approved — not the raw total.
  const totalHours = pa.total_shortfall_hours != null
    ? pa.total_shortfall_hours
    : Math.round(cands.reduce((s, c) => s + (c.shortfall_h || 0), 0) * 10) / 10;
  const deductHours = pa.effective_hours != null ? pa.effective_hours : totalHours;
  const excusedCount = pa.excused_count || 0;
  return (
    <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
      {deductHours > 0 && <Chip size="small" color="warning" label={`${deductHours} ש׳ לקיזוז`} sx={{ height: 18, fontSize: '0.6rem', fontWeight: 700 }} />}
      {deductHours <= 0 && totalHours > 0 && !pa.made_up && <Chip size="small" color="success" variant="outlined" label="✓ אין קיזוז" sx={{ height: 16, fontSize: '0.58rem', fontWeight: 700 }} />}
      {excusedCount > 0 && <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.55rem' }}>{excusedCount} אושרו · מתוך {totalHours} ש׳</Typography>}
      {/* Extra hours FOUND are not extra hours PAID — green + a plus sign is
          the language of money already granted, so unpaid extras stay gray
          and say so until the accountant approves them in the dialog. */}
      {extra > 0 && (pa.extra_approved_hours || 0) <= 0 && (
        <Tooltip title="שעות מעבר להתחייבות שנמצאו — לא אושרו לתשלום (ברירת מחדל: לא משולם). לחץ/י לאישור">
          <Chip size="small" color="default" variant="outlined" label={`${extra} ש׳ תוספת — לא אושר`} sx={{ height: 16, fontSize: '0.58rem', fontWeight: 700 }} />
        </Tooltip>
      )}
      {extra > 0 && (pa.extra_approved_hours || 0) > 0 && (
        <Chip size="small" color="success" variant="outlined"
          label={`+${pa.extra_approved_hours}${pa.extra_approved_hours < extra ? ` מתוך ${extra}` : ''} ש׳ תוספת`}
          sx={{ height: 16, fontSize: '0.58rem', fontWeight: 700 }} />
      )}
      {pa.made_up && ded === 0 && totalHours > 0 && <Chip size="small" color="success" variant="outlined" label="✓ הושלם" sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }} />}
      {(pa.extra_approved_hours || 0) > 0 && <Typography variant="caption" sx={{ color: 'success.dark', fontSize: '0.62rem', fontWeight: 700 }}>שולם: +{pa.extra_approved_hours} ש׳</Typography>}
      {ded > 0 && <Typography variant="caption" sx={{ color: 'error.main', fontSize: '0.62rem', fontWeight: 700 }}>−₪{Math.round(ded).toLocaleString('he-IL')}</Typography>}
    </Stack>
  );
}

// Per-day partial-absence review (תקן only). Every short day is deducted by
// default; the accountant marks days as EXCUSED (justified, optional reason) so
// they are NOT deducted. Unexcused hours are deducted at the committed hourly
// value, capped at the net monthly deficit (made-up hours aren't charged). Also
// shows overtime worked beyond the commitment.
function PartialAbsenceDialog({ open, row, month, disabled, canAccounting, onClose, onSave, onExamRegistered }) {
  const [excused, setExcused] = useState({});
  const [reasons, setReasons] = useState({});
  const [extraAppr, setExtraAppr] = useState({});
  const [extraReasons, setExtraReasons] = useState({});
  // Dates turned into an approved pregnancy-exam entry DURING this dialog
  // session — shown excused immediately, before the table refetch catches up.
  const [examRegistered, setExamRegistered] = useState({});
  const [examBusy, setExamBusy] = useState({});
  useEffect(() => {
    if (!open || !row) return;
    const ex = {}, rs = {}, ea = {}, er = {};
    (row.partial_absence?.candidates || []).forEach(c => { ex[c.date] = !!c.excused; rs[c.date] = c.reason || ''; });
    (row.partial_absence?.extra_candidates || []).forEach(c => { ea[c.date] = !!c.approved; er[c.date] = c.reason || ''; });
    setExcused(ex); setReasons(rs); setExtraAppr(ea); setExtraReasons(er);
    setExamRegistered({}); setExamBusy({});
  }, [open, row]);

  const isPregnant = !!row?.pregnancy?.is_pregnant;

  // One click from tidy: a short day of a pregnant employee becomes an
  // APPROVED pregnancy-exam entry for exactly the missing hours — recorded in
  // the 40h tracker (§7), certificate attachable there, and the day stops
  // being deducted. The server auto-excuses any day with an approved exam.
  const registerAsExam = async (c) => {
    setExamBusy(b => ({ ...b, [c.date]: true }));
    try {
      const res = await api.post('/employee-requests/admin', {
        employee_id: row.employee_id,
        type: 'pregnancy_exam',
        from_date: c.date,
        to_date: c.date,
        exam_hours: c.shortfall_h,
        reason: 'נרשם מתוך היעדרויות שעות — חוסר יום בדיקה',
      });
      const attachedDoc = res.data?.auto_attached_doc;
      toast.success(
        `${c.shortfall_h} ש׳ נרשמו כבדיקת היריון ב-${c.date} — היום לא יקוזז, והשעות נספרות במעקב 40 השעות`
        + (attachedDoc ? ` · האישור "${attachedDoc}" צורף אוטומטית לפי שם הקובץ` : ''),
        { autoClose: 8000 },
      );
      setExamRegistered(prev => ({ ...prev, [c.date]: true }));
      setExcused(prev => ({ ...prev, [c.date]: true }));
      setReasons(prev => ({ ...prev, [c.date]: prev[c.date] || 'בדיקת היריון' }));
      onExamRegistered?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'רישום הבדיקה נכשל');
    } finally {
      setExamBusy(b => ({ ...b, [c.date]: false }));
    }
  };
  if (!row) return null;
  const pa = row.partial_absence || {};
  const cands = pa.candidates || [];
  const extras = pa.extra_candidates || [];
  const hv = pa.hourly_value || 0;
  const fmtDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };
  // Approved extra (over-commitment / off-day) hours are PAID — computed LIVE
  // from the current selections.
  const extraApprovedHours = Math.round(extras.filter(c => extraAppr[c.date]).reduce((s, c) => s + c.hours, 0) * 100) / 100;
  const extraPay = Math.round(extraApprovedHours * hv);
  // Net deficit EXCLUDES approved-paid extra from the make-up pool (mirrors the
  // server): hours approved for payment are paid separately, so they no longer
  // cancel the shortfall. Recomputed LIVE here so the preview updates as you
  // approve extra — not the server's value from before the approval.
  const worked = pa.worked_hours || 0;
  const committed = pa.committed_hours || 0;
  const netDeficit = Math.max(0, Math.round((committed - (worked - extraApprovedHours)) * 100) / 100);
  // Unexcused hours are deducted; cap at the net deficit (made-up offset).
  const deductHours = Math.round(cands.filter(c => !excused[c.date]).reduce((s, c) => s + c.shortfall_h, 0) * 100) / 100;
  const effectiveHours = Math.round(Math.min(deductHours, netDeficit) * 100) / 100;
  const deduction = Math.round(effectiveHours * hv);
  const cappedByMakeup = deductHours > effectiveHours;
  const kindLabel = (k) => (k === 'offday' ? 'יום חופשי' : 'מעבר להתחייבות');
  const save = () => onSave({
    partial_absence_entries: cands.map(c => ({ date: c.date, excused: !!excused[c.date], reason: (reasons[c.date] || '').trim() })),
    partial_extra_entries: extras.map(c => ({ date: c.date, approved: !!extraAppr[c.date], reason: (extraReasons[c.date] || '').trim() })),
  });
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>היעדרות שעות — {row.full_name} ({month})</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {row.salary_type !== 'global' ? (
            <Alert severity="info">רלוונטי לעובדי תקן בלבד — עובד/ת שעתי/ת מקבל/ת תשלום לפי שעות בפועל.</Alert>
          ) : (
            <>
              {(() => {
                // Net summary reflecting the current approve/excuse selections:
                // approved extra hours minus the shortfall hours that will be deducted.
                const netHours = Math.round((extraApprovedHours - effectiveHours) * 10) / 10;
                const netPay = extraPay - deduction;
                const c = netHours > 0 ? '#15803d' : netHours < 0 ? '#b91c1c' : '#64748b';
                return (
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, borderWidth: 2,
                    borderColor: netHours > 0 ? 'success.light' : netHours < 0 ? 'error.light' : 'divider', bgcolor: '#f8fafc' }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.8 }}>סיכום נטו (לפי המאושר)</Typography>
                    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Box sx={{ textAlign: 'center' }}>
                        <Typography variant="caption" color="text.secondary">תוספת מאושרת</Typography>
                        <Typography sx={{ fontWeight: 700, fontSize: 18, color: 'success.dark' }}>+{extraApprovedHours} ש׳</Typography>
                      </Box>
                      <Typography sx={{ fontSize: 22, color: 'text.disabled' }}>−</Typography>
                      <Box sx={{ textAlign: 'center' }}>
                        <Typography variant="caption" color="text.secondary">חוסר לקיזוז</Typography>
                        <Typography sx={{ fontWeight: 700, fontSize: 18, color: 'error.main' }}>{effectiveHours} ש׳</Typography>
                      </Box>
                      <Typography sx={{ fontSize: 22, color: 'text.disabled' }}>=</Typography>
                      <Box sx={{ textAlign: 'center', px: 2.5, py: 0.6, borderRadius: 2, minWidth: 120,
                        bgcolor: netHours > 0 ? '#dcfce7' : netHours < 0 ? '#fee2e2' : '#f1f5f9' }}>
                        <Typography variant="caption" sx={{ fontWeight: 700 }}>נטו</Typography>
                        <Typography sx={{ fontWeight: 900, fontSize: 30, lineHeight: 1.05, color: c }}>
                          {netHours > 0 ? '+' : ''}{netHours} <span style={{ fontSize: 16 }}>ש׳</span>
                        </Typography>
                        <Typography variant="caption" sx={{ fontWeight: 800, color: c }}>
                          {netPay >= 0 ? '+' : '−'}₪{Math.abs(netPay).toLocaleString('he-IL')}
                        </Typography>
                      </Box>
                    </Stack>
                  </Paper>
                );
              })()}
              {extras.length > 0 && (
                <>
                  <Alert severity="success" icon={false} sx={{ py: 0.5 }}>
                    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ fontSize: 13 }}>
                      <span>תוספת שעות (מעבר/יום חופשי): <b>{pa.extra_hours} ש׳</b></span>
                      <span>אושרו לתשלום: <b>{extraApprovedHours} ש׳</b></span>
                      <span>תשלום תוספת: <b style={{ color: '#15803d' }}>+₪{extraPay.toLocaleString('he-IL')}</b></span>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      ברירת מחדל: לא משולם. סמן/י "מאושר" כדי <b>לשלם</b> את שעות התוספת (עם סיבה אופציונלית).
                    </Typography>
                  </Alert>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>תאריך</TableCell>
                        <TableCell align="center">סוג</TableCell>
                        <TableCell align="center">התחייבות</TableCell>
                        <TableCell align="center">עבד/ה</TableCell>
                        <TableCell align="center">תוספת</TableCell>
                        <TableCell align="center">מאושר (לשלם)</TableCell>
                        <TableCell>סיבה (אופציונלי)</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {extras.map(c => (
                        <TableRow key={c.date} sx={extraAppr[c.date] ? { bgcolor: '#ecfdf5' } : undefined}>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(c.date)}</TableCell>
                          <TableCell align="center"><Chip size="small" variant="outlined" color={c.kind === 'offday' ? 'info' : 'success'} label={kindLabel(c.kind)} sx={{ height: 18, fontSize: '0.6rem' }} /></TableCell>
                          <TableCell align="center">{c.kind === 'offday' ? '—' : `${c.committed_h} ש׳`}</TableCell>
                          <TableCell align="center">{c.worked_h} ש׳</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 700, color: 'success.dark' }}>+{c.hours} ש׳</TableCell>
                          <TableCell align="center">
                            <Checkbox size="small" color="success" checked={!!extraAppr[c.date]} disabled={disabled || !canAccounting}
                              onChange={e => setExtraAppr(a => ({ ...a, [c.date]: e.target.checked }))} />
                          </TableCell>
                          <TableCell>
                            <TextField size="small" variant="standard" placeholder="סיבה…" fullWidth
                              value={extraReasons[c.date] || ''} disabled={disabled || !canAccounting}
                              onChange={e => setExtraReasons(a => ({ ...a, [c.date]: e.target.value }))} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
              {cands.length === 0 ? (
                <Typography variant="body2" color="text.secondary">אין ימים עם חוסר מעל שעה מההתחייבות החודש. ✓</Typography>
              ) : (
                <>
                  <Alert severity="warning" icon={false} sx={{ py: 0.5 }}>
                    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ fontSize: 13 }}>
                      <span>התחייבות חודשית: <b>{pa.committed_hours} ש׳</b></span>
                      <span>עבד/ה בפועל: <b>{pa.worked_hours} ש׳</b></span>
                      <span>ערך שעה: <b>₪{hv.toLocaleString('he-IL')}</b></span>
                      <span>שעות לקיזוז (לא מאושרות): <b>{deductHours}</b></span>
                      <span>ניכוי בפועל: <b style={{ color: '#b91c1c' }}>−₪{deduction.toLocaleString('he-IL')}</b></span>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      ברירת מחדל: כל יום חוסר מקוזז. סמן/י "מאושר" כדי <b>לא</b> לקזז יום (עם סיבה אופציונלית).
                      {cappedByMakeup && ` חלק מהשעות הושלמו בימים אחרים — הניכוי מוגבל לחוסר נטו (${netDeficit} ש׳).`}
                    </Typography>
                  </Alert>
                  {isPregnant && (
                    <Alert severity="info" icon="🤰" sx={{ py: 0.5, borderRadius: 2 }}>
                      עובדת בהריון: יום חוסר עם <b>בדיקת היריון מאושרת</b> לא מקוזז — השעות משולמות במלואן לפי חוק
                      ונספרות במעקב 40 השעות. "רשום כבדיקה" הופך יום חוסר לבדיקה מאושרת בלחיצה אחת;
                      את האישור הרפואי מצרפים במעקב ההיריון.
                    </Alert>
                  )}
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>תאריך</TableCell>
                        <TableCell align="center">התחייבות</TableCell>
                        <TableCell align="center">עבד/ה</TableCell>
                        <TableCell align="center">חוסר</TableCell>
                        <TableCell align="center">מאושר (לא לקזז)</TableCell>
                        <TableCell>סיבה (אופציונלי)</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {cands.map(c => {
                        const exam = c.pregnancy_exam || null;
                        const examApproved = (!!exam && exam.status === 'approved') || !!examRegistered[c.date];
                        const examPending = !!exam && !examApproved;
                        return (
                          <TableRow key={c.date} sx={excused[c.date] ? { bgcolor: examApproved ? '#fdf2f8' : '#ecfdf5' } : undefined}>
                            <TableCell sx={{ whiteSpace: 'nowrap' }}>
                              {fmtDate(c.date)}
                              {examApproved && (
                                <Tooltip title="בדיקת היריון מאושרת — השעות משולמות לפי חוק ונספרות במעקב 40 השעות">
                                  <Chip size="small" label="🤰 בדיקה מאושרת" sx={{ height: 16, fontSize: '0.55rem', fontWeight: 700, mr: 0.5, bgcolor: '#fce7f3', color: '#9d174d' }} />
                                </Tooltip>
                              )}
                              {examPending && (
                                <Tooltip title="נרשמה בדיקת היריון ליום זה אך היא עדיין ממתינה לאישור — היום עדיין מקוזז. אשרו במעקב ההיריון">
                                  <Chip size="small" color="warning" variant="outlined" label="🤰 בדיקה ממתינה" sx={{ height: 16, fontSize: '0.55rem', fontWeight: 700, mr: 0.5 }} />
                                </Tooltip>
                              )}
                            </TableCell>
                            <TableCell align="center">{c.committed_h} ש׳</TableCell>
                            <TableCell align="center">{c.worked_h} ש׳</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 700, color: excused[c.date] ? 'text.disabled' : 'error.main' }}>{c.shortfall_h} ש׳</TableCell>
                            <TableCell align="center">
                              {/* An approved exam excuses the day by law — the server
                                  enforces it regardless, so the checkbox is locked
                                  rather than pretending the choice exists. */}
                              <Checkbox size="small" color="success" checked={!!excused[c.date]} disabled={disabled || !canAccounting || examApproved}
                                onChange={e => setExcused(a => ({ ...a, [c.date]: e.target.checked }))} />
                            </TableCell>
                            <TableCell>
                              <Stack direction="row" spacing={0.5} alignItems="center">
                                <TextField size="small" variant="standard" placeholder="סיבה…" fullWidth
                                  value={reasons[c.date] || ''} disabled={disabled || !canAccounting || examApproved}
                                  onChange={e => setReasons(a => ({ ...a, [c.date]: e.target.value }))} />
                                {isPregnant && !exam && !examRegistered[c.date] && canAccounting && !disabled && (
                                  <Button size="small" variant="outlined" disabled={!!examBusy[c.date]}
                                    onClick={() => registerAsExam(c)}
                                    sx={{ whiteSpace: 'nowrap', fontSize: '0.65rem', color: '#9d174d', borderColor: '#f9a8d4' }}>
                                    {examBusy[c.date] ? '…' : '🤰 רשום כבדיקה'}
                                  </Button>
                                )}
                              </Stack>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
        {(cands.length > 0 || extras.length > 0) && canAccounting && !disabled && (
          <Button variant="contained" color="warning" onClick={save}>שמור</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// Per-day absence review. Holiday / approved-leave days are shown auto-justified
// (read-only, no deduction). UNKNOWN-reason days get a reason + manager/accounting
// approval; deducted at the uniform daily rate only when both approve a
// deductible category.
function AbsenceDialog({ open, row, disabled, canManager, canAccounting, onClose, onSave, onSaveOffsets }) {
  const [entries, setEntries] = useState({});
  const [offsetState, setOffsetState] = useState({});
  useEffect(() => {
    if (!row) return;
    const byDate = {};
    for (const e of (row.absence?.entries || [])) byDate[e.date] = { ...e };
    const init = {};
    for (const a of (row.absence?.days || [])) {
      if (a.source !== 'unknown') continue;
      // The server pre-selects a reason for days it can explain (maternity leave /
      // שמירת הריון); anything else defaults to unpaid until the accountant sets it.
      init[a.date] = byDate[a.date] || {
        date: a.date,
        category: a.suggested_category || 'unpaid',
        note: '', manager_approved: false, accounting_approved: false,
      };
    }
    setEntries(init);
    const o = {};
    for (const s of (row.absence?.offset_suggestions || [])) o[s.absence_date] = { extra_date: s.extra_date, approved: !!s.approved };
    setOffsetState(o);
  }, [row]);
  const toggleOffset = (s, approved) => {
    const next = { ...offsetState, [s.absence_date]: { extra_date: s.extra_date, approved } };
    setOffsetState(next);
    onSaveOffsets && onSaveOffsets(Object.entries(next).map(([absence_date, v]) => ({ absence_date, extra_date: v.extra_date, approved: !!v.approved })));
  };
  if (!row) return null;
  const days = row.absence?.days || [];
  const dailyRate = row.absence?.daily_rate || 0;
  const update = (date, patch) => {
    const next = { ...entries, [date]: { ...entries[date], date, ...patch } };
    setEntries(next);
    onSave(Object.values(next)); // only unknown-day entries are tracked in state
  };
  // Default = deduct. A day is deducted when its category is deductible (unpaid)
  // and it isn't offset against extra hours — no approval gate.
  const offApprovedDate = (d) => !!(offsetState[d] && offsetState[d].approved);
  const deduction = Object.values(entries).reduce((s, e) =>
    s + ((absCat(e.category).deduct && !offApprovedDate(e.date)) ? dailyRate : 0), 0);
  // A day is "handled" (טופל) once accounting entered a reason for it. Track the
  // count so the accountant can verify every absent day got a reason.
  const isHandled = (e) => !!((e?.note || '').trim());
  const unknownDays = days.filter(a => a.source === 'unknown');
  const handledCount = unknownDays.filter(a => isHandled(entries[a.date])).length;
  const allHandled = unknownDays.length > 0 && handledCount === unknownDays.length;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>היעדרויות — {row.full_name}</DialogTitle>
      <DialogContent>
        {days.length === 0 ? (
          <Alert severity="success" sx={{ mt: 1 }}>אין ימי היעדרות החודש — כל ימי ההתחייבות מולאו.</Alert>
        ) : (
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ py: 0.5 }}>
              תעריף יום: ₪{Math.round(dailyRate).toLocaleString('he-IL')} · ניכוי מצטבר: <b>−₪{Math.round(deduction).toLocaleString('he-IL')}</b>
            </Alert>
            {unknownDays.length > 0 && (
              <Alert severity={allHandled ? 'success' : 'warning'} icon={false} sx={{ py: 0.5 }}>
                {allHandled
                  ? <><b>✓ כל ימי ההיעדרות טופלו</b> — הנה״ח הזינה סיבה לכל {unknownDays.length} הימים.</>
                  : <>טופלו <b>{handledCount}</b> מתוך <b>{unknownDays.length}</b> ימים · נותרו <b>{unknownDays.length - handledCount}</b> ללא סיבה מהנה״ח.</>}
              </Alert>
            )}
            {days.map(({ date: d, source }) => {
              const src = ABSENCE_SOURCE[source] || ABSENCE_SOURCE.unknown;
              if (source !== 'unknown') {
                return (
                  <Paper key={d} variant="outlined" sx={{ p: 1, borderRadius: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ fontWeight: 700, minWidth: 90 }}>{d}</Typography>
                    <Chip size="small" color={src.color} variant="outlined" label={src.label} />
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>בתשלום (מוצדק)</Typography>
                  </Paper>
                );
              }
              const e = entries[d] || {};
              const cat = absCat(e.category);
              const handled = isHandled(e);
              const offApproved = offApprovedDate(d);
              return (
                <Paper key={d} variant="outlined" sx={{ p: 1, borderRadius: 2, borderColor: handled ? 'success.light' : 'warning.light', bgcolor: handled ? '#f6fdf9' : undefined }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography sx={{ fontWeight: 700, minWidth: 90 }}>{d}</Typography>
                    <Chip size="small" color={handled ? 'success' : 'warning'} variant={handled ? 'filled' : 'outlined'} label={handled ? '✓ טופל' : 'ללא סיבה'} sx={{ height: 18, fontWeight: 700 }} />
                    <TextField select size="small" label="סיבה" value={e.category || 'unpaid'} disabled={disabled}
                      onChange={ev => update(d, { category: ev.target.value })} sx={{ minWidth: 160 }}>
                      {ABSENCE_CATEGORIES.map(c => <MenuItem key={c.value} value={c.value}>{c.label}{c.deduct ? ' (מנכה)' : ''}</MenuItem>)}
                    </TextField>
                    <TextField size="small" label="הערה" value={e.note || ''} disabled={disabled}
                      onChange={ev => update(d, { note: ev.target.value })} sx={{ flex: 1, minWidth: 110 }} />
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.7 }}>
                    <Typography variant="caption" color="text.secondary">
                      {cat.deduct ? 'ברירת מחדל: מנכה — בחר/י סיבה מוצדקת כדי לא לנכות' : 'סיבה מוצדקת — בתשלום'}
                    </Typography>
                    {offApproved
                      ? <Chip size="small" color="success" variant="outlined" label="מקוזז מול תוספת" sx={{ ml: 'auto' }} />
                      : cat.deduct
                        ? <Chip size="small" color="error" variant="outlined" label={`מנכה −₪${Math.round(dailyRate).toLocaleString('he-IL')}`} sx={{ ml: 'auto' }} />
                        : <Chip size="small" color="success" variant="outlined" label="בתשלום" sx={{ ml: 'auto' }} />}
                  </Stack>
                </Paper>
              );
            })}
            {(row.absence?.offset_suggestions || []).length > 0 && (
              <Box>
                <Divider sx={{ mb: 1 }} />
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>קיזוז מול תוספת שעות</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
                  ימי היעדרות שהושלמו ע״י תוספת שעות בהיקף דומה (±שעה). אישור = ההיעדרות לא תקוזז והתוספת לא תשולם (מתקזזות).
                </Typography>
                <Stack spacing={1}>
                  {row.absence.offset_suggestions.map(s => {
                    const st = offsetState[s.absence_date] || { approved: false };
                    return (
                      <Paper key={s.absence_date} variant="outlined" sx={{ p: 1, borderRadius: 2, display: 'flex', alignItems: 'center', gap: 1,
                        borderColor: st.approved ? 'success.light' : 'divider', bgcolor: st.approved ? '#f0fdf4' : undefined }}>
                        <Checkbox size="small" checked={!!st.approved} disabled={disabled || !canAccounting}
                          onChange={e => toggleOffset(s, e.target.checked)} />
                        <Box sx={{ flex: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>
                            היעדרות {s.absence_date} ({s.committed_h} ש׳) ↔ תוספת {s.extra_date} ({s.extra_h} ש׳)
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            סיבה אוטומטית: "הושלם ע״י תוספת שעות ב-{s.extra_date}"
                          </Typography>
                        </Box>
                        {st.approved && <Chip size="small" color="success" label="מקוזז" sx={{ height: 18 }} />}
                      </Paper>
                    );
                  })}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}

function HolidayPayCell({ row }) {
  const auto = row.holiday_pay_auto || { total_days: 0, total_pay: 0, is_eligible: false, blocking_reason: null };
  const manualVal = Number(row.manual.holiday_pay) || 0;
  const amount = manualVal > 0 ? manualVal : (auto.total_pay || 0);
  // Paid (eligible or manually entered) — bold amount + a green "N ימי חג" chip.
  if (amount > 0) {
    return (
      <Stack spacing={0.2} alignItems="center" sx={{ lineHeight: 1.15 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.82rem', color: 'success.dark' }}>
          {Math.round(amount).toLocaleString('he-IL')} ₪
        </Typography>
        {auto.total_days > 0 && (
          <Chip size="small" color="success" variant="filled" label={`${auto.total_days} ימי חג`} sx={{ height: 15, fontSize: '0.55rem', fontWeight: 700 }} />
        )}
        {manualVal > 0 && <Typography variant="caption" sx={{ fontSize: '0.55rem', color: 'text.secondary' }}>ידני</Typography>}
      </Stack>
    );
  }
  // Global employees get holiday pay through their salary — not a separate line.
  if (row.salary_type === 'global') {
    return <Typography variant="caption" sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>בשכר</Typography>;
  }
  // Not eligible — show a short reason on hover.
  return (
    <Tooltip title={auto.blocking_reason || 'לא זכאי החודש'}>
      <Chip size="small" color="default" variant="outlined" label="לא זכאי" sx={{ height: 15, fontSize: '0.55rem', cursor: 'help' }} />
    </Tooltip>
  );
}

function LoansSummaryCell({ row }) {
  const info = row.loans_info || { count: 0, month_deduction: 0, loans: [] };
  if (info.count === 0 && info.loans.length === 0) {
    return <Box sx={{ color: 'text.disabled', fontSize: '0.78rem' }}>—</Box>;
  }
  const active = info.count;
  const monthDed = info.month_deduction;
  // month-aware "payment X of Y" — only meaningful when a single loan is deducting this month
  const payingLoans = (info.loans || []).filter(l => l.month_amount > 0);
  const prog = payingLoans.length === 1 && payingLoans[0].paying_installments > 0
    ? `תשלום ${payingLoans[0].installment_index}/${payingLoans[0].paying_installments}`
    : null;
  return (
    <Stack spacing={0.3} alignItems="center">
      {monthDed > 0 ? (
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'error.dark', fontSize: '0.78rem' }}>
          -{Math.round(monthDed).toLocaleString('he-IL')} ₪
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.disabled', fontSize: '0.78rem' }}>—</Typography>
      )}
      {prog && (
        <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary', lineHeight: 1 }}>{prog}</Typography>
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
  // Only approved rows are in `totals`. A branch manager's entry waits here,
  // and the chips alone would show nothing — the accountant has to be able to
  // see that something is asking for a decision.
  const pending = (row.adjustments || []).filter(a => a.status === 'pending').length;
  const hasAny = totals.money_add !== 0 || totals.money_deduct !== 0 || totals.hours_delta !== 0;
  return (
    <Stack direction="row" spacing={0.3} alignItems="center" justifyContent="center" flexWrap="wrap" useFlexGap>
      {pending > 0 && (
        <Chip size="small" color="warning" variant="outlined" label={`${pending} לאישור`}
          onClick={onOpen} sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700 }} />
      )}
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
  const cells = ['ימי עבודה', 'שעות רגילות', 'שע״נ א\'', 'שע״נ ב\'', 'שכר שעתי', 'שכר תקן'];
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
    {cell(global, { last: true })}
  </>);
}
