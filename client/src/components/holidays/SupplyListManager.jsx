import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Button, Stack, IconButton, Tooltip, TextField,
  Paper, Divider, Collapse,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import ImageIcon from '@mui/icons-material/Image';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * "רשימת ציוד להורים" — a single global list (no branch selector, see
 * server/src/models/SupplyList.js): add/remove/edit rows here, then export the
 * poster PNG. Mirrors the poster button on HolidayManager.jsx — same
 * server-side render, same authenticated-blob download.
 */
export default function SupplyListManager() {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showHeaderFields, setShowHeaderFields] = useState(false);

  const fetchList = useCallback(() => {
    setLoading(true);
    api.get('/parent-supply-list')
      .then(res => setDoc(res.data))
      .catch(() => toast.error('שגיאה בטעינת רשימת הציוד'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const setField = (field, value) => setDoc(prev => ({ ...prev, [field]: value }));

  const setItem = (idx, field, value) => setDoc(prev => ({
    ...prev,
    items: prev.items.map((it, i) => (i === idx ? { ...it, [field]: value } : it)),
  }));

  const addItem = () => setDoc(prev => ({
    ...prev,
    items: [...prev.items, { name: '', note: '', emoji: '', color: '#2e7dd7' }],
  }));

  const removeItem = (idx) => setDoc(prev => ({
    ...prev,
    items: prev.items.filter((_, i) => i !== idx),
  }));

  const save = async () => {
    if (doc.items.some(it => !it.name.trim())) {
      return toast.error('לכל פריט חייב להיות שם');
    }
    setSaving(true);
    try {
      const res = await api.put('/parent-supply-list', {
        title: doc.title, subtitle: doc.subtitle, lead: doc.lead,
        callout: doc.callout, footer: doc.footer, items: doc.items,
      });
      setDoc(res.data);
      toast.success('הרשימה נשמרה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally { setSaving(false); }
  };

  const exportPoster = async () => {
    setExporting(true);
    try {
      const res = await api.get('/parent-supply-list/poster', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'רשימת-ציוד.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      toast.error('שגיאה בהפקת התמונה — נסו שוב בעוד רגע');
    } finally { setExporting(false); }
  };

  if (loading || !doc) {
    return <Box dir="rtl" sx={{ maxWidth: 800, mx: 'auto', p: 3 }}><Typography>טוען...</Typography></Box>;
  }

  return (
    <Box dir="rtl" sx={{ maxWidth: 800, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>רשימת ציוד להורים</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<ImageIcon />} onClick={exportPoster} disabled={exporting}>
            ייצוא תמונה
          </Button>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={saving}>
            שמור
          </Button>
        </Stack>
      </Stack>

      {/* Header/footer texts — collapsed by default since the defaults are
          usually fine; the items below are what actually changes often. */}
      <Paper sx={{ borderRadius: 2, mb: 2 }}>
        <Button fullWidth onClick={() => setShowHeaderFields(v => !v)}
          sx={{ justifyContent: 'space-between', px: 2, py: 1, color: 'text.secondary' }}
          endIcon={<ExpandMoreIcon sx={{ transform: showHeaderFields ? 'rotate(180deg)' : 'none', transition: '0.2s' }} />}
        >
          כותרות ותחתית הפוסטר
        </Button>
        <Collapse in={showHeaderFields}>
          <Divider />
          <Stack spacing={2} sx={{ p: 2 }}>
            <Stack direction="row" spacing={2}>
              <TextField label="כותרת" value={doc.title} fullWidth onChange={e => setField('title', e.target.value)} />
              <TextField label="שם הגן" value={doc.subtitle} fullWidth onChange={e => setField('subtitle', e.target.value)} />
            </Stack>
            <TextField label="שורת פתיחה" value={doc.lead} fullWidth onChange={e => setField('lead', e.target.value)} />
            <TextField label="תיבת הדגשה" value={doc.callout} fullWidth onChange={e => setField('callout', e.target.value)} />
            <TextField label="שורת תחתית" value={doc.footer} fullWidth onChange={e => setField('footer', e.target.value)} />
          </Stack>
        </Collapse>
      </Paper>

      {/* Items */}
      <Stack spacing={1.5}>
        {doc.items.map((it, idx) => (
          <Paper key={idx} sx={{ p: 2, borderRadius: 2, borderInlineStart: '6px solid', borderColor: it.color || '#2e7dd7' }}>
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <TextField label="אימוג'י" value={it.emoji} sx={{ width: 90 }}
                onChange={e => setItem(idx, 'emoji', e.target.value)}
              />
              <TextField label="צבע" type="color" value={it.color || '#2e7dd7'} sx={{ width: 90 }}
                onChange={e => setItem(idx, 'color', e.target.value)}
              />
              <Stack spacing={1} sx={{ flex: 1 }}>
                <TextField label="פריט" value={it.name} fullWidth
                  onChange={e => setItem(idx, 'name', e.target.value)}
                />
                <TextField label="הערה (אופציונלי)" value={it.note} fullWidth
                  onChange={e => setItem(idx, 'note', e.target.value)}
                />
              </Stack>
              <Tooltip title="הסר פריט">
                <IconButton color="error" onClick={() => removeItem(idx)} sx={{ mt: 0.5 }}>
                  <DeleteIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          </Paper>
        ))}

        <Button startIcon={<AddIcon />} onClick={addItem} sx={{ alignSelf: 'flex-start' }}>
          הוסף פריט
        </Button>
      </Stack>
    </Box>
  );
}
