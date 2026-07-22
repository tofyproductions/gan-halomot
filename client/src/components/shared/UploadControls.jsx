import { useState } from 'react';
import { Button, CircularProgress, LinearProgress, Box, Typography } from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';

/**
 * Upload feedback, in one place.
 *
 * Every file flow in the app has two silent stretches where the UI used to look
 * frozen: reading the file into base64 (FileReader, slow for a photographed
 * certificate) and the POST that carries it. With no indicator users assumed the
 * page had hung and refreshed mid-upload. These components make both visible.
 */

/**
 * A button that shows a spinner and swaps its label while `loading`. Use for
 * any submit that talks to the server — not just uploads.
 */
export function BusyButton({ loading, loadingText, children, disabled, startIcon, ...props }) {
  return (
    <Button
      {...props}
      disabled={disabled || loading}
      startIcon={loading ? <CircularProgress size={16} color="inherit" /> : startIcon}
    >
      {loading ? (loadingText || 'שולח…') : children}
    </Button>
  );
}

/**
 * File picker that reads the chosen file to base64 and reports progress.
 *
 * onPick({ name, data, mimetype, size }) is called once the read completes.
 * The button itself shows the read progress, so a 5MB photo no longer looks
 * like a dead click.
 */
export function FilePickButton({
  onPick,
  accept = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx',
  label = 'בחר קובץ',
  replaceLabel = 'החלף קובץ',
  hasFile = false,
  maxSizeMB = 15,
  onError,
  disabled,
  ...props
}) {
  const [reading, setReading] = useState(false);
  const [pct, setPct] = useState(0);

  const handle = (e) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after an error
    if (!f) return;
    if (maxSizeMB && f.size > maxSizeMB * 1024 * 1024) {
      const msg = `הקובץ גדול מדי (${(f.size / 1048576).toFixed(1)}MB). המקסימום הוא ${maxSizeMB}MB.`;
      onError ? onError(msg) : alert(msg);
      return;
    }
    setReading(true); setPct(0);
    const reader = new FileReader();
    reader.onprogress = (ev) => { if (ev.lengthComputable) setPct(Math.round((ev.loaded / ev.total) * 100)); };
    reader.onerror = () => { setReading(false); onError ? onError('קריאת הקובץ נכשלה') : null; };
    reader.onload = () => {
      setReading(false); setPct(100);
      onPick({ name: f.name, data: String(reader.result).split(',')[1], mimetype: f.type || mimeFromName(f.name), size: f.size });
    };
    reader.readAsDataURL(f);
  };

  return (
    <Box sx={{ display: 'inline-flex', flexDirection: 'column', gap: 0.5 }}>
      <Button
        component="label"
        variant="outlined"
        size="small"
        startIcon={reading ? <CircularProgress size={16} color="inherit" /> : <UploadFileIcon />}
        disabled={disabled || reading}
        {...props}
      >
        {reading ? `קורא קובץ… ${pct}%` : (hasFile ? replaceLabel : label)}
        <input type="file" hidden accept={accept} onChange={handle} />
      </Button>
      {reading && <LinearProgress variant={pct ? 'determinate' : 'indeterminate'} value={pct} sx={{ height: 3, borderRadius: 2 }} />}
    </Box>
  );
}

/** Full-width bar for a running upload — use under a form while saving. */
export function UploadingBar({ show, text = 'מעלה קובץ… אין צורך לרענן את הדף' }) {
  if (!show) return null;
  return (
    <Box sx={{ mt: 1 }}>
      <LinearProgress sx={{ height: 4, borderRadius: 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>{text}</Typography>
    </Box>
  );
}

export function mimeFromName(name = '') {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}
