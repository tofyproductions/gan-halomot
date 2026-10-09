import { useEffect, useMemo, useState } from 'react';
import { Box, Stack, Typography, Alert, ToggleButtonGroup, ToggleButton, LinearProgress, Tabs, Tab, Paper, Chip, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MyConstraints from './MyConstraints';
import api from '../../api/client';
import ShiftGrid from '../shifts/ShiftGrid';
import { buildRows, buildAwayRow, switchedSet, fmtDate, toMin, fmtMin, HEB_DAYS } from '../shifts/shiftRows';

const AREA_LABEL = { floater: 'צפה', unassigned: 'ללא כיתה' };

/**
 * HER week first, as cards — one per day, her shifts only, each naming its
 * hours, its room, and (for a worker lent between branches) its branch.
 * The whole-branch grid the screen used to open with is still here, under a
 * fold: it answers "מי עוד עובדת איתי", not "מתי אני" — and on a phone it is
 * a wall. A worker placed in two branches used to find her other branch as
 * one cramped row at the bottom of that wall.
 */
function MyWeekCards({ data, mine }) {
  const multiBranch = mine.some(e => !e.home);
  const totalMin = mine.reduce((t, e) => {
    const a = toMin(e.start_hhmm); const b = toMin(e.end_hhmm);
    return a != null && b != null && b > a ? t + (b - a) : t;
  }, 0);
  const roomOf = (e) => {
    if (!e.home) return e.classroom_name || AREA_LABEL[e.area] || '';
    if (e.area === 'class') return (data.classrooms || []).find(c => c._id === String(e.classroom_id))?.name || '';
    return AREA_LABEL[e.area] || '';
  };
  return (
    <Paper sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography fontWeight={800}>השבוע שלי</Typography>
        <Chip size="small" variant="outlined" sx={{ fontWeight: 700 }}
          label={`${mine.length} משמרות · ${fmtMin(totalMin)} שע׳`} />
        {multiBranch && <Chip size="small" color="info" variant="outlined" label="משובצת ביותר מסניף אחד" />}
      </Stack>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {data.dates.map((d, i) => {
          const day = mine.filter(e => e.date === d)
            .sort((a, b) => String(a.start_hhmm).localeCompare(String(b.start_hhmm)));
          return (
            <Box key={d} sx={{
              flex: '1 1 130px', minWidth: 130, borderRadius: 1.5, p: 1,
              border: '1px solid', borderColor: day.length ? 'primary.light' : 'divider',
              bgcolor: day.length ? 'background.paper' : 'action.hover',
            }}>
              <Typography sx={{ fontWeight: 700, fontSize: '0.8rem', mb: 0.5 }}>
                {HEB_DAYS[i]} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>{fmtDate(d)}</Box>
              </Typography>
              {day.length === 0 ? (
                <Typography variant="caption" color="text.secondary">אין משמרת</Typography>
              ) : (
                <Stack spacing={0.5}>
                  {day.map((e, k) => (
                    <Box key={k} sx={{
                      borderRadius: 1, px: 0.75, py: 0.5, fontSize: '0.75rem',
                      bgcolor: e.home ? 'primary.soft' : 'info.soft',
                      border: '1px solid', borderColor: e.home ? 'primary.light' : 'info.light',
                    }}>
                      <Box component="span" dir="ltr" sx={{ fontWeight: 700 }}>{e.start_hhmm}–{e.end_hhmm}</Box>
                      {roomOf(e) && <Box sx={{ lineHeight: 1.2 }}>{roomOf(e)}</Box>}
                      {(multiBranch || !e.home) && (
                        <Box sx={{ fontSize: '0.7rem', color: e.home ? 'text.secondary' : 'info.dark', fontWeight: e.home ? 400 : 700 }}>
                          {e.branch_name}
                        </Box>
                      )}
                    </Box>
                  ))}
                </Stack>
              )}
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}

function sunday(offsetWeeks) {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + offsetWeeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The published rota of her branch — this week and next — with her own hours marked. */
export default function MyShifts() {
  const initial = new URLSearchParams(window.location.search).get('week') || sunday(0);
  const [week, setWeek] = useState(initial);
  const [tab, setTab] = useState(new URLSearchParams(window.location.search).get('tab') === 'constraints' ? 'constraints' : 'rota');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get('/shifts/my', { params: { week } }).then(r => setData(r.data)).catch(() => setData({ error: true })).finally(() => setLoading(false));
  }, [week]);

  const classrooms = useMemo(() => {
    if (!data?.entries) return [];
    const used = new Set(data.entries.filter(e => e.area === 'class').map(e => String(e.classroom_id)));
    return (data.classrooms || []).filter(c => used.has(c._id));
  }, [data]);
  const rows = useMemo(() => {
    const base = data?.published && data?.entries ? buildRows({ entries: data.entries, classrooms }) : [];
    // Her own shifts in other branches — read-only, as in her home rota.
    return data?.away?.length ? [...base, buildAwayRow(data.away)] : base;
  }, [data, classrooms]);
  const switched = useMemo(() => switchedSet(data?.entries || []), [data]);
  // Her own shifts, home and away, for the personal cards.
  const mine = useMemo(() => {
    if (!data) return [];
    const home = (data.entries || []).filter(e => String(e.employee_id) === String(data.me))
      .map(e => ({ ...e, branch_name: data.branch_name, home: true }));
    const away = (data.away || []).map(e => ({ ...e, home: false }));
    return [...home, ...away];
  }, [data]);

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>המשמרות שלי</Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="rota" label="הסידור" />
        <Tab value="constraints" label="האילוצים שלי" />
      </Tabs>
      {tab === 'constraints' ? <MyConstraints /> : (
        <>
          <ToggleButtonGroup exclusive size="small" value={week} onChange={(_, v) => v && setWeek(v)} sx={{ mb: 2 }}>
            <ToggleButton value={sunday(0)}>השבוע</ToggleButton>
            <ToggleButton value={sunday(1)}>שבוע הבא</ToggleButton>
          </ToggleButtonGroup>
          {loading && <LinearProgress />}
          {data?.reason === 'no_employee' && <Alert severity="warning">לא נמצא כרטיס עובדת מקושר למשתמש שלך. פני למשרד.</Alert>}
          {data?.error && <Alert severity="error">לא הצלחנו לטעון את הסידור</Alert>}
          {data && data.published === false && <Alert severity="info">הסידור לשבוע {fmtDate(week)} עוד לא פורסם.</Alert>}
          {data && (data.published || (data.away && data.away.length)) && (
            <Stack spacing={1.5}>
              <MyWeekCards data={data} mine={mine} />
              <Accordion disableGutters>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography color="text.secondary">הסידור המלא — {data.branch_name} · המשמרות שלך מודגשות</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <ShiftGrid dates={data.dates} rows={rows} closedDates={new Set()} switched={switched} editable={false}
                    onCellClick={() => {}} onEntryClick={() => {}} highlightEmployeeId={data.me} />
                </AccordionDetails>
              </Accordion>
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}
