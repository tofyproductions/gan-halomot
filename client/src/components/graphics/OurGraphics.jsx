import { useState, useEffect, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Chip, Button, TextField,
  MenuItem, Table, TableBody, TableCell, TableHead, TableRow, Alert,
  ToggleButton, ToggleButtonGroup, Tooltip, IconButton, CircularProgress,
} from '@mui/material';
import CakeIcon from '@mui/icons-material/Cake';
import DownloadIcon from '@mui/icons-material/Download';
import PrintIcon from '@mui/icons-material/Print';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { ganMarkerByName } from '../../utils/branchColors';
import LoadingSpinner from '../shared/LoadingSpinner';

/**
 * הגרפיקות שלנו — the things the gan prints, made from what the gan already
 * knows.
 *
 * The birthday card is the first one and the screen is built for the next:
 * one section per graphic, each answering its own question and producing its
 * own file. Nothing here is designed in the browser — the card's layout lives
 * in the server's template so that the card the office prints in June and the
 * one a gananet prints in December are the same card.
 */

const MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const shortBranch = (name) => String(name || '').split(' - ').pop().trim();

function BranchChip({ name }) {
  const mk = ganMarkerByName(name);
  if (!name) return null;
  return (
    <Tooltip title={name}>
      <Chip
        size="small"
        label={shortBranch(name)}
        sx={{ bgcolor: mk?.strip || 'grey.300', color: mk?.stripText || 'text.primary', fontWeight: 700 }}
      />
    </Tooltip>
  );
}

/**
 * Fetch the card and hand it to the browser.
 *
 * `download` saves the file; `print` opens it in a window and asks to print.
 * Printing is the whole point of the screen, and a download the gananet then
 * has to find in her Downloads folder and open is three steps where one will
 * do — but the download stays because that is how the card reaches WhatsApp.
 */
async function fetchCard(params) {
  const res = await api.get('/graphics/birthday-card', { params, responseType: 'blob', timeout: 120000 });
  return URL.createObjectURL(res.data);
}

function saveBlobUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

/**
 * A window holding nothing but the card, which prints as one full page.
 *
 * The image is sized to the page rather than to its own pixels: at 2480px
 * wide a browser prints it across several sheets, which is how you discover
 * that a birthday card needs sellotape.
 */
function printBlobUrl(url, title) {
  const w = window.open('', '_blank');
  if (!w) {
    toast.info('הדפדפן חסם את חלון ההדפסה — השתמשו בהורדה');
    return;
  }
  w.document.write(`<!doctype html><html lang="he" dir="rtl"><head>
<title>${title}</title><meta charset="utf-8">
<style>
  @page{margin:0}
  html,body{margin:0;padding:0;height:100%}
  img{width:100%;height:100%;object-fit:contain;display:block}
</style></head><body><img src="${url}"></body></html>`);
  w.document.close();
  // Printing before the image has decoded prints an empty page.
  const img = w.document.images[0];
  const go = () => { try { w.focus(); w.print(); } catch (e) { /* ignore */ } };
  if (img && !img.complete) img.onload = go; else setTimeout(go, 300);
}

/** Read once, at module load: a card printed at midnight is not worth a re-render. */
const TODAY = new Date();

