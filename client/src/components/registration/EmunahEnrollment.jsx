import { useState, useEffect } from 'react';
import {
  Box, Stack, Typography, TextField, MenuItem, Button, Dialog, DialogTitle,
  DialogContent, DialogActions, Alert, AlertTitle,
  Chip, List, ListItem, ListItemText, Divider, Checkbox, FormControlLabel, Menu,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import GroupsIcon from '@mui/icons-material/Groups';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import DebtorsDialog from './DebtorsDialog';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { hasTabAccess } from '../../config/tabs';
import { formatAcademicYear, getEnrollmentYear } from '../../hooks/useAcademicYear';
import TmtReconcile from './TmtReconcile';
import PageHeader from '../ui/PageHeader';
import ClassPlacement from './ClassPlacement';

/**
 * רישום חיצוני — one intake, one page.
 *
 * Enrolling a child in a ministry-supervised gan takes two files that decide
 * nothing on their own: קליקטאק says who registered with us, משרד התמ"ת says
 * whom the state approved. They were two screens, each with its own branch and
 * its own year, and switching between them threw away what you were looking
 * at — pick משה דיין, read its ministry list, flip to ClickTac and you were
 * somewhere else entirely.
 *
 * So the branch and the year live HERE, once, and one table reads them. There
 * used to be a second view listing the ClickTac file on its own; it showed the
 * same children the comparison already shows, minus the half of the answer
 * that decides anything, so it is gone. Both uploads, both undos, and the
 * placement board hang off this one bar.
 */

const SOURCES = {
  clicktac: {
    label: 'קליקטאק',
    endpoint: '/external-enrollments',
    accept: '.xlsx,.xls',
    note: 'עמודת "מוסד" (או "מעון") בקובץ רושמת את שם היישוב בלבד, ואינה מבחינה בין שני סניפים '
      + 'באותו יישוב. הסניף נקבע כאן ולא מהקובץ — בחירה שגויה תשייך את כל הקבוצה לגן הלא נכון.',
    /**
     * Both exports, through one button.
     *
     * The alternative — two buttons — asks the operator to know which file she
     * downloaded twenty minutes ago, and the price of guessing wrong is a
     * cohort filed under the wrong report. The server reads the header row and
     * decides, so all this has to do is say that either is welcome and what
     * each one brings.
     */
    both: [
      ['ייצוא הנרשמים (Registrations Export)', 'פרטי הילד/ה, שני ההורים, טלפונים, מיילים ואמצעי התשלום. '
        + 'בלעדיו אי אפשר לקלוט ילד/ה למערכת.'],
      ['ייצוא החוזים (contracts_export)', 'הכיתה שקליקטאק שיבצה אליה, הדרגה, סוג המימון ותאריכי החוזה. '
        + 'אין בו הורים כלל.'],
    ],
  },
  tmt: {
    label: 'תמ״ת',
    endpoint: '/tmt',
    accept: '.xls,.xlsx',
    note: 'הקובץ יורד מהפורטל של משרד התמ"ת בנפרד לכל מעון ואינו כולל את שם הסניף או את השנה. '
      + 'שניהם נקבעים כאן.',
  },
};

/**
 * Who may act, as opposed to who may look.
 *
 * The tab grants the screen — that is how a back-office manager gets to read
 * it. Uploading a ministry file, undoing one, or turning seventy children into
 * registrations is a different thing, and it now has a permission of its own:
 * the tab id 'clicktac_write', handed out per user or per role on the
 * permissions screen like any tab (client/src/config/tabs.js). So this asks
 * hasTabAccess rather than the role — which is the whole point, since the
 * people the office wants doing it are a מנהל מערכת לצפייה בלבד and one
 * back-office employee, neither of whom is an admin. system_admin and
 * accountant hold it by default, so nothing changes for them.
 *
 * Placing a child in a room stays where it was: it is the branch manager's own
 * call on her own gan, and it never depended on the roles above.
 */
const CAN_PLACE = ['system_admin', 'accountant', 'branch_manager'];

/** "2025-2026" for "2026-2027". */
const previousYear = (y) => {
  const m = /^(\d{4})-(\d{4})$/.exec(String(y || ''));
  return m ? `${Number(m[1]) - 1}-${Number(m[2]) - 1}` : y;
};

export default function EmunahEnrollment() {
  /**
  * One year, and it is not chosen.
  *
  * The intake is always about the year starting the coming September, so a
  * picker offering last year and next year offered two wrong answers and one
  * right one. Older years stay in the database — nothing here deletes them —
  * they are simply not what this screen is for.
  */
  const year = getEnrollmentYear();

  const { user } = useAuth();
  const canImport = hasTabAccess(user, 'clicktac_write');
  const canPlace = CAN_PLACE.includes(user?.role) || canImport;

  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(localStorage.getItem('selectedBranch') || '');
  // Bumped after an upload or a delete: both views refetch, neither is remounted.
  const [reloadKey, setReloadKey] = useState(0);

  const [placeOpen, setPlaceOpen] = useState(false);

  const [importAnchor, setImportAnchor] = useState(null);
  // עצמאי מהסניף שנבחר למעלה — זו כל הנקודה: לא לעבור סניף כדי לראות מי חייב.
  const [debtorsOpen, setDebtorsOpen] = useState(false);
  const [upload, setUpload] = useState({ open: false, source: '', file: null, saving: false, result: null });
  const [wipe, setWipe] = useState({ open: false, source: '', saving: false, result: null, blocked: null });

  useEffect(() => {
    api.get('/branches')
      .then(res => {
        const all = res.data.branches || [];
        setBranches(all);
        const ids = all.map(b => String(b.id || b._id));
        if (!branchId || !ids.includes(String(branchId))) {
          const first = all[0];
          if (first) setBranchId(first.id || first._id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const branch = branches.find(b => String(b.id || b._id) === String(branchId));
  /**
   * קפלן has no ministry list — it registers directly with us and never
   * appears in ClickTac either. Its tab is disabled rather than hidden, so the
   * reason is on screen instead of the branch simply having fewer options.
   */
  const isTmtBranch = branch ? (branch.tmt_supervised ?? !/קפלן/.test(branch.name || '')) : true;

  const openUpload = (source) => setUpload({ open: true, source, file: null, saving: false, result: null, prevYear: false });

  const doUpload = async () => {
    const src = SOURCES[upload.source];
    if (!upload.file) return toast.error('יש לבחור קובץ');
    if (!branchId) return toast.error('יש לבחור סניף');
    setUpload(u => ({ ...u, saving: true, result: null }));
    try {
      const form = new FormData();
      form.append('file', upload.file);
      form.append('branch_id', branchId);
      // Last year's file goes in under last year — the server refuses a file
      // whose own year disagrees with this, in either direction.
      form.append('academic_year', upload.prevYear ? previousYear(year) : year);
      const res = await api.post(`${src.endpoint}/import`, form,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      setUpload(u => ({ ...u, saving: false, result: res.data }));
      setReloadKey(k => k + 1);
    } catch (err) {
      toast.error(err.response?.data?.error
        || `שגיאה בקליטת הקובץ (${err.response?.status || 'אין תגובה מהשרת'})`);
      setUpload(u => ({ ...u, saving: false }));
    }
  };

  const doWipe = async (force = false) => {
    const src = SOURCES[wipe.source];
    setWipe(w => ({ ...w, saving: true }));
    try {
      const res = await api.delete(`${src.endpoint}/data`, {
        params: { branch: branchId, year, ...(force ? { force: 'true' } : {}) },
      });
      setWipe(w => ({ ...w, saving: false, result: res.data, blocked: null }));
      setReloadKey(k => k + 1);
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'HAS_IMPORTED') {
        setWipe(w => ({ ...w, saving: false, blocked: data }));
      } else {
        toast.error(data?.error || 'שגיאה במחיקה');
        setWipe(w => ({ ...w, saving: false }));
      }
    }
  };

  const shared = { branchId, year, embedded: true, reloadKey, canImport, canPlace };

  // "נקלטו" means the row landed somewhere that changes something the office
  // sees — created, updated, or left unchanged because it already matched.
  // cross_branch and skipped_duplicate rows are NOT absorbed: they are
  // reported separately below, and a headline that counts `parsed` alone
  // shows green even when every row bounced.
  const absorbed = upload.result
    ? (upload.result.created || 0) + (upload.result.updated || 0) + (upload.result.unchanged || 0)
    : 0;
  const importSeverity = absorbed === 0 ? 'warning' : 'success';
  const importHeadline = absorbed === 0
    ? 'לא נקלטו שורות'
    : `נקלטו ${absorbed} מתוך ${upload.result?.parsed ?? 0} שורות`;

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      {/* One header, one filled button.
          What was here: two rows carrying six buttons, two of them filled and
          competing, two of them red and destructive sitting a few pixels from
          the ones pressed every day, plus a branch dropdown and a year chip
          wedged into the title line. Nothing said which action was the normal
          one. The branch and the year were never actions — they are what you
          are looking at, so they read as a line of context; the two uploads are
          one thing done twice, so they are one control; and deleting a file is
          now two deliberate clicks rather than one careless one. */}
      <PageHeader
        title="רישום חיצוני"
        meta={[
          { label: branch?.name || 'ללא סניף', strong: true },
          { label: `שנת ${formatAcademicYear(year)}` },
          !isTmtBranch && { label: 'רישום ישיר — הסניף אינו תחת משרד התמ"ת' },
          !canImport && { label: 'צפייה בלבד' },
        ]}
        primary={canPlace && {
          label: 'שיבוץ לכיתות',
          icon: <GroupsIcon />,
          onClick: () => setPlaceOpen(true),
          disabled: !isTmtBranch,
          hint: isTmtBranch ? '' : 'הסניף אינו תחת משרד התמ"ת',
        }}
        actions={[
          canImport && {
            label: 'קליטת קובץ',
            icon: <UploadFileIcon />,
            onClick: (e) => setImportAnchor(e.currentTarget),
          },
        ]}
        menu={[
          {
            label: 'חייבים — כל הסניפים',
            icon: <ReceiptLongIcon fontSize="small" />,
            onClick: () => setDebtorsOpen(true),
          },
          canImport && {
            label: 'מחיקת קובץ קליקטאק',
            icon: <DeleteForeverIcon fontSize="small" />,
            danger: true,
            onClick: () => setWipe({ open: true, source: 'clicktac', saving: false, result: null, blocked: null }),
          },
          canImport && {
            label: 'מחיקת קובץ תמ״ת',
            icon: <DeleteForeverIcon fontSize="small" />,
            danger: true,
            disabled: !isTmtBranch,
            onClick: () => setWipe({ open: true, source: 'tmt', saving: false, result: null, blocked: null }),
          },
        ]}
      />

      {/* The two ClickTac exports and the ministry file, behind one control.
          The server reads the header row and decides which export it was given,
          so the only question this has to ask is which SYSTEM the file came
          from — and asking that twice, as two filled buttons, was most of why
          the old header had no obvious primary action. */}
      <Menu
        anchorEl={importAnchor}
        open={!!importAnchor}
        onClose={() => setImportAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <MenuItem onClick={() => { setImportAnchor(null); openUpload('clicktac'); }} sx={{ py: 1 }}>
          <ListItemText primary="קובץ קליקטאק"
            secondary="נרשמים או חוזים — המערכת מזהה לבד"
            primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: 600 }}
            secondaryTypographyProps={{ fontSize: '0.75rem' }} />
        </MenuItem>
        <MenuItem
          onClick={() => { setImportAnchor(null); openUpload('tmt'); }}
          disabled={!isTmtBranch}
          sx={{ py: 1 }}
        >
          <ListItemText primary="קובץ תמ״ת"
            secondary={isTmtBranch ? 'רשימת האישורים מהפורטל' : 'הסניף אינו תחת משרד התמ"ת'}
            primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: 600 }}
            secondaryTypographyProps={{ fontSize: '0.75rem' }} />
        </MenuItem>
      </Menu>

      {isTmtBranch ? <TmtReconcile {...shared} /> : (
        <Alert severity="info">
          {branch?.name || 'הסניף'} אינו תחת משרד התמ"ת. הרישום בו מתבצע ישירות מולנו
          ומנוהל במסך הרישום הרגיל.
        </Alert>
      )}

      <ClassPlacement
        open={placeOpen}
        onClose={() => setPlaceOpen(false)}
        branchId={branchId}
        branchName={branch?.name || ''}
        year={year}
        onDone={() => setReloadKey(k => k + 1)}
      />

      <DebtorsDialog
        open={debtorsOpen}
        onClose={() => setDebtorsOpen(false)}
        canEdit={canPlace}
      />

      {/* ---------- upload ---------- */}
      <Dialog open={upload.open} dir="rtl" maxWidth="sm" fullWidth
        onClose={() => setUpload(u => ({ ...u, open: false }))}>
        <DialogTitle sx={{ fontWeight: 700 }}>
          קליטת קובץ {SOURCES[upload.source]?.label}
        </DialogTitle>
        <DialogContent>
          {!!SOURCES[upload.source]?.both && (
            <Alert severity="info" icon={false} sx={{ mb: 2 }}>
              <AlertTitle>שני הקבצים של קליקטאק נקלטים כאן</AlertTitle>
              המערכת מזהה לבד לפי כותרות הקובץ איזה משניהם הועלה, וממזגת אותם לשורה אחת לכל ילד/ה.
              <List dense sx={{ py: 0 }}>
                {SOURCES[upload.source].both.map(([name, what]) => (
                  <ListItem key={name} sx={{ py: 0, px: 0, alignItems: 'flex-start' }}>
                    <ListItemText primary={name} secondary={what}
                      primaryTypographyProps={{ fontWeight: 700, variant: 'body2' }} />
                  </ListItem>
                ))}
              </List>
            </Alert>
          )}

          <Alert severity="warning" icon={false} sx={{ mb: 2 }}>
            {SOURCES[upload.source]?.note}
            <Box sx={{ mt: 1 }}>
              נקלט לסניף <b>{branch?.name || '—'}</b> · שנת{' '}
              <b>{formatAcademicYear(upload.prevYear ? previousYear(year) : year)}</b>
            </Box>
          </Alert>

          {/* ---- קובץ שנה קודמת ----
              The same two exports, downloaded for LAST year, uploaded under
              last year. The comparison then knows who was actually here — the
              fact behind the "ממשיך" tick — and who still owes from it. */}
          {upload.source === 'clicktac' && (
            <FormControlLabel sx={{ mb: 1, alignItems: 'flex-start' }}
              control={<Checkbox checked={!!upload.prevYear}
                onChange={e => setUpload(u => ({ ...u, prevYear: e.target.checked }))} />}
              label={(
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    זהו קובץ של שנה קודמת ({formatAcademicYear(previousYear(year))})
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    נקלט תחת שנה שעברה ולא נוגע ברשימת השנה. משמש להשוואת "ילד ממשיך" ולהצגת חוב משנה שעברה.
                    קובץ שהשנה שלו לא תואמת לסימון — נדחה.
                  </Typography>
                </Box>
              )} />
          )}

          <Stack direction="row" spacing={1} alignItems="center">
            <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={upload.saving}>
              {upload.file ? 'החלף קובץ' : 'בחר/י קובץ'}
              <input type="file" hidden accept={SOURCES[upload.source]?.accept}
                onChange={e => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) setUpload(u => ({ ...u, file: f }));
                }} />
            </Button>
            {upload.file && <Chip size="small" label={upload.file.name}
              onDelete={() => setUpload(u => ({ ...u, file: null }))} />}
          </Stack>

          {upload.result && (
            <Alert severity={importSeverity} sx={{ mt: 2 }}>
              <AlertTitle>
                {importHeadline}
                {upload.result.export_label ? ` — ${upload.result.export_label}` : ''}
              </AlertTitle>
              חדשים: {upload.result.created} · עודכנו: {upload.result.updated} ·
              {' '}ללא שינוי: {upload.result.unchanged} · ירדו מהקובץ: {upload.result.missing ?? 0}
              {/* A whole-organisation contracts file: the rows of the other
                  מעונות were set aside, not filed here. Said in full so the
                  office can see the file was not "for" this branch. */}
              {upload.result.other_institution > 0 && (
                <Box sx={{ mt: 1 }}>
                  <b>לא נקלטו — שייכים למעון אחר ({upload.result.other_institution}):</b>{' '}
                  {(upload.result.other_institution_names || []).slice(0, 30).join(', ')}
                  {upload.result.other_institution > 30 ? ' …' : ''}
                </Box>
              )}
              {upload.result.export_type === 'contracts' && upload.result.missing_parents > 0 && (
                <Box sx={{ mt: 1 }}>
                  <b>{upload.result.missing_parents}</b> ילדים בסניף עדיין ללא פרטי הורים —
                  יש לקלוט גם את ייצוא הנרשמים כדי שאפשר יהיה לקלוט אותם למערכת.
                </Box>
              )}
              {/* שורות שלא נכתבו. שתיהן נגמרות מחוץ למערכת — אחת בתיקון ת"ז
                  בקליקטאק, השנייה בהעלאה מחדש מול הסניף הנכון — ולכן שתיהן
                  מציגות שמות ולא רק מספר. */}
              {upload.result.skipped_duplicate > 0 && (
                <Box sx={{ mt: 1 }}>
                  <b>{upload.result.skipped_label || 'דילוג — ת"ז חסרה או כפולה'}
                    {' '}({upload.result.skipped_duplicate}):</b>{' '}
                  {(upload.result.skipped_names || []).join(', ')}
                </Box>
              )}
              {upload.result.cross_branch > 0 && (
                <Box sx={{ mt: 1 }}>
                  <b>{upload.result.cross_branch_label || 'לא נקלט — הילד/ה רשום/ה בסניף אחר'}
                    {' '}({upload.result.cross_branch}):</b>{' '}
                  {(upload.result.cross_branch_names || []).join(', ')}
                </Box>
              )}
              {!!(upload.result.details?.missing?.length || upload.result.missing_names?.length) && (
                <Box sx={{ mt: 1 }}>
                  <b>ירדו מהרשימה:</b>{' '}
                  {(upload.result.details?.missing || upload.result.missing_names).join(', ')}
                </Box>
              )}
              {!!upload.result.details?.updated?.length && (
                <Box sx={{ mt: 1 }}>
                  <b>שינויים:</b>
                  <List dense>
                    {upload.result.details.updated.slice(0, 20).map((u, i) => (
                      <ListItem key={i} sx={{ py: 0 }}>
                        <ListItemText primary={u.name} secondary={(u.changes || []).join(' · ')} />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUpload(u => ({ ...u, open: false }))}>סגירה</Button>
          <Button variant="contained" onClick={doUpload} disabled={upload.saving || !upload.file}>
            {upload.saving ? 'קולט…' : 'קליטה'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---------- undo an upload ---------- */}
      <Dialog open={wipe.open} dir="rtl" maxWidth="sm" fullWidth
        onClose={() => setWipe({ open: false, source: '', saving: false, result: null, blocked: null })}>
        <DialogTitle sx={{ fontWeight: 700 }}>
          מחיקת נתוני {SOURCES[wipe.source]?.label}
        </DialogTitle>
        <DialogContent>
          {!wipe.result && (
            <Alert severity="error">
              <AlertTitle>הפעולה מוחקת הכול, לא רק את הקובץ האחרון</AlertTitle>
              יימחקו <b>כל</b> נתוני ה{SOURCES[wipe.source]?.label} של סניף <b>{branch?.name || '—'}</b>{' '}
              לשנת <b>{formatAcademicYear(year)}</b>, יחד עם היסטוריית ההעלאות.
              <Box sx={{ mt: 1 }}>
                זו הדרך לתקן קובץ שהועלה לסניף הלא נכון: מוחקים ומעלים מחדש את הקובץ הנכון.
              </Box>
            </Alert>
          )}

          {wipe.blocked && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <AlertTitle>{wipe.blocked.error}</AlertTitle>
              {(wipe.blocked.imported || []).join(', ')}
              <Box sx={{ mt: 1 }}>
                ילדים אלו כבר הפכו לרישום, לילד ולשורת גבייה במערכת. אפשר למחוק את כל
                <b> השאר </b> ולהשאיר אותם על כנם.
              </Box>
            </Alert>
          )}

          {wipe.result && (
            <Alert severity="success">
              נמחקו {wipe.result.deleted} רשומות ו־{wipe.result.batches_deleted} רישומי העלאה.
              {wipe.result.kept_imported > 0 && (
                <Box sx={{ mt: 1 }}>
                  {wipe.result.kept_imported} רשומות שכבר נקלטו למערכת נשארו.
                </Box>
              )}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWipe({ open: false, source: '', saving: false, result: null, blocked: null })}>
            {wipe.result ? 'סגירה' : 'ביטול'}
          </Button>
          {!wipe.result && !wipe.blocked && (
            <Button variant="contained" color="error" onClick={() => doWipe(false)} disabled={wipe.saving}>
              {wipe.saving ? 'מוחק…' : 'מחיקה'}
            </Button>
          )}
          {!wipe.result && wipe.blocked && (
            <Button variant="contained" color="error" onClick={() => doWipe(true)} disabled={wipe.saving}>
              {wipe.saving ? 'מוחק…' : 'מחיקת השאר'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Divider sx={{ mt: 3 }} />
    </Box>
  );
}
