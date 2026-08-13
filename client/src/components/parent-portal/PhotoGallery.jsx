import { useState, useEffect, useRef } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Alert, CircularProgress, Button,
  Dialog, IconButton, Snackbar,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import parentApi, { parentApiError } from '../../api/parentClient';

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
        <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{empty}</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
      {subtitle && (
        <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
      )}
      <Box
        ref={scroller}
        sx={{
          display: 'flex', gap: 1, mt: 1, pb: 1,
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
              flex: '0 0 auto', width: 132, height: 132,
              borderRadius: 2, overflow: 'hidden', cursor: 'pointer',
              scrollSnapAlign: 'start', bgcolor: 'action.hover',
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

  const pick = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    send(files);
  };

  const send = async (files) => {
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      files.slice(0, 5).forEach(f => form.append('photos', f));
      const res = await parentApi.post(`/children/${childId}/photos`, form);
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
              startIcon={<AddPhotoAlternateIcon />}
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
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
            <Box
              component="img"
              src={open.url}
              alt={open.caption || ''}
              sx={{ width: '100%', maxHeight: '85vh', objectFit: 'contain', display: 'block' }}
            />
          )}
        </Box>
        {open?.caption && (
          <Box sx={{ p: 1.5 }}>
            <Typography variant="body2">{open.caption}</Typography>
          </Box>
        )}
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
