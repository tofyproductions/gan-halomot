import { useState, useEffect } from 'react';
import { Box, Card, CardContent, Typography, Stack, Divider } from '@mui/material';
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

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 800, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <AccountBalanceIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>צפי השכר שלי</Typography>
      </Stack>

      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
            שלום {user?.full_name}
          </Typography>

          {loading ? (
            <Typography color="text.secondary">טוען...</Typography>
          ) : salary ? (
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between">
                <Typography>שכר בסיס</Typography>
                <Typography sx={{ fontWeight: 700 }}>{formatCurrency(salary.base_salary || 0)}</Typography>
              </Stack>
              <Divider />
              <Stack direction="row" justifyContent="space-between">
                <Typography>שעות נוספות</Typography>
                <Typography sx={{ fontWeight: 700 }}>{formatCurrency(salary.overtime || 0)}</Typography>
              </Stack>
              <Divider />
              <Stack direction="row" justifyContent="space-between">
                <Typography>נסיעות</Typography>
                <Typography sx={{ fontWeight: 700 }}>{formatCurrency(salary.travel || 0)}</Typography>
              </Stack>
              <Divider />
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="h6" sx={{ fontWeight: 800 }}>סה"כ צפי</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: 'success.main' }}>
                  {formatCurrency(salary.total || 0)}
                </Typography>
              </Stack>

              {salary.loans > 0 && (
                <>
                  <Divider />
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'error.main' }}>
                    מעקב הלוואות
                  </Typography>
                  <Stack direction="row" justifyContent="space-between">
                    <Typography>יתרת הלוואה</Typography>
                    <Typography sx={{ fontWeight: 700, color: 'error.main' }}>{formatCurrency(salary.loans)}</Typography>
                  </Stack>
                </>
              )}
            </Stack>
          ) : (
            <Typography color="text.secondary">
              אין נתוני שכר זמינים כרגע. פנו למנהלת.
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
