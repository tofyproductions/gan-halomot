import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Tabs, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, Chip, IconButton,
  Tooltip, Stack,
} from '@mui/material';
import RestoreIcon from '@mui/icons-material/Restore';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAcademicYear } from '../../hooks/useAcademicYear';
import YearSelector from '../shared/YearSelector';
import LoadingSpinner from '../shared/LoadingSpinner';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatDateHebrew } from '../../utils/hebrewYear';

const STATUS_MAP = {
  signed: { label: 'חתום', color: 'success' },
  unsigned: { label: 'לא חתום', color: 'warning' },
};

export default function ArchiveList() {
  const { selectedYear, setSelectedYear } = useAcademicYear();
  const [tab, setTab] = useState(0);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState({ open: false, id: null, action: null });

  const type = tab === 0 ? 'signed' : 'unsigned';

  const fetchData = useCallback(() => {
    setLoading(true);
    api.get(`/archives?type=${type}&year=${selectedYear}`)
      .then((res) => setData(res.data.archives || []))
      .catch(() => toast.error('שגיאה בטעינת הארכיון'))
      .finally(() => setLoading(false));
  }, [type, selectedYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRestore = async (id) => {
    try {
      await api.post(`/archives/${id}/restore`);
      toast.success('הרישום שוחזר');
      fetchData();
    } catch {
      toast.error('שגיאה בשחזור');
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/archives/${confirm.id}`);
      toast.success('הרישום נמחק לצמיתות');
      setConfirm({ open: false, id: null, action: null });
      fetchData();
    } catch {
      toast.error('שגיאה במחיקה');
    }
  };

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ארכיון רישומים</Typography>
        <YearSelector value={selectedYear} onChange={setSelectedYear} />
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab label="חתומים" />
        <Tab label="לא חתומים" />
      </Tabs>

      {loading ? (
        <LoadingSpinner />
      ) : data.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="body1" color="text.secondary">אין רישומים בארכיון</Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>תאריך מחיקה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>שם הילד/ה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>כיתה</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>סטטוס</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>פעולות</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((item) => {
                const id = item._id || item.id;
                const status = STATUS_MAP[item.archive_type] || STATUS_MAP.unsigned;
                return (
                  <TableRow key={id} hover>
                    <TableCell>{formatDateHebrew(item.archived_at)}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{item.child_name}</TableCell>
                    <TableCell>{item.classroom_name || '-'}</TableCell>
                    <TableCell>
                      <Chip label={status.label} color={status.color} size="small" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        <Tooltip title="שחזור">
                          <IconButton size="small" color="primary" onClick={() => handleRestore(id)}>
                            <RestoreIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="מחיקה לצמיתות">
                          <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, id, action: 'delete' })}>
                            <DeleteForeverIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, id: null, action: null })}
        onConfirm={handleDelete}
        title="מחיקה לצמיתות"
        message="האם למחוק את הרישום לצמיתות? לא ניתן יהיה לשחזר אותו."
      />
    </Box>
  );
}
