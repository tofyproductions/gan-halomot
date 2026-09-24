import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  TextField, MenuItem, Typography, Box, Chip, CircularProgress, Alert,
  FormControlLabel, Checkbox, Link,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { printGanttMulti } from './ganttPrint';

const MONTH_NAMES = {
  9: 'ספטמבר', 10: 'אוקטובר', 11: 'נובמבר', 12: 'דצמבר',
  1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 4: 'אפריל',
  5: 'מאי', 6: 'יוני', 7: 'יולי', 8: 'אוגוסט',
};
const ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8];

const STATUS_LABEL = { approved: 'מאושר', pending: 'ממתין', draft: 'טיוטה', missing: 'טרם הוזן' };
const STATUS_CHIP = { approved: 'success', pending: 'warning', draft: 'default', missing: 'default' };

const idOf = (x) => String(x?._id || x?.id || x || '');

/**
 * One month's plan for every room, as one document.
 *
 * The office pins up — or files — the same month for every room in the gan,
 * and the only way to get there was to open each room, print it, and go back
 * for the next. Here the month is picked once, the rooms are ticked, and
 * everything comes out as one print job: one PDF, a page per room.
 *
 * The approved rooms are ticked to begin with, because an approved plan is
 * the one that is meant to leave the building. A room with no plan for the
 * month cannot be ticked at all — there is nothing to print, and fetching it
 * would only hand back an empty template.
 */
