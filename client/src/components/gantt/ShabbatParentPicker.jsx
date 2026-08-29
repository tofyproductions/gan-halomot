import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Box,
  Typography, Chip, CircularProgress, LinearProgress, Alert, Divider,
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Who is אבא של שבת, or אמא של שבת, this week.
 *
 * The rule the gan runs on is one sentence — nobody goes twice until everybody
 * has gone once — and until now keeping it meant remembering it, across five
 * weeks a month and whoever happened to be writing that month. A four-year-old
 * counts, and the gananet is the one who gets asked why.
 *
 * So the list is ordered by whose turn it is, the children who have already
 * been are shown greyed rather than hidden — she can still pick one on purpose,
 * and hiding them would look like they had left the gan — and the round's
 * progress is on the screen.
 */
export default function ShabbatParentPicker({
  open, onClose, classroomId, role, weekLabel, currentName, onPick,
}) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);

  const isFather = role === 'father';
  const title = isFather ? 'אבא של שבת' : 'אמא של שבת';

  const load = () => {
    if (!classroomId) return;
    setLoading(true);
    api.get('/gantt/shabbat-parents', { params: { classroom: classroomId } })
      .then(res => setState(res.data))
      .catch(() => toast.error('שגיאה בטעינת רשימת הילדים'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (open) load(); }, [open, classroomId]);

  const group = isFather ? state?.boys : state?.girls;

  /**
   * A child whose gender nobody has recorded is not in either rotation. Rather
   * than a data-entry project before the feature works at all, it is one tap,
   * here, by the person who knows — and then that child joins the round.
   */
  const setGender = async (child, gender) => {
    setBusy(child.id);
    try {
      await api.put(`/children/${child.id}`, { gender });
      load();
    } catch { toast.error('שגיאה'); }
    finally { setBusy(null); }
  };

  const pick = (child) => {
    onPick({ id: child.id, name: child.name });
    onClose();
  };

  const Row = ({ child, dim }) => (
    <Box
      onClick={() => pick(child)}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1.2, py: 0.8,
        borderRadius: 2, cursor: 'pointer', border: '1px solid',
        borderColor: child.name === currentName ? '#f59e0b' : '#e2e8f0',
        bgcolor: child.name === currentName ? '#fffbeb' : dim ? '#f8fafc' : '#fff',
        opacity: dim ? 0.65 : 1,
        '&:hover': { borderColor: '#f59e0b' },
      }}
    >
      <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', flex: 1 }}>{child.name}</Typography>
      {child.times > 0 && (
        <Typography variant="caption" sx={{ color: '#94a3b8' }}>
          {child.last_at ? new Date(child.last_at).toLocaleDateString('he-IL') : ''}
          {child.times > 1 ? ` · ${child.times} פעמים` : ''}
        </Typography>
      )}
      {dim && <Chip label="כבר היה בסבב" size="small" sx={{ height: 20, fontSize: '0.68rem' }} />}
    </Box>
  );

  const waiting = group?.waiting || [];
  const served = (group?.children || []).filter(c => c.served_this_round);
  const round = group?.round || { done: 0, total: 0 };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="xs" fullWidth
      sx={{ zIndex: (t) => t.zIndex.modal + 10 }}>
      <DialogTitle sx={{ fontWeight: 800, pb: 0.5 }}>
        {title}
        <Typography variant="caption" sx={{ display: 'block', color: '#64748b', fontWeight: 500 }}>
          {weekLabel}
        </Typography>
      </DialogTitle>

      <DialogContent>
        {loading && <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>}

        {!loading && state && (
          <Stack spacing={1.2} sx={{ mt: 0.5 }}>
            {round.total > 0 && (
              <Box>
                <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 700 }}>
                  בסבב הנוכחי: {round.done} מתוך {round.total}
                </Typography>
                <LinearProgress variant="determinate"
                  value={round.total ? (round.done / round.total) * 100 : 0}
                  sx={{ height: 6, borderRadius: 3, mt: 0.4 }} />
              </Box>
            )}

            {round.total === 0 && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                {isFather ? 'אין בכיתה ילדים שרשום להם "בן".' : 'אין בכיתה ילדות שרשום להן "בת".'}
                {' '}אפשר לסמן למטה.
              </Alert>
            )}

            {waiting.length > 0 && (
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 800, color: '#334155' }}>
                  התור שלהם
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                  {waiting.map(c => <Row key={c.id} child={c} />)}
                </Stack>
              </Box>
            )}

            {served.length > 0 && (
              <Box>
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 800, color: '#94a3b8' }}>
                  כבר היו בסבב הזה
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                  {served.map(c => <Row key={c.id} child={c} dim />)}
                </Stack>
              </Box>
            )}

            {(state.unknown_gender || []).length > 0 && (
              <Box>
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 800, color: '#b45309' }}>
                  לא רשום בן או בת — לא נכנסים לסבב
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                  {state.unknown_gender.map(c => (
                    <Box key={c.id} sx={{
                      display: 'flex', alignItems: 'center', gap: 0.8, px: 1.2, py: 0.6,
                      borderRadius: 2, border: '1px dashed #fbbf24', bgcolor: '#fffbeb',
                    }}>
                      <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', flex: 1 }}>{c.name}</Typography>
                      <Button size="small" disabled={busy === c.id}
                        onClick={() => setGender(c, 'boy')}>בן</Button>
                      <Button size="small" disabled={busy === c.id}
                        onClick={() => setGender(c, 'girl')}>בת</Button>
                    </Box>
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {currentName && (
          <Button color="inherit" onClick={() => { onPick(null); onClose(); }}>נקה</Button>
        )}
        <Button onClick={onClose}>סגור</Button>
      </DialogActions>
    </Dialog>
  );
}
