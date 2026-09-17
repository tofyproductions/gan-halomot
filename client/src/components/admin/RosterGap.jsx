import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, Card, CardContent, Stack, Chip, TextField, MenuItem,
  Table, TableHead, TableRow, TableCell, TableBody, CircularProgress,
  Alert, AlertTitle, Tooltip, IconButton,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';

/**
 * פערי רישום — who the gan says is here, against who has a card.
 *
 * Every branch keeps its real roster somewhere other than the children screen:
 * קפלן in רישום, the other three in רישום חיצוני because they enrol through
 * קליקטאק. The child card is downstream of both and it drifts — stamped with a
 * year once and never revisited — so a year later the roster has moved on
 * without it.
 *
 * On the day this was built קפלן had thirty-one registrations for the current
 * year, four children with no card at all (two of them already enrolled), and
 * three cards nobody had registered. Nothing surfaced any of it; the numbers
 * simply looked a bit low on every screen downstream.
 *
 * Read-only, deliberately. Every row here has more than one honest answer — a
 * child with no card may be a card nobody made or a child who never came — and
 * only somebody at the gan knows which. This shows the disagreement and the
 * evidence for it; it does not resolve it.
 */

const KIND_STYLE = {
  no_card: { color: 'error', order: 0 },
  duplicate_card: { color: 'error', order: 1 },
  stale_year: { color: 'warning', order: 2 },
  orphan_card: { color: 'default', order: 3 },
};

export default function RosterGap() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

  const load = useCallback(async (y) => {
    setLoading(true);
    try {
      const res = await api.get('/roster-gap', { params: y ? { year: y } : {} });
      setData(res.data);
      setYear(res.data.year);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בטעינת פערי הרישום'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const branches = useMemo(() => {
    if (!data) return [];
    return branchFilter
      ? data.branches.filter(b => b.branch_id === branchFilter)
      : data.branches;
  }, [data, branchFilter]);

  const totalFindings = useMemo(
    () => (data?.branches || []).reduce((n, b) => n + b.findings.length, 0),
    [data],
  );

  /** The whole list as text, for pasting into a message to whoever fixes it. */
  const copyBranch = (b) => {
    const lines = b.findings.map(f =>
      `${data.kinds[f.kind]}: ${f.name}${f.card_year ? ` (כרטיס ${f.card_year})` : ''}`
      + (f.maybe?.length ? ` — אולי: ${f.maybe.map(m => m.name).join(', ')}` : ''));
    navigator.clipboard.writeText(`${b.branch_name} — ${data.year}\n${lines.join('\n')}`);
    toast.success('הועתק');
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>;
  }
  if (!data) return null;

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>פערי רישום</Typography>
          <Typography variant="body2" color="text.secondary">
            מי רשום בגן מול מי שיש לו כרטיס ילד. לכל סניף מקור רישום משלו.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField select size="small" label="שנה" value={year}
            onChange={e => { setYear(e.target.value); load(e.target.value); }} sx={{ minWidth: 130 }}>
            {(data.years || []).map(y => <MenuItem key={y.range} value={y.range}>{y.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="סניף" value={branchFilter}
            onChange={e => setBranchFilter(e.target.value)} sx={{ minWidth: 170 }}>
            <MenuItem value="">כל הסניפים</MenuItem>
            {data.branches.map(b => <MenuItem key={b.branch_id} value={b.branch_id}>{b.branch_name}</MenuItem>)}
          </TextField>
          <Tooltip title="רענון"><IconButton onClick={() => load(year)}><RefreshIcon /></IconButton></Tooltip>
        </Stack>
      </Stack>

      {totalFindings === 0 && (
        <Alert severity="success" sx={{ mb: 2 }}>
          <AlertTitle>אין פערים</AlertTitle>
          כל מי שרשום לשנה הזו מופיע גם ככרטיס ילד, ולהפך.
        </Alert>
      )}

      {branches.map(b => (
        <Card key={b.branch_id} sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{b.branch_name}</Typography>
                {/* Which list this branch was compared against. Shown rather
                    than assumed: reading the wrong screen would make every row
                    below wrong, and it must be visible without asking. */}
                <Chip size="small" variant="outlined" label={`מקור: ${data.sources[b.source]}`} />
                <Chip size="small" label={`${b.roster_count} רשומים`} />
                <Chip size="small" color="success" variant="outlined" label={`${b.matched} תואמים`} />
                {Object.entries(b.counts).map(([kind, n]) => (
                  <Chip key={kind} size="small" color={KIND_STYLE[kind]?.color || 'default'}
                    label={`${data.kinds[kind]}: ${n}`} />
                ))}
              </Stack>
              {b.findings.length > 0 && (
                <Tooltip title="העתקת הרשימה כטקסט">
                  <IconButton size="small" onClick={() => copyBranch(b)}><ContentCopyIcon fontSize="small" /></IconButton>
                </Tooltip>
              )}
            </Stack>

            {b.duplicates.length > 0 && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                רישום כפול לאותו שם: {b.duplicates.map(d => `${d.name} (${d.count})`).join(' · ')}
              </Alert>
            )}

            {b.findings.length === 0 ? (
              <Typography variant="body2" color="text.secondary">אין פערים בסניף זה.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>מה הפער</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>שם</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>ברשימת הרישום</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>בכרטיס הילד</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...b.findings]
                    .sort((x, y2) => (KIND_STYLE[x.kind]?.order ?? 9) - (KIND_STYLE[y2.kind]?.order ?? 9))
                    .map((f, i) => (
                      <TableRow key={`${f.kind}-${f.roster_id || f.card_id}-${i}`} hover>
                        <TableCell>
                          <Chip size="small" color={KIND_STYLE[f.kind]?.color || 'default'}
                            variant={f.kind === 'orphan_card' ? 'outlined' : 'filled'}
                            label={data.kinds[f.kind]} />
                        </TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>
                          {f.name}
                          {/* A near-identical name in the other column. Offered,
                              never acted on: two children really can be called
                              אורי. */}
                          {f.maybe?.length > 0 && (
                            <Typography variant="caption" sx={{ display: 'block', color: 'info.main' }}>
                              אולי אותו ילד: {f.maybe.map(mm => mm.name).join(', ')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          {f.roster_id ? (
                            <>
                              {f.roster_classroom || '—'}
                              {f.roster_status && (
                                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                                  {f.roster_status === 'completed' ? 'רישום הושלם'
                                    : f.roster_status === 'link_generated' ? 'קישור נשלח, טרם הושלם'
                                      : f.roster_status}
                                </Typography>
                              )}
                            </>
                          ) : <Typography variant="caption" color="text.disabled">אינו ברשימה</Typography>}
                        </TableCell>
                        <TableCell>
                          {f.kind === 'no_card' ? (
                            <Typography variant="caption" color="text.disabled">אין כרטיס</Typography>
                          ) : f.kind === 'duplicate_card' ? (
                            <Typography variant="caption" color="error.main">
                              {f.ambiguous.length} כרטיסים: {f.ambiguous.map(a => a.classroom || '—').join(', ')}
                            </Typography>
                          ) : (
                            <>
                              {f.card_classroom || '—'}
                              <Typography variant="caption" sx={{ display: 'block', color: f.card_year && f.card_year !== data.year ? 'warning.main' : 'text.secondary' }}>
                                שנת הכרטיס: {f.card_year || '—'}
                              </Typography>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ))}
    </Box>
  );
}
