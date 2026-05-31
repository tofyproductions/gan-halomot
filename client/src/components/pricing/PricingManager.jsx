import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody,
  TextField, ToggleButton, ToggleButtonGroup, IconButton, Button, Divider,
  Alert, InputAdornment, MenuItem, Select, CircularProgress, Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

// Age columns for the state subsidy matrix (by age in months).
const DEFAULT_AGE_GROUPS = ['עד 15 חודש', '15–24 חודש', 'מעל 24 חודש'];

// Official Ministry of Labor tuition table — מעונות יום תשפ"ו, תקינה מורחבת.
// Each value = the PARENT's share (השתתפות הורים) per age group.
// Full tariff (parent + state): 3,936 / 2,917 / 2,587. Source: tuition-25-me.pdf.
const DEFAULT_TIERS = [
  { label: 'דרגה 3 (0–2,330)',      prices: [1157, 938, 941] },
  { label: 'דרגה 4 (2,331–2,880)',  prices: [1401, 1109, 1113] },
  { label: 'דרגה 5 (2,881–3,330)',  prices: [1663, 1318, 1318] },
  { label: 'דרגה 6 (3,331–3,880)',  prices: [1748, 1377, 1382] },
  { label: 'דרגה 7 (3,881–4,440)',  prices: [2011, 1549, 1554] },
  { label: 'דרגה 8 (4,441–4,880)',  prices: [2180, 1703, 1709] },
  { label: 'דרגה 9 (4,881–5,440)',  prices: [2328, 1811, 1817] },
  { label: 'דרגה 10 (5,441–5,880)', prices: [2432, 1908, 1914] },
  { label: 'דרגה 11 (5,881–6,660)', prices: [3936, 2917, 2587] },
  { label: 'דרגה 12 (מעל 6,660)',   prices: [3936, 2917, 2587] },
  { label: 'דרגה 14',               prices: [1054, 835, 837] },
  { label: 'דרגה 15',               prices: [952, 731, 734] },
];

const DEFAULT_ADDONS = [
  'חצי שעת הארכה בבוקר',
  'שעת הארכה אחר הצהריים',
  'תפריט תזונתי בשרי',
  'יחס חניכה מורחב',
  'חוגים שכלולים בסל',
  'גאנט עבודה חודשי',
  'לוח עדכונים דיגיטלי להורים בתינוקייה',
];

// Empty pricing shape used when a branch has no doc yet.
function emptyPricing() {
  return {
    pricing_type: 'subsidized',
    fixed_monthly_fee: 0,
    age_groups: [...DEFAULT_AGE_GROUPS],
    tiers: DEFAULT_TIERS.map(t => ({ label: t.label, prices: [...t.prices] })),
    addons: DEFAULT_ADDONS.map(label => ({ label, price: 0, is_active: true })),
    one_time: { insurance: 0, registration: 0 },
    notes: '',
  };
}

// Normalize a doc from the server into the editable shape (fill defaults if empty).
function normalize(doc) {
  if (!doc) return emptyPricing();
  const ageGroups = doc.age_groups?.length ? [...doc.age_groups] : [...DEFAULT_AGE_GROUPS];
  const tiers = (doc.tiers?.length ? doc.tiers : DEFAULT_TIERS)
    .map(t => ({
      label: t.label || '',
      // keep prices index-aligned to ageGroups length
      prices: ageGroups.map((_, i) => Number(t.prices?.[i] ?? 0)),
    }));
  return {
    pricing_type: doc.pricing_type || 'subsidized',
    fixed_monthly_fee: Number(doc.fixed_monthly_fee ?? 0),
    age_groups: ageGroups,
    tiers,
    addons: (doc.addons?.length ? doc.addons : DEFAULT_ADDONS.map(label => ({ label, price: 0 })))
      .map(a => ({ label: a.label || '', price: Number(a.price ?? 0), is_active: a.is_active !== false })),
    one_time: {
      insurance: Number(doc.one_time?.insurance ?? 0),
      registration: Number(doc.one_time?.registration ?? 0),
    },
    notes: doc.notes || '',
  };
}

const shekel = { startAdornment: <InputAdornment position="start">₪</InputAdornment> };

