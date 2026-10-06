import { useState, useEffect } from 'react';
import { Box, Card, CardContent, Typography, Stack, Divider, Chip, Alert } from '@mui/material';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';
import { formatCurrency } from '../../utils/hebrewYear';

export default function MySalaryPreview() {
  const { user } = useAuth();
  const [salary, setSalary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/payroll/my-salary-preview')
      .then(res => setSalary(res.data))
      .catch(() => setSalary(null))
      .finally(() => setLoading(false));
  }, []);

  // Every earning and deduction the server sends, in its order. Rendering the
  // list rather than three hand-picked fields is what makes the card add up:
  // the previous screen showed base + overtime + travel and then a total that
  // included meals, recreation and bonuses it never named.
  const lines = salary?.lines || [];
  const hasLines = lines.length > 0;

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 800, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <AccountBalanceIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>צפי השכר שלי</Typography>
      </Stack>

      <Card>
        <CardContent>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              שלום {user?.full_name}
            </Typography>
            {salary?.month && (
              <Chip size="small" label={salary.month.split('-').reverse().join('/')} />
            )}
          </Stack>

          {loading ? (
            <Typography color="text.secondary">טוען...</Typography>
          ) : hasLines ? (
            <Stack spacing={2}>
              {(salary.hours_total > 0 || salary.days_worked > 0) && (
                <Typography variant="caption" color="text.secondary">
                  {salary.days_worked} ימי עבודה · {salary.hours_total} שעות
                  {salary.branches?.length > 1 && ` · ${salary.branches.join(', ')}`}
                </Typography>
              )}

              {lines.map(line => (
                <Stack key={line.key} spacing={0.2}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography>{line.label}</Typography>
                    <Typography
                      sx={{ fontWeight: 700, color: line.amount < 0 ? 'error.main' : 'text.primary' }}
                    >
                      {formatCurrency(line.amount)}
                    </Typography>
                  </Stack>
                  {line.note && (
                    <Typography variant="caption" color="text.secondary">{line.note}</Typography>
                  )}
                  <Divider sx={{ pt: 1 }} />
                </Stack>
              ))}

              {/*
                Two different screens, and calling both of them "סה״כ צפי" is
                what made the old one frightening. A finished month is a
                statement. A month still being lived is a running total, and
                saying so is the whole fix: the settlement — the salary
                completion, the absence deduction it is paired with, the loan
                — happens at the end, and until then this is simply what has
                been earned so far.
              */}
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="h6" sx={{ fontWeight: 800 }}>
                  {salary.in_progress ? 'נצבר עד היום' : 'סה"כ צפי'}
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>
                  {formatCurrency(salary.total || 0)}
                </Typography>
              </Stack>

              <Typography variant="caption" color="text.secondary">
                {salary.in_progress
                  ? `זה מה שנצבר מתחילת החודש ועד היום, ${salary.salary_is_net ? 'נטו' : 'ברוטו'} לפני ניכויי מס וביטוח לאומי. החודש עוד לא נגמר — השלמת השכר וההתחשבנות הסופית מחושבות בסגירת החודש.`
                  : `צפי ${salary.salary_is_net ? 'נטו' : 'ברוטו'} לפני ניכויי מס וביטוח לאומי. הסכום עשוי להשתנות עד סגירת החודש.`}
              </Typography>

              {salary.in_progress && salary.pending_loan_deduction > 0 && (
                <Typography variant="caption" color="text.secondary">
                  בסגירת החודש ינוכו {formatCurrency(salary.pending_loan_deduction)} על חשבון ההלוואה.
                </Typography>
              )}

              {salary.loans_remaining > 0 && (
                <>
                  <Divider />
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'error.main' }}>
                    מעקב הלוואות
                  </Typography>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography>יתרת הלוואה</Typography>
                    <Typography sx={{ fontWeight: 700, color: 'error.main' }}>
                      {formatCurrency(salary.loans_remaining)}
                    </Typography>
                  </Stack>
                </>
              )}
            </Stack>
          ) : (
            <Alert severity="info" sx={{ mt: 1 }}>
              {salary?.message || 'אין נתוני שכר זמינים כרגע. פנו למנהלת.'}
            </Alert>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
