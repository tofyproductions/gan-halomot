import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, Alert, Button, CircularProgress,
} from '@mui/material';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import RefreshIcon from '@mui/icons-material/Refresh';
import api from '../../api/client';

/**
 * מי אין לו/ה יתרת חופשה רשומה — הרשימה שאמורה להתרוקן.
 *
 * An employee with no opening balance is not an employee with no leave: she is
 * one whose leave nobody here can count. The system deliberately does not cap
 * her days against a balance it does not have (server/src/services/
 * vacationBalance.js says why), so her חופשה is filed and paid in full,
 * unchecked, every month. Nothing on screen used to say so — the payroll card
 * rendered "2 ימים" for her exactly as it did for someone whose balance
 * covered them. In 09.2026 that was ₪8,450 across nine people, found only by
 * reading a payslip.
 *
 * So this panel exists to be emptied, not to be browsed: every row on it is
 * leave being paid on a number nobody has.
 */
export default function VacationMissingBalancePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/payroll-month/vacation-missing-balance')
      .then(res => setData(res.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const rows = data?.rows || [];

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <BeachAccessIcon fontSize="small" color="warning" />
        <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
          יתרות חופשה חסרות
        </Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
          רענן
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        עובדות שאין להן יתרת פתיחה רשומה — ימי החופשה שלהן נשלחים לתשלום בלי
        בדיקת יתרה. היתרה והצבירה החודשית מיובאות מדוח ההעדרויות של הנהלת החשבונות.
      </Typography>

      {loading && <Stack alignItems="center" sx={{ py: 3 }}><CircularProgress size={28} /></Stack>}

      {!loading && !data && (
        <Alert severity="error">שגיאה בטעינת הנתונים.</Alert>
      )}

      {!loading && data && rows.length === 0 && (
        <Alert severity="success">לכל העובדות הפעילות יש יתרת פתיחה וצבירה חודשית רשומות.</Alert>
      )}

      {!loading && data && rows.length > 0 && (
        <>
          <Alert severity="warning" sx={{ mb: 2 }}>
            <b>{data.opening_missing}</b> ללא יתרת פתיחה — החופשה שלהן משולמת ללא בדיקה.
            {data.accrual_missing > 0 && <> <b>{data.accrual_missing}</b> ללא צבירה חודשית — היתרה שלהן קפואה ולא מתעדכנת.</>}
          </Alert>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>שם</TableCell>
                <TableCell>מס׳</TableCell>
                <TableCell>סוג</TableCell>
                <TableCell>יתרת פתיחה</TableCell>
                <TableCell>צבירה חודשית</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.employee_id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{r.full_name}</TableCell>
                  <TableCell>{r.employee_number || '—'}</TableCell>
                  <TableCell>{r.salary_type === 'global' ? 'תקן' : 'שעתי'}</TableCell>
                  <TableCell>
                    {r.opening_missing
                      ? <Chip size="small" color="error" label="לא רשומה" />
                      : <Box component="span">{r.opening_days} ימים · {r.opening_as_of_month}</Box>}
                  </TableCell>
                  <TableCell>
                    {r.accrual_missing
                      ? <Chip size="small" color="warning" label="לא רשומה" />
                      : <Box component="span">{r.monthly_accrual} ימים בחודש</Box>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Paper>
  );
}
