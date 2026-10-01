import { useState, useEffect, useMemo } from 'react';
import { toast } from 'react-toastify';
import {
  Box, Stack, Typography, Paper, Button, Alert, Collapse, TextField, MenuItem, IconButton, Chip, Autocomplete,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api, { apiError } from '../../api/client';
import EmptyState from '../ui/EmptyState';
import { BusyButton } from '../shared/UploadControls';
import { TxCard, Reasons } from '../expenses/ExpenseCards';
import { useAcademicYear, formatAcademicYear } from '../../hooks/useAcademicYear';
import {
  formatILS, monthName, academicYearOfDate, remainingOf, openCells, defaultSplit, sumOf,
  useLoad, LoadGate, Section, ResponsiveTable,
} from './incomeUi';

const TOLERANCE_ILS = 2;
const OPEN_MONTHS_NOTE = 'ההצעות והחלוקה משתמשות בחודשים שעוד פתוחים בבנק (צפוי פחות מה שכבר שויך מהבנק). קבלה במשרד לא סוגרת חודש כאן — לכן חודש עם קבלה עדיין יכול להופיע בחלוקה.';

const ALIAS_MSG = {
  created: 'שויך · שם המשלם נזכר — בפעם הבאה ההעברה ממנו תשויך למשפחה הזו מיד',
  same: 'שויך · שם המשלם כבר מוכר למשפחה הזו',
  skipped: 'שויך',
};
const ALIAS_CONFLICT = 'שויך — אבל שם המשלם בבנק כבר שמור למשפחה אחרת, ולכן לא נשמר כ"משלם מוכר" למשפחה הזו. אם זו טעות — בטלו את השיוך הקודם.';

const childList = (h) => (h.children || []).map(c => c.child_name).join(', ');
const parentList = (h) => (h.parents || []).join(' / ') || '— אין שם הורה —';

/** The family a transfer would go to: parents, children, the usual monthly amount. */
function HouseholdCard({ household, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderInlineStart: '4px solid', borderInlineStartColor: 'success.main', height: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography component="span" aria-hidden>👪</Typography>
        <Typography variant="subtitle2">{parentList(household)}</Typography>
      </Stack>
      <Typography variant="body2" sx={{ mt: 0.5 }}>ילדים: {childList(household) || '—'}</Typography>
      {household.monthly_expected > 0 && (
        <Typography variant="caption" color="text.secondary">סכום חודשי רגיל: {formatILS(household.monthly_expected)}</Typography>
      )}
      {children}
    </Paper>
  );
}

/** Editable split: one row per child+month; amounts may be changed, rows removed or added from the family's open months. */
function SplitEditor({ household, amount, value, onChange, disabled }) {
  const cells = useMemo(() => openCells(household), [household]);
  const openOfRow = (r) => cells.find(c => String(c.registration_id) === String(r.registration_id) && c.month_number === r.month_number)?.open ?? 0;
  const free = cells.filter(c => !value.some(r => String(r.registration_id) === String(c.registration_id) && r.month_number === c.month_number));
  const total = sumOf(value);
  const over = total > amount + TOLERANCE_ILS;

  const setAmount = (i, v) => onChange(value.map((r, j) => (j === i ? { ...r, amount: v } : r)));
  const remove = (i) => onChange(value.filter((_r, j) => j !== i));
  const add = (key) => {
    const c = free.find(x => `${x.registration_id}|${x.month_number}` === key);
    if (!c) return;
    const left = Math.max(0, Math.round((amount - total) * 100) / 100);
    onChange([...value, { registration_id: c.registration_id, child_name: c.child_name, month_number: c.month_number, amount: Math.min(c.open, left) || c.open }]);
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>חלוקה לילדים ולחודשים</Typography>
      {!value.length && <Typography variant="body2" color="text.secondary">אין שורות בחלוקה — הוסיפו חודש.</Typography>}
      <Stack spacing={0.75}>
        {value.map((r, i) => {
          const n = Number(r.amount);
          const bad = !(n > 0) || n > openOfRow(r) + TOLERANCE_ILS;
          return (
            <Stack key={`${r.registration_id}|${r.month_number}`} direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                {r.child_name} · {monthName(r.month_number)}
                <Typography component="span" variant="caption" color="text.secondary"> (פתוח {formatILS(openOfRow(r))})</Typography>
              </Typography>
              <TextField size="small" value={r.amount} disabled={disabled}
                onChange={e => setAmount(i, e.target.value)} inputProps={{ inputMode: 'decimal', 'aria-label': `סכום ל${r.child_name} ${monthName(r.month_number)}` }}
                error={bad} helperText={bad ? (n > 0 ? 'יותר מהפתוח' : 'סכום לא תקין') : undefined} sx={{ width: 120 }} />
              <IconButton size="small" aria-label="הסרת השורה" disabled={disabled} onClick={() => remove(i)}><DeleteOutlineIcon fontSize="small" /></IconButton>
            </Stack>
          );
        })}
      </Stack>
      {free.length > 0 && !disabled && (
        <TextField select size="small" label="הוספת חודש" value="" onChange={e => add(e.target.value)} sx={{ mt: 1, minWidth: 220 }}>
          {free.map(c => (
            <MenuItem key={`${c.registration_id}|${c.month_number}`} value={`${c.registration_id}|${c.month_number}`}>
              {c.child_name} · {monthName(c.month_number)} · פתוח {formatILS(c.open)}
            </MenuItem>
          ))}
        </TextField>
      )}
      <Typography variant="body2" sx={{ mt: 1, color: over ? 'error.main' : 'text.secondary' }}>
        סה״כ בחלוקה {formatILS(total)} מתוך {formatILS(amount)} בהעברה
        {over ? ' — יותר מסכום ההעברה' : total + TOLERANCE_ILS < amount ? ` · יישארו ${formatILS(amount - total)} לא משויכים` : ''}
      </Typography>
    </Box>
  );
}

/** Why the accept button cannot be pressed — spelled out, never a tooltip on a disabled control. */
function splitProblem(household, amount, split) {
  if (!split.length) return 'אין שורות בחלוקה';
  const cells = openCells(household);
  for (const r of split) {
    const n = Number(r.amount);
    if (!(n > 0)) return 'יש בחלוקה סכום לא תקין';
    const open = cells.find(c => String(c.registration_id) === String(r.registration_id) && c.month_number === r.month_number)?.open ?? 0;
    if (n > open + TOLERANCE_ILS) return 'יש בחלוקה חודש עם סכום גדול מהפתוח';
  }
  if (sumOf(split) > amount + TOLERANCE_ILS) return 'סכום החלוקה גדול מסכום ההעברה';
  return '';
}

async function acceptTransfer({ tx, household, year, split }) {
  const { data } = await api.post('/income/kaplan/accept', {
    transaction_id: tx._id,
    household_key: household.household_key,
    academic_year: year,
    split: split.map(r => ({ registration_id: r.registration_id, month_number: r.month_number, amount: Number(r.amount) })),
  });
  if (data.alias === 'conflict') toast.warning(ALIAS_CONFLICT, { autoClose: 15000 });
  else toast.success(ALIAS_MSG[data.alias] || 'שויך');
}

/** Family + editable split + "אשר". Used for a proposal, an alternative and a manual pick. */
function AssignPanel({ tx, household, year, initialSplit, canWrite, onDone, acceptLabel = '✓ אשר', extraActions }) {
  const amount = remainingOf(tx);
  const [split, setSplit] = useState(() => (initialSplit || defaultSplit(household, amount)).map(r => ({ ...r })));
  const [busy, setBusy] = useState(false);
  const problem = splitProblem(household, amount, split);

  const accept = async () => {
    setBusy(true);
    try { await acceptTransfer({ tx, household, year, split }); onDone(); }
    catch (err) { toast.error(apiError(err, 'השיוך נכשל')); }
    finally { setBusy(false); }
  };

  return (
    <HouseholdCard household={household}>
      <SplitEditor household={household} amount={amount} value={split} onChange={setSplit} disabled={!canWrite || busy} />
      {canWrite && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
            <BusyButton variant="contained" color="success" loading={busy} disabled={!!problem} onClick={accept}>{acceptLabel}</BusyButton>
            {extraActions}
          </Stack>
          {problem && <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'error.main' }}>לא ניתן לאשר: {problem}</Typography>}
        </>
      )}
    </HouseholdCard>
  );
}

