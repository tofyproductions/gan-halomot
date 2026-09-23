import { useState, useEffect, useRef } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Alert, CircularProgress, Button,
  Dialog, IconButton, Snackbar,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import PersonOffIcon from '@mui/icons-material/PersonOff';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { TextField, MenuItem } from '@mui/material';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import parentApi, { parentApiError, UPLOAD_TIMEOUT_MS } from '../../api/parentClient';

/**
 * The week, in photographs.
 *
 * Two rows, and the difference between them is deliberate and worth the
 * parent understanding it at a glance: the top one is their child, the bottom
 * one is what the room did. A single merged grid would bury the four frames a
 * parent actually came for under forty of somebody else's morning.
 *
 * Horizontal, not a grid. A phone screen fits three thumbnails across and
 * eight down; as a grid the classroom row would push everything else off the
 * screen, and a parent opening the app between meetings wants to swipe, not
 * scroll past.
 *
 * Thumbnails load, full size opens on tap. Twenty full photographs to fill a
 * 400-pixel-wide screen is twenty times the data anybody needed.
 */

function Row({ title, subtitle, photos, onOpen, empty }) {
  const scroller = useRef(null);

  if (!photos.length) {
    return (
      <Box>
        <Typography variant="h5">{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{empty}</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5">{title}</Typography>
      {subtitle && (
        <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
      )}
      <Box
        ref={scroller}
        sx={{
          display: 'flex', gap: 1.25, mt: 1.5, pb: 1,
          overflowX: 'auto',
          // Each thumbnail snaps into place, so a swipe lands on a photograph
          // rather than halfway between two.
          scrollSnapType: 'x mandatory',
          '&::-webkit-scrollbar': { height: 6 },
        }}
      >
        {photos.map(p => (
          <Box
            key={p.id}
            onClick={() => onOpen(p)}
            sx={{
              flex: '0 0 auto', width: 142, height: 142,
              borderRadius: '16px', overflow: 'hidden', cursor: 'pointer',
              scrollSnapAlign: 'start', bgcolor: 'action.hover',
              border: '1px solid', borderColor: 'divider',
              transition: 'transform .18s cubic-bezier(.22,1,.36,1)',
              '&:active': { transform: 'scale(0.96)' },
            }}
          >
            <Box
              component="img"
              src={p.thumb_url}
              alt={p.caption || ''}
              loading="lazy"
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export default function PhotoGallery({ childId, childName }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState('');
  const fileInput = useRef(null);

  const load = async () => {
    try {
      const res = await parentApi.get(`/children/${childId}/photos`);
      setData(res.data);
    } catch (err) {
      setError(parentApiError(err, 'לא הצלחנו לטעון את התמונות'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [childId]);

  useEffect(() => {
    parentApi.get('/photo-digest')
      .then(({ data }) => setDigest(data.mode))
      .catch(() => {});
  }, []);

  const setDigestMode = async (mode) => {
    setDigest(mode);
    try {
      await parentApi.post('/photo-digest', { mode });
      setToast({
        daily: 'נעדכן אתכם פעם ביום',
        weekly: 'סיכום שבועי, בשישי',
        off: 'לא נשלח התראות על תמונות',
      }[mode]);
    } catch { setError('ההגדרה לא נשמרה'); }
  };

  const pick = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    send(files);
  };

  /**
   * ההורה הוא הסמכות על מי הילד שלו.
   *
   * שתי פעולות שנראות דומות ואסור שיהיו אותו כפתור: "זה לא הילד שלי" הוא
   * תיקון — התג יורד לכולם והמערכת לומדת ממנו. "אל תציג לי את זה" הוא העדפה
   * — התמונה נכונה, פשוט לא רוצים אותה, ואסור ללמוד מזה כלום. אם נאחד אותם,
   * הורה שמסתיר תמונה שהילד שלו בוכה בה מלמד את המערכת שהילד שלו הוא לא
   * הילד שלו, ואחרי עשר כאלה הגלריה של המשפחה תפסיק לעבוד.
   */
  const decide = async (photo, action, faceIndex) => {
    setBusy(true);
    try {
      await parentApi.post(`/children/${childId}/photos/${photo.id}/faces`, {
        action, face_index: faceIndex,
      });
      setToast({
        not_my_child: 'תודה, הסימון הוסר',
        hide: 'התמונה לא תוצג לכם יותר',
        is_my_child: 'סומן. הגן יאשר, ומאז נזהה לבד',
      }[action] || 'נשמר');
      setOpen(null);
      await load();
    } catch (err) {
      setError(parentApiError(err, 'הפעולה לא הצליחה'));
    } finally {
      setBusy(false);
    }
  };

  const send = async (files) => {
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      files.slice(0, 5).forEach(f => form.append('photos', f));
      const res = await parentApi.post(`/children/${childId}/photos`, form, { timeout: UPLOAD_TIMEOUT_MS });
      setToast(res.data.saved === 1 ? 'התמונה נשמרה' : `${res.data.saved} תמונות נשמרו`);
      if (res.data.failed?.length) {
        setError(`${res.data.failed.length} קבצים לא נקלטו`);
      }
      await load();
    } catch (err) {
      setError(parentApiError(err, 'ההעלאה נכשלה'));
    } finally {
      setUploading(false);
    }
  };

  if (loading) {
    return <Stack alignItems="center" sx={{ py: 5 }}><CircularProgress size={28} /></Stack>;
  }

  if (data && data.storage_ready === false) {
    return <Alert severity="info">התמונות עדיין לא זמינות. בקרוב.</Alert>;
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <Card>
        <CardContent>
          <Row
            title={`התמונות של ${childName}`}
            photos={data?.mine || []}
            onOpen={setOpen}
            empty="עדיין אין תמונות מסומנות. תמונות שהגן מסמן שהילד מופיע בהן יופיעו כאן."
          />

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={pick}
            />
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddPhotoAlternateIcon />}
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              sx={{ flexShrink: 0 }}
            >
              {uploading ? 'מעלה…' : 'הוספת תמונה'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              תמונות שתעלו נשמרות לבחירת מתנות ונראות לכם ולצוות בלבד.
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Row
            title="הכיתה השבוע"
            subtitle={`תמונות שצוות הגן צילם ב-${data?.window_days || 7} הימים האחרונים`}
            photos={data?.classroom || []}
            onOpen={setOpen}
            empty="הצוות עוד לא העלה תמונות השבוע."
          />
          {(data?.classroom || []).length > 0 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              בתמונות הכיתה מופיעים גם ילדים אחרים. הן לצפייה משפחתית — נא לא לשתף מחוץ למשפחה.
            </Alert>
          )}

          {/* מתי לעדכן אתכם. פעם ביום היא ברירת המחדל, כי מאה תמונות ביום
              מארבעה סניפים זו התראה כל כמה דקות — ותוך שבוע מכבים התראות,
              וביחד איתן גם את אלה על תשלומים ואיסוף. */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
            <NotificationsIcon fontSize="small" color="action" />
            <TextField
              select
              size="small"
              label="עדכון על תמונות חדשות"
              value={digest || 'daily'}
              onChange={(e) => setDigestMode(e.target.value)}
              sx={{ minWidth: 220 }}
            >
              <MenuItem value="daily">פעם ביום</MenuItem>
              <MenuItem value="weekly">סיכום שבועי, בשישי</MenuItem>
              <MenuItem value="off">בלי התראות</MenuItem>
            </TextField>
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={!!open} onClose={() => setOpen(null)} maxWidth="lg" fullWidth>
        <Box sx={{ position: 'relative', bgcolor: 'common.black' }}>
          <IconButton
            onClick={() => setOpen(null)}
            sx={{ position: 'absolute', top: 8, insetInlineEnd: 8, color: 'common.white', zIndex: 1 }}
            aria-label="סגירה"
          >
            <CloseIcon />
          </IconButton>
          {open && (
            <Box sx={{ position: 'relative', display: 'inline-block', width: '100%' }}>
              <Box
                component="img"
                src={open.url}
                alt={open.caption || ''}
                sx={{ width: '100%', maxHeight: '85vh', objectFit: 'contain', display: 'block' }}
              />
              {/* הפרצופים שאף אחד לא סימן, כמסגרות על התמונה עצמה. מיקום
                  באחוזים מתוך מידות התמונה, כך שזה מחזיק בכל גודל מסך.
                  "פרצוף 1" ו"פרצוף 2" לא אומרים כלום להורה; מסגרת על הפנים
                  אומרת הכול. */}
              {!(open.my_faces || []).length
                && (open.faces || []).filter(f => !f.taken).map(f => (
                  <Box
                    key={f.index}
                    role="button"
                    aria-label={`סימון ${childName} כאן`}
                    onClick={() => !busy && decide(open, 'is_my_child', f.index)}
                    sx={{
                      position: 'absolute',
                      insetInlineStart: `${(100 * f.bbox[0]) / (open.width || 1)}%`,
                      top: `${(100 * f.bbox[1]) / (open.height || 1)}%`,
                      width: `${(100 * (f.bbox[2] - f.bbox[0])) / (open.width || 1)}%`,
                      height: `${(100 * (f.bbox[3] - f.bbox[1])) / (open.height || 1)}%`,
                      border: '3px solid',
                      borderColor: 'primary.main',
                      borderRadius: 1,
                      cursor: 'pointer',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0)',
                      transition: 'background-color .15s',
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' },
                    }}
                  />
                ))}
            </Box>
          )}
        </Box>
        {open?.caption && (
          <Box sx={{ p: 1.5 }}>
            <Typography variant="body2">{open.caption}</Typography>
          </Box>
        )}

        {/* תמונה שהילד שלכם מסומן בה — שני הכפתורים, ובמכוון נפרדים. */}
        {open && (open.my_faces || []).length > 0 && (
          <Stack spacing={1} sx={{ p: 1.5 }}>
            {open.my_faces.some(f => f.awaiting_staff) && (
              <Typography variant="caption" color="text.secondary">
                סימנתם את {childName} בתמונה הזו. ממתין לאישור הגן.
              </Typography>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                size="small"
                color="inherit"
                disabled={busy}
                startIcon={<PersonOffIcon />}
                onClick={() => decide(open, 'not_my_child', open.my_faces[0].index)}
              >
                זה לא {childName}
              </Button>
              <Button
                size="small"
                color="inherit"
                disabled={busy}
                startIcon={<VisibilityOffIcon />}
                onClick={() => decide(open, 'hide')}
              >
                אל תציגו לי את זה
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              &quot;זה לא {childName}&quot; מתקן את הזיהוי בגן.
              &quot;אל תציגו לי&quot; מסתיר רק אצלכם ולא משנה כלום אחר.
            </Typography>
          </Stack>
        )}

        {/* תמונת כיתה שהילד שלכם לא מסומן בה — אפשר להצביע עליו. */}
        {open && !(open.my_faces || []).length && (open.faces || []).length > 0 && (
          <Stack spacing={1} sx={{ p: 1.5 }}>
            <Typography variant="body2">
              {childName} בתמונה הזו? סמנו וניזכר לבד בפעם הבאה.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              לחצו על המסגרת שסביב הפנים שלו/ה בתמונה למעלה.
            </Typography>
          </Stack>
        )}
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
