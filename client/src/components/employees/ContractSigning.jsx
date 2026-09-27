import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Button, Stack, TextField, Alert, CircularProgress, Divider,
  Checkbox, FormControlLabel, Chip,
} from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import SignatureCanvas from 'react-signature-canvas';
import axios from 'axios';
import { toast } from 'react-toastify';
import { API_ORIGIN } from '../../api/config';

/**
 * The employee's signing page — opened from a link on her phone, no login.
 *
 * She reads the actual contract (the same HTML that will be the signed PDF,
 * not a summary), then proves she is the right person with the last four
 * digits of her ת"ז before signing. A forwarded link on its own cannot sign.
 */
const publicApi = axios.create({ baseURL: `${API_ORIGIN}/api/public`, timeout: 30000 });

/** רשימת הבנקים של בנק ישראל — כמו בטופס רישום העובד/ת. */
const BANKS = [
  ['4', 'בנק יהב'], ['9', 'בנק הדואר'], ['10', 'בנק לאומי'], ['11', 'בנק דיסקונט'],
  ['12', 'בנק הפועלים'], ['14', 'בנק אוצר החייל'], ['17', 'בנק מרכנתיל דיסקונט'],
  ['18', 'וואן זירו (One Zero)'], ['20', 'בנק מזרחי טפחות'], ['31', 'הבנק הבינלאומי'],
  ['34', 'בנק ערבי ישראלי'], ['46', 'בנק מסד'], ['52', 'בנק פועלי אגודת ישראל'], ['54', 'בנק ירושלים'],
];
const RELIGIONS = ['יהודית', 'מוסלמית', 'נוצרית', 'דרוזית', 'אחרת'];

/**
 * A contract with a blank line where the signer's own details belong is a
 * contract missing them forever. The server says exactly which personal fields
 * the card didn't know; she completes them here and they land both in the
 * signed text and on her employee card.
 */
