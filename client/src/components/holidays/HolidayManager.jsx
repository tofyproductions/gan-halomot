import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
  Paper, IconButton, Tooltip, MenuItem, Dialog, DialogTitle,
  DialogContent, DialogActions, Chip, Alert,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAcademicYear } from '../../hooks/useAcademicYear';

const PRESET_HOLIDAYS = [
  'ראש השנה', 'יום כיפור', 'סוכות', 'חנוכה', 'פורים',
  'פסח', 'יום הזיכרון', 'יום העצמאות', 'שבועות', 'ט׳ באב',
  'חופשת קיץ',
];

export default function HolidayManager() {
  const { selectedBranch, branches } = useBranch();
  const { years } = useAcademicYear();
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState({ open: false, mode: 'add', data: {} });
  const [copyDialog, setCopyDialog] = useState({ open: false, sourceBranch: '' });

  const academicYear = years.current.range;

  const fetchHolidays = useCallback(() => {
    setLoading(true);
    api.get('/holidays', { params: { year: academicYear } })
      .then(res => setHolidays(res.data.holidays || []))
      .catch(() => toast.error('שגיאה בטעינת חופשות'))
      .finally(() => setLoading(false));
  }, [academicYear]);

  useEffect(() => { fetchHolidays(); }, [fetchHolidays]);

  const handleSave = async () => {
    const { mode, data } = dialog;
    if (!data.name || !data.start_date || !data.end_date) {
      return toast.error('כל השדות חובה');
    }
    try {
      if (mode === 'add') {
        await api.post('/holidays', {
          branch_id: selectedBranch,
          academic_year: academicYear,
          ...data,
        });
        toast.success('חופשה נוספה');
      } else {
        await api.put(`/holidays/${data.id}`, data);
        toast.success('חופשה עודכנה');
      }
      setDialog({ open: false, mode: 'add', data: {} });
      fetchHolidays();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/holidays/${id}`);
      toast.success('חופשה נמחקה');
      fetchHolidays();
    } catch { toast.error('שגיאה'); }
  };

  const handleCopy = async () => {
    try {
      await api.post('/holidays/copy', {
        source_branch_id: copyDialog.sourceBranch,
        target_branch_id: selectedBranch,
        academic_year: academicYear,
      });
      toast.success('חופשות הועתקו');
      setCopyDialog({ open: false, sourceBranch: '' });
      fetchHolidays();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const addPreset = (name) => {
    setDialog({
      open: true, mode: 'add',
      data: { name, start_date: '', end_date: '', is_custom: false },
    });
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('he-IL') : '';

  // Find which presets are missing
  const existingNames = new Set(holidays.map(h => h.name));
  const missingPresets = PRESET_HOLIDAYS.filter(p => !existingNames.has(p));

  return (
    <Box dir="rtl" sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>חופשות וחגים - {academicYear}</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<ContentCopyIcon />}
            onClick={() => setCopyDialog({ open: true, sourceBranch: '' })}
          >
            העתק מסניף אחר
          </Button>
          <Button variant="contained" startIcon={<AddIcon />}
            onClick={() => setDialog({ open: true, mode: 'add', data: { name: '', start_date: '', end_date: '', is_custom: true } })}
          >
            הוסף חופשה
          </Button>
        </Stack>
      </Stack>

      {/* Missing presets */}
      {missingPresets.length > 0 && (
        <Alert severity="info" sx={{ mb: 3, borderRadius: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>חגים שטרם הוגדרו:</Typography>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {missingPresets.map(p => (
              <Chip key={p} label={p} size="small" onClick={() => addPreset(p)}
                sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'primary.light', color: 'white' } }}
              />
            ))}
          </Stack>
        </Alert>
      )}

      {/* Holidays table */}
      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>חופשה/חג</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>מתאריך</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>עד תאריך</TableCell>
              <TableCell sx={{ fontWeight: 700 }} align="center">ימים</TableCell>
              <TableCell align="center">פעולות</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {holidays.map(h => {
              const days = Math.ceil((new Date(h.end_date) - new Date(h.start_date)) / 86400000) + 1;
              return (
                <TableRow key={h._id || h.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {h.name}
                    {h.is_custom && <Chip label="מותאם" size="small" variant="outlined" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>{formatDate(h.start_date)}</TableCell>
                  <TableCell>{formatDate(h.end_date)}</TableCell>
                  <TableCell align="center"><Chip label={days} size="small" /></TableCell>
                  <TableCell align="center">
                    <Stack direction="row" spacing={0.5} justifyContent="center">
                      <Tooltip title="ערוך">
                        <IconButton size="small" onClick={() => setDialog({
                          open: true, mode: 'edit',
                          data: {
                            id: h._id || h.id, name: h.name,
                            start_date: new Date(h.start_date).toISOString().slice(0, 10),
                            end_date: new Date(h.end_date).toISOString().slice(0, 10),
                          },
                        })}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="מחק">
                        <IconButton size="small" color="error" onClick={() => handleDelete(h._id || h.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {holidays.length === 0 && (
              <TableRow><TableCell colSpan={5} sx={{ textAlign: 'center', py: 4 }}>אין חופשות מוגדרות. לחץ על חג למעלה או הוסף ידנית.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add/Edit Dialog */}
      <Dialog open={dialog.open} onClose={() => setDialog({ open: false, mode: 'add', data: {} })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>{dialog.mode === 'add' ? 'הוסף חופשה' : 'ערוך חופשה'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="שם החופשה/חג" value={dialog.data.name || ''} fullWidth
              onChange={e => setDialog(prev => ({ ...prev, data: { ...prev.data, name: e.target.value } }))}
            />
            <TextField label="מתאריך" type="date" value={dialog.data.start_date || ''} fullWidth
              InputLabelProps={{ shrink: true }}
              onChange={e => setDialog(prev => ({ ...prev, data: { ...prev.data, start_date: e.target.value } }))}
            />
            <TextField label="עד תאריך" type="date" value={dialog.data.end_date || ''} fullWidth
              InputLabelProps={{ shrink: true }}
              onChange={e => setDialog(prev => ({ ...prev, data: { ...prev.data, end_date: e.target.value } }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog({ open: false, mode: 'add', data: {} })}>ביטול</Button>
          <Button variant="contained" onClick={handleSave}>שמור</Button>
        </DialogActions>
      </Dialog>

      {/* Copy Dialog */}
      <Dialog open={copyDialog.open} onClose={() => setCopyDialog({ open: false, sourceBranch: '' })} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>העתק חופשות מסניף אחר</DialogTitle>
        <DialogContent>
          <TextField select fullWidth label="בחר סניף מקור" value={copyDialog.sourceBranch} sx={{ mt: 1 }}
            onChange={e => setCopyDialog(prev => ({ ...prev, sourceBranch: e.target.value }))}
          >
            {branches.filter(b => (b._id || b.id) !== selectedBranch).map(b => (
              <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
            ))}
          </TextField>
          <Alert severity="warning" sx={{ mt: 2, borderRadius: 2 }}>
            שים לב: העתקה תמחק את החופשות הקיימות בסניף הנוכחי
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCopyDialog({ open: false, sourceBranch: '' })}>ביטול</Button>
          <Button variant="contained" onClick={handleCopy} disabled={!copyDialog.sourceBranch}>העתק</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
