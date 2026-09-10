import { useState, useEffect } from 'react';
import {
  Paper, Typography, Stack, TextField, Button, Alert, CircularProgress, Box,
} from '@mui/material';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * The version of the app that is live in each store, typed in by hand.
 *
 * The web app tells itself it is stale — every build stamps itself and the
 * running page compares. Nothing on a phone can do that: an App Store or Play
 * build ships its own copy of the front end, and no reload turns build 6 into
 * build 7. So the store apps ask the server "what is published?", and somebody
 * has to answer.
 *
 * It cannot be derived from a deploy. Review takes days and is Apple's and
 * Google's decision, not ours — an app uploaded on Tuesday may go live on
 * Friday or not at all. Whoever has the store console open knows; nothing here
 * does.
 *
 * Left empty, nobody is told anything. That is the correct behaviour for "we
 * do not know" and it is the state this sits in between releases: a wrong
 * claim sends every parent to a store page that has nothing new for them.
 */
export default function StoreVersionPanel() {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/admin/app-version')
      .then(res => setData(res.data))
      .catch(() => setData({ ios: { version: '', url: '' }, android: { version: '', url: '' } }));
  }, []);

  const set = (platform, field, value) => {
    setData(d => ({ ...d, [platform]: { ...d[platform], [field]: value } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put('/admin/app-version', data);
      setData(res.data);
      toast.success('נשמר');
    } catch (err) {
      toast.error(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return <Paper sx={{ p: 2, mb: 2 }}><CircularProgress size={20} /></Paper>;
  }

  const row = (platform, label) => (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} key={platform}>
      <TextField
        size="small" label={`${label} — גרסה`} sx={{ width: { sm: 180 } }}
        placeholder="2.1.0" inputProps={{ dir: 'ltr' }}
        value={data[platform].version}
        onChange={e => set(platform, 'version', e.target.value)}
      />
      <TextField
        size="small" label={`${label} — קישור לחנות`} fullWidth
        placeholder="https://…" inputProps={{ dir: 'ltr' }}
        value={data[platform].url}
        onChange={e => set(platform, 'url', e.target.value)}
      />
    </Stack>
  );

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <SystemUpdateAltIcon fontSize="small" color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 800 }}>
          גרסת האפליקציה בחנויות
        </Typography>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        למלא רק אחרי שאפל או גוגל אישרו גרסה חדשה. מי שמשתמש באפליקציה מהחנות
        ורואה גרסה ישנה יותר — יקבל בראש המסך הודעה עם כפתור לחנות. שדה ריק =
        לא מוצגת שום הודעה. אפליקציית הדפדפן לא צריכה את זה — היא מזהה לבד
        שיצאה גרסה חדשה ומציעה רענון.
      </Alert>

      <Stack spacing={2}>
        {row('ios', 'אייפון')}
        {row('android', 'אנדרואיד')}
        <Box>
          <Button variant="contained" size="small" disabled={saving} onClick={save}>
            {saving ? 'שומר…' : 'שמירה'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