function MissingFields({ missing, fills, setFills }) {
  const set = (k) => (e) => setFills(s => ({ ...s, [k]: e.target.value }));
  const has = (k) => missing.some(m => m.key === k);
  if (!missing.length) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, mb: 2, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
      <Typography sx={{ fontWeight: 800, mb: 0.5 }}>השלמת פרטים להסכם</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        הפרטים הבאים חסרים בהסכם — הם ייכנסו לנוסח החתום ולתיק העובד/ת.
      </Typography>
      <Stack spacing={2}>
        {has('address') && (
          <TextField size="small" label="כתובת מגורים" value={fills.address || ''} onChange={set('address')} fullWidth />
        )}
        {has('phone') && (
          <TextField size="small" label="טלפון" value={fills.phone || ''} onChange={set('phone')} type="tel" fullWidth />
        )}
        {has('email') && (
          <TextField size="small" label="אימייל" value={fills.email || ''} onChange={set('email')} type="email" fullWidth />
        )}
        {has('religion') && (
          <>
            <TextField select size="small" label="דת (לתשלום ימי חג)" value={fills.religion_pick || ''}
              onChange={set('religion_pick')} fullWidth SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
              <option value="" />
              {RELIGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </TextField>
            {fills.religion_pick === 'אחרת' && (
              <TextField size="small" label="פרטו את הדת" value={fills.religion_other || ''} onChange={set('religion_other')} fullWidth />
            )}
          </>
        )}
        {has('bank') && (
          <>
            <TextField select size="small" label="בנק" value={fills.bank_number || ''}
              onChange={set('bank_number')} fullWidth SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
              <option value="" />
              {BANKS.map(([code, label]) => <option key={code} value={code}>{label} ({code})</option>)}
            </TextField>
            <Stack direction="row" spacing={1.5}>
              <TextField size="small" label="מספר סניף" value={fills.bank_branch || ''} onChange={set('bank_branch')} inputProps={{ inputMode: 'numeric' }} fullWidth />
              <TextField size="small" label="מספר חשבון" value={fills.bank_account || ''} onChange={set('bank_account')} inputProps={{ inputMode: 'numeric' }} fullWidth />
            </Stack>
            <TextField size="small" label="שם המוטב (אם החשבון אינו על שמך)" value={fills.bank_account_holder || ''} onChange={set('bank_account_holder')} fullWidth />
          </>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * What happens after she signs.
 *
 * The page used to end on "אפשר לסגור את הדף", which is the last moment we have
 * her attention and the only one where she is holding the phone she would
 * install this on. She has a login from the day her ת"ז reached her card, and
 * until somebody says so she does not know it exists — so she telephones the
 * manager for her payslip, which is the call the האזור שלי screens were built
 * to end.
 *
 * The first sign-in needs her full name and ת"ז and nothing else: an employee
 * with no password yet is let in on those two, and chooses a password after.
 * So the instruction is short enough to follow standing up, and there is no
 * temporary password to read down a telephone or leave in a message.
 *
 * The steps differ by phone because the browsers differ, and a person following
 * Android's wording on an iPhone finds no menu item by that name. iOS is the
 * one that has to be told to use Safari at all: Chrome on an iPhone cannot add
 * to the home screen, and it fails by simply not offering the option.
 */
function InstallAndLogin({ employeeName }) {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    // iPadOS reports itself as a Mac; the touch points are what give it away.
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const [prompt, setPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Android/Chrome offers a real one-tap install. iOS never fires this, which
    // is why the written steps are not a fallback but the main path there.
    const onPrompt = (e) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const steps = isIOS
    ? ['פתחי את הדף הזה בספארי', 'לחצי על כפתור השיתוף למטה', 'בחרי "הוספה למסך הבית"']
    : ['לחצי על שלוש הנקודות בפינת הדפדפן', 'בחרי "התקנת אפליקציה" או "הוספה למסך הבית"'];

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 2 }}>
      <Typography sx={{ fontWeight: 800, mb: 1 }}>מה עכשיו — האזור האישי שלך</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        במערכת יש לך אזור אישי: צפי השכר החודשי, התלושים שלך להורדה, ההחתמות שלך
        ובקשת תיקון ליום שגוי, והמסמכים שלך — כולל ההסכם שזה עתה חתמת עליו.
      </Typography>

      <Divider sx={{ my: 1.5 }} />

      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>הכניסה הראשונה</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        בכניסה הראשונה מזינים שם מלא{employeeName ? ` (${employeeName})` : ''} ותעודת זהות —
        זה הכל. אחר כך תתבקשי לבחור סיסמה משלך.
      </Typography>
      <Button variant="contained" href="/login" sx={{ mb: 2 }}>כניסה למערכת</Button>

      <Divider sx={{ my: 1.5 }} />

      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>שמירה על מסך הבית</Typography>
      {installed ? (
        <Alert severity="success">האפליקציה הותקנה. אפשר לפתוח אותה מהאייקון במסך הבית.</Alert>
      ) : prompt ? (
        <Stack spacing={1} alignItems="flex-start">
          <Typography variant="body2" color="text.secondary">
            כך תיכנסי בלחיצה אחת, בלי לחפש כתובת.
          </Typography>
          <Button variant="outlined" onClick={() => { prompt.prompt(); setPrompt(null); }}>
            התקנת האפליקציה
          </Button>
        </Stack>
      ) : (
        <Stack component="ol" sx={{ m: 0, pr: 2.5 }} spacing={0.25}>
          {steps.map(s => (
            <Typography key={s} component="li" variant="body2" color="text.secondary">{s}</Typography>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

export default function ContractSigning() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [idLast4, setIdLast4] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  // נספח ג' is 113 scanned pages that cannot live inside the contract page.
  // She must actually open every part before the sign button unlocks — an
  // unopened annex is exactly the thing a contract shouldn't claim she read.
  const [openedAnnexes, setOpenedAnnexes] = useState({});
  const [annexAck, setAnnexAck] = useState(false);
  const [fills, setFills] = useState({});
  const sigRef = useRef(null);

  useEffect(() => {
    publicApi.get(`/contract/${token}`)
      .then(res => {
        setData(res.data);
        setName(res.data.employee_name || '');
        if (res.data.already_signed) setDone(true);
      })
      .catch(e => setErr(e.response?.data?.error || 'שגיאה בטעינת ההסכם'))
      .finally(() => setLoading(false));
  }, [token]);

  const annexes = data?.annexes || [];
  const allOpened = annexes.every(a => openedAnnexes[a.id]);

  const missing = data?.missing_fields || [];

  const submit = async () => {
    if (annexes.length > 0 && !(allOpened && annexAck)) {
      return toast.error('יש לפתוח את נספח ג׳ ולאשר שקראתם אותו');
    }
    if (!sigRef.current || sigRef.current.isEmpty()) return toast.error('נא לחתום במסגרת');
    if (String(idLast4).trim().length !== 4) return toast.error('נא להזין 4 ספרות אחרונות של ת״ז');
    // What the contract is missing must be filled before the ink goes on.
    for (const m of missing) {
      if (m.key === 'bank') {
        if (!fills.bank_number || !String(fills.bank_branch || '').trim() || !String(fills.bank_account || '').trim()) {
          return toast.error('נא להשלים את פרטי חשבון הבנק');
        }
      } else if (m.key === 'religion') {
        if (!fills.religion_pick) return toast.error('נא לבחור דת');
        if (fills.religion_pick === 'אחרת' && !String(fills.religion_other || '').trim()) return toast.error('נא לפרט את הדת');
      } else if (!String(fills[m.key] || '').trim()) {
        return toast.error(`נא להשלים: ${m.label}`);
      }
    }
    setSaving(true);
    try {
      await publicApi.post(`/contract/${token}/sign`, {
        signature: sigRef.current.toDataURL('image/png'),
        signer_name: name,
        id_last4: String(idLast4).trim(),
        fills: {
          ...fills,
          religion: fills.religion_pick === 'אחרת' ? fills.religion_other : fills.religion_pick,
          bank_name: (BANKS.find(([code]) => code === fills.bank_number) || [])[1] || '',
        },
      });
      setDone(true);
    } catch (e) {
      toast.error(e.response?.data?.error || 'שגיאה בשמירת החתימה');
    } finally { setSaving(false); }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>;
  }
  if (err) {
    return <Box dir="rtl" sx={{ p: 3, maxWidth: 620, mx: 'auto' }}><Alert severity="error">{err}</Alert></Box>;
  }

  return (
    <Box dir="rtl" sx={{ p: { xs: 1.5, sm: 3 }, maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>הסכם העסקה — גן החלומות</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {data.employee_name}
      </Typography>

      {done ? (
        <>
          <Alert severity="success" sx={{ mb: 2 }}>
            ההסכם נחתם בהצלחה. מנהלת הסניף תחתום כמעסיק, והעותק המלא יישלח אלייך במייל.
          </Alert>
          <InstallAndLogin employeeName={data.employee_name} />
        </>
      ) : (
        <Alert severity="info" sx={{ mb: 2 }}>
          יש לקרוא את ההסכם במלואו, ולאחר מכן לחתום בתחתית העמוד.
        </Alert>
      )}

      {/* The real contract, scrollable — not a summary. */}
      <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden', mb: 2 }}>
        <Box
          component="iframe" title="הסכם העסקה" srcDoc={data.html}
          sx={{ width: '100%', height: { xs: 460, sm: 620 }, border: 0, bgcolor: '#fff' }}
        />
      </Paper>

      {!done && <MissingFields missing={missing} fills={fills} setFills={setFills} />}

      {!done && annexes.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, mb: 2, bgcolor: '#fffbeb', borderColor: '#fde68a' }}>
          <Typography sx={{ fontWeight: 800, mb: 0.5 }}>נספח ג׳ — ונשמרתם</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            נוהל הבטיחות מהווה חלק בלתי נפרד מההסכם. יש לפתוח ולקרוא את כל החלקים לפני החתימה.
          </Typography>
          <Stack spacing={1}>
            {annexes.map(a => (
              <Stack key={a.id} direction="row" alignItems="center" spacing={1}>
                <Button
                  size="small" variant={openedAnnexes[a.id] ? 'outlined' : 'contained'}
                  startIcon={<PictureAsPdfIcon />} href={a.url} target="_blank" rel="noreferrer"
                  onClick={() => setOpenedAnnexes(o => ({ ...o, [a.id]: true }))}
                >
                  חלק {a.part}{a.page_count ? ` · ${a.page_count} עמ׳` : ''}
                </Button>
                {openedAnnexes[a.id] && <Chip size="small" color="success" label="נפתח" />}
              </Stack>
            ))}
          </Stack>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={annexAck} disabled={!allOpened}
              onChange={(e) => setAnnexAck(e.target.checked)} />}
            label={<Typography variant="body2">קראתי את נוהל "ונשמרתם" במלואו והבנתי את תוכנו</Typography>}
          />
        </Paper>
      )}

      {!done && (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
          <Typography sx={{ fontWeight: 800, mb: 1.5 }}>חתימה</Typography>
          <Stack spacing={2}>
            <TextField
              size="small" label="שם מלא" value={name} onChange={(e) => setName(e.target.value)} fullWidth
            />
            <TextField
              size="small" label="4 ספרות אחרונות של ת״ז" value={idLast4}
              onChange={(e) => setIdLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputProps={{ inputMode: 'numeric', maxLength: 4 }}
              helperText="לאימות זהות — הספרות חייבות להתאים לת״ז שבמערכת"
              sx={{ maxWidth: 260 }}
            />
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">חתמו כאן:</Typography>
              <Box sx={{ border: '2px dashed #cbd5e1', borderRadius: 2, mt: 0.5, bgcolor: '#fff', touchAction: 'none' }}>
                <SignatureCanvas
                  ref={sigRef} penColor="#111"
                  canvasProps={{ style: { width: '100%', height: 190, display: 'block' } }}
                />
              </Box>
              <Button size="small" sx={{ mt: 0.5 }} onClick={() => sigRef.current?.clear()}>נקה חתימה</Button>
            </Box>
            <Button variant="contained" size="large"
              disabled={saving || (annexes.length > 0 && !(allOpened && annexAck))} onClick={submit}>
              {saving ? 'שומר…' : 'אני מאשר/ת וחותם/ת על ההסכם'}
            </Button>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
