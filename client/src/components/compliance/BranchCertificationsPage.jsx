import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Button, Stack, Chip, TextField, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, AlertTitle,
  CircularProgress, IconButton, Tooltip, Table, TableHead, TableRow, TableCell,
  TableBody, FormControlLabel, Checkbox,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import DescriptionIcon from '@mui/icons-material/Description';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import NotificationsIcon from '@mui/icons-material/NotificationsNone';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import LinearProgress from '@mui/material/LinearProgress';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import FolderZipIcon from '@mui/icons-material/FolderZip';
import { toast } from 'react-toastify';
import api, { openApiFile, apiError, UPLOAD_TIMEOUT_MS } from '../../api/client';
import { FilePickButton, BusyButton } from '../shared/UploadControls';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../shared/ConfirmProvider';
import { pluralDays } from '../../utils/ilDates';
import DriveImportDialog from './DriveImportDialog';

/**
 * אישורי מעון — the papers each branch operates under, and when they run out.
 *
 * One card per branch; each certificate is a row with a colour that answers
 * the only question anybody opens this screen with: is something about to
 * expire. The mail digest is the push; this is the truth.
 */

const STATUS = {
  expired: { label: 'פג תוקף', color: 'error' },
  expiring: { label: 'נדרש חידוש', color: 'warning' },
  ok: { label: 'בתוקף', color: 'success' },
  no_expiry: { label: 'ללא תאריך', color: 'default' },
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '—');
const toInputDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

const EMPTY_FORM = {
  branch_id: '', cert_type: 'operating_license', label: '',
  issued_at: '', expires_at: '', external_url: '', notes: '', file: null,
};

