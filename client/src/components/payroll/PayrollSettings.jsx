import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody,
  TextField, Select, MenuItem, IconButton, Button, Divider, Chip, Alert,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * Payroll settings panel — currently houses two admin tools:
 *   1. PresetOptionsManager — define the dropdown values for fields like
 *      "אחוז מתשלום השכר בהתאמה לקיזוז המקדמה". Each option has a textual
 *      label + an action that says what the bookkeeping system should do.
 *   2. AmutaBranchMapping — assign each branch to a legal entity (amuta).
 *      Drives the per-amuta column groups in the monthly payroll table.
 */
const ACTION_LABELS = {
  deduct_advance:    'קיזוז המקדמה ששולמה',
  pay_full:          'להפקיד שכר מלא (קיזוז בחודש הבא)',
  partial_percent:   'תשלום אחוז משכר (חל"ת)',
  custom:            'מותאם — הערה חופשית',
};

function PresetOptionsManager() {
  const FIELD = 'advance_deduction';
  const [options, setOptions] = useState([]);
  const [draft, setDraft] = useState({ label: '', action: 'custom', percent: 50 });

  const load = useCallback(() => {
    api.get('/payroll-month/presets', { params: { field_name: FIELD } })
      .then(res => setOptions(res.data.options || []))
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת אפשרויות'); });
  }, []);

  useEffect(load, [load]);

  const create = () => {
    if (!draft.label.trim()) return toast.error('יש להזין שם אפשרות');
    const params = draft.action === 'partial_percent' ? { percent: Number(draft.percent) || 0 } : {};
    api.post('/payroll-month/presets', {
      field_name: FIELD,
      label: draft.label.trim(),
      action: draft.action,
      action_params: params,
    })
      .then(() => { setDraft({ label: '', action: 'custom', percent: 50 }); load(); toast.success('אפשרות נוספה'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const update = (id, patch) => {
    api.patch(`/payroll-month/presets/${id}`, patch)
      .then(() => load())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const remove = (id) => {
    if (!confirm('להסיר אפשרות זו?')) return;
    api.delete(`/payroll-month/presets/${id}`)
      .then(() => load())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: 2, mb: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>אפשרויות לקיזוז מקדמה</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        כל אפשרות מקבלת תווית (טקסט שמופיע בטבלה) + פעולה שמסבירה לחישוב מה לעשות.
      </Typography>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>תווית</TableCell>
            <TableCell>פעולה</TableCell>
            <TableCell align="center">בשימוש</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {options.map(o => (
            <TableRow key={o.id}>
              <TableCell>
                <TextField
                  size="small"
                  value={o.label}
                  onChange={e => setOptions(opts => opts.map(x => x.id === o.id ? { ...x, label: e.target.value } : x))}
                  onBlur={() => update(o.id, { label: o.label })}
                  variant="standard"
                  fullWidth
                />
              </TableCell>
              <TableCell>
                <Select
                  size="small"
                  value={o.action}
                  onChange={e => update(o.id, { action: e.target.value })}
                  variant="standard"
                  sx={{ minWidth: 240 }}
                >
                  {Object.entries(ACTION_LABELS).map(([k, v]) => (
                    <MenuItem key={k} value={k}>{v}</MenuItem>
                  ))}
                </Select>
                {o.action === 'partial_percent' && (
                  <TextField
                    size="small"
                    type="number"
                    label="%"
                    value={o.action_params?.percent || 0}
                    onChange={e => update(o.id, { action_params: { percent: Number(e.target.value) } })}
                    sx={{ width: 80, ml: 1 }}
                  />
                )}
              </TableCell>
              <TableCell align="center">{o.usage_count || 0}</TableCell>
              <TableCell align="left">
                <IconButton size="small" color="error" onClick={() => remove(o.id)}><DeleteIcon fontSize="small" /></IconButton>
              </TableCell>
            </TableRow>
          ))}
          {options.length === 0 && (
            <TableRow><TableCell colSpan={4} align="center" sx={{ color: 'text.disabled' }}>אין אפשרויות שמורות</TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      <Divider sx={{ my: 1.5 }} />

      <Stack direction="row" spacing={1} alignItems="center">
        <TextField size="small" label="תווית חדשה" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} sx={{ flex: 1 }} />
        <Select size="small" value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })} sx={{ minWidth: 220 }}>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <MenuItem key={k} value={k}>{v}</MenuItem>
          ))}
        </Select>
        {draft.action === 'partial_percent' && (
          <TextField size="small" type="number" label="%" value={draft.percent} onChange={e => setDraft({ ...draft, percent: e.target.value })} sx={{ width: 90 }} />
        )}
        <Button variant="contained" startIcon={<AddIcon />} onClick={create}>הוסף</Button>
      </Stack>
    </Paper>
  );
}

function AmutaBranchMapping() {
  const [amutot, setAmutot] = useState([]);
  const [branches, setBranches] = useState([]);
  const [newAmuta, setNewAmuta] = useState('');

  const load = useCallback(() => {
    api.get('/payroll-month/amutot')
      .then(res => { setAmutot(res.data.amutot || []); setBranches(res.data.branches || []); })
      .catch(err => { console.error(err); toast.error('שגיאה בטעינת עמותות'); });
  }, []);

  useEffect(load, [load]);

  const createAmuta = () => {
    if (!newAmuta.trim()) return;
    api.put('/payroll-month/amutot/new', { name: newAmuta.trim() })
      .then(() => { setNewAmuta(''); load(); toast.success('עמותה נוספה'); })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  const setBranchAmuta = (branchId, amutaId) => {
    api.put(`/payroll-month/branches/${branchId}/amuta`, { amuta_id: amutaId || null })
      .then(() => load())
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה'));
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>מיפוי סניפים לעמותות</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        כל סניף משויך לעמותה אחת. שעות החתמה בסניף X נכנסות לעמודות העמותה של X.
      </Typography>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>עמותות קיימות</Typography>
          {amutot.length === 0 && <Alert severity="warning" sx={{ mb: 1 }}>אין עמותות מוגדרות.</Alert>}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {amutot.map(a => <Chip key={a.id} label={a.name} variant="outlined" />)}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField size="small" placeholder="שם עמותה חדשה" value={newAmuta} onChange={e => setNewAmuta(e.target.value)} />
            <Button startIcon={<AddIcon />} onClick={createAmuta}>הוסף עמותה</Button>
          </Stack>
        </Box>
      </Stack>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>סניף</TableCell>
            <TableCell>עמותה</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {branches.map(b => (
            <TableRow key={b.id}>
              <TableCell>{b.name}</TableCell>
              <TableCell>
                <Select
                  size="small"
                  value={b.amuta_id || ''}
                  displayEmpty
                  onChange={e => setBranchAmuta(b.id, e.target.value)}
                  sx={{ minWidth: 240 }}
                >
                  <MenuItem value=""><em>— ללא —</em></MenuItem>
                  {amutot.map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

export default function PayrollSettings() {
  return (
    <Box dir="rtl" sx={{ maxWidth: 1100, mx: 'auto' }}>
      <PresetOptionsManager />
      <AmutaBranchMapping />
    </Box>
  );
}
