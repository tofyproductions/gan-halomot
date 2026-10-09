import { useEffect, useState } from 'react';
import { Paper, Stack, Typography, Chip, Button, Box, Tooltip } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { HEB_DAYS, fmtDate } from '../shifts/shiftRows';

const weekdayOf = (ymd) => new Date(`${ymd}T12:00`).getDay();
const WIN = { am: '☀️ בוקר', pm: '🌙 צהריים' };
const STATUS = {
  pending: { label: 'ממתין למנהלת', color: 'warning' },
  accepted: { label: 'אושר — את בסידור', color: 'success' },
  declined: { label: 'לא אושר', color: 'default' },
};

/**
 * "חסר — ואת פנויה": the gaps she may volunteer for, computed on the server
 * from the same arithmetic as the manager's balance strip, shown only when
 * the gap has no internal surplus to drag from. One tap sends the offer to
 * the manager; the decision comes back as a notification and shows here.
 */
export default function CoverGapsCard() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.get('/shifts/cover-offers/mine').then(r => setData(r.data)).catch(() => setData(null));
  useEffect(() => { load(); }, []);

  if (!data || (!data.gaps.length && !data.offers.length)) return null;

  const offer = async (g) => {
    // Another branch is a real commute — said out loud before it is sent.
    if (g.foreign && !window.confirm(`להציע את עצמך למשמרת בסניף ${g.branch_name}? ההצעה תישלח למנהלת של הסניף הזה.`)) return;
    const key = `${g.date}|${g.window}|${g.classroom_id}`;
    setBusy(key);
    try {
      await api.post('/shifts/cover-offers', { date: g.date, window: g.window, classroom_id: g.classroom_id, branch_id: g.branch_id });
      toast.success(g.foreign
        ? `ההצעה נשלחה למנהלת של ${g.branch_name} — תקבלי הודעה כשתוחלט`
        : 'ההצעה נשלחה למנהלת — תקבלי הודעה כשתוחלט');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'השליחה נכשלה');
      load();
    } finally { setBusy(''); }
  };

  const homeGaps = data.gaps.filter(g => !g.foreign);
  const awayGaps = data.gaps.filter(g => g.foreign);

  return (
    <Paper sx={{ p: 1.5, mb: 1.5, borderRadius: 3 }}>
      <Typography sx={{ fontWeight: 800, mb: 0.5 }}>🙋 חסר בסידור — ואת פנויה</Typography>
      {data.gaps.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            במשבצות האלה חסרה עובדת ואת פנויה לפי הסידור. לחיצה שולחת הצעה למנהלת — השיבוץ נכנס רק אחרי אישור שלה.
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: awayGaps.length || data.offers.length ? 1.25 : 0 }}>
            {homeGaps.map(g => {
              const key = `${g.date}|${g.window}|${g.classroom_id}`;
              return (
                <Tooltip key={key} title={`חסרות ${g.missing} · לחיצה שולחת הצעה למנהלת`}>
                  <Button size="small" variant="outlined" color="primary" disabled={busy === key}
                    onClick={() => offer(g)}
                    sx={{ borderRadius: 999, fontWeight: 700, textTransform: 'none' }}>
                    + {HEB_DAYS[weekdayOf(g.date)]} {fmtDate(g.date)} · {g.classroom_name} · {WIN[g.window]}
                  </Button>
                </Tooltip>
              );
            })}
          </Stack>
          {awayGaps.length > 0 && (
            <>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.75, color: 'info.dark', fontWeight: 700 }}>
                בסניפים אחרים — משמרת נוספת אם מתאים לך להגיע:
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: data.offers.length ? 1.5 : 0 }}>
                {awayGaps.map(g => {
                  const key = `${g.date}|${g.window}|${g.classroom_id}`;
                  return (
                    <Tooltip key={key} title={`${g.branch_name} · חסרות ${g.missing}${g.bonus ? ` · בונוס ₪${g.bonus} באישור הנהלת חשבונות` : ''} · ההצעה נשלחת למנהלת של הסניף הזה`}>
                      <Button size="small" variant="outlined" color="info" disabled={busy === key}
                        onClick={() => offer(g)}
                        sx={{
                          borderRadius: 999, fontWeight: 700, textTransform: 'none',
                          ...(g.bonus ? {
                            borderColor: '#F59E0B', color: '#92400E', bgcolor: '#FFFBEB',
                            boxShadow: '0 1px 6px rgba(245,158,11,0.35)',
                            '&:hover': { bgcolor: '#FEF3C7', borderColor: '#F59E0B' },
                          } : {}),
                        }}>
                        + {g.branch_name} · {HEB_DAYS[weekdayOf(g.date)]} {fmtDate(g.date)} · {g.classroom_name} · {WIN[g.window]}
                        {g.bonus && (
                          <Box component="span" dir="ltr" sx={{
                            mr: 0.75, px: 0.75, py: 0.1, borderRadius: 999,
                            bgcolor: '#F59E0B', color: '#fff', fontSize: '0.68rem', fontWeight: 800,
                          }}>
                            🎁 ₪{g.bonus}
                          </Box>
                        )}
                      </Button>
                    </Tooltip>
                  );
                })}
              </Stack>
            </>
          )}
        </>
      )}
      {data.offers.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
          <Typography variant="caption" color="text.secondary">ההצעות שלך:</Typography>
          {data.offers.map(o => (
            <Tooltip key={o._id} title={o.status === 'declined' && o.reject_reason ? `סיבה: ${o.reject_reason}` : ''}>
              <Chip size="small" variant="outlined" color={STATUS[o.status]?.color || 'default'}
                label={`${fmtDate(o.date)} ${o.classroom_name} ${WIN[o.window]} — ${STATUS[o.status]?.label || o.status}`} />
            </Tooltip>
          ))}
        </Stack>
      )}
      {data.gaps.length === 0 && data.offers.length > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">אין כרגע משבצות פתוחות נוספות.</Typography>
        </Box>
      )}
    </Paper>
  );
}
