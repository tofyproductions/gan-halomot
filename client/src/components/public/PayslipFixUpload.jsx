import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert, Box, Button, Chip, CircularProgress, Container, Divider, IconButton,
  Paper, Stack, TextField, Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

/**
 * The accountant's page — reachable with a token, no account.
 *
 * He gets the corrections by email and sends the fixed payslips back by email,
 * which means someone in the office has to download and re-upload them before
 * anything can be verified. This closes that loop: he drops the corrected PDFs
 * here and the round runs itself.
 *
 * The page deliberately shows him nothing he wasn't already sent — the month
 * and his own notes. No salary figures, no other employees, no history.
 */
const SEV_COLOR = { critical: 'error', warning: 'warning', info: 'info' };
const SEV_LABEL = { critical: 'קריטי', warning: 'אזהרה', info: 'מידע' };

export default function PayslipFixUpload() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [files, setFiles] = useState([{ branch: '', file: null }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/payslip-fix/${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'הקישור אינו תקף');
        setInfo(json);
        setFiles((json.branches || []).length
          ? json.branches.map((b) => ({ branch: b, file: null }))
          : [{ branch: '', file: null }]);
      } catch (err) {
        setError(err.message || 'שגיאה');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const submit = async () => {
    const chosen = files.filter((r) => r.file && r.branch.trim());
    if (chosen.length === 0) { setError('נא לבחור לפחות קובץ תלושים אחד עם שם סניף'); return; }
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      chosen.forEach((row, i) => {
        form.append(`payslip_file_${i}`, row.file);
        form.append(`branch_${i}`, row.branch.trim());
      });
      if (note.trim()) form.append('note', note.trim());
      const res = await fetch(`/api/public/payslip-fix/${encodeURIComponent(token)}/upload`, { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'שגיאה בהעלאה');
      setDone(json);
    } catch (err) {
      setError(err.message || 'שגיאה בהעלאה');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>;
  }

  if (!info) {
    return (
      <Container maxWidth="sm" dir="rtl" sx={{ mt: 6 }}>
        <Alert severity="error">{error || 'הקישור אינו תקף או שפג תוקפו.'}</Alert>
      </Container>
    );
  }

  if (done) {
    return (
      <Container maxWidth="sm" dir="rtl" sx={{ mt: 6 }}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <CheckCircleIcon color="success" sx={{ fontSize: 56 }} />
          <Typography variant="h6" sx={{ fontWeight: 800, mt: 1 }}>הקבצים התקבלו</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            סבב {done.round_no} · נבדקו {done.employees_checked} תלושים מול ההערות.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {(done.received || []).join(', ')}
          </Typography>
          <Typography variant="body2" sx={{ mt: 2 }}>משרד גן החלומות יעבור על התוצאות ויחזור אליך במידת הצורך.</Typography>
        </Paper>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" dir="rtl" sx={{ py: 4 }}>
      <Typography variant="h5" sx={{ fontWeight: 800 }}>העלאת תלושים מתוקנים</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        גן החלומות · שכר {info.year_month}
        {info.rounds_so_far > 0 && ` · הועלו עד כה ${info.rounds_so_far} סבבים`}
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>קבצי התלושים המתוקנים</Typography>
        <Stack spacing={1}>
          {files.map((row, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="center">
              <TextField size="small" label="סניף" value={row.branch} sx={{ minWidth: 200 }}
                onChange={(e) => setFiles((p) => p.map((x, j) => j === i ? { ...x, branch: e.target.value } : x))} />
              <Button size="small" variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                {row.file ? row.file.name : 'בחר PDF'}
                <input hidden type="file" accept="application/pdf"
                  onChange={(e) => { const f = e.target.files?.[0] || null; setFiles((p) => p.map((x, j) => j === i ? { ...x, file: f } : x)); }} />
              </Button>
              {files.length > 1 && (
                <IconButton size="small" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><DeleteIcon fontSize="small" /></IconButton>
              )}
            </Stack>
          ))}
          <Box>
            <Button size="small" startIcon={<AddIcon />} disabled={files.length >= 10}
              onClick={() => setFiles((p) => [...p, { branch: '', file: null }])}>סניף נוסף</Button>
          </Box>
          <TextField size="small" label="הערה (אופציונלי)" value={note} onChange={(e) => setNote(e.target.value)} fullWidth />
          <Box>
            <Button variant="contained" size="large" disabled={busy} onClick={submit}>
              {busy ? 'מעלה…' : 'שלח תלושים מתוקנים'}
            </Button>
          </Box>
        </Stack>
      </Paper>

      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
        התיקונים שנשלחו אליך ({info.employees.length} תלושים)
      </Typography>
      <Stack spacing={1}>
        {info.employees.map((e, i) => (
          <Paper key={i} variant="outlined" sx={{ p: 1.25 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
              <Typography sx={{ fontWeight: 700 }}>{e.name}</Typography>
              {e.branch && <Typography variant="caption" color="text.secondary">{e.branch}</Typography>}
              {e.employee_no != null && <Typography variant="caption" color="text.secondary">· מס׳ עובד {e.employee_no}</Typography>}
            </Stack>
            <Divider sx={{ mb: 0.75 }} />
            <Stack spacing={0.5}>
              {e.notes.map((n, ni) => (
                <Stack key={ni} direction="row" spacing={1} alignItems="flex-start">
                  <Chip size="small" color={SEV_COLOR[n.severity] || 'default'} label={SEV_LABEL[n.severity] || n.severity}
                    sx={{ height: 20, fontSize: 10, fontWeight: 700, minWidth: 60 }} />
                  <Typography variant="body2">{n.message}</Typography>
                </Stack>
              ))}
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Container>
  );
}
