import { useState, useEffect, useRef } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Button, Alert, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, LinearProgress,
} from '@mui/material';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import parentApi, { parentApiError, UPLOAD_TIMEOUT_MS } from '../../api/parentClient';

/**
 * Choosing the photograph that goes on this year's gift.
 *
 * It sits ABOVE the tabs, not inside the photographs tab, and that is the
 * whole point: it is a deadline with a date on it, and a parent who never
 * opens the photographs tab would have missed it entirely. Once the family has
 * chosen it collapses into a quiet confirmation — a demand that stays loud
 * after it has been met is a demand people learn to ignore.
 *
 * Uploading lives INSIDE the picker. A parent who opens it and finds nothing
 * they like has to be able to add one without leaving, going to another tab,
 * uploading, and coming back to find their place. The photograph they add is
 * selected immediately, because adding one during this dialog is not an
 * ambiguous act.
 */

/** "תמונה אחת" reads; "1 תמונות" does not. */
function photoCount(n) {
  if (n === 1) return 'תמונה אחת';
  if (n === 2) return 'שתי תמונות';
  return `${n} תמונות`;
}

export default function GiftPicker({ childId, childName }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef(null);

  const load = async () => {
    try {
      const res = await parentApi.get(`/children/${childId}/gift`);
      setData(res.data);
    } catch {
      setData({ campaign: null });
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [childId]);

  if (!data?.campaign) return null;

  const { campaign, chosen = [], photos = [], finalised } = data;
  const chosenPhotos = photos.filter(p => chosen.includes(p.id));
  const needed = campaign.picks_required;
  const done = chosen.length > 0;

  const begin = () => {
    setDraft(chosen);
    setError('');
    setOpen(true);
  };

  const toggle = (id) => {
    setDraft(d => {
      if (d.includes(id)) return d.filter(x => x !== id);
      // Replacing the oldest rather than refusing: told "you already have two",
      // a parent has to work out which to drop before they can pick the one
      // they actually wanted.
      if (d.length >= needed) return [...d.slice(1), id];
      return [...d, id];
    });
  };

  const pickFile = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) upload(files);
  };

  const upload = async (files) => {
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      files.slice(0, 5).forEach(f => form.append('photos', f));
      await parentApi.post(`/children/${childId}/photos`, form, { timeout: UPLOAD_TIMEOUT_MS });

      // Re-read and select whatever is new, so the photograph the parent just
      // added is the one they are choosing.
      const before = new Set(photos.map(p => p.id));
      const res = await parentApi.get(`/children/${childId}/gift`);
      setData(res.data);
      const added = (res.data.photos || []).filter(p => !before.has(p.id)).map(p => p.id);
      if (added.length) {
        setDraft(d => [...d, ...added].slice(-needed));
      }
    } catch (err) {
      setError(parentApiError(err, 'ההעלאה נכשלה'));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await parentApi.put(`/children/${childId}/gift`, { photo_ids: draft });
      setOpen(false);
      await load();
    } catch (err) {
      setError(parentApiError(err, 'השמירה נכשלה'));
    } finally {
      setSaving(false);
    }
  };

  const deadline = (() => {
    const d = new Date(campaign.closes_on);
    return Number.isNaN(d.getTime()) ? campaign.closes_on : d.toLocaleDateString('he-IL');
  })();

  return (
    <>
      <Card
        sx={{
          // The whole surface changes, not a stripe down its edge. Loud while
          // something is required of the family, quiet once it is done: a
          // demand that stays loud after it has been met is a demand people
          // learn to ignore.
          bgcolor: campaign.open && !done ? 'warning.light' : 'background.paper',
          borderColor: campaign.open && !done ? '#EFD3A6' : 'divider',
        }}
      >
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 0.75 }}>
            <Box
              sx={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                display: 'grid', placeItems: 'center',
                bgcolor: done ? 'success.light' : campaign.open ? 'primary.main' : 'action.hover',
                color: done ? 'success.dark' : campaign.open ? '#fff' : 'text.secondary',
              }}
            >
              {done ? <CheckCircleIcon /> : <CardGiftcardIcon />}
            </Box>
            <Typography variant="h5">{campaign.name}</Typography>
          </Stack>

          {campaign.product && (
            <Typography variant="body2" color="text.secondary">
              המתנה השנה: {campaign.product}
            </Typography>
          )}

          {campaign.open && !done && (
            <>
              <Typography variant="body1" fontWeight={700} sx={{ mt: 1 }}>
                צריך לבחור {photoCount(needed)} של {childName} עד {deadline}.
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                הצוות יבחר מתוכן את זו שמתאימה למתנה. אם לא תבחרו — הגן יבחר עבורכם.
              </Typography>
              {/* The one primary action on this card, and sized like it. */}
              <Button
                variant="contained" color="primary" size="large"
                startIcon={<CardGiftcardIcon />}
                sx={{ mt: 2, width: { xs: '100%', sm: 'auto' } }}
                onClick={begin}
              >
                בחירת תמונות
              </Button>
            </>
          )}

          {campaign.open && done && (
            <>
              <Typography variant="body2" sx={{ mt: 1 }}>
                הבחירה נשמרה. אפשר לשנות עד {deadline}.
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                {chosenPhotos.map(p => (
                  <Box key={p.id} component="img" src={p.thumb_url} alt=""
                    sx={{
                      width: 76, height: 76, objectFit: 'cover', borderRadius: '14px',
                      border: '2px solid', borderColor: 'success.main',
                    }} />
                ))}
              </Stack>
              <Button size="small" sx={{ mt: 1 }} onClick={begin}>שינוי הבחירה</Button>
            </>
          )}

          {!campaign.open && (
            <Alert severity="info" sx={{ mt: 1 }}>
              מועד הבחירה הסתיים{finalised ? '. הגן בחר תמונה למתנה.' : '.'}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onClose={saving || uploading ? undefined : () => setOpen(false)}
        fullWidth maxWidth="sm">
        <DialogTitle>
          בחירת תמונות למתנה
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            נבחרו {draft.length} מתוך {needed}
          </Typography>
        </DialogTitle>
        <DialogContent>
          {uploading && <LinearProgress sx={{ mb: 2 }} />}
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={pickFile} />

          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {/* First tile, always. A parent who finds nothing they like must be
                able to add one without leaving this dialog. */}
            <Box
              onClick={() => !uploading && fileInput.current?.click()}
              sx={{
                aspectRatio: '1', borderRadius: '14px', cursor: 'pointer',
                border: '2px dashed', borderColor: 'primary.main',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 0.5,
                color: 'primary.main',
              }}
            >
              <AddPhotoAlternateIcon />
              <Typography variant="caption" fontWeight={700}>העלאת תמונה</Typography>
            </Box>

            {photos.map(p => {
              const on = draft.includes(p.id);
              return (
                <Box
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  sx={{
                    position: 'relative', aspectRatio: '1', borderRadius: '14px', overflow: 'hidden',
                    cursor: 'pointer', outline: on ? '3px solid' : '1px solid',
                    outlineColor: on ? 'primary.main' : 'divider',
                  }}
                >
                  <Box component="img" src={p.thumb_url} alt="" loading="lazy"
                    sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  {on && (
                    <Chip label="נבחרה" size="small" color="primary"
                      sx={{ position: 'absolute', bottom: 4, insetInlineStart: 4 }} />
                  )}
                </Box>
              );
            })}
          </Box>

          {photos.length === 0 && !uploading && (
            <Alert severity="info" sx={{ mt: 2 }}>
              אין עדיין תמונות של {childName}. אפשר להעלות תמונה כאן, או להמתין שהגן יסמן תמונה.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={saving || uploading}>ביטול</Button>
          <Button variant="contained" onClick={save} disabled={saving || uploading}>
            {saving ? 'שומר…' : 'שמירת הבחירה'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
