import { useState, useEffect, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, Alert,
  Table, TableHead, TableBody, TableRow, TableCell, Checkbox,
  TextField, MenuItem, Button, CircularProgress, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, Select,
  InputLabel, FormControl, OutlinedInput, ListItemText,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LockResetIcon from '@mui/icons-material/LockReset';
import SaveIcon from '@mui/icons-material/Save';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import { TAB_GROUPS, ALL_TABS, isDefaultAllowed, roleHasTab } from '../../config/tabs';
import api from '../../api/client';
import { toast } from 'react-toastify';

const ROLE_LABELS = {
  system_admin: 'מנהל מערכת',
  branch_manager: 'מנהל סניף',
  accountant: 'הנה"ח',
  class_leader: 'גננת אחראית',
  teacher: 'גננת',
  assistant: 'סייעת',
  cook: 'מבשלת',
};

// State per user-tab cell. We track only effective allowed (true/false).
// On save we diff against the ROLE-EFFECTIVE access (role default + role-wide
// override) so a per-user override is only stored when it genuinely differs.
function computeOverrides(user, allowedMap, roleTabs = {}) {
  const add = [];
  const remove = [];
  for (const tab of ALL_TABS) {
    const allowed = !!allowedMap[tab.id];
    const def = roleHasTab(user.role, tab.id, roleTabs);
    if (allowed && !def) add.push(tab.id);
    if (!allowed && def) remove.push(tab.id);
  }
  return { add, remove };
}

// Effective per-user access. Mirrors hasTabAccess precedence:
// per-user override > role-wide override > role default.
function effectiveMap(user, roleTabs = {}) {
  const m = {};
  for (const tab of ALL_TABS) {
    let allowed = roleHasTab(user.role, tab.id, roleTabs); // default + role-wide
    if ((user.tab_overrides_add || []).includes(tab.id)) allowed = true;
    if ((user.tab_overrides_remove || []).includes(tab.id)) allowed = false;
    m[tab.id] = allowed;
  }
  return m;
}

function RoleDialog({ open, user, branches, onClose, onSaved }) {
  const [role, setRole] = useState('');
  const [managed, setManaged] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && user) {
      setRole(user.role || 'teacher');
      setManaged((user.managed_branch_ids || []).map(b => b._id || b.id || b));
    }
  }, [open, user]);

  if (!user) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(`/admin/users/${user._id}/role`, { role, managed_branch_ids: managed });
      onSaved(res.data.user);
      toast.success('עודכן');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>תפקיד וסניפים — {user.full_name || user.email}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="תפקיד" value={role} onChange={e => setRole(e.target.value)} fullWidth>
            {Object.entries(ROLE_LABELS).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setManaged(branches.map(b => b._id || b.id))}>
              כל הסניפים
            </Button>
            <Button size="small" onClick={() => setManaged([])}>ניקוי</Button>
          </Stack>
          <FormControl fullWidth>
            <InputLabel>סניפים מנוהלים</InputLabel>
            <Select
              multiple
              value={managed}
              onChange={e => setManaged(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
              input={<OutlinedInput label="סניפים מנוהלים" />}
              renderValue={(selected) => (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {selected.map(id => {
                    const b = branches.find(x => (x._id || x.id) === id);
                    return <Chip key={id} label={b?.name || id} size="small" />;
                  })}
                </Stack>
              )}
            >
              {branches.map(b => {
                const id = b._id || b.id;
                return (
                  <MenuItem key={id} value={id}>
                    <Checkbox checked={managed.indexOf(id) > -1} size="small" />
                    <ListItemText primary={b.name} />
                  </MenuItem>
                );
              })}
            </Select>
            <Typography variant="caption" sx={{ mt: 0.5, color: 'text.secondary' }}>
              אלו הסניפים שהמשתמש/ת יראה/תראה בבורר הסניפים ויוכל/תוכל לעבוד עליהם.
              ריק = רק הסניף הראשי שלו/ה. לגישה לכל הרשת חוץ מגן אחד — "כל הסניפים"
              ואז מסירים את אותו גן.
            </Typography>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>ביטול</Button>
        <Button variant="contained" onClick={save} disabled={saving}>שמור</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function PermissionsManager() {
  // The temporary password, held only until the administrator closes the
  // dialog. Never stored — a hash is all that exists after this.
  //
  // It lives HERE and not in RoleDialog, which is where it was declared: the
  // dialog that shows it is in this component's own JSX, so every render of
  // this screen was reading a name that is not in its scope. That is a
  // ReferenceError on the first paint, which React reports as a blank white
  // page — the permissions screen has been unreachable since it was written.
  const [tempPassword, setTempPassword] = useState(null);
  const [users, setUsers] = useState([]);
  // Active employees with no login at all — they can't appear in the table
  // below, so they get their own callout instead of vanishing silently.
  const [unlinked, setUnlinked] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [edits, setEdits] = useState({}); // userId -> { tabId -> bool }
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [roleDialog, setRoleDialog] = useState({ open: false, user: null });
  // Role-wide overrides: { role: { add: [], remove: [] } }
  const [roleTabs, setRoleTabs] = useState({});
  const [roleTabsDirty, setRoleTabsDirty] = useState(false);
  const [savingRoleTabs, setSavingRoleTabs] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [usersRes, branchesRes, roleTabsRes] = await Promise.all([
        api.get('/admin/users'),
        api.get('/branches'),
        api.get('/admin/role-tabs'),
      ]);
      setUsers(usersRes.data.users || []);
      setUnlinked(usersRes.data.unlinked_employees || []);
      setBranches(branchesRes.data.branches || []);
      setRoleTabs(roleTabsRes.data.role_tabs || {});
      setRoleTabsDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת משתמשים');
    } finally {
      setLoading(false);
    }
  }

  function getCellValue(user, tabId) {
    const userEdits = edits[user._id];
    if (userEdits && tabId in userEdits) return userEdits[tabId];
    return effectiveMap(user, roleTabs)[tabId];
  }

  function isCellOverride(user, tabId) {
    const value = getCellValue(user, tabId);
    const def = roleHasTab(user.role, tabId, roleTabs);
    return value !== def;
  }

  function isUserDirty(user) {
    const userEdits = edits[user._id];
    if (!userEdits) return false;
    const eff = effectiveMap(user, roleTabs);
    return Object.entries(userEdits).some(([k, v]) => eff[k] !== v);
  }

  function toggle(userId, tabId) {
    setEdits(prev => {
      const userEdits = { ...(prev[userId] || {}) };
      const user = users.find(u => u._id === userId);
      const current = (tabId in userEdits) ? userEdits[tabId] : effectiveMap(user, roleTabs)[tabId];
      userEdits[tabId] = !current;
      return { ...prev, [userId]: userEdits };
    });
  }

  function resetUser(userId) {
    setEdits(prev => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }

  async function resetPassword(user) {
    if (!window.confirm(`להנפיק סיסמה חדשה ל${user.full_name || user.email}?\n\nהסיסמה הנוכחית תפסיק לעבוד מיד. תוצג סיסמה זמנית להעברה בטלפון, והעובד/ת יידרש/תידרש לבחור סיסמה משלו/ה בכניסה הבאה.`)) return;
    try {
      const { data } = await api.post(`/admin/users/${user._id}/reset-password`, {});
      // Shown once and not stored anywhere readable, so it has to be put in
      // front of whoever is about to read it out — a toast that fades while
      // they are still looking for a pen is how the call ends with the person
      // still locked out.
      setTempPassword(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  }

  async function saveUser(user) {
    const eff = effectiveMap(user, roleTabs);
    const userEdits = edits[user._id] || {};
    const merged = { ...eff, ...userEdits };
    const { add, remove } = computeOverrides(user, merged, roleTabs);
    setSaving(s => ({ ...s, [user._id]: true }));
    try {
      const res = await api.patch(`/admin/users/${user._id}/tabs`, { add, remove });
      const fresh = res.data.user;
      setUsers(prev => prev.map(u => u._id === user._id ? { ...u, ...fresh } : u));
      setEdits(prev => {
        const next = { ...prev };
        delete next[user._id];
        return next;
      });
      toast.success(`הרשאות נשמרו: ${user.full_name || user.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(s => ({ ...s, [user._id]: false }));
    }
  }

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (roleFilter && u.role !== roleFilter) return false;
      if (!q) return true;
      const blob = `${u.full_name || ''} ${u.email || ''} ${u.position || ''}`.toLowerCase();
      return blob.includes(q);
    });
  }, [users, search, roleFilter]);

  // Per-role default tabs reference: derived from tabs.js
  const roleDefaults = useMemo(() => {
    const out = {};
    for (const role of Object.keys(ROLE_LABELS)) {
      out[role] = ALL_TABS.filter(t => !t.defaultRoles || t.defaultRoles.includes(role));
    }
    return out;
  }, []);

  // --- Role-wide tab overrides (bulk per role) -----------------------------
  // Toggling a tab for a role writes an add/remove entry against the role's
  // hardcoded default, so it applies to every user of that role at once.
  function toggleRoleTab(role, tabId) {
    setRoleTabs(prev => {
      const entry = { add: [...(prev[role]?.add || [])], remove: [...(prev[role]?.remove || [])] };
      const tab = ALL_TABS.find(t => t.id === tabId);
      const isDefault = isDefaultAllowed({ role }, tab);
      const currentlyOn = roleHasTab(role, tabId, prev);
      // Clear any existing override for this tab, then set the opposite of now.
      entry.add = entry.add.filter(t => t !== tabId);
      entry.remove = entry.remove.filter(t => t !== tabId);
      const want = !currentlyOn;
      if (want !== isDefault) (want ? entry.add : entry.remove).push(tabId);
      return { ...prev, [role]: entry };
    });
    setRoleTabsDirty(true);
  }

  async function saveRoleTabs() {
    setSavingRoleTabs(true);
    try {
      await api.put('/admin/role-tabs', { role_tabs: roleTabs });
      setRoleTabsDirty(false);
      toast.success('הרשאות התפקידים נשמרו — חלות על כל בעלי התפקיד');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setSavingRoleTabs(false);
    }
  }

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  return (
    <Box sx={{ p: { xs: 1, md: 3 } }}>
      {/* Shown once. All three details, because logging in needs the full name
          AND the id number AND the password — handing over the password alone
          ends the call with the person still locked out. */}
      <Dialog open={Boolean(tempPassword)} onClose={() => setTempPassword(null)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle>סיסמה זמנית — מוצגת פעם אחת</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            למסור <b>בטלפון</b>. הסיסמה לא נשמרת ואי אפשר יהיה לראות אותה שוב.
          </Alert>
          <Table size="small">
            <TableBody>
              <TableRow><TableCell>שם מלא</TableCell><TableCell><b>{tempPassword?.full_name}</b></TableCell></TableRow>
              <TableRow><TableCell>תעודת זהות</TableCell><TableCell dir="ltr">{tempPassword?.id_number || '—'}</TableCell></TableRow>
              <TableRow>
                <TableCell>סיסמה זמנית</TableCell>
                <TableCell dir="ltr"><Typography sx={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 700 }}>{tempPassword?.temp_password}</Typography></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            בכניסה הבאה המערכת תדרוש מהם לבחור סיסמה משלהם. עד שיבחרו, הסיסמה הזמנית
            לא מאפשרת לעשות שום דבר אחר.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setTempPassword(null)}>העתקתי, סגור</Button>
        </DialogActions>
      </Dialog>

      {/* Role-wide permissions — one click applies to EVERY user of that role */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3, bgcolor: '#fafbff' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 800 }}>הרשאות לפי תפקיד</Typography>
          <Chip label="חל על כל בעלי התפקיד" size="small" color="primary" variant="outlined" />
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained" size="small" startIcon={<SaveIcon />}
            disabled={!roleTabsDirty || savingRoleTabs} onClick={saveRoleTabs}
          >
            {savingRoleTabs ? 'שומר…' : 'שמור הרשאות תפקיד'}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          לחיצה על טאב מוסיפה/מסירה אותו לכל בעלי התפקיד במכה אחת. מלא = יש גישה, מתאר = אין.
          שינוי פר-משתמש (בטבלה למטה) גובר על הגדרת התפקיד.
        </Typography>
        <Stack spacing={1}>
          {Object.entries(ROLE_LABELS).map(([role, label]) => (
            <Stack key={role} direction="row" spacing={1} alignItems="flex-start" useFlexGap flexWrap="wrap">
              <Chip
                size="small"
                label={label}
                color={role === 'system_admin' ? 'error' : role === 'branch_manager' ? 'primary' : 'default'}
                sx={{ minWidth: 110, fontWeight: 700 }}
              />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {ALL_TABS.map(t => {
                  const on = roleHasTab(role, t.id, roleTabs);
                  const overridden = ((roleTabs[role]?.add || []).includes(t.id))
                    || ((roleTabs[role]?.remove || []).includes(t.id));
                  return (
                    <Chip
                      key={t.id} size="small" clickable
                      label={t.label}
                      onClick={() => toggleRoleTab(role, t.id)}
                      color={on ? 'primary' : 'default'}
                      variant={on ? 'filled' : 'outlined'}
                      sx={{
                        height: 22, fontSize: '0.7rem',
                        opacity: on ? 1 : 0.5,
                        border: overridden ? '2px solid #a78bfa' : undefined,
                      }}
                    />
                  );
                })}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Paper>

      {unlinked.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
            {unlinked.length} עובדים פעילים ללא משתמש — הם לא מופיעים בטבלה ולא יכולים להתחבר.
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mb: 1 }}>
            משתמש נוצר אוטומטית מכרטיס העובד לפי הת"ז. עובד ללא ת"ז — יש להשלים אותה בכרטיס, והמשתמש ייווצר בשמירה.
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {unlinked.map(e => (
              <Chip
                key={e.id} size="small"
                label={`${e.full_name}${e.position ? ` · ${e.position}` : ''}${e.branch_name ? ` · ${e.branch_name}` : ''}`}
                color={e.has_israeli_id ? 'default' : 'warning'}
                variant="outlined"
                title={e.has_israeli_id ? 'יש ת"ז — שמירת כרטיס העובד תיצור משתמש' : 'חסרה ת"ז — אי אפשר ליצור משתמש'}
              />
            ))}
          </Stack>
        </Alert>
      )}

      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>ניהול הרשאות לפי טאב</Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small" placeholder="חיפוש לפי שם / אימייל / תפקיד"
          value={search} onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 240 }}
        />
        <TextField
          select size="small" label="תפקיד"
          value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">הכל</MenuItem>
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <MenuItem key={k} value={k}>{v}</MenuItem>
          ))}
        </TextField>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        כל תפקיד מקבל ברירת מחדל של טאבים. סימון <b>V</b> = יש גישה, ריק = אין. תאים בצבע סגול = override (חורג מברירת המחדל של התפקיד). שינויים נשמרים פר משתמש.
      </Alert>

      <Paper sx={{ overflow: 'auto', maxWidth: '100%' }}>
        <Table size="small" sx={{ minWidth: 1200 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 800, bgcolor: '#f8fafc', position: 'sticky', left: 0, zIndex: 2, minWidth: 220 }}>
                משתמש
              </TableCell>
              {TAB_GROUPS.map(group => (
                group.items.map((tab, ti) => (
                  <TableCell
                    key={tab.id}
                    align="center"
                    sx={{
                      fontWeight: 700, fontSize: '0.7rem', bgcolor: '#f8fafc',
                      borderRight: ti === 0 ? '2px solid #cbd5e1' : undefined,
                      whiteSpace: 'nowrap', px: 0.5,
                    }}
                  >
                    <Stack alignItems="center" spacing={0}>
                      <Box sx={{ fontSize: '0.62rem', color: 'text.secondary' }}>{group.label}</Box>
                      <Box>{tab.label}</Box>
                    </Stack>
                  </TableCell>
                ))
              ))}
              <TableCell sx={{ bgcolor: '#f8fafc', minWidth: 130 }}></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredUsers.map(user => {
              const dirty = isUserDirty(user);
              return (
                <TableRow key={user._id} hover sx={{ bgcolor: dirty ? '#fef3c7' : 'inherit' }}>
                  <TableCell sx={{ position: 'sticky', left: 0, zIndex: 1, bgcolor: dirty ? '#fef3c7' : '#fff' }}>
                    <Stack spacing={0.3}>
                      <Box sx={{ fontWeight: 700, fontSize: '0.85rem' }}>{user.full_name || user.email}</Box>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        <Tooltip title="לחץ לעריכת תפקיד וסניפים מנוהלים">
                          <Chip
                            size="small"
                            label={ROLE_LABELS[user.role] || user.role}
                            onClick={() => setRoleDialog({ open: true, user })}
                            icon={<AdminPanelSettingsIcon sx={{ fontSize: 14 }} />}
                            color={user.role === 'branch_manager' ? 'primary' : user.role === 'system_admin' ? 'error' : 'default'}
                            sx={{ fontSize: '0.65rem', height: 20, cursor: 'pointer', '&:hover': { boxShadow: 1 } }}
                          />
                        </Tooltip>
                        {user.branch_id?.name && (
                          <Chip size="small" variant="outlined" label={user.branch_id.name} sx={{ fontSize: '0.65rem', height: 18 }} />
                        )}
                        {(user.managed_branch_ids || []).length > 1 && (
                          <Chip size="small" color="primary" variant="outlined"
                            label={`+${user.managed_branch_ids.length - 1} סניפים`}
                            sx={{ fontSize: '0.65rem', height: 18 }} />
                        )}
                      </Stack>
                    </Stack>
                  </TableCell>
                  {TAB_GROUPS.map(group => (
                    group.items.map((tab, ti) => {
                      const value = getCellValue(user, tab.id);
                      const override = isCellOverride(user, tab.id);
                      return (
                        <TableCell
                          key={tab.id}
                          align="center"
                          sx={{
                            borderRight: ti === 0 ? '2px solid #cbd5e1' : undefined,
                            bgcolor: override ? 'rgba(167,139,250,0.18)' : undefined,
                            p: 0,
                          }}
                        >
                          <Checkbox
                            size="small"
                            checked={value}
                            onChange={() => toggle(user._id, tab.id)}
                            sx={{ p: 0.5 }}
                          />
                        </TableCell>
                      );
                    })
                  ))}
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="ערוך תפקיד וסניפים מנוהלים">
                        <IconButton size="small" color="secondary" onClick={() => setRoleDialog({ open: true, user })}>
                          <AdminPanelSettingsIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="שמור">
                        <span>
                          <IconButton
                            size="small" color="primary"
                            disabled={!dirty || saving[user._id]}
                            onClick={() => saveUser(user)}
                          >
                            {saving[user._id] ? <CircularProgress size={16} /> : <SaveIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="בטל שינויים">
                        <span>
                          <IconButton
                            size="small"
                            disabled={!dirty}
                            onClick={() => resetUser(user._id)}
                          >
                            <RestartAltIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="אפס סיסמה (העובד יבחר חדשה בכניסה הבאה)">
                        <IconButton size="small" color="warning" onClick={() => resetPassword(user)}>
                          <LockResetIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredUsers.length === 0 && (
              <TableRow>
                <TableCell colSpan={ALL_TABS.length + 2} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  אין משתמשים תואמים.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        סה"כ {filteredUsers.length} משתמשים. לחץ על אייקון "מנהל סניף" כדי לערוך תפקיד וסניפים מנוהלים.
      </Typography>

      <RoleDialog
        open={roleDialog.open}
        user={roleDialog.user}
        branches={branches}
        onClose={() => setRoleDialog({ open: false, user: null })}
        onSaved={(fresh) => setUsers(prev => prev.map(u => u._id === fresh._id ? { ...u, ...fresh } : u))}
      />
    </Box>
  );
}
