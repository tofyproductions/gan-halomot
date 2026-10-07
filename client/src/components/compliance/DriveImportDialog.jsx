import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, TextField, MenuItem, Table, TableHead, TableBody, TableRow,
  TableCell, Chip, Alert, Checkbox, CircularProgress, Link, IconButton, Tooltip,
} from '@mui/material';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';

const CONFIDENCE = {
  high: { label: 'בטוח', color: 'success' },
  medium: { label: 'צריך עין', color: 'warning' },
  low: { label: 'לא זוהה', color: 'error' },
};

/**
 * ייבוא מהדרייב — proposals, not an import.
 *
 * The scan reads file names that were typed by hand over four years, so what
 * it produces is a guess with a confidence on it. Every row here is editable
 * and nothing is written until somebody presses the button, because the
 * mistake this screen exists to prevent is quiet: a certificate attached to
 * the wrong branch is a branch that LOOKS covered and is not, and the first
 * anybody hears of it is from an inspector.
 *
 * The rows that cannot be guessed are the point and so they sort to the top:
 * כפר סבא names TWO branches in this system — קפלן and משה דיין — and no
 * filename says which. Those arrive with an empty branch and cannot be ticked
 * until one is chosen.
 */
export default function DriveImportDialog({ open, onClose, branches, certTypes, onImported }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState([]);
  const [problem, setProblem] = useState(null);
  const [account, setAccount] = useState('');

  const bid = (b) => String(b._id || b.id);

  const scan = () => {
    setLoading(true); setProblem(null);
    api.get('/branch-certifications/drive/scan')
      .then(r => {
        setRows((r.data.proposals || []).map(p => ({
          ...p,
          // Nothing already linked, and nothing unidentified, is ticked by
          // default — a default of "yes" on a row nobody read is how a wrong
          // guess gets imported.
          picked: !p.already_imported && p.confidence === 'high',
          expires_at: '',
        })));
      })
      .catch(err => {
        const d = err.response?.data || {};
        setProblem({ code: d.code || '', message: apiError(err, 'הסריקה נכשלה') });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setRows([]); setProblem(null);
    api.get('/branch-certifications/drive/folders')
      .then(r => setAccount(r.data.service_account || ''))
      .catch(() => {});
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const ready = rows.filter(r => r.picked && r.branch_id && r.type && !r.already_imported);
  const blocked = rows.filter(r => r.picked && (!r.branch_id || !r.type));

  const doImport = () => {
    if (ready.length === 0) return toast.info('לא נבחרה אף שורה שאפשר לייבא');
    setSaving(true);
    api.post('/branch-certifications/drive/import', {
      items: ready.map(r => ({
        file_name: r.file_name, url: r.url, kind: r.kind, type: r.type,
        branch_id: r.branch_id, issued_at: r.issued_at || null,
        expires_at: r.expires_at || null, folder_path: r.folder_path,
      })),
    })
      .then(res => {
        const { created, refused = [] } = res.data;
        toast.success(`יובאו ${created} אישורים`);
        if (refused.length) {
          toast.warn(`${refused.length} נדחו: ${refused.slice(0, 3).map(x => `${x.name} — ${x.reason}`).join(' · ')}`);
        }
        onImported?.();
        scan();
      })
      .catch(err => toast.error(apiError(err, 'הייבוא נכשל')))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CloudDownloadIcon color="primary" /> ייבוא אישורים מהדרייב
      </DialogTitle>

      <DialogContent>
        {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

        {problem && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>{problem.message}</Typography>
            {problem.code === 'DRIVE_NOT_CONFIGURED' && (
              <Typography variant="body2">אין במערכת פרטי גישה לגוגל. פנו למנהל/ת המערכת.</Typography>
            )}
            {account && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                כדי שהמערכת תראה תיקייה, צריך לשתף אותה בהרשאת <b>צופה</b> עם:
                <Box component="span" dir="ltr" sx={{ display: 'block', fontFamily: 'monospace', mt: 0.5 }}>
                  {account}
                </Box>
              </Typography>
            )}
            <Button size="small" sx={{ mt: 1 }} onClick={scan}>נסה שוב</Button>
          </Alert>
        )}

        {!loading && !problem && rows.length === 0 && (
          <Alert severity="info" sx={{ mt: 1 }}>לא נמצאו קבצים בתיקיות שהוגדרו.</Alert>
        )}

        {rows.length > 0 && (
          <>
            <Alert severity="info" sx={{ mt: 1, mb: 1.5 }}>
              אלה <b>הצעות</b> שנגזרו משמות הקבצים — שום דבר לא נכנס למערכת עד שתלחץ/י ייבוא.
              שורה שמסומנת <b>❓ צריך סניף</b> היא קובץ של "כפר סבא", ובמערכת יש שני סניפים בשם הזה.
            </Alert>

            <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 900 }}>
              <TableHead><TableRow>
                <TableCell padding="checkbox" />
                <TableCell>קובץ</TableCell>
                <TableCell>סוג האישור</TableCell>
                <TableCell>סניף</TableCell>
                <TableCell>תאריך הוצאה</TableCell>
                <TableCell>בתוקף עד</TableCell>
                <TableCell align="center">זיהוי</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.drive_id} hover
                    sx={{ opacity: r.already_imported ? 0.45 : 1 }}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={!!r.picked} disabled={r.already_imported}
                        onChange={e => setRow(i, { picked: e.target.checked })}
                      />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 260 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.file_name}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {r.folder_path}
                        {r.also_at?.length ? ` · גם ב: ${r.also_at.join(', ')}` : ''}
                      </Typography>
                      {r.already_imported && <Chip size="small" label="כבר מקושר" sx={{ mt: 0.5 }} />}
                      <Tooltip title="פתח בדרייב">
                        <IconButton size="small" component={Link} href={r.url} target="_blank" rel="noopener">
                          <OpenInNewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <TextField select size="small" sx={{ minWidth: 190 }}
                        value={r.type || ''} onChange={e => setRow(i, { type: e.target.value })}>
                        <MenuItem value="">— בחר/י —</MenuItem>
                        {Object.entries(certTypes || {}).map(([k, v]) =>
                          <MenuItem key={k} value={k}>{v}</MenuItem>)}
                      </TextField>
                    </TableCell>
                    <TableCell>
                      <TextField select size="small" sx={{ minWidth: 170 }}
                        error={r.picked && !r.branch_id}
                        value={r.branch_id || ''} onChange={e => setRow(i, { branch_id: e.target.value })}>
                        <MenuItem value="">❓ צריך סניף</MenuItem>
                        {(branches || []).map(b =>
                          <MenuItem key={bid(b)} value={bid(b)}>{b.name}</MenuItem>)}
                      </TextField>
                    </TableCell>
                    <TableCell>
                      <TextField type="date" size="small" sx={{ minWidth: 150 }}
                        InputLabelProps={{ shrink: true }}
                        value={r.issued_at || ''} onChange={e => setRow(i, { issued_at: e.target.value })}
                        helperText={r.date_precision === 'month' ? 'מהשם: חודש בלבד' : ''}
                      />
                    </TableCell>
                    <TableCell>
                      <TextField type="date" size="small" sx={{ minWidth: 150 }}
                        InputLabelProps={{ shrink: true }}
                        value={r.expires_at || ''} onChange={e => setRow(i, { expires_at: e.target.value })}
                      />
                    </TableCell>
                    <TableCell align="center">
                      <Chip size="small" color={CONFIDENCE[r.confidence]?.color || 'default'}
                        label={CONFIDENCE[r.confidence]?.label || r.confidence} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>

            <Alert severity="warning" sx={{ mt: 1.5 }}>
              שים/י לב: הקובץ <b>נשאר בדרייב</b> — המערכת שומרת קישור אליו. אם הקובץ יימחק
              או יועבר שם, הקישור כאן יישבר.
              {' '}תאריך "בתוקף עד" לא מופיע בשמות הקבצים, ולכן הוא ריק — בלעדיו המערכת לא
              תתריע לפני שהאישור פג.
            </Alert>
          </>
        )}
      </DialogContent>

      <DialogActions>
        {blocked.length > 0 && (
          <Typography variant="caption" color="error" sx={{ mr: 'auto', ml: 1 }}>
            {blocked.length} שורות מסומנות בלי סניף או בלי סוג — הן לא ייובאו
          </Typography>
        )}
        <Button onClick={onClose} disabled={saving}>סגור</Button>
        <Button variant="contained" onClick={doImport} disabled={saving || ready.length === 0}>
          {saving ? 'מייבא…' : `ייבוא ${ready.length} אישורים`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