export default function PricingManager() {
  const { branches } = useBranch();
  const [branchId, setBranchId] = useState('');
  const [pricing, setPricing] = useState(emptyPricing());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Pick a real branch (never the 'all' pseudo-branch) once branches load.
  useEffect(() => {
    if (!branchId && branches.length) setBranchId(branches[0]._id || branches[0].id);
  }, [branches, branchId]);

  const load = useCallback((id) => {
    if (!id) return;
    setLoading(true);
    api.get(`/branch-pricing/${id}`)
      .then(res => { setPricing(normalize(res.data.pricing)); setDirty(false); })
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת המחירים'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (branchId) load(branchId); }, [branchId, load]);

  const patch = (changes) => { setPricing(p => ({ ...p, ...changes })); setDirty(true); };

  const save = () => {
    setSaving(true);
    api.put(`/branch-pricing/${branchId}`, pricing)
      .then(() => { toast.success('המחירים נשמרו'); setDirty(false); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בשמירה'))
      .finally(() => setSaving(false));
  };

  // --- subsidized matrix editing (index-aligned) ---
  const setCell = (tierIdx, agIdx, value) => {
    const tiers = pricing.tiers.map((t, i) =>
      i === tierIdx ? { ...t, prices: t.prices.map((p, j) => (j === agIdx ? value : p)) } : t);
    patch({ tiers });
  };
  const setTierLabel = (tierIdx, label) =>
    patch({ tiers: pricing.tiers.map((t, i) => (i === tierIdx ? { ...t, label } : t)) });
  const addTier = () =>
    patch({ tiers: [...pricing.tiers, { label: '', prices: pricing.age_groups.map(() => 0) }] });
  const removeTier = (tierIdx) =>
    patch({ tiers: pricing.tiers.filter((_, i) => i !== tierIdx) });

  const setAgeGroup = (agIdx, label) =>
    patch({ age_groups: pricing.age_groups.map((g, i) => (i === agIdx ? label : g)) });
  const addAgeGroup = () =>
    patch({
      age_groups: [...pricing.age_groups, ''],
      tiers: pricing.tiers.map(t => ({ ...t, prices: [...t.prices, 0] })),
    });
  const removeAgeGroup = (agIdx) =>
    patch({
      age_groups: pricing.age_groups.filter((_, i) => i !== agIdx),
      tiers: pricing.tiers.map(t => ({ ...t, prices: t.prices.filter((_, j) => j !== agIdx) })),
    });

  // --- add-ons ---
  const setAddon = (idx, changes) =>
    patch({ addons: pricing.addons.map((a, i) => (i === idx ? { ...a, ...changes } : a)) });
  const addAddon = () => patch({ addons: [...pricing.addons, { label: '', price: 0, is_active: true }] });
  const removeAddon = (idx) => patch({ addons: pricing.addons.filter((_, i) => i !== idx) });

  const isPrivate = pricing.pricing_type === 'private';

  return (
    <Box dir="rtl" sx={{ maxWidth: 1100, mx: 'auto', pb: 6 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מחירי המעונות</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Select size="small" value={branchId} onChange={e => setBranchId(e.target.value)} sx={{ minWidth: 220 }}>
            {branches.map(b => (
              <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
            ))}
          </Select>
          <Button
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            onClick={save}
            disabled={saving || loading || !branchId}
          >
            שמירה
          </Button>
        </Stack>
      </Stack>

      {dirty && <Alert severity="info" sx={{ mb: 2 }}>יש שינויים שלא נשמרו.</Alert>}

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : (
        <>
          {/* Branch type */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>סוג המעון</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={pricing.pricing_type}
              onChange={(_, v) => v && patch({ pricing_type: v })}
            >
              <ToggleButton value="subsidized">מעון סמל (מסובסד ע"י התמ"ת)</ToggleButton>
              <ToggleButton value="private">מעון פרטי (מחיר אחיד)</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {isPrivate
                ? 'מחיר אחיד וקבוע הכולל את כל השירות, ללא משתנים.'
                : 'מחיר הבסיס נקבע ע"י המדינה לפי דרגת סבסוד וקבוצת גיל. מעליו מתווספות תוספות וחיובים חד-פעמיים.'}
            </Typography>
          </Paper>

          {/* Private: single fixed fee */}
          {isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>מחיר חודשי קבוע</Typography>
              <TextField
                type="number"
                size="small"
                label="מחיר להורה לחודש"
                value={pricing.fixed_monthly_fee}
                onChange={e => patch({ fixed_monthly_fee: Number(e.target.value) })}
                InputProps={shekel}
                sx={{ width: 240 }}
              />
            </Paper>
          )}

          {/* Subsidized: state price matrix */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 800 }}>מחיר בסיס (גרף המדינה)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    שורה = דרגת סבסוד, עמודה = קבוצת גיל. הזן את המחיר שההורה משלם בכל תא.
                  </Typography>
                </Box>
                <Button size="small" startIcon={<AddIcon />} onClick={addAgeGroup}>הוסף קבוצת גיל</Button>
              </Stack>

              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>דרגת סבסוד</TableCell>
                      {pricing.age_groups.map((ag, agIdx) => (
                        <TableCell key={agIdx} align="center" sx={{ minWidth: 150 }}>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <TextField
                              size="small" variant="standard" value={ag}
                              placeholder="קבוצת גיל"
                              onChange={e => setAgeGroup(agIdx, e.target.value)}
                              fullWidth
                            />
                            <Tooltip title="מחק קבוצת גיל">
                              <IconButton size="small" color="error" onClick={() => removeAgeGroup(agIdx)}>
                                <DeleteIcon fontSize="inherit" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      ))}
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pricing.tiers.map((tier, tierIdx) => (
                      <TableRow key={tierIdx}>
                        <TableCell>
                          <TextField
                            size="small" variant="standard" value={tier.label}
                            placeholder="שם דרגה"
                            onChange={e => setTierLabel(tierIdx, e.target.value)}
                            fullWidth
                          />
                        </TableCell>
                        {pricing.age_groups.map((_, agIdx) => (
                          <TableCell key={agIdx} align="center">
                            <TextField
                              size="small" type="number" variant="standard"
                              value={tier.prices[agIdx] ?? 0}
                              onChange={e => setCell(tierIdx, agIdx, Number(e.target.value))}
                              sx={{ width: 110 }}
                            />
                          </TableCell>
                        ))}
                        <TableCell align="left">
                          <IconButton size="small" color="error" onClick={() => removeTier(tierIdx)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                    {pricing.tiers.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={pricing.age_groups.length + 2} align="center" sx={{ color: 'text.disabled' }}>
                          אין דרגות מוגדרות
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Box>
              <Button size="small" startIcon={<AddIcon />} onClick={addTier} sx={{ mt: 1 }}>הוסף דרגה</Button>
            </Paper>
          )}

          {/* Subsidized: add-ons */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>תוספות (חודשי)</Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>תוספת</TableCell>
                    <TableCell sx={{ fontWeight: 700, width: 160 }}>מחיר חודשי</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pricing.addons.map((a, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <TextField
                          size="small" variant="standard" value={a.label}
                          placeholder="שם תוספת"
                          onChange={e => setAddon(idx, { label: e.target.value })}
                          fullWidth
                        />
                      </TableCell>
                      <TableCell>
                        <TextField
                          size="small" type="number" variant="standard"
                          value={a.price}
                          onChange={e => setAddon(idx, { price: Number(e.target.value) })}
                          sx={{ width: 120 }}
                        />
                      </TableCell>
                      <TableCell align="left">
                        <IconButton size="small" color="error" onClick={() => removeAddon(idx)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {pricing.addons.length === 0 && (
                    <TableRow><TableCell colSpan={3} align="center" sx={{ color: 'text.disabled' }}>אין תוספות</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              <Button size="small" startIcon={<AddIcon />} onClick={addAddon} sx={{ mt: 1 }}>הוסף תוספת</Button>
            </Paper>
          )}

          {/* One-time fees */}
          {!isPrivate && (
            <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>חיובים חד-פעמיים</Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                <TextField
                  type="number" size="small" label="ביטוח"
                  value={pricing.one_time.insurance}
                  onChange={e => patch({ one_time: { ...pricing.one_time, insurance: Number(e.target.value) } })}
                  InputProps={shekel} sx={{ width: 200 }}
                />
                <TextField
                  type="number" size="small" label="דמי רישום"
                  value={pricing.one_time.registration}
                  onChange={e => patch({ one_time: { ...pricing.one_time, registration: Number(e.target.value) } })}
                  InputProps={shekel} sx={{ width: 200 }}
                />
              </Stack>
            </Paper>
          )}

          {/* Notes */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>הערות</Typography>
            <TextField
              size="small" multiline minRows={2} fullWidth
              value={pricing.notes}
              onChange={e => patch({ notes: e.target.value })}
              placeholder="הערות פנימיות על המחירון"
            />
          </Paper>

          <Divider sx={{ my: 2 }} />
          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
              onClick={save}
              disabled={saving || loading || !branchId}
            >
              שמירה
            </Button>
          </Stack>
        </>
      )}
    </Box>
  );
}
