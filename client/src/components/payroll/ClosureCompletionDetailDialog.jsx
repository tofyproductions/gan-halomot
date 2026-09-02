import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Alert, Table, TableHead, TableBody, TableRow, TableCell,
  Checkbox, Chip, CircularProgress, Tooltip,
} from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import { toast } from 'react-toastify';
import api from '../../api/client';

const ils = (n) => `₪${Math.round(Number(n) || 0).toLocaleString('he-IL')}`;
const HEB_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayLabel = (ymd) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

/**
 * בונוס אוגוסט — the EDIT dialog behind the bonus chip.
 *
 * Nothing here pays by itself: the server materializes/deletes the synthetic
 * punches only for the dates SAVED to the approval list, and (for a global
 * employee) carves the bonus out of the monthly completion so full approval
 * lands on exactly 100% of the agreed salary. The dialog's amounts are
 * estimates priced at her hourly value — the binding number is the one on the
 * table row after saving.
 *
 * Day states from GET /payroll-month/closure-candidates/:employeeId —
 *   worked      she clocked in (ימי היערכות): paid normally, not approvable;
 *   approved    on the saved approval list;
 *   unapproved  awaiting the accountant's decision (the default for every day).
 */
export default function ClosureCompletionDetailDialog({ open, row, month, onClose, onSaved, locked }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(() => new Set());

  const employeeId = row?.employee_id;

  useEffect(() => {
    if (!open || !employeeId) return;
    setData(null);
    setLoading(true);
    api.get(`/payroll-month/closure-candidates/${employeeId}`, { params: { month } })
      .then(res => {
        setData(res.data);
        setApproved(new Set(res.data?.approved_dates || []));
      })
      .catch(err => {
        toast.error(err.response?.data?.error || 'טעינת ימי הבונוס נכשלה');
        onClose?.();
      })
      .finally(() => setLoading(false));
  }, [open, employeeId, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const isGlobal = row?.salary_type === 'global';
  const hourlyValue = isGlobal
    ? Number(row?.breakdown?.components?.teken_breakdown?.hourly_value || 0)
    : Number(row?.breakdown?.rates?.hourly_rate || 0);

  const days = data?.days || [];
  const approvable = useMemo(() => days.filter(d => d.status !== 'worked'), [days]);
  const estimate = (d) => (hourlyValue > 0 ? d.weighted_pay_hours * hourlyValue : 0);
  const approvedEstimate = approvable
    .filter(d => approved.has(d.date))
    .reduce((s, d) => s + estimate(d), 0);
  const allApproved = approvable.length > 0 && approvable.every(d => approved.has(d.date));
  const dirty = data && (
    approvable.some(d => approved.has(d.date) !== (d.status === 'approved')) || !data.flag_on
  );
  const editingBlocked = locked || data?.locked;

  const toggleDay = (date) => {
    setApproved(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };
  const setAll = (on) => {
    setApproved(on ? new Set(approvable.map(d => d.date)) : new Set());
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/payroll-month/${employeeId}`, {
        manual: {
          closure_completion: true,
          closure_completion_approved_dates: [...approved].sort(),
        },
      }, { params: { month } });
      toast.success(`בונוס אוגוסט נשמר — ${approved.size} ימים מאושרים לתשלום`);
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שמירת הבונוס נכשלה');
    } finally {
      setSaving(false);
    }
  };

  // Turning the bonus OFF removes every synthetic bonus day from the month —
  // the server deletes the punches; the approval choices are kept for a re-enable.
  const disableBonus = async () => {
    setSaving(true);
    try {
      await api.patch(`/payroll-month/${employeeId}`, {
        manual: { closure_completion: false },
      }, { params: { month } });
      toast.info('בונוס אוגוסט בוטל לחודש זה — ימי הבונוס הוסרו מהשכר');
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'ביטול הבונוס נכשל');
    } finally {
      setSaving(false);
    }
  };

  if (!row) return null;

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <EventAvailableIcon color="secondary" />
        בונוס אוגוסט — {row.full_name} ({month})
      </DialogTitle>
      <DialogContent>
        {loading || !data ? (
          <Box sx={{ py: 4, textAlign: 'center' }}><CircularProgress size={28} /></Box>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'secondary.50', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">מאושרים לתשלום</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800 }}>
                  {approvable.filter(d => approved.has(d.date)).length} / {approvable.length}
                </Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.secondary">בונוס משוער</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800, color: 'success.dark' }}>{ils(approvedEstimate)}</Typography>
              </Box>
            </Stack>

            <Alert severity="info" sx={{ borderRadius: 2 }}>
              {isGlobal
                ? 'עובדת גלובלית: יום מאושר הוא יום חופשת קיץ במתנה מהגן — משולם כ"בונוס אוגוסט" בלי לגעת בימי החופשה שבצבירה. אישור של כל הימים = שכר מלא (100%) בדיוק כמו חודש רגיל, בחלוקה שמפרידה שעות שעבדה בפועל מהבונוס. יום שלא אושר יורד מהשכר. הסכומים כאן משוערים — הסכום המחייב מופיע בטבלה אחרי שמירה.'
                : 'עובדת שעתית: יום מאושר משולם כבונוס נפרד לפי השעות המשוערות שלו (עד 8 שעות, בלי שע״נ) — הוא לא נספר בימי העבודה ובשעות, ולא נוגע בימי החופשה שבצבירה. יום שלא אושר פשוט לא משולם.'}
            </Alert>

            {editingBlocked && (
              <Alert severity="warning" sx={{ borderRadius: 2 }}>החודש נעול — צפייה בלבד.</Alert>
            )}

            {days.length === 0 ? (
              <Alert severity="warning" sx={{ borderRadius: 2 }}>
                לא נמצאו ימי התחייבות בטווח חופשת הקיץ (16–31.8). ודאו שמוגדרים לעובדת ימי התחייבות.
              </Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={allApproved}
                        indeterminate={!allApproved && approvable.some(d => approved.has(d.date))}
                        disabled={editingBlocked || approvable.length === 0}
                        onChange={(e) => setAll(e.target.checked)}
                      />
                    </TableCell>
                    <TableCell>תאריך</TableCell>
                    <TableCell align="center">התחייבות</TableCell>
                    <TableCell align="center">שעות לתשלום</TableCell>
                    <TableCell align="center">סכום משוער</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {days.map((d) => {
                    const worked = d.status === 'worked';
                    const isOn = !worked && approved.has(d.date);
                    return (
                      <TableRow
                        key={d.date}
                        hover={!worked && !editingBlocked}
                        onClick={() => !worked && !editingBlocked && toggleDay(d.date)}
                        sx={{
                          cursor: worked || editingBlocked ? 'default' : 'pointer',
                          opacity: worked ? 0.55 : 1,
                          bgcolor: isOn ? 'success.50' : undefined,
                        }}
                      >
                        <TableCell padding="checkbox">
                          {worked
                            ? <Tooltip title="הגיעה והחתימה שעון — משולם כרגיל, לא חלק מהבונוס"><span>—</span></Tooltip>
                            : <Checkbox size="small" checked={isOn} disabled={editingBlocked} />}
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {dayLabel(d.date)} · {HEB_WEEKDAYS[d.weekday]}
                          </Typography>
                          {d.out_of_window && (
                            <Chip size="small" variant="outlined" color="warning" label="מחוץ לטווח 16–31" sx={{ height: 16, fontSize: '0.55rem' }} />
                          )}
                        </TableCell>
                        <TableCell align="center">
                          {d.committed_start ? `${d.committed_start}–${d.committed_end}` : '—'}
                        </TableCell>
                        <TableCell align="center">
                          {worked ? (
                            <Chip size="small" variant="outlined" label={`עבדה ${d.worked_hours}ש׳`} sx={{ height: 18, fontSize: '0.6rem' }} />
                          ) : (
                            <Tooltip title={d.from_average ? 'לפי ממוצע השעות שלה ליום זה ב-3 החודשים האחרונים' : 'לפי שעות ההתחייבות'}>
                              <span>{d.pay_hours}ש׳{d.from_average ? '*' : ''}</span>
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 700 }}>
                          {worked ? '' : ils(estimate(d))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            {approvable.length > 0 && !editingBlocked && (
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="outlined" color="success" onClick={() => setAll(true)}>
                  אשר את כל הימים
                </Button>
                <Button size="small" variant="outlined" color="inherit" onClick={() => setAll(false)}>
                  בטל את כל האישורים
                </Button>
              </Stack>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {data?.flag_on && !editingBlocked && (
          <Button color="error" onClick={disableBonus} disabled={saving} sx={{ ml: 'auto' }}>
            בטל בונוס אוגוסט לחודש זה
          </Button>
        )}
        <Button onClick={onClose} disabled={saving}>סגור</Button>
        {!editingBlocked && (
          <Button variant="contained" onClick={save} disabled={saving || loading || !data || !dirty}>
            {saving ? 'שומר…' : 'שמור אישורים'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
