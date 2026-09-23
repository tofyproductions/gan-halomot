import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography,
  Checkbox, FormControlLabel, Stack, Divider, Alert,
} from '@mui/material';
import parentApi from '../../api/parentClient';

/**
 * שתי תיבות, ורק אחת מהן חובה.
 *
 * הראשונה היא מדיניות הפרטיות — בלעדיה אין שימוש באפליקציה, וזה נורמלי.
 * השנייה היא זיהוי הפנים, והיא **לא חוסמת כלום**: מי שלא מסמן אותה נכנס
 * כרגיל, רואה את כל גלריית הכיתה, ופשוט צריך לגלול במקום לקבל סינון.
 *
 * ההפרדה הזו היא כל ההגנה. הסכמה שנכפתה כתנאי כניסה אינה נחשבת חופשית כשמדובר
 * במידע ביומטרי של קטין, וההורה גם לא בא לאפליקציה בשביל זיהוי פנים — הוא בא
 * בשביל התשלומים, הנוכחות והתמונות. לאחד את שתי התיבות היה חוסך תיבת סימון
 * אחת ומייצר את הטענה שהכי קשה להתגונן מולה.
 *
 * לכן גם אין כאן כפתור "אחר כך" על התיבה הראשונה, ואין עונש על השנייה.
 */
export default function FaceConsentDialog() {
  const [state, setState] = useState(null);
  const [policy, setPolicy] = useState(false);
  const [faces, setFaces] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    parentApi.get('/face-consent')
      .then(({ data }) => setState(data))
      .catch(() => setState({ needs_asking: false }));
  }, []);

  if (!state || !state.needs_asking) return null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await parentApi.post('/face-consent', { given: faces });
      setState({ ...state, needs_asking: false });
    } catch {
      setError('לא הצלחנו לשמור. נסו שוב.');
      setSaving(false);
    }
  };

  return (
    <Dialog open maxWidth="sm" fullWidth>
      <DialogTitle>לפני שממשיכים</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            עדכנו את מדיניות הפרטיות ותקנון השימוש. אנא קראו ואשרו.
          </Typography>

          <Stack spacing={1} sx={{ bgcolor: 'action.hover', p: 2, borderRadius: 2 }}>
            <Typography variant="subtitle2">בקצרה, מה שחשוב לדעת</Typography>
            <Typography variant="body2">
              • התמונות נשמרות בגן ונגישות רק לכם ולצוות. הן אינן פומביות ואינן
              נשלחות לחברה חיצונית.
            </Typography>
            <Typography variant="body2">
              • תמונות של ילדים לא ישמשו לפרסום או שיווק של הגן ללא טשטוש פנים.
            </Typography>
            <Typography variant="body2">
              • תמונות נשמרות שנתיים לימודים ואז נמחקות.
            </Typography>
            <Typography variant="body2">
              • ניתן לבקש הפסקת זיהוי הפנים בכל עת בפנייה למשרד הגן.
            </Typography>
          </Stack>

          <Divider />

          <FormControlLabel
            control={<Checkbox checked={policy} onChange={(e) => setPolicy(e.target.checked)} />}
            label={(
              <Typography variant="body2">
                קראתי ואני מאשר/ת את מדיניות הפרטיות ותקנון השימוש
                <Typography component="span" color="error.main"> (חובה)</Typography>
              </Typography>
            )}
          />

          <FormControlLabel
            control={<Checkbox checked={faces} onChange={(e) => setFaces(e.target.checked)} />}
            label={(
              <Typography variant="body2">
                מאשר/ת שהמערכת תזהה את הילד/ה שלי בתמונות באופן אוטומטי, כדי
                שאוכל למצוא אותו/ה מהר
                <Typography component="span" color="text.secondary">
                  {' '}
                  — אפשר לוותר. הגלריה תעבוד בלי זה, פשוט בלי הסינון.
                </Typography>
              </Typography>
            )}
          />

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" disabled={!policy || saving} onClick={save}>
          {saving ? 'שומר…' : 'המשך'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
