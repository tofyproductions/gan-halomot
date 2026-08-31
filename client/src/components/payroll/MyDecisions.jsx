import { useState, useEffect, useCallback } from 'react';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack,
  Typography, Chip, Card, Divider, Badge, IconButton, Tooltip, LinearProgress,
} from '@mui/material';
import RuleFolderIcon from '@mui/icons-material/RuleFolder';
import NotificationsIcon from '@mui/icons-material/Notifications';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * What accounting decided on the requests this person sent.
 *
 * A branch manager cannot write payroll, employee cards or pay rates — each of
 * those is a request somebody else approves. Nothing told her the answer, so
 * she learned it from the payslip: too late, and the wrong place.
 *
 * Two surfaces over one list, which is the whole design:
 *   • the POPUP shows only what she has not seen, once, and closing it marks
 *     exactly those as read — so it never shows her the same decision twice;
 *   • the SCREEN shows everything from the last ninety days, read or not,
 *     because "what did they say about that one again?" is the second question
 *     everybody asks and a list that empties itself cannot answer it.
 */

const DISMISS_KEY = 'decisions_popup_dismissed';

const STATUS_STYLE = {
  approved: { color: 'success', icon: <CheckCircleIcon fontSize="small" /> },
  rejected: { color: 'error', icon: <CancelIcon fontSize="small" /> },
  partially_approved: { color: 'warning', icon: <RemoveCircleOutlineIcon fontSize="small" /> },
};

const LINE_STYLE = {
  approved: { label: 'אושר', color: '#15803d', bg: '#f0fdf4' },
  rejected: { label: 'נדחה', color: '#b91c1c', bg: '#fef2f2' },
  pending: { label: 'לא הוחלט', color: '#92400e', bg: '#fffbeb' },
};