export default function BranchCertificationsPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [form, setForm] = useState(null);        // {mode:'create'|'edit'|'renew', id?, ...EMPTY_FORM}
  const [saving, setSaving] = useState(false);
  const [recipients, setRecipients] = useState(null); // {emails: 'a, b'}
  const [driveOpen, setDriveOpen] = useState(false);
  const [exporting, setExporting] = useState('');
  // Which branch is open. One at a time: the page is a list of four מעונות and
  // the question is always about one of them.
  const [openBranch, setOpenBranch] = useState('');

  /**
   * One file to hand an inspector: a cover page saying what the branch holds
   * and what it does not, then the certificates themselves bound in behind it.
   *
   * Downloaded through fetch rather than a plain link because the request needs
   * the auth header, and because the response carries X-Skipped-Count — a
   * portfolio quietly missing two certificates is worse than one that says so.
   */
  const exportPortfolio = async (branch) => {
    setExporting(branch.id);
    try {
      const res = await api.get(`/branch-certifications/${branch.id}/portfolio.pdf`, {
        responseType: 'blob', timeout: 180000,
      });
      const skipped = Number(res.headers?.['x-skipped-count'] || 0);
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `תיק אישורים - ${branch.name} - ${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      if (skipped > 0) {
        toast.warn(`${skipped} אישורים לא צורפו לקובץ — בדקו שהקובץ עצמו קיים ונגיש.`);
      } else {
        toast.success('התיק הופק');
      }
    } catch (err) {
      toast.error(apiError(err, 'הפקת התיק נכשלה'));
    } finally {
      setExporting('');
    }
  };

  const isOffice = ['system_admin', 'accountant'].includes(user?.role);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/branch-certifications', {
        params: includeArchived ? { include_archived: '1' } : {},
      });
      setData(res.data);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בטעינת האישורים'));
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => { load(); }, [load]);

  const openFile = (row) => {
    if (row.has_file) {
      openApiFile(`/branch-certifications/${row.id}/file`, { filename: row.file_name });
    } else if (row.external_url) {
      window.open(row.external_url, '_blank', 'noopener');
    }
  };

  const save = async () => {
    if (!form.branch_id) { toast.error('יש לבחור סניף'); return; }
    setSaving(true);
    try {
      const body = {
        branch_id: form.branch_id,
        cert_type: form.cert_type,
        label: form.label,
        issued_at: form.issued_at || null,
        expires_at: form.expires_at || null,
        external_url: form.external_url,
        notes: form.notes,
        ...(form.file ? {
          file_data: form.file.data, file_name: form.file.name, file_mimetype: form.file.mimetype,
        } : {}),
      };
      const opts = form.file ? { timeout: UPLOAD_TIMEOUT_MS } : {};
      if (form.mode === 'edit') {
        await api.put(`/branch-certifications/${form.id}`, body, opts);
      } else if (form.mode === 'renew') {
        await api.post(`/branch-certifications/${form.id}/renew`, body, opts);
      } else {
        await api.post('/branch-certifications', body, opts);
      }
      toast.success('נשמר');
      setForm(null);
      load();
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בשמירה'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!(await confirm({
      title: 'מחיקת אישור',
      message: `למחוק את "${row.type_label}" של ${row.branch_name}? המחיקה סופית.`,
      danger: true,
    }))) return;
    try {
      await api.delete(`/branch-certifications/${row.id}`);
      toast.success('נמחק');
      load();
    } catch (err) {
      toast.error(apiError(err, 'שגיאה במחיקה'));
    }
  };

  const openRecipients = async () => {
    try {
      const res = await api.get('/branch-certifications/alert-recipients');
      setRecipients({ emails: (res.data.emails || []).join(', ') });
    } catch (err) {
      toast.error(apiError(err, 'שגיאה'));
    }
  };

  const saveRecipients = async () => {
    try {
      const emails = recipients.emails.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
      const res = await api.put('/branch-certifications/alert-recipients', { emails });
      toast.success(`נשמרו ${res.data.emails.length} כתובות`);
      setRecipients(null);
    } catch (err) {
      toast.error(apiError(err, 'שגיאה בשמירה'));
    }
  };

  if (loading && !data) return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;
  if (!data) return null;

  const {
    certifications, branches, cert_types: certTypes, summary, warn_days: warnDays,
    gaps = [],
  } = data;
  const byBranch = new Map(branches.map(b => [b.id, []]));
  for (const c of certifications) {
    if (!byBranch.has(c.branch_id)) byBranch.set(c.branch_id, []);
    byBranch.get(c.branch_id).push(c);
  }

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>אישורי מעון</Typography>
          <Typography variant="body2" color="text.secondary">
            רישיון הפעלה, חשמלאי, גילוי אש ושאר האישורים — לכל סניף, עם תאריכי תוקף.
            התראה במייל נשלחת {warnDays} ימים לפני פקיעה.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <FormControlLabel
            control={<Checkbox size="small" checked={includeArchived}
              onChange={e => setIncludeArchived(e.target.checked)} />}
            label={<Typography variant="body2">כולל ישנים</Typography>}
          />
          {isOffice && (
            <Tooltip title="נמעני ההתראות במייל">
              <IconButton onClick={openRecipients}><NotificationsIcon /></IconButton>
            </Tooltip>
          )}
          {isOffice && (
            <Tooltip title="קורא את שמות הקבצים בתיקיות הדרייב ומציע מה הם. שום דבר לא נכנס בלי אישור שלך.">
              <Button variant="outlined" startIcon={<CloudDownloadIcon />}
                onClick={() => setDriveOpen(true)}>
                ייבוא מהדרייב
              </Button>
            </Tooltip>
          )}
          <Button variant="contained" startIcon={<AddIcon />}
            onClick={() => setForm({ mode: 'create', ...EMPTY_FORM, branch_id: branches[0]?.id || '' })}>
            הוספת אישור
          </Button>
        </Stack>
      </Stack>

      {(summary.expired > 0 || summary.expiring > 0) && (
        <Alert severity={summary.expired > 0 ? 'error' : 'warning'} sx={{ mb: 2 }}>
          <AlertTitle>
            {[
              summary.expired > 0 && `${summary.expired} אישורים פגי תוקף`,
              summary.expiring > 0 && `${summary.expiring} אישורים דורשים חידוש בקרוב`,
            ].filter(Boolean).join(' · ')}
          </AlertTitle>
          אישור שפג תוקפו הוא חשיפה מול הרישוי — כדאי לטפל לפני הביקורת הבאה.
        </Alert>
      )}

      <Stack spacing={2}>
        {branches.map(b => {
          const rows = byBranch.get(b.id) || [];
          const bad = rows.filter(r => !r.is_archived && ['expired', 'expiring'].includes(r.status)).length;
          const gap = gaps.find(g => g.branch_id === b.id);
          const required = gap?.required_count || 0;
          const held = Math.max(0, required - (gap?.total_gaps || 0));
          return (
            <Accordion
              key={b.id} disableGutters variant="outlined"
              expanded={openBranch === b.id}
              onChange={(_, on) => setOpenBranch(on ? b.id : '')}
              sx={{ borderRadius: 2, '&:before': { display: 'none' }, overflow: 'hidden' }}
            >
              {/*
                Closed, a branch is one line: its name and how it stands. The
                page is four מעונות and the question is always about one of
                them — four open tables at once is a page you scroll past.
              */}
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2, py: 1 }}>
                <Stack direction="row" alignItems="center" spacing={1.5} sx={{ width: '100%', pr: 1 }}>
                  {held === required && bad === 0
                    ? <CheckCircleIcon sx={{ color: 'success.main' }} />
                    : <ErrorOutlineIcon color={gap?.missing?.length ? 'error' : 'warning'} />}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', lineHeight: 1.2 }}>
                      {b.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {held} מתוך {required} האישורים הנדרשים
                      {rows.length ? ` · ${rows.length} מסמכים בתיק` : ''}
                    </Typography>
                  </Box>
                  <Box sx={{ flex: 1 }} />
                  {bad > 0 && <Chip size="small" color="error" label={`${bad} לטיפול`} />}
                  {gap?.missing?.length > 0 && (
                    <Chip size="small" color="error" variant="outlined"
                      label={`${gap.missing.length} חסרים`} />
                  )}
                  {held === required && bad === 0 && (
                    <Chip size="small" color="success" variant="outlined" label="תקין" />
                  )}
                  <Box sx={{ width: 110, display: { xs: 'none', sm: 'block' } }}>
                    <LinearProgress
                      variant="determinate"
                      value={required ? Math.round((held / required) * 100) : 0}
                      color={held === required ? 'success' : (gap?.missing?.length ? 'error' : 'warning')}
                      sx={{ height: 7, borderRadius: 4 }}
                    />
                  </Box>
                </Stack>
              </AccordionSummary>

              <AccordionDetails sx={{ px: 2, pt: 0, pb: 2 }}>
                <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
                  <Tooltip title="קובץ PDF אחד: עמוד ריכוז של מה שיש ומה שחסר, ואחריו האישורים עצמם. ההפקה לוקחת כדקה.">
                    <span>
                      <Button size="small" variant="outlined" startIcon={<FolderZipIcon />}
                        disabled={exporting === b.id}
                        onClick={() => exportPortfolio(b)}>
                        {exporting === b.id ? 'מפיק…' : 'ייצא תיק אישורים'}
                      </Button>
                    </span>
                  </Tooltip>
                  <Button size="small" variant="contained" startIcon={<AddIcon />}
                    onClick={() => setForm({ mode: 'create', ...EMPTY_FORM, branch_id: b.id })}>
                    הוספת אישור
                  </Button>
                </Stack>

                {/*
                  What this branch does NOT hold. Said out loud, because the
                  table below can only show what exists: an אישור בודק בטיחות
                  that was never uploaded is an empty space, and an empty space
                  does not announce itself.
                */}
                {gap?.total_gaps > 0 && (
                  <Alert severity={gap.missing.length ? 'error' : 'warning'} sx={{ mb: 1.5 }}>
                    <AlertTitle sx={{ mb: 0.5 }}>
                      חסר בתיק האישורים ({gap.total_gaps} מתוך {gap.required_count} הנדרשים)
                    </AlertTitle>
                    <Stack spacing={0.5}>
                      {gap.missing.length > 0 && (
                        <Typography variant="body2">
                          <b>לא הועלו:</b>{' '}
                          {gap.missing.map(t => certTypes[t] || t).join(' · ')}
                        </Typography>
                      )}
                      {gap.expired.length > 0 && (
                        <Typography variant="body2">
                          <b>פגי תוקף:</b>{' '}
                          {gap.expired.map(t => certTypes[t] || t).join(' · ')}
                        </Typography>
                      )}
                      {gap.no_expiry.length > 0 && (
                        <Typography variant="body2">
                          <b>בלי תאריך תפוגה:</b>{' '}
                          {gap.no_expiry.map(t => certTypes[t] || t).join(' · ')}
                          {' '}— הקובץ קיים, אבל בלי תאריך המערכת לא תתריע לפני שהוא פג.
                        </Typography>
                      )}
                    </Stack>
                  </Alert>
                )}

                {rows.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    עדיין לא הוזנו אישורים לסניף הזה.
                  </Typography>
                ) : (
                  <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell align="right">אישור</TableCell>
                          <TableCell align="right">הונפק</TableCell>
                          <TableCell align="right">בתוקף עד</TableCell>
                          <TableCell align="right">מצב</TableCell>
                          <TableCell align="right">הערות</TableCell>
                          <TableCell align="left" />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {rows.map(row => (
                          <TableRow key={row.id} sx={row.is_archived ? { opacity: 0.5 } : {}}>
                            <TableCell align="right" sx={{ fontWeight: 700 }}>
                              {row.type_label}
                              {row.cert_type !== 'other' && row.label ? ` — ${row.label}` : ''}
                              {row.is_archived && ' (ישן)'}
                            </TableCell>
                            <TableCell align="right">{fmtDate(row.issued_at)}</TableCell>
                            <TableCell align="right">{fmtDate(row.expires_at)}</TableCell>
                            <TableCell align="right">
                              <Chip size="small" color={STATUS[row.status].color}
                                variant={row.status === 'ok' ? 'outlined' : 'filled'}
                                label={row.status === 'expiring' && row.days_left != null
                                  ? `בעוד ${pluralDays(row.days_left)}`
                                  : STATUS[row.status].label} />
                            </TableCell>
                            <TableCell align="right" sx={{ maxWidth: 220 }}>
                              <Typography variant="body2" noWrap title={row.notes}>{row.notes}</Typography>
                            </TableCell>
                            <TableCell align="left" sx={{ whiteSpace: 'nowrap' }}>
                              {(row.has_file || row.external_url) && (
                                <Tooltip title="פתיחת המסמך">
                                  <IconButton size="small" onClick={() => openFile(row)}>
                                    {row.has_file ? <DescriptionIcon fontSize="small" /> : <OpenInNewIcon fontSize="small" />}
                                  </IconButton>
                                </Tooltip>
                              )}
                              {!row.is_archived && (
                                <>
                                  <Tooltip title="חידוש — האישור הישן נשמר בהיסטוריה">
                                    <IconButton size="small" onClick={() => setForm({
                                      mode: 'renew', id: row.id, ...EMPTY_FORM,
                                      branch_id: row.branch_id, cert_type: row.cert_type, label: row.label,
                                    })}>
                                      <AutorenewIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip title="עריכה">
                                    <IconButton size="small" onClick={() => setForm({
                                      mode: 'edit', id: row.id,
                                      branch_id: row.branch_id, cert_type: row.cert_type, label: row.label,
                                      issued_at: toInputDate(row.issued_at), expires_at: toInputDate(row.expires_at),
                                      external_url: row.external_url, notes: row.notes, file: null,
                                    })}>
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                </>
                              )}
                              <Tooltip title="מחיקה">
                                <IconButton size="small" color="error" onClick={() => remove(row)}>
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Stack>

      {/* ---- הוספה / עריכה / חידוש ---- */}
      <Dialog open={!!form} onClose={() => setForm(null)} maxWidth="sm" fullWidth dir="rtl">
        <DialogTitle>
          {form?.mode === 'edit' ? 'עריכת אישור' : form?.mode === 'renew' ? 'חידוש אישור' : 'הוספת אישור'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {form?.mode === 'renew' && (
              <Alert severity="info">
                האישור הקודם יעבור להיסטוריה (מסומן "ישן") והחדש יחליף אותו.
              </Alert>
            )}
            <TextField select label="סניף" value={form?.branch_id || ''} fullWidth
              disabled={form?.mode !== 'create'}
              onChange={e => setForm(v => ({ ...v, branch_id: e.target.value }))}>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
            <TextField select label="סוג האישור" value={form?.cert_type || ''} fullWidth
              disabled={form?.mode === 'renew'}
              onChange={e => setForm(v => ({ ...v, cert_type: e.target.value }))}>
              {Object.entries(certTypes).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
            {(form?.cert_type === 'other' || form?.label) && (
              <TextField label={form?.cert_type === 'other' ? 'שם האישור' : 'תיאור (לא חובה)'}
                value={form?.label || ''} fullWidth
                onChange={e => setForm(v => ({ ...v, label: e.target.value }))} />
            )}
            <Stack direction="row" spacing={2}>
              <TextField type="date" label="תאריך הנפקה" InputLabelProps={{ shrink: true }} fullWidth
                value={form?.issued_at || ''} onChange={e => setForm(v => ({ ...v, issued_at: e.target.value }))} />
              <TextField type="date" label="בתוקף עד" InputLabelProps={{ shrink: true }} fullWidth
                value={form?.expires_at || ''} onChange={e => setForm(v => ({ ...v, expires_at: e.target.value }))}
                helperText="בלי תאריך — לא תישלח התראה" />
            </Stack>
            <Stack direction="row" spacing={2} alignItems="center">
              <FilePickButton
                onPick={file => setForm(v => ({ ...v, file }))}
                hasFile={!!form?.file}
                label="העלאת המסמך" replaceLabel="החלפת המסמך"
                onError={msg => toast.error(msg)}
              />
              {form?.file && <Typography variant="body2" color="text.secondary">{form.file.name}</Typography>}
            </Stack>
            <TextField label="או קישור למסמך קיים (Drive)" value={form?.external_url || ''} fullWidth
              dir="ltr" placeholder="https://drive.google.com/…"
              onChange={e => setForm(v => ({ ...v, external_url: e.target.value }))} />
            <TextField label="הערות" multiline minRows={2} value={form?.notes || ''} fullWidth
              onChange={e => setForm(v => ({ ...v, notes: e.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>ביטול</Button>
          <BusyButton variant="contained" loading={saving} onClick={save}>שמירה</BusyButton>
        </DialogActions>
      </Dialog>

      {/* ---- נמעני התראות ---- */}
      <Dialog open={!!recipients} onClose={() => setRecipients(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>נמעני התראות במייל</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            ההתראות על אישורים וקורסים שפג תוקפם נשלחות תמיד למנהלי המערכת ולהנה״ח.
            כאן מוסיפים כתובות נוספות — למשל של עינת.
          </Typography>
          <TextField
            label="כתובות מייל, מופרדות בפסיק" multiline minRows={2} fullWidth dir="ltr"
            value={recipients?.emails || ''}
            onChange={e => setRecipients({ emails: e.target.value })}
            placeholder="einat@example.com, office@example.com"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRecipients(null)}>ביטול</Button>
          <Button variant="contained" onClick={saveRecipients}>שמירה</Button>
        </DialogActions>
      </Dialog>
      <DriveImportDialog
        open={driveOpen}
        onClose={() => setDriveOpen(false)}
        branches={branches}
        certTypes={certTypes}
        onImported={load}
      />

    </Box>
  );
}
