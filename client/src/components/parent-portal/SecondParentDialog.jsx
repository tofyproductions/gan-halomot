import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField,
  Stack, Alert, Typography,
} from '@mui/material';
import parentApi, { parentApiError } from '../../api/parentClient';

/**
 * Adding the child's other parent.
 *
 * A registration carries one parent — whoever filled the form — so the gan
 * often has a phone number for the second on paper and nothing in the system.
 * This is the parent who is already here filling that in.
 *
 * The screen says both halves of what happens, before anything is typed: the
 * details reach the gan at once, and the other parent's own access waits for
 * the gan to open it. Told only the first half, a parent tells their partner
 * "you're in the app now" and the partner spends the evening failing to log
 * in; told only the second, the gan looks like it is withholding a phone
 * number it needs for an emergency.
 */
export default function SecondParentDialog({ open, childId, childName, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(''); setIdNumber(''); setPhone(''); setError('');
  }, [open]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await parentApi.post(`/children/${childId}/second-parent`, {
        name, id_number: idNumber, phone,
      });
      onAdded?.();
      onClose();
    } catch (err) {
      setError(parentApiError(err, 'ההוספה נכשלה'));
    } finally {
      setSaving(false);
    }
  };

  const ready = name.trim().length > 1 && idNumber.length >= 8 && phone.length >= 9;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>הוספת הורה נוסף</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Typography variant="body2" color="text.secondary">
            ההורה הנוסף של {childName}.
          </Typography>

          <TextField
            label="שם מלא" value={name} fullWidth autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="תעודת זהות" value={idNumber} fullWidth inputMode="numeric"
            onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, '').slice(0, 9))}
          />
          <TextField
            label="טלפון נייד" value={phone} fullWidth inputMode="numeric"
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          />

          <Alert severity="info">
            הפרטים ייכנסו מיד כדי שיהיה לגן איש קשר נוסף.
            <b> הכניסה שלו לאפליקציה תיפתח אחרי אישור הגן.</b>
          </Alert>
          <Typography variant="caption" color="text.secondary">
            אפשר להוסיף הורה נוסף פעם אחת. לשינוי או תיקון — יש לפנות לגן.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>ביטול</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !ready}>
          {saving ? 'שומר…' : 'הוספה'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
