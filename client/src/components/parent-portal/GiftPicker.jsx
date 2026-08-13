import { useState, useEffect } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Button, Alert, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress,
} from '@mui/material';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * Choosing the photograph that goes on this year's gift.
 *
 * It sits at the top of the photographs tab and only when a round is running,
 * because it is a deadline: a card that is always there is a card nobody
 * reads, and this one has a date on it.
 *
 * The choice is made in a dialog rather than by turning the gallery into a
 * selection mode. A parent scrolling their child's photographs and a parent
 * deciding which two go on a mug are doing different things, and a gallery that
 * silently becomes a form is a gallery where somebody picks a photograph by
 * accident.
 *
 * Only the child's own photographs are offered — the server enforces it, and
 * the screen never shows the classroom gallery here. A group photograph on a
 * gift would put other families' children on it.
 */
export default function GiftPicker({ childId, childName }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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

  const begin = () => {
    setDraft(chosen);
    setError('');
    setOpen(true);
  };

  const toggle = (id) => {
    setDraft(d => {
      if (d.includes(id)) return d.filter(x => x !== id);
      // Replacing the oldest rather than refusing: told "you already have two",
      // a parent has to work out which to remove before they can pick the one
      // they wanted.
      if (d.length >= campaign.picks_required) return [...d.slice(1), id];
      return [...d, id];
    });
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
      <Card sx={{ borderInlineStart: '4px solid', borderColor: 'primary.main' }}>
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
            <CardGiftcardIcon color="primary" fontSize="small" />
            <Typography variant="subtitle1" fontWeight={700}>{campaign.name}</Typography>
          </Stack>

          {campaign.product && (
            <Typography variant="body2" color="text.secondary">
              המתנה השנה: {campaign.product}
            </Typography>
          )}

          {campaign.open ? (
            <Typography variant="body2" sx={{ mt: 1 }}>
              בחרו עד {campaign.picks_required} תמונות של {childName} עד {deadline}.
              הצוות יבחר מתוכן את זו שמתאימה למתנה.
            </Typography>
          ) : (
            <Alert severity="info" sx={{ mt: 1 }}>
              מועד הבחירה הסתיים{finalised ? '. הגן בחר תמונה למתנה.' : '.'}
            </Alert>
          )}

          {chosenPhotos.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              {chosenPhotos.map(p => (
                <Box key={p.id} component="img" src={p.thumb_url} alt=""
                  sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 2 }} />
              ))}
            </Stack>
          )}

          {campaign.open && (
            <Button variant={chosen.length ? 'outlined' : 'contained'} size="small" sx={{ mt: 2 }}
              onClick={begin} disabled={photos.length === 0}>
              {chosen.length ? 'שינוי הבחירה' : 'בחירת תמונות'}
            </Button>
          )}

          {campaign.open && photos.length === 0 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              עדיין אין תמונות של {childName} לבחירה. אפשר להעלות תמונה למטה, או להמתין שהגן יסמן.
            </Alert>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onClose={saving ? undefined : () => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>
          בחירת תמונות למתנה
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            נבחרו {draft.length} מתוך {campaign.picks_required}
          </Typography>
        </DialogTitle>
        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {photos.map(p => {
              const on = draft.includes(p.id);
              return (
                <Box
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  sx={{
                    position: 'relative', aspectRatio: '1', borderRadius: 2, overflow: 'hidden',
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={saving}>ביטול</Button>
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? 'שומר…' : 'שמירת הבחירה'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
