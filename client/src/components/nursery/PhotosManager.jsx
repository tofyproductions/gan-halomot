import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, TextField, MenuItem, Button,
  Alert, CircularProgress, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, IconButton, Snackbar, LinearProgress, ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import api, { apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import FaceTagging from './FaceTagging';
import {
  enqueue, subscribe, pump, retryFailed, discardFailed,
} from '../../utils/uploadQueue';

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
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [tagging, setTagging] = useState(null);
  const [diag, setDiag] = useState(null);
  const [draftIds, setDraftIds] = useState([]);
  const fileInput = useRef(null);
  // "מי זה?" יושב כאן ולא בטאב נפרד: הרגע שבו כדאי לתייג הוא הרגע שאחרי
  // ההעלאה, והגננת כבר על המסך הזה. המונה הוא מה שמזמין אותה פנימה.
  const [mode, setMode] = useState('gallery');
  const [waiting, setWaiting] = useState(0);
  const [queue, setQueue] = useState({ pending: 0, failed: 0, busy: false });

  // The photos feature's OWN room list — every category, this year only.
  // It used to borrow the nursery board's list, which is infant-rooms-only by
  // design and spans every year ever opened: בוגרים could never get photos,
  // and last year's rooms showed as duplicates.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/photos/classrooms');
        const rooms = res.data.classrooms || [];
        setClassrooms(rooms);
        setClassroomId(String(rooms[0]?.id || ''));
      } catch (err) {
        setError(apiError(err, 'לא הצלחנו לטעון את הכיתות'));
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
      setError(apiError(err, 'לא הצלחנו לטעון את התמונות'));
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

  /**
   * הגננת לוחצת שלח, והמסך חוזר אליה מיד.
   *
   * המתחרה כאן הוא ווטסאפ, ושם שיתוף לא מבקש שנייה אחת של המתנה. קודם היה
   * פה פס התקדמות שהיא הייתה תקועה מולו — 50 תמונות על וויפי של גן זה כ-75
   * שניות. עכשיו הקבצים מכווצים בטלפון (46 מגה הופכים ל-15), נכנסים לתור
   * ששמור על המכשיר, והעלאה קורית ברקע תמונה-תמונה.
   *
   * אם היא תסגור את האפליקציה באמצע, התור מחכה וממשיך בפתיחה הבאה. שום
   * צילום לא הולך לאיבוד בגלל מעלית בלי קליטה.
   */
  const send = async (files) => {
    setError('');
    try {
      const n = await enqueue(files, { classroomId });
      setToast(n === 1 ? 'התמונה נשלחת' : `${n} תמונות נשלחות`);
    } catch (err) {
      setError(apiError(err, 'לא הצלחנו להוסיף לתור'));
    }
  };

  /**
   * Which of the four things an upload needs is broken.
   *
   * "ההעלאה נכשלה" hides the answer: configuration, the image library, the
   * write and the signed read all look identical from here. This asks the
   * server to try each in order against a tiny generated image and say where
   * it stopped.
   */
  const runSelftest = async () => {
    setDiag({ running: true });
    try {
      const res = await api.get('/photos/selftest', { timeout: 60000 });
      setDiag(res.data);
    } catch (err) {
      setDiag({ ok: false, steps: [{ name: 'בדיקה', ok: false, detail: apiError(err) }] });
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
      setError(apiError(err, 'השמירה נכשלה'));
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
      setError(apiError(err, 'המחיקה נכשלה'));
    }
  };

  const photos = data?.photos || [];
  const children = data?.children || [];

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>תמונות</Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_, v) => v && setMode(v)}
        >
          <ToggleButton value="gallery">הגלריה</ToggleButton>
          <ToggleButton value="tagging">
            מי זה?
            {waiting > 0 && (
              <Chip label={waiting} size="small" color="primary" sx={{ ml: 1, height: 20 }} />
            )}
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {mode === 'tagging' && <FaceTagging onWaitingChange={setWaiting} />}
      {mode === 'gallery' && (
      <>

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
          disabled={!classroomId}
          onClick={() => fileInput.current?.click()}
          sx={{ whiteSpace: 'nowrap' }}
        >
          העלאת תמונות
        </Button>
      </Stack>

      {/* לא פס שחוסם — שורת מצב. היא כבר יכולה לעשות דברים אחרים. */}
      {(queue.pending > 0 || queue.failed > 0) && (
        <Alert
          severity={queue.failed ? 'warning' : 'info'}
          sx={{ mb: 2 }}
          action={queue.failed ? (
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => retryFailed()}>נסה שוב</Button>
              <Button size="small" color="inherit" onClick={() => discardFailed()}>מחק</Button>
            </Stack>
          ) : null}
        >
          {queue.pending > 0 && `נשלחות ברקע: ${queue.pending}`}
          {queue.pending > 0 && queue.failed > 0 && ' · '}
          {queue.failed > 0 && `${queue.failed} לא נשלחו`}
        </Alert>
      )}
      {queue.pending > 0 && <LinearProgress sx={{ mb: 2 }} />}
      {error && (
        <Alert
          severity="error" sx={{ mb: 2 }} onClose={() => setError('')}
          action={<Button size="small" onClick={runSelftest}>בדיקת אחסון</Button>}
        >
          {error}
        </Alert>
      )}

      {diag && (
        <Alert
          severity={diag.running ? 'info' : diag.ok ? 'success' : 'error'}
          sx={{ mb: 2 }}
          onClose={() => setDiag(null)}
        >
          {diag.running ? 'בודק…' : (
            <Stack spacing={0.5}>
              {(diag.steps || []).map((st, i) => (
                <Typography key={i} variant="body2">
                  {st.ok ? '✓' : '✗'} {st.name}{st.detail ? ` — ${st.detail}` : ''}
                </Typography>
              ))}
            </Stack>
          )}
        </Alert>
      )}

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
      </>
      )}
    </Box>
  );
}
