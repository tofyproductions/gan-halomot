import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Stack,
  IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
  Divider, Chip, Table, TableBody, TableCell, TableHead, TableRow,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import SchoolIcon from '@mui/icons-material/School';
import SaveIcon from '@mui/icons-material/Save';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';
import { useAcademicYear } from '../../hooks/useAcademicYear';
import ConfirmDialog from '../shared/ConfirmDialog';

export default function BranchManager() {
  const { branches, fetchBranches } = useBranch();
  const { years } = useAcademicYear();

  // Branch dialog
  const [branchDialog, setBranchDialog] = useState({ open: false, mode: 'add', id: null, name: '', address: '' });
  // Classroom dialog
  const [classDialog, setClassDialog] = useState({ open: false, branchId: null, id: null, name: '', capacity: 35 });
  // Confirm delete
  const [confirm, setConfirm] = useState({ open: false, type: null, id: null, message: '' });
  // Classrooms per branch
  const [classroomsByBranch, setClassroomsByBranch] = useState({});
  // Inline editing capacity
  const [editingCapacity, setEditingCapacity] = useState({});

  // Fetch classrooms for all branches
  const fetchClassrooms = useCallback(async () => {
    const result = {};
    for (const b of branches) {
      const bid = b._id || b.id;
      try {
        const res = await api.get(`/classrooms?branch=${bid}`);
        result[bid] = res.data.classrooms || [];
      } catch {
        result[bid] = [];
      }
    }
    setClassroomsByBranch(result);
  }, [branches]);

  useEffect(() => {
    if (branches.length > 0) fetchClassrooms();
  }, [branches, fetchClassrooms]);

  // --- Branch CRUD ---
  const openAddBranch = () => setBranchDialog({ open: true, mode: 'add', id: null, name: '', address: '' });
  const openEditBranch = (b) => setBranchDialog({ open: true, mode: 'edit', id: b._id || b.id, name: b.name, address: b.address || '' });
  const closeBranchDialog = () => setBranchDialog({ open: false, mode: 'add', id: null, name: '', address: '' });

  const handleSaveBranch = async () => {
    const { mode, id, name, address } = branchDialog;
    if (!name.trim()) return toast.error('שם הסניף חובה');
    try {
      if (mode === 'add') {
        await api.post('/branches', { name: name.trim(), address: address.trim() });
        toast.success('סניף נוסף');
      } else {
        await api.put(`/branches/${id}`, { name: name.trim(), address: address.trim() });
        toast.success('סניף עודכן');
      }
      closeBranchDialog();
      fetchBranches();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  // --- Classroom CRUD ---
  const openAddClass = (branchId) => setClassDialog({ open: true, branchId, id: null, name: '', capacity: 35 });
  const closeClassDialog = () => setClassDialog({ open: false, branchId: null, id: null, name: '', capacity: 35 });

  const handleSaveClass = async () => {
    const { branchId, name, capacity } = classDialog;
    if (!name.trim()) return toast.error('שם הכיתה חובה');
    try {
      await api.post('/classrooms', {
        name: name.trim(),
        capacity: parseInt(capacity) || 35,
        academic_year: years.current.range,
        branch_id: branchId,
      });
      toast.success('כיתה נוספה');
      closeClassDialog();
      fetchClassrooms();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handleUpdateCapacity = async (classroomId, newCapacity) => {
    try {
      await api.put(`/classrooms/${classroomId}`, { capacity: parseInt(newCapacity) || 0 });
      toast.success('תפוסה עודכנה');
      setEditingCapacity({});
      fetchClassrooms();
    } catch {
      toast.error('שגיאה בעדכון');
    }
  };

  const handleUpdateClassName = async (classroomId, newName) => {
    if (!newName.trim()) return;
    try {
      await api.put(`/classrooms/${classroomId}`, { name: newName.trim() });
      toast.success('שם הכיתה עודכן');
      fetchClassrooms();
    } catch {
      toast.error('שגיאה בעדכון');
    }
  };

  // --- Confirm delete ---
  const handleConfirmDelete = async () => {
    const { type, id } = confirm;
    try {
      if (type === 'branch') {
        await api.delete(`/branches/${id}`);
        toast.success('סניף הוסר');
        fetchBranches();
      } else if (type === 'classroom') {
        await api.delete(`/classrooms/${id}`);
        toast.success('כיתה הוסרה');
        fetchClassrooms();
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
    setConfirm({ open: false, type: null, id: null, message: '' });
  };

  return (
    <Box dir="rtl" sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול סניפים וכיתות</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAddBranch}>
          הוסף סניף
        </Button>
      </Stack>

      {branches.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary">אין סניפים. הוסף את הסניף הראשון.</Typography>
        </Box>
      ) : (
        <Stack spacing={3}>
          {branches.map((branch) => {
            const bid = branch._id || branch.id;
            const classrooms = classroomsByBranch[bid] || [];
            const totalCapacity = classrooms.reduce((s, c) => s + (c.capacity || 0), 0);
            const totalChildren = classrooms.reduce((s, c) => s + (c.child_count || 0), 0);

            return (
              <Card key={bid} sx={{ borderRight: '5px solid #f59e0b' }}>
                <CardContent>
                  {/* Branch Header */}
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
                    <Box>
                      <Typography variant="h6" sx={{ fontWeight: 700 }}>{branch.name}</Typography>
                      {branch.address && (
                        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                          <LocationOnIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary">{branch.address}</Typography>
                        </Stack>
                      )}
                      <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
                        <Chip size="small" label={`${classrooms.length} כיתות`} variant="outlined" />
                        <Chip size="small" label={`${totalChildren} ילדים`} color="primary" variant="outlined" />
                        <Chip size="small" label={`תפוסה: ${totalCapacity}`} color="secondary" variant="outlined" />
                      </Stack>
                    </Box>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="ערוך סניף">
                        <IconButton size="small" onClick={() => openEditBranch(branch)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="מחק סניף">
                        <IconButton size="small" color="error" onClick={() =>
                          setConfirm({ open: true, type: 'branch', id: bid, message: `למחוק את הסניף "${branch.name}"?` })
                        }>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>

                  <Divider sx={{ mb: 2 }} />

                  {/* Classrooms Table */}
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <SchoolIcon fontSize="small" /> כיתות - {years.current.range}
                    </Typography>
                    <Button size="small" startIcon={<AddIcon />} onClick={() => openAddClass(bid)}>
                      הוסף כיתה
                    </Button>
                  </Stack>

                  {classrooms.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                      אין כיתות. הוסף כיתה ראשונה.
                    </Typography>
                  ) : (
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>שם הכיתה</TableCell>
                          <TableCell sx={{ fontWeight: 700 }} align="center">תפוסה מקסימלית</TableCell>
                          <TableCell sx={{ fontWeight: 700 }} align="center">ילדים רשומים</TableCell>
                          <TableCell sx={{ fontWeight: 700 }} align="center">פעולות</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {classrooms.map((cls) => {
                          const cid = cls._id || cls.id;
                          const isEditing = editingCapacity[cid] !== undefined;
                          return (
                            <TableRow key={cid} hover>
                              <TableCell>
                                <EditableText
                                  value={cls.name}
                                  onSave={(val) => handleUpdateClassName(cid, val)}
                                />
                              </TableCell>
                              <TableCell align="center">
                                {isEditing ? (
                                  <Stack direction="row" spacing={0.5} justifyContent="center" alignItems="center">
                                    <TextField
                                      size="small"
                                      type="number"
                                      value={editingCapacity[cid]}
                                      onChange={(e) => setEditingCapacity(prev => ({ ...prev, [cid]: e.target.value }))}
                                      inputProps={{ style: { textAlign: 'center', width: 50, padding: '4px 8px' } }}
                                      autoFocus
                                    />
                                    <IconButton size="small" color="primary" onClick={() => handleUpdateCapacity(cid, editingCapacity[cid])}>
                                      <SaveIcon fontSize="small" />
                                    </IconButton>
                                  </Stack>
                                ) : (
                                  <Chip
                                    label={cls.capacity || '—'}
                                    size="small"
                                    onClick={() => setEditingCapacity({ [cid]: cls.capacity || 0 })}
                                    sx={{ cursor: 'pointer', fontWeight: 700 }}
                                  />
                                )}
                              </TableCell>
                              <TableCell align="center">
                                <Typography sx={{
                                  fontWeight: 700,
                                  color: cls.child_count > (cls.capacity || 999) ? 'error.main' : 'success.main',
                                }}>
                                  {cls.child_count || 0}
                                </Typography>
                              </TableCell>
                              <TableCell align="center">
                                <Tooltip title="מחק כיתה">
                                  <IconButton size="small" color="error" onClick={() =>
                                    setConfirm({ open: true, type: 'classroom', id: cid, message: `למחוק את הכיתה "${cls.name}"?` })
                                  }>
                                    <DeleteIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* Branch Add/Edit Dialog */}
      <Dialog open={branchDialog.open} onClose={closeBranchDialog} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {branchDialog.mode === 'add' ? 'הוסף סניף חדש' : 'ערוך סניף'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="שם הסניף"
              value={branchDialog.name}
              onChange={(e) => setBranchDialog(prev => ({ ...prev, name: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="כתובת"
              value={branchDialog.address}
              onChange={(e) => setBranchDialog(prev => ({ ...prev, address: e.target.value }))}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeBranchDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSaveBranch}>שמור</Button>
        </DialogActions>
      </Dialog>

      {/* Classroom Add Dialog */}
      <Dialog open={classDialog.open} onClose={closeClassDialog} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>הוסף כיתה</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="שם הכיתה"
              value={classDialog.name}
              onChange={(e) => setClassDialog(prev => ({ ...prev, name: e.target.value }))}
              fullWidth
              required
              placeholder="לדוגמה: תינוקייה א"
            />
            <TextField
              label="תפוסה מקסימלית"
              type="number"
              value={classDialog.capacity}
              onChange={(e) => setClassDialog(prev => ({ ...prev, capacity: e.target.value }))}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeClassDialog}>ביטול</Button>
          <Button variant="contained" onClick={handleSaveClass}>הוסף</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirm.open}
        onClose={() => setConfirm({ open: false, type: null, id: null, message: '' })}
        onConfirm={handleConfirmDelete}
        title="אישור מחיקה"
        message={confirm.message}
      />
    </Box>
  );
}

/* Inline editable text - double click to edit */
function EditableText({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);

  if (editing) {
    return (
      <TextField
        size="small"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== value) onSave(text);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (text.trim() !== value) onSave(text);
            setEditing(false);
          }
          if (e.key === 'Escape') {
            setText(value);
            setEditing(false);
          }
        }}
        autoFocus
        inputProps={{ style: { padding: '4px 8px' } }}
      />
    );
  }

  return (
    <Typography
      sx={{ fontWeight: 600, cursor: 'pointer', '&:hover': { color: 'primary.main' } }}
      onDoubleClick={() => setEditing(true)}
      title="לחיצה כפולה לעריכה"
    >
      {value}
    </Typography>
  );
}
