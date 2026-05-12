import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box, Paper, Stack, Typography, TextField, Select, MenuItem, IconButton, Button,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Tooltip,
  Chip, Autocomplete, Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton, ToggleButtonGroup,
  CircularProgress,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import NoteAltIcon from '@mui/icons-material/NoteAlt';
import NumbersIcon from '@mui/icons-material/Numbers';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/**
 * Monthly payroll table — replicates the CSV layout the bookkeeper uses,
 * with per-amuta column groups, auto-calculated cells from punches, and
 * editable manual cells (sick/vacation/gift card/notes etc.).
 */

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtNum(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (Number.isNaN(v)) return String(n);
  return v % 1 === 0 ? v.toString() : v.toFixed(2);
}

function fmtCurrency(n) {
  if (n == null) return '';
  return Math.round(Number(n) || 0).toLocaleString('he-IL');
}

// Auto travel calculation — must match server payrollCalc.js
function computeTravel(row) {
  if (row.manual.travel_override != null) return row.manual.travel_override;
  const days = row.breakdown?.hours?.days_worked || 0;
  if (row.travel_mode === 'per_day') return (row.travel_per_day || 0) * days;
  if (row.travel_mode === 'monthly_flat') return row.travel_monthly_flat || 0;
  return 0;
}

// ── Inline number editor — click to edit, save on blur / Enter ───────────
function NumberCell({ value, onSave, disabled, suffix = '', placeholder = '—' }) {
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
        autoFocus
        size="small"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        variant="standard"
        sx={{ width: 70 }}
        inputProps={{ style: { textAlign: 'center', fontSize: '0.8rem' } }}
      />
    );
  }
  const display = value == null || value === 0 || value === '' ? placeholder : `${fmtNum(value)}${suffix}`;
  return (
    <Box
      onClick={begin}
      sx={{
        cursor: disabled ? 'default' : 'text',
        minHeight: 24,
        fontSize: '0.8rem',
        color: value ? 'text.primary' : 'text.disabled',
        textAlign: 'center',
        '&:hover': { bgcolor: disabled ? undefined : 'action.hover' },
      }}
    >
      {display}
    </Box>
  );
}

// ── Number-or-text cell — small toggle inside the cell ───────────────────
function NumberOrTextCell({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState(value?.kind || 'empty');
  const [draft, setDraft] = useState('');

  const begin = () => {
    if (disabled) return;
    const initialKind = value?.kind === 'empty' ? 'number' : value?.kind || 'number';
    setKind(initialKind);
    setDraft(initialKind === 'number' ? (value?.amount ?? '') : (value?.text ?? ''));
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
      <Stack direction="row" alignItems="center" spacing={0.3}>
        <ToggleButtonGroup
          size="small"
          value={kind}
          exclusive
          onChange={(_, v) => v && setKind(v)}
          sx={{ '& button': { padding: '2px 4px', minWidth: 22, height: 22 } }}
        >
          <ToggleButton value="number"><NumbersIcon sx={{ fontSize: 14 }} /></ToggleButton>
          <ToggleButton value="text"><TextFieldsIcon sx={{ fontSize: 14 }} /></ToggleButton>
        </ToggleButtonGroup>
        <TextField
          autoFocus
          size="small"
          variant="standard"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter' && kind === 'number') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          sx={{ width: 80 }}
          inputProps={{ style: { textAlign: 'center', fontSize: '0.8rem' } }}
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
        cursor: disabled ? 'default' : 'text',
        minHeight: 24,
        fontSize: '0.8rem',
        color: isEmpty ? 'text.disabled' : 'text.primary',
        textAlign: 'center',
        '&:hover': { bgcolor: disabled ? undefined : 'action.hover' },
      }}
    >
      {display}
    </Box>
  );
}

