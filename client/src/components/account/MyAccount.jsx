import { useState, useEffect } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Divider, Alert, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell,
} from '@mui/material';
import api from '../../api/client';

/**
 * The gan's own commercial screen: what they pay, why, and what has been
 * charged so far.
 *
 * Every number here is computed by the same code that produces the invoice, so
 * this screen and the charge cannot drift apart — a customer who is shown one
 * figure and billed another stops trusting both.
 *
 * READ ONLY, on purpose. The price is what was agreed. Changing it is a
 * conversation, and the telephone number for that conversation is at the
 * bottom of the screen.
 */

const money = (n, currency = 'ILS') =>
  (currency === 'ILS' ? '₪' : '') + Number(n || 0).toLocaleString('he-IL');

const day = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');

const monthName = (m) =>
  m ? new Date(`${m}-01`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }) : '';

const STATUS = {
  active: { label: 'פעיל', color: 'success' },
  trial: { label: 'תקופת התנסות', color: 'info' },
  suspended: { label: 'מושהה', color: 'warning' },
  pending: { label: 'בהקמה', color: 'default' },
  closed: { label: 'סגור', color: 'error' },
};

const BILL_STATUS = { draft: 'מחושב', issued: 'נשלח', paid: 'שולם', void: 'בוטל' };

export default function MyAccount() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/account')
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'שגיאה בטעינת פרטי המנוי'));
  }, []);

  if (err) return <Box sx={{ p: 3 }}><Alert severity="info">{err}</Alert></Box>;
  if (!data) return <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>;

  const st = STATUS[data.status] || { label: data.status, color: 'default' };
  const cur = data.current;
  const plan = data.plan;
  const inTrial = plan.free_until && new Date(plan.free_until) > new Date();

  // How the price is described depends on which shape it takes. Saying "₪50
  // per child" to a network billed in bands is how a customer decides they
  // were quoted one thing and charged another.
  const priceLine = plan.tiers.length
    ? plan.tiers.map((t, i) => (t.up_to == null
      ? `מעל — ${money(t.price, plan.currency)} לילד`
      : `עד ${t.up_to} ילדים — ${money(t.price, plan.currency)} לילד`)).join(' · ')
    : `${money(plan.price_per_child, plan.currency)} לכל ילד`;

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 0.5 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>המנוי שלי</Typography>
        <Chip size="small" label={st.label} color={st.color} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {data.name} · {data.address} · לקוח מאז {day(data.since)}
      </Typography>

      {inTrial && (
        <Alert severity="info" sx={{ mb: 2 }}>
          תקופת התנסות ללא תשלום עד <b>{day(plan.free_until)}</b>. אחרי התאריך הזה יתחיל החיוב לפי התוכנית למטה.
        </Alert>
      )}
      {data.status === 'suspended' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          המנוי מושהה. <b>המידע שלכם נשמר במלואו ולא נמחק.</b> להפעלה מחדש — צרו קשר.
        </Alert>
      )}

      {/* The number they are actually about to pay, before anything else. */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, mb: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
          החיוב הקרוב{cur ? ` · ${monthName(cur.month)}` : ''}
        </Typography>
        {cur ? (
          <>
            <Typography sx={{ fontSize: 36, fontWeight: 800, lineHeight: 1.2, mt: 0.5 }}>
              {money(cur.amount, plan.currency)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {cur.children} ילדים פעילים · {cur.breakdown}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              מספר הילדים נספר ביום החיוב. ילד שנרשם או עזב אחריו ישתקף בחודש הבא.
            </Typography>
          </>
        ) : (
          <Alert severity="warning" sx={{ mt: 1 }}>{data.current_error || 'לא ניתן לחשב כרגע'}</Alert>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1.5 }}>התוכנית</Typography>
        <Stack spacing={1}>
          <Row label="מחיר" value={priceLine} />
          {plan.minimum_monthly > 0 && (
            <Row label="מינימום חודשי" value={money(plan.minimum_monthly, plan.currency)}
              note="גם אם החישוב לפי ילדים יוצא נמוך יותר" />
          )}
          <Row
            label="אמצעי תשלום"
            value={data.payment.connected
              ? (data.payment.method === 'cc' ? 'כרטיס אשראי' : 'הוראת קבע בנקאית')
              : 'טרם הוגדר'}
            note={data.payment.connected
              ? 'פרטי התשלום שמורים אצל חברת הסליקה ולא אצלנו'
              : 'החיוב לא יתבצע עד שיוגדר'}
          />
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>היסטוריית חיובים</Typography>
        {data.history.length === 0 ? (
          <Typography variant="body2" color="text.secondary">עוד לא היו חיובים.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>חודש</TableCell>
                <TableCell align="center">ילדים</TableCell>
                <TableCell align="left">סכום</TableCell>
                <TableCell>לפי מה</TableCell>
                <TableCell>סטטוס</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.history.map((h) => (
                <TableRow key={h.month}>
                  <TableCell>{monthName(h.month)}</TableCell>
                  <TableCell align="center">{h.children}</TableCell>
                  <TableCell align="left"><b>{money(h.amount, h.currency)}</b></TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>{h.breakdown}</TableCell>
                  <TableCell>{BILL_STATUS[h.status] || h.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          החשבוניות עצמן נשלחות במייל מחברת הסליקה.
        </Typography>
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="body2" color="text.secondary">
        לשינוי בתוכנית, באמצעי התשלום או בכל שאלה על החיוב:{' '}
        <a href={`mailto:${data.support.email}`}>{data.support.email}</a>
        {data.support.phone ? ` · ${data.support.phone}` : ''}
      </Typography>
    </Box>
  );
}

function Row({ label, value, note }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>{label}</Typography>
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>{value}</Typography>
        {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
      </Box>
    </Box>
  );
}