/** "✗ לא זה" — the next five families for the transfer, each with its own split. */
function Alternatives({ tx, canWrite, onDone }) {
  const [state, reload] = useLoad('/income/kaplan/alternatives', { transaction_id: tx._id });
  const [chosen, setChosen] = useState(null);
  const year = academicYearOfDate(tx.date);
  const list = state.data?.alternatives || [];
  return (
    <Box sx={{ mt: 1.5, p: 1.5, border: '1px dashed', borderColor: 'info.main', borderRadius: 1 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>משפחות אחרות להעברה הזו:</Typography>
      <LoadGate state={state} reload={reload}>
        {!list.length ? <Typography variant="body2" color="text.secondary">אין משפחה אחרת בשנת הלימודים של ההעברה. אפשר לשייך ידנית למטה ב"העברות בלי משפחה".</Typography> : (
          <Stack spacing={1}>
            {list.map(a => {
              const k = a.household.household_key;
              return chosen === k ? (
                <AssignPanel key={k} tx={tx} household={a.household} year={year} initialSplit={a.split} canWrite={canWrite} onDone={onDone}
                  acceptLabel="✓ שייך למשפחה הזו" extraActions={<Button onClick={() => setChosen(null)}>ביטול</Button>} />
              ) : (
                <Stack key={k} direction="row" spacing={1} alignItems="center" justifyContent="space-between"
                  sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2">{parentList(a.household)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {childList(a.household)}{a.household.monthly_expected ? ` · ${formatILS(a.household.monthly_expected)} לחודש` : ''}{a.reasons?.length ? ` · ${a.reasons.join(' · ')}` : ''}
                    </Typography>
                  </Box>
                  {a.score > 0 && <Chip size="small" label={`${a.score}%`} />}
                  {canWrite && <Button size="small" variant="outlined" onClick={() => setChosen(k)}>בחר</Button>}
                </Stack>
              );
            })}
          </Stack>
        )}
      </LoadGate>
    </Box>
  );
}

/** One proposed transfer ↔ family. */
function PairRow({ pair, canWrite, onDone }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('md'));
  const { tx, household } = pair;
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const year = academicYearOfDate(tx.date);

  const reject = async () => {
    setBusy(true);
    try {
      await api.post('/income/kaplan/reject', { transaction_id: tx._id, household_key: household.household_key });
      setRejected(true);
    } catch (err) { toast.error(apiError(err, 'השמירה נכשלה')); }
    finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 7.5rem 1.3fr' }, alignItems: 'stretch' }}>
        <TxCard tx={tx} />
        <Reasons score={pair.score} reasons={pair.reasons} vertical={phone} />
        {rejected ? (
          <HouseholdCard household={household}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>✗ סימנתם שזו לא המשפחה — לא תוצע שוב להעברה הזו</Typography>
          </HouseholdCard>
        ) : (
          <AssignPanel tx={tx} household={household} year={year} initialSplit={pair.split} canWrite={canWrite} onDone={onDone}
            extraActions={<Button variant="outlined" color="error" disabled={busy} onClick={reject}>✗ לא זה — הראו אפשרויות</Button>} />
        )}
      </Box>
      {rejected && <Alternatives tx={tx} canWrite={canWrite} onDone={onDone} />}
    </Paper>
  );
}

const yearShift = (range, d) => {
  const s = Number(String(range).slice(0, 4)) + d;
  return `${s}-${s + 1}`;
};

/** "שייך למשפחה": search the Kaplan families of a gan year (the transfer's, or the one before / after). */
function FamilyPicker({ tx, canWrite, onDone, onClose }) {
  const txYear = academicYearOfDate(tx.date);
  const [year, setYear] = useState(txYear);
  const [state, reload] = useLoad('/income/kaplan/households', { year });
  const [household, setHousehold] = useState(null);
  const households = state.data?.households || [];
  useEffect(() => { setHousehold(null); }, [year]);

  return (
    <Box sx={{ mt: 1, p: 1.25, border: '1px dashed', borderColor: 'info.main', borderRadius: 1 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField select size="small" label="שנת לימודים" value={year} onChange={e => setYear(e.target.value)} sx={{ minWidth: 170 }}>
          {[yearShift(txYear, -1), txYear, yearShift(txYear, 1)].map(y => (
            <MenuItem key={y} value={y}>{formatAcademicYear(y)}{y === txYear ? ' (לפי תאריך ההעברה)' : ''}</MenuItem>
          ))}
        </TextField>
        <Box sx={{ flex: 1 }}>
          <LoadGate state={state} reload={reload}>
            <Autocomplete
              size="small"
              options={households}
              value={household}
              onChange={(_e, v) => setHousehold(v)}
              getOptionLabel={(h) => `${parentList(h)} — ${childList(h)}`}
              isOptionEqualToValue={(a, b) => a.household_key === b.household_key}
              noOptionsText={households.length ? 'לא נמצאה משפחה' : 'אין משפחות קפלן בשנה הזו'}
              renderInput={(params) => <TextField {...params} label="חיפוש משפחה (שם הורה או ילד)" />}
            />
          </LoadGate>
        </Box>
      </Stack>
      {household && (
        <Box sx={{ mt: 1 }}>
          <AssignPanel key={`${year}|${household.household_key}`} tx={tx} household={household} year={year} canWrite={canWrite} onDone={onDone}
            acceptLabel="✓ שייך למשפחה הזו" />
        </Box>
      )}
      <Button size="small" sx={{ mt: 1 }} onClick={onClose}>סגור</Button>
    </Box>
  );
}

function UnmatchedTx({ tx, canWrite, onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <TxCard tx={tx}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>{tx.why}</Typography>
      {canWrite && !open && <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={() => setOpen(true)}>שייך למשפחה</Button>}
      {open && <FamilyPicker tx={tx} canWrite={canWrite} onDone={onDone} onClose={() => setOpen(false)} />}
    </TxCard>
  );
}

const crossCols = [
  { key: 'child_name', label: 'ילד/ה', title: true },
  { key: 'month_number', label: 'חודש', render: r => monthName(r.month_number) },
  { key: 'expected', label: 'צפוי', num: true },
  { key: 'receipt', label: 'קבלה', render: r => r.receipt || '—' },
  { key: 'allocated', label: 'בבנק', num: true },
];

/** Per month: expected · paid by receipt · found in the bank — and the two cross-check lists. */
function MonthReport({ year, tick }) {
  const [state, reload] = useLoad('/income/kaplan/report', { year });
  // An accept / reject elsewhere on the tab changes the bank column: reload, keep the old table meanwhile.
  useEffect(() => { if (tick) reload(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = state.data;
  const months = d?.months || [];
  const footer = months.length ? { month_number: null, expected: sumOf(months, 'expected'), by_receipt: sumOf(months, 'by_receipt'), in_bank: sumOf(months, 'in_bank') } : null;
  const cardTitle = (r) => `${r.child_name} · ${monthName(r.month_number)}`;
  return (
    <Section title={`📊 הצלבה לפי חודש — ${formatAcademicYear(year)}`}
      hint="צפוי (כמו במסך הגבייה) · שולם לפי קבלה (מהגבייה) · נמצא בבנק (שיוכים מהמסך הזה). השנה לפי בורר השנה של המערכת.">
      <LoadGate state={state} reload={reload}>
        {d && (
          <>
            {!months.length ? <EmptyState title="אין נתוני גבייה לקפלן בשנה הזו" /> : (
              <ResponsiveTable
                rowKey={r => r.month_number}
                cardTitle={r => monthName(r.month_number)}
                columns={[
                  { key: 'month_number', label: 'חודש', title: true, render: r => (r.month_number ? monthName(r.month_number) : 'סה״כ') },
                  { key: 'expected', label: 'צפוי', num: true },
                  { key: 'by_receipt', label: 'לפי קבלה', num: true },
                  { key: 'in_bank', label: 'בבנק', num: true },
                ]}
                rows={months}
                footer={footer}
              />
            )}
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, mt: 2 }}>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>🧾 קבלה בלי כסף בבנק ({d.receipt_no_bank.length})</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>יש קבלה (או סומן שולם) אבל לא נמצאה העברה בנקאית שמכסה את החודש — צ׳ק, מזומן, או העברה שעוד לא שויכה.</Typography>
                {!d.receipt_no_bank.length ? <Typography variant="body2" color="text.secondary">אין ✓</Typography>
                  : <ResponsiveTable columns={crossCols} rows={d.receipt_no_bank} cardTitle={cardTitle} rowKey={r => `${r.registration_id}|${r.month_number}`} />}
              </Box>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>🏦 כסף בבנק בלי קבלה ({d.bank_no_receipt.length})</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>שויכה העברה לחודש, אבל במסך הגבייה אין עדיין קבלה — כדאי להוציא קבלה.</Typography>
                {!d.bank_no_receipt.length ? <Typography variant="body2" color="text.secondary">אין ✓</Typography>
                  : <ResponsiveTable columns={crossCols} rows={d.bank_no_receipt} cardTitle={cardTitle} rowKey={r => `${r.registration_id}|${r.month_number}`} />}
              </Box>
            </Box>
          </>
        )}
      </LoadGate>
    </Section>
  );
}

const cardsGrid = { display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } };

/** קפלן — parents' bank transfers ↔ families, and the per-month cross-check. */
export default function KaplanTab({ canWrite }) {
  const { selectedYear } = useAcademicYear();
  const [state, reload] = useLoad('/income/kaplan/queue');
  const [tick, setTick] = useState(0);
  const [showExempt, setShowExempt] = useState(false);
  const done = () => { reload(); setTick(t => t + 1); };

  const q = state.data;
  const pairs = q?.pairs || [];
  const unmatched = q?.unmatched_tx || [];
  const exempt = q?.exempt || [];

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>{OPEN_MONTHS_NOTE}</Alert>
      <LoadGate state={state} reload={reload}>
        {q && (
          <>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
              <Typography sx={{ color: 'info.dark' }}>{pairs.length} העברות עם משפחה מוצעת</Typography>
              <Typography sx={{ color: 'warning.dark' }}>{unmatched.length} העברות בלי משפחה</Typography>
            </Stack>

            {!pairs.length ? <EmptyState title="אין הצעות פתוחות ✓" hint="כל ההעברות הנכנסות שויכו, או שלא נמצאה להן משפחה (ברשימה למטה)." /> : (
              <Stack spacing={1.5}>
                {pairs.map(p => <PairRow key={`${p.tx._id}|${p.household.household_key}|${p.tx.remaining}`} pair={p} canWrite={canWrite} onDone={done} />)}
              </Stack>
            )}

            <Section title="💸 העברות בלי משפחה" count={unmatched.length}>
              {!unmatched.length ? <Typography variant="body2" color="text.secondary">אין ✓</Typography> : (
                <Box sx={cardsGrid}>
                  {unmatched.map(t => <UnmatchedTx key={`${t._id}|${t.remaining}`} tx={t} canWrite={canWrite} onDone={done} />)}
                </Box>
              )}
            </Section>

            {exempt.length > 0 && (
              <Box sx={{ mt: 3 }}>
                <Button onClick={() => setShowExempt(s => !s)} sx={{ px: 0 }}>
                  {showExempt ? '▾' : '◂'} לא הכנסת הורים — אמונה, ריבית, החזרים ({exempt.length})
                </Button>
                <Collapse in={showExempt} unmountOnExit>
                  <Box sx={{ ...cardsGrid, mt: 1 }}>
                    {exempt.map(({ tx, rule }) => (
                      <TxCard key={tx._id} tx={tx} dim>
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>כלל: {rule.label}{rule.note ? ` — ${rule.note}` : ''}</Typography>
                      </TxCard>
                    ))}
                  </Box>
                </Collapse>
              </Box>
            )}
          </>
        )}
      </LoadGate>

      <MonthReport year={selectedYear} tick={tick} />
    </Box>
  );
}
