import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, TextField, MenuItem, Button,
  Alert, CircularProgress, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, IconButton, Snackbar, LinearProgress, ToggleButton,
  ToggleButtonGroup, Paper,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
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
  const [queue, setQueue] = useState({ pending: 0, failed: 0, duplicates: 0, busy: false });
  // בחירה מרובה. ברגע שמשהו מסומן, הקשה על תמונה מסמנת ולא פותחת — זו
  // ההתנהגות של כל גלריה, והיא חוסכת מצב-עריכה שצריך להיכנס אליו ולצאת.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkChildIds, setBulkChildIds] = useState([]);
  const [bulkMode, setBulkMode] = useState('add');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyBulk, setBusyBulk] = useState(false);

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

  useEffect(() => {
    // הבחירה מתאפסת בכל החלפת כיתה. בלי זה גננת שבחרה עשרים תמונות
    // בתינוקייה, עברה לבוגרים והקישה "מחיקה" הייתה מוחקת את העשרים מהחדר
    // השני — המסך כבר לא מציג אותן, והמספר בסרגל נראה כאילו הוא מדבר על מה
    // שמולה.
    clearSelection();
    if (classroomId) load(classroomId, filter);
    /* eslint-disable-next-line */
  }, [classroomId]);

  const pick = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) send(files);
  };

  const idOf = (p) => String(p._id || p.id);
  const selectionMode = selected.size > 0;

  const toggleSelect = (p) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const id = idOf(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(photos.map(idOf)));

  // תמונה אחת יכולה לשאת כמה ילדים, ולכן הבחירה כאן מרובה גם היא.
  const applyBulkTag = async () => {
    setBusyBulk(true);
    try {
      const { data } = await api.post('/photos/bulk-tag', {
        photo_ids: [...selected],
        child_ids: bulkChildIds,
        mode: bulkMode,
      });
      // רוב התיוגים מהגלריה לא מלמדים כלום — רק אלה שבהם נשאר פרצוף אחד
      // בלי שם. שווה להגיד כשזה כן קרה.
      const learned = data.taught
        ? ` · ${data.taught} ${data.taught === 1 ? 'לימדה' : 'לימדו'} את הזיהוי`
        : '';
      setToast(`${data.changed} ${data.changed === 1 ? 'תמונה סומנה' : 'תמונות סומנו'}${learned}`);
      setBulkTagOpen(false);
      setBulkChildIds([]);
      clearSelection();
      await load();
    } catch (err) {
      setError(apiError(err, 'הסימון נכשל'));
    } finally { setBusyBulk(false); }
  };

  const applyBulkDelete = async () => {
    setBusyBulk(true);
    try {
      const { data } = await api.post('/photos/bulk-delete', { photo_ids: [...selected] });
      setToast(`${data.deleted} ${data.deleted === 1 ? 'תמונה נמחקה' : 'תמונות נמחקו'}`);
      setConfirmDelete(false);
      clearSelection();
      await load();
    } catch (err) {
      setError(apiError(err, 'המחיקה נכשלה'));
    } finally { setBusyBulk(false); }
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
      const { queued, rejected } = await enqueue(files, { classroomId });
      if (queued) setToast(queued === 1 ? 'התמונה נשלחת' : `${queued} תמונות נשלחות`);
      // HEIC שלא הצלחנו להמיר — נאמר עכשיו ולא אחרי שלוש נסיעות רשת
      // שנגמרות ב"לא הצלחנו לעבד את הקובץ".
      if (rejected.length) {
        setError(`${rejected.length} ${rejected.length === 1 ? 'קובץ לא נשלח' : 'קבצים לא נשלחו'}: `
          + rejected[0].error);
      }
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
          onChange={(_, v) => { if (v) { clearSelection(); setFilter(v); load(classroomId, v); } }}
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
        {photos.map(p => {
          const id = idOf(p);
          const isSelected = selected.has(id);
          return (
            <Box
              key={id}
              // ברגע שמשהו מסומן, הקשה מסמנת ולא פותחת. אחרת גננת שבחרה
              // עשרים תמונות והקישה על העשרים ואחת הייתה מאבדת את הבחירה
              // לתוך דיאלוג שלא ביקשה.
              onClick={() => (selectionMode ? toggleSelect(p) : openTagging(p))}
              sx={{
                position: 'relative', aspectRatio: '1', borderRadius: 2,
                overflow: 'hidden', cursor: 'pointer', bgcolor: 'action.hover',
                outline: isSelected ? '3px solid' : 'none',
                outlineColor: 'primary.main',
                outlineOffset: '-3px',
              }}
            >
              <Box
                component="img" src={p.thumb_url} alt="" loading="lazy"
                sx={{
                  width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                  opacity: isSelected ? 0.75 : 1, transition: 'opacity .12s',
                }}
              />

              {/* הסימון עצמו — תמיד גלוי, כי על טלפון אין ריחוף. */}
              <Box
                role="checkbox"
                aria-checked={isSelected}
                aria-label="בחירה"
                onClick={(e) => { e.stopPropagation(); toggleSelect(p); }}
                sx={{
                  position: 'absolute', top: 4, insetInlineEnd: 4,
                  display: 'flex',
                  borderRadius: '50%',
                  // דרך הערכה ולא כתיבה ידנית של הצבע: העיגול יושב על תמונה,
                  // ולכן הוא חייב להיות לבן חלקית כדי שהסימון ייראה על רקע
                  // בהיר. ראצ'ט design-hex סופר כל צבע שנכתב ביד, והוא צודק.
                  bgcolor: (t) => alpha(t.palette.common.white, 0.85),
                  color: isSelected ? 'primary.main' : 'text.disabled', lineHeight: 0, p: '1px',
                }}
              >
                {isSelected ? <CheckCircleIcon /> : <RadioButtonUncheckedIcon />}
              </Box>

              {(p.child_ids || []).length === 0 && (
                <Chip label="לא מסומנת" size="small" color="warning"
                  sx={{ position: 'absolute', bottom: 4, insetInlineStart: 4 }} />
              )}
              {(p.child_ids || []).length > 0 && (
                <Chip
                  label={(p.child_ids || []).length} size="small" color="success"
                  sx={{ position: 'absolute', bottom: 4, insetInlineStart: 4, minWidth: 28 }}
                />
              )}
            </Box>
          );
        })}
      </Box>

      {/* סרגל הפעולות. צף בתחתית כדי שהאגודל יגיע אליו בלי לגלול חזרה. */}
      {selectionMode && (
        <Paper
          elevation={8}
          sx={{
            position: 'sticky', bottom: 12, mt: 2, p: 1.5, borderRadius: 3,
            display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
          }}
        >
          <Typography variant="subtitle2" sx={{ me: 1 }}>
            {`נבחרו ${selected.size}`}
          </Typography>
          <Button size="small" onClick={selectAll}>בחר הכל</Button>
          <Button size="small" color="inherit" onClick={clearSelection}>נקה</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small" variant="contained" startIcon={<LocalOfferIcon />}
            onClick={() => { setBulkChildIds([]); setBulkMode('add'); setBulkTagOpen(true); }}
          >
            סימון ילדים
          </Button>
          <Button
            size="small" color="error" startIcon={<DeleteOutlineIcon />}
            onClick={() => setConfirmDelete(true)}
          >
            מחיקה
          </Button>
        </Paper>
      )}

      {/* סימון קבוצתי. תמונה אחת יכולה לשאת כמה ילדים, ולכן גם הבחירה כאן. */}
      <Dialog open={bulkTagOpen} onClose={() => setBulkTagOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{`מי מופיע ב-${selected.size} התמונות?`}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Stack direction="row" flexWrap="wrap" sx={{ gap: 1 }}>
              {(data?.children || []).map(c => {
                const on = bulkChildIds.includes(String(c.id));
                return (
                  <Chip
                    key={c.id}
                    label={c.name}
                    color={on ? 'primary' : 'default'}
                    variant={on ? 'filled' : 'outlined'}
                    onClick={() => setBulkChildIds(prev => (on
                      ? prev.filter(x => x !== String(c.id))
                      : [...prev, String(c.id)]))}
                  />
                );
              })}
            </Stack>

            <ToggleButtonGroup
              size="small" exclusive value={bulkMode}
              onChange={(_, v) => v && setBulkMode(v)}
            >
              <ToggleButton value="add">הוספה לסימון הקיים</ToggleButton>
              <ToggleButton value="replace">החלפה</ToggleButton>
            </ToggleButtonGroup>

            <Typography variant="caption" color="text.secondary">
              {bulkMode === 'add'
                ? 'מי שכבר מסומן בתמונה יישאר מסומן.'
                : 'הסימון הקיים בתמונות האלה יימחק ויוחלף במה שנבחר כאן.'}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkTagOpen(false)}>ביטול</Button>
          <Button
            variant="contained"
            disabled={busyBulk || (bulkMode === 'add' && !bulkChildIds.length)}
            onClick={applyBulkTag}
          >
            {busyBulk ? 'שומר…' : 'שמירה'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* מחיקה היא הפעולה היחידה כאן שאי אפשר לבטל, ולכן היא נאמרת במספרים. */}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>{`למחוק ${selected.size} תמונות?`}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            התמונות יימחקו לצמיתות, גם מהגלריה של ההורים. אי אפשר לבטל.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>ביטול</Button>
          <Button color="error" variant="contained" disabled={busyBulk} onClick={applyBulkDelete}>
            {busyBulk ? 'מוחק…' : 'מחיקה'}
          </Button>
        </DialogActions>
      </Dialog>

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
