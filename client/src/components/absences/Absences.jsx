import { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Chip, Alert, TextField,
  ToggleButton, ToggleButtonGroup, CircularProgress, Table, TableBody,
  TableCell, TableHead, TableRow, MenuItem, Select, FormControl, InputLabel,
} from '@mui/material';
import api from '../../api/client';

/**
 * היעדרויות — the morning list, and the month behind it.
 *
 * Read-only on purpose. The parent reports from the portal and the staff
 * record attendance on the nursery board; a third place to write the same fact
 * is how the three stop agreeing. What this screen adds is the comparison.
 *
 * THE TWO COLUMNS ARE THE POINT. "דווח" is what the family said in advance;
 * "בלוח" is what the room observed. A child reported away who was marked
 * present is the row worth looking at — somebody changed their mind and did
 * not say, and lunch was counted for a child who is here.
 */

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function errText(e, fallback) {
  return e?.response?.data?.error || fallback;
}

/** What the daily board says, in the board's own words. */
function BoardChip({ value }) {
  if (value === 'הגיע') {
    return <Chip size="small" label="הגיע/ה בפועל" color="warning" sx={{ fontWeight: 700 }} />;
  }
  if (value === 'חסר') {
    return <Chip size="small" label="סומן/ה חסר/ה" color="success" variant="outlined" />;
  }
  return <Typography variant="caption" color="text.disabled">טרם סומן</Typography>;
}

function DayView({ date, setDate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [room, setRoom] = useState('all');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.get('/absences', { params: { date, classroom: room } });
      setData(r.data);
    } catch (e) {
      setError(errText(e, 'לא הצלחנו לטעון את הרשימה'));
    } finally { setLoading(false); }
  }, [date, room]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.absences || [];
  const surprises = rows.filter(a => a.board_says === 'הגיע').length;

  return (
    <>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          type="date" size="small" label="תאריך" value={date}
          onChange={(e) => setDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>כיתה</InputLabel>
          <Select value={room} label="כיתה" onChange={(e) => setRoom(e.target.value)}>
            <MenuItem value="all">כל הכיתות</MenuItem>
            {(data?.classrooms || []).map(c => (
              <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

      {!loading && rows.length === 0 && (
        <Alert severity="info">אף הורה לא דיווח על היעדרות בתאריך הזה.</Alert>
      )}

      {!loading && rows.length > 0 && (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
            <Chip label={`${rows.length} דיווחים`} color="primary" />
            {surprises > 0 && (
              <Chip
                color="warning"
                label={`${surprises} הגיעו בפועל למרות הדיווח`}
              />
            )}
          </Stack>

          <Card>
            <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>ילד/ה</TableCell>
                    <TableCell>כיתה</TableCell>
                    <TableCell>סיבה</TableCell>
                    <TableCell>דיווח/ה</TableCell>
                    <TableCell>בלוח היומי</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map(a => (
                    <TableRow key={a.id} hover>
                      <TableCell sx={{ fontWeight: 700 }}>{a.child_name}</TableCell>
                      <TableCell>{a.classroom}</TableCell>
                      <TableCell sx={{ color: a.reason ? 'text.primary' : 'text.disabled' }}>
                        {a.reason || '—'}
                      </TableCell>
                      <TableCell>{a.reported_by || '—'}</TableCell>
                      <TableCell><BoardChip value={a.board_says} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

/**
 * The month.
 *
 * Sorted by count, because the point is the tail: a child at fifteen days in a
 * term is a conversation somebody should be having, and nobody notices that
 * from a daily list.
 */
function ReportView() {
  const [from, setFrom] = useState(`${dayKey().slice(0, 7)}-01`);
  const [to, setTo] = useState(dayKey());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let dead = false;
    setLoading(true); setError('');
    api.get('/absences/report', { params: { from, to } })
      .then(r => { if (!dead) setData(r.data); })
      .catch(e => { if (!dead) setError(errText(e, 'לא הצלחנו לטעון את הדוח')); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [from, to]);

  const rows = data?.rows || [];

  return (
    <>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField type="date" size="small" label="מתאריך" value={from}
          onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField type="date" size="small" label="עד תאריך" value={to}
          onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}
      {!loading && rows.length === 0 && (
        <Alert severity="info">אין דיווחי היעדרות בטווח הזה.</Alert>
      )}

      {!loading && rows.length > 0 && (
        <Card>
          <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ילד/ה</TableCell>
                  <TableCell>כיתה</TableCell>
                  <TableCell align="left">ימי היעדרות</TableCell>
                  <TableCell>התאריכים</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.child_id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{r.child_name}</TableCell>
                    <TableCell>{r.classroom}</TableCell>
                    <TableCell align="left" sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                      {r.days}
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>
                      {r.dates.map(d => d.slice(8) + '.' + d.slice(5, 7)).join(', ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default function Absences() {
  const [view, setView] = useState('day');
  const [date, setDate] = useState(dayKey());

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Typography variant="h5" sx={{ flex: 1 }}>היעדרויות</Typography>
        <ToggleButtonGroup
          size="small" exclusive value={view}
          onChange={(_, v) => v && setView(v)}
        >
          <ToggleButton value="day">רשימת היום</ToggleButton>
          <ToggleButton value="report">דוח תקופה</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        הרשימה מציגה מה שההורים דיווחו מראש בפורטל. סימון הנוכחות בפועל נעשה בלוח התינוקייה,
        והדיווח לא משנה אותו ולא משנה את שכר הלימוד.
      </Alert>

      {view === 'day'
        ? <DayView date={date} setDate={setDate} />
        : <ReportView />}
    </Box>
  );
}
