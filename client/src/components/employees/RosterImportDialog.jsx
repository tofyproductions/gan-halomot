import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Alert, TextField, LinearProgress, Table, TableHead, TableRow, TableCell,
  TableBody, Checkbox, Chip, Box, Paper, Accordion, AccordionSummary,
  AccordionDetails, Tooltip,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Loading the accountant's roster into the staff records.
 *
 * The screen exists because the alternative is a script: a hundred employees'
 * telephone numbers, dates of birth and leave balances rewritten in one call
 * that nobody sees until somebody notices their balance is wrong. Here the file
 * is read, the differences are shown one employee at a time, and NOTHING is
 * written until a person ticks the rows and presses the second button.
 *
 * Two things are deliberately not offered. There is no "select all and apply"
 * shortcut on an untouched preview — approving ninety-five people should take a
 * deliberate action. And a row with nothing to change is not selectable at all,
 * so the count on the button is the number of records that will actually move.
 */
export default function RosterImportDialog({ open, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [asOfMonth, setAsOfMonth] = useState('');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState({});

  const reset = () => { setFile(null); setPlan(null); setApproved({}); setAsOfMonth(''); };
  const close = () => { reset(); onClose(); };

  const changed = (plan?.matched || []).filter((m) => m.changes.length > 0);
  const chosen = changed.filter((m) => approved[m.israeli_id]);

  const preview = async () => {
    if (!file) { toast.error('בחרו קובץ'); return; }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      if (asOfMonth) body.append('as_of_month', asOfMonth);
      const res = await api.post('/employee-roster-import/preview', body);
      setPlan(res.data);
      // Nothing is pre-ticked: a default of "everyone" turns review into a
      // formality, and this is the only screen standing between a spreadsheet
      // and ninety-five personnel records.
      setApproved({});
      if ((res.data.matched || []).every((m) => m.changes.length === 0)) {
        toast.info('אין מה לעדכן — כל הנתונים במערכת כבר תואמים לקובץ');
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'שגיאה בקריאת הקובץ');
    } finally { setBusy(false); }
  };

  const applyNow = async () => {
    if (chosen.length === 0) { toast.error('לא סומנו עובדים'); return; }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      if (asOfMonth) body.append('as_of_month', asOfMonth);
      body.append('approved_ids', JSON.stringify(chosen.map((m) => m.israeli_id)));
      const res = await api.post('/employee-roster-import/apply', body);
      const { updated = [], failed = [] } = res.data;
      toast.success(`${updated.length} עובדים עודכנו${failed.length ? ` · ${failed.length} נכשלו` : ''}`);
      if (failed.length) {
        failed.slice(0, 3).forEach((f) => toast.error(`${f.full_name || f.israeli_id}: ${f.error}`));
      }
      onDone?.();
      close();
    } catch (e) {
      toast.error(e.response?.data?.error || 'שגיאה בעדכון');
    } finally { setBusy(false); }
  };

  const s = plan?.summary;

  return (
    <Dialog open={open} onClose={close} dir="rtl" maxWidth="lg" fullWidth
      PaperProps={{ sx: { height: '92vh' } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        ייבוא אלפון עובדים מהרו״ח
      </DialogTitle>
      <DialogContent dividers>
        {busy && <LinearProgress sx={{ mb: 1 }} />}

        <Stack spacing={2}>
          <Alert severity="info">
            הקובץ נקרא ומושווה לפי <b>תעודת זהות</b>. שדה שריק בקובץ לא מוחק את מה שקיים
            במערכת, ותעודת זהות שלא מוכרת לא יוצרת עובד/ת חדש/ה — רק מדווחת.
          </Alert>

          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
              {file ? file.name : 'בחרו קובץ (Excel / CSV)'}
              <input hidden type="file" accept=".xlsx,.xls,.csv"
                onChange={(e) => { setFile(e.target.files?.[0] || null); setPlan(null); setApproved({}); }} />
            </Button>
            <Tooltip title="החודש שאליו היתרות נכונות. בלעדיו יתרות חופשה/מחלה/הבראה לא ייקלטו — אי אפשר לצבור קדימה מיתרה בלי תאריך.">
              <TextField size="small" label="היתרות נכונות לחודש" placeholder="2026-08"
                value={asOfMonth} onChange={(e) => { setAsOfMonth(e.target.value.trim()); setPlan(null); }}
                sx={{ width: 190 }} />
            </Tooltip>
            <Button variant="contained" onClick={preview} disabled={busy || !file}>
              הצג מה ישתנה
            </Button>
          </Stack>

          {plan && !asOfMonth && s?.blocked > 0 && (
            <Alert severity="warning">
              לא הוזן חודש ליתרות, ולכן {s.blocked} יתרות לא ייקלטו. מלאו את השדה והציגו שוב.
            </Alert>
          )}

          {s && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Chip label={`${s.rows} שורות בקובץ`} />
              <Chip color="primary" label={`${s.with_changes} לעדכון`} />
              <Chip label={`${s.unchanged} ללא שינוי`} />
              {s.unknown > 0 && <Chip color="warning" label={`${s.unknown} לא נמצאו במערכת`} />}
              {s.invalid > 0 && <Chip color="error" label={`${s.invalid} שורות פסולות`} />}
              {s.blocked > 0 && <Chip color="error" label={`${s.blocked} יתרות חסומות`} />}
            </Stack>
          )}

          {changed.length > 0 && (
            <Paper variant="outlined" sx={{ borderRadius: 2 }}>
              <Stack direction="row" spacing={1} sx={{ p: 1 }}>
                <Button size="small" onClick={() => setApproved(Object.fromEntries(changed.map((m) => [m.israeli_id, true])))}>
                  סמן הכל
                </Button>
                <Button size="small" onClick={() => setApproved({})}>נקה סימון</Button>
              </Stack>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox" />
                      <TableCell sx={{ fontWeight: 800 }}>עובד/ת</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>שדה</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>במערכת היום</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>יעודכן ל</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {changed.map((m) => m.changes.map((c, i) => (
                      <TableRow key={`${m.israeli_id}-${c.field}`} hover>
                        {i === 0 && (
                          <TableCell padding="checkbox" rowSpan={m.changes.length}>
                            <Checkbox size="small" checked={!!approved[m.israeli_id]}
                              onChange={(e) => setApproved((p) => ({ ...p, [m.israeli_id]: e.target.checked }))} />
                          </TableCell>
                        )}
                        {i === 0 && (
                          <TableCell rowSpan={m.changes.length} sx={{ fontWeight: 700 }}>
                            {m.full_name}
                            {!m.is_active && <Chip size="small" color="warning" label="לא פעיל/ה" sx={{ mr: 0.5 }} />}
                            {m.blocked.length > 0 && (
                              <Tooltip title={m.blocked.map((b) => `${b.label}: ${b.reason}`).join(' · ')}>
                                <WarningAmberIcon fontSize="small" color="error" sx={{ verticalAlign: 'middle', mr: 0.5 }} />
                              </Tooltip>
                            )}
                          </TableCell>
                        )}
                        <TableCell>{c.label}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{c.before}</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{c.after}</TableCell>
                      </TableRow>
                    )))}
                  </TableBody>
                </Table>
              </Box>
            </Paper>
          )}

          {plan?.unknown?.length > 0 && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography sx={{ fontWeight: 700 }}>
                  {plan.unknown.length} תעודות זהות שאינן במערכת — לא ייווצרו עובדים
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                {plan.unknown.map((u) => (
                  <Typography key={u.israeli_id} variant="body2">
                    • מס׳ {u.employee_number || '—'} · ת״ז {u.israeli_id} {u.email ? `· ${u.email}` : ''}
                  </Typography>
                ))}
                <Typography variant="caption" color="text.secondary">
                  אם מדובר בעובד/ת שאכן עובד/ת בגן — יש להוסיף אותה במסך העובדים ואז להריץ שוב.
                </Typography>
              </AccordionDetails>
            </Accordion>
          )}

          {plan?.invalid?.length > 0 && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography sx={{ fontWeight: 700, color: 'error.main' }}>
                  {plan.invalid.length} שורות פסולות
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                {plan.invalid.map((v, i) => (
                  <Typography key={i} variant="body2">
                    • ת״ז {v.israeli_id || '—'} — {v.reason}
                  </Typography>
                ))}
              </AccordionDetails>
            </Accordion>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>סגור</Button>
        <Button variant="contained" color="primary" disabled={busy || chosen.length === 0}
          onClick={applyNow}>
          עדכן {chosen.length} עובדים
        </Button>
      </DialogActions>
    </Dialog>
  );
}
