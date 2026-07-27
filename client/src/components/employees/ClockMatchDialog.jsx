import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Select, MenuItem, Chip, Alert, Box, FormControl, InputLabel,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useBranch } from '../../hooks/useBranch';

/**
 * ClockMatchDialog — bulk-assign clock user IDs to payroll employees.
 *
 * The dialog fetches:
 *   1) The branch's cached clock user list (from Branch.clock_users)
 *   2) All active employees in the branch
 *
 * It then renders one row per clock user that is NOT yet linked. Each row has
 * a dropdown of employees that DON'T yet have an israeli_id. Save applies
 * all non-empty selections in one batch via /api/payroll/clock-users/assign,
 * which triggers the Employee post-save hook to re-link any orphan punches.
 *
 * Clock users already linked to an employee are shown at the top as a
 * checklist so the admin knows what's done.
 */
export default function ClockMatchDialog({ open, branchId, branchName, onClose, onSaved }) {
  const { branches } = useBranch();
  // When the global picker is on 'all', let the user pick a specific branch
  // inside the dialog (the clock-users endpoint can only handle one branch).
  const isAll = !branchId || branchId === 'all';
  const [pickedBranch, setPickedBranch] = useState('');
  const effectiveBranch = isAll ? pickedBranch : branchId;

  const [clockUsers, setClockUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // selections: { [clock_user_id_key]: employee_id }
  const [selections, setSelections] = useState({});
  // Enroll an existing employee (already set up elsewhere) onto THIS branch's clock.
  const [enrollEmp, setEnrollEmp] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  // Cross-branch fingerprint copy — stage 1 (safe): verify we can READ the
  // employee's fingerprint template off the source branch's clock.
  const [sourceBranch, setSourceBranch] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [templateResult, setTemplateResult] = useState(null);
  // Stage 2: write the extracted templates onto THIS branch's clock.
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // One-press mirroring of the finger to every branch the employee works at.
  const [syncEmp, setSyncEmp] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    if (!open || !effectiveBranch) return;
    setLoading(true);
    // Load employees system-wide (not just this branch) so cross-branch
    // workers show up in the assignment dropdown too.
    Promise.all([
      api.get('/payroll/clock-users', { params: { branch: effectiveBranch } }),
      api.get('/payroll/employees', { params: { active: 'true' } }),
    ])
      .then(([clockRes, empRes]) => {
        setClockUsers(clockRes.data.clock_users || []);
        setUpdatedAt(clockRes.data.updated_at);
        setEmployees(empRes.data.employees || []);
        setSelections({});
      })
      .catch(err => {
        console.error(err);
        toast.error('שגיאה בטעינת נתוני השעון');
      })
      .finally(() => setLoading(false));
  }, [open, effectiveBranch]);

  const linked = useMemo(() => clockUsers.filter(u => u.linked_employee), [clockUsers]);
  const unlinked = useMemo(() => clockUsers.filter(u => !u.linked_employee), [clockUsers]);

  // Employees without an israeli_id — available for assignment.
  // We exclude any employee already picked in another row of this dialog
  // so the same employee can't be assigned twice in one batch.
  const assignableEmployees = useMemo(() => {
    const freshOnes = employees.filter(e => !e.israeli_id);
    const picked = new Set(Object.values(selections).filter(Boolean));
    return freshOnes.filter(e => !picked.has(String(e._id || e.id)));
  }, [employees, selections]);

  const selectEmployee = (clockUserKey, employeeId) => {
    setSelections(prev => ({ ...prev, [clockUserKey]: employeeId }));
  };

  // Employees WITH a ת"ז who are NOT already on this branch's clock — candidates
  // to register on the device (e.g. a cross-branch worker set up elsewhere).
  const addableEmployees = useMemo(() => {
    const onClock = new Set(clockUsers.map(u => String(u.user_id)));
    return employees
      .filter(e => e.israeli_id && !onClock.has(String(e.israeli_id)))
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'he'));
  }, [employees, clockUsers]);

  const enroll = async () => {
    if (!enrollEmp || !effectiveBranch) return;
    setEnrolling(true);
    try {
      const res = await api.post(`/payroll/employees/${enrollEmp}/enroll-clock`, { branch_id: effectiveBranch });
      toast.success(`נשלחה פקודה לשעון — ${res.data.full_name} (ת"ז ${res.data.israeli_id}) יתווסף. יש להחתים את טביעת האצבע פעם אחת במכשיר.`, { autoClose: 8000 });
      setEnrollEmp('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשיוך לשעון');
    } finally {
      setEnrolling(false);
    }
  };

  // Mirror the employee's fingerprint to every branch she works at (home branch
  // + her per-branch rates). The server captures the finger from a clock that
  // already has it when it doesn't hold a copy yet, then pushes it onward on
  // its own — nothing here needs to know which branch is the source.
  // Anyone with a ת"ז can be synced — including workers already on this clock.
  const syncableEmployees = useMemo(
    () => employees.filter(e => e.israeli_id)
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'he')),
    [employees]
  );

  const syncFingerprint = async () => {
    if (!syncEmp) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const { data } = await api.post(`/payroll/employees/${syncEmp}/sync-fingerprint`, {});
      setSyncResult(data);
      toast.success(data.message || 'הסנכרון הופעל', { autoClose: 8000 });
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בסנכרון הטביעה');
    } finally {
      setSyncing(false);
    }
  };

  // Source-branch options for the fingerprint-read test: any branch other than
  // the one we're enrolling into (the target).
  const sourceBranchOptions = useMemo(
    () => (branches || []).filter(b => String(b._id || b.id) !== String(effectiveBranch)),
    [branches, effectiveBranch]
  );

  const TPL_ERR_HE = {
    user_not_on_device: 'העובד/ת לא רשומ/ה בשעון של סניף המקור שנבחר.',
  };

  const verifyTemplate = async () => {
    if (!enrollEmp || !sourceBranch) return;
    setVerifying(true);
    setTemplateResult(null);
    setImportResult(null);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const { data } = await api.post(`/payroll/employees/${enrollEmp}/export-template`, { branch_id: sourceBranch });
      const cmdId = data.command_id;
      let final = null;
      // The Pi polls for commands every ~15s; give it up to ~40s to answer.
      for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const { data: st } = await api.get(`/payroll/clock-commands/${cmdId}`);
        if (st.status === 'confirmed' || st.status === 'failed') { final = st; break; }
      }
      if (!final) {
        setTemplateResult({ status: 'timeout' });
      } else if (final.status === 'failed') {
        setTemplateResult({ status: 'failed', error: final.last_error });
      } else {
        setTemplateResult({ status: 'confirmed', export_command_id: cmdId, ...(final.result || {}) });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בבדיקת חילוץ הטביעה');
    } finally {
      setVerifying(false);
    }
  };

  // Stage 2: queue the WRITE of the just-extracted templates onto the clock
  // of the branch this dialog is enrolling into. The server takes the blobs
  // from the completed export command — nothing sensitive passes through here.
  const importTemplate = async () => {
    if (!enrollEmp || !effectiveBranch || !templateResult?.export_command_id) return;
    const srcName = (branches || []).find(b => String(b._id || b.id) === String(sourceBranch))?.name || 'המקור';
    if (!window.confirm(`לכתוב את טביעת האצבע לשעון של ${branchName || 'הסניף הזה'}?\n(המקור: ${srcName}. הפעולה כותבת למכשיר חי.)`)) return;
    setImporting(true);
    setImportResult(null);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const { data } = await api.post(`/payroll/employees/${enrollEmp}/import-template`, {
        target_branch_id: effectiveBranch,
        export_command_id: templateResult.export_command_id,
      });
      const cmdId = data.command_id;
      let final = null;
      for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const { data: st } = await api.get(`/payroll/clock-commands/${cmdId}`);
        if (st.status === 'confirmed' || st.status === 'failed') { final = st; break; }
      }
      if (!final) {
        setImportResult({ status: 'timeout' });
      } else if (final.status === 'failed') {
        setImportResult({ status: 'failed', error: final.last_error });
      } else {
        setImportResult({ status: 'confirmed', ...(final.result || {}) });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בכתיבת הטביעה לשעון');
    } finally {
      setImporting(false);
    }
  };

  const selectionCount = Object.values(selections).filter(Boolean).length;

  const handleSave = async () => {
    const payload = Object.entries(selections)
      .filter(([, empId]) => !!empId)
      .map(([key, empId]) => {
        const cu = unlinked.find(u => String(u.user_id) === key);
        return { employee_id: empId, israeli_id: cu?.user_id };
      })
      .filter(a => a.employee_id && a.israeli_id);

    if (payload.length === 0) {
      toast.info('לא בחרת אף שיוך');
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/payroll/clock-users/assign', { assignments: payload });
      const { applied, failed } = res.data;
      toast.success(`${applied} עובדים שויכו${failed > 0 ? ` • ${failed} נכשלו` : ''}`);
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירת השיוכים');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} dir="rtl" maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        שיוך עובדים לשעון{isAll ? '' : ` — ${branchName || ''}`}
      </DialogTitle>
      <DialogContent>
        {isAll && (
          <FormControl size="small" fullWidth sx={{ mt: 1, mb: 2 }}>
            <InputLabel>בחר סניף</InputLabel>
            <Select
              value={pickedBranch}
              label="בחר סניף"
              onChange={e => setPickedBranch(e.target.value)}
            >
              {(branches || []).map(b => (
                <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        {!effectiveBranch ? (
          <Alert severity="info">בחר סניף ספציפי מהרשימה למעלה כדי לטעון את משתמשי השעון.</Alert>
        ) : loading ? (
          <Typography sx={{ py: 4, textAlign: 'center' }}>טוען…</Typography>
        ) : (
          <Stack spacing={2}>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              לכל משתמש בשעון שמופיע כאן יש תעודת זהות אמיתית (שדה <code>userId</code> בשעון).
              בחר עבור כל משתמש את העובד המתאים ולחץ "שמור". השיוך יעדכן את ה-ת״ז על העובד
              ויקשר אוטומטית את כל ההחתמות ההיסטוריות שלו.
              {updatedAt && (
                <Box sx={{ mt: 0.5, fontSize: '0.75rem', opacity: 0.8 }}>
                  רשימה מהשעון עודכנה: {new Date(updatedAt).toLocaleString('he-IL')}
                </Box>
              )}
            </Alert>

            {linked.length > 0 && (
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                  כבר משויכים ({linked.length})
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {linked.map(u => {
                    const le = u.linked_employee;
                    const isCrossBranch = le.branch_name && le.branch_name.replace(/\s+/g, ' ').trim() !== (branchName || '').replace(/\s+/g, ' ').trim();
                    return (
                      <Chip
                        key={u.user_id}
                        icon={<CheckCircleIcon />}
                        label={
                          <span>
                            {le.full_name} · {u.user_id}
                            {isCrossBranch && <span style={{ marginInlineStart: 6, opacity: 0.75, fontSize: '0.75em' }}>({le.branch_name})</span>}
                          </span>
                        }
                        size="small"
                        color={isCrossBranch ? 'secondary' : 'success'}
                        variant="outlined"
                      />
                    );
                  })}
                </Stack>
              </Box>
            )}

            <Box sx={{ p: 1.5, border: '1px dashed', borderColor: 'primary.light', borderRadius: 2, bgcolor: 'primary.50' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>הוספת עובד/ת קיים/ת לשעון סניף זה</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                עובד/ת שכבר קיים/ת במערכת (עם ת"ז) ועובד/ת גם כאן — בחר/י ולחץ/י "הוסף לשעון". נשלחת פקודה למכשיר לרשום את ת"ז + השם.
                את <b>טביעת האצבע</b> אפשר להעתיק לכל הסניפים בלחיצה אחת — "סנכרן טביעה לכל הסניפים".
              </Typography>
              <Stack direction="row" spacing={1}>
                <Select size="small" fullWidth value={enrollEmp} onChange={e => setEnrollEmp(e.target.value)} displayEmpty>
                  <MenuItem value=""><em>— בחר/י עובד/ת —</em></MenuItem>
                  {addableEmployees.map(e => (
                    <MenuItem key={e._id || e.id} value={String(e._id || e.id)}>{e.full_name} · {e.israeli_id}</MenuItem>
                  ))}
                </Select>
                <Button variant="outlined" onClick={enroll} disabled={!enrollEmp || enrolling} sx={{ whiteSpace: 'nowrap' }}>
                  {enrolling ? 'שולח…' : 'הוסף לשעון'}
                </Button>
              </Stack>

              <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
                <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                  🫆 סנכרון טביעת אצבע לכל הסניפים של העובד/ת
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  מעתיק את הטביעה לכל הסניפים שבהם העובד/ת עובד/ת (הסניף הראשי + הסניפים שבתעריפים פר-סניף).
                  אם עדיין אין לנו עותק של הטביעה — נשלחת קודם קריאה מהשעון שבו היא כן קיימת, וההעתקה נמשכת לבד.
                </Typography>
                <Stack direction="row" spacing={1}>
                  {/* Own picker: a cross-branch worker is usually ALREADY on this
                      clock, so the "add to clock" list above wouldn't show her. */}
                  <Select size="small" fullWidth value={syncEmp} onChange={e => { setSyncEmp(e.target.value); setSyncResult(null); }} displayEmpty>
                    <MenuItem value=""><em>— בחר/י עובד/ת —</em></MenuItem>
                    {syncableEmployees.map(e => (
                      <MenuItem key={e._id || e.id} value={String(e._id || e.id)}>{e.full_name} · {e.israeli_id}</MenuItem>
                    ))}
                  </Select>
                  <Button variant="outlined" color="secondary" onClick={syncFingerprint}
                    disabled={!syncEmp || syncing} sx={{ whiteSpace: 'nowrap' }}>
                    {syncing ? 'מסנכרן…' : '🫆 סנכרן טביעה'}
                  </Button>
                </Stack>
                {syncResult && (
                  <Alert severity={syncResult.status === 'no_source_left' ? 'warning' : 'info'} sx={{ py: 0.5, mt: 1 }}>
                    {syncResult.message}
                    {syncResult.queued?.length > 0 && (
                      <Box sx={{ mt: 0.5, fontSize: '0.75rem' }}>
                        נשלחו פקודות לסניפים: {syncResult.queued.map(q => q.branch_name).join(', ')} — לוקח עד כדקה.
                      </Box>
                    )}
                    {syncResult.branches?.length > 0 && (
                      <Box sx={{ mt: 0.5, fontSize: '0.75rem', opacity: 0.8 }}>
                        סניפים רלוונטיים: {syncResult.branches.join(', ')}
                      </Box>
                    )}
                  </Alert>
                )}
              </Box>

              <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
                <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                  🔍 בדיקת חילוץ טביעה (שלב בטוח — קריאה בלבד)
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  בחר/י קודם עובד/ת למעלה, ואז את סניף <b>המקור</b> שבו טביעת האצבע כבר קיימת, ולחץ/י "בדוק חילוץ".
                  זה רק קורא את הטביעה מהמכשיר — לא כותב לשום מכשיר.
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Select size="small" fullWidth value={sourceBranch} onChange={e => setSourceBranch(e.target.value)} displayEmpty>
                    <MenuItem value=""><em>— סניף מקור —</em></MenuItem>
                    {sourceBranchOptions.map(b => (
                      <MenuItem key={b._id || b.id} value={String(b._id || b.id)}>{b.name}</MenuItem>
                    ))}
                  </Select>
                  <Button variant="text" onClick={verifyTemplate} disabled={!enrollEmp || !sourceBranch || verifying} sx={{ whiteSpace: 'nowrap' }}>
                    {verifying ? 'בודק…' : 'בדוק חילוץ'}
                  </Button>
                </Stack>
                {templateResult && (
                  <Box sx={{ mt: 1 }}>
                    {templateResult.status === 'confirmed' && templateResult.finger_count > 0 && (
                      <Alert severity="success" sx={{ py: 0.5 }}>
                        ✅ חולצו {templateResult.finger_count} טביעות (אצבעות: {(templateResult.templates || []).map(t => t.fid).join(', ')}).
                        {!importResult && (
                          <Button
                            size="small" variant="contained" color="warning" onClick={importTemplate}
                            disabled={importing} sx={{ mt: 1, display: 'block' }}
                          >
                            {importing ? 'כותב לשעון…' : '✍️ העתק את הטביעה לשעון של הסניף הזה'}
                          </Button>
                        )}
                      </Alert>
                    )}
                    {importResult?.status === 'confirmed' && (
                      <Alert severity="success" sx={{ py: 0.5, mt: 1 }}>
                        🎉 הטביעה נכתבה לשעון ואומתה בקריאה חוזרת ({importResult.verified_fingers} אצבעות במכשיר).
                        העובד/ת יכול/ה להחתים כאן החל מעכשיו.
                      </Alert>
                    )}
                    {importResult?.status === 'failed' && (
                      <Alert severity="error" sx={{ py: 0.5, mt: 1 }}>
                        {importResult.error === 'user_not_on_device'
                          ? 'העובד/ת עדיין לא רשומ/ה בשעון של הסניף הזה — לחץ/י קודם "הוסף לשעון" והמתן/י כחצי דקה.'
                          : (importResult.error || 'הכתיבה לשעון נכשלה')}
                      </Alert>
                    )}
                    {importResult?.status === 'timeout' && (
                      <Alert severity="info" sx={{ py: 0.5, mt: 1 }}>
                        פקודת הכתיבה נשלחה — ה-Pi של הסניף הזה עדיין לא ענה. אפשר לבדוק שוב בעוד רגע.
                      </Alert>
                    )}
                    {templateResult.status === 'confirmed' && !templateResult.finger_count && (
                      <Alert severity="warning" sx={{ py: 0.5 }}>העובד/ת קיים/ת בשעון המקור, אך אין לו/ה טביעות אצבע רשומות שם.</Alert>
                    )}
                    {templateResult.status === 'failed' && (
                      <Alert severity="error" sx={{ py: 0.5 }}>{TPL_ERR_HE[templateResult.error] || templateResult.error || 'החילוץ נכשל'}</Alert>
                    )}
                    {templateResult.status === 'timeout' && (
                      <Alert severity="info" sx={{ py: 0.5 }}>הפקודה נשלחה — ה-Pi של סניף המקור עדיין לא ענה. ודא/י שה-agent פועל ונסה/י שוב.</Alert>
                    )}
                  </Box>
                )}
              </Box>
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                לשיוך ({unlinked.length})
              </Typography>
              {unlinked.length === 0 ? (
                <Alert severity="success">כל משתמשי השעון כבר משויכים לעובדים.</Alert>
              ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>uid בשעון</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>ת״ז</TableCell>
                        <TableCell sx={{ fontWeight: 700, minWidth: 260 }}>שייך לעובד</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {unlinked.map(u => {
                        const key = String(u.user_id);
                        const picked = selections[key] || '';
                        // For this row's dropdown: include already-picked
                        // employees in other rows EXCLUDED, but include THIS
                        // row's current selection (if any) so user can see it.
                        const options = [...assignableEmployees];
                        if (picked) {
                          const self = employees.find(e => String(e._id || e.id) === picked);
                          if (self && !options.find(o => String(o._id || o.id) === picked)) {
                            options.push(self);
                          }
                        }
                        return (
                          <TableRow key={key}>
                            <TableCell>{u.uid}</TableCell>
                            <TableCell dir="ltr" sx={{ fontFamily: 'monospace' }}>{u.user_id}</TableCell>
                            <TableCell>
                              <Select
                                size="small"
                                fullWidth
                                value={picked}
                                onChange={(e) => selectEmployee(key, e.target.value)}
                                displayEmpty
                              >
                                <MenuItem value=""><em>— דלג —</em></MenuItem>
                                {options.map(e => (
                                  <MenuItem key={e._id || e.id} value={String(e._id || e.id)}>
                                    {e.full_name}
                                  </MenuItem>
                                ))}
                              </Select>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>ביטול</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || selectionCount === 0}
        >
          {saving ? 'שומר…' : `שמור ${selectionCount} שיוכים`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
