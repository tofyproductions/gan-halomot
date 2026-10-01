import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Alert, Stack,
} from '@mui/material';
import api, { apiError } from '../../api/client';
import { BusyButton, FilePickButton } from '../shared/UploadControls';

/**
 * Upload the Max "פירוט חיובים" xlsx. Only the gan's cards (7996, 8093) are
 * kept; the result says exactly what went in and what was skipped and why.
 */
export default function MaxImportDialog({ open, onClose, onDone }) {
  const [file, setFile] = useState(null); // { name, data (base64), ... }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const close = () => {
    if (busy) return; setFile(null); setError(''); setResult(null); setBusy(false); onClose(); };

  const upload = async () => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/finance/import/max', { file_data: file.data });
      setResult(data);
      onDone?.();
    } catch (err) {
      setError(apiError(err, 'הייבוא נכשל'));
    } finally {
      setBusy(false);
    }
  };

  const skipped = Array.isArray(result?.cards_skipped) ? result.cards_skipped : [];

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth dir="rtl">
      <DialogTitle>ייבוא חיובי כרטיס מ-Max</DialogTitle>
      <DialogContent>
        {!result ? (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              באתר Max: פירוט חיובים ← ייצא לאקסל. נכנסים רק הכרטיסים של הגן (7996 של בן, 8093 של אלעד).
              קובץ PDF לא מתאים — חסר בו תאריך החיוב.
            </Typography>
            <FilePickButton
              accept=".xlsx"
              maxSizeMB={10}
              hasFile={!!file}
              label="בחירת קובץ אקסל"
              onPick={setFile}
              onError={setError}
            />
            {file && <Typography variant="body2">{file.name}</Typography>}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        ) : (
          <Stack spacing={1}>
            <Alert severity="success">
              נכנסו {result.inserted} תנועות חדשות{result.updated ? `, ${result.updated} עודכנו` : ''}.
            </Alert>
            {skipped.length > 0 && (
              <Typography variant="body2">
                דולגו כרטיסים שאינם של הגן: {skipped.map(c => `••••${c}${result.cards_seen?.[c] ? ` (${result.cards_seen[c]} שורות)` : ''}`).join(', ')}
              </Typography>
            )}
            {result.card_settlements > 0 && (
              <Typography variant="body2">
                {result.card_settlements} חיובי כרטיס בבנק זוהו וסומנו כהעברה פנימית — ההוצאות לא נספרות פעמיים.
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>{result ? 'סגירה' : 'ביטול'}</Button>
        {!result && <BusyButton variant="contained" loading={busy} disabled={!file} onClick={upload}>ייבוא</BusyButton>}
      </DialogActions>
    </Dialog>
  );
}
