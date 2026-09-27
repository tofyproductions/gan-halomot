import { useState, useEffect } from 'react';
import {
  Stack, Box, Typography, TextField, Button, Chip, IconButton, Tooltip, CircularProgress,
} from '@mui/material';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { CHANGED_EVENT } from '../../hooks/useContactInboxCount';

/**
 * One "פניות למשרד" conversation — shared by the employee's page and the
 * office inbox (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 * The office's messages sit on one side and the employee's on the other, so
 * a thread reads like a chat whichever side opens it. Screenshots are fetched
 * with the login token (they are behind the same visibility as the text).
 */
export const STATUS = {
  open: { label: 'ממתינה למשרד', color: 'warning' },
  answered: { label: 'נענתה', color: 'success' },
  closed: { label: 'סגורה', color: 'default' },
};

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

/** Pick a screenshot; refuses what the server would refuse, in words. */
export function pickImage(file) {
  if (!file) return null;
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) {
    toast.error('אפשר לצרף רק תמונה — צילום מסך (JPG או PNG)');
    return null;
  }
  if (file.size > MAX_BYTES) { toast.error('התמונה גדולה מדי (עד 10MB)'); return null; }
  return file;
}

function Screenshot({ requestId, index }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    let objectUrl = null;
    api.get(`/contact-requests/${requestId}/attachment/${index}`, { responseType: 'blob' })
      .then(res => { if (!alive) return; objectUrl = URL.createObjectURL(res.data); setUrl(objectUrl); })
      .catch(() => {});
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [requestId, index]);
  if (!url) return <CircularProgress size={16} />;
  return (
    <Box component="a" href={url} target="_blank" rel="noreferrer" sx={{ display: 'block', mt: 0.5 }}>
      <Box component="img" src={url} alt="צילום מסך" sx={{ maxWidth: '100%', maxHeight: 220, borderRadius: 1, border: 1, borderColor: 'divider' }} />
    </Box>
  );
}

const when = (d) => new Date(d).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function ContactThread({ request, onChange }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const closed = request.status === 'closed';

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('text', text.trim());
      if (file) form.append('file', file);
      const res = await api.post(`/contact-requests/${request.id}/reply`, form);
      setText(''); setFile(null);
      toast.success(request.side === 'office' ? 'התשובה נשלחה — העובדת תקבל התראה' : 'נשלח');
      window.dispatchEvent(new Event(CHANGED_EVENT));
      onChange?.(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'השליחה נכשלה');
    } finally { setBusy(false); }
  };

  const close = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/contact-requests/${request.id}/close`);
      toast.success('הפנייה נסגרה');
      window.dispatchEvent(new Event(CHANGED_EVENT));
      onChange?.(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'הסגירה נכשלה');
    } finally { setBusy(false); }
  };

  return (
    <Stack spacing={1.25}>
      {request.messages.map(m => {
        // "Ours" = the side of whoever is looking, so each side reads its own on the right.
        const ours = request.side === 'office' ? m.from_office : !m.from_office;
        return (
          <Box key={m.i} sx={{ alignSelf: ours ? 'flex-start' : 'flex-end', maxWidth: '85%' }}>
            <Box sx={{
              p: 1.25, borderRadius: 2,
              bgcolor: ours ? 'primary.light' : 'action.hover',
              color: ours ? 'primary.contrastText' : 'text.primary',
            }}>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</Typography>
              {m.has_attachment && <Screenshot requestId={request.id} index={m.i} />}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {m.from_office ? `${m.by_name} · המשרד` : m.by_name} · {when(m.at)}
            </Typography>
          </Box>
        );
      })}

      {closed ? (
        <Typography variant="body2" color="text.secondary">הפנייה סגורה. לשאלה חדשה — פתחו פנייה חדשה.</Typography>
      ) : (
        <Stack spacing={1}>
          <TextField
            size="small" multiline minRows={2} fullWidth
            label={request.side === 'office' ? 'תשובה לעובדת' : 'תגובה'}
            value={text} onChange={e => setText(e.target.value)}
            inputProps={{ maxLength: 2000 }}
          />
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" size="small" disabled={busy || !text.trim()} onClick={send}>
              {busy ? 'שולח…' : 'שליחה'}
            </Button>
            <Tooltip title="צירוף צילום מסך">
              <IconButton size="small" component="label" disabled={busy}>
                <AttachFileIcon fontSize="small" />
                <input hidden type="file" accept={IMAGE_ACCEPT} onChange={e => { setFile(pickImage(e.target.files?.[0])); e.target.value = ''; }} />
              </IconButton>
            </Tooltip>
            {file && <Chip size="small" label={file.name} onDelete={() => setFile(null)} />}
            <Box sx={{ flex: 1 }} />
            <Button size="small" color="inherit" startIcon={<CloseIcon />} disabled={busy} onClick={close}>
              סגירת הפנייה
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
