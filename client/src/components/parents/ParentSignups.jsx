import { useState, useEffect, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Chip, Button, TextField,
  MenuItem, Table, TableBody, TableCell, TableHead, TableRow, Alert,
  IconButton, Tooltip, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import LoadingSpinner from '../shared/LoadingSpinner';

/**
 * מעקב הורים רשומים — who reached the portal, and who to ring about it.
 *
 * The screen exists because nothing else could answer the question. An
 * account is not the whole story: a parent can only activate when the
 * enrolment data lets them, so "has not signed up" and "cannot sign up" are
 * different answers needing different actions, and the screen keeps them
 * apart. Chasing the first is a WhatsApp message. Chasing the second is a
 * correction in the office, and no amount of reminding will do instead.
 */

const PORTAL_URL = 'gan-halomot.onrender.com/parents';

const STATE = {
  active: { label: 'נכנס', color: 'success' },
  not_signed_up: { label: 'טרם נכנס', color: 'warning' },
  blocked: { label: 'חסום', color: 'error' },
  awaiting_approval: { label: 'ממתין לאישור הגן', color: 'info' },
  closed: { label: 'חשבון סגור', color: 'default' },
};

const BLOCKED_WHY = {
  no_phone: 'אין נייד תקין במערכת',
  no_id: 'אין תעודת זהות במערכת',
};

/** 0546136599 → 054-6136599. Also how an Israeli mobile is written down. */
const prettyPhone = (p) => (/^0\d{9}$/.test(String(p || '')) ? `${p.slice(0, 3)}-${p.slice(3)}` : (p || '—'));

/**
 * The invitation, in the voice of whoever is sending it.
 *
 * The name is the signed-in employee's, not the gan's, because a message that
 * opens "היי, מדבר/ת שרה מגן החלומות" is answered and one from an institution
 * is not. "מדבר/ת" rather than a guess at gender: most of the staff are women
 * and the rest are not, and getting it wrong in the first three words is
 * worse than the slash.
 */
function inviteText(senderName) {
  return `היי, מדבר/ת ${senderName || ''} מגן החלומות 🌈
פתחנו אזור אישי להורים — רואים שם את היום של הילד/ה בגן, תמונות, הודעות ותשלומים.

נכנסים כאן:
https://${PORTAL_URL}

מזינים את תעודת הזהות של ההורה (לא של הילד/ה), לוחצים "כניסה ראשונה", ומקבלים קוד ב-SMS.

אם משהו לא עובד — תגידו לי ואסדר.`;
}

function whatsappLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  // wa.me wants the country code and no leading zero.
  const intl = digits.startsWith('0') ? `972${digits.slice(1)}` : digits;
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function ParentSignups() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState('all');
  const [classroom, setClassroom] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const load = () => {
    setLoading(true);
    const params = {};
    if (branch !== 'all') params.branch = branch;
    if (classroom) params.classroom = classroom;
    api.get('/parent-signups', { params })
      .then(res => setData(res.data))
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בטעינה'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [branch, classroom]);

  const rows = useMemo(() => {
    const all = data?.parents || [];
    const q = search.trim();
    return all.filter((p) => {
      if (filter === 'needs_chasing' && p.state !== 'not_signed_up') return false;
      if (filter === 'blocked' && p.state !== 'blocked') return false;
      if (filter === 'active' && p.state !== 'active') return false;
      if (!q) return true;
      const hay = `${p.name} ${p.id_number} ${p.phone || ''} ${p.children.map(c => c.name).join(' ')}`;
      return hay.includes(q);
    });
  }, [data, filter, search]);

  const exportCsv = () => {
    const lines = [['מצב', 'תעודת זהות', 'נייד', 'שם ההורה', 'ילדים', 'כיתה', 'סניף', 'סיבת חסימה']
      .map(csvCell).join(',')];
    for (const p of rows) {
      lines.push([
        STATE[p.state]?.label || p.state,
        // A ת.ז that begins with a zero loses it to a spreadsheet, and the
        // result is a different valid-looking ID rather than an obvious error.
        /^0/.test(p.id_number) ? `="${p.id_number}"` : p.id_number,
        prettyPhone(p.phone),
        p.name,
        p.children.map(c => c.name).join(' · '),
        p.classrooms.join(' · '),
        p.branches.join(' · '),
        p.blocked_reason ? BLOCKED_WHY[p.blocked_reason] : '',
      ].map(csvCell).join(','));
    }
    // BOM, or Excel reads the Hebrew as mojibake.
    const blob = new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `הורים רשומים - ${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading && !data) return <LoadingSpinner />;

  const s = data?.summary || {};
  const text = inviteText(user?.full_name);

  const Stat = ({ label, value, color }) => (
    <Card sx={{ flex: '1 1 120px', minWidth: 120 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="h4" sx={{ fontWeight: 800, color }}>{value ?? 0}</Typography>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
      </CardContent>
    </Card>
  );

  return (
    <Box dir="rtl">
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>מעקב הורים רשומים</Typography>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>רענן</Button>
          <Button startIcon={<DownloadIcon />} variant="outlined" onClick={exportCsv} disabled={!rows.length}>
            ייצוא לקובץ
          </Button>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Stat label="הורים" value={s.parents} />
        <Stat label="נכנסו" value={s.active} color="success.main" />
        <Stat label="טרם נכנסו" value={s.not_signed_up} color="warning.main" />
        <Stat label="חסומים" value={s.blocked} color="error.main" />
      </Stack>

      {s.blocked > 0 && (
        <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 2, borderRadius: 2 }}>
          <strong>{s.blocked} הורים לא יכולים להיכנס גם אם יזכירו להם.</strong>{' '}
          חסר להם נייד תקין או תעודת זהות במערכת — זה תיקון במשרד, לא תזכורת.
        </Alert>
      )}

      {s.children_without_parent_id > 0 && (
        <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
          {s.children_without_parent_id} ילדים ללא תעודת זהות של הורה באף אחד מהשדות — ההורים שלהם
          אינם מופיעים ברשימה כלל.
        </Alert>
      )}

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
            <TextField
              select size="small" label="סניף" value={branch}
              onChange={e => { setBranch(e.target.value); setClassroom(''); }}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="all">כל הסניפים</MenuItem>
              {(data?.branches || []).map(b => (
                <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>
              ))}
            </TextField>
            <TextField
              select size="small" label="כיתה" value={classroom}
              onChange={e => setClassroom(e.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">כל הכיתות</MenuItem>
              {(data?.classrooms || []).map(c => (
                <MenuItem key={c} value={c}>{c}</MenuItem>
              ))}
            </TextField>
            <TextField
              size="small" label="חיפוש" value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="שם, ת.ז, נייד או שם ילד"
              sx={{ minWidth: 220 }}
            />
            <ToggleButtonGroup
              size="small" exclusive value={filter}
              onChange={(_, v) => v && setFilter(v)}
            >
              <ToggleButton value="all">הכול</ToggleButton>
              <ToggleButton value="needs_chasing">לנדנד</ToggleButton>
              <ToggleButton value="blocked">חסומים</ToggleButton>
              <ToggleButton value="active">נכנסו</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>מצב</TableCell>
              <TableCell>שם ההורה</TableCell>
              <TableCell>נייד</TableCell>
              <TableCell>תעודת זהות</TableCell>
              <TableCell>ילדים</TableCell>
              <TableCell>כיתה</TableCell>
              <TableCell align="center">וואטסאפ</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((p) => {
              const st = STATE[p.state] || STATE.not_signed_up;
              return (
                <TableRow
                  key={p.id_number}
                  sx={p.state === 'blocked' ? { bgcolor: 'error.lighter', '& td': { color: 'error.dark' } } : undefined}
                >
                  <TableCell>
                    <Chip size="small" label={st.label} color={st.color} />
                    {p.blocked_reason && (
                      <Typography variant="caption" display="block" color="error.main">
                        {BLOCKED_WHY[p.blocked_reason]}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>{p.name || '(ללא שם)'}</TableCell>
                  {/* Latin digits inside a Hebrew table reorder on screen and
                      run into the next column; isolate keeps each one whole. */}
                  <TableCell sx={{ direction: 'ltr', textAlign: 'right', unicodeBidi: 'isolate' }}>
                    {prettyPhone(p.phone)}
                  </TableCell>
                  <TableCell sx={{ direction: 'ltr', textAlign: 'right', unicodeBidi: 'isolate' }}>
                    {p.id_number}
                  </TableCell>
                  <TableCell>{p.children.map(c => c.name).join(', ')}</TableCell>
                  <TableCell>{p.classrooms.join(', ')}</TableCell>
                  <TableCell align="center">
                    {p.phone ? (
                      <Tooltip title={p.state === 'active' ? 'כבר נכנס — אפשר לשלוח בכל זאת' : 'שלח הזמנה אישית'}>
                        <IconButton
                          color="success" size="small"
                          component="a" target="_blank" rel="noopener"
                          href={whatsappLink(p.phone, text)}
                        >
                          <WhatsAppIcon />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Typography variant="caption" color="text.disabled">—</Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  אין הורים להצגה
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        ההודעה נפתחת בוואטסאפ עם השם שלך — {user?.full_name || ''} — ולא נשלחת לבד.
        המערכת יודעת מי הפעיל חשבון, לא מי התקין את האפליקציה: הורה שנכנס מהדפדפן נחשב נכנס.
      </Typography>
    </Box>
  );
}
