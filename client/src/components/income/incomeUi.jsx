import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Paper, Typography, Alert, Button, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
  Stack, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import api, { apiError } from '../../api/client';
import { formatILS, formatDay } from '../bank/bankFormat';

export { formatILS, formatDay };

/**
 * Shared pieces of the income screen (spec §4): month names, the Kaplan
 * default split (mirrors the server's splitInto), one loader with a sequence
 * guard, and a table that turns into cards on a phone. Tabs compose these.
 */

const MONTH_NAMES = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר', 'קייטנה'];
export const CAMP_MONTH = 13;
const ACADEMIC_ORDER = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, CAMP_MONTH];

/** 9 → "ספטמבר", 13 → "קייטנה". */
export const monthName = (n) => MONTH_NAMES[Number(n)] || String(n ?? '—');

/** "2026-09" → "ספטמבר 2026". */
export const ymLabel = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${monthName(Number(m[2]))} ${m[1]}` : String(ym || '—');
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The gan year of a transfer by calendar month (server: academicYearOfDate). */
export function academicYearOfDate(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const start = Number(m[2]) >= 9 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** What is left of a transfer to give. */
export const remainingOf = (tx) => (tx.remaining != null ? Number(tx.remaining) : Number(tx.amount) || 0);

/** Open amount of a child's month: expected beyond what the bank was already allocated. */
export const openOf = (m) => round2((m.expected || 0) - (m.allocated || 0));

/** Every (child, month) of the family that still has something open, in gan-year order. */
export function openCells(household) {
  const cells = [];
  for (const c of household?.children || []) {
    for (const m of c.months || []) {
      if (openOf(m) > 0) cells.push({ registration_id: c.registration_id, child_name: c.child_name, month_number: m.month_number, open: openOf(m) });
    }
  }
  return cells.sort((a, b) => ACADEMIC_ORDER.indexOf(a.month_number) - ACADEMIC_ORDER.indexOf(b.month_number));
}

/** Default split: earliest open months across the family's children until the amount is used (server's splitInto). */
export function defaultSplit(household, amount) {
  let left = round2(amount);
  const out = [];
  for (const c of openCells(household)) {
    if (left <= 0) break;
    const take = round2(Math.min(c.open, left));
    left = round2(left - take);
    out.push({ registration_id: c.registration_id, child_name: c.child_name, month_number: c.month_number, amount: take });
  }
  return out;
}

export const sumOf = (rows, key = 'amount') => round2((rows || []).reduce((s, r) => s + (Number(r[key]) || 0), 0));

/** A transfer's payer as the bank shows it. */
export const payerText = (tx) => tx.counterparty || tx.description || '—';

/** One GET with its own loading / error state and a sequence guard (a late answer never overwrites a newer one). */
export function useLoad(url, params) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const seq = useRef(0);
  const key = JSON.stringify(params || {});
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const { data } = await api.get(url, { params: JSON.parse(key) });
      if (my === seq.current) setState({ loading: false, error: '', data });
    } catch (err) {
      if (my === seq.current) setState({ loading: false, error: apiError(err, 'הטעינה נכשלה'), data: null });
    }
  }, [url, key]);
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

/** Loading / failed / content. A failure is never shown as an empty list. */
export function LoadGate({ state, reload, children }) {
  if (state.error) {
    return <Alert severity="error" action={<Button color="inherit" size="small" onClick={reload}>נסו שוב</Button>}>{state.error}</Alert>;
  }
  if (state.loading && state.data == null) return <Typography color="text.secondary">טוען…</Typography>;
  return children;
}

export function Section({ title, count, hint, children, sx }) {
  return (
    <Box sx={{ mt: 3, ...sx }}>
      <Typography variant="h6" sx={{ fontSize: '1.05rem', mb: hint ? 0.25 : 1 }}>
        {title}{count != null ? ` (${count})` : ''}
      </Typography>
      {hint && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>{hint}</Typography>}
      {children}
    </Box>
  );
}

/**
 * A table on a wide screen, a card per row on a phone.
 * columns: [{ key, label, render?(row), num?: bool }]
 */
export function ResponsiveTable({ columns, rows, rowKey, footer, rowSx, cardTitle }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down('md'));
  const cell = (c, r) => (c.render ? c.render(r) : (c.num ? formatILS(r[c.key]) : (r[c.key] ?? '—')));
  if (phone) {
    const all = footer ? [...rows, { ...footer, __footer: true }] : rows;
    return (
      <Stack spacing={1}>
        {all.map((r, i) => (
          <Paper key={r.__footer ? '__footer' : rowKey(r, i)} variant="outlined" sx={{ p: 1.25, ...(r.__footer ? { bgcolor: 'action.hover' } : (rowSx ? rowSx(r) : {})) }}>
            {cardTitle && <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{r.__footer ? 'סה״כ' : cardTitle(r)}</Typography>}
            {columns.filter(c => !(cardTitle && c.title)).map(c => (
              <Stack key={c.key} direction="row" justifyContent="space-between" spacing={1}>
                <Typography variant="caption" color="text.secondary">{c.label}</Typography>
                <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', textAlign: 'end' }}>{cell(c, r)}</Typography>
              </Stack>
            ))}
          </Paper>
        ))}
      </Stack>
    );
  }
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>{columns.map(c => <TableCell key={c.key} align={c.num ? 'left' : 'right'} sx={{ fontWeight: 700 }}>{c.label}</TableCell>)}</TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={rowKey(r, i)} sx={rowSx ? rowSx(r) : undefined}>
              {columns.map(c => <TableCell key={c.key} align={c.num ? 'left' : 'right'} sx={{ fontVariantNumeric: 'tabular-nums' }}>{cell(c, r)}</TableCell>)}
            </TableRow>
          ))}
          {footer && (
            <TableRow sx={{ bgcolor: 'action.hover' }}>
              {columns.map((c, i) => (
                <TableCell key={c.key} align={c.num ? 'left' : 'right'} sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {i === 0 && !c.num ? 'סה״כ' : cell(c, footer)}
                </TableCell>
              ))}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
