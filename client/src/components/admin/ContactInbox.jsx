import { useState, useEffect, useCallback } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Collapse, CircularProgress, Alert, Tabs, Tab,
} from '@mui/material';
import MarkEmailUnreadIcon from '@mui/icons-material/MarkEmailUnread';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import api from '../../api/client';
import ContactThread, { STATUS } from '../contact/ContactThread';

/**
 * "פניות מעובדים" — the office side of "פניות למשרד"
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 * Each office person sees only the topics the admin grid ("מי מקבל מה") gives
 * them; the server decides, this only shows what it returns.
 */
const FILTERS = [
  { key: 'open', label: 'ממתינות לתשובה' },
  { key: 'answered', label: 'נענו' },
  { key: 'closed', label: 'סגורות' },
  { key: 'all', label: 'הכל' },
];

const ago = (d) => {
  const h = Math.floor((Date.now() - new Date(d)) / 3600000);
  if (h < 1) return 'לפני פחות משעה';
  if (h < 24) return `לפני ${h} שעות`;
  return `לפני ${Math.floor(h / 24)} ימים`;
};

function InboxCard({ request, onChange }) {
  const [open, setOpen] = useState(false);
  const last = request.messages[request.messages.length - 1];
  const st = STATUS[request.status];
  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Box onClick={() => setOpen(o => !o)} sx={{ p: 1.5, cursor: 'pointer', display: 'flex', gap: 1, alignItems: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography sx={{ fontWeight: 800 }}>{request.user_name}</Typography>
            {request.branch_name && <Typography variant="caption" color="text.secondary">{request.branch_name}</Typography>}
            <Chip size="small" variant="outlined" label={request.topic_label} />
            <Chip size="small" color={st.color} label={st.label} />
            <Typography variant="caption" color="text.secondary">{ago(request.last_message_at)}</Typography>
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

export default function ContactInbox() {
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/contact-requests/inbox', { params: { status: filter } })
      .then(res => setData(res.data)).catch(() => setData({ requests: [], topics: [] }));
  }, [filter]);
  useEffect(() => { setData(null); load(); }, [load]);
  // A reply moves the card to another filter; reload so the list stays honest.
  const changed = () => load();

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <MarkEmailUnreadIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>פניות מעובדים</Typography>
      </Stack>
      {data?.topics?.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          הנושאים שלך: {data.topics.map(t => t.label).join(' · ')}
        </Typography>
      )}
      <Tabs value={filter} onChange={(e, v) => setFilter(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2 }}>
        {FILTERS.map(f => <Tab key={f.key} value={f.key} label={f.label} />)}
      </Tabs>
      {data === null ? <CircularProgress size={22} /> : data.topics.length === 0 ? (
        <Alert severity="info" variant="outlined">לא סומנו לך נושאי פניות. אפשר לשנות במסך ההרשאות, בטבלת "מי מקבל מה".</Alert>
      ) : data.requests.length === 0 ? (
        <Alert severity="success" variant="outlined">אין פניות כאן.</Alert>
      ) : (
        <Stack spacing={1.25}>
          {data.requests.map(r => <InboxCard key={r.id} request={r} onChange={changed} />)}
        </Stack>
      )}
    </Box>
  );
}
