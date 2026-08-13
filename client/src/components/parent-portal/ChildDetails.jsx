import { useState, useEffect, useMemo } from 'react';
import {
  Card, CardContent, Typography, Stack, Alert, CircularProgress, Chip,
  Button, Box, Tabs, Tab, Avatar,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import TodayIcon from '@mui/icons-material/Today';
import BadgeIcon from '@mui/icons-material/Badge';
import FolderIcon from '@mui/icons-material/Folder';
import parentApi, { parentApiError, openParentFile } from '../../api/parentClient';
import EditableCard from './EditableCard';
import NurseryDay from './NurseryDay';
import PhoneChangeDialog from './PhoneChangeDialog';
import SecondParentDialog from './SecondParentDialog';

/**
 * One child, in tabs.
 *
 * It was one long scroll, and the scroll had the wrong thing on top for
 * whoever was looking. An infant's parent opens this several times a day for
 * the day itself; the same parent looks at the contract once a year. On a
 * phone that meant scrolling past a year of paperwork to find out whether
 * their baby had eaten.
 *
 * So: the day, the details, the documents — and the tab that opens first is
 * the one this parent came for. A child with no daily board has no day tab at
 * all, rather than an empty one.
 *
 * Empty sections still say so in words. A health box that renders nothing when
 * there are no allergies looks identical to one that failed to load, and the
 * difference matters most for exactly that field.
 */

function Field({ label, value, empty = 'לא רשום' }) {
  const has = value !== null && value !== undefined && String(value).trim() !== '';
  return (
    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="baseline">
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={has ? 500 : 400}
        sx={{ textAlign: 'left', color: has ? 'text.primary' : 'text.disabled' }}>
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

/** First letter of the child's name — a face for the card until there is one. */
function initial(name) {
  const s = String(name || '').trim();
  return s ? s[0] : '•';
}

export default function ChildDetails({ childId }) {
  const [data, setData] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  const [tab, setTab] = useState('');

  const refresh = async () => {
    const fresh = await parentApi.get(`/children/${childId}`);
    setData(fresh.data);
  };

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
      await refresh();
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
    setTab('');

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

  const tabs = useMemo(() => {
    if (!data) return [];
    const list = [];
    if (data.is_nursery) list.push({ key: 'day', label: 'היום בגן', icon: <TodayIcon fontSize="small" /> });
    list.push({ key: 'details', label: 'פרטים', icon: <BadgeIcon fontSize="small" /> });
    list.push({ key: 'docs', label: 'מסמכים', icon: <FolderIcon fontSize="small" /> });
    return list;
  }, [data]);

  // Falls back rather than showing nothing: a remembered tab that this child
  // does not have (switching from an infant to an older sibling) would
  // otherwise render an empty screen.
  const active = tab && tabs.some(t => t.key === tab) ? tab : (tabs[0]?.key || '');

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
        onChanged={refresh}
      />
      <SecondParentDialog
        open={secondOpen}
        childId={childId}
        childName={data.child.name}
        onClose={() => setSecondOpen(false)}
        onAdded={refresh}
      />

      {/* The child, once, above the tabs — so switching tabs never leaves you
          wondering whose screen you are on. */}
      <Card>
        <CardContent sx={{ pb: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar sx={{ bgcolor: 'primary.main', width: 48, height: 48, fontWeight: 700 }}>
              {initial(data.child.name)}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" fontWeight={700} noWrap>{data.child.name}</Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {data.child.classroom && <Chip size="small" label={data.child.classroom} />}
                {data.child.academic_year && (
                  <Chip size="small" variant="outlined" label={data.child.academic_year} />
                )}
              </Stack>
            </Box>
          </Stack>
        </CardContent>

        <Tabs
          value={active}
          onChange={(_, v) => setTab(v)}
          variant="fullWidth"
          sx={{ borderTop: 1, borderColor: 'divider', minHeight: 48 }}
        >
          {tabs.map(t => (
            <Tab key={t.key} value={t.key} label={t.label} icon={t.icon} iconPosition="start"
              sx={{ minHeight: 48, fontWeight: 600 }} />
          ))}
        </Tabs>
      </Card>

      {active === 'day' && <NurseryDay childId={childId} />}

      {active === 'details' && (
        <Stack spacing={2}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>הילד</Typography>
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
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
                <Button size="small" startIcon={<PhoneIphoneIcon />}
                  onClick={() => setPhoneOpen(true)}>
                  שינוי מספר טלפון
                </Button>
                {/* Offered only when the records know of nobody. Adding is all a
                    parent may do — correcting somebody else's details, and with
                    them where that person's login codes are sent, goes through
                    the gan. */}
                {!data.second_parent && (
                  <Button size="small" startIcon={<PersonAddAlt1Icon />}
                    onClick={() => setSecondOpen(true)}>
                    הוספת הורה נוסף
                  </Button>
                )}
              </Stack>
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
        </Stack>
      )}

      {active === 'docs' && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>חוזים</Typography>

            {contracts && contracts.length === 0 && (
              <Alert severity="info">
                אין חוזה חתום שמור במערכת. לקבלת עותק יש לפנות לגן.
              </Alert>
            )}

            <Stack spacing={1}>
              {(contracts || []).map((c) => (
                <Box
                  key={c.id}
                  sx={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 1, flexWrap: 'wrap', p: 1.25, borderRadius: 2,
                    border: 1, borderColor: 'divider',
                  }}
                >
                  <Box>
                    <Typography variant="body2" fontWeight={600}>
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
      )}
    </Stack>
  );
}
