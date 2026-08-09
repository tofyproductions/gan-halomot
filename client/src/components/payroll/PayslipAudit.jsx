import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, CardContent, Checkbox, Chip, CircularProgress, Collapse,
  Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton,
  LinearProgress, MenuItem, Paper, Select, Stack, Switch, Tab, Table, TableBody, TableCell,
  TableHead, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import InfoIcon from '@mui/icons-material/Info';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EmailIcon from '@mui/icons-material/Email';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import EditIcon from '@mui/icons-material/Edit';
import DescriptionIcon from '@mui/icons-material/Description';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useConfirm } from '../shared/ConfirmProvider';
import { useWorkMonth } from '../../hooks/useWorkMonth';

// ── Field labels for the readable side-by-side comparison ──
//
// Each entry maps a JSON path on the parsed object to a Hebrew label.
// `format` lets us pretty-print values (e.g. currency for salary fields).

const TABLE_FIELDS = [
  { key: 'days',                 label: 'ימי עבודה' },
  { key: 'hours_regular',        label: 'שעות רגילות' },
  { key: 'ot_125',               label: 'שעות נוספות 125%' },
  { key: 'ot_150',               label: 'שעות נוספות 150%' },
  { key: 'hourly_rate',          label: 'תעריף שעתי' },
  { key: 'global_salary_amount', label: 'שכר תקן', currency: true, suffixKey: 'global_salary_kind' },
  { key: 'global_ot_amount',     label: 'שעות נוספות גלובלי', currency: true, suffixKey: 'global_salary_kind' },
  { key: 'transport',            label: 'נסיעות', currency: true },
  { key: 'sick_days',            label: 'מחלה (ימים)' },
  { key: 'vacation_days',        label: 'חופשה (ימים)' },
  { key: 'holiday_days',         label: 'דמי חגים (ימים)' },
  { key: 'recuperation',         label: 'הבראה', currency: true },
  { key: 'cibus',                label: 'סיבוס', currency: true },
  { key: 'reserve_duty',         label: 'מילואים' },
  { key: 'gift_card',            label: 'כרטיס מתנה', currency: true },
  { key: 'advance_directive',    label: 'הוראת מקדמה' },
  { key: 'notes',                label: 'הערות', multiline: true },
];

const PAYSLIP_FIELDS = [
  { key: 'paid_days',          label: 'ימי עבודה (משולמים)' },
  { key: 'actual_days',        label: 'ימי עבודה (בפועל)' },
  { key: 'paid_hours',         label: 'שעות (משולמות)' },
  { key: 'actual_hours',       label: 'שעות (בפועל)' },
  { key: 'hourly_rate',        label: 'תעריף שעה' },
  { key: 'daily_rate',         label: 'תעריף יום' },
  { key: 'base_salary',        label: 'שכר בסיס', currency: true },
  { key: 'total_payments',     label: 'סה"כ תשלומים', currency: true },
  { key: 'total_deductions',   label: 'סה"כ ניכויים', currency: true },
  { key: 'net_salary',         label: 'שכר נטו', currency: true },
  { key: 'net_to_pay',         label: 'נטו לתשלום', currency: true },
  { key: 'branch_address',     label: 'כתובת סניף בתלוש' },
];

function fmtNumber(v, currency) {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  const formatted = Number.isInteger(v) ? v.toLocaleString('he-IL') : v.toFixed(2);
  return currency ? `₪${formatted}` : formatted;
}

const SEVERITY_META = {
  critical: { label: 'קריטי',   color: 'error',   icon: <ErrorIcon fontSize="small" /> },
  warning:  { label: 'אזהרה',   color: 'warning', icon: <WarningIcon fontSize="small" /> },
  info:     { label: 'מידע',    color: 'info',    icon: <InfoIcon fontSize="small" /> },
  ok:       { label: 'תקין',    color: 'success', icon: <CheckCircleIcon fontSize="small" /> },
};

function formatVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function FileInput({ label, file, onChange, accept }) {
  const ref = useRef(null);
  return (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          variant="outlined"
          startIcon={<UploadFileIcon />}
          onClick={() => ref.current?.click()}
          size="small"
        >
          {file ? 'החלף' : 'בחר קובץ'}
        </Button>
        {file && (
          <Typography variant="caption" color="text.secondary" noWrap>
            ✓ {file.name} ({Math.round(file.size / 1024)} KB)
          </Typography>
        )}
      </Stack>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => onChange(e.target.files?.[0] || null)}
      />
    </Box>
  );
}

// ── Compact, Hebrew-labeled panel that replaces the raw JSON dump ──
//
// `obj` is the parsed table row or payslip object; `fields` describes which
// keys to render and how. We hide rows whose value is null/undefined to keep
// the panel tight.
function ReadablePanel({ title, obj, fields, extras }) {
  if (!obj) {
    return (
      <Paper variant="outlined" sx={{ p: 1.5, height: '100%' }}>
        <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">— אין נתונים —</Typography>
      </Paper>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 1.5, height: '100%' }}>
      <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>{title}</Typography>
      <Table size="small" sx={{
        '& td': { fontSize: 12, py: 0.4, borderColor: 'rgba(0,0,0,0.06)' },
        '& tr:last-of-type td': { borderBottom: 'none' },
      }}>
        <TableBody>
          {fields.map((f) => {
            const v = obj[f.key];
            if (v === null || v === undefined || v === '') return null;
            const suffix = f.suffixKey && obj[f.suffixKey] && obj[f.suffixKey] !== 'unknown'
              ? ` (${obj[f.suffixKey] === 'net' ? 'נטו' : 'ברוטו'})` : '';
            const display = typeof v === 'number'
              ? `${fmtNumber(v, f.currency)}${suffix}`
              : String(v) + suffix;
            return (
              <TableRow key={f.key}>
                <TableCell sx={{ color: 'text.secondary', width: '45%' }}>{f.label}</TableCell>
                <TableCell sx={{
                  fontWeight: 600,
                  whiteSpace: f.multiline ? 'pre-line' : 'normal',
                  wordBreak: 'break-word',
                }}>
                  {display}
                </TableCell>
              </TableRow>
            );
          })}
          {extras}
        </TableBody>
      </Table>
    </Paper>
  );
}

// Specialized renderer for vacation/sick balances inside the payslip panel.
function LeaveRow({ label, leave }) {
  if (!leave || (leave.prev_balance == null && leave.used == null && leave.balance == null)) {
    return null;
  }
  const prev = leave.prev_balance != null ? Number(leave.prev_balance).toFixed(2) : '—';
  const used = leave.used != null ? Number(leave.used).toFixed(2) : '—';
  const bal  = leave.balance != null ? Number(leave.balance).toFixed(2) : '—';
  // Highlight negative usage (added) — that's the bug pattern we hunt for.
  const usedNeg = leave.used != null && leave.used < 0;
  return (
    <TableRow>
      <TableCell sx={{ color: 'text.secondary', width: '45%' }}>{label}</TableCell>
      <TableCell sx={{ fontWeight: 600 }}>
        קודם: <b>{prev}</b>{' · '}
        ניצול: <b style={{ color: usedNeg ? '#d32f2f' : 'inherit' }}>{used}</b>{' · '}
        יתרה: <b>{bal}</b>
      </TableCell>
    </TableRow>
  );
}

// Single (file + branch) row in the multi-PDF uploader. Branch can be picked
// from a dropdown of branches detected in the xlsx, or typed freely (Autocomplete-
// style behavior achieved with TextField + datalist for simplicity).
function PayslipFileRow({ row, idx, branches, canRemove, onChange, onRemove, hideBranch }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const takeDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.name) || x.type === 'application/pdf');
    if (f) onChange({ file: f });
  };
  return (
    <Paper
      variant="outlined"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={takeDrop}
      sx={{
        p: 1.25, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: hideBranch ? '1fr auto' : '2fr 1.5fr auto' }, gap: 1.5, alignItems: 'center',
        transition: 'all .15s',
        ...(dragOver ? { borderColor: 'primary.main', borderStyle: 'dashed', bgcolor: 'primary.50', boxShadow: '0 0 0 2px rgba(99,102,241,0.15)' } : {}),
      }}
    >
      {/* File picker (click or drag-and-drop a PDF onto the row) */}
      <Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="outlined"
            size="small"
            startIcon={<UploadFileIcon />}
            onClick={() => inputRef.current?.click()}
          >
            {row.file ? 'החלף' : 'בחר PDF'}
          </Button>
          {row.file ? (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
              ✓ {row.file.name} ({Math.round(row.file.size / 1024)} KB)
            </Typography>
          ) : (
            <Typography variant="caption" color={dragOver ? 'primary.main' : 'text.disabled'} sx={{ flex: 1 }}>
              {dragOver ? 'שחרר כאן את קובץ ה-PDF' : 'או גרור לכאן קובץ PDF'}
            </Typography>
          )}
        </Stack>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => onChange({ file: e.target.files?.[0] || null })}
        />
      </Box>

      {/* Branch selector — hidden in all-branches mode (matched by ת"ז). */}
      {!hideBranch && (
        <Autocomplete
          freeSolo
          size="small"
          options={branches}
          value={row.branch}
          onChange={(_, v) => onChange({ branch: v || '' })}
          onInputChange={(_, v) => onChange({ branch: v })}
          renderInput={(params) => (
            <TextField {...params} label="סניף" placeholder="בחר או הקלד שם סניף" />
          )}
        />
      )}

      {/* Remove row */}
      <Box>
        <IconButton
          size="small"
          onClick={onRemove}
          disabled={!canRemove}
          color="error"
          title="הסר קובץ"
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Box>
    </Paper>
  );
}

// Chip-based recipient editor: shows current addresses as removable chips +
// inline input for adding new ones. Accepts Enter or comma to commit; supports
// pasting comma/space separated lists.
function RecipientEditor({ label, required, chips, onRemove, inputValue, onInputChange, onAdd }) {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      onAdd();
    } else if (e.key === 'Backspace' && !inputValue && chips.length > 0) {
      // Quality-of-life: backspace on empty input removes the last chip.
      onRemove(chips[chips.length - 1]);
    }
  };
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {label}{required && <span style={{ color: '#d32f2f' }}> *</span>}
      </Typography>
      <Paper
        variant="outlined"
        sx={{
          p: 1,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 0.5,
          minHeight: 44,
          '&:focus-within': { borderColor: 'primary.main', borderWidth: 2, p: 'calc(8px - 1px)' },
        }}
      >
        {chips.map((addr) => (
          <Chip
            key={addr}
            label={addr}
            size="small"
            onDelete={() => onRemove(addr)}
            sx={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        ))}
        <TextField
          variant="standard"
          placeholder={chips.length === 0 ? 'הקלד כתובת ולחץ Enter' : 'הוסף עוד…'}
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => inputValue.trim() && onAdd()}
          InputProps={{ disableUnderline: true, sx: { fontSize: 13 } }}
          sx={{ flex: 1, minWidth: 140, ml: 0.5 }}
        />
      </Paper>
    </Box>
  );
}

