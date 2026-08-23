import { useState, useEffect, useCallback } from 'react';
import {
  Box, Button, TextField, MenuItem, Stack, Typography, Alert, Divider, Paper,
  Table, TableHead, TableBody, TableRow, TableCell, Chip, LinearProgress,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * תנאי העסקה with a date on them.
 *
 * The screen exists because of what it prevents. A salary in this system is
 * recomputed from the employee card every time somebody opens a payroll month,
 * so editing the rate on the card used to rewrite every open month in the past
 * at the new rate — a raise agreed in September quietly repricing February.
 * Recording the change here dates it instead: earlier months keep the terms
 * they were actually worked under.
 *
 * Everything the accountant needs to not be surprised is shown BEFORE saving:
 * the month the change really starts, what it replaces, and which closed months
 * it cannot reach.
 */

// The baseline row is dated before any payroll exists on purpose. Printing
// "01/1900" would make a bookkeeper doubt the whole table, so it says what it
// means instead.
const BASELINE_MONTH = '1900-01';

const ymLabel = (ym) => {
  if (!ym) return '';
  if (ym === BASELINE_MONTH) return 'מלכתחילה';
  const [y, m] = ym.split('-');
  return `${m}/${y}`;
};

const money = (n) => (n === null || n === undefined || n === '' ? '—' : `${Number(n).toLocaleString('he-IL')} ₪`);

const describe = (t) => {
  if (!t) return '—';
  return t.salary_type === 'global'
    ? `תקן ${money(t.global_salary)} · ${t.required_hours || '—'} שעות`
    : `שעתי ${money(t.hourly_rate)}`;
};

const SOURCE_LABEL = {
  baseline: 'מצב התחלתי',
  contract: 'מחוזה',
  manual: 'עדכון ידני',
};

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function EmploymentTermsPanel({ employeeId, contractId = null, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState('');

  const load = useCallback(() => {
    if (!employeeId) return;
    setLoading(true);
    api.get(`/employment-contracts/terms/${employeeId}`)
      .then(({ data: d }) => {
        setData(d);
        const c = d.current || {};
        setForm({
          effective_date: todayISO(),
          salary_type: c.salary_type || 'hourly',
          hourly_rate: c.hourly_rate ?? '',
          global_salary: c.global_salary ?? '',
          global_ot_rate: c.global_ot_rate ?? '',
          required_hours: c.required_hours ?? '',
          note: '',
        });
      })
      .catch((err) => toast.error(err.response?.data?.error || 'שגיאה בטעינת תנאי העסקה'))
      .finally(() => setLoading(false));
  }, [employeeId]);

  useEffect(load, [load]);

  const set = (k, v) => { setForm((s) => ({ ...s, [k]: v })); setPlan(null); setPlanError(''); };

  // The preview is deliberately a separate, explicit step. It is the only place
  // the accountant is told the date moved to the start of the month and which
  // finalized months will not follow — findings that must land before a save,
  // not after one.
  const doPreview = async () => {
    setBusy(true); setPlanError('');
    try {
      const { data: p } = await api.post('/employment-contracts/terms/preview', { employee_id: employeeId, ...form });
      setPlan(p);
    } catch (err) {
      setPlan(null);
      setPlanError(err.response?.data?.error || 'שגיאה');
    } finally { setBusy(false); }
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const { data: r } = await api.post('/employment-contracts/terms', {
        employee_id: employeeId, contract_id: contractId, ...form,
      });
      toast.success(`התנאים עודכנו — בתוקף מ-${ymLabel(r.effective_month)}`);
      if (r.finalized_months?.length) {
        toast.warn(`חודשים סגורים לא השתנו: ${r.finalized_months.map(ymLabel).join(', ')}`);
      }
      setPlan(null);
      load();
      onSaved && onSaved(r);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally { setBusy(false); }
  };

  if (loading || !form) return <LinearProgress />;

  const isGlobal = form.salary_type === 'global';
  const history = data?.history || [];

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      {busy && <LinearProgress sx={{ mb: 1 }} />}

      <Alert severity="info" sx={{ mb: 2 }}>
        עדכון תנאי ההעסקה משנה את מה שהמערכת משלמת בפועל — <b>מהחודש שתבחר ואילך בלבד</b>.
        חודשים קודמים ימשיכו להיות מחושבים לפי התנאים שהיו נכונים בהם.
      </Alert>

      <Typography sx={{ fontWeight: 800, mb: 1 }}>
        תנאים נוכחיים: {describe(data?.current)}
      </Typography>

      <Divider sx={{ my: 2 }} />

      <Stack spacing={1.5} sx={{ maxWidth: 560 }}>
        <TextField
          size="small" type="date" label="בתוקף מתאריך"
          InputLabelProps={{ shrink: true }}
          value={form.effective_date}
          onChange={(e) => set('effective_date', e.target.value)}
        />

        <TextField select size="small" label="סוג שכר" value={form.salary_type}
          onChange={(e) => set('salary_type', e.target.value)}>
          <MenuItem value="hourly">שעתי</MenuItem>
          <MenuItem value="global">תקן (שכר חודשי מול שעות מחויבות)</MenuItem>
        </TextField>

        {isGlobal ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField size="small" type="number" fullWidth label="שכר חודשי ברוטו"
              value={form.global_salary} onChange={(e) => set('global_salary', e.target.value)} />
            <TextField size="small" type="number" fullWidth label="שעות חודשיות"
              value={form.required_hours} onChange={(e) => set('required_hours', e.target.value)} />
            <TextField size="small" type="number" fullWidth label="תעריף שעה נוספת"
              value={form.global_ot_rate} onChange={(e) => set('global_ot_rate', e.target.value)} />
          </Stack>
        ) : (
          <TextField size="small" type="number" label="שכר שעתי ברוטו" sx={{ maxWidth: 240 }}
            value={form.hourly_rate} onChange={(e) => set('hourly_rate', e.target.value)} />
        )}

        <TextField size="small" label="הערה (למה השתנה)" value={form.note}
          onChange={(e) => set('note', e.target.value)}
          placeholder="לדוגמה: חוזה חדש חתום 08/2026" />

        <Box>
          <Button variant="outlined" onClick={doPreview} disabled={busy}>בדוק מה ישתנה</Button>
        </Box>
      </Stack>

      {planError && <Alert severity="error" sx={{ mt: 2 }}>{planError}</Alert>}

      {plan && (
        <Box sx={{ mt: 2 }}>
          <Alert severity={plan.nothing_changed ? 'warning' : 'success'} sx={{ mb: 1 }}>
            {plan.nothing_changed
              ? 'התנאים שהוזנו זהים לתנאים הקיימים — אין מה לעדכן.'
              : (<>בתוקף מחודש <b>{ymLabel(plan.effective_month)}</b>: {describe(plan.previous)} ← <b>{describe(plan.next)}</b></>)}
          </Alert>

          {plan.mid_month && !plan.nothing_changed && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              התאריך שבחרת נמצא באמצע החודש. <b>כל חודש {ymLabel(plan.effective_month)} ישולם לפי התנאים החדשים</b>,
              ולא רק מהתאריך עצמו. התאריך המדויק נשמר ומוצג בהיסטוריה.
            </Alert>
          )}

          {plan.finalized_months?.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              החודשים הבאים כבר נסגרו ולא ישתנו: <b>{plan.finalized_months.map(ymLabel).join(', ')}</b>.
              כדי לעדכן אותם יש לפתוח אותם מחדש במסך השכר.
            </Alert>
          )}

          <Button variant="contained" color="primary" disabled={busy || plan.nothing_changed} onClick={doSave}>
            עדכן תנאי העסקה
          </Button>
        </Box>
      )}

      {history.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography sx={{ fontWeight: 800, mb: 1 }}>היסטוריית תנאים</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>בתוקף מ־</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>תנאים</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>מקור</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>נרשם</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* A row written straight into the database (an import, a fixture)
                  can arrive without an id — fall back rather than collide. */}
              {history.map((h, i) => (
                <TableRow key={h.id || `${h.effective_month}-${i}`} hover>
                  <TableCell>
                    <b>{ymLabel(h.effective_month)}</b>
                    {h.effective_date && h.effective_month !== BASELINE_MONTH && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                        לפי תאריך {new Date(h.effective_date).toLocaleDateString('he-IL')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {describe(h)}
                    {h.note && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                        {h.note}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell><Chip size="small" label={SOURCE_LABEL[h.source] || h.source} /></TableCell>
                  <TableCell>
                    <Typography variant="caption">
                      {h.created_by_name || '—'}
                      <br />
                      {h.created_at ? new Date(h.created_at).toLocaleDateString('he-IL') : ''}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Paper>
  );
}
