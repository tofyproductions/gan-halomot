import { useState, useEffect } from 'react';
import {
  Card, CardContent, Typography, Stack, Box, Button, Alert, Chip,
  TextField, Skeleton, IconButton, Divider,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import parentApi, { parentApiError } from '../../api/parentClient';
import { DISPLAY } from '../../theme/parentTheme';

/**
 * Who else may collect this child.
 *
 * ADDING WAITS FOR THE GAN, REMOVING DOES NOT, and the screen makes that
 * asymmetry obvious rather than hiding it. A new name is a request and says
 * so; taking a name off is immediate, because a parent removing somebody is
 * answering a question that must not queue behind an office.
 *
 * THE SCREEN IS HONEST ABOUT WHAT IT CANNOT DO. This system holds a name, a
 * number and a relationship. It cannot verify a person, and a family reading
 * "דנה כהן מורשית" without being told that the gan asks for a document at the
 * door has been sold a feeling of safety rather than safety.
 */

const STATUS = {
  pending: { label: 'ממתין לאישור הגן', tone: 'warning' },
  approved: { label: 'מאושר/ת', tone: 'success' },
  rejected: { label: 'נדחה', tone: 'error' },
};

function StatusChip({ status }) {
  const s = STATUS[status] || STATUS.pending;
  const sx = {
    success: { bgcolor: 'success.light', color: (t) => (t.palette.mode === 'dark' ? t.palette.success.main : t.palette.success.dark) },
    warning: { bgcolor: 'warning.light', color: (t) => (t.palette.mode === 'dark' ? t.palette.warning.main : t.palette.warning.dark) },
    error: { bgcolor: 'error.light', color: (t) => (t.palette.mode === 'dark' ? t.palette.error.main : t.palette.error.dark) },
  }[s.tone];
  return <Chip size="small" label={s.label} sx={{ ...sx, fontWeight: 700 }} />;
}

export default function ParentPickup({ childId, childName }) {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relation, setRelation] = useState('');

  const load = async () => {
    try {
      const res = await parentApi.get(`/children/${childId}/pickup`);
      setPeople(res.data.people || []);
    } catch (err) {
      setError(parentApiError(err, 'לא הצלחנו לטעון את הרשימה'));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    setLoading(true); setError(''); setPeople([]);
    setName(''); setPhone(''); setRelation('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId]);

  const add = async () => {
    setBusy(true); setError('');
    try {
      const res = await parentApi.post(`/children/${childId}/pickup`, { name, phone, relation });
      setPeople(res.data.people || []);
      setName(''); setPhone(''); setRelation('');
    } catch (err) {
      setError(parentApiError(err, 'ההוספה נכשלה'));
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    setError('');
    try {
      const res = await parentApi.delete(`/children/${childId}/pickup/${id}`);
      setPeople(res.data.people || []);
    } catch (err) {
      setError(parentApiError(err, 'ההסרה נכשלה'));
    }
  };

  if (loading) {
    return <Skeleton variant="rounded" height={260} sx={{ borderRadius: '20px' }} />;
  }

  return (
    <Stack spacing={2} sx={{ animation: 'riseIn .35s cubic-bezier(.22,1,.36,1) both' }}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <Card>
        <CardContent>
          <Typography sx={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: '1.15rem' }}>
            מי מורשה לאסוף את {childName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            מלבדכם. כל שם חדש עובר לאישור הגן.
          </Typography>

          {people.length === 0 ? (
            <Alert severity="info" sx={{ mt: 2 }}>
              אין מורשים נוספים. רק ההורים הרשומים יכולים לאסוף.
            </Alert>
          ) : (
            <Stack spacing={0} sx={{ mt: 1.5 }}>
              {people.map((p, i) => (
                <Box key={p.id}>
                  {i > 0 && <Divider />}
                  <Stack direction="row" alignItems="center" spacing={1.5} sx={{ py: 1.25 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>{p.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        {[p.relation, p.phone].filter(Boolean).join(' · ') || '—'}
                      </Typography>
                      {p.status === 'rejected' && p.reject_reason && (
                        <Typography variant="caption" color="error" component="div">
                          {p.reject_reason}
                        </Typography>
                      )}
                    </Box>
                    <StatusChip status={p.status} />
                    {/* Immediate, whatever the state. Withdrawing a request and
                        revoking an approval are the same act from this side. */}
                    <IconButton size="small" onClick={() => remove(p.id)} aria-label={`הסרת ${p.name}`}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 1.5 }}>הוספת מורשה</Typography>
          <Stack spacing={1.5}>
            <TextField
              size="small" fullWidth label="שם מלא" value={name}
              onChange={(e) => setName(e.target.value)} inputProps={{ maxLength: 80 }}
            />
            <TextField
              size="small" fullWidth label="טלפון" value={phone} type="tel"
              onChange={(e) => setPhone(e.target.value)} inputProps={{ maxLength: 20 }}
            />
            <TextField
              size="small" fullWidth label="קרבה" placeholder="סבתא, שכנה, דודה…"
              value={relation} onChange={(e) => setRelation(e.target.value)}
              inputProps={{ maxLength: 60 }}
            />
            <Button variant="contained" onClick={add} disabled={busy || !name.trim()}>
              {busy ? 'שולח…' : 'שליחה לאישור הגן'}
            </Button>
          </Stack>

          {/* What the app cannot do, said before somebody relies on it. */}
          <Alert severity="warning" sx={{ mt: 2 }}>
            <b>הזיהוי נעשה בגן, לא כאן.</b> הצוות מבקש תעודת זהות מכל מי שאינו הורה ומשווה
            לשם שברשימה. אין צורך למסור כאן מספר תעודת זהות של אדם אחר.
          </Alert>
        </CardContent>
      </Card>
    </Stack>
  );
}
