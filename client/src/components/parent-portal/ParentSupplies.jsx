import { useState, useEffect } from 'react';
import {
  Stack, Card, CardContent, Typography, Alert, Box, CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * מה צריך להביא.
 *
 * Read-only, deliberately. A parent ticking "brought it" from the sofa would
 * leave the shelf empty and the list clean; the person who can see the shelf
 * is the one in the room, so they are the one who clears it.
 *
 * The wording and the icons are the gan's own printed sheet, so a parent
 * recognises "תמ״ל" from the page on their fridge instead of having to work
 * out what the app means.
 */

const dayCount = (iso) => {
  if (!iso) return null;
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  return Number.isFinite(days) ? days : null;
};

function Item({ item }) {
  const c = item.color || '#64748b';
  const days = dayCount(item.marked_at);
  return (
    <Card variant="outlined" sx={{ borderInlineStart: `10px solid ${c}`, borderRadius: 3 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box
            sx={{
              width: 44, height: 44, borderRadius: '50%', flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, bgcolor: `${c}26`,
            }}
            aria-hidden
          >
            {item.emoji || '📌'}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 800, fontSize: 17 }}>{item.label}</Typography>
            {item.hint && (
              <Typography variant="body2" color="text.secondary">{item.hint}</Typography>
            )}
            {item.note && (
              <Typography variant="body2" sx={{ mt: 0.25 }}>{item.note}</Typography>
            )}
            {days !== null && days >= 3 && (
              <Typography variant="caption" sx={{ color: c, fontWeight: 700 }}>
                {days === 1 ? 'מאתמול' : `כבר ${days} ימים`}
              </Typography>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function ParentSupplies({ childId, childName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    parentApi.get(`/children/${childId}/supplies`)
      .then((res) => { if (alive) setData(res.data); })
      .catch((err) => { if (alive) setError(parentApiError(err, 'שגיאה בטעינה')); });
    return () => { alive = false; };
  }, [childId]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={28} /></Stack>;

  const missing = data.missing || [];

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מה צריך להביא</Typography>
        <Typography variant="caption" color="text.secondary">
          הצוות מעדכן את הרשימה מהגן
        </Typography>
      </Box>

      {missing.length === 0 ? (
        <Alert severity="success" icon={<CheckCircleIcon />} sx={{ fontWeight: 700 }}>
          לא חסר כלום ל{childName || 'ילד/ה'} כרגע 🎉
        </Alert>
      ) : (
        <>
          <Alert severity="warning" sx={{ fontWeight: 700 }}>
            {missing.length === 1 ? 'פריט אחד חסר' : `${missing.length} פריטים חסרים`}
          </Alert>
          {missing.map((m) => <Item key={m.key} item={m} />)}
        </>
      )}

      {data.note && (
        <Alert severity="info" icon={false} sx={{ fontWeight: 700, textAlign: 'center' }}>
          ⭐ {data.note} ⭐
        </Alert>
      )}
    </Stack>
  );
}