// Per-employee paired view — the page-level layout that pairs each audit
// ResultCard (right column) with its own corrections editor (left column).
// Both columns scroll together as one row per employee. Manual employees
// (added via "+ עובד חדש") appear at the bottom with no audit card on the right.
function PerEmployeePairedView({
  filteredResults, audit, editableResults, expanded, setExpanded,
  updateFinding, removeFinding, addFinding, removeEmployee, addManualEmployee,
  onSendEmail, onSaveEdits, onFixRound, reviewedMap, onToggleReviewed, priorNotes,
  previewKind, roundView, onExitRoundView, onApproveRound, onSendEmployees, onSendManagers,
  onAnotherRound, onResendAccountant, onAddNote,
}) {
  const [showAllEmpty, setShowAllEmpty] = useState(false);
  const [newName, setNewName] = useState('');
  const [showAddEmployee, setShowAddEmployee] = useState(false);

  const totalFindings = editableResults.reduce((s, r) => s + r.findings.length, 0);
  // Verification stats — what % is reviewed, what % will actually be sent
  const allFindings = editableResults.flatMap((r) => r.findings);
  const approvedCount = allFindings.filter((f) => f.status === 'approved').length;
  const rejectedCount = allFindings.filter((f) => f.status === 'rejected').length;
  const pendingCount  = allFindings.filter((f) => !f.status || f.status === 'pending').length;
  // Corrections decide what travels; the ✓ נבדק tick is review progress only.
  const sendable = (f) => f.status !== 'rejected' && f.settled !== 'fixed' && f.message && f.message.trim();
  const willSendCount = editableResults.reduce((s, r) => s + r.findings.filter(sendable).length, 0);
  const reviewedCount = editableResults.filter((_, idx) => reviewedMap?.[idx]).length;
  const cleanCount = editableResults.filter((r) => r.findings.filter(sendable).length === 0).length;

  // Map an audit result to its parallel editableResult by index
  const editableByAuditIdx = (auditIdx) => editableResults[auditIdx];

  // Visible audit-backed pairs: filteredResults filtered to non-empty editor
  // unless showAllEmpty is on.
  const auditPairs = filteredResults
    .map((r) => ({ result: r, idx: audit.results.indexOf(r) }))
    .filter(({ idx }) => idx >= 0)
    .filter(({ idx }) => showAllEmpty || (editableByAuditIdx(idx)?.findings.length ?? 0) > 0);

  // Manual employees added via "+ עובד חדש" — these have no entry in audit.results
  const manualEntries = editableResults
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.__manual);

  const emptyCount = filteredResults.filter((r) => {
    const i = audit.results.indexOf(r);
    return i >= 0 && (editableByAuditIdx(i)?.findings.length ?? 0) === 0;
  }).length;

  return (
    <Box>
      {/* Viewing a correction round, not the original audit. Say so loudly —
          the numbers on screen came from the accountant's re-submission. */}
      {roundView && (
        <Card sx={{ mb: 1.5, borderTop: 4, borderColor: roundView.open === 0 ? 'success.main' : 'warning.main' }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', mb: 1 }}>
              <Typography sx={{ fontWeight: 800 }}>סבב תיקון {roundView.round_no}</Typography>
              <Typography variant="caption" color="text.secondary">התלושים המתוקנים שהתקבלו מהרו״ח · התצוגה המקדימה מציגה את התלוש החדש</Typography>
              <Box sx={{ flex: 1 }} />
              {roundView.approved && <Chip size="small" color="success" label="✓ הסבב אושר" sx={{ fontWeight: 800 }} />}
              <Button size="small" onClick={onExitRoundView}>חזור לביקורת המקורית</Button>
            </Stack>
            {roundView.summary && (
              <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                <Chip size="small" color="success" label={`${roundView.summary.fixed} תוקנו`} />
                {!!roundView.summary.not_fixed && <Chip size="small" color="error" label={`${roundView.summary.not_fixed} לא תוקנו`} />}
                {!!roundView.summary.manual && <Chip size="small" color="warning" label={`${roundView.summary.manual} להכרעה`} />}
                {!!roundView.summary.new_issues && <Chip size="small" color="error" variant="outlined" label={`${roundView.summary.new_issues} ממצאים חדשים`} />}
              </Stack>
            )}

            {/* The fork at the end of a round: sign off and release the payslips,
                or send the accountant back for another pass. */}
            {roundView.approved ? (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, color: 'success.dark', width: '100%', mb: 0.5 }}>
                  התלושים המתוקנים מוכנים להפצה:
                </Typography>
                <Button size="small" variant="contained" color="success" startIcon={<EmailIcon />} onClick={onSendEmployees}>
                  שלח לעובדים (תלוש + דוח שעות אישי)
                </Button>
                <Button size="small" variant="contained" color="success" startIcon={<EmailIcon />} onClick={onSendManagers}>
                  שלח למנהלי סניפים (כל הסניף)
                </Button>
              </Stack>
            ) : (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                <Button size="small" variant="contained" color="success" startIcon={<CheckCircleIcon />}
                  disabled={roundView.busy} onClick={() => onApproveRound(false)}>
                  {roundView.open === 0 ? 'אשר סבב וסיים' : `אשר בכל זאת (${roundView.open} פתוחות)`}
                </Button>
                <Button size="small" variant="outlined" onClick={onAnotherRound}>סבב תיקון נוסף</Button>
                <Button size="small" variant="outlined" startIcon={<EmailIcon />} onClick={onResendAccountant}>
                  שלח שוב לרו״ח
                </Button>
                {/* Something turns up on a payslip that was already signed off.
                    Adding the correction to the origin audit puts that employee
                    back in the next round — no need to redo the review. */}
                <Button size="small" variant="outlined" color="warning" startIcon={<AddIcon />} onClick={onAddNote}>
                  הוסף תיקון לסבב הבא
                </Button>
                {roundView.open > 0 && (
                  <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 700, alignSelf: 'center' }}>
                    {roundView.open} הערות עדיין לא סגורות — סגור אותן בדיאלוג הסבב, או אשר בכל זאת
                  </Typography>
                )}
              </Stack>
            )}
          </CardContent>
        </Card>
      )}
      {/* Top bar — sticky so the email button + add-employee stay reachable */}
      <Card sx={{ borderTop: 4, borderColor: 'primary.main', mb: 1.5, position: 'sticky', top: 0, zIndex: 5 }}>
        <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <EditIcon fontSize="small" color="primary" />
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                תיקונים לרו"ח · <b>{willSendCount}</b> יישלחו במייל
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
                {approvedCount > 0 && <Chip size="small" color="success" label={`✓ ${approvedCount} מאושרים`} sx={{ height: 18, fontSize: 10 }} />}
                {rejectedCount > 0 && <Chip size="small" color="error"   label={`✗ ${rejectedCount} נדחו`}    sx={{ height: 18, fontSize: 10 }} />}
                {pendingCount > 0  && <Chip size="small" variant="outlined" label={`${pendingCount} לסקירה`} sx={{ height: 18, fontSize: 10 }} />}
                {cleanCount > 0 && <Chip size="small" color="success" variant="outlined" label={`${cleanCount} ללא תיקונים — יישלחו כרשימת מאושרים`} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />}
                {reviewedCount > 0 && <Chip size="small" variant="outlined" label={`✓ נבדקו ${reviewedCount}/${editableResults.length}`} sx={{ height: 18, fontSize: 10 }} />}
              </Stack>
            </Box>
            <Button
              size="small"
              startIcon={<PersonAddIcon />}
              onClick={() => setShowAddEmployee((v) => !v)}
            >
              עובד חדש
            </Button>
            {onSaveEdits && (
              <Button size="small" variant="outlined" onClick={onSaveEdits}>
                💾 שמור
              </Button>
            )}
            {onFixRound && (
              <Button size="small" variant="outlined" color="secondary" startIcon={<CheckCircleIcon />} onClick={onFixRound}>
                סבב תיקון
              </Button>
            )}
            <Button
              variant="contained"
              color="primary"
              startIcon={<EmailIcon />}
              onClick={onSendEmail}
              disabled={willSendCount === 0}
            >
              שלח מייל
            </Button>
          </Stack>

          {showAddEmployee && (
            <Paper variant="outlined" sx={{ p: 1, mt: 1, display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                size="small"
                placeholder="שם עובד"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) {
                    addManualEmployee(newName);
                    setNewName('');
                    setShowAddEmployee(false);
                  }
                }}
                sx={{ flex: 1 }}
                autoFocus
              />
              <Button
                variant="contained"
                size="small"
                disabled={!newName.trim()}
                onClick={() => { addManualEmployee(newName); setNewName(''); setShowAddEmployee(false); }}
              >
                הוסף
              </Button>
              <Button size="small" onClick={() => { setShowAddEmployee(false); setNewName(''); }}>ביטול</Button>
            </Paper>
          )}
        </CardContent>
      </Card>

      {/* Paired rows: ResultCard (right) + EmployeeBlock (left) per employee */}
      {filteredResults.length === 0 && manualEntries.length === 0 ? (
        <Alert severity="info">אין תוצאות לפילטר זה</Alert>
      ) : (
        <Stack spacing={1.5}>
          {auditPairs.map(({ result, idx }) => {
            const editableR = editableByAuditIdx(idx);
            return (
              <Box
                key={`pair-${idx}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', lg: '1.1fr 1fr' },
                  gap: 1.5,
                  alignItems: 'start',
                }}
              >
                {/* Right column (RTL first): audit card */}
                <ResultCard
                  result={result}
                  expanded={expanded === idx}
                  onToggle={() => setExpanded(expanded === idx ? null : idx)}
                  savedAuditId={audit.saved_audit_id}
                  reviewed={!!reviewedMap?.[idx]}
                  onToggleReviewed={onToggleReviewed ? () => onToggleReviewed(idx) : null}
                  priorNotes={priorNotes?.[resultKey(result)]}
                  previewKind={previewKind}
                />
                {/* Left column (RTL second): per-employee editor.
                    Side stripe color reflects review state — green when all
                    findings approved/rejected, primary blue otherwise. */}
                <Paper
                  variant="outlined"
                  sx={{
                    borderRight: 3,
                    borderColor: isEmployeeReviewed(editableR) ? 'success.main' : 'primary.main',
                    p: 0,
                    transition: 'border-color 0.2s',
                  }}
                >
                  <EmployeeBlock
                    r={editableR || { findings: [], table_row: result.table_row, payslip: result.payslip }}
                    rIdx={idx}
                    defaultExpanded={(editableR?.findings.length ?? 0) > 0}
                    onUpdate={updateFinding}
                    onRemove={removeFinding}
                    onAdd={addFinding}
                    onRemoveEmployee={removeEmployee}
                  />
                </Paper>
              </Box>
            );
          })}

          {/* Empty employees toggle — show employees with no current corrections
              so the user can add new ones in their context */}
          {emptyCount > 0 && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setShowAllEmpty((v) => !v)}
              sx={{ alignSelf: 'flex-start' }}
            >
              {showAllEmpty ? `הסתר עובדים ללא תיקונים (${emptyCount})` : `הצג עובדים ללא תיקונים (${emptyCount})`}
            </Button>
          )}

          {/* Manual employees: editor only (no audit card pair) */}
          {manualEntries.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                עובדים שנוספו ידנית
              </Typography>
              <Stack spacing={1}>
                {manualEntries.map(({ r, idx }) => (
                  <Box
                    key={`manual-${idx}`}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', lg: '1.1fr 1fr' },
                      gap: 1.5,
                    }}
                  >
                    {/* Spacer on the right (no audit card for manuals) */}
                    <Box />
                    <Paper variant="outlined" sx={{ borderRight: 3, borderColor: 'warning.main', p: 0 }}>
                      <EmployeeBlock
                        r={r}
                        rIdx={idx}
                        defaultExpanded
                        onUpdate={updateFinding}
                        onRemove={removeFinding}
                        onAdd={addFinding}
                        onRemoveEmployee={removeEmployee}
                      />
                    </Paper>
                  </Box>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      )}
    </Box>
  );
}

// Pre-send editor for the corrections list. Each employee block lets the user
// edit/delete existing findings and add new ones; a "+ עובד חדש" affordance
// at the bottom adds a manual correction for someone outside the audit.
function FindingsEditor({
  results, onUpdate, onRemove, onAdd, onRemoveEmployee, onAddManualEmployee,
}) {
  const [newName, setNewName] = useState('');
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [showAllEmployees, setShowAllEmployees] = useState(false);

  // Split: employees with at least one finding (always shown) vs empty ones
  // (hidden behind a "show all" toggle so the editor isn't drowned in 27 blocks).
  const withFindings = results.filter((r) => r.findings.length > 0);
  const empty = results.filter((r) => r.findings.length === 0);
  const totalFindings = withFindings.reduce((s, r) => s + r.findings.length, 0);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          תיקונים שיישלחו: <b>{totalFindings}</b> · עם תיקונים: <b>{withFindings.length}</b> · ללא: <b>{empty.length}</b>
        </Typography>
        <Button
          size="small"
          startIcon={<PersonAddIcon />}
          onClick={() => setShowAddEmployee((v) => !v)}
        >
          עובד חדש
        </Button>
      </Stack>

      {showAddEmployee && (
        <Paper variant="outlined" sx={{ p: 1, mb: 1, display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            size="small"
            placeholder="שם עובד"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                onAddManualEmployee(newName);
                setNewName('');
                setShowAddEmployee(false);
              }
            }}
            sx={{ flex: 1 }}
            autoFocus
          />
          <Button
            variant="contained"
            size="small"
            disabled={!newName.trim()}
            onClick={() => { onAddManualEmployee(newName); setNewName(''); setShowAddEmployee(false); }}
          >
            הוסף
          </Button>
          <Button size="small" onClick={() => { setShowAddEmployee(false); setNewName(''); }}>ביטול</Button>
        </Paper>
      )}

      {results.length === 0 ? (
        <Alert severity="info" sx={{ fontSize: 12 }}>
          אין תיקונים — הוסף עובד או סגור את הדיאלוג.
        </Alert>
      ) : (
        <Stack spacing={1}>
          {/* Employees with at least one finding — always rendered */}
          {withFindings.map((r) => {
            const realIdx = results.indexOf(r);
            return (
              <EmployeeBlock
                key={`f-${realIdx}`}
                r={r}
                rIdx={realIdx}
                defaultExpanded
                onUpdate={onUpdate}
                onRemove={onRemove}
                onAdd={onAdd}
                onRemoveEmployee={onRemoveEmployee}
              />
            );
          })}

          {/* Toggle to reveal employees with no findings (hidden by default to
              keep the editor short — there can be 25+ of these). */}
          {empty.length > 0 && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setShowAllEmployees((v) => !v)}
              sx={{ alignSelf: 'flex-start', mt: 0.5 }}
            >
              {showAllEmployees ? `הסתר עובדים ללא תיקונים (${empty.length})` : `הצג עובדים ללא תיקונים (${empty.length})`}
            </Button>
          )}

          {showAllEmployees && empty.map((r) => {
            const realIdx = results.indexOf(r);
            return (
              <EmployeeBlock
                key={`e-${realIdx}`}
                r={r}
                rIdx={realIdx}
                defaultExpanded={false}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onAdd={onAdd}
                onRemoveEmployee={onRemoveEmployee}
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

// An employee is "reviewed" (טופל) when every finding has a non-pending
// status (approved or rejected). Employees with zero findings are NOT
// considered reviewed — they're empty and don't need attention.
function isEmployeeReviewed(r) {
  if (!r || !r.findings || r.findings.length === 0) return false;
  return r.findings.every((f) => f.status === 'approved' || f.status === 'rejected');
}

// Single employee block in the FindingsEditor. Header is clickable to collapse;
// expanded view shows each finding with severity selector + multiline text +
// delete, plus a "+ הוסף תיקון" button.
function EmployeeBlock({ r, rIdx, defaultExpanded, onUpdate, onRemove, onAdd, onRemoveEmployee }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Auto-expand when a new finding is added.
  const findingCount = r.findings.length;
  const prevCount = useRef(findingCount);
  if (findingCount > prevCount.current && !expanded) setExpanded(true);
  prevCount.current = findingCount;

  const name = r.table_row?.employee_name || r.payslip?.employee_name || '—';
  const branch = r.table_row?.branch || '';
  const id = r.payslip?.employee_id;
  const empNo = r.payslip?.employee_no;
  const isEmpty = findingCount === 0;
  const reviewed = isEmployeeReviewed(r);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        bgcolor: reviewed ? 'success.50' : r.__manual ? 'warning.50' : isEmpty ? 'grey.50' : 'background.paper',
        borderColor: reviewed ? 'success.main' : 'divider',
        borderWidth: reviewed ? 2 : 1,
        opacity: isEmpty && !expanded ? 0.7 : 1,
        transition: 'background-color 0.2s, border-color 0.2s',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ cursor: 'pointer', mb: expanded ? 1 : 0 }}
        onClick={() => setExpanded((v) => !v)}
      >
        <IconButton size="small" sx={{ p: 0.25 }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>
          {reviewed && <CheckCircleIcon sx={{ fontSize: 18, color: 'success.main', verticalAlign: 'middle', ml: 0.5 }} />}
          {name}
          {empNo != null && <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>#{empNo}</Typography>}
          {id && <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>{id}</Typography>}
          {branch && <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>· {branch}</Typography>}
          {r.__manual && <Chip label="חדש" size="small" color="warning" sx={{ height: 18, fontSize: 10, mr: 1 }} />}
          {reviewed && <Chip label="✓ טופל" size="small" color="success" sx={{ height: 18, fontSize: 10, mr: 1, fontWeight: 700 }} />}
          {!reviewed && findingCount > 0 && (
            <Chip
              label={`${findingCount} תיקונים`}
              size="small"
              color="primary"
              sx={{ height: 18, fontSize: 10, mr: 1 }}
            />
          )}
        </Typography>
        {(r.__manual || findingCount > 0) && (
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onRemoveEmployee(rIdx); }}
            title="הסר עובד מהמייל"
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
      <Collapse in={expanded}>
        <Stack spacing={0.75}>
          {r.findings.map((f, fIdx) => {
            const status = f.status || 'pending';
            // Visual treatment per status — rejected findings dim out, approved
            // get a green border, pending stay neutral.
            const rowBg =
              status === 'approved' ? 'success.50' :
              status === 'rejected' ? 'grey.100'   :
              'transparent';
            const rowOpacity = status === 'rejected' ? 0.55 : 1;
            return (
              <Box key={fIdx} sx={{ bgcolor: rowBg, borderRadius: 1, p: 0.5, opacity: rowOpacity, transition: 'opacity 0.15s' }}>
                <Stack direction="row" spacing={0.5} alignItems="flex-start">
                  <Select
                    size="small"
                    value={f.severity}
                    onChange={(e) => onUpdate(rIdx, fIdx, { severity: e.target.value })}
                    sx={{ minWidth: 80, fontSize: 12, '& .MuiSelect-select': { py: 0.5 } }}
                  >
                    <MenuItem value="critical">קריטי</MenuItem>
                    <MenuItem value="warning">אזהרה</MenuItem>
                    <MenuItem value="info">מידע</MenuItem>
                  </Select>
                  <TextField
                    size="small"
                    multiline
                    maxRows={3}
                    placeholder="תיאור התיקון הנדרש"
                    value={f.message}
                    onChange={(e) => onUpdate(rIdx, fIdx, { message: e.target.value })}
                    sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: 13 } }}
                  />
                  <IconButton size="small" onClick={() => onRemove(rIdx, fIdx)} sx={{ color: 'error.main' }} title="מחק לחלוטין">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
                {/* Already settled by a correction round — say so, and say
                    which round, rather than leaving it looking unsent. */}
                {f.settled === 'fixed' && (
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5, mr: 11 }}>
                    <Chip size="small" color="success" label={`✓ תוקן בסבב ${f.settled_round}`} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                      לא יישלח שוב לרו״ח
                    </Typography>
                  </Stack>
                )}
                {/* Verification toolbar — teach the system which findings to act on */}
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5, mr: 11 }}>
                  <Button
                    size="small"
                    variant={status === 'approved' ? 'contained' : 'outlined'}
                    color="success"
                    onClick={() => onUpdate(rIdx, fIdx, { status: status === 'approved' ? 'pending' : 'approved' })}
                    sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: 11 }}
                    title="אשר תיקון — להישלח במייל"
                  >
                    ✓ אשר
                  </Button>
                  <Button
                    size="small"
                    variant={status === 'rejected' ? 'contained' : 'outlined'}
                    color="error"
                    onClick={() => onUpdate(rIdx, fIdx, { status: status === 'rejected' ? 'pending' : 'rejected' })}
                    sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: 11 }}
                    title="לא רלוונטי — להתעלם"
                  >
                    ✗ דחה
                  </Button>
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: status === 'approved' ? 'success.main' : status === 'rejected' ? 'error.main' : 'text.secondary',
                  }}>
                    {status === 'approved' ? 'יישלח' : status === 'rejected' ? 'יוסר מהמייל' : 'לסקירה'}
                  </Typography>
                </Stack>
              </Box>
            );
          })}
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => onAdd(rIdx)}
            sx={{ alignSelf: 'flex-start', fontSize: 12 }}
          >
            הוסף תיקון
          </Button>
        </Stack>
      </Collapse>
    </Paper>
  );
}

// ── Diff comparison field map ──
//
// Each entry describes ONE quantity that appears in both the table and the
// payslip (or in just one of them) and how to extract it. The diff renderer
// uses this to show a gap-highlighted comparison table.
//
//   tableKey / tablePath / tableSum: how to read the value from table_row
//   payslipKey / payslipPath:        how to read from payslip
//   tolerance:                       absolute diff allowed before flagging
//   currency / days / hours:         formatting hint
const DIFF_FIELDS = [
  { key: 'days',         label: 'ימי עבודה',           tableKey: 'days',                payslipKey: 'paid_days',       tolerance: 0.5, days: true },
  { key: 'hours_total',  label: 'סה״כ שעות',           tableSum: ['hours_regular', 'ot_125', 'ot_150'], payslipFn: (p) => {
    // Header paid_hours when present; otherwise sum of line-item qty (hourly employees show 0/0 in header).
    if (p?.paid_hours && p.paid_hours > 0) return p.paid_hours;
    const items = (p?.item_regular_hours || 0) + (p?.item_ot_125_hours || 0) + (p?.item_ot_150_hours || 0);
    return items > 0 ? items : (p?.paid_hours ?? null);
  }, tolerance: 1, hours: true },
  { key: 'hours_reg',    label: 'שעות רגילות',         tableKey: 'hours_regular',       payslipFn: (p) => p?.item_regular_hours ?? null, tolerance: 1, hours: true },
  { key: 'ot_125',       label: 'שעות נוספות 125%',    tableKey: 'ot_125',              payslipFn: (p) => p?.item_ot_125_hours ?? null,   tolerance: 0.5, hours: true },
  { key: 'ot_150',       label: 'שעות נוספות 150%',    tableKey: 'ot_150',              payslipFn: (p) => p?.item_ot_150_hours ?? null,   tolerance: 0.5, hours: true },
  { key: 'hourly_rate',  label: 'תעריף שעתי',          tableKey: 'hourly_rate',         payslipKey: 'hourly_rate',     tolerance: 0.5, currency: true },
  // שכר תקן — prefer the money actually paid over the header's תעריף. On a
  // part-time payslip the header carries the FULL-TIME rate (₪9,000) while the
  // agreed pay is the כמות-scaled amount (0.66 → ₪5,983), and comparing the
  // table against the rate turned a correct payslip into a ₪3,017 shortfall.
  // The candidate list is the same one the comparator matches against, so the
  // two views can no longer disagree about the same payslip.
  { key: 'global',       label: 'שכר תקן',          tableKey: 'global_salary_amount', payslipFn: (p) => p?.base_salary_paid ?? p?.base_salary ?? null, candidatesKey: 'base_salary_candidates', tolerance: 1, currency: true, suffixKey: 'global_salary_kind' },
  { key: 'global_ot',    label: 'שעות נוספות גלובלי',  tableKey: 'global_ot_amount',    payslipKey: 'global_ot_amount', tolerance: 1, currency: true, suffixKey: 'global_salary_kind' },
  { key: 'transport',    label: 'נסיעות',              tableKey: 'transport',           payslipKey: 'transport_value', tolerance: 0.5, currency: true },
  { key: 'recup',        label: 'הבראה',               tableKey: 'recuperation',        payslipKey: null,              currency: true, infoOnly: true, note: 'מופיע בתלוש כ-"שווי הבראה" או "סיבוס"' },
  { key: 'cibus',        label: 'סיבוס / שווי ארוחות', tableKey: 'cibus',               payslipKey: 'meal_value',      tolerance: 0.5, currency: true },
  { key: 'gift',         label: 'כרטיס מתנה',          tableKey: 'gift_card',           payslipKey: null,              currency: true, infoOnly: true },
  { key: 'reserve',      label: 'מילואים',              tableKey: 'reserve_duty',        payslipKey: null,              days: true, infoOnly: true },
  { key: 'vacation_used', label: 'חופשה — ימי ניצול',   tableKey: 'vacation_days',       payslipPath: ['vacation', 'used'], tolerance: 1, days: true, absVal: true },
  { key: 'sick_used',    label: 'מחלה — ימי ניצול',    tableKey: 'sick_days',           payslipPath: ['sick', 'used'],     tolerance: 0.5, days: true },
  { key: 'holidays',     label: 'דמי חגים — ימים',      tableKey: 'holiday_days',        payslipKey: null,              days: true, infoOnly: true },
];

function getValueByPath(obj, path) {
  if (!obj || !path) return null;
  let v = obj;
  for (const seg of path) v = v?.[seg];
  return v ?? null;
}

function getTableValue(tableRow, field) {
  if (!tableRow) return null;
  if (field.tableSum) {
    const sum = field.tableSum.reduce((s, k) => s + (Number(tableRow[k]) || 0), 0);
    return sum > 0 ? sum : null;
  }
  if (field.tableKey) return tableRow[field.tableKey];
  return null;
}

function getPayslipValue(payslip, field) {
  if (!payslip) return null;
  if (field.payslipFn) return field.payslipFn(payslip);
  if (field.payslipPath) return getValueByPath(payslip, field.payslipPath);
  if (field.payslipKey) return payslip[field.payslipKey];
  return null;
}

function fmt(value, field) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value !== 'number') return String(value);
  const formatted = Number.isInteger(value) ? value.toLocaleString('he-IL') : value.toFixed(2);
  if (field?.currency) return `₪${formatted}`;
  if (field?.days) return `${formatted}`;
  if (field?.hours) return `${formatted}h`;
  return formatted;
}

/**
 * Side-by-side diff between the table row and the parsed payslip.
 *
 * Each row shows status:
 *   - match   ✓ green   — values agree within tolerance
 *   - gap     ⚠ red     — both have values but they disagree
 *   - missing ⚪ gray    — payslip doesn't expose this field; needs manual check
 *   - none              — neither side has data; row hidden by default
 *
 * Toggle "show all" to also surface the no-data rows.
 */
function DiffPanel({ tableRow, payslip, cibusRow }) {
  const [showAll, setShowAll] = useState(false);
  // Hourly employee = the table has hourly_rate but no global salary. For these
  // rows the payslip's base_salary equals rate × hours, NOT a global figure —
  // so a "שכר תקן" comparison is meaningless and should be hidden.
  const isHourlyEmployee = tableRow
    && (tableRow.hourly_rate || 0) > 0
    && !tableRow.global_salary_amount
    && !tableRow.global_salary;
  // Global-salary employee = the table carries a שכר תקן. For these rows
  // hours aren't paid per-unit, so שעות-related comparisons are meaningless
  // (any "shortfall" is handled by the comparator only when the notes carry
  // a "מחויבת ל-N שעות" directive).
  const isGlobalEmployee = tableRow
    && ((tableRow.global_salary_amount || 0) > 0 || (tableRow.global_salary || 0) > 0);
  const HOUR_KEYS = new Set(['hours_total', 'hours_reg', 'ot_125', 'ot_150', 'hourly_rate']);
  // Vacation directives in the notes column can carry the expected usage even
  // when the structured vacation_days column is empty. Recognise:
  //   "להוריד N ימי חופשה" → expected usage = N
  //   "לאפס חופשה"          → expected usage = 0 (zeroing instruction)
  const notes = tableRow?.notes || '';
  let directiveVacationUsed = null;
  const deductMatch = notes.match(/להוריד\s*(\d+(?:\.\d+)?)\s*ימי?\s*חופשה/);
  if (deductMatch) directiveVacationUsed = Number(deductMatch[1]);
  else if (/לאפס\s*ימי?\s*חופשה/.test(notes)) directiveVacationUsed = 0;
  const rows = DIFF_FIELDS.map((field) => {
    let tableVal = getTableValue(tableRow, field);
    let payslipVal = getPayslipValue(payslip, field);
    // Pull vacation expectation from the notes directive when the column is
    // empty — so a payslip ניצול=8 isn't flagged as a gap when the manager
    // explicitly instructed "להוריד 8 ימי חופשה".
    if (field.key === 'vacation_used' && tableVal == null && directiveVacationUsed != null) {
      tableVal = directiveVacationUsed;
    }

    let status; // 'match' | 'gap' | 'missing' | 'none'
    let delta = null;

    // Hide global-salary rows for hourly employees (avoid false-positive gap).
    if (isHourlyEmployee && (field.key === 'global' || field.key === 'global_ot')) {
      return { field, tableVal, payslipVal: null, status: 'none', delta: null };
    }
    // Hide hour-detail rows for global-salary employees (they're paid lump-sum).
    if (isGlobalEmployee && HOUR_KEYS.has(field.key)) {
      return { field, tableVal, payslipVal: null, status: 'none', delta: null };
    }
    // Net-target global salary: the table value is NET, the payslip is GROSS
    // after gross-up. Direct comparison is invalid — show as info, not gap.
    if (field.key === 'global' && tableRow?.global_salary_kind === 'net'
        && tableVal != null && payslipVal != null) {
      return { field, tableVal, payslipVal, status: 'missing', delta: null };
    }

    if (tableVal === null && payslipVal === null) {
      status = 'none';
    } else if (field.infoOnly || payslipVal === null) {
      status = tableVal === null ? 'none' : 'missing';
    } else if (tableVal === null) {
      // Payslip has it but table doesn't — flag as gap (extra payment / missing instruction)
      status = 'gap';
      delta = payslipVal;
    } else {
      const t = typeof tableVal === 'number' ? tableVal : Number(tableVal);
      const p = typeof payslipVal === 'number' ? payslipVal : Number(payslipVal);
      const pCompare = field.absVal ? Math.abs(p) : p;
      const tol = field.tolerance ?? 0.01;
      if (Number.isFinite(t) && Number.isFinite(pCompare) && Math.abs(t - pCompare) <= tol) {
        status = 'match';
      } else if (Number.isFinite(t) && Number.isFinite(pCompare)) {
        status = 'gap';
        delta = pCompare - t;
        // The payslip's base line carries several money columns (סכום התשלום /
        // נטו-לגילום / שכר-לקופ"ג). The comparator accepts a match against any
        // of them; this panel used to compare only one, so the same payslip
        // could read "fine" in the findings and "₪3,017 off" here. Fall back to
        // the same candidate list before calling it a gap.
        const candidates = field.candidatesKey ? payslip?.[field.candidatesKey] : null;
        if (Array.isArray(candidates)) {
          const hit = candidates.find((c) => Number.isFinite(c) && Math.abs(t - c) <= tol);
          if (hit != null) {
            status = 'match';
            payslipVal = hit;
            delta = null;
          }
        }
      } else {
        // One side is non-numeric — show without comparison
        status = 'missing';
      }
    }
    return { field, tableVal, payslipVal, status, delta };
  });

  // Cibus row from Pluxee report — show as a special row at top if present
  const cibusComparison = cibusRow && tableRow ? (() => {
    const tableCibus = tableRow.cibus;
    const reportAmount = cibusRow.amount;
    if (reportAmount == null) return null;
    let status = 'match';
    let delta = null;
    if (tableCibus == null) {
      status = 'gap';
      delta = reportAmount;
    } else if (Math.abs(tableCibus - reportAmount) > 0.5) {
      status = 'gap';
      delta = reportAmount - tableCibus;
    }
    return {
      field: { label: '🍽 סיבוס לפי דוח Pluxee', currency: true, special: true },
      tableVal: tableCibus,
      payslipVal: reportAmount,
      status,
      delta,
      cibusDays: cibusRow.days,
    };
  })() : null;

  const visible = showAll ? rows : rows.filter((r) => r.status === 'gap' || r.status === 'missing');
  const gapCount = rows.filter((r) => r.status === 'gap').length + (cibusComparison?.status === 'gap' ? 1 : 0);
  const missingCount = rows.filter((r) => r.status === 'missing').length;

  const STATUS_STYLE = {
    gap:     { bg: '#fdecea', icon: '⚠', color: 'error.main' },
    missing: { bg: '#fafafa', icon: '○', color: 'text.secondary' },
    match:   { bg: '#e8f5e9', icon: '✓', color: 'success.main' },
    none:    { bg: 'transparent', icon: '·', color: 'text.disabled' },
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          השוואת פערים
        </Typography>
        {gapCount > 0 && <Chip size="small" color="error"   label={`${gapCount} פערים`} sx={{ height: 18, fontSize: 10 }} />}
        {missingCount > 0 && <Chip size="small" variant="outlined" label={`${missingCount} לאימות ידני`} sx={{ height: 18, fontSize: 10 }} />}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          onClick={() => setShowAll((v) => !v)}
          sx={{ fontSize: 11 }}
        >
          {showAll ? 'הסתר תואמים' : 'הצג הכל (כולל תואמים)'}
        </Button>
      </Stack>
      <Table size="small" sx={{
        '& td, & th': { fontSize: 12, py: 0.5, borderColor: 'rgba(0,0,0,0.06)' },
        '& tr:last-of-type td': { borderBottom: 'none' },
      }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 28 }}></TableCell>
            <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>שדה</TableCell>
            <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>בטבלה (לרו"ח)</TableCell>
            <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>בתלוש</TableCell>
            <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>פער</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {/* Cibus row — special row at top when Pluxee report is available */}
          {cibusComparison && (
            <TableRow sx={{ bgcolor: STATUS_STYLE[cibusComparison.status].bg, borderLeft: '3px solid', borderColor: 'info.main' }}>
              <TableCell align="center" sx={{ color: STATUS_STYLE[cibusComparison.status].color, fontWeight: 700 }}>
                {STATUS_STYLE[cibusComparison.status].icon}
              </TableCell>
              <TableCell>
                {cibusComparison.field.label}
                {cibusComparison.cibusDays != null && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                    {cibusComparison.cibusDays} ימי שימוש
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ fontWeight: 600 }}>{fmt(cibusComparison.tableVal, cibusComparison.field)}</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>{fmt(cibusComparison.payslipVal, cibusComparison.field)} <Typography component="span" variant="caption" color="info.main">(מ-Pluxee)</Typography></TableCell>
              <TableCell sx={{ fontWeight: 700, color: cibusComparison.status === 'gap' ? 'error.main' : 'text.disabled' }}>
                {cibusComparison.status === 'gap' && cibusComparison.delta != null
                  ? (cibusComparison.delta > 0 ? '+' : '') + fmt(cibusComparison.delta, cibusComparison.field)
                  : '—'}
              </TableCell>
            </TableRow>
          )}
          {visible.length === 0 && !cibusComparison ? (
            <TableRow>
              <TableCell colSpan={5} align="center" sx={{ py: 1.5, color: 'success.dark' }}>
                ✓ אין פערים בנתונים שניתן להשוות אוטומטית
              </TableCell>
            </TableRow>
          ) : (
            visible.map((r) => {
              const meta = STATUS_STYLE[r.status];
              return (
                <TableRow key={r.field.key} sx={{ bgcolor: meta.bg }}>
                  <TableCell align="center" sx={{ color: meta.color, fontWeight: 700 }}>{meta.icon}</TableCell>
                  <TableCell>
                    {r.field.label}
                    {r.field.note && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                        {r.field.note}
                      </Typography>
                    )}
                    {/* Part-time base pay — spell out the arithmetic, otherwise
                        the payslip's big תעריף number looks like the salary and
                        the smaller amount looks like an error. */}
                    {r.field.key === 'global' && payslip?.base_salary_paid != null && payslip?.job_percent != null && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                        {payslip.job_percent} משרה × ₪{Number(payslip.base_salary_rate).toLocaleString('he-IL')} (תעריף מלא)
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {fmt(r.tableVal, r.field)}
                    {r.field.suffixKey && tableRow?.[r.field.suffixKey] && tableRow[r.field.suffixKey] !== 'unknown' && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                        ({tableRow[r.field.suffixKey] === 'net' ? 'נטו' : 'ברוטו'})
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {r.status === 'missing'
                      ? <Typography variant="caption" color="text.secondary">לא חולץ אוטומטית</Typography>
                      : fmt(r.payslipVal, r.field)}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700, color: r.status === 'gap' ? 'error.main' : 'text.disabled' }}>
                    {r.status === 'gap' && r.delta != null
                      ? (r.delta > 0 ? '+' : '') + fmt(r.delta, r.field)
                      : '—'}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Box>
  );
}

function StatTile({ label, value, color = 'default' }) {
  return (
    <Paper elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: `${color}.50`, textAlign: 'center', minWidth: 90 }}>
      <Typography variant="h5" sx={{ fontWeight: 800, color: color === 'default' ? 'text.primary' : `${color}.dark` }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Paper>
  );
}

function ResultCard({ result, expanded, onToggle, savedAuditId, reviewed, onToggleReviewed, priorNotes, previewKind }) {
  const name = result.table_row?.employee_name || result.payslip?.employee_name || '—';
  // Prefer __source_branch (set by /run-multi) — it's the canonical branch the
  // PDF was tagged with — over the table_row's branch column which may have
  // mid-name whitespace from the xlsx.
  const branch = result.__source_branch || result.table_row?.branch || '';
  const id = result.payslip?.employee_id;
  const empNo = result.payslip?.employee_no;
  // PDF preview state — opens a dialog with an iframe loading the specific
  // page from the stored payslip PDF for this employee. We fetch with auth
  // (iframe can't carry Authorization headers) and convert to a blob URL.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBlobUrl, setPreviewBlobUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Active preview can be SWITCHED to a previous month for the same employee
  // — `activePreview` holds {auditId, branch, page} that's currently loaded.
  const [activePreview, setActivePreview] = useState(null);
  // History of this employee across all saved audits (Phase 2)
  const [employeeHistory, setEmployeeHistory] = useState([]);
  const canPreview = !!(savedAuditId && result.payslip?.page_index && (result.__source_branch || branch));

  // When the dialog opens for the first time, default to the current audit.
  useEffect(() => {
    if (previewOpen && !activePreview && canPreview) {
      setActivePreview({
        auditId: savedAuditId,
        branch,
        page: result.payslip.page_index,
        // A correction round reuses the origin audit's id, so the page has to
        // be pulled from that round's upload rather than the original file.
        kind: previewKind || null,
        year_month: null, // current
      });
    }
    if (!previewOpen) setActivePreview(null);
  }, [previewOpen, activePreview, canPreview, savedAuditId, branch, result.payslip?.page_index]);

  // Load PDF page for whichever audit/branch/page is active
  useEffect(() => {
    if (!activePreview) return;
    let cancelled = false;
    let createdUrl = null;
    setPreviewLoading(true);
    setPreviewError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/payroll/payslip-audit/history/${activePreview.auditId}/payslip-page?branch=${encodeURIComponent(activePreview.branch)}&page=${activePreview.page}${activePreview.kind ? `&kind=${encodeURIComponent(activePreview.kind)}` : ''}`,
          { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } }
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `שגיאה ${res.status}`);
        const blob = await res.blob();
        createdUrl = URL.createObjectURL(blob);
        if (!cancelled) setPreviewBlobUrl(createdUrl);
      } catch (err) {
        if (!cancelled) setPreviewError(err.message || 'שגיאה בטעינת תצוגה מקדימה');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setPreviewBlobUrl(null);
    };
  }, [activePreview]);

  // Load this employee's history across all audits when dialog opens
  useEffect(() => {
    if (!previewOpen || !canPreview) return;
    const params = id ? `id=${encodeURIComponent(id)}` : `name=${encodeURIComponent(name)}`;
    fetch(`/api/payroll/payslip-audit/employee-history?${params}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
    })
      .then((r) => r.ok ? r.json() : { occurrences: [] })
      .then((d) => setEmployeeHistory(d.occurrences || []))
      .catch(() => setEmployeeHistory([]));
  }, [previewOpen, canPreview, id, name]);

  const counts = { critical: 0, warning: 0, info: 0, ok: 0 };
  for (const f of result.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const topSeverity =
    counts.critical > 0 ? 'critical'
    : counts.warning > 0 ? 'warning'
    : counts.info > 0 ? 'info'
    : 'ok';

  const borderColor =
    reviewed ? 'success.main'
    : topSeverity === 'critical' ? 'error.main'
    : topSeverity === 'warning' ? 'warning.main'
    : topSeverity === 'info' ? 'info.light'
    : 'success.light';

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, border: 2, borderColor, bgcolor: reviewed ? 'rgba(46,125,50,0.04)' : undefined }}>
      <Box
        onClick={onToggle}
        sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
      >
        {SEVERITY_META[topSeverity].icon}
        <Box sx={{ flex: 1, mr: 1, ml: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {name}
            {empNo != null && <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>#{empNo}</Typography>}
            {id && <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>{id}</Typography>}
          </Typography>
          {branch && (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
              <Chip
                label={branch.replace(/\s+/g, ' ').trim()}
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
              />
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {onToggleReviewed && (
            <Chip
              size="small"
              icon={<CheckCircleIcon />}
              label="נבדק"
              color={reviewed ? 'success' : 'default'}
              variant={reviewed ? 'filled' : 'outlined'}
              onClick={(e) => { e.stopPropagation(); onToggleReviewed(); }}
              sx={{ fontWeight: 700, cursor: 'pointer' }}
            />
          )}
          {counts.critical > 0 && <Chip size="small" color="error"   label={counts.critical} />}
          {counts.warning > 0  && <Chip size="small" color="warning" label={counts.warning} />}
          {counts.info > 0     && <Chip size="small" color="info"    label={counts.info} />}
          {counts.ok > 0       && <Chip size="small" color="success" label={counts.ok} />}
          {canPreview && (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); setPreviewOpen(true); }}
              title="תצוגה מקדימה של התלוש"
              sx={{ color: 'primary.main' }}
            >
              <DescriptionIcon fontSize="small" />
            </IconButton>
          )}
          <IconButton size="small">
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>
      </Box>

      {/* PDF preview dialog — PDF iframe on the left, expected-vs-detected
          diff panel on the right so the user can verify the parser's reading
          against the actual payslip without flipping screens. */}
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} fullWidth maxWidth="xl" dir="rtl">
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <DescriptionIcon color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
              תלוש: {name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {activePreview?.year_month
                ? `חודש ${activePreview.year_month}`
                : 'חודש נוכחי'}
              {' · '}
              עמוד {activePreview?.page} · {(activePreview?.branch || branch).replace(/\s+/g, ' ').trim()}
            </Typography>
          </Stack>
          {/* Phase 2: chips of previous months for the same employee.
              Click switches the iframe to that month's page. */}
          {employeeHistory.length > 1 && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', mr: 0.5 }}>
                חודשים קודמים:
              </Typography>
              {employeeHistory.map((h, i) => {
                const isActive = activePreview?.auditId === h.audit_id && activePreview?.page === h.page_index;
                return (
                  <Chip
                    key={i}
                    label={`${h.year_month || '?'}${h.approved ? ' ✓' : ''}${h.critical_count > 0 ? ` · ${h.critical_count}🔴` : ''}`}
                    size="small"
                    color={isActive ? 'primary' : h.approved ? 'success' : 'default'}
                    variant={isActive ? 'filled' : 'outlined'}
                    onClick={() => h.page_index && setActivePreview({
                      auditId: h.audit_id,
                      branch: h.branch,
                      page: h.page_index,
                      year_month: h.year_month,
                    })}
                    disabled={!h.page_index}
                    sx={{ height: 22, fontSize: 10, fontWeight: 600 }}
                    title={h.approved ? 'מאושר' : `${h.finding_count} תיקונים`}
                  />
                );
              })}
            </Stack>
          )}
        </DialogTitle>
        <DialogContent sx={{ p: 0, height: '82vh', display: 'flex', alignItems: 'stretch', gap: 0 }}>
          {/* Left: PDF iframe (page from the persisted payslip) */}
          <Box sx={{ flex: '1 1 60%', display: 'flex', alignItems: 'stretch', borderInlineStart: 1, borderColor: 'divider' }}>
            {previewLoading && (
              <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CircularProgress />
              </Box>
            )}
            {previewError && !previewLoading && (
              <Box sx={{ flex: 1, p: 2 }}>
                <Alert severity="error">{previewError}</Alert>
              </Box>
            )}
            {previewBlobUrl && !previewLoading && !previewError && (
              <iframe
                src={previewBlobUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="תצוגה מקדימה של התלוש"
              />
            )}
          </Box>
          {/* Right: expected (table) ↔ detected (payslip) diff for THIS employee */}
          <Box sx={{ flex: '1 1 40%', overflowY: 'auto', p: 1.5, bgcolor: 'grey.50' }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                השוואה: צפוי (טבלה) ↔ זוהה בתלוש
              </Typography>
              {activePreview?.year_month && (
                <Chip
                  label="חודש קודם — נתוני ההשוואה הם של החודש הנוכחי"
                  size="small"
                  color="warning"
                  variant="outlined"
                  sx={{ height: 20, fontSize: 10 }}
                />
              )}
            </Stack>
            {/* What we ASKED FOR comes before what we're comparing. A payslip
                number only means something against the instruction behind it —
                reviewing the diff first and finding the note underneath it is
                how a deliberate ₪5,983 gets read as a ₪3,017 error. */}
            {(result.table_row?.notes || result.table_row?.advance_directive) && (
              <Box sx={{ mb: 1.5, p: 1.25, bgcolor: '#fffbeb', border: '1px solid #fde68a', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.5 }}>
                  📝 הערות והוראות בטבלת המערכת (לרו״ח)
                </Typography>
                {result.table_row.advance_directive && (
                  <Typography variant="body2" sx={{ fontSize: 12, mb: 0.5 }}>
                    <b>מקדמה:</b> {result.table_row.advance_directive}
                  </Typography>
                )}
                {result.table_row.notes && (
                  <Typography variant="body2" sx={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {result.table_row.notes}
                  </Typography>
                )}
              </Box>
            )}
            {/* Corrections already sent to the accountant this month — with the
                correction round's verdict when one exists, so an ignored note
                doesn't look like a note that was never written. */}
            {priorNotes?.length > 0 && (
              <Box sx={{ mb: 1.5, p: 1.25, bgcolor: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ fontWeight: 800, display: 'block', mb: 0.5 }}>
                  ✉️ תיקונים שכבר נשלחו לרו״ח לחודש הזה ({priorNotes.length})
                </Typography>
                <Stack spacing={0.5}>
                  {priorNotes.map((n, i) => (
                    <Stack key={i} direction="row" spacing={0.75} alignItems="flex-start">
                      {n.verdict
                        ? <Chip size="small" color={VERDICT_COLOR[n.verdict]} label={VERDICT_LABEL[n.verdict]}
                            sx={{ height: 18, fontSize: 9.5, fontWeight: 700, minWidth: 74 }} />
                        : <Chip size="small" variant="outlined" label="נשלח" sx={{ height: 18, fontSize: 9.5, minWidth: 74 }} />}
                      <Typography variant="body2" sx={{ fontSize: 12 }}>
                        {n.message}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                          {' · '}{new Date(n.created_at).toLocaleDateString('he-IL')}
                          {n.verdict_round ? ` · סבב ${n.verdict_round}` : ''}
                        </Typography>
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
            <DiffPanel
              tableRow={result.table_row}
              payslip={result.payslip}
              cibusRow={result.cibus_row}
            />
            {/* Full system-table row — every column the accountant was given, not
                just the auto-compared numeric fields. */}
            {result.table_row?.system_detail?.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  📋 פירוט מלא — שורת המערכת (כל העמודות)
                </Typography>
                <Table size="small" sx={{ '& td': { fontSize: 12, py: 0.4, borderColor: 'rgba(0,0,0,0.06)' } }}>
                  <TableBody>
                    {result.table_row.system_detail.map((d, i) => (
                      <TableRow key={i} sx={d.strong ? { bgcolor: '#eef2ff' } : {}}>
                        <TableCell sx={{ color: 'text.secondary', width: '55%' }}>{d.label}</TableCell>
                        <TableCell sx={{ fontWeight: d.strong ? 800 : 600 }}>
                          {d.currency && typeof d.value === 'number'
                            ? `₪${d.value.toLocaleString('he-IL')}`
                            : d.value}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreviewOpen(false)}>סגור</Button>
        </DialogActions>
      </Dialog>
      <Collapse in={expanded}>
        <Divider />
        <Box sx={{ p: 2, bgcolor: 'grey.50' }}>
          <Stack spacing={1}>
            {result.findings.length === 0 ? (
              <Typography variant="body2" align="center" color="success.dark">✓ הכל תקין</Typography>
            ) : (
              result.findings.map((f, i) => {
                const meta = SEVERITY_META[f.severity];
                return (
                  <Alert
                    key={i}
                    severity={meta.color === 'success' ? 'success' : meta.color === 'info' ? 'info' : meta.color === 'warning' ? 'warning' : 'error'}
                    icon={meta.icon}
                    sx={{ '& .MuiAlert-message': { width: '100%' } }}
                  >
                    <Stack spacing={0.25}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Chip label={meta.label} size="small" color={meta.color} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                        <Typography variant="caption" color="text.secondary">{f.field}</Typography>
                      </Box>
                      <Typography variant="body2">{f.message}</Typography>
                      {(f.expected !== null || f.actual !== null) && (
                        <Typography variant="caption" color="text.secondary">
                          צפוי: <b>{formatVal(f.expected)}</b> | בפועל: <b>{formatVal(f.actual)}</b>
                        </Typography>
                      )}
                    </Stack>
                  </Alert>
                );
              })
            )}
          </Stack>
          {/* Primary diff view: side-by-side comparison with gaps highlighted */}
          <Box sx={{ mt: 2, p: 1.5, bgcolor: 'background.paper', borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
            <DiffPanel tableRow={result.table_row} payslip={result.payslip} cibusRow={result.cibus_row} />
          </Box>

          {/* Secondary: full per-side data, collapsible */}
          <Box sx={{ mt: 1.5 }}>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#666' }}>
                הצג את כל הנתונים (מהטבלה והתלוש)
              </summary>
              <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
                <ReadablePanel
                  title="📋 בטבלה (נשלח לרו״ח)"
                  obj={result.table_row}
                  fields={TABLE_FIELDS}
                />
                <ReadablePanel
                  title="📄 בתלוש (התקבל)"
                  obj={result.payslip}
                  fields={PAYSLIP_FIELDS}
                  extras={result.payslip ? (
                    <>
                      <LeaveRow label="חופשה (קודם · ניצול · יתרה)" leave={result.payslip.vacation} />
                      <LeaveRow label="מחלה (קודם · ניצול · יתרה)"   leave={result.payslip.sick} />
                      {(result.payslip.voluntary_deductions || []).map((d, i) => (
                        <TableRow key={`vol-${i}`}>
                          <TableCell sx={{ color: 'text.secondary', width: '45%' }}>
                            ניכוי: {d.description}
                          </TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{fmtNumber(d.amount, true)}</TableCell>
                        </TableRow>
                      ))}
                    </>
                  ) : null}
                />
              </Box>
            </details>
          </Box>
        </Box>
      </Collapse>
    </Card>
  );
}

/* Edit the stored per-branch manager email — the address the consolidated
   payslip bundle is sent to for each branch. */
export function BranchManagerEmailsDialog({ open, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/payroll/payslip-audit/branch-manager-emails')
      .then(res => setRows(res.data.branches || []))
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  }, [open]);
  const save = () => {
    setSaving(true);
    const emails = {};
    rows.forEach(r => { if ((r.email || '').trim()) emails[r.id] = r.email.trim(); });
    api.put('/payroll/payslip-audit/branch-manager-emails', { emails })
      .then(() => { toast.success('מיילי המנהלים נשמרו'); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בשמירה'))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>מיילי מנהלי סניפים</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" color="text.secondary">
          כתובת המייל של מנהל/ת כל סניף — אליה נשלח מייל מרוכז עם כל תלושי הסניף ודוח השעות.
          אם ריק, נשלח למשתמשי "מנהל סניף" המוגדרים במערכת.
        </Typography>
        {loading ? <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box> : (
          <Stack spacing={1.2} sx={{ mt: 1.5 }}>
            {rows.map((r, i) => (
              <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ width: 140, fontWeight: 600, flexShrink: 0 }}>{r.name}</Typography>
                <TextField size="small" fullWidth dir="ltr" placeholder="manager@example.com" value={r.email || ''}
                  onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
              </Stack>
            ))}
            {rows.length === 0 && <Typography variant="body2" color="text.secondary">אין סניפים.</Typography>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={saving || loading}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

const DIST_STATUS_HE = {
  sent: 'נשלח', no_email: 'אין מייל', no_match: 'לא הותאם', no_page: 'אין עמוד',
  no_pdf: 'אין קובץ', error: 'שגיאה',
};

/* Preview the EXACT content that will be emailed — the payslip PDF and the
   hours report — in two tabs, before sending. Works for both an employee
   (payslip page + personal hours) and a branch manager (branch PDF + branch
   hours). */
function SendContentPreview({ open, onClose, auditId, title, pdfEndpoint, pdfQuery, hoursQuery }) {
  const [tab, setTab] = useState('payslip');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [html, setHtml] = useState('');
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [loadingHours, setLoadingHours] = useState(false);
  const [err, setErr] = useState(null);
  const urlRef = useRef(null);
  const revoke = () => { if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  useEffect(() => {
    // Reset everything whenever the dialog is closed or has no target, so a
    // re-open never shows a stale/revoked blob URL.
    if (!open || !auditId) { revoke(); setPdfUrl(null); setHtml(''); setErr(null); return; }
    let cancelled = false;
    setTab('payslip'); setErr(null);
    revoke(); setPdfUrl(null); setLoadingPdf(true);
    api.get(`/payroll/payslip-audit/history/${auditId}/${pdfEndpoint}`, { params: pdfQuery, responseType: 'blob', timeout: 120000 })
      .then(res => { if (cancelled) return; const u = URL.createObjectURL(res.data); urlRef.current = u; setPdfUrl(u); })
      .catch(() => { if (!cancelled) setErr('התלוש אינו זמין לתצוגה'); })
      .finally(() => { if (!cancelled) setLoadingPdf(false); });
    setLoadingHours(true); setHtml('');
    // Branch/office hours reports can take a while (whole-branch salary compute).
    api.get(`/payroll/payslip-audit/history/${auditId}/hours-preview`, { params: hoursQuery, responseType: 'text', timeout: 180000 })
      .then(res => { if (!cancelled) setHtml(res.data); }).catch(() => {}).finally(() => { if (!cancelled) setLoadingHours(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [open, auditId, JSON.stringify(pdfQuery), JSON.stringify(hoursQuery), pdfEndpoint]);
  useEffect(() => revoke, []); // revoke on unmount
  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth PaperProps={{ sx: { height: '92vh' } }}>
      <DialogTitle sx={{ fontWeight: 700, pb: 0 }}>
        תצוגה מקדימה — {title}
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mt: 1, minHeight: 36 }}>
          <Tab value="payslip" label="תלוש שכר" sx={{ minHeight: 36 }} />
          <Tab value="hours" label="דוח שעות" sx={{ minHeight: 36 }} />
        </Tabs>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: '#f1f5f9' }}>
        {tab === 'payslip' ? (
          loadingPdf ? <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
            : err ? <Alert severity="warning" sx={{ m: 2 }}>{err}</Alert>
            : pdfUrl ? <iframe title="payslip" src={pdfUrl} style={{ width: '100%', height: '100%', border: 0 }} />
            : null
        ) : (
          loadingHours ? <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
            : <iframe title="hours" srcDoc={html} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>
  );
}

/* Distribute payslips to employees: review the ת"ז match per payslip, edit +
   save each employee's email, pick who to send to (or all), and see the log. */
export function PayslipDistributionDialog({ open, audit, onClose }) {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);
  const [includeHours, setIncludeHours] = useState(true);
  const [preview, setPreview] = useState(null); // { it } — the row being previewed
  const [polling, setPolling] = useState(false);
  const sentAtRef = useRef(0);

  // After a send is accepted, poll ONLY the log (don't touch items/selection)
  // until the background job finishes.
  useEffect(() => {
    if (!open || !polling || !audit?._id) return undefined;
    const t = setInterval(async () => {
      if (Date.now() - sentAtRef.current > 30 * 60 * 1000) { setPolling(false); return; }
      try {
        const res = await api.get(`/payroll/payslip-audit/history/${audit._id}/distribution-preview`);
        const lg = res.data.distribution?.employees || null;
        setLog(lg);
        if (lg?.at && new Date(lg.at).getTime() >= sentAtRef.current && !lg.running) {
          setPolling(false);
          const errs = (lg.results || []).filter(r => r.status === 'error').length;
          if (errs) toast.error(`השליחה הסתיימה עם ${errs} שגיאות — ראה/י לוג`);
          else toast.success('השליחה הושלמה ✓');
        }
      } catch { /* keep polling */ }
    }, 10000);
    return () => clearInterval(t);
  }, [open, polling, audit?._id]);

  const load = () => {
    if (!audit?._id) return;
    setLoading(true);
    api.get(`/payroll/payslip-audit/history/${audit._id}/distribution-preview`)
      .then(res => {
        const its = res.data.items || [];
        setItems(its);
        const s = {};
        its.forEach(it => { if (it.employee_id && it.email && it.has_page) s[it.employee_id] = true; });
        setSel(s);
        setLog(res.data.distribution?.employees || null);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, audit?._id]);

  const selectableIds = items.filter(it => it.employee_id).map(it => it.employee_id);
  const selectedIds = selectableIds.filter(id => sel[id]);
  const allChecked = selectableIds.length > 0 && selectedIds.length === selectableIds.length;
  const someChecked = selectedIds.length > 0 && !allChecked;

  const persistEmails = async () => {
    const updates = items.filter(it => it.employee_id).map(it => ({ employee_id: it.employee_id, email: (it.email || '').trim() }));
    try { await api.put('/payroll/payslip-audit/employees/emails', { updates }); return true; }
    catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשמירת מיילים'); return false; }
  };
  const saveEmails = async () => { setBusy(true); if (await persistEmails()) toast.success('מיילים נשמרו'); setBusy(false); };

  const send = async (all) => {
    const ids = all ? [] : selectedIds;
    if (!all && ids.length === 0) { toast.error('בחר/י לפחות עובד אחד'); return; }
    const who = all ? 'לכל העובדים המותאמים' : `ל-${ids.length} עובדים נבחרים`;
    // In-app confirm — window.confirm can be silently suppressed by the browser
    // ("prevent additional dialogs"), making the button appear dead.
    if (!(await confirm({
      title: 'שליחת תלושים לעובדים',
      message: `לשלוח ${who} את התלוש${includeHours ? ' + דוח השעות' : ''}? הפעולה מסמנת את חודש השכר כאושר+שולם ושומרת עותק בתיק כל עובד.`,
      confirm_label: 'שלח',
    }))) return;
    setBusy(true);
    await persistEmails();
    try {
      // Generous timeout: a sleeping free-tier instance takes >30s to wake.
      const res = await api.post(`/payroll/payslip-audit/history/${audit._id}/send-employees`,
        { ...(all ? {} : { employee_ids: ids }), include_hours: includeHours }, { timeout: 120000 });
      sentAtRef.current = Date.now(); setPolling(true);
      toast.success(`השליחה החלה — ${res.data.count} עובדים. הלוג מתעדכן אוטומטית (הכנת PDF אורכת מספר דקות).`, { autoClose: 8000 });
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשליחה'); }
    finally { setBusy(false); }
  };

  const logCounts = (log?.results || []).reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

  return (
    <>
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth PaperProps={{ sx: { height: '90vh' } }}>
      <DialogTitle sx={{ fontWeight: 700 }}>הפצת תלושים לעובדים{audit?.year_month ? ` · ${audit.year_month}` : ''}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" color="text.secondary">
          כל תלוש מותאם לעובד לפי <b>ת"ז</b>. ערכ/י מייל לכל עובד (נשמר לעתיד), בחר/י למי לשלוח — כל עובד מקבל את התלוש שלו + דוח השעות שלו.
        </Typography>
        {loading ? <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box> : (
          <Table size="small" sx={{ mt: 1.5 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox"><Checkbox size="small" checked={allChecked} indeterminate={someChecked} onChange={e => { const v = e.target.checked; const s = {}; selectableIds.forEach(id => { s[id] = v; }); setSel(s); }} /></TableCell>
                <TableCell sx={{ fontWeight: 700 }}>עובד</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>ת"ז</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>התאמה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>מייל (ניתן לעריכה)</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="center">עמוד</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((it, i) => (
                <TableRow key={i} sx={{ bgcolor: !it.matched ? '#fef2f2' : !it.has_page ? '#fffbeb' : undefined }}>
                  <TableCell padding="checkbox"><Checkbox size="small" disabled={!it.employee_id || !it.has_page} checked={!!sel[it.employee_id]} onChange={() => setSel(s => ({ ...s, [it.employee_id]: !s[it.employee_id] }))} /></TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{it.employee_name || it.payslip_name || '—'}</TableCell>
                  <TableCell dir="ltr">{it.payslip_id || '—'}</TableCell>
                  <TableCell>
                    {!it.matched ? <Chip size="small" color="error" label="לא הותאם" />
                      : it.id_verified ? <Chip size="small" color="success" label='✓ ת"ז מאומת' />
                        : <Chip size="small" color="warning" label="הותאם (בדוק)" />}
                  </TableCell>
                  <TableCell>
                    <TextField size="small" fullWidth dir="ltr" placeholder="—" value={it.email || ''} disabled={!it.employee_id}
                      onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
                  </TableCell>
                  <TableCell align="center">
                    {it.has_page ? (
                      <Button size="small" variant="text" onClick={() => setPreview({ it })} sx={{ minWidth: 0, fontSize: 11 }}>
                        תצוגה
                      </Button>
                    ) : <Chip size="small" color="error" label="חסר" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {log && (
          <Box sx={{ mt: 2, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'grey.50' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>לוג שליחה אחרון</Typography>
              <Typography variant="caption" color="text.secondary">{log.at ? new Date(log.at).toLocaleString('he-IL') : ''}</Typography>
              <Box sx={{ flex: 1 }} />
              {(log.running || polling) && <Chip size="small" color="warning" icon={<CircularProgress size={12} color="inherit" />} label="שליחה בתהליך..." />}
              {Object.entries(logCounts).map(([st, n]) => (
                <Chip key={st} size="small" color={st === 'sent' ? 'success' : st === 'error' ? 'error' : 'default'} label={`${DIST_STATUS_HE[st] || st}: ${n}`} />
              ))}
            </Stack>
            <Box sx={{ maxHeight: 130, overflowY: 'auto' }}>
              {(log.results || []).map((r, i) => (
                <Typography key={i} variant="caption" sx={{ display: 'block', color: r.status === 'sent' ? 'success.dark' : r.status === 'error' ? 'error.main' : 'text.secondary' }}>
                  {r.name} — {DIST_STATUS_HE[r.status] || r.status}{r.email ? ` · ${r.email}` : ''}{r.error ? ` — ${r.error}` : ''}
                </Typography>
              ))}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <FormControlLabel sx={{ ml: 0 }}
          control={<Switch size="small" checked={includeHours} onChange={e => setIncludeHours(e.target.checked)} />}
          label={<Typography variant="caption">צרף דוח שעות</Typography>} />
        <Tooltip title="שליחה לעובד נועלת את חודש השכר שלו כאושר+שולם ושומרת עותק של התלוש בתיק העובד">
          <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>שליחה = אושר ושולם ✓</Typography>
        </Tooltip>
        <Button onClick={load} disabled={busy || loading}>רענון לוג</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={saveEmails} disabled={busy || loading}>שמור מיילים</Button>
        <Button variant="contained" onClick={() => send(false)} disabled={busy || loading || selectedIds.length === 0}>שלח לנבחרים ({selectedIds.length})</Button>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
    <SendContentPreview
      open={!!preview} onClose={() => setPreview(null)} auditId={audit?._id}
      title={preview?.it?.employee_name || preview?.it?.payslip_name || ''}
      pdfEndpoint="payslip-page"
      pdfQuery={preview ? { branch: preview.it.branch, page: preview.it.page } : {}}
      hoursQuery={preview ? { scope: 'employee', employee_id: preview.it.employee_id } : {}}
    />
    </>
  );
}

/* ── Correction rounds ──────────────────────────────────────────────────────

   After the notes go out, the accountant sends corrected payslips back. Before
   this the only way to check him was to delete the audit and re-run the whole
   month — which threw away the very notes you were trying to verify. Here the
   audit stays put: upload only the corrected PDFs, and every note gets graded
   ✓ תוקן / ✗ לא תוקן against the salary table already stored with the audit.

   Notes the manager typed by hand have no machine field behind them, so they
   can't be graded automatically — they come back as a question to settle by
   hand rather than as a confident wrong answer.                            */

const VERDICT_LABEL = { fixed: '✓ תוקן', not_fixed: '✗ לא תוקן', manual: '? להכרעה' };
const VERDICT_COLOR = { fixed: 'success', not_fixed: 'error', manual: 'warning' };

/* Identify an employee the same way the server does, so notes written in an
   earlier audit land on the right person here. Must mirror targetKey() in
   payslipAudit.controller.js — a drift between the two silently hides notes. */
function resultKey(r) {
  const id = r?.payslip?.employee_id || r?.table_row?.employee_id;
  if (id) return `id:${id}`;
  const name = (r?.table_row?.employee_name || r?.payslip?.employee_name || '').trim();
  const branch = (r?.table_row?.branch || r?.__source_branch || '').replace(/\s+/g, ' ').trim();
  return `nm:${name}::${branch}`;
}

export function FixRoundDialog({ open, auditId, branches = [], onClose, onOpenRound, onAddNote, onSendAccountant }) {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [files, setFiles] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [openRound, setOpenRound] = useState(null);
  const [preview, setPreview] = useState(null);   // { title, url }

  const load = async () => {
    if (!auditId) return;
    setLoading(true);
    try {
      const res = await api.get(`/payroll/payslip-audit/history/${auditId}/fix-rounds`);
      setData(res.data);
      const list = (res.data.branches?.length ? res.data.branches : branches);
      setFiles(list.length ? list.map((b) => ({ branch: b, file: null })) : [{ branch: '', file: null }]);
      setOpenRound(res.data.rounds?.length ? res.data.rounds[res.data.rounds.length - 1].round_no : null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת סבבי תיקון');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, auditId]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const runRound = async () => {
    const chosen = files.filter((r) => r.file && r.branch.trim());
    if (chosen.length === 0) { toast.warn('בחר לפחות קובץ תלושים אחד עם סניף'); return; }
    setBusy(true);
    try {
      const form = new FormData();
      chosen.forEach((row, i) => {
        form.append(`payslip_file_${i}`, row.file);
        form.append(`branch_${i}`, row.branch.trim());
      });
      if (note.trim()) form.append('note', note.trim());
      const res = await api.post(`/payroll/payslip-audit/history/${auditId}/fix-round`, form,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000 });
      const round = res.data.round;
      const s = round.summary;
      toast.success(`סבב ${round.round_no}: ${s.fixed} תוקנו · ${s.not_fixed} לא תוקנו · ${s.manual} להכרעה`);
      setNote('');
      setFiles((prev) => prev.map((r) => ({ ...r, file: null })));
      await load();
      // Land straight in the review screen with the corrected payslips, the way
      // a fresh upload does — a verdict list with no payslip beside it can't be
      // checked against anything.
      if (onOpenRound && round.audit_view) onOpenRound(round);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהרצת הסבב');
    } finally {
      setBusy(false);
    }
  };

  const setVerdict = async (roundNo, key, noteIndex, manual_verdict, reply) => {
    try {
      await api.patch(`/payroll/payslip-audit/history/${auditId}/fix-rounds/${roundNo}/verdict`,
        { key, note_index: noteIndex, manual_verdict, ...(reply !== undefined ? { reply } : {}) });
      setData((prev) => {
        if (!prev) return prev;
        const rounds = prev.rounds.map((r) => {
          if (r.round_no !== roundNo) return r;
          return {
            ...r,
            items: r.items.map((it) => it.key !== key ? it : {
              ...it,
              notes: it.notes.map((n, i) => i !== noteIndex ? n
                : { ...n, manual_verdict, ...(reply !== undefined ? { reply } : {}) }),
            }),
          };
        });
        return { ...prev, rounds };
      });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירת ההכרעה');
    }
  };

  const showPage = async (roundNo, it) => {
    if (!it.round_branch || !it.page_index) { toast.info('אין עמוד תלוש שמור לעובד הזה בסבב'); return; }
    try {
      const res = await fetch(
        `/api/payroll/payslip-audit/history/${auditId}/fix-rounds/${roundNo}/page?branch=${encodeURIComponent(it.round_branch)}&page=${it.page_index}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `שגיאה ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      setPreview({ title: `${it.employee_name} · סבב ${roundNo}`, url });
    } catch (err) {
      toast.error(err.message || 'שגיאה בטעינת התלוש');
    }
  };

  const makeToken = async () => {
    try {
      const res = await api.post(`/payroll/payslip-audit/history/${auditId}/fix-token`, {});
      setData((p) => ({ ...p, fix_token: res.data.token, fix_token_expires: res.data.expires }));
      toast.success('נוצר קישור העלאה לרו״ח');
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה ביצירת קישור'); }
  };
  const killToken = async () => {
    if (!(await confirm({ title: 'ביטול הקישור', message: 'לבטל את קישור ההעלאה? הרו״ח לא יוכל להעלות קבצים דרכו.', danger: true }))) return;
    try {
      await api.delete(`/payroll/payslip-audit/history/${auditId}/fix-token`);
      setData((p) => ({ ...p, fix_token: null, fix_token_expires: null }));
      toast.success('הקישור בוטל');
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה'); }
  };

  const fixUrl = data?.fix_token ? `${window.location.origin}/payslip-fix/${data.fix_token}` : '';

  return (
    <>
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" dir="rtl">
      <DialogTitle sx={{ fontWeight: 700 }}>
        סבבי תיקון — אימות שההערות בוצעו
        {data?.year_month && <Chip size="small" sx={{ mr: 1 }} label={data.year_month} />}
      </DialogTitle>
      <DialogContent dividers>
        {loading && <LinearProgress />}
        {data && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity={data.open_notes ? 'info' : 'warning'}>
              {data.open_notes
                ? <>הביקורת הזו כוללת <b>{data.open_notes}</b> הערות על <b>{data.open_targets}</b> תלושים. העלה את התלושים המתוקנים ונבדוק כל הערה מולם — הטבלה השמורה משמשת כמקור, לא צריך להעלות אותה מחדש.</>
                : <>אין הערות פתוחות בביקורת הזו. הוסף תיקון לעובד/ת כדי לפתוח סבב.</>}
            </Alert>

            {/* Problems surface while reading the round's results, so the two
                things you'd want next belong here rather than behind a close. */}
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              {onAddNote && (
                <Button size="small" variant="outlined" color="warning" startIcon={<AddIcon />}
                  onClick={() => onAddNote(load)}>
                  הוסף תיקון לסבב הבא
                </Button>
              )}
              {onSendAccountant && (
                <Button size="small" variant="outlined" startIcon={<EmailIcon />}
                  disabled={!data.open_notes} onClick={onSendAccountant}>
                  שלח לרו״ח {data.open_notes ? `(${data.open_notes} הערות)` : ''}
                </Button>
              )}
            </Stack>

            {/* Upload */}
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>העלאת תלושים מתוקנים</Typography>
              <Stack spacing={1}>
                {files.map((row, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center">
                    <TextField size="small" label="סניף" value={row.branch} sx={{ minWidth: 200 }}
                      onChange={(e) => setFiles((p) => p.map((x, j) => j === i ? { ...x, branch: e.target.value } : x))} />
                    <Button size="small" variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                      {row.file ? row.file.name : 'בחר PDF'}
                      <input hidden type="file" accept="application/pdf"
                        onChange={(e) => { const f = e.target.files?.[0] || null; setFiles((p) => p.map((x, j) => j === i ? { ...x, file: f } : x)); }} />
                    </Button>
                    {files.length > 1 && (
                      <IconButton size="small" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><DeleteIcon fontSize="small" /></IconButton>
                    )}
                  </Stack>
                ))}
                <Box>
                  <Button size="small" startIcon={<AddIcon />} disabled={files.length >= 10}
                    onClick={() => setFiles((p) => [...p, { branch: '', file: null }])}>סניף נוסף</Button>
                </Box>
                <TextField size="small" label="הערה לסבב (אופציונלי)" value={note} onChange={(e) => setNote(e.target.value)} fullWidth />
                <Box>
                  <Button variant="contained" startIcon={<PlayArrowIcon />} disabled={busy || !data.open_notes} onClick={runRound}>
                    {busy ? 'בודק…' : 'הרץ אימות'}
                  </Button>
                </Box>
              </Stack>
            </Paper>

            {/* Accountant's own upload link */}
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>קישור העלאה לרו״ח</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                מאפשר לרו״ח להעלות בעצמו את התלושים המתוקנים בלי חשבון. הדף מציג לו רק את החודש ואת ההערות ששלחנו לו.
              </Typography>
              {fixUrl ? (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <TextField size="small" value={fixUrl} dir="ltr" sx={{ flex: 1, minWidth: 280 }} InputProps={{ readOnly: true }} />
                  <Button size="small" onClick={() => { navigator.clipboard.writeText(fixUrl); toast.success('הקישור הועתק'); }}>העתק</Button>
                  <Button size="small" color="error" onClick={killToken}>בטל קישור</Button>
                  {data.fix_token_expires && (
                    <Typography variant="caption" color="text.secondary">
                      בתוקף עד {new Date(data.fix_token_expires).toLocaleDateString('he-IL')}
                    </Typography>
                  )}
                </Stack>
              ) : (
                <Button size="small" variant="outlined" onClick={makeToken}>צור קישור</Button>
              )}
            </Paper>

            {/* Rounds */}
            {(data.rounds || []).length === 0 && <Alert severity="info">עדיין לא הורץ אף סבב תיקון.</Alert>}
            {[...(data.rounds || [])].reverse().map((r) => {
              const isOpen = openRound === r.round_no;
              const s = r.summary || {};
              return (
                <Paper key={r.round_no} variant="outlined">
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ p: 1.25, cursor: 'pointer' }}
                    onClick={() => setOpenRound(isOpen ? null : r.round_no)}>
                    <Typography sx={{ fontWeight: 800, flex: 1 }}>
                      סבב {r.round_no}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                        {new Date(r.created_at).toLocaleString('he-IL')} · {r.created_by_name || '—'}
                        {r.source === 'accountant' && ' · הועלה ע״י הרו״ח'}
                      </Typography>
                    </Typography>
                    <Chip size="small" color="success" label={`${s.fixed || 0} תוקנו`} />
                    <Chip size="small" color="error" label={`${s.not_fixed || 0} לא תוקנו`} />
                    {!!s.manual && <Chip size="small" color="warning" label={`${s.manual} להכרעה`} />}
                    {!!s.new_issues && <Chip size="small" color="error" variant="outlined" label={`${s.new_issues} ממצאים חדשים`} />}
                    {!!s.unmatched && <Chip size="small" variant="outlined" label={`${s.unmatched} לא בקובץ`} />}
                    {onOpenRound && r.audit_view && (
                      <Button size="small" variant="outlined" startIcon={<DescriptionIcon />}
                        onClick={(ev) => { ev.stopPropagation(); onOpenRound(r); }}>
                        פתח בתצוגה מלאה
                      </Button>
                    )}
                    {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  </Stack>
                  <Collapse in={isOpen}>
                    <Divider />
                    <Box sx={{ p: 1 }}>
                      {r.items.map((it) => (
                        <Paper key={it.key} variant="outlined" sx={{ p: 1, mb: 1, bgcolor: it.matched ? 'transparent' : 'grey.50' }}>
                          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                            <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{it.employee_name}</Typography>
                            {it.branch && <Typography variant="caption" color="text.secondary">{it.branch}</Typography>}
                            {!it.matched && <Chip size="small" variant="outlined" label="לא נמצא בקובץ הסבב" />}
                            <Box sx={{ flex: 1 }} />
                            {it.matched && it.page_index && (
                              <Button size="small" startIcon={<DescriptionIcon />} onClick={() => showPage(r.round_no, it)}>
                                תלוש מתוקן
                              </Button>
                            )}
                          </Stack>
                          <Stack spacing={0.75}>
                            {it.notes.map((n, ni) => {
                              const eff = n.manual_verdict || n.auto_verdict;
                              return (
                                <Box key={ni} sx={{ p: 0.75, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                                  <Stack direction="row" spacing={1} alignItems="flex-start">
                                    <Chip size="small" color={VERDICT_COLOR[eff]} label={VERDICT_LABEL[eff]}
                                      sx={{ fontWeight: 700, minWidth: 84 }} />
                                    <Box sx={{ flex: 1 }}>
                                      <Typography variant="body2">{n.message}</Typography>
                                      {eff === 'not_fixed' && (n.still_expected != null || n.still_actual != null) && (
                                        <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>
                                          עדיין: צפוי <b>{String(n.still_expected ?? '—')}</b> · בתלוש <b>{String(n.still_actual ?? '—')}</b>
                                        </Typography>
                                      )}
                                      {n.auto_verdict === 'manual' && (
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                          {it.matched
                                            ? 'הערה ידנית — אין לה בדיקה אוטומטית, הכרע לפי התלוש המתוקן.'
                                            : 'התלוש לא נמצא בקובץ הסבב. אם ההערה הייתה לבטל את התלוש — הביטול בוצע, סמן ✓. אחרת הרו״ח פשוט לא שלח אותו.'}
                                        </Typography>
                                      )}
                                      {n.manual_verdict && n.manual_verdict !== n.auto_verdict && n.auto_verdict !== 'manual' && (
                                        <Typography variant="caption" color="warning.dark" sx={{ display: 'block' }}>
                                          הוכרע ידנית (הבדיקה האוטומטית אמרה {VERDICT_LABEL[n.auto_verdict]})
                                        </Typography>
                                      )}
                                    </Box>
                                    <Stack direction="row" spacing={0.5}>
                                      <Button size="small" color="success"
                                        variant={n.manual_verdict === 'fixed' ? 'contained' : 'outlined'}
                                        sx={{ minWidth: 0, px: 1, fontSize: 11 }}
                                        onClick={() => setVerdict(r.round_no, it.key, ni, n.manual_verdict === 'fixed' ? null : 'fixed')}>✓</Button>
                                      <Button size="small" color="error"
                                        variant={n.manual_verdict === 'not_fixed' ? 'contained' : 'outlined'}
                                        sx={{ minWidth: 0, px: 1, fontSize: 11 }}
                                        onClick={() => setVerdict(r.round_no, it.key, ni, n.manual_verdict === 'not_fixed' ? null : 'not_fixed')}>✗</Button>
                                    </Stack>
                                  </Stack>
                                </Box>
                              );
                            })}
                            {it.new_findings.map((f, fi) => (
                              <Box key={`nf${fi}`} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'error.50', border: '1px solid', borderColor: 'error.light' }}>
                                <Typography variant="caption" sx={{ fontWeight: 800, color: 'error.dark' }}>⚠ ממצא חדש שלא היה בהערות: </Typography>
                                <Typography variant="caption">{f.message}</Typography>
                              </Box>
                            ))}
                          </Stack>
                        </Paper>
                      ))}
                    </Box>
                  </Collapse>
                </Paper>
              );
            })}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>סגור</Button></DialogActions>
    </Dialog>

    <Dialog open={!!preview} onClose={() => setPreview(null)} fullWidth maxWidth="md" dir="rtl">
      <DialogTitle>{preview?.title}</DialogTitle>
      <DialogContent dividers sx={{ height: '75vh', p: 0 }}>
        {preview && <iframe title="payslip" src={preview.url} style={{ width: '100%', height: '100%', border: 0 }} />}
      </DialogContent>
      <DialogActions><Button onClick={() => setPreview(null)}>סגור</Button></DialogActions>
    </Dialog>
    </>
  );
}

/* Distribute the consolidated per-branch payslip bundle to each branch manager.
   Preview which branches will be sent, their manager email + payslip count, pick
   which branches, toggle the hours report, then send. */
export function ManagerDistributionDialog({ open, audit, onClose }) {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [empSel, setEmpSel] = useState({});   // { [branch]: { [employee_id]: bool } }
  const [expanded, setExpanded] = useState({}); // { [branch]: bool }
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);
  const [includeHours, setIncludeHours] = useState(true);
  const [preview, setPreview] = useState(null); // { title, pdfEndpoint, pdfQuery, hoursQuery }
  const [specificEmail, setSpecificEmail] = useState(''); // override: send all to one address
  const [polling, setPolling] = useState(false);
  const sentAtRef = useRef(0);

  // After a send is accepted, poll ONLY the log (don't touch items/selection)
  // until the job finishes — the user shouldn't have to click "רענון לוג".
  useEffect(() => {
    if (!open || !polling || !audit?._id) return undefined;
    const t = setInterval(async () => {
      if (Date.now() - sentAtRef.current > 30 * 60 * 1000) { setPolling(false); return; }
      try {
        const res = await api.get(`/payroll/payslip-audit/history/${audit._id}/manager-preview`);
        const lg = res.data.distribution || null;
        setLog(lg);
        if (lg?.at && new Date(lg.at).getTime() >= sentAtRef.current && !lg.running) {
          setPolling(false);
          const errs = (lg.results || []).filter(r => r.status === 'error').length;
          if (errs) toast.error(`השליחה הסתיימה עם ${errs} שגיאות — ראה/י לוג`);
          else toast.success('השליחה הושלמה ✓');
        }
      } catch { /* keep polling */ }
    }, 10000);
    return () => clearInterval(t);
  }, [open, polling, audit?._id]);

  const matched = (it) => (it.employees || []).filter(e => e.employee_id && e.has_page);
  const managerEmails = [...new Set(items.flatMap(it => (it.email || '').split(',').map(s => s.trim()).filter(Boolean)))];

  const load = () => {
    if (!audit?._id) return;
    setLoading(true);
    api.get(`/payroll/payslip-audit/history/${audit._id}/manager-preview`)
      .then(res => {
        const its = res.data.items || [];
        setItems(its);
        const s = {};
        its.forEach(it => { s[it.branch] = {}; matched(it).forEach(e => { s[it.branch][e.employee_id] = true; }); });
        setEmpSel(s);
        setLog(res.data.distribution || null);
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, audit?._id]);

  const selCount = (branch) => Object.values(empSel[branch] || {}).filter(Boolean).length;
  const toggleEmp = (branch, id) => setEmpSel(s => ({ ...s, [branch]: { ...s[branch], [id]: !s[branch]?.[id] } }));
  const toggleBranch = (it, v) => setEmpSel(s => { const b = {}; matched(it).forEach(e => { b[e.employee_id] = v; }); return { ...s, [it.branch]: b }; });
  const totalSelected = items.reduce((n, it) => n + selCount(it.branch), 0);

  const previewBranch = (it) => setPreview({ title: it.branch, pdfEndpoint: 'branch-pdf', pdfQuery: { branch: it.branch }, hoursQuery: { scope: 'branch', branch: it.branch } });
  const previewEmp = (it, e) => setPreview({ title: `${e.name} · ${it.branch}`, pdfEndpoint: 'payslip-page', pdfQuery: { branch: e.source_branch || it.branch, page: e.page }, hoursQuery: { scope: 'employee', employee_id: e.employee_id } });

  const send = async (all) => {
    const to = specificEmail.trim();
    const branches = []; const branch_employees = {};
    items.forEach(it => {
      if ((!it.email && !to) || !it.has_pdf) return; // needs a manager email unless a specific address is given
      if (all) { branches.push(it.branch); return; } // whole branch PDF (incl. unmatched)
      const ids = matched(it).filter(e => empSel[it.branch]?.[e.employee_id]).map(e => e.employee_id);
      if (ids.length) { branches.push(it.branch); branch_employees[it.branch] = ids; }
    });
    if (branches.length === 0) { toast.error(all ? 'אין סניפים לשליחה' : 'בחר/י לפחות עובד אחד'); return; }
    const who = to ? `לכתובת ${to}` : `למנהלי ${branches.length} סניפים · ${totalSelected} עובדים`;
    // In-app confirm — window.confirm can be silently suppressed by the browser
    // ("prevent additional dialogs"), making the button appear dead.
    if (!(await confirm({
      title: 'שליחת תלושים למנהלים',
      message: `לשלוח ${who} את התלושים${includeHours ? ' + דוח שעות' : ''}?`,
      confirm_label: 'שלח',
    }))) return;
    setBusy(true);
    try {
      // Generous timeout: a sleeping free-tier instance takes >30s to wake.
      const res = await api.post(`/payroll/payslip-audit/history/${audit._id}/send-managers`,
        { branches, ...(all ? {} : { branch_employees }), include_hours: includeHours, ...(to ? { to } : {}) }, { timeout: 120000 });
      sentAtRef.current = Date.now(); setPolling(true);
      toast.success(`השליחה החלה — ${res.data.count} סניפים. הלוג מתעדכן אוטומטית (הכנת PDF אורכת 1-3 דק').`, { autoClose: 8000 });
    } catch (err) { toast.error(err.response?.data?.error || 'שגיאה בשליחה'); }
    finally { setBusy(false); }
  };

  const logCounts = (log?.results || []).reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

  return (
    <>
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth PaperProps={{ sx: { height: '90vh' } }}>
      <DialogTitle sx={{ fontWeight: 700 }}>שליחת תלושים למנהלי סניפים{audit?.year_month ? ` · ${audit.year_month}` : ''}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" color="text.secondary">
          כל מנהל/ת סניף מקבל/ת את תלושי עובדי הסניף{includeHours ? ' + דוח שעות' : ''}. פתח/י סניף כדי לראות את העובדים, לצפות בכל תלוש+דוח, ולהוסיף/להסיר עובדים מהשליחה.
        </Typography>
        {loading ? <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box> : (
          <Stack spacing={1} sx={{ mt: 1.5 }}>
            {items.map((it, i) => {
              const emps = matched(it);
              const sc = selCount(it.branch);
              const allSel = emps.length > 0 && sc === emps.length;
              const someSel = sc > 0 && !allSel;
              const disabled = !it.email || !it.has_pdf;
              const unmatched = (it.employees || []).filter(e => !e.employee_id).length;
              return (
                <Paper key={i} variant="outlined" sx={{ borderColor: disabled ? 'error.light' : 'divider' }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
                    <Checkbox size="small" disabled={disabled} checked={allSel} indeterminate={someSel} onChange={e => toggleBranch(it, e.target.checked)} />
                    <IconButton size="small" onClick={() => setExpanded(x => ({ ...x, [it.branch]: !x[it.branch] }))}>
                      {expanded[it.branch] ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 700 }}>{it.branch}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>{sc}/{emps.length} עובדים</Typography>
                        {unmatched > 0 && <Chip size="small" color="warning" label={`${unmatched} לא מותאמים`} sx={{ height: 16, fontSize: 10, mr: 0.5 }} />}
                      </Typography>
                      <Typography variant="caption" color={it.email ? 'text.secondary' : 'error.main'} dir="ltr" sx={{ display: 'block' }}>
                        {it.email || 'אין מייל מנהל/ת'}
                      </Typography>
                    </Box>
                    {it.has_pdf
                      ? <Button size="small" variant="text" onClick={() => previewBranch(it)} sx={{ fontSize: 11 }}>תצוגת סניף</Button>
                      : <Chip size="small" color="error" label="אין קובץ" />}
                  </Stack>
                  <Collapse in={!!expanded[it.branch]}>
                    <Table size="small" sx={{ bgcolor: 'grey.50' }}>
                      <TableBody>
                        {emps.length === 0 && <TableRow><TableCell colSpan={4} align="center" sx={{ color: 'text.secondary', py: 1 }}>אין עובדים מותאמים בקובץ.</TableCell></TableRow>}
                        {emps.map((e, j) => (
                          <TableRow key={j}>
                            <TableCell padding="checkbox"><Checkbox size="small" checked={!!empSel[it.branch]?.[e.employee_id]} onChange={() => toggleEmp(it.branch, e.employee_id)} /></TableCell>
                            <TableCell sx={{ fontWeight: 600 }}>{e.name}</TableCell>
                            <TableCell dir="ltr"><Typography variant="caption">{e.israeli_id}</Typography></TableCell>
                            <TableCell align="center"><Button size="small" variant="text" onClick={() => previewEmp(it, e)} sx={{ minWidth: 0, fontSize: 11 }}>תצוגה</Button></TableCell>
                          </TableRow>
                        ))}
                        {(it.employees || []).filter(e => !e.matched || !e.has_page).map((e, j) => (
                          <TableRow key={`u${j}`} sx={{ bgcolor: '#fef2f2' }}>
                            <TableCell padding="checkbox" />
                            <TableCell sx={{ fontWeight: 600 }}>{e.name}</TableCell>
                            <TableCell dir="ltr"><Typography variant="caption">{e.israeli_id}</Typography></TableCell>
                            <TableCell align="center"><Chip size="small" color="warning" variant="outlined" label={e.has_page ? 'לא הותאם' : 'אין עמוד'} sx={{ height: 16, fontSize: 10 }} /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Collapse>
                </Paper>
              );
            })}
            {items.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>אין סניפים.</Typography>}
          </Stack>
        )}
        {log && (
          <Box sx={{ mt: 2, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'grey.50' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>לוג שליחה אחרון</Typography>
              <Typography variant="caption" color="text.secondary">{log.at ? new Date(log.at).toLocaleString('he-IL') : ''}</Typography>
              <Box sx={{ flex: 1 }} />
              {(log.running || polling) && <Chip size="small" color="warning" icon={<CircularProgress size={12} color="inherit" />} label="שליחה בתהליך..." />}
              {Object.entries(logCounts).map(([st, n]) => (
                <Chip key={st} size="small" color={st === 'sent' ? 'success' : st === 'error' ? 'error' : 'default'} label={`${DIST_STATUS_HE[st] || st}: ${n}`} />
              ))}
            </Stack>
            <Box sx={{ maxHeight: 130, overflowY: 'auto' }}>
              {(log.results || []).map((r, i) => (
                <Typography key={i} variant="caption" sx={{ display: 'block', color: r.status === 'sent' ? 'success.dark' : r.status === 'error' ? 'error.main' : 'text.secondary' }}>
                  {r.branch} — {DIST_STATUS_HE[r.status] || r.status}{r.emails ? ` · ${[].concat(r.emails).join(', ')}` : ''}{r.error ? ` — ${r.error}` : ''}
                </Typography>
              ))}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <FormControlLabel sx={{ ml: 0 }}
          control={<Switch size="small" checked={includeHours} onChange={e => setIncludeHours(e.target.checked)} />}
          label={<Typography variant="caption">צרף דוח שעות</Typography>} />
        <Autocomplete freeSolo options={managerEmails} value={specificEmail}
          onInputChange={(_, v) => setSpecificEmail(v)} sx={{ minWidth: 220 }}
          renderInput={(p) => <TextField {...p} size="small" label="מייל ספציפי (אופציונלי)" dir="ltr" />} />
        <Button onClick={load} disabled={busy || loading}>רענון לוג</Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => send(false)} disabled={busy || loading || totalSelected === 0}>שלח לנבחרים ({totalSelected})</Button>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
    <SendContentPreview
      open={!!preview} onClose={() => setPreview(null)} auditId={audit?._id}
      title={preview?.title || ''}
      pdfEndpoint={preview?.pdfEndpoint || 'branch-pdf'}
      pdfQuery={preview?.pdfQuery || {}}
      hoursQuery={preview?.hoursQuery || {}}
    />
    </>
  );
}

/**
 * Payslip Audit page — manager uploads the salary table xlsx (sent to the
 * accountant) and the payslip PDF (received back); the system flags
 * mismatches per employee, color-coded by severity.
 */
export default function PayslipAudit() {
  const confirm = useConfirm();
  // Audit source: 'system' = compare against the in-system salary table (only
  // payslips uploaded); 'file' = legacy compare against an uploaded xlsx.
  const [auditMode, setAuditMode] = useState('system');
  // One PDF holding every branch's payslips (matched to the system by ת"ז).
  const [allBranchesFile, setAllBranchesFile] = useState(false);
  const { month: auditMonth, setMonth: setAuditMonth } = useWorkMonth();
  const [tableFile, setTableFile] = useState(null);
  // Optional Cibus monthly report (xlsx/csv from Pluxee admin dashboard).
  const [cibusFile, setCibusFile] = useState(null);
  // Multi-PDF: list of { file, branch }. Always at least one row in the form.
  const [payslipFiles, setPayslipFiles] = useState([{ file: null, branch: '' }]);
  // Branches detected from the uploaded xlsx — populated when the user picks
  // a table file. Used to hint the per-PDF branch dropdown.
  const [availableBranches, setAvailableBranches] = useState([]);
  const [sheetName, setSheetName] = useState('');
  const [running, setRunning] = useState(false);
  const [audit, setAudit] = useState(null);
  const [filterSev, setFilterSev] = useState('all');
  const [filterBranch, setFilterBranch] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState(null);
  // History of saved audits — fetched on mount and refreshed after each run.
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [emailDialog, setEmailDialog] = useState({ open: false });
  const [emailIntro, setEmailIntro] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailTo, setEmailTo] = useState(['efraim@dy-cpa.co.il']);
  const [emailCc, setEmailCc] = useState(['tofy10.office@gmail.com']);
  const [recipientInput, setRecipientInput] = useState({ to: '', cc: '' });
  // Editable copy of audit.results that the user can prune / extend before send.
  // Each result keeps the original table_row + payslip references so the email
  // builder still has employee context — only `findings` array is meant to be
  // mutated. New manually-added employees use `__manual: true`.
  const [editableResults, setEditableResults] = useState([]);
  // "נבדק" checkmark per payslip (keyed by audit index), persisted on the record.
  const [reviewedMap, setReviewedMap] = useState({});

  // Attach a PDF of just the to-fix payslips to the accountant's email.
  const [attachPayslips, setAttachPayslips] = useState(true);
  // Correction rounds — verify the accountant acted on the notes.
  const [fixDialog, setFixDialog] = useState(false);
  // When a round is opened in the main screen, this holds which one. The screen
  // is then showing the accountant's corrected payslips, NOT the original
  // audit — editing must not write back over the notes that produced it.
  const [roundView, setRoundView] = useState(null); // { audit_id, round_no, summary }

  const openRoundInView = (round) => {
    const originId = roundView ? roundView.audit_id : audit?.saved_audit_id;
    if (!round?.audit_view || !originId) return;
    // Anything not settled as "fixed" blocks a clean sign-off.
    const open = (round.items || []).reduce((s, it) => s + (it.notes || [])
      .filter((n) => (n.manual_verdict || n.auto_verdict) !== 'fixed').length, 0);
    setRoundView({
      audit_id: originId,
      round_no: round.round_no,
      summary: round.summary,
      open,
      approved: !!round.approved,
    });
    setAudit({
      ...round.audit_view,
      saved_audit_id: originId,
      // Point every payslip preview at the round's upload rather than the
      // original one — otherwise the screen shows the pre-correction page.
      __preview_kind: `fix_${round.round_no}`,
    });
    setExpanded(null);
    setFilterSev('all');
    setFilterBranch('all');
    setSearchQuery('');
    setFixDialog(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exitRoundView = async () => {
    const id = roundView?.audit_id;
    setRoundView(null);
    if (id) await loadFromHistory(id, true);
  };

  // Sign the round off. Approving promotes its PDFs to the audit's 'approved'
  // copy, which is what every distribution path reads — so the managers and
  // the employees receive the corrected payslips and not the original file.
  const approveRound = async (force = false) => {
    if (!roundView) return;
    const open = roundView.open || 0;
    if (open > 0 && !force) {
      const go = await confirm({
        title: 'אישור סבב עם הערות פתוחות',
        message: `${open} הערות עדיין לא סומנו כתוקנו. אישור הסבב משחרר את התלושים להפצה למנהלים ולעובדים. להמשיך בכל זאת?`,
        danger: true,
      });
      if (!go) return;
    }
    setRoundView((p) => ({ ...p, busy: true }));
    try {
      const res = await api.post(
        `/payroll/payslip-audit/history/${roundView.audit_id}/fix-rounds/${roundView.round_no}/approve`,
        { force: true },
      );
      toast.success(`סבב ${res.data.round_no} אושר · ${res.data.pdfs_promoted} קבצים סומנו כגרסה הסופית`);
      setRoundView((p) => ({ ...p, busy: false, approved: true }));
      fetchHistory();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה באישור הסבב');
      setRoundView((p) => ({ ...p, busy: false }));
    }
  };

  // Add one correction to an employee already signed off, so the next round
  // picks them up again.
  const [addNoteDlg, setAddNoteDlg] = useState({ open: false, key: '', message: '', severity: 'critical', reload: null });
  const submitAddNote = async () => {
    const originId = roundView ? roundView.audit_id : audit?.saved_audit_id;
    if (!originId || !addNoteDlg.key || !addNoteDlg.message.trim()) return;
    try {
      const res = await api.post(`/payroll/payslip-audit/history/${originId}/notes`, {
        key: addNoteDlg.key, message: addNoteDlg.message.trim(), severity: addNoteDlg.severity,
      });
      toast.success(`נוסף תיקון ל${res.data.employee} · ${res.data.open_notes} הערות פתוחות לסבב הבא`);
      // The fix dialog shows the open-notes count; refresh it so the new
      // correction is reflected without closing and reopening.
      if (typeof addNoteDlg.reload === 'function') addNoteDlg.reload();
      if (!roundView) await loadFromHistory(originId, true);
      setAddNoteDlg({ open: false, key: '', message: '', severity: 'critical', reload: null });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהוספת התיקון');
    }
  };

  // Reach the accountant mail from wherever the problem was noticed. The mail
  // is always composed against the ORIGIN audit, never a round view — a round
  // holds only the re-checked employees, so composing from it would quietly
  // drop everyone else who still needs a fix.
  const sendToAccountant = async () => {
    setFixDialog(false);
    if (roundView) await exitRoundView();
    openEmailDialog();
  };

  // Render the message before it goes out.
  const [mailPreview, setMailPreview] = useState(null); // { html, subject, attachment_name, attachment_pages }
  const [previewBusy, setPreviewBusy] = useState(false);
  // Notes already sent to the accountant this month, keyed by employee, so the
  // reviewer sees the instruction next to the number it was meant to produce.
  const [priorNotes, setPriorNotes] = useState({});
  // The accountant's upload link, offered inside the corrections email so the
  // fixes and the way to return them travel together.
  const [fixLink, setFixLink] = useState('');
  const [includeFixLink, setIncludeFixLink] = useState(true);
  const [fixLinkBusy, setFixLinkBusy] = useState(false);

  // Mint the link on demand — most months it won't exist yet when the email
  // is being written.
  const ensureFixLink = async () => {
    if (fixLink || !audit?.saved_audit_id) return;
    setFixLinkBusy(true);
    try {
      const res = await api.post(`/payroll/payslip-audit/history/${audit.saved_audit_id}/fix-token`, {});
      setFixLink(`${window.location.origin}/payslip-fix/${res.data.token}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה ביצירת קישור ההעלאה');
      setIncludeFixLink(false);
    } finally {
      setFixLinkBusy(false);
    }
  };

  const toggleReviewed = (idx) => {
    if (roundView) return;   // round view is read-only — see openRoundInView
    setReviewedMap((prev) => {
      const next = { ...prev, [idx]: !prev[idx] };
      if (audit?.saved_audit_id) {
        api.patch(`/payroll/payslip-audit/history/${audit.saved_audit_id}/edits`, { reviewed_payslips: next })
          .catch(() => toast.error('שגיאה בשמירת סימון נבדק'));
      }
      return next;
    });
  };

  // The payslips the accountant can skip: the ones left with no live
  // correction. Indices run over the ORIGINAL audit.results, which
  // editableResults is kept parallel to.
  const approvedPayslips = useMemo(() => {
    if (!audit || editableResults.length === 0) return [];
    return audit.results
      .map((r, idx) => ({ r, idx }))
      .filter(({ idx }) => {
        const live = (editableResults[idx]?.findings || [])
          .filter((f) => f.message && f.message.trim() && f.status !== 'rejected' && f.settled !== 'fixed');
        return live.length === 0;
      })
      .map(({ r, idx }) => ({
        name: r.table_row?.employee_name || r.payslip?.employee_name || '—',
        branch: (r.__source_branch || r.table_row?.branch || '').replace(/\s+/g, ' ').trim(),
        employee_no: r.payslip?.employee_no ?? null,
        employee_id: r.payslip?.employee_id || null,
        // Ticked ✓ נבדק — someone actually opened this one, as opposed to it
        // simply never having been flagged. Worth telling the accountant apart.
        reviewed: !!reviewedMap[idx],
      }));
  }, [audit, editableResults, reviewedMap]);

  const stats = useMemo(() => {
    if (!audit) return null;
    let critical = 0, warning = 0, info = 0, ok = 0;
    for (const r of audit.results) for (const f of r.findings) {
      if (f.severity === 'critical') critical++;
      else if (f.severity === 'warning') warning++;
      else if (f.severity === 'info') info++;
      else ok++;
    }
    return {
      critical, warning, info, ok,
      missing: audit.missing_payslips.length,
      orphans: audit.orphan_payslips.length,
    };
  }, [audit]);

  // List of branches present in this audit — for the branch-filter chips.
  const branchOptions = useMemo(() => {
    if (!audit) return [];
    const set = new Set();
    for (const r of audit.results) {
      const b = r.__source_branch || r.table_row?.branch;
      if (b) set.add(b);
    }
    return [...set];
  }, [audit]);

  // Per-branch review progress: how many employees-with-findings have been
  // fully reviewed (every finding approved/rejected)? Drives the progress
  // bars in the summary card and the row backgrounds in the per-branch table.
  const branchProgress = useMemo(() => {
    if (!audit || editableResults.length === 0) return {};
    const map = {}; // branch → { withFindings, reviewed, totalFindings, reviewedFindings }
    for (let i = 0; i < audit.results.length; i++) {
      const r = audit.results[i];
      const editable = editableResults[i];
      if (!editable) continue;
      const branch = r.__source_branch || r.table_row?.branch || '—';
      const key = branch;
      if (!map[key]) map[key] = { withFindings: 0, reviewed: 0, totalFindings: 0, reviewedFindings: 0 };
      if (editable.findings.length === 0) continue;
      map[key].withFindings++;
      map[key].totalFindings += editable.findings.length;
      const allDone = editable.findings.every((f) => f.status === 'approved' || f.status === 'rejected');
      const doneFindings = editable.findings.filter((f) => f.status === 'approved' || f.status === 'rejected').length;
      if (allDone) map[key].reviewed++;
      map[key].reviewedFindings += doneFindings;
    }
    return map;
  }, [audit, editableResults]);

  const filteredResults = useMemo(() => {
    if (!audit) return [];
    const q = searchQuery.trim().toLowerCase();
    return audit.results.filter((r) => {
      // Severity filter
      if (filterSev !== 'all' && !r.findings.some((f) => f.severity === filterSev)) return false;
      // Branch filter
      if (filterBranch !== 'all') {
        const b = r.__source_branch || r.table_row?.branch || '';
        if (!b.includes(filterBranch)) return false;
      }
      // Name search (matches table_row.employee_name OR payslip.employee_name)
      if (q) {
        const a = (r.table_row?.employee_name || '').toLowerCase();
        const b = (r.payslip?.employee_name || '').toLowerCase();
        const id = (r.payslip?.employee_id || '').toLowerCase();
        if (!a.includes(q) && !b.includes(q) && !id.includes(q)) return false;
      }
      return true;
    });
  }, [audit, filterSev, filterBranch, searchQuery]);

  const openEmailDialog = async () => {
    if (!audit) return;
    const ym = audit.year_month || '';
    const branch = audit.branch_filter || 'כל הסניפים';
    setEmailIntro(
      `שלום אפרים,\n\n` +
      `מצורפים תיקונים נדרשים בתלושי השכר לחודש ${ym} (${branch}).\n` +
      `נא לבצע את התיקונים ולשלוח לאישור.\n\n` +
      `תודה,\nמשרד גן החלומות`
    );
    // Pull canonical defaults from server in case the office address ever changes.
    try {
      const res = await api.get('/payroll/payslip-audit/email/defaults');
      if (Array.isArray(res.data?.to))  setEmailTo(res.data.to);
      if (Array.isArray(res.data?.cc))  setEmailCc(res.data.cc);
    } catch {
      // ignore — fall back to the local defaults
    }
    // Reuse an upload link if this audit already has one, so re-sending the
    // corrections doesn't invalidate the link the accountant already has.
    if (audit.saved_audit_id) {
      try {
        const res = await api.get(`/payroll/payslip-audit/history/${audit.saved_audit_id}/fix-rounds`);
        setFixLink(res.data?.fix_token ? `${window.location.origin}/payslip-fix/${res.data.fix_token}` : '');
      } catch {
        setFixLink('');
      }
    }
    setRecipientInput({ to: '', cc: '' });
    // editableResults already maintained by useEffect when audit changes —
    // we just open the dialog. The user has been editing on the main page.
    setEmailDialog({ open: true });
  };

  // Recipient editing helpers — chip-based, validate on add.
  const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());

  const addRecipient = (kind) => {
    const raw = recipientInput[kind].trim();
    if (!raw) return;
    // Allow comma-separated bulk paste
    const parts = raw.split(/[,;\s]+/).filter(Boolean);
    const valid = parts.filter(isValidEmail);
    const invalid = parts.filter((p) => !isValidEmail(p));
    if (invalid.length) {
      toast.warn(`כתובת לא תקינה: ${invalid.join(', ')}`);
    }
    if (valid.length) {
      const setter = kind === 'to' ? setEmailTo : setEmailCc;
      setter((prev) => Array.from(new Set([...prev, ...valid])));
    }
    setRecipientInput((prev) => ({ ...prev, [kind]: '' }));
  };

  const removeRecipient = (kind, addr) => {
    const setter = kind === 'to' ? setEmailTo : setEmailCc;
    setter((prev) => prev.filter((a) => a !== addr));
  };

  // ── Findings editor helpers — operate on `editableResults` ──
  const updateFinding = (rIdx, fIdx, patch) => {
    setEditableResults((prev) => {
      const next = [...prev];
      const r = { ...next[rIdx], findings: [...next[rIdx].findings] };
      r.findings[fIdx] = { ...r.findings[fIdx], ...patch };
      next[rIdx] = r;
      return next;
    });
  };
  const removeFinding = (rIdx, fIdx) => {
    setEditableResults((prev) => {
      const next = [...prev];
      const r = { ...next[rIdx], findings: next[rIdx].findings.filter((_, i) => i !== fIdx) };
      next[rIdx] = r;
      return next;
      // Note: we do NOT drop empty employee blocks anymore — the user wants to
      // see all employees so they can add new corrections. Empty blocks are
      // skipped at send time, not removed from the editor.
    });
  };
  const addFinding = (rIdx) => {
    setEditableResults((prev) => {
      const next = [...prev];
      const r = {
        ...next[rIdx],
        findings: [
          ...next[rIdx].findings,
          { severity: 'critical', message: '', expected: null, actual: null, field: 'manual', status: 'approved', note: '' },
        ],
      };
      next[rIdx] = r;
      return next;
    });
  };
  const removeEmployee = (rIdx) => {
    setEditableResults((prev) => prev.filter((_, i) => i !== rIdx));
  };
  const addManualEmployee = (name) => {
    if (!name?.trim()) return;
    setEditableResults((prev) => [
      ...prev,
      {
        matched: false,
        match_method: 'manual',
        table_row: { employee_name: name.trim(), branch: audit?.branch_filter || '' },
        payslip: null,
        findings: [{ severity: 'critical', message: '', expected: null, actual: null, field: 'manual', status: 'approved', note: '' }],
        __manual: true,
      },
    ]);
  };

  // The exact body the send would post — built once so the preview cannot
  // drift from the message that actually goes out.
  const buildEmailPayload = () => {
    const cleaned = editableResults
      .map((r, idx) => ({
        ...r,
        __audit_idx: idx,
        findings: r.findings.filter((f) => f.message && f.message.trim() && f.status !== 'rejected' && f.settled !== 'fixed'),
      }))
      .filter((r) => r.findings.length > 0);
    return {
      audit: { ...audit, results: cleaned },
      intro_text: emailIntro,
      to: emailTo,
      cc: emailCc,
      approved_payslips: approvedPayslips,
      attach_payslips: attachPayslips,
      ...(includeFixLink && fixLink ? { fix_url: fixLink } : {}),
    };
  };

  const previewEmail = async () => {
    if (!audit) return;
    setPreviewBusy(true);
    try {
      const res = await api.post('/payroll/payslip-audit/email/preview', buildEmailPayload());
      setMailPreview(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בבניית התצוגה המקדימה');
    } finally {
      setPreviewBusy(false);
    }
  };

  const sendEmail = async () => {
    if (!audit) return;
    if (emailTo.length === 0) {
      toast.warn('יש להוסיף לפחות נמען אחד בשדה "אל"');
      return;
    }
    // What decides is the corrections. A payslip with a live correction goes to
    // the accountant; one without goes in the "approved, don't touch" list, so
    // his absence from the fix list means "checked and fine" rather than "we
    // forgot him". The ✓ נבדק tick is a progress marker and excludes nothing —
    // treating it as approval silently emptied the whole correction list once
    // a review pass was finished.
    const cleaned = editableResults
      .map((r, idx) => ({
        ...r,
        __audit_idx: idx,
        // Settled-as-fixed notes are done — asking for them again is how the
        // accountant got a list of the seven things he had just corrected.
        findings: r.findings.filter((f) =>
          f.message && f.message.trim() && f.status !== 'rejected' && f.settled !== 'fixed'
        ),
      }))
      .filter((r) => r.findings.length > 0);
    if (cleaned.length === 0) {
      toast.warn('אין תיקונים לשליחה — הוסף לפחות תיקון אחד עם תוכן');
      return;
    }
    // Build the payload from a shallow-cloned audit so server-side stats stay intact
    const editedAudit = { ...audit, results: cleaned };
    setEmailSending(true);
    try {
      const res = await api.post('/payroll/payslip-audit/email', {
        audit: editedAudit,
        intro_text: emailIntro,
        to: emailTo,
        cc: emailCc,
        approved_payslips: approvedPayslips,
        attach_payslips: attachPayslips,
        ...(includeFixLink && fixLink ? { fix_url: fixLink } : {}),
      });
      const extra = [
        res.data.attached ? `מצורף: ${res.data.attached}` : null,
        res.data.approved_count ? `${res.data.approved_count} אושרו` : null,
      ].filter(Boolean).join(' · ');
      toast.success(`המייל נשלח (${res.data.provider}) ל-${res.data.sent_to.join(', ')}${res.data.cc.length ? ', עותק: ' + res.data.cc.join(', ') : ''}${extra ? ` — ${extra}` : ''}`);
      setEmailDialog({ open: false });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשליחת המייל');
    } finally {
      setEmailSending(false);
    }
  };

  // ── Audit history ──
  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/payroll/payslip-audit/history?limit=20');
      setHistory(res.data?.items || []);
    } catch {
      // silent — history is non-essential
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => { fetchHistory(); }, []);

  useEffect(() => {
    if (!audit?.year_month) { setPriorNotes({}); return; }
    const q = new URLSearchParams({ year_month: audit.year_month });
    if (audit.saved_audit_id) q.set('exclude_audit_id', String(audit.saved_audit_id));
    api.get(`/payroll/payslip-audit/prior-notes?${q}`)
      .then((r) => setPriorNotes(r.data?.items || {}))
      .catch(() => setPriorNotes({}));   // non-essential — never block the review
  }, [audit?.year_month, audit?.saved_audit_id]);

  // Persist the last viewed audit id so leaving the tab and returning restores
  // the audit (results + payslip previews) instead of an empty form.
  useEffect(() => {
    if (audit?.saved_audit_id) sessionStorage.setItem('lastAuditId', String(audit.saved_audit_id));
  }, [audit?.saved_audit_id]);

  // On mount, if no audit is loaded, silently restore the last viewed one.
  useEffect(() => {
    const last = sessionStorage.getItem('lastAuditId');
    if (last) loadFromHistory(last, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the audit changes (run, or load from history), seed the editor
  // with critical+warning findings. The list is kept PARALLEL to audit.results
  // (same order, same length) so each ResultCard on the right can be paired
  // with its EmployeeBlock on the left by index.
  //
  // Each finding gets a `status` field for the verification workflow:
  //   'pending'  — not yet reviewed (default for system-detected findings)
  //   'approved' — user confirmed; will be sent in the email
  //   'rejected' — user marked as false positive; excluded from email
  // If the audit has saved verification decisions (`editor_verifications`)
  // from a prior session, we restore them by matching field+message.
  useEffect(() => {
    if (!audit) {
      setEditableResults([]);
      setReviewedMap({});
      return;
    }
    setReviewedMap(audit.reviewed_payslips || {});
    const savedEdits = audit.editor_verifications || {}; // { auditIdx: [{field, message, status, note}] }
    // Verdicts the correction rounds reached, keyed `employeeKey::message`.
    const settled = audit.settled_notes || {};
    const cloned = audit.results.map((r, idx) => {
      const empKey = resultKey(r);
      const savedFindings = savedEdits[idx] || [];
      const findingsList = r.findings
        .filter((f) => f.severity === 'critical' || f.severity === 'warning')
        .map((f) => {
          // Restore prior decision if we have a saved entry with matching field+message
          const prior = savedFindings.find((s) => s.field === f.field && s.message === f.message);
          return {
            ...f,
            status: prior?.status || 'pending',
            note: prior?.note || '',
          };
        });
      // Also pull in any manually-added findings from saved edits that aren't in audit.results
      const manualSaved = savedFindings.filter((s) => s.field === 'manual' || (!findingsList.find((f) => f.field === s.field && f.message === s.message)));
      for (const ms of manualSaved) {
        if (!findingsList.find((f) => f.message === ms.message)) {
          findingsList.push({ ...ms, status: ms.status || 'approved' });
        }
      }
      // Stamp what the correction rounds concluded. A note settled as fixed is
      // finished: it stays visible with its verdict, but stops being something
      // we ask the accountant for again.
      for (const f of findingsList) {
        const s = settled[`${empKey}::${f.message}`];
        if (s) { f.settled = s.verdict; f.settled_round = s.round_no; }
      }
      return { ...r, findings: findingsList };
    });
    setEditableResults(cloned);
  }, [audit]);

  const loadFromHistory = async (id, silent = false) => {
    try {
      const res = await api.get(`/payroll/payslip-audit/history/${id}`);
      setAudit(res.data);
      setExpanded(null);
      setFilterSev('all');
      setFilterBranch('all');
      setSearchQuery('');
      if (!silent) {
        toast.info('נטענה ביקורת שמורה');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      if (!silent) toast.error(err.response?.data?.error || 'שגיאה בטעינת ביקורת');
      sessionStorage.removeItem('lastAuditId');
    }
  };

  // Save the user's per-finding decisions back to the audit record so they
  // persist across page reloads. Triggered manually via the "שמור" button +
  // automatically on a 1.5s debounce after every edit.
  const saveEdits = async (silent = false) => {
    if (!audit?.saved_audit_id) {
      if (!silent) toast.warn('יש להריץ קודם בדיקה');
      return;
    }
    // A round view borrows the origin audit's id for previews. Saving here
    // would overwrite the very notes the round was graded against.
    if (roundView) {
      if (!silent) toast.info('תצוגת סבב — לצפייה בלבד. חזור לביקורת המקורית כדי לערוך תיקונים.');
      return;
    }
    // Build a compact verifications map: { auditIdx: [{field, message, status, note, severity}] }
    const verifications = {};
    editableResults.forEach((r, idx) => {
      const entries = r.findings
        .filter((f) => f.status || f.note || f.field === 'manual')
        .map((f) => ({
          field: f.field,
          message: f.message,
          severity: f.severity,
          status: f.status,
          note: f.note,
        }));
      if (entries.length > 0) verifications[idx] = entries;
    });
    try {
      await api.patch(`/payroll/payslip-audit/history/${audit.saved_audit_id}/edits`, {
        editor_verifications: verifications,
      });
      if (!silent) toast.success('עריכות נשמרו');
    } catch (err) {
      if (!silent) toast.error(err.response?.data?.error || 'שגיאה בשמירת עריכות');
    }
  };

  // Auto-save edits 1.5s after the last change, but only if we have a saved audit id.
  useEffect(() => {
    if (!audit?.saved_audit_id || editableResults.length === 0) return;
    const t = setTimeout(() => { saveEdits(true); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableResults]);

  const deleteFromHistory = async (id) => {
    if (!(await confirm({ title: 'מחיקת ביקורת', message: 'למחוק את הביקורת מההיסטוריה? פעולה זו אינה הפיכה.', danger: true, remember_key: 'delete-audit-history' }))) return;
    try {
      await api.delete(`/payroll/payslip-audit/history/${id}`);
      setHistory((prev) => prev.filter((h) => h._id !== id));
      toast.success('הביקורת נמחקה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה במחיקה');
    }
  };

  // Correct the month an audit belongs to (e.g. June payslips uploaded in July).
  const changeAuditMonth = async (h) => {
    const cur = h.year_month || '';
    const input = window.prompt('חודש הביקורת (YYYY-MM) — לדוגמה 2026-06:', cur);
    if (!input) return;
    const ym = input.trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) { toast.error('פורמט לא תקין. השתמש/י ב-YYYY-MM'); return; }
    if (ym === cur) return;
    try {
      await api.patch(`/payroll/payslip-audit/history/${h._id}/month`, { year_month: ym });
      setHistory((prev) => prev.map((x) => (x._id === h._id ? { ...x, year_month: ym } : x)));
      toast.success(`חודש הביקורת עודכן ל-${ym}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בעדכון החודש');
    }
  };

  // Phase 3: approve/unapprove a saved audit. Approving prompts for optional
  // corrected payslip PDFs (one per branch) and stamps the record with the
  // approving manager + timestamp. Future audits can reference this state.
  const [approveDialog, setApproveDialog] = useState({ open: false, audit: null });
  const [approveFiles, setApproveFiles] = useState([]);
  const [approveNote, setApproveNote] = useState('');
  const [approveSending, setApproveSending] = useState(false);
  const [mgrEmailsOpen, setMgrEmailsOpen] = useState(false);
  const [distDialog, setDistDialog] = useState({ open: false, audit: null });
  const [mgrDialog, setMgrDialog] = useState({ open: false, audit: null });

  // Round-progression dialog: shows a per-employee × per-round matrix of
  // critical/warning counts so the user can see fix-cycle progress at a glance.
  const [progressionDialog, setProgressionDialog] = useState({ open: false, year_month: '', loading: false, data: null, error: null });
  const openProgressionDialog = async (ym) => {
    setProgressionDialog({ open: true, year_month: ym, loading: true, data: null, error: null });
    try {
      const res = await api.get(`/payroll/payslip-audit/cycle-progression?year_month=${encodeURIComponent(ym)}`);
      setProgressionDialog({ open: true, year_month: ym, loading: false, data: res.data, error: null });
    } catch (err) {
      setProgressionDialog({ open: true, year_month: ym, loading: false, data: null, error: err.response?.data?.error || err.message });
    }
  };

  const openApproveDialog = (h) => {
    setApproveDialog({ open: true, audit: h });
    // Pre-populate one row per branch in the audit
    setApproveFiles((h.branches || []).map((b) => ({ branch: b, file: null })));
    setApproveNote('');
  };

  const submitApprove = async () => {
    if (!approveDialog.audit) return;
    setApproveSending(true);
    try {
      const form = new FormData();
      if (approveNote) form.append('approved_note', approveNote);
      approveFiles.forEach((row, i) => {
        if (row.file && row.branch) {
          form.append(`approved_payslip_${i}`, row.file);
          form.append(`approved_branch_${i}`, row.branch);
        }
      });
      const res = await api.patch(
        `/payroll/payslip-audit/history/${approveDialog.audit._id}/approve`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      toast.success('הביקורת סומנה כסבב סופי');
      setApproveDialog({ open: false, audit: null });
      fetchHistory();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה באישור');
    } finally {
      setApproveSending(false);
    }
  };

  const unapproveAudit = async (id) => {
    if (!(await confirm({ title: 'ביטול אישור', message: 'לבטל את האישור? הביקורת תוחזר ל-״לא סופי״.', danger: true, remember_key: 'unapprove-audit' }))) return;
    try {
      await api.patch(`/payroll/payslip-audit/history/${id}/unapprove`);
      toast.success('האישור בוטל');
      fetchHistory();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  // Group history records by year_month so the user sees one section per
  // month, sorted newest first. Within each month, audits are still in
  // chronological order (newest first) — so the most recent run for that
  // month is at the top.
  const historyByMonth = useMemo(() => {
    const map = new Map();
    for (const h of history) {
      const key = h.year_month || 'ללא חודש';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(h);
    }
    // Sort keys: real year_month strings sort lexically desc; "ללא חודש" goes last
    return [...map.entries()].sort((a, b) => {
      if (a[0] === 'ללא חודש') return 1;
      if (b[0] === 'ללא חודש') return -1;
      return b[0].localeCompare(a[0]);
    });
  }, [history]);
  // Track which month sections are expanded — the most recent month is open
  // by default; older months collapsed (clean view).
  const [expandedMonths, setExpandedMonths] = useState({});
  useEffect(() => {
    if (historyByMonth.length > 0 && Object.keys(expandedMonths).length === 0) {
      // Default: only the latest month is open
      setExpandedMonths({ [historyByMonth[0][0]]: true });
    }
  }, [historyByMonth, expandedMonths]);

  // Probe the xlsx for its branch list as soon as the user selects it. Fail
  // silently — the dropdown will just stay empty (user can type manually).
  const probeBranches = async (file) => {
    if (!file) {
      setAvailableBranches([]);
      return;
    }
    try {
      const form = new FormData();
      form.append('file', file);
      if (sheetName) form.append('sheet_name', sheetName);
      const res = await api.post('/payroll/payslip-audit/list-branches', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const branches = Array.isArray(res.data?.branches) ? res.data.branches : [];
      setAvailableBranches(branches);
      // Auto-fill empty branch slots round-robin so the user sees sensible defaults.
      setPayslipFiles((prev) =>
        prev.map((row, idx) => row.branch ? row : { ...row, branch: branches[idx] || '' })
      );
    } catch {
      setAvailableBranches([]);
    }
  };

  const handleTableFileChange = (file) => {
    setTableFile(file);
    probeBranches(file);
  };

  const updatePayslipRow = (idx, patch) => {
    setPayslipFiles((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };
  const addPayslipRow = () => {
    setPayslipFiles((prev) => [
      ...prev,
      { file: null, branch: availableBranches[prev.length] || '' },
    ]);
  };
  const removePayslipRow = (idx) => {
    setPayslipFiles((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  // In system mode, populate the branch datalist from the system branch list.
  useEffect(() => {
    if (auditMode !== 'system') return;
    api.get('/branches')
      .then((res) => setAvailableBranches((res.data?.branches || []).map((b) => b.name).filter(Boolean)))
      .catch(() => {});
  }, [auditMode]);

  const runAudit = async () => {
    if (auditMode === 'file' && !tableFile) {
      toast.warn('נא לבחור את טבלת השכר');
      return;
    }
    if (auditMode === 'system' && !auditMonth) {
      toast.warn('נא לבחור חודש');
      return;
    }
    // All-branches mode (system only): one PDF, no per-file branch.
    const allMode = auditMode === 'system' && allBranchesFile;
    const validRows = allMode
      ? payslipFiles.filter((r) => r.file)
      : payslipFiles.filter((r) => r.file && r.branch.trim());
    if (validRows.length === 0) {
      toast.warn(allMode ? 'נא לבחור קובץ תלושים' : 'נא לבחור לפחות קובץ תלושים אחד עם סניף');
      return;
    }
    if (!allMode) {
      const missingBranch = payslipFiles.find((r) => r.file && !r.branch.trim());
      if (missingBranch) {
        toast.warn(`חסר סניף לקובץ "${missingBranch.file.name}"`);
        return;
      }
    }
    setRunning(true);
    try {
      const form = new FormData();
      if (auditMode === 'system') {
        form.append('month', auditMonth);
        if (allMode) form.append('all_branches', 'true');
      } else {
        form.append('table_file', tableFile);
        if (sheetName) form.append('sheet_name', sheetName);
      }
      validRows.forEach((row, i) => {
        form.append(`payslip_file_${i}`, row.file);
        if (!allMode) form.append(`branch_${i}`, row.branch);
      });
      // Optional Cibus monthly report (xlsx/csv) — comparator does a triple
      // cross-check (table ↔ payslip ↔ cibus) when present.
      if (cibusFile) {
        form.append('cibus_file', cibusFile);
      }
      const endpoint = auditMode === 'system'
        ? '/payroll/payslip-audit/run-system'
        : '/payroll/payslip-audit/run-multi';
      const res = await api.post(endpoint, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setAudit(res.data);
      setExpanded(null);
      const branches = res.data.per_branch?.length || validRows.length;
      toast.success(`הושוו ${res.data.payslips_in_pdf} תלושים מול ${res.data.rows_in_table} שורות (${branches} סניפים)`);
      // Refresh history with the just-saved run at the top
      fetchHistory();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'שגיאה בהשוואה');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }} dir="rtl">
      <Stack spacing={2}>
        {/* Header */}
        <Card>
          <CardContent>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>🧾 בדיקת תלושי שכר</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              העלה את טבלת השכר שנשלחה לרו"ח (xlsx) ואת קובץ התלושים שהתקבל (PDF) — המערכת תאתר אי-התאמות.
            </Typography>
          </CardContent>
        </Card>

        {/* Upload form */}
        <Card>
          <CardContent>
            <Stack spacing={2}>
              {/* Audit source toggle */}
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="caption" sx={{ fontWeight: 700 }}>מקור הבדיקה:</Typography>
                <Button size="small" variant={auditMode === 'system' ? 'contained' : 'outlined'}
                  onClick={() => setAuditMode('system')}>מול טבלת המערכת</Button>
                <Button size="small" variant={auditMode === 'file' ? 'contained' : 'outlined'}
                  onClick={() => setAuditMode('file')}>מול קובץ xlsx</Button>
                <Typography variant="caption" color="text.secondary">
                  {auditMode === 'system'
                    ? 'מעלים רק תלושים — ההשוואה מול הנתונים שבמערכת'
                    : 'משווים מול קובץ אקסל חיצוני'}
                </Typography>
              </Stack>
              {auditMode === 'system' && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" sx={{ fontWeight: 700 }}>מבנה הקובץ:</Typography>
                  <Button size="small" variant={!allBranchesFile ? 'contained' : 'outlined'}
                    onClick={() => setAllBranchesFile(false)}>קובץ לכל סניף</Button>
                  <Button size="small" variant={allBranchesFile ? 'contained' : 'outlined'}
                    onClick={() => setAllBranchesFile(true)}>📄 קובץ אחד לכל הסניפים</Button>
                  <Typography variant="caption" color="text.secondary">
                    {allBranchesFile
                      ? 'PDF אחד עם כל התלושים — ההתאמה לפי ת"ז'
                      : 'קובץ נפרד לכל סניף'}
                  </Typography>
                </Stack>
              )}
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '2fr 1fr 2fr' }, gap: 2, alignItems: 'end' }}>
                {auditMode === 'system' ? (
                  <TextField
                    label="חודש לבדיקה"
                    type="month"
                    size="small"
                    value={auditMonth}
                    onChange={(e) => setAuditMonth(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                ) : (
                  <FileInput
                    label="טבלת שכר מרוכזת (.xlsx) — חובה"
                    file={tableFile}
                    onChange={handleTableFileChange}
                    accept=".xlsx,.xls"
                  />
                )}
                {auditMode === 'file' ? (
                  <TextField
                    label="שם גליון (אופציונלי)"
                    size="small"
                    placeholder="למשל: אפריל 26"
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                  />
                ) : <Box />}
                <FileInput
                  label="דוח סיבוס/Pluxee (אופציונלי, .xlsx/.csv)"
                  file={cibusFile}
                  onChange={setCibusFile}
                  accept=".xlsx,.xls,.csv"
                />
              </Box>

              {/* Per-branch payslip files */}
              <Box>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, flex: 1 }}>
                    {allBranchesFile && auditMode === 'system'
                      ? 'קובץ תלושים אחד (כל הסניפים)'
                      : 'קבצי תלושים (PDF) — אחד לכל סניף'}
                  </Typography>
                  {!(allBranchesFile && auditMode === 'system') && (
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      onClick={addPayslipRow}
                      disabled={payslipFiles.length >= 10}
                    >
                      הוסף קובץ
                    </Button>
                  )}
                </Stack>
                <Stack spacing={1}>
                  {(allBranchesFile && auditMode === 'system' ? payslipFiles.slice(0, 1) : payslipFiles).map((row, idx) => (
                    <PayslipFileRow
                      key={idx}
                      row={row}
                      idx={idx}
                      branches={availableBranches}
                      hideBranch={allBranchesFile && auditMode === 'system'}
                      canRemove={payslipFiles.length > 1 && !(allBranchesFile && auditMode === 'system')}
                      onChange={(patch) => updatePayslipRow(idx, patch)}
                      onRemove={() => removePayslipRow(idx)}
                    />
                  ))}
                </Stack>
                {availableBranches.length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    סניפים שזוהו בטבלה: {availableBranches.join(' · ')}
                  </Typography>
                )}
              </Box>

              <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 2 }}>
                {(() => {
                  const miss = [];
                  if (auditMode === 'system') { if (!auditMonth) miss.push('חודש'); }
                  else if (!tableFile) miss.push('טבלת שכר מרוכזת (xlsx)');
                  if (!payslipFiles.some((r) => r.file)) miss.push('קובץ תלושים (PDF)');
                  if (!miss.length || running) return null;
                  return (
                    <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
                      ⚠️ כדי להריץ בדיקה חסר: {miss.join(' + ')}
                    </Typography>
                  );
                })()}
                <Button
                  variant="contained"
                  size="large"
                  startIcon={running ? <CircularProgress size={18} color="inherit" /> : <PlayArrowIcon />}
                  onClick={runAudit}
                  disabled={running
                    || (auditMode === 'system' ? !auditMonth : !tableFile)
                    || !payslipFiles.some((r) => r.file)}
                >
                  {running ? 'משווה…' : 'הרץ בדיקה'}
                </Button>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        {/* Recent saved audits — quick access without re-uploading files */}
        {history.length > 0 && (
          <Card>
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  ביקורות שמורות
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ({history.length})
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button size="small" startIcon={<EmailIcon />} onClick={() => setMgrEmailsOpen(true)}>מיילי מנהלים</Button>
                <Button size="small" onClick={fetchHistory} disabled={historyLoading}>
                  רענן
                </Button>
              </Stack>
              {/* Per-month grouped rendering — one expandable section per month.
                  Each month shows an aggregate "מאושר" badge if any audit in
                  that month was marked as a closed cycle. */}
              <Stack spacing={1}>
                {historyByMonth.map(([ym, items]) => {
                  const isOpen = !!expandedMonths[ym];
                  const hasApproved = items.some((h) => h.approved);
                  const totalCritical = items.reduce((s, h) => s + (h.summary?.critical_count || 0), 0);
                  const totalWarning = items.reduce((s, h) => s + (h.summary?.warning_count || 0), 0);
                  // All branches across the month's audits, deduped
                  const branchSet = new Set();
                  items.forEach((h) => (h.branches || []).forEach((b) => branchSet.add(b)));
                  return (
                    <Paper
                      key={ym}
                      variant="outlined"
                      sx={{
                        borderColor: hasApproved ? 'success.main' : 'divider',
                        borderRight: hasApproved ? 4 : 1,
                        bgcolor: hasApproved ? 'success.50' : 'background.paper',
                      }}
                    >
                      <Box
                        onClick={() => setExpandedMonths((p) => ({ ...p, [ym]: !p[ym] }))}
                        sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                      >
                        <IconButton size="small" sx={{ p: 0.25 }}>
                          {isOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                        </IconButton>
                        <Typography variant="subtitle1" sx={{ fontWeight: 800, ml: 1, mr: 0.5 }}>
                          {ym}
                        </Typography>
                        <Chip size="small" label={`${items.length} ביקורות`} sx={{ height: 20, fontSize: 10, ml: 1 }} />
                        {hasApproved && (
                          <Chip
                            size="small"
                            color="success"
                            icon={<CheckCircleIcon />}
                            label="סבב סופי"
                            sx={{ height: 20, fontSize: 10, fontWeight: 700, ml: 1 }}
                          />
                        )}
                        <Box sx={{ flex: 1 }} />
                        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                          {[...branchSet].map((b) => (
                            <Chip
                              key={b}
                              label={b.replace(/\s+/g, ' ').trim()}
                              size="small"
                              variant="outlined"
                              sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
                            />
                          ))}
                          {totalCritical > 0 && <Chip size="small" color="error"   label={`${totalCritical} קריטי`} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />}
                          {totalWarning > 0 && <Chip size="small" color="warning" label={`${totalWarning} אזהרה`} sx={{ height: 18, fontSize: 10 }} />}
                          {items.length >= 2 && (
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={(e) => { e.stopPropagation(); openProgressionDialog(ym); }}
                              sx={{ fontSize: 10, py: 0, minHeight: 22 }}
                            >
                              📊 השוואת סבבים
                            </Button>
                          )}
                        </Stack>
                      </Box>
                      <Collapse in={isOpen}>
                        <Divider />
                        <Table size="small" sx={{
                          '& td, & th': { fontSize: 12, py: 0.5, borderColor: 'rgba(0,0,0,0.06)' },
                        }}>
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ fontWeight: 700 }}>תאריך + שעה</TableCell>
                              <TableCell sx={{ fontWeight: 700 }}>סניפים</TableCell>
                              <TableCell align="center" sx={{ fontWeight: 700 }}>שורות / תלושים</TableCell>
                              <TableCell align="center" sx={{ fontWeight: 700, color: 'error.main' }}>קריטי</TableCell>
                              <TableCell align="center" sx={{ fontWeight: 700, color: 'warning.main' }}>אזהרה</TableCell>
                              <TableCell align="center" sx={{ fontWeight: 700 }}>מצב</TableCell>
                              <TableCell align="center" sx={{ fontWeight: 700 }}>פעולות</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {items.map((h) => (
                              <TableRow
                                key={h._id}
                                hover
                                sx={{ cursor: 'pointer', bgcolor: audit?.saved_audit_id === h._id ? 'primary.50' : 'inherit' }}
                                onClick={() => loadFromHistory(h._id)}
                              >
                                <TableCell>
                                  {new Date(h.created_at).toLocaleString('he-IL', {
                                    day: '2-digit', month: '2-digit', year: '2-digit',
                                    hour: '2-digit', minute: '2-digit',
                                  })}
                                  {h.created_by_name && (
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10 }}>
                                      ע״י {h.created_by_name}
                                    </Typography>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                                    {(h.branches || []).map((b) => (
                                      <Chip key={b} label={b} size="small" variant="outlined"
                                        sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }} />
                                    ))}
                                  </Stack>
                                </TableCell>
                                <TableCell align="center">
                                  {h.summary?.rows_in_table} / {h.summary?.payslips_in_pdf}
                                </TableCell>
                                <TableCell align="center" sx={{ fontWeight: h.summary?.critical_count > 0 ? 700 : 400, color: h.summary?.critical_count > 0 ? 'error.main' : 'text.secondary' }}>
                                  {h.summary?.critical_count || 0}
                                </TableCell>
                                <TableCell align="center" sx={{ fontWeight: h.summary?.warning_count > 0 ? 700 : 400, color: h.summary?.warning_count > 0 ? 'warning.main' : 'text.secondary' }}>
                                  {h.summary?.warning_count || 0}
                                </TableCell>
                                <TableCell align="center">
                                  {h.approved ? (
                                    <Chip size="small" color="success" icon={<CheckCircleIcon />} label="סבב סופי" sx={{ fontWeight: 700 }} />
                                  ) : (
                                    <Chip size="small" variant="outlined" label="פתוח" />
                                  )}
                                </TableCell>
                                <TableCell align="center">
                                  <Stack direction="row" spacing={0.5} justifyContent="center">
                                    {h.approved ? (
                                      <>
                                        <Chip size="small" color="success" variant="outlined" label="להפצה: לשונית 'הפצת תלושים ודוחות'" sx={{ height: 20, fontSize: 9.5 }} />
                                        <Button size="small" variant="outlined" onClick={(e) => { e.stopPropagation(); unapproveAudit(h._id); }} sx={{ fontSize: 10, py: 0, minWidth: 0 }}>בטל אישור</Button>
                                      </>
                                    ) : (
                                      <Button size="small" variant="contained" color="success" onClick={(e) => { e.stopPropagation(); openApproveDialog(h); }} sx={{ fontSize: 10, py: 0, minWidth: 0 }}>אשר סבב</Button>
                                    )}
                                    <Chip size="small" variant="outlined" color="primary"
                                      label={`חודש נבדק: ${h.year_month || 'לא הוגדר'}`}
                                      onClick={(e) => { e.stopPropagation(); changeAuditMonth(h); }}
                                      sx={{ height: 20, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                                      title="לחץ/י לשינוי החודש הנבדק (למשל תלושי יוני שהועלו ביולי)" />
                                    <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); deleteFromHistory(h._id); }} title="מחק">
                                      <DeleteIcon fontSize="small" />
                                    </IconButton>
                                  </Stack>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </Collapse>
                    </Paper>
                  );
                })}
              </Stack>
            </CardContent>
          </Card>
        )}

        {/* Summary */}
        {audit && stats && (
          <Card>
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap' }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>סיכום בדיקה</Typography>
                {audit.year_month && <Chip size="small" label={`חודש ${audit.year_month}`} />}
                {audit.table_sheet_name && <Chip size="small" variant="outlined" label={`גליון: ${audit.table_sheet_name}`} />}
                {audit.branch_filter && <Chip size="small" variant="outlined" label={`סניף: ${audit.branch_filter}`} />}
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(6, 1fr)' }, gap: 1 }}>
                <StatTile label="שורות בטבלה" value={audit.rows_in_table} />
                <StatTile label="תלושים" value={audit.payslips_in_pdf} />
                <StatTile label="קריטי" value={stats.critical} color="error" />
                <StatTile label="אזהרה" value={stats.warning} color="warning" />
                <StatTile label="חסר תלוש" value={stats.missing} color="error" />
                <StatTile label="תלוש יתום" value={stats.orphans} color="warning" />
              </Box>

              {/* Cibus report meta — when a Cibus file was uploaded */}
              {audit.cibus_report_meta && (
                <Box sx={{ mt: 2, p: 1.25, bgcolor: 'info.50', borderRadius: 1.5, border: '1px solid', borderColor: 'info.light' }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                    🍽️ דוח סיבוס/Pluxee נטען
                  </Typography>
                  {audit.cibus_report_meta.parse_error ? (
                    <Typography variant="body2" color="error">
                      שגיאה: {audit.cibus_report_meta.parse_error}
                    </Typography>
                  ) : audit.cibus_report_meta.warning ? (
                    <Typography variant="body2" color="warning.dark">
                      ⚠ {audit.cibus_report_meta.warning}
                    </Typography>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      {audit.cibus_report_meta.transaction_count ?? audit.cibus_report_meta.aggregated_employee_count} עסקאות,
                      {' '}אוגדו ל-{audit.cibus_report_meta.aggregated_employee_count} עובדים ·
                      עמודות שזוהו: {Object.keys(audit.cibus_report_meta.detected_columns || {}).join(', ') || '—'}
                    </Typography>
                  )}
                  {Array.isArray(audit.orphan_cibus_rows) && audit.orphan_cibus_rows.length > 0 && (() => {
                    // Split: orphans that DO appear in the salary table (just no PDF
                    // for that branch) vs truly unknown employees.
                    const inTable = audit.orphan_cibus_rows.filter((c) => c.matched_table_row);
                    const unknown = audit.orphan_cibus_rows.filter((c) => !c.matched_table_row);
                    return (
                      <Box sx={{ mt: 1 }}>
                        {inTable.length > 0 && (
                          <Box sx={{ mb: 1 }}>
                            <Typography variant="caption" sx={{ fontWeight: 700, color: 'info.dark', display: 'block', mb: 0.5 }}>
                              💡 בטבלה אבל ללא PDF בסניף ({inTable.length}) — העלה PDF לסניף כדי להשלים בדיקה:
                            </Typography>
                            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                              {inTable.map((c, i) => (
                                <Chip
                                  key={i}
                                  size="small"
                                  variant="outlined"
                                  color="info"
                                  label={`${c.matched_table_row.employee_name} · ${c.matched_table_row.branch.replace(/\s+/g, ' ').trim()} · ₪${c.amount ?? '—'} ב-Pluxee${c.matched_table_row.cibus_in_table != null ? ` / ₪${c.matched_table_row.cibus_in_table} בטבלה` : ''}`}
                                  sx={{ height: 22, fontSize: 10 }}
                                />
                              ))}
                            </Stack>
                          </Box>
                        )}
                        {unknown.length > 0 && (
                          <Box>
                            <Typography variant="caption" sx={{ fontWeight: 700, color: 'warning.dark', display: 'block', mb: 0.5 }}>
                              עובדים בדוח Pluxee שלא נמצאו גם בטבלה ({unknown.length}):
                            </Typography>
                            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                              {unknown.map((c, i) => (
                                <Chip
                                  key={i}
                                  size="small"
                                  variant="outlined"
                                  color="warning"
                                  label={`${c.name || c.id || '?'} · ₪${c.amount ?? '—'}`}
                                  sx={{ height: 20, fontSize: 10 }}
                                />
                              ))}
                            </Stack>
                          </Box>
                        )}
                      </Box>
                    );
                  })()}
                </Box>
              )}

              {/* Per-branch breakdown — only when multi-file mode was used */}
              {Array.isArray(audit.per_branch) && audit.per_branch.length > 1 && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                    פירוט לפי סניף · התקדמות בטיפול
                  </Typography>
                  <Table size="small" sx={{
                    '& td, & th': { fontSize: 12, py: 0.5, borderColor: 'rgba(0,0,0,0.06)' },
                  }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>שורות</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>תלושים</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700, color: 'error.main' }}>קריטי</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700, color: 'warning.main' }}>אזהרה</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>חסר/יתום</TableCell>
                        <TableCell sx={{ fontWeight: 700, minWidth: 180 }}>התקדמות בטיפול</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {audit.per_branch.map((b, i) => {
                        // Branch name in audit.per_branch comes from the user's
                        // input (e.g. "משה דיין"), but branchProgress is keyed
                        // by the actual branch text from the table (e.g.
                        // "כפר סבא  משה דיין"). Match by includes().
                        const progress = Object.entries(branchProgress).find(([k]) => k.includes(b.branch))?.[1] || { withFindings: 0, reviewed: 0 };
                        const total = progress.withFindings;
                        const done = progress.reviewed;
                        const pct = total === 0 ? 0 : Math.round((done / total) * 100);
                        const allDone = total > 0 && done === total;
                        return (
                          <TableRow key={i} sx={{ bgcolor: allDone ? 'success.50' : 'inherit' }}>
                            <TableCell sx={{ fontWeight: 600 }}>
                              {allDone && <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main', verticalAlign: 'middle', ml: 0.5 }} />}
                              {b.branch}
                            </TableCell>
                            <TableCell align="center">{b.rows}</TableCell>
                            <TableCell align="center">{b.payslips}</TableCell>
                            <TableCell align="center" sx={{ color: b.critical > 0 ? 'error.main' : 'text.secondary', fontWeight: b.critical > 0 ? 700 : 400 }}>{b.critical}</TableCell>
                            <TableCell align="center" sx={{ color: b.warning > 0 ? 'warning.main' : 'text.secondary', fontWeight: b.warning > 0 ? 700 : 400 }}>{b.warning}</TableCell>
                            <TableCell align="center">{b.missing + b.orphans}</TableCell>
                            <TableCell>
                              {total === 0 ? (
                                <Typography variant="caption" color="text.disabled">אין תיקונים</Typography>
                              ) : (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                  <LinearProgress
                                    variant="determinate"
                                    value={pct}
                                    color={allDone ? 'success' : pct > 50 ? 'primary' : 'warning'}
                                    sx={{ flex: 1, height: 8, borderRadius: 1 }}
                                  />
                                  <Typography variant="caption" sx={{
                                    minWidth: 60,
                                    fontWeight: allDone ? 700 : 600,
                                    color: allDone ? 'success.dark' : 'text.primary',
                                  }}>
                                    {done}/{total} · {pct}%
                                  </Typography>
                                </Box>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
              )}
              {/* Filters: severity + branch + name search */}
              <Stack spacing={1} sx={{ mt: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 50 }}>חומרה:</Typography>
                  {['all', 'critical', 'warning', 'info', 'ok'].map((s) => (
                    <Chip
                      key={s}
                      label={s === 'all' ? 'הכל' : SEVERITY_META[s].label}
                      color={filterSev === s ? 'primary' : 'default'}
                      onClick={() => setFilterSev(s)}
                      variant={filterSev === s ? 'filled' : 'outlined'}
                      size="small"
                    />
                  ))}
                </Stack>
                {branchOptions.length > 1 && (
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 50 }}>סניף:</Typography>
                    <Chip
                      label="כולם"
                      color={filterBranch === 'all' ? 'primary' : 'default'}
                      onClick={() => setFilterBranch('all')}
                      variant={filterBranch === 'all' ? 'filled' : 'outlined'}
                      size="small"
                    />
                    {branchOptions.map((b) => (
                      <Chip
                        key={b}
                        label={b.replace(/\s+/g, ' ').trim()}
                        color={filterBranch === b ? 'primary' : 'default'}
                        onClick={() => setFilterBranch(b)}
                        variant={filterBranch === b ? 'filled' : 'outlined'}
                        size="small"
                      />
                    ))}
                  </Stack>
                )}
                <TextField
                  size="small"
                  placeholder="חיפוש לפי שם עובד או ת״ז…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{
                    endAdornment: searchQuery && (
                      <IconButton size="small" onClick={() => setSearchQuery('')} title="נקה">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    ),
                  }}
                  sx={{ maxWidth: 360 }}
                />
                {(filterSev !== 'all' || filterBranch !== 'all' || searchQuery) && (
                  <Typography variant="caption" color="text.secondary">
                    מציג {filteredResults.length} מתוך {audit.results.length}
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>
        )}

        {/* Per-employee paired layout: every audit card on the right has its
            own correction editor right next to it on the left, so the user
            edits each employee's findings in context. Manual employees (added
            via "+ עובד חדש") are appended at the bottom with no audit card. */}
        {audit && (
          <PerEmployeePairedView
            filteredResults={filteredResults}
            audit={audit}
            editableResults={editableResults}
            expanded={expanded}
            setExpanded={setExpanded}
            updateFinding={updateFinding}
            removeFinding={removeFinding}
            addFinding={addFinding}
            removeEmployee={removeEmployee}
            addManualEmployee={addManualEmployee}
            onSendEmail={roundView ? null : openEmailDialog}
            onSaveEdits={roundView ? null : () => saveEdits(false)}
            onFixRound={audit.saved_audit_id ? () => setFixDialog(true) : null}
            reviewedMap={reviewedMap}
            onToggleReviewed={roundView ? null : toggleReviewed}
            priorNotes={priorNotes}
            previewKind={audit.__preview_kind || null}
            roundView={roundView}
            onExitRoundView={exitRoundView}
            onApproveRound={approveRound}
            onSendEmployees={() => setDistDialog({ open: true, audit: { _id: roundView?.audit_id } })}
            onSendManagers={() => setMgrDialog({ open: true, audit: { _id: roundView?.audit_id } })}
            onAnotherRound={() => setFixDialog(true)}
            onResendAccountant={async () => { await exitRoundView(); openEmailDialog(); }}
            onAddNote={() => setAddNoteDlg({ open: true, key: '', message: '', severity: 'critical' })}
          />
        )}

        <FixRoundDialog
          open={fixDialog}
          auditId={roundView ? roundView.audit_id : audit?.saved_audit_id}
          branches={(audit?.payslip_files || []).map((f) => f.branch).filter(Boolean)}
          onClose={() => setFixDialog(false)}
          onOpenRound={openRoundInView}
          onAddNote={(reload) => setAddNoteDlg({ open: true, key: '', message: '', severity: 'critical', reload })}
          onSendAccountant={sendToAccountant}
        />

        {!audit && !running && (
          <Alert severity="info">העלה את קבצי הטבלה והתלושים מעלה ולחץ על "הרץ בדיקה"</Alert>
        )}
      </Stack>

      {/* Email dialog — confirms recipients + lets the manager edit the intro text */}
      <Dialog open={emailDialog.open} onClose={() => setEmailDialog({ open: false })} fullWidth maxWidth="md" dir="rtl">
        <DialogTitle>שליחת תיקוני תלושים במייל</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <RecipientEditor
              label="אל"
              required
              chips={emailTo}
              onRemove={(a) => removeRecipient('to', a)}
              inputValue={recipientInput.to}
              onInputChange={(v) => setRecipientInput((p) => ({ ...p, to: v }))}
              onAdd={() => addRecipient('to')}
            />
            <RecipientEditor
              label="עותק (CC)"
              chips={emailCc}
              onRemove={(a) => removeRecipient('cc', a)}
              inputValue={recipientInput.cc}
              onInputChange={(v) => setRecipientInput((p) => ({ ...p, cc: v }))}
              onAdd={() => addRecipient('cc')}
            />
            <Box>
              <Typography variant="caption" color="text.secondary">נושא</Typography>
              <Typography variant="body2">
                תיקוני תלושי שכר — {audit?.year_month} {audit?.branch_filter ? `— ${audit.branch_filter}` : ''}
              </Typography>
            </Box>
            <TextField
              label="טקסט פתיחה (ניתן לערוך)"
              multiline
              minRows={4}
              value={emailIntro}
              onChange={(e) => setEmailIntro(e.target.value)}
              fullWidth
            />
            {/* What the accountant actually receives — the two lists side by
                side, so it's obvious before sending that he gets the fixes AND
                the list of payslips he can skip. */}
            {(() => {
              const sendable = (f) => f.status !== 'rejected' && f.settled !== 'fixed' && f.message && f.message.trim();
              const toFix = editableResults
                .map((r, idx) => ({ r, idx }))
                .filter(({ r }) => r.findings.filter(sendable).length > 0);
              const fixCount = toFix.reduce((s, { r }) => s + r.findings.filter(sendable).length, 0);
              const reviewedApproved = approvedPayslips.filter((e) => e.reviewed).length;
              return (
                <>
                  <Alert severity={fixCount === 0 ? 'warning' : 'info'} sx={{ fontSize: 12 }}>
                    <b>{fixCount}</b> תיקונים עבור <b>{toFix.length}</b> תלושים יישלחו לתיקון
                    {approvedPayslips.length > 0 && <> · <b>{approvedPayslips.length}</b> תלושים יופיעו כרשימת "אושרו — אין צורך לעבור עליהם"
                      {reviewedApproved > 0 && ` (${reviewedApproved} מהם סומנו כנבדקו ידנית)`}</>}
                    {fixCount === 0 && ' ⚠ אין תיקונים לשליחה — סגור והוסף תיקונים בעמוד.'}
                  </Alert>

                  <FormControlLabel
                    control={<Checkbox checked={attachPayslips} onChange={(e) => setAttachPayslips(e.target.checked)} />}
                    label={
                      <Typography variant="body2">
                        צרף קובץ PDF עם <b>{toFix.length}</b> התלושים לתיקון בלבד
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          עמודי התלושים נחתכים מקבצי הסניפים השמורים. התלושים שאושרו לא מצורפים — רק שמותיהם ברשימה.
                        </Typography>
                      </Typography>
                    }
                  />

                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={includeFixLink}
                          disabled={fixLinkBusy || !audit?.saved_audit_id}
                          onChange={async (e) => {
                            setIncludeFixLink(e.target.checked);
                            if (e.target.checked) await ensureFixLink();
                          }}
                        />
                      }
                      label={
                        <Typography variant="body2">
                          צרף לרו"ח קישור להעלאת התלושים המתוקנים
                          <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            הוא מעלה ישירות למערכת ואנחנו מאמתים כל הערה — בלי שתצטרך להוריד ולהעלות מחדש.
                          </Typography>
                        </Typography>
                      }
                    />
                    {includeFixLink && fixLink && (
                      <Typography variant="caption" dir="ltr" sx={{ display: 'block', color: 'text.secondary', pr: 4, wordBreak: 'break-all' }}>
                        {fixLink}
                      </Typography>
                    )}
                    {fixLinkBusy && <Typography variant="caption" sx={{ pr: 4 }}>יוצר קישור…</Typography>}
                  </Box>

                  {approvedPayslips.length > 0 && (
                    <Paper variant="outlined" sx={{ p: 1, bgcolor: 'success.50', borderColor: 'success.light' }}>
                      <Typography variant="caption" sx={{ fontWeight: 800, color: 'success.dark' }}>
                        ✓ {approvedPayslips.length} תלושים מאושרים שיצוינו במייל:
                      </Typography>
                      <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary', lineHeight: 1.7 }}>
                        {approvedPayslips.map((e) => e.name).join(' · ')}
                      </Typography>
                    </Paper>
                  )}
                </>
              );
            })()}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEmailDialog({ open: false })}>ביטול</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            startIcon={previewBusy ? <CircularProgress size={16} /> : <DescriptionIcon />}
            onClick={previewEmail}
            disabled={previewBusy || emailSending}
          >
            {previewBusy ? 'בונה…' : 'תצוגה מקדימה'}
          </Button>
          <Button
            variant="contained"
            startIcon={emailSending ? <CircularProgress size={16} color="inherit" /> : <EmailIcon />}
            onClick={sendEmail}
            disabled={emailSending}
          >
            {emailSending ? 'שולח…' : 'שלח'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* The message itself, rendered by the same builder the send uses. */}
      <Dialog open={!!mailPreview} onClose={() => setMailPreview(null)} fullWidth maxWidth="md" dir="rtl">
        <DialogTitle sx={{ pb: 0.5 }}>
          תצוגה מקדימה — המייל לרו״ח
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 400 }}>
            נושא: {mailPreview?.subject}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
            {mailPreview?.attachment_name
              ? <Chip size="small" color="primary" variant="outlined"
                  label={`📎 ${mailPreview.attachment_name} · ${mailPreview.attachment_pages} עמודים`} />
              : <Chip size="small" variant="outlined" label="ללא קובץ מצורף" />}
            {!!mailPreview?.approved_count && <Chip size="small" color="success" variant="outlined" label={`${mailPreview.approved_count} מאושרים ברשימה`} />}
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, height: '70vh' }}>
          {mailPreview && (
            <iframe
              title="email-preview"
              srcDoc={mailPreview.html}
              sandbox=""
              style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMailPreview(null)}>סגור</Button>
          <Button variant="contained" startIcon={<EmailIcon />} disabled={emailSending}
            onClick={async () => { setMailPreview(null); await sendEmail(); }}>
            שלח
          </Button>
        </DialogActions>
      </Dialog>

      <BranchManagerEmailsDialog open={mgrEmailsOpen} onClose={() => setMgrEmailsOpen(false)} />
      {/* Put a signed-off employee back in play — one correction, appended to
          the origin audit, which is what the next round reads. */}
      <Dialog open={addNoteDlg.open} onClose={() => setAddNoteDlg({ ...addNoteDlg, open: false })} fullWidth maxWidth="sm" dir="rtl">
        <DialogTitle sx={{ fontWeight: 700 }}>הוסף תיקון לסבב הבא</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ fontSize: 12 }}>
              התיקון נוסף לביקורת המקורית. העובד/ת יחזרו אוטומטית לסבב התיקון הבא ולמייל לרו״ח,
              גם אם התלוש כבר סומן כנבדק.
            </Alert>
            <Autocomplete
              options={(audit?.results || []).map((r, i) => ({
                key: resultKey(r), i,
                label: `${r.table_row?.employee_name || r.payslip?.employee_name || '—'}${(r.__source_branch || r.table_row?.branch) ? ` · ${(r.__source_branch || r.table_row.branch).replace(/\s+/g, ' ').trim()}` : ''}`,
              }))}
              getOptionLabel={(o) => o.label || ''}
              isOptionEqualToValue={(a, b) => a.key === b.key}
              onChange={(_, v) => setAddNoteDlg((p) => ({ ...p, key: v?.key || '' }))}
              renderInput={(p) => <TextField {...p} label="עובד/ת" size="small" />}
            />
            <Select size="small" value={addNoteDlg.severity}
              onChange={(e) => setAddNoteDlg((p) => ({ ...p, severity: e.target.value }))}>
              <MenuItem value="critical">קריטי</MenuItem>
              <MenuItem value="warning">אזהרה</MenuItem>
            </Select>
            <TextField label="תיאור התיקון הנדרש" multiline minRows={3} fullWidth
              value={addNoteDlg.message}
              onChange={(e) => setAddNoteDlg((p) => ({ ...p, message: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddNoteDlg({ ...addNoteDlg, open: false })}>ביטול</Button>
          <Button variant="contained" disabled={!addNoteDlg.key || !addNoteDlg.message.trim()} onClick={submitAddNote}>
            הוסף
          </Button>
        </DialogActions>
      </Dialog>

      <PayslipDistributionDialog open={distDialog.open} audit={distDialog.audit} onClose={() => setDistDialog({ open: false, audit: null })} />
      <ManagerDistributionDialog open={mgrDialog.open} audit={mgrDialog.audit} onClose={() => setMgrDialog({ open: false, audit: null })} />

      {/* Phase 3: approve audit dialog — accept optional corrected payslip
          PDFs (one per branch) + admin note. Saving stamps the record as
          a closed cycle that future audits can reference. */}
      <Dialog
        open={approveDialog.open}
        onClose={() => setApproveDialog({ open: false, audit: null })}
        fullWidth
        maxWidth="sm"
        dir="rtl"
      >
        <DialogTitle>
          <Stack direction="row" alignItems="center" spacing={1}>
            <CheckCircleIcon color="success" />
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
              אישור סבב סופי
            </Typography>
            {approveDialog.audit?.year_month && (
              <Chip size="small" label={approveDialog.audit.year_month} />
            )}
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ fontSize: 12 }}>
              סימון הביקורת כסבב סופי מציין שהרו"ח השיב תלושים מתוקנים והם מאומתים.
              ניתן (לא חובה) להעלות גם את התלושים המתוקנים — הם יישמרו כגרסה הסופית של החודש.
            </Alert>

            {approveFiles.map((row, idx) => (
              <Paper key={idx} variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    label="סניף"
                    size="small"
                    value={row.branch}
                    onChange={(e) => setApproveFiles((prev) => prev.map((r, i) => i === idx ? { ...r, branch: e.target.value } : r))}
                    sx={{ flex: 1 }}
                  />
                  <FileInput
                    label="תלוש מתוקן (PDF)"
                    file={row.file}
                    onChange={(file) => setApproveFiles((prev) => prev.map((r, i) => i === idx ? { ...r, file } : r))}
                    accept=".pdf,application/pdf"
                  />
                </Stack>
              </Paper>
            ))}

            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => setApproveFiles((prev) => [...prev, { branch: '', file: null }])}
              sx={{ alignSelf: 'flex-start' }}
            >
              הוסף סניף נוסף
            </Button>

            <TextField
              label="הערה (אופציונלי)"
              multiline
              minRows={2}
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              fullWidth
              placeholder="לדוגמה: אושר ע״י אפרים ב-15.05, כל התלושים תוקנו"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApproveDialog({ open: false, audit: null })}>
            ביטול
          </Button>
          <Button
            variant="contained"
            color="success"
            startIcon={approveSending ? <CircularProgress size={16} color="inherit" /> : <CheckCircleIcon />}
            onClick={submitApprove}
            disabled={approveSending}
          >
            {approveSending ? 'שומר…' : 'אשר סבב'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Round-progression dialog: per-employee × per-round status matrix.
          Shows critical/warning counts per round, color-coded so the user can
          see "improved", "still open", "newly broken" at a glance. */}
      <Dialog
        open={progressionDialog.open}
        onClose={() => setProgressionDialog({ open: false, year_month: '', loading: false, data: null, error: null })}
        fullWidth
        maxWidth="lg"
        dir="rtl"
      >
        <DialogTitle>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
              📊 השוואת סבבי תיקון — {progressionDialog.year_month}
            </Typography>
            {progressionDialog.data?.rounds?.length > 0 && (
              <Chip size="small" label={`${progressionDialog.data.rounds.length} סבבים`} />
            )}
          </Stack>
        </DialogTitle>
        <DialogContent>
          {progressionDialog.loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          )}
          {progressionDialog.error && !progressionDialog.loading && (
            <Alert severity="error">{progressionDialog.error}</Alert>
          )}
          {progressionDialog.data && !progressionDialog.loading && (() => {
            const { rounds, employees } = progressionDialog.data;
            // Sort: 'open' first (need attention), then 'new', then 'resolved'
            const order = { open: 0, new: 1, dropped: 2, resolved: 3 };
            const sorted = [...employees].sort((a, b) =>
              (order[a.status] - order[b.status]) || a.name.localeCompare(b.name, 'he')
            );
            const cellSx = (cell) => {
              if (!cell) return { bgcolor: 'grey.100', color: 'text.disabled' };
              const total = cell.critical + cell.warning;
              if (total === 0) return { bgcolor: 'success.50', color: 'success.dark', fontWeight: 700 };
              if (cell.critical > 0) return { bgcolor: 'error.50', color: 'error.dark', fontWeight: 700 };
              return { bgcolor: 'warning.50', color: 'warning.dark', fontWeight: 700 };
            };
            const cellLabel = (cell) => {
              if (!cell) return '—';
              const total = cell.critical + cell.warning;
              if (total === 0) return '✓';
              const parts = [];
              if (cell.critical > 0) parts.push(`${cell.critical}🔴`);
              if (cell.warning > 0) parts.push(`${cell.warning}⚠`);
              return parts.join(' ');
            };
            return (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {rounds.map((r) => (
                    <Chip
                      key={r.audit_id}
                      label={`סבב ${r.round_no} · ${new Date(r.created_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}${r.approved ? ' ✓' : ''}`}
                      size="small"
                      color={r.approved ? 'success' : 'default'}
                      variant={r.approved ? 'filled' : 'outlined'}
                      sx={{ fontWeight: 700 }}
                    />
                  ))}
                </Stack>
                <Box sx={{ overflowX: 'auto' }}>
                  <Table size="small" sx={{ '& td, & th': { fontSize: 12, py: 0.5 } }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700, position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 1 }}>עובד</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>סניף</TableCell>
                        {rounds.map((r) => (
                          <TableCell key={r.audit_id} align="center" sx={{ fontWeight: 700, minWidth: 80 }}>
                            סבב {r.round_no}
                            <Typography variant="caption" display="block" color="text.secondary">
                              {new Date(r.created_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
                            </Typography>
                          </TableCell>
                        ))}
                        <TableCell align="center" sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sorted.map((emp) => (
                        <TableRow key={emp.key} hover>
                          <TableCell sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper', fontWeight: 600 }}>
                            {emp.name}
                            {emp.employee_no != null && (
                              <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>#{emp.employee_no}</Typography>
                            )}
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{emp.branch}</TableCell>
                          {rounds.map((r) => {
                            const cell = emp.rounds[r.audit_id];
                            return (
                              <TableCell
                                key={r.audit_id}
                                align="center"
                                sx={cellSx(cell)}
                                title={cell?.messages?.map((m) => m.message).join('\n') || ''}
                              >
                                {cellLabel(cell)}
                              </TableCell>
                            );
                          })}
                          <TableCell align="center">
                            {emp.status === 'resolved' && <Chip size="small" color="success" label="הסתיים" sx={{ height: 20, fontSize: 10 }} />}
                            {emp.status === 'open' && <Chip size="small" color="error" label="פתוח" sx={{ height: 20, fontSize: 10 }} />}
                            {emp.status === 'new' && <Chip size="small" color="warning" label="חדש" sx={{ height: 20, fontSize: 10 }} />}
                            {emp.status === 'dropped' && <Chip size="small" variant="outlined" label="לא בסבב אחרון" sx={{ height: 20, fontSize: 10 }} />}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {sorted.filter((e) => e.status === 'resolved').length} הסתיימו · {sorted.filter((e) => e.status === 'open').length} פתוחים · {sorted.filter((e) => e.status === 'new').length} חדשים
                </Typography>
              </Stack>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProgressionDialog({ open: false, year_month: '', loading: false, data: null, error: null })}>
            סגור
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