// ── Advance-deduction Autocomplete with free-text → saved preset flow ────
function AdvanceDeductionCell({ row, presets, onSavePresetId, onSaveText, onCreatePreset, disabled }) {
  const value = row.manual.advance_deduction_preset?.label || row.manual.advance_deduction_text || '';
  const handleChange = (_, newValue) => {
    if (!newValue) {
      onSavePresetId(null);
      onSaveText('');
      return;
    }
    if (typeof newValue === 'string') {
      // typed free text + pressed enter → create preset, then save its id
      onCreatePreset(newValue, (created) => onSavePresetId(created.id));
      return;
    }
    if (newValue.inputValue) {
      // selected the "הוסף ..." option
      onCreatePreset(newValue.inputValue, (created) => onSavePresetId(created.id));
      return;
    }
    onSavePresetId(newValue.id);
  };

  return (
    <Autocomplete
      size="small"
      freeSolo
      disabled={disabled}
      options={presets}
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
        <TextField {...params} variant="standard" placeholder="בחר…" InputProps={{ ...params.InputProps, style: { fontSize: '0.78rem' } }} />
      )}
      sx={{ minWidth: 180 }}
    />
  );
}

// ── Notes modal ──────────────────────────────────────────────────────────
function NotesDialog({ open, row, onClose, onSave }) {
  const [text, setText] = useState('');
  useEffect(() => { if (row) setText(row.manual.notes || ''); }, [row]);
  if (!row) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>הערות — {row.full_name}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={5}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="הערות חופשי על העובד החודש (בונוסים, הלוואות, התנהגות חריגה וכו')…"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={() => { onSave(text); onClose(); }}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Main component ──────────────────────────────────────────────────────
export default function PayrollMonthTable() {
  const { selectedBranch, selectedBranchName, isAllBranches, branches } = useBranch();
  const [month, setMonth] = useState(currentYearMonth());
  const [viewMode, setViewMode] = useState('branch'); // 'branch' | 'amuta'
  const [selectedAmuta, setSelectedAmuta] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [presets, setPresets] = useState([]);
  const [notes, setNotes] = useState({ open: false, row: null });

  const isFinalized = useMemo(() => {
    if (!data?.rows) return false;
    return data.rows.every(r => r.status === 'finalized');
  }, [data]);

  // Load presets once
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

  // Persist a manual-field change for one row, with optimistic UI
  const patchManual = useCallback((employeeId, patch) => {
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => r.employee_id === employeeId ? { ...r, manual: { ...r.manual, ...patch } } : r),
      };
    });
    api.patch(`/payroll-month/${employeeId}`, { manual: patch }, { params: { month } })
      .catch(err => {
        toast.error(err.response?.data?.error || 'שמירה נכשלה');
        fetchData();
      });
  }, [month, fetchData]);

  const createPresetAndUse = useCallback((label, cb) => {
    api.post('/payroll-month/presets', { field_name: 'advance_deduction', label, action: 'custom' })
      .then(res => {
        const created = res.data.option;
        setPresets(prev => prev.some(p => p.id === created.id) ? prev : [...prev, created]);
        cb && cb(created);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  }, []);

  const finalize = () => {
    if (!confirm('לנעול את החודש? לאחר נעילה הערכים האוטומטיים לא יחושבו מחדש.')) return;
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

  // CSV export matches the bookkeeper's original spreadsheet layout
  const exportCSV = () => {
    if (!data) return;
    const amutot = data.amutot;
    // Build 2-row header
    const top = ['', 'משכורות - עמותת גן החלומות - ' + month, ...Array(8 * (amutot.length + 1) + 10).fill('')];
    const groupHdr = ['סניף', 'שם העובד', 'שעות עבודה'];
    for (let i = 0; i < 6; i++) groupHdr.push('');
    for (const a of amutot) {
      groupHdr.push(a.name);
      for (let i = 0; i < 6; i++) groupHdr.push('');
    }
    groupHdr.push('מאזן כללי');
    for (let i = 0; i < 6; i++) groupHdr.push('');
    const cols = [
      'ימי עבודה', 'שעות רגילות', 'שעות נוספות א\'', 'שעות נוספות ב\'',
      'שכר שעתי', 'שכר גלובלי', 'שעות נוספות גלובלי',
    ];
    const subHdr = ['', '', ...cols];
    for (const _a of amutot) subHdr.push(...cols);
    subHdr.push(...cols); // מאזן כללי
    subHdr.push('נסיעות', 'מחלה', 'היעדרות', 'חופשה', 'דמי חגים',
                'אחוז מתשלום השכר בהתאמה לקיזוז המקדמה ששולמה',
                'GIFT CARD', 'הבראה', 'סיבוס', 'מילואים', 'הערות נוספות');

    const rows = data.rows.map(r => {
      const cells = [r.branch_name, r.full_name];
      // primary (default) bucket
      cells.push(
        r.breakdown.hours.days_worked,
        r.breakdown.hours.regular,
        r.breakdown.hours.ot_125,
        r.breakdown.hours.ot_150,
        r.salary_type === 'hourly' ? (r.breakdown.rates.hourly_rate || '') : '',
        r.salary_type === 'global' ? (r.breakdown.rates.global_salary || '') : '',
        r.salary_type === 'global' ? (r.breakdown.rates.global_ot_rate || '') : '',
      );
      // per-amuta
      for (const a of amutot) {
        const bk = r.breakdown.per_amuta?.[a.id];
        if (bk) {
          cells.push(bk.days_worked, bk.regular_hours, bk.ot_125_hours, bk.ot_150_hours, bk.hourly_rate || '', bk.global_salary || '', bk.global_ot_rate || '');
        } else {
          cells.push('', '', '', '', '', '', '');
        }
      }
      // מאזן כללי (unmapped bucket) — placeholder
      const balance = r.breakdown.per_amuta?.['unmapped'];
      if (balance) {
        cells.push(balance.days_worked, balance.regular_hours, balance.ot_125_hours, balance.ot_150_hours, '', '', '');
      } else {
        cells.push('', '', '', '', '', '', '');
      }
      // post-amuta cols
      cells.push(
        computeTravel(r),
        r.manual.sick_days || '',
        r.manual.absence_days || '',
        r.manual.vacation_days || '',
        r.manual.holiday_pay || '',
        r.manual.advance_deduction_preset?.label || r.manual.advance_deduction_text || '',
        r.manual.gift_card?.kind === 'number' ? r.manual.gift_card.amount : (r.manual.gift_card?.text || ''),
        r.manual.recreation?.kind === 'number' ? r.manual.recreation.amount : (r.manual.recreation?.text || ''),
        r.manual.cibus?.kind === 'number' ? r.manual.cibus.amount : (r.manual.cibus?.text || ''),
        r.manual.miluim?.kind === 'number' ? r.manual.miluim.amount : (r.manual.miluim?.text || ''),
        r.manual.notes || '',
      );
      return cells;
    });

    const allRows = [top, groupHdr, subHdr, ...rows];
    const csv = '﻿' + allRows.map(row =>
      row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const label = viewMode === 'amuta'
      ? (data.amutot.find(x => x.id === selectedAmuta)?.name || 'amuta')
      : (selectedBranchName || (isAllBranches ? 'all-branches' : 'branch'));
    a.download = `payroll-${label}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Amuta columns shown in the table — when in 'amuta' view we show only the
  // selected amuta; otherwise we show all amutot.
  const visibleAmutot = useMemo(() => {
    if (!data) return [];
    if (viewMode === 'amuta' && selectedAmuta) {
      return data.amutot.filter(a => a.id === selectedAmuta);
    }
    return data.amutot;
  }, [data, viewMode, selectedAmuta]);

  return (
    <Box dir="rtl" sx={{ maxWidth: '100%' }}>
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

          <Tooltip title="רענן"><IconButton onClick={fetchData} disabled={loading}><RefreshIcon /></IconButton></Tooltip>
          <Tooltip title="ייצוא CSV"><IconButton onClick={exportCSV} disabled={!data}><DownloadIcon /></IconButton></Tooltip>
          {isFinalized ? (
            <Button startIcon={<LockOpenIcon />} onClick={reopen} color="warning" variant="outlined" size="small">פתח לעריכה</Button>
          ) : (
            <Button startIcon={<LockIcon />} onClick={finalize} color="primary" variant="outlined" size="small">נעל חודש</Button>
          )}
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ borderRadius: 3, maxHeight: 'calc(100vh - 240px)' }}>
        <Table size="small" stickyHeader sx={{
          '& td, & th': { fontSize: '0.78rem', whiteSpace: 'nowrap' },
          '& td.auto': { bgcolor: 'grey.50', color: 'text.secondary' },
        }}>
          <TableHead>
            <TableRow>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, position: 'sticky', right: 0, bgcolor: 'background.paper', zIndex: 3 }}>סניף</TableCell>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, position: 'sticky', right: 60, bgcolor: 'background.paper', zIndex: 3, minWidth: 150 }}>שם העובד</TableCell>
              {visibleAmutot.map(a => (
                <TableCell key={a.id} colSpan={7} align="center" sx={{ fontWeight: 800, bgcolor: 'primary.50', borderLeft: '2px solid', borderColor: 'divider' }}>
                  {a.name}
                </TableCell>
              ))}
              <TableCell colSpan={11} align="center" sx={{ fontWeight: 800, bgcolor: 'warning.50' }}>נתונים חודשיים</TableCell>
            </TableRow>
            <TableRow>
              {visibleAmutot.map((a, idx) => (
                <SubHeaderGroup key={a.id} accent={idx === 0} />
              ))}
              <TableCell align="center" className="auto" sx={{ fontWeight: 700 }}>נסיעות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מחלה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>היעדרות</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>חופשה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>דמי חגים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700, minWidth: 200 }}>קיזוז מקדמה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>GIFT CARD</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הבראה</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>סיבוס</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>מילואים</TableCell>
              <TableCell align="center" sx={{ fontWeight: 700 }}>הערות</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={20} align="center" sx={{ py: 4 }}><CircularProgress size={28} /></TableCell></TableRow>
            )}
            {!loading && data?.rows.length === 0 && (
              <TableRow><TableCell colSpan={20} align="center" sx={{ py: 4, color: 'text.disabled' }}>אין עובדים</TableCell></TableRow>
            )}
            {!loading && data?.rows.map(r => {
              const locked = r.status === 'finalized';
              return (
                <TableRow key={r.employee_id} hover>
                  <TableCell sx={{ position: 'sticky', right: 0, bgcolor: 'background.paper', fontSize: '0.72rem', color: 'text.secondary' }}>{r.branch_name}</TableCell>
                  <TableCell sx={{ position: 'sticky', right: 60, bgcolor: 'background.paper', fontWeight: 600 }}>
                    {r.full_name}
                    {locked && <Chip size="small" label="נעול" color="default" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />}
                  </TableCell>

                  {visibleAmutot.map(a => {
                    const bk = r.breakdown.per_amuta?.[a.id];
                    return (
                      <AmutaGroupCells key={a.id} bk={bk} salaryType={r.salary_type} primaryAmutaId={r.breakdown.rates?.primary_amuta_id} amutaId={a.id} primary={r.breakdown.rates} />
                    );
                  })}

                  <TableCell align="center" className="auto" sx={{ fontWeight: 600 }}>{fmtCurrency(computeTravel(r))}</TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.sick_days} disabled={locked} onSave={v => patchManual(r.employee_id, { sick_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.absence_days} disabled={locked} onSave={v => patchManual(r.employee_id, { absence_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.vacation_days} disabled={locked} onSave={v => patchManual(r.employee_id, { vacation_days: v })} /></TableCell>
                  <TableCell align="center"><NumberCell value={r.manual.holiday_pay} disabled={locked} onSave={v => patchManual(r.employee_id, { holiday_pay: v })} /></TableCell>
                  <TableCell>
                    <AdvanceDeductionCell
                      row={r}
                      presets={presets}
                      disabled={locked}
                      onSavePresetId={(id) => patchManual(r.employee_id, { advance_deduction_preset_id: id, advance_deduction_text: id ? '' : r.manual.advance_deduction_text })}
                      onSaveText={(text) => patchManual(r.employee_id, { advance_deduction_text: text, advance_deduction_preset_id: null })}
                      onCreatePreset={createPresetAndUse}
                    />
                  </TableCell>
                  <TableCell align="center"><NumberOrTextCell value={r.manual.gift_card} disabled={locked} onSave={v => patchManual(r.employee_id, { gift_card: v })} /></TableCell>
                  <TableCell align="center"><NumberOrTextCell value={r.manual.recreation} disabled={locked} onSave={v => patchManual(r.employee_id, { recreation: v })} /></TableCell>
                  <TableCell align="center"><NumberOrTextCell value={r.manual.cibus} disabled={locked} onSave={v => patchManual(r.employee_id, { cibus: v })} /></TableCell>
                  <TableCell align="center"><NumberOrTextCell value={r.manual.miluim} disabled={locked} onSave={v => patchManual(r.employee_id, { miluim: v })} /></TableCell>
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

      <NotesDialog
        open={notes.open}
        row={notes.row}
        onClose={() => setNotes({ open: false, row: null })}
        onSave={(text) => notes.row && patchManual(notes.row.employee_id, { notes: text })}
      />
    </Box>
  );
}

// 7 sub-headers per amuta block
function SubHeaderGroup({ accent }) {
  const bg = accent ? 'primary.50' : 'grey.50';
  const cells = ['ימי עבודה', 'שעות רגילות', 'שע״נ א\'', 'שע״נ ב\'', 'שכר שעתי', 'שכר גלובלי', 'שע״נ גלובלי'];
  return (
    <>
      {cells.map((label, i) => (
        <TableCell
          key={i}
          align="center"
          className="auto"
          sx={{ fontWeight: 700, fontSize: '0.72rem', bgcolor: bg, borderLeft: i === 6 ? '2px solid' : undefined, borderColor: 'divider' }}
        >
          {label}
        </TableCell>
      ))}
    </>
  );
}

// 7 cells per amuta — auto data
function AmutaGroupCells({ bk, salaryType, primaryAmutaId, amutaId, primary }) {
  const isPrimary = String(primaryAmutaId) === String(amutaId);
  const days  = bk?.days_worked || '';
  const reg   = bk?.regular_hours || '';
  const ot125 = bk?.ot_125_hours || '';
  const ot150 = bk?.ot_150_hours || '';
  // Rates: only shown for the primary amuta (we don't store per-amuta rates yet)
  const hourly = isPrimary && salaryType === 'hourly'  ? primary.hourly_rate    : '';
  const global = isPrimary && salaryType === 'global'  ? primary.global_salary  : '';
  const globalOt = isPrimary && salaryType === 'global' ? primary.global_ot_rate : '';
  const cell = (v, opts = {}) => (
    <TableCell align="center" className="auto" sx={{ borderLeft: opts.last ? '2px solid' : undefined, borderColor: 'divider' }}>
      {v ? fmtNum(v) : <span style={{ opacity: 0.3 }}>—</span>}
    </TableCell>
  );
  return (
    <>
      {cell(days)}
      {cell(reg)}
      {cell(ot125)}
      {cell(ot150)}
      {cell(hourly)}
      {cell(global)}
      {cell(globalOt, { last: true })}
    </>
  );
}