const heDate = (d) => (d ? new Date(d).toLocaleString('he-IL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '');

/** One decided request, itemised. */
function DecisionCard({ item, highlight }) {
  const s = STATUS_STYLE[item.status] || { color: 'default' };
  return (
    <Card variant="outlined" sx={{
      p: 1.5, mb: 1.25, borderRadius: 2,
      borderColor: highlight ? '#f59e0b' : 'divider',
      borderWidth: highlight ? 2 : 1,
      bgcolor: highlight ? '#fffdf7' : 'background.paper',
    }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Chip size="small" color={s.color} icon={s.icon} label={item.status_label} />
        <Typography variant="body2" sx={{ fontWeight: 800 }}>{item.title}</Typography>
        <Chip size="small" variant="outlined" label={item.kind_label} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {heDate(item.decided_at)}{item.decided_by_name ? ` · ${item.decided_by_name}` : ''}
        </Typography>
      </Stack>

      {/* A partial approval MUST be itemised. "אושרה חלקית" on its own says
          something was refused and not which, which leaves her comparing the
          table against what she asked for, line by line. */}
      {(item.lines || []).length > 0 && (
        <Box sx={{ mt: 1 }}>
          {item.lines.map((l, i) => {
            const st = LINE_STYLE[l.decision] || LINE_STYLE.pending;
            return (
              <Stack key={i} direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap"
                sx={{ py: 0.5, px: 0.75, borderRadius: 1, bgcolor: st.bg, mb: 0.4 }}>
                <Typography variant="caption"
                  sx={{ fontWeight: 800, color: st.color, minWidth: 62, flexShrink: 0, mt: '2px' }}>
                  {st.label}
                </Typography>
                <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
                  <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap">
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{l.label}</Typography>
                    {l.who && (
                      <Typography variant="caption" color="text.secondary">{l.who}</Typography>
                    )}
                  </Stack>
                  {/*
                    Two rules for one short line of text.

                    dir="auto", never dir="ltr". These values are a number as
                    often as they are a sentence — "500" and "העלאת שכר ל-20000"
                    both land here — and forcing the Latin direction onto the
                    Hebrew one tore it into pieces and reordered them. auto lets
                    the first strong character decide, per value.

                    And words rather than an arrow. "200 ← 350" has no fixed
                    meaning on a right-to-left line: the arrow points at the
                    start of the reading order, so which number is the old one
                    depends on how the reader happens to scan it. מ / ל cannot
                    be read backwards.
                  */}
                  <Typography variant="caption" color="text.secondary" dir="auto"
                    sx={{ display: 'block', wordBreak: 'break-word' }}>
                    {l.from && l.from !== '—' ? `מ-${l.from} ל-${l.to}` : l.to}
                  </Typography>
                </Box>
              </Stack>
            );
          })}
        </Box>
      )}

      {item.note && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography variant="body2" color="text.secondary">
            <b>הערה:</b> {item.note}
          </Typography>
        </>
      )}
    </Card>
  );
}

/**
 * The full screen — a tab in שכר. Everything from the last ninety days, with
 * anything not yet read still marked, so opening the popup and opening this are
 * not the same act.
 */
export default function MyDecisions() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/my-decisions')
      .then(r => setItems(r.data.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LinearProgress />;

  if (!items.length) {
    return (
      <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
        <RuleFolderIcon sx={{ fontSize: 42, opacity: 0.35 }} />
        <Typography sx={{ mt: 1 }}>עדיין לא הוחלט על אף בקשה ששלחת.</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        ההחלטות על הבקשות ששלחת, מ-90 הימים האחרונים. חדשות מסומנות בכתום.
      </Typography>
      {items.map(it => <DecisionCard key={`${it.kind}-${it.id}`} item={it} highlight={it.unseen} />)}
    </Box>
  );
}

/**
 * The popup, mounted once in the layout.
 *
 * Opens on entry when there is something she has not seen, and closing it marks
 * exactly those as read — stamped from the newest item that was actually ON
 * SCREEN, not from the moment of the click, so a decision landing while she
 * reads is not marked read without ever having been shown.
 *
 * The bell stays afterwards: it is how she reopens the list without hunting for
 * the tab, and it carries the count so an unread decision is visible from every
 * screen rather than only from the one nobody opens.
 */
export function MyDecisionsPopup() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((autoOpen) => {
    api.get('/my-decisions')
      .then(r => {
        const list = r.data.items || [];
        setItems(list);
        const unseen = list.filter(i => i.unseen);
        if (autoOpen && unseen.length && !sessionStorage.getItem(DISMISS_KEY)) setOpen(true);
      })
      .catch(() => {});
  }, []);

  /*
   * Keyed on the user's ID, not the user OBJECT.
   *
   * The auth context hands back a new object on every one of its renders, so a
   * dependency on `user` is a dependency on nothing — the effect re-ran on each
   * pass and the endpoint was called in a loop. Caught while watching the
   * network panel: eight identical GETs for one page load, and the last of them
   * landed after the "mark as read" and overwrote it.
   *
   * Everyone who can SEND one of these requests can be told the answer; someone
   * who has sent none gets an empty list and sees nothing at all.
   */
  const userId = user?.id;
  useEffect(() => { if (userId) load(true); }, [userId, load]);

  if (!user) return null;

  const unseen = items.filter(i => i.unseen);
  // The popup shows only what is new. The screen keeps the rest.
  const shown = unseen.length ? unseen : items.slice(0, 20);

  const close = async () => {
    setOpen(false);
    sessionStorage.setItem(DISMISS_KEY, '1');
    if (!unseen.length) return;
    // The newest decision she was just shown — anything later stays unread.
    const newest = unseen.reduce((max, i) => {
      const t = new Date(i.decided_at || 0).getTime();
      return t > max ? t : max;
    }, 0);
    setBusy(true);
    try {
      await api.post('/my-decisions/seen', { up_to: new Date(newest).toISOString() });
      setItems(prev => prev.map(i => (
        new Date(i.decided_at || 0).getTime() <= newest ? { ...i, unseen: false } : i
      )));
    } catch (e) { /* the popup has closed; a failed stamp only shows it again */ }
    finally { setBusy(false); }
  };

  return (
    <>
      {items.length > 0 && (
        <Tooltip title="החלטות על הבקשות שלי">
          <IconButton
            onClick={() => setOpen(true)}
            sx={{ position: 'fixed', bottom: 16, insetInlineStart: 16, zIndex: 1200,
              bgcolor: 'background.paper', boxShadow: 3,
              '&:hover': { bgcolor: 'background.paper' } }}
          >
            <Badge badgeContent={unseen.length} color="error">
              <NotificationsIcon color={unseen.length ? 'warning' : 'disabled'} />
            </Badge>
          </IconButton>
        </Tooltip>
      )}

      <Dialog open={open} onClose={close} dir="rtl" maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <RuleFolderIcon color="warning" />
          {unseen.length ? `החלטות חדשות על הבקשות שלך (${unseen.length})` : 'ההחלטות על הבקשות שלך'}
        </DialogTitle>
        <DialogContent dividers>
          {busy && <LinearProgress sx={{ mb: 1 }} />}
          {unseen.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              אלה יוצגו כאן פעם אחת. אחרי הסגירה הן יישארו זמינות במסך
              «שכר ← ההחלטות שלי».
            </Typography>
          )}
          {shown.map(it => (
            <DecisionCard key={`${it.kind}-${it.id}`} item={it} highlight={it.unseen} />
          ))}
          {!shown.length && (
            <Typography color="text.secondary">אין החלטות חדשות.</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={close}>
            {unseen.length ? 'הבנתי, סגור' : 'סגור'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
