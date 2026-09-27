import { useState, useEffect } from 'react';
import {
  Paper, Typography, Stack, Button, Alert, CircularProgress, Box, Checkbox,
  Table, TableHead, TableRow, TableCell, TableBody, Autocomplete, TextField, Chip,
} from '@mui/material';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * "מי מקבל מה" — which office people each email topic reaches
 * (docs/superpowers/specs/2026-09-27-email-routing-and-contact-design.md).
 *
 * Rows are the office people with a real address, columns are the topics:
 * three for the system's own mails, four for the contact page. Under the grid,
 * extra addresses per topic for people with no login (עינת, for instance).
 * A topic left empty is not silent — the server sends it to the system
 * admins, and the "מגיע ל" line under each column says so plainly.
 */
const ROLE_HE = { system_admin: 'מנהל/ת מערכת', accountant: 'הנהלת חשבונות', admin_viewer: 'צופה' };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export default function EmailRoutingPanel() {
  const [data, setData] = useState(null);
  const [routing, setRouting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const take = (d) => { setData(d); setRouting(d.routing); setDirty(false); };

  useEffect(() => {
    api.get('/admin/email-routing').then(res => take(res.data)).catch(() => setData(false));
  }, []);

  const toggle = (topic, userId) => {
    setRouting(r => {
      const ids = new Set(r[topic].user_ids);
      if (ids.has(userId)) ids.delete(userId); else ids.add(userId);
      return { ...r, [topic]: { ...r[topic], user_ids: [...ids] } };
    });
    setDirty(true);
  };

  const setExtra = (topic, list) => {
    const clean = [...new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
    const bad = clean.find(e => !EMAIL_RE.test(e));
    if (bad) { toast.error(`כתובת לא תקינה: ${bad}`); return; }
    setRouting(r => ({ ...r, [topic]: { ...r[topic], extra_emails: clean } }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Only people the grid shows — somebody who left since the last save
      // would otherwise make the server refuse the whole grid.
      const listed = new Set(data.candidates.map(c => c.id));
      const body = Object.fromEntries(Object.entries(routing).map(([k, v]) => (
        [k, { user_ids: v.user_ids.filter(id => listed.has(id)), extra_emails: v.extra_emails }]
      )));
      const res = await api.put('/admin/email-routing', { routing: body });
      take(res.data);
      toast.success('נשמר');
    } catch (err) {
      toast.error(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  };

  if (data === null) return <Paper sx={{ p: 2, mb: 2 }}><CircularProgress size={20} /></Paper>;
  if (data === false) return <Paper sx={{ p: 2, mb: 2 }}><Alert severity="error">לא ניתן לטעון את הגדרות המיילים</Alert></Paper>;

  const groups = [
    { kind: 'mail', title: 'מיילים אוטומטיים מהמערכת' },
    { kind: 'contact', title: 'פניות מעובדים ("פניות למשרד")' },
  ];
  const short = (t) => t.label.replace(/^פנייה: /, '');

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <ForwardToInboxIcon fontSize="small" color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 800 }}>מי מקבל מה</Typography>
      </Stack>
      <Alert severity="info" sx={{ mb: 2 }}>
        כל מייל שהמערכת שולחת למשרד — וכל פנייה של עובדת — מגיע רק למי שמסומן בנושא שלו.
        נושא שלא מסומן בו אף אחד יגיע למנהלי המערכת, כדי ששום דבר לא ילך לאיבוד.
        מיילים למנהלות הסניפים, לרואה החשבון ולספקים לא מושפעים מכאן.
      </Alert>

      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 760 }}>
          <TableHead>
            <TableRow>
              <TableCell />
              {groups.map(g => (
                <TableCell key={g.kind} align="center" colSpan={data.topics.filter(t => t.kind === g.kind).length}
                  sx={{ fontWeight: 800, bgcolor: 'action.hover' }}>
                  {g.title}
                </TableCell>
              ))}
            </TableRow>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>איש משרד</TableCell>
              {data.topics.map(t => (
                <TableCell key={t.key} align="center" sx={{ fontWeight: 700, fontSize: 13, maxWidth: 120 }}>{short(t)}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.candidates.map(c => (
              <TableRow key={c.id} hover>
                <TableCell>
                  <Typography sx={{ fontWeight: 700 }}>{c.full_name}</Typography>
                  <Typography variant="caption" color="text.secondary">{ROLE_HE[c.role] || c.role} · {c.email}</Typography>
                </TableCell>
                {data.topics.map(t => (
                  <TableCell key={t.key} align="center" padding="checkbox">
                    <Checkbox checked={routing[t.key].user_ids.includes(c.id)} onChange={() => toggle(t.key, c.id)}
                      inputProps={{ 'aria-label': `${c.full_name} — ${t.label}` }} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            <TableRow>
              <TableCell><Typography variant="caption" color="text.secondary">מגיע כרגע ל־</Typography></TableCell>
              {data.topics.map(t => (
                <TableCell key={t.key} align="center" sx={{ fontSize: 11, color: 'text.secondary', verticalAlign: 'top' }}>
                  {(data.reaches[t.key] || []).map(e => <div key={e} dir="ltr">{e}</div>)}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </Box>
      {dirty && <Typography variant="caption" color="warning.main">"מגיע כרגע ל־" יתעדכן אחרי השמירה.</Typography>}

      <Typography sx={{ fontWeight: 800, mt: 2, mb: 1 }}>כתובות נוספות (אנשים בלי משתמש במערכת)</Typography>
      <Stack spacing={1.5}>
        {data.topics.map(t => (
          <Autocomplete
            key={t.key} multiple freeSolo options={[]} size="small"
            value={routing[t.key].extra_emails}
            onChange={(e, list) => setExtra(t.key, list)}
            renderTags={(value, getTagProps) => value.map((option, index) => (
              <Chip size="small" label={option} {...getTagProps({ index })} key={option} />
            ))}
            renderInput={(params) => (
              <TextField {...params} label={t.label} placeholder="הקלידו כתובת ולחצו Enter" inputProps={{ ...params.inputProps, dir: 'ltr' }} />
            )}
          />
        ))}
      </Stack>

      <Box sx={{ mt: 2 }}>
        <Button variant="contained" size="small" disabled={saving || !dirty} onClick={save}>
          {saving ? 'שומר…' : 'שמירה'}
        </Button>
      </Box>
    </Paper>
  );
}
