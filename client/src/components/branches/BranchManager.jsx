import { useState } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import ConfirmDialog from '../shared/ConfirmDialog';

export default function BranchManager() {
  const { branches, fetchBranches } = useBranch();
  const [dialog, setDialog] = useState({ open: false, mode: 'add', id: null, name: '', address: '' });
  const [confirm, setConfirm] = useState({ open: false, id: null });

  const openAdd = () => setDialog({ open: true, mode: 'add', id: null, name: '', address: '' });

  const openEdit = (branch) => setDialog({
    open: true, mode: 'edit', id: branch._id || branch.id,
    name: branch.name, address: branch.address || '',
  });

  const closeDialog = () => setDialog({ open: false, mode: 'add', id: null, name: '', address: '' });

  const handleSave = async () => {
    const { mode, id, name, address } = dialog;
    if (!name.trim()) {
      toast.error('שם הסניף חובה');
      return;
    }

    try {
      if (mode === 'add') {
        await api.post('/branches', { name: name.trim(), address: address.trim() });
        toast.success('סניף נוסף בהצלחה');
      } else {
        await api.put(`/branches/${id}`, { name: name.trim(), address: address.trim() });
        toast.success('סניף עודכן');
      }
      closeDialog();
      fetchBranches();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    }
  };

  const handleDelete = async () => {
    if (!confirm.id) return;
    try {
      await api.delete(`/branches/${confirm.id}`);
      toast.success('סניף הוסר');
      setConfirm({ open: false, id: null });
      fetchBranches();
    } catch {
      toast.error('שגיאה במחיקה');
    }
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 800, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול סניפים</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          הוסף סניף
        </Button>
      </Stack>

      {branches.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary">אין סניפים. הוסף את הסניף הראשון.</Typography>
        </Box>
      ) : (
        <Stack spacing={2}>
          {branches.map((branch) => (
            <Card key={branch._id || branch.id} sx={{ borderRight: '5px solid #f59e0b' }}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>{branch.name}</Typography>
                    {branch.address && (
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                        <LocationOnIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                        <Typography variant="body2" color="text.secondary">{branch.address}</Typography>
                      </Stack>
                    )}
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="עריכה">
                      <IconButton size="small" onClick={() => openEdit(branch)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="מחיקה">
                      <IconButton size="small" color="error" onClick={() => setConfirm({ open: true, id: branch._id || branch.id })}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialog.open} onClose={closeDialog} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {dialog.mode === 'add' ? 'הוסף סניף חדש' : 'ערוך סניף'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="שם הסניף"
              value={dialog.name}
              onChange={(e) => setDialog(prev => ({ ...prev, name: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="כתובת"
              value={dialog.address}
              onChange={(e) => setDialog(prev => ({ ...prev, address: e.target.value }))}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSave}>שמור</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, id: null })}
        onConfirm={handleDelete}
        title="מחיקת סניף"
        message="האם למחוק את הסניף?"
      />
    </Box>
  );
}
