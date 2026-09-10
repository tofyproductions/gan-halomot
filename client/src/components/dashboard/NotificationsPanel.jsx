import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Paper, Box, Stack, Typography, Chip, Button, Divider, Skeleton,
  ToggleButton, ToggleButtonGroup, Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * What is waiting for you, at the top of the first screen you see.
 *
 * The notifications themselves are not new — NotificationEvent has been
 * writing a row per recipient and resending it hourly since the push channel
 * was built. What was missing was anywhere to LOOK. A push that arrives while
 * the phone is in a drawer, or in a browser that was never granted permission,
 * or is simply read and forgotten, left no trace on any screen in the system.
 *
 * Nothing here dismisses anything. A row closes when the thing it is about is
 * actually done — the punch approved, the lead handled — so the count is the
 * truth about what is outstanding rather than about what somebody has looked
 * at. A "mark as read" button would let a person empty this list without doing
 * the work, and then the list would be lying.
 *
 * The admin's second view answers a different question: not "what do I have to
 * do" but "what is stuck, and with whom". A branch manager on leave with four
 * punches waiting on her is invisible from every other screen in the system.
 */

const ROLE_LABEL = {
  system_admin: 'מנהל מערכת',
  admin_viewer: 'מנהל מערכת (צפייה)',
  branch_manager: 'מנהל/ת סניף',
  accountant: 'הנה"ח',
  class_leader: 'גננת אחראית',
  teacher: 'גננת',
  assistant: 'סייעת',
};

/** "לפני שעתיים" — how long this has been waiting, which is the point of it. */
function ago(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return 'לפני שעה';
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'אתמול';
  if (days < 30) return `לפני ${days} ימים`;
  return new Date(value).toLocaleDateString('he-IL');
}

/**
 * One notification.
 *
 * The whole row is the target, because the useful action is always the same:
 * go to the thing. A row with no url is still shown — it is still a fact — it
 * simply does not pretend to be a link.
 */
function Item({ item, onOpen }) {
  const clickable = Boolean(item.url);
  return (
    <Stack
      direction="row" alignItems="center" spacing={1.5}
      onClick={clickable ? () => onOpen(item.url) : undefined}
      sx={{
        py: 1.25, px: 1, borderRadius: 2,
        cursor: clickable ? 'pointer' : 'default',
        '&:hover': clickable ? { bgcolor: 'action.hover' } : undefined,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={700} noWrap>{item.title}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {item.body}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {ago(item.created_at)}
      </Typography>
      {clickable && <ChevronLeftIcon fontSize="small" sx={{ color: 'text.disabled', flexShrink: 0 }} />}
    </Stack>
  );
}

export default function NotificationsPanel() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = ['system_admin', 'admin_viewer'].includes(user?.role);

  const [scope, setScope] = useState('mine');
  const [mine, setMine] = useState(null);
  const [groups, setGroups] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Allowed to fail quietly: a dashboard that refuses to render because a
      // notification list is unavailable is a worse screen than one without it.
      const res = await api.get('/notifications').catch(() => null);
      setMine(res?.data?.items || []);
      if (isAdmin) {
        const all = await api.get('/notifications/by-recipient').catch(() => null);
        setGroups(all?.data?.groups || []);
      }
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  const open = (url) => navigate(url);

  if (loading) {
    return <Skeleton variant="rounded" height={92} sx={{ borderRadius: 2, mb: 3 }} />;
  }

  const myCount = mine?.length || 0;
  const allCount = (groups || []).reduce((sum, g) => sum + g.items.length, 0);
  const showing = scope === 'all' ? groups || [] : [];

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 3 }}>
      <Stack
        direction="row" alignItems="center" spacing={1.5}
        sx={{ mb: myCount || scope === 'all' ? 1 : 0 }}
      >
        {myCount > 0
          ? <NotificationsActiveIcon sx={{ color: 'warning.main' }} />
          : <CheckCircleOutlineIcon sx={{ color: 'success.main' }} />}

        <Typography variant="h6" sx={{ fontWeight: 800, flex: 1, minWidth: 0 }}>
          התראות
        </Typography>

        {myCount > 0 && scope === 'mine' && (
          <Chip size="small" label={myCount} sx={{ fontWeight: 800, bgcolor: 'warning.soft', color: 'warning.softOn' }} />
        )}

        {/* Only an admin has a second question to ask of this panel. */}
        {isAdmin && (
          <ToggleButtonGroup
            size="small" exclusive value={scope}
            onChange={(_, v) => v && setScope(v)}
          >
            <ToggleButton value="mine" sx={{ px: 1.5 }}>שלי</ToggleButton>
            <ToggleButton value="all" sx={{ px: 1.5 }}>
              כל המערכת{allCount ? ` (${allCount})` : ''}
            </ToggleButton>
          </ToggleButtonGroup>
        )}

        <Button size="small" onClick={load}>רענון</Button>
      </Stack>

      {scope === 'mine' && (
        myCount === 0 ? (
          <Typography variant="body2" color="text.secondary">
            אין התראות שממתינות לך.
          </Typography>
        ) : (
          <Box>
            {mine.map((item, i) => (
              <Box key={item.id}>
                {i > 0 && <Divider />}
                <Item item={item} onOpen={open} />
              </Box>
            ))}
          </Box>
        )
      )}

      {/* Grouped by the person the notification is addressed to — the whole
          point of the view. Whoever has the most waiting on them is first. */}
      {scope === 'all' && (
        showing.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            אין התראות פתוחות לאף אחד במערכת.
          </Typography>
        ) : (
          <Box>
            {showing.map(group => (
              <Accordion key={group.recipient_id} disableGutters elevation={0}
                sx={{ '&:before': { display: 'none' }, border: 1, borderColor: 'divider', borderRadius: 2, mb: 1 }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction="row" alignItems="center" spacing={1.5} sx={{ width: '100%' }}>
                    {/* Two lines rather than a name and a role on one. A margin
                        between them is a physical direction, and this page is
                        RTL — the gap landed on the wrong side and the two words
                        ran together. */}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={800} noWrap>
                        {group.recipient_name}
                      </Typography>
                      {group.recipient_role && (
                        <Typography variant="caption" color="text.secondary" component="div" noWrap>
                          {ROLE_LABEL[group.recipient_role] || group.recipient_role}
                        </Typography>
                      )}
                    </Box>
                    <Chip size="small" label={group.items.length}
                      sx={{ fontWeight: 800, bgcolor: 'warning.soft', color: 'warning.softOn' }} />
                  </Stack>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  {group.items.map((item, i) => (
                    <Box key={item.id}>
                      {i > 0 && <Divider />}
                      <Item item={item} onOpen={open} />
                    </Box>
                  ))}
                </AccordionDetails>
              </Accordion>
            ))}
          </Box>
        )
      )}
    </Paper>
  );
}
