import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, TextField, Button, Chip, Collapse, CircularProgress, Alert, IconButton, Tooltip,
} from '@mui/material';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import BuildIcon from '@mui/icons-material/Build';
import PaletteIcon from '@mui/icons-material/Palette';
import PaymentsIcon from '@mui/icons-material/Payments';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ContactThread, { STATUS, IMAGE_ACCEPT, pickImage } from '../contact/ContactThread';

/**
 * "פניות למשרד" — any staff member writes to the office, and the answer comes
 * back here (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 * The topic decides who reads it — the admin grid "מי מקבל מה".
 */
const TOPICS = [
  { key: 'contact_tech', label: 'תקלה או בעיה באפליקציה', hint: 'משהו לא עובד, נתקע או לא נראה נכון', Icon: BuildIcon },
  { key: 'contact_graphics', label: 'גרפיקה ותמונות', hint: 'עלון, הזמנה, שלט, תמונות מהגן', Icon: PaletteIcon },
  { key: 'contact_payroll', label: 'שכר, שעות, תלושים ומסמכים', hint: 'שאלה על התלוש, השעות או מסמך', Icon: PaymentsIcon },
  { key: 'contact_general', label: 'שאלה כללית או אחר', hint: 'כל דבר אחר', Icon: HelpOutlineIcon },
];

function NewRequest({ onSent }) {
  const [topic, setTopic] = useState(null);
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('topic', topic);
      form.append('text', text.trim());
      if (file) form.append('file', file);
      await api.post('/contact-requests', form);
      toast.success('הפנייה נשלחה — התשובה תופיע כאן, ותקבלי התראה');
      setTopic(null); setText(''); setFile(null);
      onSent();
    } catch (err) {
      toast.error(err.response?.data?.error || 'השליחה נכשלה');
    } finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <Typography sx={{ fontWeight: 800, mb: 1.5 }}>פנייה חדשה — במה מדובר?</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
        {TOPICS.map(({ key, label, hint, Icon }) => {
          const on = topic === key;
          return (
            <Paper key={key} variant="outlined" onClick={() => setTopic(key)} role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setTopic(key); }}
              sx={{
                p: 1.5, cursor: 'pointer', borderRadius: 2, display: 'flex', gap: 1.25, alignItems: 'center',
                borderColor: on ? 'primary.main' : 'divider', borderWidth: on ? 2 : 1,
                bgcolor: on ? 'action.selected' : 'background.paper',
              }}>
              <Icon color={on ? 'primary' : 'action'} />
              <Box>
                <Typography sx={{ fontWeight: 700 }}>{label}</Typography>
                <Typography variant="caption" color="text.secondary">{hint}</Typography>
              </Box>
            </Paper>
          );
        })}
      </Box>

      <Collapse in={!!topic}>
        <Stack spacing={1} sx={{ mt: 2 }}>
          <TextField multiline minRows={3} fullWidth label="מה תרצי לשאול או לבקש?"
            value={text} onChange={e => setText(e.target.value)} inputProps={{ maxLength: 2000 }} />
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" disabled={busy || !text.trim()} onClick={send}>
              {busy ? 'שולחת…' : 'שליחה'}
            </Button>
            <Tooltip title="צירוף צילום מסך">
              <IconButton component="label" disabled={busy}>
                <AttachFileIcon />
                <input hidden type="file" accept={IMAGE_ACCEPT} onChange={e => { setFile(pickImage(e.target.files?.[0])); e.target.value = ''; }} />
              </IconButton>
            </Tooltip>
            {file ? <Chip size="small" label={file.name} onDelete={() => setFile(null)} />
              : <Typography variant="caption" color="text.secondary">בתקלה — צילום מסך עוזר מאוד</Typography>}
          </Stack>
        </Stack>
      </Collapse>
    </Paper>
  );
}

function MyRequest({ request, onChange }) {
  const [open, setOpen] = useState(request.status === 'answered');
  const last = request.messages[request.messages.length - 1];
  const st = STATUS[request.status];
  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Box onClick={() => setOpen(o => !o)} sx={{ p: 1.5, cursor: 'pointer', display: 'flex', gap: 1, alignItems: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography sx={{ fontWeight: 800 }}>{request.topic_label}</Typography>
            <Chip size="small" color={st.color} label={st.label} />
          </Stack>
          <Typography variant="body2" color="text.secondary" noWrap>
            {last?.from_office ? `${last.by_name}: ` : ''}{last?.text}
          </Typography>
        </Box>
        <ExpandMoreIcon sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ p: 1.5, pt: 0 }}><ContactThread request={request} onChange={onChange} /></Box>
      </Collapse>
    </Paper>
  );
}

export default function ContactOffice() {
  const [requests, setRequests] = useState(null);
  const load = useCallback(() => {
    api.get('/contact-requests/mine').then(res => setRequests(res.data.requests)).catch(() => setRequests([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const replace = (r) => setRequests(list => list.map(x => (x.id === r.id ? r : x)));

  return (
    <Box sx={{ maxWidth: 820, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <SupportAgentIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>פניות למשרד</Typography>
      </Stack>
      <Stack spacing={2}>
        <NewRequest onSent={load} />
        <Typography sx={{ fontWeight: 800 }}>הפניות שלי</Typography>
        {requests === null ? <CircularProgress size={22} /> : requests.length === 0 ? (
          <Alert severity="info" variant="outlined">עוד לא שלחת פניות. התשובות מהמשרד יופיעו כאן.</Alert>
        ) : requests.map(r => <MyRequest key={r.id} request={r} onChange={replace} />)}
      </Stack>
    </Box>
  );
}
