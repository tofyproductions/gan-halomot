import { useState, useEffect, useMemo } from 'react';
import {
  Card, CardContent, Typography, Stack, Alert, Chip, Skeleton,
  Button, Box, Tabs, Tab, Avatar, BottomNavigation, BottomNavigationAction, Paper,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import TodayIcon from '@mui/icons-material/Today';
import BadgeIcon from '@mui/icons-material/Badge';
import FolderIcon from '@mui/icons-material/Folder';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import parentApi, { parentApiError, openParentFile } from '../../api/parentClient';
import { DISPLAY } from '../../theme/parentTheme';
import EditableCard from './EditableCard';
import NurseryDay from './NurseryDay';
import PhotoGallery from './PhotoGallery';
import GiftPicker from './GiftPicker';
import PhoneChangeDialog from './PhoneChangeDialog';
import SecondParentDialog from './SecondParentDialog';

/**
 * One child, in sections.
 *
 * It was one long scroll, and the scroll had the wrong thing on top for
 * whoever was looking. An infant's parent opens this several times a day for
 * the day itself; the same parent looks at the contract once a year. On a
 * phone that meant scrolling past a year of paperwork to find out whether
 * their baby had eaten.
 *
 * The sections now live in a bar at the BOTTOM of the phone screen rather
 * than in tabs at the top. That is where the thumb already is — a parent
 * holding a baby in one arm and the phone in the other hand cannot reach the
 * top of a six-inch screen — and it is what every app they use all day does.
 * On a wide screen the same sections are tabs, because a bar pinned to the
 * bottom of a desktop browser is nobody's habit.
 *
 * Empty sections still say so in words. A health box that renders nothing when
 * there are no allergies looks identical to one that failed to load, and the
 * difference matters most for exactly that field.
 */

function Field({ label, value, empty = 'לא רשום' }) {
  const has = value !== null && value !== undefined && String(value).trim() !== '';
  return (
    <Stack
      direction="row" spacing={2} justifyContent="space-between" alignItems="baseline"
      sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={has ? 600 : 400}
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

/**
 * The child, at the top, with their own face on it.
 *
 * The photograph the gan tagged them in is used twice: once blurred and
 * darkened as the ground, once sharp and round on top of it. When there is no
 * photograph yet the ground is a plain warm wash — deliberately a finished
 * design rather than an empty frame, because most families will spend their
 * first fortnight here before a single picture is tagged.
 */
function Hero({ name, classroom, year, photo }) {
  return (
    <Card sx={{ overflow: 'hidden', position: 'relative' }}>
      <Box sx={{ position: 'relative', minHeight: 140, display: 'flex', alignItems: 'flex-end' }}>
        {photo ? (
          <>
            <Box
              component="img" src={photo} alt="" aria-hidden
              sx={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'cover', filter: 'blur(16px) saturate(1.15)',
                transform: 'scale(1.2)',
              }}
            />
            <Box sx={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg, rgba(43,33,25,0.25) 0%, rgba(43,33,25,0.66) 100%)',
            }} />
          </>
        ) : (
          <Box sx={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(140deg, #C9702A 0%, #8A3F06 100%)',
          }} />
        )}

        <Stack
          direction="row" spacing={1.75} alignItems="center"
          sx={{ position: 'relative', p: 2.25, width: '100%', minWidth: 0 }}
        >
          <Avatar
            src={photo || undefined}
            sx={{
              width: 68, height: 68, fontSize: '1.75rem',
              bgcolor: 'rgba(255,255,255,0.22)', color: '#fff',
              border: '3px solid rgba(255,255,255,0.85)',
              flexShrink: 0,
            }}
          >
            {initial(name)}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              component="h1"
              sx={{
                fontFamily: DISPLAY, fontWeight: 700, fontSize: '1.5rem', lineHeight: 1.2,
                color: '#fff', textShadow: '0 1px 8px rgba(43,33,25,0.45)',
              }}
              noWrap
            >
              {name}
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
              {classroom && (
                <Chip size="small" label={classroom}
                  sx={{ bgcolor: 'rgba(255,255,255,0.9)', color: '#2B2119', fontWeight: 700 }} />
              )}
              {year && (
                <Chip size="small" label={year}
                  sx={{ bgcolor: 'rgba(255,255,255,0.22)', color: '#fff', fontWeight: 600 }} />
              )}
            </Stack>
          </Box>
        </Stack>
      </Box>
    </Card>
  );
}

