import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack,
  Typography, Chip, Alert, Table, TableHead, TableBody, TableRow, TableCell,
  CircularProgress, LinearProgress, Divider,
} from '@mui/material';
import RestaurantMenuIcon from '@mui/icons-material/RestaurantMenu';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Uploads a Pluxee/Cibus monthly report and applies each employee's total
 * to PayrollMonth.manual.cibus for the selected month. Shows a per-row
 * summary of matched/unmatched employees after the upload completes.
 */
export default function CibusImportDialog({ open, month, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  const reset = () => { setFile(null); setUploading(false); setResult(null); };

  const upload = () => {
    if (!file) return toast.error('יש לבחור קובץ');
    const form = new FormData();
    form.append('cibus_file', file);
    setUploading(true);
    api.post(`/payroll-month/import-cibus?month=${encodeURIComponent(month)}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
      .then(res => {
        setResult(res.data);
        toast.success(`יובאו ${res.data.matched_count} עובדים`);
        onImported && onImported();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בייבוא'))
      .finally(() => setUploading(false));
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <RestaurantMenuIcon color="success" />
        ייבוא דוח סיבוס — {month}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">
            העלה קובץ Pluxee/Cibus (xlsx או csv). הסכומים יוזנו אוטומטית לעמודת "סיבוס" בטבלת השכר.
            ההתאמה לעובדים נעשית לפי תעודת זהות, ואם זו לא קיימת — לפי שם.
          </Alert>

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              component="label"
              startIcon={<UploadFileIcon />}
              disabled={uploading}
            >
              בחר קובץ
              <input
                type="file"
                hidden
                accept=".xlsx,.xls,.csv"
                onChange={e => setFile(e.target.files?.[0] || null)}
              />
            </Button>
            {file && <Chip label={file.name} onDelete={() => setFile(null)} />}
            <Box sx={{ flex: 1 }} />
            <Button
              variant="contained"
              onClick={upload}
              disabled={!file || uploading}
              startIcon={uploading ? <CircularProgress size={16} /> : null}
            >
              {uploading ? 'מייבא…' : 'ייבא לטבלת השכר'}
            </Button>
          </Stack>

          {uploading && <LinearProgress />}

          {result && (
            <>
              <Divider />
              <Stack direction="row" spacing={2}>
                <Box sx={{ flex: 1, p: 1.5, bgcolor: 'success.50', borderRadius: 2, textAlign: 'center' }}>
                  <Typography variant="caption" color="text.secondary">הותאמו</Typography>
                  <Typography variant="h5" sx={{ fontWeight: 800 }}>{result.matched_count}</Typography>
                </Box>
                <Box sx={{ flex: 1, p: 1.5, bgcolor: 'warning.50', borderRadius: 2, textAlign: 'center' }}>
                  <Typography variant="caption" color="text.secondary">לא הותאמו</Typography>
                  <Typography variant="h5" sx={{ fontWeight: 800 }}>{result.unmatched_count}</Typography>
                </Box>
                <Box sx={{ flex: 1, p: 1.5, bgcolor: 'primary.50', borderRadius: 2, textAlign: 'center' }}>
                  <Typography variant="caption" color="text.secondary">סכום כולל</Typography>
                  <Typography variant="h5" sx={{ fontWeight: 800 }}>{Math.round(result.total_amount)} ₪</Typography>
                </Box>
              </Stack>

              {result.warning && <Alert severity="warning">{result.warning}</Alert>}

              {result.matched.length > 0 && (
                <>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הותאמו</Typography>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>שם</TableCell>
                        <TableCell>ת״ז</TableCell>
                        <TableCell align="center">סכום</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {result.matched.slice(0, 50).map(m => (
                        <TableRow key={m.employee_id}>
                          <TableCell>{m.employee_name}</TableCell>
                          <TableCell>{m.israeli_id || '—'}</TableCell>
                          <TableCell align="center">{Math.round(m.amount)} ₪</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {result.matched.length > 50 && (
                    <Typography variant="caption" color="text.disabled">מציג 50/{result.matched.length}</Typography>
                  )}
                </>
              )}

              {result.unmatched.length > 0 && (
                <>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'warning.main' }}>
                    לא הותאמו (יש לבדוק ידנית)
                  </Typography>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>שם בדוח</TableCell>
                        <TableCell>ת״ז בדוח</TableCell>
                        <TableCell align="center">סכום</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {result.unmatched.map((u, i) => (
                        <TableRow key={i}>
                          <TableCell>{u.name || '—'}</TableCell>
                          <TableCell>{u.id || '—'}</TableCell>
                          <TableCell align="center">{Math.round(u.amount)} ₪</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { reset(); onClose(); }}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
