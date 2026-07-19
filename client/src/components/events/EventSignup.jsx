import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import {
  Box, Paper, Typography, Stack, Button, TextField, Chip, Divider, Alert,
  CircularProgress, Card, CardContent, LinearProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EventIcon from '@mui/icons-material/Event';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { toast } from 'react-toastify';

// Public routes take no JWT — plain axios instance.
const publicApi = axios.create({ baseURL: '/api/public', timeout: 30000 });

// Stable per-browser id so a return visit from the same device shows my picks.
function getClaimantId() {
  let id = localStorage.getItem('gan_event_claimant');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('gan_event_claimant', id);
  }
  return id;
}

const fmtDate = (d) => {
  if (!d) return '';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return d; }
};

export default function EventSignup() {
  const { token } = useParams();
  const claimantId = useRef(getClaimantId()).current;

  const [name, setName] = useState(() => localStorage.getItem('gan_parent_name') || '');
  const [phone, setPhone] = useState(() => localStorage.getItem('gan_parent_phone') || '');
  const [data, setData] = useState(null);        // { event, items, mine, closed }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');           // item name currently mutating

  const load = useCallback((ph) => {
    const params = { claimant_id: claimantId };
    const usePhone = ph !== undefined ? ph : phone;
    if (usePhone) params.phone = usePhone;
    return publicApi.get(`/event/${token}`, { params })
      .then((res) => { setData(res.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'שגיאה בטעינת האירוע'))
      .finally(() => setLoading(false));
  }, [token, claimantId, phone]);

  useEffect(() => { load(); }, []); // eslint-disable-line

  // mine grouped by item name → count + first slot id (for release)
  const mineByName = {};
  (data?.mine || []).forEach((m) => {
    if (!mineByName[m.name]) mineByName[m.name] = { count: 0, slots: [] };
    mineByName[m.name].count += 1;
    mineByName[m.name].slots.push(m.slot_id);
  });

  const persistIdentity = () => {
    localStorage.setItem('gan_parent_name', name.trim());
    localStorage.setItem('gan_parent_phone', phone.trim());
  };

  const claim = async (itemName) => {
    if (!name.trim()) return toast.warn('נא להזין את שמך למעלה');
    persistIdentity();
    setBusy(itemName);
    try {
      const res = await publicApi.post(`/event/${token}/claim`, {
        claimant_id: claimantId, parent_name: name.trim(), parent_phone: phone.trim(), item_name: itemName,
      });
      setData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'שגיאה');
      if (e.response?.data?.view) setData(e.response.data.view); // server sent fresh state
      else if (e.response?.status === 409) load(); // someone beat us — refresh counts
    } finally { setBusy(''); }
  };

  const release = async (itemName) => {
    const slotId = mineByName[itemName]?.slots[0];
    if (!slotId) return;
    setBusy(itemName);
    try {
      const res = await publicApi.post(`/event/${token}/release`, {
        claimant_id: claimantId, slot_id: slotId, parent_phone: phone.trim(),
      });
      setData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'שגיאה');
      load();
    } finally { setBusy(''); }
  };

  if (loading) {
    return <Box dir="rtl" sx={{ display: 'flex', justifyContent: 'center', mt: 10 }}><CircularProgress /></Box>;
  }
  if (error && !data) {
    return (
      <Box dir="rtl" sx={{ maxWidth: 480, mx: 'auto', mt: 8, px: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  const { event, items } = data;
  const totalRemaining = items.reduce((s, g) => s + g.remaining, 0);
  const myTotal = data.mine.length;
  const allowMultiple = data.allow_multiple;
  const canClaimMore = allowMultiple || myTotal === 0;

  return (
    <Box dir="rtl" sx={{ maxWidth: 560, mx: 'auto', py: { xs: 2, sm: 4 }, px: 2 }}>
      {/* Header */}
      <Paper sx={{ p: 3, borderRadius: 3, mb: 2, background: 'linear-gradient(135deg,#fff7e6,#ffffff)' }}>
        <Typography variant="h5" fontWeight={800} gutterBottom>{event.name}</Typography>
        {event.branch_name && <Typography variant="subtitle2" color="text.secondary">{event.branch_name}</Typography>}
        <Stack direction="row" spacing={2} sx={{ mt: 1, color: 'text.secondary' }} flexWrap="wrap" useFlexGap>
          {event.event_date && <Stack direction="row" spacing={0.5} alignItems="center"><EventIcon fontSize="small" /><Typography variant="body2">{fmtDate(event.event_date)}</Typography></Stack>}
          {event.event_time && <Stack direction="row" spacing={0.5} alignItems="center"><AccessTimeIcon fontSize="small" /><Typography variant="body2">{event.event_time}</Typography></Stack>}
        </Stack>
        {event.description && <Typography variant="body2" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{event.description}</Typography>}
      </Paper>

      {data.closed && <Alert severity="info" sx={{ mb: 2 }}>הרשימה סגורה לשריונים חדשים. אלו הפריטים ששוריינת:</Alert>}

      {/* Identity */}
      {!data.closed && (
        <Paper sx={{ p: 2, borderRadius: 3, mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>הפרטים שלך</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField size="small" label="השם שלי" value={name} onChange={(e) => setName(e.target.value)} fullWidth required />
            <TextField size="small" label="טלפון" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => { persistIdentity(); load(); }}
              helperText="מזהה אותך אם תיכנס/י ממכשיר אחר" fullWidth />
          </Stack>
        </Paper>
      )}

      {/* Summary strip */}
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} justifyContent="space-between" alignItems="center">
        <Chip color={totalRemaining > 0 ? 'primary' : 'success'} label={totalRemaining > 0 ? `נשארו ${totalRemaining} פריטים` : 'הכל שוריין 🎉'} />
        {myTotal > 0 && <Chip color="success" variant="outlined" icon={<CheckCircleIcon />} label={`בחרת ${myTotal}`} />}
      </Stack>
      {!allowMultiple && !data.closed && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {myTotal > 0 ? 'בחרת פריט אחד. לבחירת פריט אחר — בטל/י קודם את הבחירה הנוכחית.' : 'אפשר לבחור פריט אחד.'}
        </Typography>
      )}

      {/* Items */}
      <Stack spacing={1}>
        {items.map((g) => {
          const mine = mineByName[g.name];
          const iTook = mine?.count > 0;
          const soldOut = g.remaining <= 0;
          const isBusy = busy === g.name;
          return (
            <Card key={g.name} variant="outlined"
              sx={{ borderRadius: 2, borderColor: iTook ? 'success.main' : 'divider', borderWidth: iTook ? 2 : 1 }}>
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Stack direction="row" alignItems="center" spacing={1.5}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography fontWeight={700} noWrap={false}>{g.name}</Typography>
                    <Typography variant="caption" color={soldOut ? 'success.main' : 'text.secondary'}>
                      {g.total > 1
                        ? (soldOut ? `כל ${g.total} שוריינו` : `נשארו ${g.remaining} מתוך ${g.total}`)
                        : (soldOut ? 'שוריין' : 'זמין')}
                      {iTook && ` · בחרת ${mine.count > 1 ? `×${mine.count}` : ''}`}
                    </Typography>
                  </Box>

                  <Stack direction="row" spacing={0.5} alignItems="center">
                    {iTook && (
                      <Button size="small" color="error" variant="text" disabled={isBusy || data.closed}
                        onClick={() => release(g.name)}>ביטול</Button>
                    )}
                    {data.closed ? (
                      iTook ? <Chip size="small" color="success" icon={<CheckCircleIcon />} label="שלך" /> : null
                    ) : soldOut && !iTook ? (
                      <Chip size="small" label="נתפס" />
                    ) : iTook ? (
                      // Already mine — offer "another one" only when multiples are allowed.
                      allowMultiple ? (
                        <Button size="small" variant="outlined" disabled={isBusy || soldOut} onClick={() => claim(g.name)}>
                          {isBusy ? '…' : 'עוד אחד'}
                        </Button>
                      ) : null
                    ) : (
                      <Button size="small" variant="contained" disabled={isBusy || soldOut || !canClaimMore} onClick={() => claim(g.name)}>
                        {isBusy ? '…' : 'אני מביא/ה'}
                      </Button>
                    )}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          );
        })}
      </Stack>

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary" display="block" textAlign="center">
        הבחירות שלך נשמרות אוטומטית · אפשר לחזור לקישור בכל עת
      </Typography>
    </Box>
  );
}
