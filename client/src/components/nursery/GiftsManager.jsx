import { useState, useEffect, useCallback } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Button, TextField, MenuItem,
  Alert, CircularProgress, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, Divider, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import DownloadIcon from '@mui/icons-material/Download';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import api, { apiError, openApiFile } from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * Gift rounds, staff side.
 *
 * The screen answers one question the whole way down: which children still
 * have no photograph on their gift. That is the number that decides whether
 * the supplier file can be sent, so it is the filter that opens first once a
 * round is running.
 *
 * A parent's picks and the final choice are shown side by side rather than
 * merged, because "the family chose this" and "we chose it for them" are
 * different facts and the office gets asked which happened.
 */

const LEVELS = ['תינוקייה', 'צעירים', 'בוגרים'];

function fmt(d) {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString('he-IL');
}

export default function GiftsManager() {
  const { user } = useAuth();
  const mayManage = ['system_admin', 'branch_manager'].includes(user?.role);

  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState('');
  const [progress, setProgress] = useState(null);
  const [filter, setFilter] = useState('missing');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [picking, setPicking] = useState(null);
  const [choices, setChoices] = useState([]);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await api.get('/gifts');
      setCampaigns(res.data.campaigns || []);
      if (!selected && res.data.campaigns?.length) setSelected(String(res.data.campaigns[0]._id));
    } catch (err) {
      setError(apiError(err, 'לא הצלחנו לטעון את המבצעים'));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { loadCampaigns(); /* eslint-disable-next-line */ }, []);

  const loadProgress = useCallback(async (id = selected) => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get(`/gifts/${id}/progress`);
      setProgress(res.data);
    } catch (err) {
      setError(apiError(err, 'לא הצלחנו לטעון את המעקב'));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { if (selected) loadProgress(selected); /* eslint-disable-next-line */ }, [selected]);

  const saveCampaign = async () => {
    setError('');
    try {
      const body = {
        name: editing.name,
        opens_on: editing.opens_on,
        closes_on: editing.closes_on,
        picks_required: Number(editing.picks_required) || 2,
        products: editing.products || {},
        ...(editing._id ? { is_open: editing.is_open } : {}),
      };
      if (editing._id) await api.patch(`/gifts/${editing._id}`, body);
      else await api.post('/gifts', body);
      setEditing(null);
      await loadCampaigns();
      if (editing._id) await loadProgress(editing._id);
    } catch (err) {
      setError(apiError(err, 'השמירה נכשלה'));
    }
  };

  /**
   * Open the final-choice dialog for one child.
   *
   * The family's picks come from the progress row; anything else the gan has of
   * that child is fetched on demand, because when nobody chose, the staff need
   * something to choose FROM.
   */
  const openPicker = async (row) => {
    setPicking(row);
    setChoices(row.parent_picks || []);
    if ((row.parent_picks || []).length === 0) {
      try {
        const res = await api.get('/photos', { params: { classroom: row.classroom_id } });
        setChoices((res.data.photos || [])
          .filter(p => (p.child_ids || []).some(id => String(id) === String(row.child_id)))
          .map(p => ({ id: String(p._id), url: p.url, thumb_url: p.thumb_url, width: p.width, height: p.height })));
      } catch { /* the dialog simply offers nothing */ }
    }
  };

  const setFinal = async (photoId) => {
    try {
      await api.post(`/gifts/${selected}/children/${picking.child_id}/final`, { photo_id: photoId });
      setPicking(null);
      await loadProgress();
    } catch (err) {
      setError(apiError(err, 'השמירה נכשלה'));
    }
  };

  /**
   * Download the supplier file.
   *
   * Not window.open: the route is behind the bearer token, and a new tab
   * carries no Authorization header — it would open onto a 401 with no
   * explanation. Fetched with the token and handed to the browser as a blob.
   */
  const exportZip = async () => {
    setError('');
    try {
      const name = campaigns.find(c => String(c._id) === String(selected))?.name || 'מתנות';
      await openApiFile(`/gifts/${selected}/export`, { filename: `${name}.zip` });
    } catch (err) {
      setError(apiError(err, 'ההורדה נכשלה'));
    }
  };

  const rows = (progress?.children || []).filter(r => (filter === 'missing' ? !r.final : true));

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CardGiftcardIcon color="primary" />
          <Typography variant="h5" fontWeight={700}>מתנות</Typography>
        </Stack>
        {mayManage && (
          <Button variant="contained" size="small" onClick={() => setEditing({
            name: '', opens_on: progress?.campaign?.opens_on || '', closes_on: '',
            picks_required: 2, products: {}, is_open: true,
          })}>
            מבצע חדש
          </Button>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {campaigns.length === 0 && !loading && (
        <Alert severity="info">אין עדיין מבצעי מתנות. פתחו מבצע כדי שההורים יוכלו לבחור.</Alert>
      )}

      {campaigns.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <TextField select label="מבצע" size="small" fullWidth value={selected}
            onChange={(e) => setSelected(e.target.value)}>
            {campaigns.map(c => (
              <MenuItem key={c._id} value={String(c._id)}>
                {c.name} {c.open_for_parents ? '· פתוח' : '· סגור'}
              </MenuItem>
            ))}
          </TextField>
          {mayManage && progress?.campaign && (
            <Button size="small" onClick={() => setEditing({ ...progress.campaign })}>עריכה</Button>
          )}
          <Button size="small" variant="outlined" startIcon={<DownloadIcon />}
            onClick={exportZip} disabled={!progress?.totals?.finalised}>
            הורדה לספק
          </Button>
        </Stack>
      )}

      {progress && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip label={`${progress.totals.children} ילדים`} />
              <Chip label={`${progress.totals.parents_chose} הורים בחרו`} color="primary" variant="outlined" />
              <Chip label={`${progress.totals.finalised} סופיות`} color="success" variant="outlined" />
              <Chip label={`${progress.totals.missing} חסרות`}
                color={progress.totals.missing ? 'error' : 'success'} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              עד {fmt(progress.campaign.closes_on)} · {progress.campaign.open_for_parents ? 'ההורים עדיין יכולים לבחור' : 'הבחירה סגורה להורים'}
            </Typography>
          </CardContent>
        </Card>
      )}

      {progress && (
        <ToggleButtonGroup size="small" exclusive value={filter} sx={{ mb: 2 }}
          onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="missing">חסרות תמונה</ToggleButton>
          <ToggleButton value="all">הכל</ToggleButton>
        </ToggleButtonGroup>
      )}

      {loading && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}

      {!loading && progress && rows.length === 0 && (
        <Alert severity="success">
          {filter === 'missing' ? 'לכל הילדים נבחרה תמונה. אפשר להוריד את הקובץ לספק.' : 'אין ילדים.'}
        </Alert>
      )}

      <Stack spacing={1}>
        {rows.map(r => (
          <Card key={r.child_id}>
            <CardContent sx={{ py: 1.5 }}>
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                <Box sx={{ minWidth: 160, flexGrow: 1 }}>
                  <Typography variant="subtitle2" fontWeight={700}>{r.child_name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {r.branch} · {r.classroom}{r.product ? ` · ${r.product}` : ''}
                  </Typography>
                </Box>

                <Stack direction="row" spacing={0.5} alignItems="center">
                  {r.parent_picks.map(p => (
                    <Box key={p.id} sx={{ position: 'relative' }}>
                      <Box component="img" src={p.thumb_url} alt=""
                        sx={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 1 }} />
                      {p.low_resolution && (
                        <WarningAmberIcon color="error" fontSize="small"
                          sx={{ position: 'absolute', bottom: -4, insetInlineEnd: -4 }} />
                      )}
                    </Box>
                  ))}
                  {r.parent_picks.length === 0 && (
                    <Typography variant="caption" color="text.disabled">ההורה לא בחר</Typography>
                  )}
                </Stack>

                {r.final ? (
                  <Chip size="small" color="success"
                    label={r.final_source === 'from_parent_picks' ? 'נבחרה מבחירת ההורה' : 'נבחרה על ידי הצוות'} />
                ) : (
                  <Button size="small" variant="contained" onClick={() => openPicker(r)}>
                    בחירה סופית
                  </Button>
                )}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>

      {/* Final choice */}
      <Dialog open={!!picking} onClose={() => setPicking(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          תמונה למתנה — {picking?.child_name}
          {picking?.product && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {picking.product}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          {choices.length === 0 && (
            <Alert severity="warning">
              אין תמונות מסומנות לילד זה. יש לסמן תמונה במסך התמונות ואז לחזור לכאן.
            </Alert>
          )}
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {choices.map(p => (
              <Box key={p.id} onClick={() => setFinal(p.id)}
                sx={{ position: 'relative', aspectRatio: '1', borderRadius: 2, overflow: 'hidden', cursor: 'pointer' }}>
                <Box component="img" src={p.thumb_url} alt=""
                  sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                {p.low_resolution && (
                  <Chip label="איכות נמוכה" size="small" color="error"
                    sx={{ position: 'absolute', bottom: 4, insetInlineStart: 4 }} />
                )}
              </Box>
            ))}
          </Box>
        </DialogContent>
        <DialogActions><Button onClick={() => setPicking(null)}>סגירה</Button></DialogActions>
      </Dialog>

      {/* Campaign editor */}
      <Dialog open={!!editing} onClose={() => setEditing(null)} fullWidth maxWidth="sm">
        <DialogTitle>{editing?._id ? 'עריכת מבצע' : 'מבצע מתנות חדש'}</DialogTitle>
        <DialogContent>
          {editing && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="שם המבצע" value={editing.name} fullWidth
                placeholder="מתנות ראש השנה"
                onChange={(e) => setEditing(v => ({ ...v, name: e.target.value }))} />
              <Stack direction="row" spacing={2}>
                <TextField label="פתיחה" type="date" fullWidth InputLabelProps={{ shrink: true }}
                  value={editing.opens_on || ''}
                  onChange={(e) => setEditing(v => ({ ...v, opens_on: e.target.value }))} />
                <TextField label="סגירה" type="date" fullWidth InputLabelProps={{ shrink: true }}
                  value={editing.closes_on || ''}
                  onChange={(e) => setEditing(v => ({ ...v, closes_on: e.target.value }))} />
              </Stack>
              <TextField label="כמה תמונות ההורה בוחר" type="number" fullWidth
                value={editing.picks_required}
                onChange={(e) => setEditing(v => ({ ...v, picks_required: e.target.value }))} />

              <Divider />
              <Typography variant="subtitle2" fontWeight={700}>המתנה בכל רמת כיתה</Typography>
              <Typography variant="caption" color="text.secondary">
                אותה מתנה בכל הסניפים. רמה שנשארת ריקה — לא מקבלת מתנה במבצע הזה.
              </Typography>
              {LEVELS.map(level => (
                <TextField key={level} label={level} fullWidth size="small"
                  value={editing.products?.[level] || ''}
                  onChange={(e) => setEditing(v => ({
                    ...v, products: { ...(v.products || {}), [level]: e.target.value },
                  }))} />
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>ביטול</Button>
          <Button variant="contained" onClick={saveCampaign}>שמירה</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
