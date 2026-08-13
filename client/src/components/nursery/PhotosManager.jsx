import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, TextField, MenuItem, Button,
  Alert, CircularProgress, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, IconButton, Snackbar, LinearProgress, ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api from '../../api/client';

/**
 * The gan's photographs, staff side.
 *
 * Uploading and tagging are separate on purpose. A teacher comes in from the
 * garden with thirty photographs and wants them off her phone; deciding who is
 * in each one is a different job, done sitting down. Forcing them into one step
 * means either the upload waits for the quiet moment or the tagging never
 * happens at all.
 *
 * So an untagged photograph is a normal state. It is already in the classroom
 * gallery every parent of the room sees; tagging only adds it to a family's
 * "photographs of my child". The "לא מסומנות" filter is what makes catching up
 * possible without hunting.
 */
export default function PhotosManager() {
  const [data, setData] = useState(null);
  const [classrooms, setClassrooms] = useState([]);
  const [classroomId, setClassroomId] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [tagging, setTagging] = useState(null);
  const [draftIds, setDraftIds] = useState([]);
  const fileInput = useRef(null);

  // The classroom list comes from the board, which already answers "which
  // rooms may this user act on" with the branch scoping applied.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/nursery/board');
        setClassrooms(res.data.classrooms || []);
        setClassroomId(String(res.data.classroom?.id || ''));
      } catch (err) {
        setError(err.response?.data?.error || 'לא הצלחנו לטעון את הכיתות');
        setLoading(false);
      }
    })();
  }, []);

  const load = useCallback(async (room = classroomId, f = filter) => {
    if (!room) return;
    setLoading(true);
    setError('');
    try {
      const params = { classroom: room };
      if (f === 'untagged') params.untagged = '1';
      const res = await api.get('/photos', { params });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו לטעון את התמונות');
    } finally {
      setLoading(false);
    }
  }, [classroomId, filter]);

  useEffect(() => { if (classroomId) load(classroomId, filter); /* eslint-disable-next-line */ }, [classroomId]);

  const pick = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) send(files);
  };

  const send = async (files) => {
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      files.slice(0, 30).forEach(f => form.append('photos', f));
      form.append('classroom_id', classroomId);
      const res = await api.post('/photos/upload', form);
      setToast(`${res.data.saved} תמונות הועלו`);
      if (res.data.failed?.length) setError(`${res.data.failed.length} קבצים לא נקלטו`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'ההעלאה נכשלה');
    } finally {
      setUploading(false);
    }
  };

  const openTagging = (photo) => {
    setTagging(photo);
    setDraftIds((photo.child_ids || []).map(String));
  };

  const saveTags = async () => {
    try {
      await api.patch(`/photos/${tagging.id || tagging._id}`, { child_ids: draftIds });
      setTagging(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'השמירה נכשלה');
    }
  };

  const remove = async (photo) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('למחוק את התמונה? הפעולה אינה הפיכה.')) return;
    try {
      await api.delete(`/photos/${photo.id || photo._id}`);
      setTagging(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'המחיקה נכשלה');
    }
  };

  const photos = data?.photos || [];
  const children = data?.children || [];

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', pb: 6 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>תמונות</Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          select label="כיתה" size="small" value={classroomId} fullWidth
          onChange={(e) => { setClassroomId(e.target.value); }}
        >
          {classrooms.map(c => (
            <MenuItem key={c.id} value={String(c.id)}>{c.branch} — {c.name}</MenuItem>
          ))}
        </TextField>

        <ToggleButtonGroup
          size="small" exclusive value={filter}
          onChange={(_, v) => { if (v) { setFilter(v); load(classroomId, v); } }}
        >
          <ToggleButton value="all">הכל</ToggleButton>
          <ToggleButton value="untagged">לא מסומנות</ToggleButton>
        </ToggleButtonGroup>

        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={pick} />
        <Button
          variant="contained" startIcon={<AddPhotoAlternateIcon />}
          disabled={uploading || !classroomId}
          onClick={() => fileInput.current?.click()}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {uploading ? 'מעלה…' : 'העלאת תמונות'}
        </Button>
      </Stack>

      {uploading && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Alert severity="info" sx={{ mb: 2 }}>
        כל תמונה שמועלית נראית להורי הכיתה. סימון מי בתמונה מוסיף אותה גם לגלריה האישית של אותו ילד.
      </Alert>

      {loading && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}

      {!loading && photos.length === 0 && (
        <Alert severity="info">
          {filter === 'untagged' ? 'כל התמונות מסומנות.' : 'אין עדיין תמונות בכיתה זו.'}
        </Alert>
      )}

      <Box sx={{
        display: 'grid', gap: 1,
        gridTemplateColumns: { xs: 'repeat(3, 1fr)', sm: 'repeat(4, 1fr)', md: 'repeat(6, 1fr)' },
      }}>
        {photos.map(p => (
          <Box
            key={p._id || p.id}
            onClick={() => openTagging(p)}
            sx={{
              position: 'relative', aspectRatio: '1', borderRadius: 2,
              overflow: 'hidden', cursor: 'pointer', bgcolor: 'action.hover',
            }}
          >
            <Box component="img" src={p.thumb_url} alt="" loading="lazy"
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            {(p.child_ids || []).length === 0 && (
              <Chip label="לא מסומנת" size="small" color="warning"
                sx={{ position: 'absolute', bottom: 4, insetInlineStart: 4 }} />
            )}
          </Box>
        ))}
      </Box>

      <Dialog open={!!tagging} onClose={() => setTagging(null)} fullWidth maxWidth="sm">
        <DialogTitle>מי בתמונה?</DialogTitle>
        <DialogContent>
          {tagging && (
            <Stack spacing={2}>
              <Box component="img" src={tagging.url || tagging.thumb_url} alt=""
                sx={{ width: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 2 }} />
              <Stack direction="row" flexWrap="wrap" gap={0.75}>
                {children.map(c => {
                  const on = draftIds.includes(String(c.id));
                  return (
                    <Chip
                      key={c.id} label={c.name} size="small"
                      color={on ? 'primary' : 'default'}
                      variant={on ? 'filled' : 'outlined'}
                      onClick={() => setDraftIds(d => (
                        on ? d.filter(x => x !== String(c.id)) : [...d, String(c.id)]
                      ))}
                    />
                  );
                })}
              </Stack>
              {children.length === 0 && (
                <Alert severity="info">אין ילדים פעילים בכיתה זו לסימון.</Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <IconButton color="error" onClick={() => remove(tagging)} aria-label="מחיקה">
            <DeleteOutlineIcon />
          </IconButton>
          <Box>
            <Button onClick={() => setTagging(null)}>ביטול</Button>
            <Button variant="contained" onClick={saveTags}>שמירה</Button>
          </Box>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast('')} message={toast} />
    </Box>
  );
}