export default function OurGraphics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(TODAY.getMonth() + 1);
  const [year, setYear] = useState(TODAY.getFullYear());
  const [branch, setBranch] = useState('all');
  const [classroom, setClassroom] = useState('');
  // Which name goes on the card. Per screen and not per child: a room decides
  // this once — a תינוקיה says "נועם", a room with two of them says which.
  const [nameMode, setNameMode] = useState('first');
  const [busy, setBusy] = useState(null);

  const load = () => {
    setLoading(true);
    const params = { month, year };
    if (branch !== 'all') params.branch = branch;
    if (classroom) params.classroom = classroom;
    api.get('/graphics/birthdays', { params })
      .then(res => setData(res.data))
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [month, year, branch, classroom]);

  const children = data?.children || [];
  const years = useMemo(() => {
    const y = TODAY.getFullYear();
    return [y - 1, y, y + 1];
  }, []);

  const card = async (child, how) => {
    const key = `${child?.id || 'blank'}-${how}`;
    setBusy(key);
    let url;
    try {
      const params = child ? { child: child.id, name: nameMode } : {};
      if (branch !== 'all') params.branch = branch;
      url = await fetchCard(params);
      const name = child ? (nameMode === 'full' ? child.full_name : child.first_name) : '';
      if (how === 'print') printBlobUrl(url, name ? `יום הולדת - ${name}` : 'יום הולדת');
      else saveBlobUrl(url, name ? `יום הולדת - ${name}.jpg` : 'יום הולדת.jpg');
    } catch (err) {
      toast.error(err.response?.data?.error || 'הפקת הכרטיס נכשלה — נסו שוב בעוד רגע');
    } finally {
      setBusy(null);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>הגרפיקות שלנו</Typography>
        <Tooltip title="רענון">
          <IconButton onClick={load}><RefreshIcon /></IconButton>
        </Tooltip>
      </Stack>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
            <CakeIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 800 }}>כרטיס יום הולדת</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            ימי ההולדת של החודש, מתוך הרישום. כל כרטיס יוצא כתמונה להדפסה.
          </Typography>

          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <TextField select size="small" label="חודש" value={month} sx={{ minWidth: 130 }}
              onChange={e => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <MenuItem key={m} value={i + 1}>{m}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="שנה" value={year} sx={{ minWidth: 100 }}
              onChange={e => setYear(Number(e.target.value))}>
              {years.map(y => <MenuItem key={y} value={y}>{y}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="סניף" value={branch} sx={{ minWidth: 180 }}
              onChange={e => { setBranch(e.target.value); setClassroom(''); }}>
              <MenuItem value="all">כל הסניפים</MenuItem>
              {(data?.branches || []).map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="כיתה" value={classroom} sx={{ minWidth: 160 }}
              onChange={e => setClassroom(e.target.value)}>
              <MenuItem value="">כל הכיתות</MenuItem>
              {(data?.classrooms || []).map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
          </Stack>

          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>השם על הכרטיס:</Typography>
            <ToggleButtonGroup exclusive size="small" value={nameMode}
              onChange={(e, v) => v && setNameMode(v)}>
              <ToggleButton value="first">שם פרטי</ToggleButton>
              <ToggleButton value="full">שם פרטי ומשפחה</ToggleButton>
            </ToggleButtonGroup>
            {/* A card for a child who started last week, before the office has
                typed them in — the name goes on by hand. */}
            <Button variant="outlined" startIcon={<PrintIcon />}
              disabled={busy === 'blank-print'}
              onClick={() => card(null, 'print')}>
              כרטיס ריק להדפסה
            </Button>
            <Button variant="text" startIcon={<DownloadIcon />}
              disabled={busy === 'blank-download'}
              onClick={() => card(null, 'download')}>
              הורדת כרטיס ריק
            </Button>
          </Stack>

          {loading ? <LoadingSpinner /> : (
            <>
              {!children.length && (
                <Alert severity="info">
                  אין ימי הולדת ב{MONTHS[month - 1]} בסניפים שנבחרו.
                  ילד/ה בלי תאריך לידה ברישום לא יופיע כאן — אפשר להפיק כרטיס ריק.
                </Alert>
              )}
              {!!children.length && (
                <>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {children.length} ימי הולדת ב{MONTHS[month - 1]}
                  </Typography>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 800 }}>תאריך</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>שם</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>גיל</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>כיתה</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>סניף</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>כרטיס</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {children.map(c => (
                        <TableRow key={c.id} hover>
                          <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>
                            {c.day}.{month}
                          </TableCell>
                          <TableCell>{c.full_name}</TableCell>
                          <TableCell>{c.age ?? '—'}</TableCell>
                          <TableCell>{c.classroom || '—'}</TableCell>
                          <TableCell><BranchChip name={c.branch} /></TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5}>
                              <Tooltip title="הדפסה">
                                <span>
                                  <IconButton size="small" color="primary"
                                    disabled={busy === `${c.id}-print`}
                                    onClick={() => card(c, 'print')}>
                                    {busy === `${c.id}-print`
                                      ? <CircularProgress size={18} />
                                      : <PrintIcon fontSize="small" />}
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title="הורדה">
                                <span>
                                  <IconButton size="small"
                                    disabled={busy === `${c.id}-download`}
                                    onClick={() => card(c, 'download')}>
                                    {busy === `${c.id}-download`
                                      ? <CircularProgress size={18} />
                                      : <DownloadIcon fontSize="small" />}
                                  </IconButton>
                                </span>
                              </Tooltip>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
