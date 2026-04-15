import { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Table, TableBody, TableCell, TableHead, TableRow, TableContainer, Paper,
  Select, MenuItem, Chip, Alert, Box,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { toast } from 'react-toastify';
import api from '../../api/client';

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
  const [clockUsers, setClockUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // selections: { [clock_user_id_key]: employee_id }
  const [selections, setSelections] = useState({});

  useEffect(() => {
    if (!open || !branchId) return;
    setLoading(true);
    Promise.all([
      api.get('/payroll/clock-users', { params: { branch: branchId } }),
      api.get('/payroll/employees', { params: { branch: branchId, active: 'true' } }),
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
  }, [open, branchId]);

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
        שיוך עובדים לשעון — {branchName || ''}
      </DialogTitle>
      <DialogContent>
        {loading ? (
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
                  {linked.map(u => (
                    <Chip
                      key={u.user_id}
                      icon={<CheckCircleIcon />}
                      label={`${u.linked_employee.full_name} · ${u.user_id}`}
                      size="small"
                      color="success"
                      variant="outlined"
                    />
                  ))}
                </Stack>
              </Box>
            )}

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
