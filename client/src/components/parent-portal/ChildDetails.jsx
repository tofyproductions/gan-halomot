import { useState, useEffect } from 'react';
import {
  Card, CardContent, Typography, Stack, Alert, CircularProgress, Chip,
  Divider, Button, Box,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import parentApi, { parentApiError, openParentFile } from '../../api/parentClient';
import EditableCard from './EditableCard';
import PhoneChangeDialog from './PhoneChangeDialog';

/**
 * One child: who the gan has them down as, and the contracts behind it.
 *
 * Both requests are made per child rather than fetched once for the family,
 * because the server checks ownership per child and the screen should ask the
 * same question the server answers.
 *
 * Empty sections say so in words. A health box that renders nothing when
 * there are no allergies looks identical to one that failed to load, and the
 * difference matters most for exactly that field.
 */

function Field({ label, value, empty = 'לא רשום' }) {
  const has = value !== null && value !== undefined && String(value).trim() !== '';
  return (
    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="baseline">
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ textAlign: 'left', color: has ? 'text.primary' : 'text.disabled' }}>
        {has ? String(value) : empty}
      </Typography>
    </Stack>
  );
}

function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('he-IL');
}

export default function ChildDetails({ childId }) {
  const [data, setData] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [phoneOpen, setPhoneOpen] = useState(false);

  /**
   * Send a correction and re-read the child.
   *
   * Re-reading rather than patching the local copy: the server decides what
   * actually changed (it ignores no-op edits), and a screen that showed a
   * value the database rejected would be lying about a record the gan acts on.
   */
  const save = async (changed) => {
    try {
      await parentApi.patch(`/children/${childId}`, changed);
      const fresh = await parentApi.get(`/children/${childId}`);
      setData(fresh.data);
    } catch (err) {
      throw new Error(parentApiError(err, 'השמירה נכשלה'));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    setContracts(null);

    (async () => {
      try {
        const [d, c] = await Promise.all([
          parentApi.get(`/children/${childId}`),
          parentApi.get(`/children/${childId}/contracts`),
        ]);
        if (cancelled) return;
        setData(d.data);
        setContracts(c.data.contracts || []);
      } catch (err) {
        if (!cancelled) setError(parentApiError(err, 'לא הצלחנו לטעון את הפרטים'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [childId]);

  const openContract = async (c) => {
    setError('');
    if (c.source === 'link') {
      window.open(c.url, '_blank', 'noopener');
      return;
    }
    setBusy(c.id);
    try {
      await openParentFile(
        `/children/${childId}/contracts/${c.id}/file`,
        c.file_name || 'חוזה.pdf'
      );
    } catch (err) {
      setError(parentApiError(err, 'לא הצלחנו לפתוח את החוזה'));
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>;
  }
  if (error && !data) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}

      <PhoneChangeDialog
        open={phoneOpen}
        currentPhone={data.contact.phone}
        onClose={() => setPhoneOpen(false)}
        onChanged={async () => {
          const fresh = await parentApi.get(`/children/${childId}`);
          setData(fresh.data);
        }}
      />

      <Card>
        <CardContent>
          <Typography variant="h6" fontWeight={700}>{data.child.name}</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1, mb: 2 }} flexWrap="wrap" useFlexGap>
            {data.child.classroom && <Chip size="small" label={data.child.classroom} />}
            {data.child.classroom_category && (
              <Chip size="small" variant="outlined" label={data.child.classroom_category} />
            )}
            {data.child.academic_year && (
              <Chip size="small" variant="outlined" label={`שנת ${data.child.academic_year}`} />
            )}
          </Stack>
          <Stack spacing={1}>
            <Field label="תאריך לידה" value={formatDate(data.child.birth_date)} />
            <Field label="תעודת זהות" value={data.child.id_number} />
            {data.registration?.start_date && (
              <Field label="תחילת שנה" value={formatDate(data.registration.start_date)} />
            )}
            {data.registration?.end_date && (
              <Field label="סיום שנה" value={formatDate(data.registration.end_date)} />
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>ההורה</Typography>
          <Stack spacing={1}>
            <Field label="שם" value={data.contact.parent_name} />
            <Field label="טלפון" value={data.contact.phone} />
            {data.second_parent && <Field label="הורה נוסף" value={data.second_parent} />}
          </Stack>
          <Button size="small" startIcon={<PhoneIphoneIcon />} sx={{ mt: 2 }}
            onClick={() => setPhoneOpen(true)}>
            שינוי מספר טלפון
          </Button>
        </CardContent>
      </Card>

      <EditableCard
        title="פרטי קשר"
        fields={[
          { name: 'address', label: 'כתובת' },
          { name: 'emergency_contact', label: 'איש קשר לחירום' },
          { name: 'emergency_phone', label: 'טלפון לחירום', numeric: true },
        ]}
        values={data.contact}
        onSave={save}
      />

      <EditableCard
        title="בריאות"
        fields={[
          { name: 'allergies', label: 'אלרגיות', multiline: true, empty: 'לא רשמו אלרגיות' },
          { name: 'medical_alerts', label: 'הערות רפואיות', multiline: true, empty: 'אין' },
        ]}
        values={data.health}
        warning={'הצוות והמטבח עובדים לפי מה שרשום כאן. מחיקת אלרגיה נכנסת לתוקף מיד.'}
        onSave={save}
      />

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>חוזה</Typography>

          {contracts && contracts.length === 0 && (
            <Alert severity="info">
              אין חוזה חתום שמור במערכת עבור השנה הזו. לקבלת עותק יש לפנות לגן.
            </Alert>
          )}

          <Stack spacing={1}>
            {(contracts || []).map((c) => (
              <Box
                key={c.id}
                sx={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 1, flexWrap: 'wrap',
                }}
              >
                <Box>
                  <Typography variant="body2">
                    {c.academic_year ? `חוזה ${c.academic_year}` : c.file_name}
                  </Typography>
                  {c.signed_at && (
                    <Typography variant="caption" color="text.secondary">
                      נחתם {formatDate(c.signed_at)}
                    </Typography>
                  )}
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DescriptionIcon />}
                  disabled={busy === c.id}
                  onClick={() => openContract(c)}
                >
                  {busy === c.id ? 'פותח…' : 'פתיחה'}
                </Button>
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
