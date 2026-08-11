import { useState, useEffect, useCallback } from 'react';
import {
  Box, Stack, Typography, TextField, MenuItem, Button, Dialog, DialogTitle,
  DialogContent, DialogActions, Alert, AlertTitle, ToggleButton, ToggleButtonGroup,
  Chip, List, ListItem, ListItemText, Divider,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { formatAcademicYear, getEnrollmentYear } from '../../hooks/useAcademicYear';
import ExternalEnrollments from './ExternalEnrollments';
import TmtReconcile from './TmtReconcile';

/**
 * רישום לאמונה — one intake, one page.
 *
 * Enrolling a child in a ministry-supervised gan takes two files that decide
 * nothing on their own: קליקטאק says who registered with us, משרד התמ"ת says
 * whom the state approved. They were two screens, each with its own branch and
 * its own year, and switching between them threw away what you were looking
 * at — pick משה דיין, read its ministry list, flip to ClickTac and you were
 * somewhere else entirely.
 *
 * So the branch and the year live HERE, once, and both views read them. Both
 * stay mounted and the inactive one is hidden rather than unmounted, so the
 * filters and the scroll position you left are still there when you come back.
 * Both uploads and both undos are on this bar, because they are the same job.
 */

const SOURCES = {
  clicktac: {
    label: 'קליקטאק',
    endpoint: '/external-enrollments',
    accept: '.xlsx,.xls',
    note: 'עמודת "מוסד" בקובץ רושמת "כפר סבא" לכל השורות ואינה מבחינה בין משה דיין לקפלן. '
      + 'הסניף נקבע כאן ולא מהקובץ — בחירה שגויה תשייך את כל הקבוצה לגן הלא נכון.',
  },
  tmt: {
    label: 'תמ״ת',
    endpoint: '/tmt',
    accept: '.xls,.xlsx',
    note: 'הקובץ יורד מהפורטל של משרד התמ"ת בנפרד לכל מעון ואינו כולל את שם הסניף או את השנה. '
      + 'שניהם נקבעים כאן.',
  },
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

  const [params, setParams] = useSearchParams();
  const initialView = ['clicktac', 'tmt'].includes(params.get('view')) ? params.get('view') : 'clicktac';

  const [view, setView] = useState(initialView);
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(localStorage.getItem('selectedBranch') || '');
  // Bumped after an upload or a delete: both views refetch, neither is remounted.
  const [reloadKey, setReloadKey] = useState(0);

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

  const changeView = useCallback((next) => {
    setView(next);
    setParams(next === 'clicktac' ? {} : { view: next }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    if (!isTmtBranch && view === 'tmt') changeView('clicktac');
  }, [isTmtBranch, view, changeView]);

  const openUpload = (source) => setUpload({ open: true, source, file: null, saving: false, result: null });

  const doUpload = async () => {
    const src = SOURCES[upload.source];
    if (!upload.file) return toast.error('יש לבחור קובץ');
    if (!branchId) return toast.error('יש לבחור סניף');
    setUpload(u => ({ ...u, saving: true, result: null }));
    try {
      const form = new FormData();
      form.append('file', upload.file);
      form.append('branch_id', branchId);
      form.append('academic_year', year);
      const res = await api.post(`${src.endpoint}/import`, form,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      setUpload(u => ({ ...u, saving: false, result: res.data }));
      setReloadKey(k => k + 1);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בקליטת הקובץ');
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

  const shared = { branchId, year, embedded: true, reloadKey };

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>רישום לאמונה</Typography>

        <TextField select size="small" label="סניף" value={branchId} sx={{ minWidth: 200 }}
          onChange={e => { setBranchId(e.target.value); localStorage.setItem('selectedBranch', e.target.value); }}>
          {branches.map(b => (
            <MenuItem key={b.id || b._id} value={b.id || b._id}>{b.name}</MenuItem>
          ))}
        </TextField>

        <Chip color="primary" variant="outlined" label={`שנת ${formatAcademicYear(year)}`}
          sx={{ fontWeight: 700 }} />

        <Box sx={{ flex: 1 }} />

        <Button size="small" variant="contained" startIcon={<UploadFileIcon />}
          onClick={() => openUpload('clicktac')}>
          קליטת קובץ קליקטאק
        </Button>
        <Button size="small" variant="contained" color="secondary" startIcon={<UploadFileIcon />}
          disabled={!isTmtBranch} onClick={() => openUpload('tmt')}>
          קליטת קובץ תמ״ת
        </Button>
      </Stack>

      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={view}
          onChange={(_e, v) => v && changeView(v)}>
          <ToggleButton value="clicktac">קליטה מקליקטאק</ToggleButton>
          <ToggleButton value="tmt" disabled={!isTmtBranch}>הצלבת תמ״ת</ToggleButton>
        </ToggleButtonGroup>

        {!isTmtBranch && (
          <Chip size="small" color="default" variant="outlined"
            label={`${branch?.name || 'הסניף'} אינו תחת משרד התמ"ת — הרישום בו ישיר`} />
        )}

        <Box sx={{ flex: 1 }} />
        <Button size="small" color="error" startIcon={<DeleteForeverIcon />}
          onClick={() => setWipe({ open: true, source: 'clicktac', saving: false, result: null, blocked: null })}>
          מחיקת קובץ קליקטאק
        </Button>
        <Button size="small" color="error" disabled={!isTmtBranch} startIcon={<DeleteForeverIcon />}
          onClick={() => setWipe({ open: true, source: 'tmt', saving: false, result: null, blocked: null })}>
          מחיקת קובץ תמ״ת
        </Button>
      </Stack>

      {/* Both mounted, one shown. Unmounting the other is what used to throw
          away the branch, the filters and the scroll on every switch. */}
      <Box sx={{ display: view === 'clicktac' ? 'block' : 'none' }}>
        <ExternalEnrollments {...shared} />
      </Box>
      <Box sx={{ display: view === 'tmt' ? 'block' : 'none' }}>
        {isTmtBranch && <TmtReconcile {...shared} />}
      </Box>

      {/* ---------- upload ---------- */}
      <Dialog open={upload.open} dir="rtl" maxWidth="sm" fullWidth
        onClose={() => setUpload(u => ({ ...u, open: false }))}>
        <DialogTitle sx={{ fontWeight: 700 }}>
          קליטת קובץ {SOURCES[upload.source]?.label}
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" icon={false} sx={{ mb: 2 }}>
            {SOURCES[upload.source]?.note}
            <Box sx={{ mt: 1 }}>
              נקלט לסניף <b>{branch?.name || '—'}</b> · שנת <b>{formatAcademicYear(year)}</b>
            </Box>
          </Alert>

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
            <Alert severity="success" sx={{ mt: 2 }}>
              <AlertTitle>נקלטו {upload.result.parsed} שורות</AlertTitle>
              חדשים: {upload.result.created} · עודכנו: {upload.result.updated} ·
              {' '}ללא שינוי: {upload.result.unchanged} · ירדו מהקובץ: {upload.result.missing ?? 0}
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