export default function ChildDetails({ childId }) {
  const [data, setData] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [heroPhoto, setHeroPhoto] = useState('');
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
    setHeroPhoto('');
    setTab('');

    (async () => {
      try {
        const [d, c, p] = await Promise.all([
          parentApi.get(`/children/${childId}`),
          parentApi.get(`/children/${childId}/contracts`),
          // Decoration, so it is allowed to fail: object storage being down
          // must not cost the parent the details of their child.
          parentApi.get(`/children/${childId}/photos`).catch(() => null),
        ]);
        if (cancelled) return;
        setData(d.data);
        setContracts(c.data.contracts || []);
        // Only a photograph of THIS child. A classroom picture has other
        // people's children in it and has no business being their portrait.
        const mine = p?.data?.mine || [];
        if (mine.length) setHeroPhoto(mine[0].thumb_url || mine[0].url || '');
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
    if (data.is_nursery) list.push({ key: 'day', label: 'היום בגן', icon: <TodayIcon /> });
    // Second, not last: photographs are the other thing a parent opens the app
    // for, and burying them behind the paperwork would be the same mistake the
    // single scroll made.
    list.push({ key: 'photos', label: 'תמונות', icon: <PhotoLibraryIcon /> });
    list.push({ key: 'details', label: 'פרטים', icon: <BadgeIcon /> });
    list.push({ key: 'docs', label: 'מסמכים', icon: <FolderIcon /> });
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
    return (
      <Stack spacing={2}>
        <Skeleton variant="rounded" height={140} sx={{ borderRadius: '20px' }} />
        <Skeleton variant="rounded" height={240} sx={{ borderRadius: '20px' }} />
      </Stack>
    );
  }
  if (error && !data) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  return (
    <>
    <Stack spacing={2} sx={{ animation: 'riseIn .35s cubic-bezier(.22,1,.36,1) both' }}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

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

      <Hero
        name={data.child.name}
        classroom={data.child.classroom}
        year={data.child.academic_year}
        photo={heroPhoto}
      />

      {/* Above the sections and therefore visible from every one of them. A
          deadline a parent has to act on cannot live inside a section they may
          never open. */}
      <GiftPicker childId={childId} childName={data.child.name} />

      {/* Wide screens only. The same choices are a thumb-height bar at the
          bottom of a phone. */}
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <Card>
          <Tabs value={active} onChange={(_, v) => setTab(v)} variant="fullWidth">
            {tabs.map(t => (
              <Tab key={t.key} value={t.key} label={t.label} icon={t.icon} iconPosition="start" />
            ))}
          </Tabs>
        </Card>
      </Box>

      {active === 'day' && <NurseryDay childId={childId} />}

      {active === 'photos' && (
        <PhotoGallery childId={childId} childName={data.child.name} />
      )}

      {active === 'details' && (
        <Stack spacing={2}>
          <Card>
            <CardContent>
              <Typography variant="h5" sx={{ mb: 1 }}>הילד</Typography>
              <Stack>
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
              <Typography variant="h5" sx={{ mb: 1 }}>ההורה</Typography>
              <Stack>
                <Field label="שם" value={data.contact.parent_name} />
                <Field label="טלפון" value={data.contact.phone} />
                {data.second_parent && <Field label="הורה נוסף" value={data.second_parent} />}
              </Stack>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
                <Button size="small" variant="outlined" startIcon={<PhoneIphoneIcon />}
                  onClick={() => setPhoneOpen(true)}>
                  שינוי מספר טלפון
                </Button>
                {/* Offered only when the records know of nobody. Adding is all a
                    parent may do — correcting somebody else's details, and with
                    them where that person's login codes are sent, goes through
                    the gan. */}
                {!data.second_parent && (
                  <Button size="small" variant="outlined" startIcon={<PersonAddAlt1Icon />}
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
            <Typography variant="h5" sx={{ mb: 1.5 }}>חוזים</Typography>

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
                    gap: 1, flexWrap: 'wrap', p: 1.5, borderRadius: '14px',
                    border: 1, borderColor: 'divider', bgcolor: 'background.default',
                  }}
                >
                  <Box>
                    <Typography variant="body2" fontWeight={700}>
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

      {/* The navigation, on a phone. Fixed, thumb-height, labels always shown —
          an icon-only bar is a guessing game the first time somebody uses it.

          Deliberately OUTSIDE the animated stack above. An element running a
          transform animation becomes the containing block for anything fixed
          inside it, which quietly turns this bar into a strip sitting at the
          bottom of the PAGE rather than the screen — it scrolled away and
          nothing looked broken enough to notice. */}
      <Paper
        elevation={0}
        sx={{
          display: { xs: 'block', md: 'none' },
          position: 'fixed', bottom: 0, insetInline: 0, zIndex: 1200,
          borderTop: 1, borderColor: 'divider',
          bgcolor: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)',
          pb: 'env(safe-area-inset-bottom)',
        }}
      >
        <BottomNavigation
          value={active}
          onChange={(_, v) => setTab(v)}
          showLabels
          sx={{ maxWidth: 760, mx: 'auto', bgcolor: 'transparent', height: 62 }}
        >
          {tabs.map(t => (
            <BottomNavigationAction key={t.key} value={t.key} label={t.label} icon={t.icon} />
          ))}
        </BottomNavigation>
      </Paper>
    </>
  );
}
