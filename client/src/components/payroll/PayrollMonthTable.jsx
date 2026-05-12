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
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/* ─────────────────────────────────────────────────────────────────────────
   Monthly payroll table — auto-calculated per-amuta hours from punches,
   editable manual fields per employee per month, and admin-defined custom
   columns specific to a month (or all months).
   ──────────────────────────────────────────────────────────────────────── */

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
  if (row.manual.travel_override != null) return row.manual.travel_override;
  const days = row.breakdown?.hours?.days_worked || 0;
  if (row.travel_mode === 'per_day') {
    const perDay = row.travel_per_day || 16; // default 16₪/day if unset
    return perDay * days;
  }
  if (row.travel_mode === 'monthly_flat') return row.travel_monthly_flat || 0;
  return 16 * days;
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

/* ─── Main component ────────────────────────────────────────────────── */

export default function PayrollMonthTable() {
  const { selectedBranch, selectedBranchName, isAllBranches } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [viewMode, setViewMode] = useState('branch'); // 'branch' | 'amuta'
  const [selectedAmuta, setSelectedAmuta] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [presets, setPresets] = useState([]);
  const [notes, setNotes] = useState({ open: false, row: null });
  const [addCol, setAddCol] = useState(false);

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
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, manual: { ...r.manual, ...patch } } : r),
      };
    });
    api.patch(`/payroll-month/${employeeId}`, { manual: patch }, { params: { month } })
      .catch(err => { toast.error(err.response?.data?.error || 'שמירה נכשלה'); fetchData(); });
  }, [month, fetchData]);

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

  const removeColumn = (colId) => {
    if (!confirm('להסיר את העמודה? הנתונים שהוזנו לעובדים יישמרו בבסיס הנתונים.')) return;
    api.delete(`/payroll-month/custom-columns/${colId}`)
      .then(() => fetchData())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const finalize = () => {
    if (!confirm('לנעול את החודש?')) return;
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

  /* CSV export — replicates the bookkeeper's spreadsheet layout */
  const exportCSV = () => {
    if (!data) return;
    const rowsAcc = [];
    const cols = ['ימי עבודה', 'שעות רגילות', 'שע"נ א\'', 'שע"נ ב\'', 'שכר שעתי', 'שכר גלובלי', 'שע"נ גלובלי'];

    const headerTop = ['סניף', 'שם העובד'];
    for (const b of visibleBranches) headerTop.push(b.name, ...Array(6).fill(''));
    headerTop.push(...['נסיעות', 'מחלה', 'היעדרות', 'חופשה', 'דמי חגים', 'קיזוז מקדמה', 'GIFT CARD', 'הבראה', 'סיבוס', 'מילואים']);
    for (const c of customColumns) headerTop.push(c.label);
    headerTop.push('הערות');
    rowsAcc.push(headerTop);

    const subHdr = ['', ''];
    for (const _b of visibleBranches) subHdr.push(...cols);
    subHdr.push(...Array(10).fill(''));
    for (const _c of customColumns) subHdr.push('');
    subHdr.push('');
    rowsAcc.push(subHdr);

    for (const r of data.rows) {
      const cells = [r.branch_name, r.full_name];
      for (const b of visibleBranches) {
        const bk = r.breakdown.per_branch?.[b.id];
        if (bk) {
          cells.push(bk.days_worked, bk.regular_hours, bk.ot_125_hours, bk.ot_150_hours, bk.hourly_rate || '', bk.global_salary || '', bk.global_ot_rate || '');
        } else { cells.push('', '', '', '', '', '', ''); }
      }
      cells.push(
        computeTravel(r),
        r.manual.sick_days || '', r.manual.absence_days || '', r.manual.vacation_days || '', r.manual.holiday_pay || '',
        r.manual.advance_deduction_preset?.label || r.manual.advance_deduction_text || '',
        r.manual.gift_card?.kind === 'number' ? r.manual.gift_card.amount : (r.manual.gift_card?.text || ''),
        r.manual.recreation?.kind === 'number' ? r.manual.recreation.amount : (r.manual.recreation?.text || ''),
        r.manual.cibus?.kind === 'number' ? r.manual.cibus.amount : (r.manual.cibus?.text || ''),
        r.manual.miluim?.kind === 'number' ? r.manual.miluim.amount : (r.manual.miluim?.text || ''),
      );
      for (const c of customColumns) {
        const v = r.manual.custom_values?.[c.id];
        if (!v || v.kind === 'empty') cells.push('');
        else if (v.kind === 'number') cells.push(v.amount);
        else cells.push(v.text);
      }
      cells.push(r.manual.notes || '');
      rowsAcc.push(cells);
    }

    const csv = '﻿' + rowsAcc.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const label = viewMode === 'amuta'
      ? (data.amutot.find(x => x.id === selectedAmuta)?.name || 'amuta')
      : (selectedBranchName || (isAllBranches ? 'all-branches' : 'branch'));
    a.href = url; a.download = `payroll-${label}-${month}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  /* ─── Render ────────────────────────────────────────────────────── */

  // Approx column widths so borders sit right
  const W = {
    branch: 110,
    name: 150,
    amutaCell: 64,        // each of 7 cols per amuta
    travel: 70,
    days: 56,
    advance: 170,
    money: 78,
    notes: 50,
    custom: 110,
  };

  return (
    <Box dir="rtl">
      <Paper variant="outlined" sx={{ borderRadius: 3, p: 1.5, mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <TextField type="month" size="small" label="חודש" value={month} onChange={e => setMonth(e.target.value)} sx={{ width: 160 }} InputLabelProps={{ shrink: true }} />
          <ToggleButtonGroup size="small" exclusive value={viewMode} onChange={(_, v) => v && setViewMode(v)}>
            <ToggleButton value="branch">לפי סניף</ToggleButton>
            <ToggleButton value="amuta">לפי עמותה</ToggleButton>
          </ToggleButtonGroup>
          {viewMode === 'amuta' && data && (
            <Select size="small" value={selectedAmuta} onChange={e => setSelectedAmuta(e.target.value)} displayEmpty sx={{ minWidth: 220 }}>
              <MenuItem value=""><em>בחר עמותה…</em></MenuItem>
              {data.amutot.map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
            </Select>
          )}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {data ? `${data.rows.length} עובדים • ${Math.round(data.totals.hours || 0)} שעות` : ''}
          </Typography>
          <Button startIcon={<AddCircleOutlineIcon />} size="small" onClick={() => setAddCol(true)} variant="outlined">הוסף עמודה</Button>
          <Tooltip title="רענן"><IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton></Tooltip>
          <Tooltip title="ייצוא CSV"><IconButton onClick={exportCSV} disabled={!data}><DownloadIcon /></IconButton></Tooltip>
          {isFinalized
            ? <Button startIcon={<LockOpenIcon />} onClick={reopen} color="warning" variant="outlined" size="small">פתח לעריכה</Button>
            : <Button startIcon={<LockIcon />} onClick={finalize} color="primary" variant="outlined" size="small">נעל חודש</Button>}
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ borderRadius: 3, maxHeight: 'calc(100vh - 240px)', overflowX: 'auto' }}>
        <Table size="small" stickyHeader sx={{
          tableLayout: 'fixed',
          minWidth: 1200,
          '& td, & th': { fontSize: '0.78rem', borderBottom: '1px solid', borderColor: 'divider', boxSizing: 'border-box' },
          '& td.auto': { bgcolor: 'grey.50', color: 'text.secondary' },
          '& .ag-divider': { borderLeft: '2px solid', borderColor: 'divider' },
        }}>
          <colgroup>
            <col style={{ width: W.branch }} />
            <col style={{ width: W.name }} />
            {visibleBranches.flatMap(b => [
              <col key={`cg-${b.id}-days`} style={{ width: W.days }} />,
              ...Array.from({ length: 6 }, (_, i) => <col key={`cg-${b.id}-${i}`} style={{ width: W.amutaCell }} />),
            ])}
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
            {customColumns.map(c => <col key={`cc-${c.id}`} style={{ width: W.custom }} />)}
            <col style={{ width: W.notes }} />
          </colgroup>

          <TableHead>
            <TableRow>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, bgcolor: 'background.paper' }}>סניף</TableCell>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, bgcolor: 'background.paper' }} className="ag-divider">שם העובד</TableCell>
              {visibleBranches.map((b) => {
                const c = branchColor(b.color_index || 0);
                return (
                  <TableCell
                    key={b.id} colSpan={7} align="center"
                    sx={{
                      fontWeight: 800, bgcolor: c.header, color: c.accent,
                      borderLeft: '3px solid', borderColor: c.border,
                      letterSpacing: 0.2,
                    }}
                  >
                    {b.name}
                  </TableCell>
                );
              })}
              <TableCell colSpan={10 + customColumns.length + 1} align="center" sx={{ fontWeight: 800, bgcolor: 'warning.50' }} className="ag-divider">
                נתונים חודשיים
              </TableCell>
            </TableRow>
            <TableRow>
              {visibleBranches.map((b) => {
                const c = branchColor(b.color_index || 0);
                return <SubHeaderGroup key={b.id} color={c} />;
              })}
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
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>

          <TableBody>
            {loading && <TableRow><TableCell colSpan={20 + customColumns.length} align="center" sx={{ py: 4 }}><CircularProgress size={28} /></TableCell></TableRow>}
            {!loading && data?.rows.length === 0 && (
              <TableRow><TableCell colSpan={20 + customColumns.length} align="center" sx={{ py: 4, color: 'text.disabled' }}>אין עובדים</TableCell></TableRow>
            )}
            {!loading && data?.rows.map(r => {
              const locked = r.status === 'finalized';
              return (
                <TableRow key={r.employee_id} hover>
                  <TableCell sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>{r.branch_name}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }} className="ag-divider">
                    {r.full_name}
                    {locked && <Chip size="small" label="נעול" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />}
                  </TableCell>

                  {visibleBranches.map((b) => {
                    const bk = r.breakdown.per_branch?.[b.id];
                    const c = branchColor(b.color_index || 0);
                    return <BranchGroupCells key={b.id} bk={bk} salaryType={r.salary_type} color={c} />;
                  })}

                  <TableCell align="center" className="auto ag-divider" sx={{ fontWeight: 600 }}>{fmtCurrency(computeTravel(r)) || '—'}</TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.sick_days} disabled={locked} onSave={v => patchManual(r.employee_id, { sick_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.absence_days} disabled={locked} onSave={v => patchManual(r.employee_id, { absence_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.vacation_days} disabled={locked} onSave={v => patchManual(r.employee_id, { vacation_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.holiday_pay} disabled={locked} onSave={v => patchManual(r.employee_id, { holiday_pay: v })} /></TableCell>
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
                  {customColumns.map(c => (
                    <TableCell key={c.id} align="center">
                      <CustomCell column={c} value={r.manual.custom_values?.[c.id]} disabled={locked} onSave={v => patchCustomValue(r.employee_id, c.id, v)} />
                    </TableCell>
                  ))}
                  <TableCell align="center">
                    <IconButton size="small" onClick={() => setNotes({ open: true, row: r })} color={r.manual.notes ? 'primary' : 'default'}>
                      <NoteAltIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <NotesDialog open={notes.open} row={notes.row} onClose={() => setNotes({ open: false, row: null })}
        onSave={(text) => notes.row && patchManual(notes.row.employee_id, { notes: text })} />
      <AddColumnDialog open={addCol} month={month} onClose={() => setAddCol(false)} onCreated={() => fetchData()} />
    </Box>
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
  const cells = ['ימי עבודה', 'שעות רגילות', 'שע״נ א\'', 'שע״נ ב\'', 'שכר שעתי', 'שכר גלובלי', 'שע״נ גלובלי'];
  return (
    <>
      {cells.map((label, i) => (
        <TableCell
          key={i} align="center"
          sx={{
            fontWeight: 700, fontSize: '0.7rem', lineHeight: 1.1,
            bgcolor: color.sub, color: color.accent,
            borderLeft: i === 6 ? '3px solid' : undefined,
            borderColor: i === 6 ? color.border : undefined,
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
