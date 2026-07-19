import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Button, Chip, Table, TableHead, TableBody,
  TableRow, TableCell, IconButton, Tooltip, CircularProgress, Alert, LinearProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CelebrationIcon from '@mui/icons-material/Celebration';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useConfirm } from '../shared/ConfirmProvider';
import EventEditor from './EventEditor';
import EventDetail from './EventDetail';

const fmtDate = (d) => (d ? (() => { try { return new Date(d + 'T00:00:00').toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }); } catch { return d; } })() : '—');

function StatusChip({ status }) {
  if (status === 'published') return <Chip size="small" color="success" label="מפורסם" />;
  if (status === 'closed') return <Chip size="small" label="סגור" />;
  return <Chip size="small" color="warning" label="טיוטה" />;
}

export default function EventsPage() {
  const { selectedBranch, branches } = useBranch();
  const confirm = useConfirm();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [detailGroup, setDetailGroup] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/gan-events')
      .then((res) => setEvents(res.data.events || []))
      .catch((e) => toast.error(e.response?.data?.error || 'שגיאה'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, selectedBranch]);

  const delGroup = async (ev) => {
    if (!(await confirm({ title: 'מחיקת אירוע', message: `למחוק את "${ev.name}" מכל הסניפים? כל השריונים יימחקו.` }))) return;
    try { await api.delete(`/gan-events/group/${ev.group_id}`); toast.success('נמחק'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'שגיאה'); }
  };

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CelebrationIcon color="primary" />
          <Typography variant="h5" fontWeight={700}>אירועים בגן</Typography>
        </Stack>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditorOpen(true)}>אירוע חדש</Button>
      </Stack>

      <Paper sx={{ borderRadius: 3, overflow: 'hidden' }}>
        {loading ? (
          <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>
        ) : events.length === 0 ? (
          <Alert severity="info" sx={{ m: 2 }}>אין עדיין אירועים. צור אירוע חדש כדי לפתוח רשימת התחייבויות להורים.</Alert>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>שם האירוע</TableCell>
                <TableCell align="center">תאריך</TableCell>
                <TableCell>סניפים</TableCell>
                <TableCell align="center">סטטוס</TableCell>
                <TableCell align="center" sx={{ minWidth: 140 }}>שוריינו</TableCell>
                <TableCell align="center">פעולות</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((ev) => {
                const pct = ev.total_items ? Math.round((ev.taken_items / ev.total_items) * 100) : 0;
                return (
                  <TableRow key={ev.group_id} hover sx={{ cursor: 'pointer' }} onClick={() => setDetailGroup(ev.group_id)}>
                    <TableCell sx={{ fontWeight: 600 }}>{ev.name}</TableCell>
                    <TableCell align="center">{fmtDate(ev.event_date)}{ev.event_time ? ` ${ev.event_time}` : ''}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {ev.branches.map((b) => <Chip key={b.id} size="small" variant="outlined" label={b.branch_name} />)}
                      </Stack>
                    </TableCell>
                    <TableCell align="center"><StatusChip status={ev.status} /></TableCell>
                    <TableCell align="center">
                      <Stack spacing={0.5} sx={{ minWidth: 120, mx: 'auto' }}>
                        <Typography variant="caption">{ev.taken_items}/{ev.total_items}</Typography>
                        <LinearProgress variant="determinate" value={pct} sx={{ height: 6, borderRadius: 3 }} />
                      </Stack>
                    </TableCell>
                    <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="צפייה"><IconButton size="small" onClick={() => setDetailGroup(ev.group_id)}><VisibilityIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="מחק"><IconButton size="small" color="error" onClick={() => delGroup(ev)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      <EventEditor
        open={editorOpen}
        mode="create"
        branches={branches}
        defaultBranchId={selectedBranch}
        onClose={() => setEditorOpen(false)}
        onSaved={(saved) => { load(); if (saved?.group_id) setDetailGroup(saved.group_id); }}
      />
      <EventDetail
        open={!!detailGroup}
        groupId={detailGroup}
        branches={branches}
        onClose={() => setDetailGroup(null)}
        onChanged={load}
      />
    </Box>
  );
}
