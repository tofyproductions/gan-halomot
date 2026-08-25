import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box, Stack, Card, CardContent, Typography, Chip, TextField, InputAdornment,
  Alert, Button, Dialog, DialogTitle, DialogContent, DialogActions, Divider,
  ToggleButton, ToggleButtonGroup, LinearProgress, IconButton, Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CheckIcon from '@mui/icons-material/Check';
import { toast } from 'react-toastify';
import api, { apiError } from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/**
 * מה חסר — every child in the gan, and what the family owes.
 *
 * ONE LIST FOR THE WHOLE GAN, not one per room. The question is asked at the
 * door — "who do I need to catch this afternoon" — and the answer crosses
 * rooms, so a screen that made you pick a room first would be answering a
 * different question.
 *
 * Children WITH something outstanding come first. The default view is the work
 * that is left; a roster sorted by name buries eleven open items among ninety
 * children who owe nothing, which is how the list stops being read.
 *
 * Marking is one tap per item on one child, and saves immediately. A screen
 * with a save button is a screen where somebody ticks four things, gets called
 * away, and loses them.
 */

function ChildDialog({ child, catalogue, onClose, onSaved }) {
  const [picked, setPicked] = useState(() => new Set((child?.missing || []).map((m) => m.key)));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  if (!child) return null;

  const toggle = (key) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const save = async () => {
    setBusy(true);
    try {
      const missing = [...picked].map((key) => {
        const known = catalogue.find((c) => c.key === key);
        return known ? { key } : { key, label: key };
      });
      const res = await api.put(`/supplies/${child.id}`, { missing });
      toast.success(missing.length ? 'נשמר' : 'הרשימה נוקתה');
      onSaved(child.id, res.data.missing || []);
      onClose();
    } catch (err) { toast.error(apiError(err, 'שגיאה בשמירה')); }
    finally { setBusy(false); }
  };

  const addCustom = () => {
    const v = custom.trim();
    if (!v) return;
    setPicked((s) => new Set(s).add(v));
    setCustom('');
  };

  const extras = [...picked].filter((k) => !catalogue.some((c) => c.key === k));

  return (
    <Dialog open onClose={onClose} dir="rtl" maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {child.name}
        {child.classroom_name && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
            {child.classroom_name}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent dividers>
        {busy && <LinearProgress sx={{ mb: 1 }} />}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          סמנו מה חסר. ההורה רואה את זה באפליקציה.
        </Typography>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {catalogue.map((item) => {
            const on = picked.has(item.key);
            return (
              <Chip
                key={item.key}
                onClick={() => toggle(item.key)}
                icon={<span style={{ fontSize: 16, paddingInlineStart: 6 }}>{item.emoji}</span>}
                label={item.label}
                sx={{
                  fontWeight: 700, cursor: 'pointer',
                  bgcolor: on ? item.color : 'action.hover',
                  color: on ? '#fff' : 'text.primary',
                  '&:hover': { bgcolor: on ? item.color : 'action.selected' },
                }}
              />
            );
          })}
        </Box>

        {extras.length > 0 && (
          <>
            <Divider sx={{ my: 2 }}><Typography variant="caption">פריטים שהוקלדו</Typography></Divider>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {extras.map((k) => (
                <Chip key={k} label={k} onDelete={() => toggle(k)} color="primary" sx={{ fontWeight: 700 }} />
              ))}
            </Box>
          </>
        )}

        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <TextField
            size="small" fullWidth label="פריט אחר" value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
          />
          <Button onClick={addCustom} disabled={!custom.trim()}>הוסף</Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={busy}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function SuppliesBoard() {
  const { selectedBranch, selectedBranchName } = useBranch();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('missing');
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    if (!selectedBranch || selectedBranch === 'all') { setData(null); return; }
    setError('');
    api.get('/supplies', { params: { branch: selectedBranch } })
      .then((res) => setData(res.data))
      .catch((err) => setError(apiError(err, 'שגיאה בטעינה')));
  }, [selectedBranch]);

  useEffect(load, [load]);

  const applySaved = (childId, missing) => {
    setData((d) => (!d ? d : {
      ...d,
      children: d.children.map((c) => (c.id === childId ? { ...c, missing } : c)),
    }));
  };

  const shown = useMemo(() => {
    if (!data) return [];
    const q = search.trim();
    return data.children
      .filter((c) => (filter === 'all' ? true : c.missing.length > 0))
      .filter((c) => !q || c.name.includes(q) || (c.classroom_name || '').includes(q))
      // Anybody who owes something first, then the longest-outstanding.
      .sort((a, b) => {
        if (!!b.missing.length !== !!a.missing.length) return b.missing.length - a.missing.length;
        if (a.missing.length && b.missing.length) {
          return new Date(a.missing[0].marked_at) - new Date(b.missing[0].marked_at);
        }
        return a.name.localeCompare(b.name, 'he');
      });
  }, [data, search, filter]);

  if (selectedBranch === 'all' || !selectedBranch) {
    return <Alert severity="info">בחרו סניף כדי לראות מה חסר.</Alert>;
  }
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <LinearProgress />;

  const owing = data.children.filter((c) => c.missing.length > 0).length;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מה חסר — {selectedBranchName}</Typography>
        <Typography variant="caption" color="text.secondary">
          {owing > 0 ? `${owing} מתוך ${data.children.length} ילדים` : `אין חוסרים · ${data.children.length} ילדים`}
        </Typography>
      </Box>

      {/* A roster that silently omits people is worse than one that says it is short. */}
      {data.unplaced_children > 0 && (
        <Alert severity="warning">
          {data.unplaced_children} ילדים אינם משויכים לכיתה ולכן אינם ברשימה.
          שייכו אותם לכיתה במסך השיבוץ.
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small" placeholder="חיפוש שם או כיתה" value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ flex: 1, minWidth: 200 }}
        />
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="missing">רק מי שחסר לו</ToggleButton>
          <ToggleButton value="all">כל הילדים</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {shown.length === 0 && (
        <Alert severity="success">
          {filter === 'missing' ? 'לא חסר כלום לאף ילד.' : 'לא נמצאו ילדים.'}
        </Alert>
      )}

      {shown.map((c) => (
        <Card key={c.id} variant="outlined" sx={{ borderRadius: 3 }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                  <Typography sx={{ fontWeight: 800 }}>{c.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{c.classroom_name}</Typography>
                </Stack>

                {c.missing.length === 0 ? (
                  <Typography variant="body2" color="success.main" sx={{ mt: 0.5, fontWeight: 700 }}>
                    <CheckIcon fontSize="inherit" /> לא חסר כלום
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75 }}>
                    {c.missing.map((m) => (
                      <Tooltip
                        key={m.key}
                        title={m.marked_at ? `סומן ב-${new Date(m.marked_at).toLocaleDateString('he-IL')}${m.marked_by_name ? ` · ${m.marked_by_name}` : ''}` : ''}
                      >
                        <Chip
                          size="small"
                          icon={<span style={{ fontSize: 14, paddingInlineStart: 5 }}>{m.emoji}</span>}
                          label={m.label}
                          sx={{ fontWeight: 700, bgcolor: `${m.color}22` }}
                        />
                      </Tooltip>
                    ))}
                  </Box>
                )}
              </Box>

              <Button size="small" variant="outlined" onClick={() => setOpen(c)}>
                {c.missing.length ? 'עדכן' : 'סמן'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ))}

      {data.catalogue_note && (
        <Alert severity="info" icon={false} sx={{ fontWeight: 700, textAlign: 'center' }}>
          ⭐ {data.catalogue_note} ⭐
        </Alert>
      )}

      {open && (
        <ChildDialog
          child={open}
          catalogue={data.catalogue}
          onClose={() => setOpen(null)}
          onSaved={applySaved}
        />
      )}
    </Stack>
  );
}
