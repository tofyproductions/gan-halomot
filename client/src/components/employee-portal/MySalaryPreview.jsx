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

              <Stack direction="row" justifyContent="space-between">
                <Typography variant="h6" sx={{ fontWeight: 800 }}>סה"כ צפי</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>
                  {formatCurrency(salary.total || 0)}
                </Typography>
              </Stack>

              <Typography variant="caption" color="text.secondary">
                צפי {salary.salary_is_net ? 'נטו' : 'ברוטו'} לפני ניכויי מס וביטוח לאומי. הסכום עשוי
                להשתנות עד סגירת החודש.
              </Typography>

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
