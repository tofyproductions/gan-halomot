import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { API_ORIGIN } from '../../api/config';
import {
  Box, Paper, Typography, Stack, Button, TextField, MenuItem, Alert,
  CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FavoriteIcon from '@mui/icons-material/Favorite';

// Public — no JWT.
const publicApi = axios.create({ baseURL: `${API_ORIGIN}/api/public`, timeout: 30000 });

/**
 * Public new-parent inquiry form. Reached from a marketed link:
 *   /lead            — general: the parent picks a branch (or "not sure yet")
 *   /lead/:branchId  — per-branch: that branch is preset (ad campaign per gan)
 * On submit it creates a Lead; the branch manager gets an email + sees it in
 * the leads page. No login, standalone (outside the admin shell).
 */
export default function LeadForm() {
  const { branchId } = useParams();
  const [params] = useSearchParams();
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    parent_name: '', parent_phone: '', parent_email: '',
    child_name: '', child_birth_date: '', message: '',
    branch_id: branchId || '',
  });

  useEffect(() => {
    publicApi.get('/lead-branches')
      .then(res => setBranches(res.data.branches || []))
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.parent_name.trim()) return setError('נא למלא שם');
    if (form.parent_phone.replace(/\D/g, '').length < 9) return setError('נא למלא מספר טלפון תקין');
    setSaving(true);
    try {
      await publicApi.post('/lead', {
        ...form,
        branch_id: form.branch_id || null,
        source: params.get('utm_source') || params.get('source') || '',
      });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה בשליחה, נסו שוב');
    } finally {
      setSaving(false);
    }
  };

  const presetBranch = branchId ? branches.find(b => b.id === branchId) : null;

  return (
    <Box dir="rtl" sx={{ minHeight: '100vh', bgcolor: '#fdf6ec', display: 'flex', alignItems: 'center', justifyContent: 'center', px: 2, py: 4 }}>
      <Paper elevation={3} sx={{ maxWidth: 480, width: '100%', borderRadius: 4, overflow: 'hidden' }}>
        <Box sx={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#fff', p: 3, textAlign: 'center' }}>
          <Typography variant="h4" sx={{ fontWeight: 900, fontFamily: 'Varela Round' }}>גן החלומות</Typography>
          <Typography sx={{ opacity: 0.95, mt: 0.5 }}>שמחים שאתם מתעניינים! 🎈</Typography>
        </Box>

        {done ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 1 }} />
            <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>תודה רבה!</Typography>
            <Typography color="text.secondary">
              הפרטים התקבלו. ניצור אתכם קשר בהקדם 💛
            </Typography>
          </Box>
        ) : loading ? (
          <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>
        ) : (
          <Box component="form" onSubmit={submit} sx={{ p: 3 }}>
            <Typography color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
              מלאו פרטים ונחזור אליכם עם כל המידע על הגן{presetBranch ? ` — ${presetBranch.name}` : ''}.
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Stack spacing={2}>
              <TextField label="שם ההורה *" value={form.parent_name} onChange={e => set('parent_name', e.target.value)} fullWidth autoFocus />
              <TextField label="טלפון *" value={form.parent_phone} onChange={e => set('parent_phone', e.target.value)} fullWidth
                inputProps={{ dir: 'ltr', inputMode: 'tel' }} />
              <TextField label="אימייל" type="email" value={form.parent_email} onChange={e => set('parent_email', e.target.value)} fullWidth
                inputProps={{ dir: 'ltr' }} />
              {!branchId && (
                <TextField select label="הגן המבוקש" value={form.branch_id} onChange={e => set('branch_id', e.target.value)} fullWidth>
                  <MenuItem value="">עדיין לא בטוח/ה</MenuItem>
                  {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
                </TextField>
              )}
              <TextField label="שם הילד/ה" value={form.child_name} onChange={e => set('child_name', e.target.value)} fullWidth />
              <TextField label="גיל / תאריך לידה" value={form.child_birth_date} onChange={e => set('child_birth_date', e.target.value)} fullWidth
                placeholder="לדוגמה: 2024-03 או בן שנה" />
              <TextField label="הודעה (לא חובה)" value={form.message} onChange={e => set('message', e.target.value)} fullWidth multiline minRows={2} />
              <Button type="submit" variant="contained" size="large" disabled={saving}
                startIcon={<FavoriteIcon />} sx={{ py: 1.3, fontWeight: 800 }}>
                {saving ? 'שולח…' : 'שלחו פרטים'}
              </Button>
            </Stack>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
