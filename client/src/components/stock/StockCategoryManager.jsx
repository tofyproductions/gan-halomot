import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField,
  IconButton, Box, Typography, Divider,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import api from '../../api/client';
import { toast } from 'react-toastify';

export default function StockCategoryManager({ open, onClose, categories, branchId, onChanged }) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.post('/stock/categories', { branch_id: branchId, name, sort_order: (categories.length + 1) * 10 });
      setNewName('');
      onChanged?.();
      toast.success('קטגוריה נוספה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בהוספה');
    }
  }

  async function handleSaveEdit() {
    if (!editing || !editName.trim()) return;
    try {
      await api.patch(`/stock/categories/${editing._id}`, { name: editName.trim() });
      setEditing(null);
      onChanged?.();
      toast.success('שם עודכן');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בעדכון');
    }
  }

  async function handleDelete(c) {
    if (!confirm(`למחוק קטגוריה "${c.name}"?`)) return;
    try {
      await api.delete(`/stock/categories/${c._id}`);
      onChanged?.();
      toast.success('נמחקה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה במחיקה');
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>ניהול קטגוריות מלאי</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1}>
            <TextField
              label="קטגוריה חדשה" placeholder="למשל: ציוד משרדי"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              fullWidth size="small"
            />
            <Button variant="contained" onClick={handleAdd} disabled={!newName.trim()}>הוסף</Button>
          </Stack>
          <Divider />
          {categories.length === 0 ? (
            <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>אין קטגוריות עדיין</Typography>
          ) : (
            categories.map(c => (
              <Box key={c._id} sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, border: '1px solid #e2e8f0', borderRadius: 1 }}>
                {editing?._id === c._id ? (
                  <>
                    <TextField
                      value={editName} onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
                      size="small" fullWidth autoFocus
                    />
                    <Button size="small" variant="contained" onClick={handleSaveEdit}>שמור</Button>
                    <Button size="small" onClick={() => setEditing(null)}>ביטול</Button>
                  </>
                ) : (
                  <>
                    <Typography sx={{ flex: 1, fontWeight: 700 }}>{c.name}</Typography>
                    <IconButton size="small" onClick={() => { setEditing(c); setEditName(c.name); }}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" color="error" onClick={() => handleDelete(c)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </>
                )}
              </Box>
            ))
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
