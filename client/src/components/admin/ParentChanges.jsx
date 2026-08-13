import { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Chip, Button, Alert,
  CircularProgress, ToggleButton, ToggleButtonGroup, Divider,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DoneIcon from '@mui/icons-material/Done';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import api from '../../api/client';

/**
 * עדכונים מהורים — what families corrected about their own children.
 *
 * An acknowledgement queue, not an approval one. The gan decided a parent may
 * fix their own details without waiting for anyone, so every row here is
 * already true; the button records that somebody at the gan has read it.
 *
 * The screen is built around one row type mattering more than the rest. An
 * allergy edited at eleven at night is true from eleven at night, and the only
 * open question is whether anyone finds out before breakfast — so health rows
 * are red, carry a warning, and sort above everything unread.
 *
 * Every row shows what the value WAS. "מיכל שינתה אלרגיות" is not something
 * anyone can act on; "אגוזים ← (ריק)" is.
 */

const CATEGORY_LABEL = {
  contact: 'פרטי קשר',
  health: 'בריאות',
  phone: 'טלפון',
  second_parent: 'הורה שני',
};

function when(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** An empty value is a fact, and it is usually the alarming one. */
function shown(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? '(ריק)' : s;
}

export default function ParentChanges() {
  const [rows, setRows] = useState([]);
  const [unseen, setUnseen] = useState(0);
  const [status, setStatus] = useState('unseen');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async (next = status) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/parent-changes', { params: { status: next } });
      setRows(res.data.changes || []);
      setUnseen(res.data.unseen || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו לטעון את העדכונים');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load('unseen'); /* eslint-disable-next-line */ }, []);

  const approveAccess = async (id) => {
    setBusy(id);
    try {
      await api.post(`/parent-changes/${id}/approve-access`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'האישור נכשל');
    } finally {
      setBusy('');
    }
  };

  const markSeen = async (id) => {
    setBusy(id);
    try {
      await api.post(`/parent-changes/${id}/seen`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'הסימון נכשל');
    } finally {
      setBusy('');
    }
  };

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>עדכונים מהורים</Typography>
        {unseen > 0 && <Chip label={`${unseen} לא נקראו`} color="error" size="small" />}
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        הורים מעדכנים את פרטיהם בעצמם והשינוי נכנס לתוקף מיד. המסך הזה כדי שתדעו — לא כדי לאשר.
      </Alert>

      <ToggleButtonGroup
        size="small" exclusive value={status} sx={{ mb: 2 }}
        onChange={(_, v) => { if (v) { setStatus(v); load(v); } }}
      >
        <ToggleButton value="unseen">לא נקראו</ToggleButton>
        <ToggleButton value="all">הכל</ToggleButton>
      </ToggleButtonGroup>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}

      {!loading && rows.length === 0 && (
        <Alert severity="success">
          {status === 'unseen' ? 'אין עדכונים חדשים.' : 'אין עדכונים.'}
        </Alert>
      )}

      <Stack spacing={2}>
        {rows.map(row => {
          const critical = row.severity === 'high';
          return (
            <Card
              key={row.id}
              sx={{
                borderInlineStart: '4px solid',
                borderColor: critical ? 'error.main' : row.seen_at ? 'divider' : 'primary.main',
                opacity: row.seen_at ? 0.75 : 1,
              }}
            >
              <CardContent>
                <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
                  {critical && <WarningAmberIcon color="error" fontSize="small" />}
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant="subtitle1" fontWeight={700}>
                      {row.child_name || 'ללא ילד'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.parent_name || 'הורה'} · {CATEGORY_LABEL[row.category] || row.category} · {when(row.created_at)}
                    </Typography>
                  </Box>
                  {/* A second parent waiting on a decision gets the decision
                      button instead of the acknowledgement one. Approving is
                      also reading it, so offering both would be asking for two
                      taps on one act. */}
                  {row.awaiting_access ? (
                    <Button
                      size="small" variant="contained" startIcon={<LockOpenIcon />}
                      disabled={busy === row.id}
                      onClick={() => approveAccess(row.id)}
                    >
                      {busy === row.id ? '…' : 'אישור גישה'}
                    </Button>
                  ) : !row.seen_at && (
                    <Button
                      size="small"
                      variant={critical ? 'contained' : 'outlined'}
                      color={critical ? 'error' : 'primary'}
                      startIcon={<DoneIcon />}
                      disabled={busy === row.id}
                      onClick={() => markSeen(row.id)}
                    >
                      {busy === row.id ? '…' : 'קראתי'}
                    </Button>
                  )}
                </Stack>

                {row.awaiting_access && (
                  <Alert severity="warning" sx={{ mb: 1.5 }}>
                    הורה זה ממתין לאישורכם כדי להיכנס לאפליקציה ולראות את נתוני הילד.
                    הפרטים כבר נשמרו ומשמשים כאיש קשר.
                  </Alert>
                )}

                {critical && !row.seen_at && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    שינוי רפואי. הצוות והמטבח עובדים לפי זה — ודאו שהמידע עבר הלאה.
                  </Alert>
                )}

                <Divider sx={{ mb: 1.5 }} />

                <Stack spacing={1}>
                  {row.changes.map((c, i) => (
                    <Stack key={i} direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 110 }}>
                        {c.label || c.field}
                      </Typography>
                      <Typography variant="body2" sx={{ textDecoration: 'line-through', color: 'text.disabled' }}>
                        {shown(c.before)}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">←</Typography>
                      <Typography variant="body2" fontWeight={700}>
                        {shown(c.after)}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>

                {row.seen_at && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    נקרא {when(row.seen_at)}{row.seen_by_name ? ` · ${row.seen_by_name}` : ''}
                  </Typography>
                )}
              </CardContent>
            </Card>
          );
        })}
      </Stack>
    </Box>
  );
}
