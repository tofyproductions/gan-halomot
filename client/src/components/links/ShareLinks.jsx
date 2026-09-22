import { useState, useEffect, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, TextField,
  MenuItem, Alert, Divider, Button,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckIcon from '@mui/icons-material/Check';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import FamilyRestroomIcon from '@mui/icons-material/FamilyRestroom';
import WorkOutlineIcon from '@mui/icons-material/WorkOutline';
import BadgeIcon from '@mui/icons-material/Badge';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * קישורים להפצה — the public addresses, in one place to copy from.
 *
 * Every one of these already existed and every one of them was a question
 * somebody asked the office: "what's the link for parents again", "where do I
 * send someone who wants to work here", "what do I send the girl who starts
 * Sunday". The answer lived in a WhatsApp message from four months ago, or in
 * somebody's head, and the branch link — the one that tells the system which
 * gan a family is asking about — was almost never used because nobody could
 * remember how to build it.
 *
 * Nothing here is secret. They are advertised addresses, and the screen says
 * so: the point is not to protect them, it is to stop them being lost.
 *
 * The parent inquiry link comes in one form PER BRANCH as well as a general
 * one, because a link that names the branch is the difference between a lead
 * arriving at a manager's screen and a lead arriving at nobody's.
 */

const isProbablyInstalledApp = () =>
  typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone === true);

function LinkRow({ url, hint }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      // navigator.clipboard is unavailable over plain http and inside some
      // WebViews. Falling back keeps the one button on this screen working
      // rather than failing in exactly the place it is most needed.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('ההעתקה נכשלה — אפשר לסמן את הכתובת ולהעתיק ידנית');
    }
  };

  return (
    <Stack
      direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap
      sx={{ px: 1.2, py: 0.9, borderRadius: 2, bgcolor: 'background.default' }}
    >
      {hint && (
        <Typography variant="caption" sx={{ fontWeight: 700, minWidth: 92 }}>
          {hint}
        </Typography>
      )}
      <Typography
        dir="ltr"
        sx={{
          flex: 1, minWidth: 220, fontFamily: 'monospace', fontSize: '.82rem',
          color: 'text.secondary', wordBreak: 'break-all', textAlign: 'left',
        }}
      >
        {url}
      </Typography>
      <Tooltip title={copied ? 'הועתק' : 'העתקת הקישור'}>
        <IconButton size="small" color={copied ? 'success' : 'primary'} onClick={copy}>
          {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="פתיחה בלשונית חדשה">
        <IconButton size="small" href={url} target="_blank" rel="noopener noreferrer">
          <OpenInNewIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="שליחה בוואטסאפ">
        <IconButton
          size="small" sx={{ color: 'success.main' }}
          href={`https://wa.me/?text=${encodeURIComponent(url)}`}
          target="_blank" rel="noopener noreferrer"
        >
          <WhatsAppIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function LinkCard({ icon, title, blurb, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Box sx={{ color: 'primary.main', display: 'flex' }}>{icon}</Box>
        <Typography sx={{ fontWeight: 800 }}>{title}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {blurb}
      </Typography>
      <Stack spacing={0.8}>{children}</Stack>
    </Paper>
  );
}

export default function ShareLinks() {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');

  /**
   * The address a PARENT would type, which is not always the one in this bar.
   *
   * Inside the installed app the origin is `capacitor://localhost` or
   * `https://localhost` — perfectly valid for the app and completely useless
   * on somebody else's phone. Sending that to a family is a link that opens
   * nothing, and it would be sent confidently.
   */
  const origin = useMemo(() => {
    const here = typeof window !== 'undefined' ? window.location.origin : '';
    const unusable = !here
      || /^capacitor:/i.test(here)
      || /^https?:\/\/localhost(:|$)/i.test(here)
      || /^https?:\/\/127\./i.test(here);
    return unusable ? 'https://gan-halomot.onrender.com' : here;
  }, []);

  const substituted = isProbablyInstalledApp() && !/^https?:\/\//i.test(
    typeof window !== 'undefined' ? window.location.origin : '',
  );

  useEffect(() => {
    api.get('/public/lead-branches')
      .then(res => setBranches(res.data.branches || []))
      .catch(() => setBranches([]));
  }, []);

  const branch = branches.find(b => b.id === branchId) || null;

  return (
    <Box>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>קישורים להפצה</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        הכתובות הציבוריות של הגן, במקום אחד. אפשר להעתיק, לפתוח או לשלוח ישירות בוואטסאפ.
      </Typography>

      {substituted && (
        <Alert severity="info" sx={{ mb: 2 }}>
          הקישורים כאן מוצגים עם הכתובת האמיתית של האתר ולא עם הכתובת הפנימית של האפליקציה —
          כדי שמי שיקבל אותם יוכל לפתוח אותם.
        </Alert>
      )}

      <Stack spacing={2}>
        <LinkCard
          icon={<FamilyRestroomIcon />}
          title="פנייה מהורה חדש"
          blurb="הורה שמתעניין ממלא שם וטלפון, והפנייה נכנסת למסך ״פניות הורים״ עם התראה למנהלת הסניף."
        >
          <LinkRow url={`${origin}/lead`} hint="כללי" />
          <Divider sx={{ my: 0.5 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center">
            <TextField
              select size="small" label="קישור לסניף מסוים" sx={{ minWidth: 240 }}
              value={branchId} onChange={e => setBranchId(e.target.value)}
              helperText="פנייה דרכו מגיעה ישירות לסניף הנבחר"
            >
              <MenuItem value="">בחרו סניף…</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
            {branch && (
              <Chip size="small" color="primary" variant="outlined" label={branch.name} />
            )}
          </Stack>
          {branch && <LinkRow url={`${origin}/lead/${branch.id}`} hint={branch.name} />}
        </LinkCard>

        <LinkCard
          icon={<WorkOutlineIcon />}
          title="דף הדרושים"
          blurb="דף הגיוס המלא עם טופס הגשת מועמדות. זה הקישור שצריך לשבת בקמפיין בפייסבוק — פנייה דרכו נכנסת ישר למסך ״גיוס״."
        >
          <LinkRow url={`${origin}/careers`} />
        </LinkCard>

        <LinkCard
          icon={<BadgeIcon />}
          title="רישום עובד/ת חדש/ה"
          blurb="למי שהתקבל/ה לעבודה: פרטים אישיים, פרטי בנק, איש קשר לחירום ומסמכים. הרישום ממתין לאישור במסך ״רישומי עובדים״ — אף אחד לא הופך לעובד/ת בלי שמישהו מאשר."
        >
          <LinkRow url={`${origin}/join`} />
        </LinkCard>

        <LinkCard
          icon={<PhoneIphoneIcon />}
          title="פורטל ההורים"
          blurb="הכניסה של ההורים לפורטל — תשלומים, מסמכים, היום בגן ותמונות."
        >
          <LinkRow url={`${origin}/parents/login`} />
        </LinkCard>
      </Stack>

      <Alert severity="warning" sx={{ mt: 2.5 }} icon={false}>
        <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>שימו לב</Typography>
        הקישורים האלה פתוחים לכל מי שמקבל אותם, וזו בדיוק מטרתם. מה שמגיע דרכם —
        פנייה, מועמדות או רישום — תמיד ממתין לאישור של מישהו במערכת ואף פעם לא נכנס לבד.
      </Alert>

      <Button
        size="small" sx={{ mt: 2 }} href={`${origin}/careers`} target="_blank" rel="noopener noreferrer"
        startIcon={<OpenInNewIcon />}
      >
        תצוגה מקדימה של דף הדרושים
      </Button>
    </Box>
  );
}
