import { useEffect, useMemo, useState } from 'react';
import {
  Box, Paper, Typography, Stack, TextField, MenuItem, Chip, Table, TableHead,
  TableBody, TableRow, TableCell, LinearProgress, Alert, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import api from '../../api/client';

const AREAS = [
  { value: '', label: 'כל האזורים' },
  { value: 'payroll', label: 'שכר ונוכחות' },
  { value: 'registration', label: 'רישום' },
  { value: 'collections', label: 'גבייה' },
  { value: 'children', label: 'ילדים' },
  { value: 'employees', label: 'עובדים' },
  { value: 'documents', label: 'מסמכים' },
  { value: 'contracts', label: 'חוזים' },
  { value: 'classes', label: 'חוגים' },
];

/**
 * Who opened what — the sensitive-area access log, for the admin's eyes.
 * Reads are the point: the 09.10.2026 review could prove what was WRITTEN
 * and only guess what was READ. Red rows are refusals (403) — someone
 * asking for what is not theirs is exactly the thing to notice.
 */
export default function AuditTrailPage() {
  const [days, setDays] = useState(7);
  const [area, setArea] = useState('');
  const [q, setQ] = useState('');
  const [only403, setOnly403] = useState(false);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get('/admin/audit-trail', { params: { days, area: area || undefined, q: q || undefined, status: only403 ? '403' : undefined } })
      .then(r => setRows(r.data.rows || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [days, area, q, only403]);

  const refused = useMemo(() => (rows || []).filter(r => r.status === 403).length, [rows]);
  const fmt = (d) => new Date(d).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  return (
    <Box dir="rtl">
      <Typography variant="h5" fontWeight={700} sx={{ mb: 0.5 }}>יומן ביקורת</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        כל גישה למסכים הרגישים — כולל צפייה בלבד. נשמר 180 יום. שורות אדומות = ניסיונות שנחסמו.
      </Typography>

      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup exclusive size="small" value={days} onChange={(_, v) => v && setDays(v)}>
            <ToggleButton value={1}>יום</ToggleButton>
            <ToggleButton value={7}>שבוע</ToggleButton>
            <ToggleButton value={30}>חודש</ToggleButton>
            <ToggleButton value={180}>הכל</ToggleButton>
          </ToggleButtonGroup>
          <TextField select size="small" label="אזור" value={area} onChange={e => setArea(e.target.value)} sx={{ minWidth: 150 }}>
            {AREAS.map(a => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}
          </TextField>
          <TextField size="small" label="חיפוש בנתיב" value={q} onChange={e => setQ(e.target.value)} />
          <Chip
            label={`נחסמו: ${refused}`}
            color={refused ? 'error' : 'default'}
            variant={only403 ? 'filled' : 'outlined'}
            clickable onClick={() => setOnly403(v => !v)}
          />
        </Stack>
      </Paper>

      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {rows && rows.length === 0 && !loading && <Alert severity="info">אין רשומות בטווח שנבחר.</Alert>}
      {rows && rows.length > 0 && (
        <Paper sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 700 }}>
            <TableHead><TableRow>
              <TableCell>מתי</TableCell>
              <TableCell>מי</TableCell>
              <TableCell>תפקיד</TableCell>
              <TableCell>אזור</TableCell>
              <TableCell>פעולה</TableCell>
              <TableCell>נתיב</TableCell>
              <TableCell align="center">תוצאה</TableCell>
            </TableRow></TableHead>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r._id} sx={r.status === 403 ? { bgcolor: '#fee2e2' } : undefined}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</TableCell>
                  <TableCell>{r.user_name}</TableCell>
                  <TableCell>{r.role}</TableCell>
                  <TableCell>{AREAS.find(a => a.value === r.area)?.label || r.area}</TableCell>
                  <TableCell>{r.method}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', direction: 'ltr' }}>{r.path}</TableCell>
                  <TableCell align="center">
                    <Chip size="small" label={r.status}
                      color={r.status === 403 ? 'error' : r.status >= 400 ? 'warning' : 'default'}
                      variant="outlined" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {rows && rows.length === 500 && (
        <Typography variant="caption" color="text.secondary">מוצגות 500 הרשומות האחרונות — צמצם את הסינון לראות יותר אחורה.</Typography>
      )}
    </Box>
  );
}
