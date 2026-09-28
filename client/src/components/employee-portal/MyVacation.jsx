import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Paper, Alert, LinearProgress, Chip, Divider,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
} from '@mui/material';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import api from '../../api/client';

/**
 * The employee's own חופשה balance.
 *
 * She could already see her hours and her payslips; the balance was the one
 * number she had to ask the office for, and the office had to ask the
 * accountant. By the time a payslip answers it, the leave has been taken.
 *
 * So the working is shown, not just a figure: the opening balance and the month
 * it was measured, what has accrued since, every month she took days, and what
 * is left. Somebody is going to plan a holiday on this number, and a balance
 * nobody can reconstruct is a balance nobody trusts.
 *
 * Two things are said out loud rather than left to be inferred. A תקן employee
 * is paid for leave beyond her balance and goes into arrears; an hourly one is
 * simply not paid for it — the screen says which she is, because otherwise the
 * number behaves inexplicably. And when no balance has been imported the screen
 * says so instead of showing a zero: "we do not know" and "you have none" are
 * different sentences, and only one of them is true.
 */
const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL');

export default function MyVacation() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/payroll/my-vacation')
      .then((res) => setData(res.data))
      .catch((e) => setErr(e.response?.data?.error || 'שגיאה בטעינת יתרת החופשה'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Box sx={{ p: 2 }}><LinearProgress /></Box>;
  if (err) return <Box sx={{ p: 2 }}><Alert severity="error">{err}</Alert></Box>;

  const noBalance = data && data.available == null;
  const negative = data?.available < 0;

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2 }, maxWidth: 760, mx: 'auto' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <BeachAccessIcon color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 800 }}>יתרת ימי החופשה שלי</Typography>
      </Stack>

      {noBalance && (
        <Alert severity="info">
          {data.reason === 'no_employee'
            ? 'לא נמצא כרטיס עובד/ת מקושר לחשבון הזה. פנו למשרד.'
            : 'יתרת החופשה שלך עדיין לא הוזנה למערכת. המשרד מעדכן את היתרות מדוח שנתי של רואת החשבון — אפשר לפנות אליהם בינתיים.'}
        </Alert>
      )}

      {!noBalance && data && (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{
            p: 2.5, borderRadius: 3, textAlign: 'center',
            bgcolor: negative ? '#fef2f2' : '#f0fdf4',
            borderColor: negative ? '#fecaca' : '#bbf7d0',
          }}>
            <Typography variant="body2" color="text.secondary">
              {negative ? 'את/ה במינוס ימי חופשה' : 'נשארו לך'}
            </Typography>
            <Typography sx={{
              fontWeight: 900, fontSize: '2.6rem', lineHeight: 1.1,
              color: negative ? '#b91c1c' : '#15803d',
            }}>
              {fmt(data.available)}
            </Typography>
            <Typography variant="body2" color="text.secondary">ימים</Typography>
          </Paper>

          {negative && (
            <Alert severity="warning">
              קיבלת תשלום עבור <b>{fmt(Math.abs(data.available))}</b> ימי חופשה שטרם נצברו.
              הימים האלה יקוזזו בגמר חשבון. הפירוט למטה מראה באיזה חודש זה קרה.
            </Alert>
          )}

          {/* The arithmetic, so the number can be checked rather than believed. */}
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>איך חושב</Typography>
            <Stack spacing={0.75}>
              <Row label={`יתרה נכון לסוף ${data.as_of_month}`} value={`${fmt(data.opening_days)} ימים`} />
              <Row label="נצבר מאז" value={`${fmt(data.accrued - data.opening_days)} ימים`} />
              {data.monthly_accrual > 0 && (
                <Row label="קצב צבירה" value={`${fmt(data.monthly_accrual)} ימים לחודש`} muted />
              )}
              <Divider sx={{ my: 0.5 }} />
              <Row label="סה״כ נצבר" value={`${fmt(data.accrued)} ימים`} bold />
              <Row label="נוצל" value={`${fmt(data.used)} ימים`} />
              <Divider sx={{ my: 0.5 }} />
              <Row label="נשאר" value={`${fmt(data.available)} ימים`} bold
                color={negative ? '#b91c1c' : '#15803d'} />
            </Stack>
          </Paper>

          {data.taken?.length > 0 && (
            <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 800, p: 1.5, pb: 1 }}>
                חופשות שנוצלו
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>חודש</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>ימים</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.taken.map((t) => (
                      <TableRow key={t.month}>
                        <TableCell>{t.month}</TableCell>
                        <TableCell>{fmt(t.days)}</TableCell>
                        <TableCell>
                          {t.overdraft > 0 && (
                            <Chip size="small" color="error" variant="outlined"
                              label={`${fmt(t.overdraft)} מעבר ליתרה`} />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )}

          <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
            {data.pays_beyond_balance
              ? 'השכר שלך הוא שכר תקן חודשי, ולכן ימי חופשה משולמים במלואם גם כשהיתרה לא מכסה אותם — והיתרה נכנסת למינוס. המינוס מקוזז בגמר חשבון.'
              : 'ימי חופשה משולמים עד גובה היתרה שלך. אם תיקחי יותר ימים מהיתרה, הימים הנוספים לא ישולמו — אבל גם לא ייווצר חוב.'}
          </Alert>

          <Typography variant="caption" color="text.secondary">
            משהו לא מסתדר? פנו למשרד דרך "פניות למשרד" ונבדוק.
          </Typography>
        </Stack>
      )}
    </Box>
  );
}

function Row({ label, value, bold, muted, color }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline">
      <Typography variant="body2" color={muted ? 'text.secondary' : 'text.primary'}>{label}</Typography>
      <Typography variant="body2"
        sx={{ fontWeight: bold ? 800 : 600, color: color || 'inherit' }}>{value}</Typography>
    </Stack>
  );
}
