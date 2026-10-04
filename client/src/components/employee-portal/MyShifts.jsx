import { useEffect, useMemo, useState } from 'react';
import { Box, Stack, Typography, Alert, ToggleButtonGroup, ToggleButton, LinearProgress, Tabs, Tab } from '@mui/material';
import MyConstraints from './MyConstraints';
import api from '../../api/client';
import ShiftGrid from '../shifts/ShiftGrid';
import { buildRows, buildAwayRow, switchedSet, fmtDate } from '../shifts/shiftRows';

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
    const base = data?.entries ? buildRows({ entries: data.entries, classrooms }) : [];
    // Her own shifts in other branches — read-only, as in her home rota.
    return data?.away?.length ? [...base, buildAwayRow(data.away)] : base;
  }, [data, classrooms]);
  const switched = useMemo(() => switchedSet(data?.entries || []), [data]);

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
          {data?.published && (
            <Stack spacing={1}>
              <Typography color="text.secondary">{data.branch_name} · המשמרות שלך מודגשות</Typography>
              <ShiftGrid dates={data.dates} rows={rows} closedDates={new Set()} switched={switched} editable={false}
                onCellClick={() => {}} onEntryClick={() => {}} highlightEmployeeId={data.me} />
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}