export default function GanttMultiPrintDialog({ open, onClose, y1, yearRange }) {
  const { branches, selectedBranch } = useBranch();
  const y2 = y1 + 1;
  const yearOf = (m) => (m >= 9 ? y1 : y2);

  const initialMonth = () => {
    const now = new Date();
    const m = now.getMonth() + 1;
    return now.getFullYear() === yearOf(m) ? m : 9;
  };

  const [month, setMonth] = useState(initialMonth);
  const [classrooms, setClassrooms] = useState([]);
  const [archive, setArchive] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const allBranches = selectedBranch === 'all';

  // The archive holds every saved month of every room, so it is read once
  // per opening and the month picker only re-reads it.
  useEffect(() => {
    if (!open) return;
    setMonth(initialMonth());
    setLoading(true);
    const archiveParams = selectedBranch && !allBranches ? { branch: selectedBranch } : {};
    Promise.all([
      api.get('/gantt/archive', { params: archiveParams }).then(r => r.data.archive || []),
      api.get('/classrooms', { params: { year: yearRange } }).then((r) => {
        const cls = r.data.classrooms || [];
        return cls.length ? cls : api.get('/classrooms').then(r2 => r2.data.classrooms || []);
      }),
    ])
      .then(([arch, cls]) => { setArchive(arch); setClassrooms(cls); })
      .catch(err => toast.error(apiError(err, 'שגיאה בטעינת הכיתות')))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const branchNameOf = (room) => {
    if (room.branch_id && typeof room.branch_id === 'object' && room.branch_id.name) return room.branch_id.name;
    const b = branches.find(x => idOf(x) === idOf(room.branch_id));
    return b?.name || '';
  };

  // Every room with its status for the chosen month, in the order the sheets
  // will print: by branch, then by room.
  const rooms = useMemo(() => {
    const yr = yearOf(month);
    return classrooms.map((c) => {
      const id = idOf(c);
      const found = archive.find(a => a.month === month && a.year === yr && idOf(a.classroom_id) === id);
      return { id, name: c.name || '', branchId: idOf(c.branch_id), branchName: branchNameOf(c), status: found?.status || 'missing' };
    }).sort((a, b) => a.branchName.localeCompare(b.branchName, 'he') || a.name.localeCompare(b.name, 'he'));
  }, [classrooms, archive, month, branches]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new month, or a fresh load, starts from its approved rooms.
  useEffect(() => {
    setChecked(new Set(rooms.filter(r => r.status === 'approved').map(r => r.id)));
  }, [rooms]);

  const printable = rooms.filter(r => r.status !== 'missing');
  const selected = rooms.filter(r => checked.has(r.id) && r.status !== 'missing');

  const toggle = (id) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // In the cross-branch view the list is grouped under each branch's name.
  const groups = useMemo(() => {
    if (!allBranches) return [{ name: '', rooms }];
    const out = [];
    rooms.forEach((r) => {
      const last = out[out.length - 1];
      if (last && last.name === r.branchName) last.rooms.push(r);
      else out.push({ name: r.branchName, rooms: [r] });
    });
    return out;
  }, [rooms, allBranches]);

  const run = async () => {
    if (!selected.length) return;
    // Opened inside the click: after the fetches below, the popup blocker
    // would no longer believe the user asked for it.
    const win = window.open('', '_blank', 'width=1200,height=850');
    if (!win) { toast.error('הדפדפן חסם את חלון ההדפסה. אפשרו חלונות קופצים ונסו שוב.'); return; }
    win.document.write('<p dir="rtl" style="font-family:sans-serif;padding:24px">מכין את התוכניות להדפסה…</p>');
    setBusy(true);
    const yr = yearOf(month);
    try {
      const sheets = await Promise.all(selected.map(r => api.get('/gantt', {
        params: { classroom: r.id, month, year: yr, branch: selectedBranch },
      }).then(res => ({
        weeks: res.data.gantt?.weeks || [],
        rows: res.data.gantt?.row_definitions || [],
        holidays: res.data.holidays || [],
        month,
        year: yr,
        classroomName: r.name,
        branchName: r.branchName,
        status: res.data.gantt?.status,
      }))));
      printGanttMulti(sheets, { win });
      onClose();
    } catch (err) {
      win.close();
      toast.error(apiError(err, 'שגיאה בהכנת התוכניות להדפסה'));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>הדפסת חודש לכל הכיתות</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select size="small" label="חודש" value={month}
            onChange={e => setMonth(Number(e.target.value))} sx={{ maxWidth: 220 }}>
            {ACADEMIC_MONTHS.map(m => (
              <MenuItem key={m} value={m}>{MONTH_NAMES[m]} {yearOf(m)}</MenuItem>
            ))}
          </TextField>

          {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

          {!loading && rooms.length === 0 && (
            <Alert severity="info">לא נמצאו כיתות.</Alert>
          )}

          {!loading && rooms.length > 0 && (
            <>
              <Stack direction="row" spacing={2} alignItems="center">
                <Link component="button" type="button" underline="hover"
                  onClick={() => setChecked(new Set(printable.map(r => r.id)))}>בחר הכל</Link>
                <Link component="button" type="button" underline="hover"
                  onClick={() => setChecked(new Set())}>נקה</Link>
                <Typography variant="body2" color="text.secondary" sx={{ marginInlineStart: 'auto !important' }}>
                  {selected.length === 1 ? 'כיתה אחת תודפס' : `${selected.length} כיתות ייודפסו`}
                </Typography>
              </Stack>

              <Box sx={{ maxHeight: 420, overflowY: 'auto' }}>
                {groups.map(g => (
                  <Box key={g.name || 'rooms'} sx={{ mb: 1 }}>
                    {g.name && (
                      <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 1 }}>{g.name}</Typography>
                    )}
                    {g.rooms.map(r => (
                      <Stack key={r.id} direction="row" alignItems="center" spacing={1}>
                        <FormControlLabel
                          sx={{ flex: 1, mr: 0 }}
                          disabled={r.status === 'missing'}
                          control={<Checkbox size="small" checked={checked.has(r.id) && r.status !== 'missing'}
                            onChange={() => toggle(r.id)} />}
                          label={r.name}
                        />
                        <Chip size="small" variant="outlined" sx={{ fontWeight: 600 }}
                          label={STATUS_LABEL[r.status] || STATUS_LABEL.draft}
                          color={STATUS_CHIP[r.status] || 'default'} />
                      </Stack>
                    ))}
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={run}
          disabled={!selected.length || busy || loading}>
          {busy ? 'מכין…' : 'הדפס'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
