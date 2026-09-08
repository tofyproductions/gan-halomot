import { useState, useEffect, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, Alert,
  Table, TableHead, TableBody, TableRow, TableCell, Checkbox,
  TextField, MenuItem, Button, CircularProgress, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, Select,
  InputLabel, FormControl, OutlinedInput, ListItemText, ListSubheader,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LockResetIcon from '@mui/icons-material/LockReset';
import SaveIcon from '@mui/icons-material/Save';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import { TAB_GROUPS, ALL_TABS, isDefaultAllowed, roleHasTab, customRoleHasTab } from '../../config/tabs';
import api from '../../api/client';
import { toast } from 'react-toastify';

const ROLE_LABELS = {
  system_admin: 'מנהל מערכת',
  admin_viewer: 'מנהל מערכת - לצפייה בלבד',
  branch_manager: 'מנהל סניף',
  accountant: 'הנה"ח',
  class_leader: 'גננת אחראית',
  teacher: 'גננת',
  assistant: 'סייעת',
  cook: 'מבשלת',
};

/**
 * The custom role this user holds, out of the loaded list.
 *
 * `custom_role_id` arrives from /api/admin/users as a plain string (the
 * controller flattens the populated document on purpose) so this is a lookup,
 * not an unwrap.
 */
function customRoleOf(user, customRoles = []) {
  if (!user?.custom_role_id) return null;
  return customRoles.find(r => String(r._id) === String(user.custom_role_id)) || null;
}

/** What this person's role is CALLED on screen — the custom name wins. */
function roleLabelOf(user, customRoles = []) {
  const cr = customRoleOf(user, customRoles);
  if (cr) return cr.name;
  return ROLE_LABELS[user?.role] || user?.role || '';
}

// State per user-tab cell. We track only effective allowed (true/false).
// On save we diff against the ROLE-EFFECTIVE access — the custom role's lists
// when she holds one, otherwise role default + role-wide override — so a
// per-user override is only stored when it genuinely differs from what the
// role already gives her.
function computeOverrides(user, allowedMap, roleTabs = {}, customRole = null) {
  const add = [];
  const remove = [];
  for (const tab of ALL_TABS) {
    const allowed = !!allowedMap[tab.id];
    const def = roleHasTab(user.role, tab.id, roleTabs, customRole);
    if (allowed && !def) add.push(tab.id);
    if (!allowed && def) remove.push(tab.id);
  }
  return { add, remove };
}

// Effective per-user access. Mirrors hasTabAccess precedence:
// per-user override > role layer (custom role, else role-wide override) > default.
function effectiveMap(user, roleTabs = {}, customRole = null) {
  const m = {};
  for (const tab of ALL_TABS) {
    let allowed = roleHasTab(user.role, tab.id, roleTabs, customRole);
    if ((user.tab_overrides_add || []).includes(tab.id)) allowed = true;
    if ((user.tab_overrides_remove || []).includes(tab.id)) allowed = false;
    m[tab.id] = allowed;
  }
  return m;
}

function RoleDialog({ open, user, branches, customRoles, onClose, onSaved, onRoleCreated }) {
  // One dropdown, two kinds of answer. 'role:<builtin>' or 'custom:<id>' —
  // keeping them as two pieces of state is how a screen ends up sending both
  // and meaning neither.
  const [choice, setChoice] = useState('role:teacher');
  const [managed, setManaged] = useState([]);
  const [saving, setSaving] = useState(false);
  const [nameDialog, setNameDialog] = useState(null);   // the "build a role" name
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open && user) {
      setChoice(user.custom_role_id ? `custom:${user.custom_role_id}` : `role:${user.role || 'teacher'}`);
      setManaged((user.managed_branch_ids || []).map(b => b._id || b.id || b));
    }
  }, [open, user]);

  if (!user) return null;

  const chosenCustom = choice.startsWith('custom:')
    ? (customRoles || []).find(r => String(r._id) === choice.slice(7))
    : null;

  const save = async () => {
    setSaving(true);
    try {
      const body = chosenCustom
        ? { custom_role_id: chosenCustom._id, managed_branch_ids: managed }
        : { role: choice.slice(5), custom_role_id: null, managed_branch_ids: managed };
      const res = await api.patch(`/admin/users/${user._id}/role`, body);
      onSaved(res.data.user);
      toast.success('עודכן. שינויים נכנסים לתוקף אחרי התחברות מחדש.');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setSaving(false); }
  };

  /**
   * "הקם תפקיד מההרשאות של משתמש/ת זה".
   *
   * The server computes her EFFECTIVE tab set and expresses it as a difference
   * from her base role's defaults — the client does not send a tab list,
   * because the client's idea of what she has is a render of the same data and
   * sending it back would make the role depend on which screen built it.
   */
  const createFromUser = async () => {
    const name = String(nameDialog || '').trim();
    if (!name) return;
    setCreating(true);
    try {
      const { data } = await api.post(`/admin/custom-roles/from-user/${user._id}`, { name });
      setNameDialog(null);
      onRoleCreated(data.role, data.user);
      toast.success(`התפקיד "${data.role.name}" הוקם והוקצה ל${user.full_name || user.email}. שינויים נכנסים לתוקף אחרי התחברות מחדש.`);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally { setCreating(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth dir="rtl">
      <DialogTitle>תפקיד וסניפים — {user.full_name || user.email}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="תפקיד" value={choice} onChange={e => setChoice(e.target.value)} fullWidth>
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <MenuItem key={k} value={`role:${k}`}>{v}</MenuItem>
            ))}
            {(customRoles || []).length > 0 && <Divider />}
            {(customRoles || []).length > 0 && (
              <ListSubheader sx={{ fontWeight: 800 }}>תפקידים מותאמים</ListSubheader>
            )}
            {(customRoles || []).map(r => (
              <MenuItem key={r._id} value={`custom:${r._id}`}>{r.name}</MenuItem>
            ))}
          </TextField>
          {chosenCustom && (
            <Typography variant="caption" sx={{ mt: -1, color: 'text.secondary' }}>
              על בסיס {ROLE_LABELS[chosenCustom.base_role] || chosenCustom.base_role} — כל
              כללי הסניפים והאישורים ימשיכו לעבוד לפי תפקיד הבסיס.
            </Typography>
          )}
          <Button
            size="small" variant="outlined" startIcon={<BookmarkAddIcon />}
            onClick={() => setNameDialog(`${user.full_name || user.email} — תפקיד`)}
          >
            הקם תפקיד מההרשאות של משתמש/ת זה
          </Button>
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

      <Dialog open={nameDialog !== null} onClose={() => setNameDialog(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>הקמת תפקיד מההרשאות הקיימות</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            ההרשאות שיש כרגע ל<b>{user.full_name || user.email}</b> יהפכו לתפקיד בשם שתבחר/י,
            והיא תשויך אליו. מכאן והלאה אפשר להקצות אותו לעובדים נוספים ולערוך אותו במקום אחד.
          </Typography>
          <TextField
            autoFocus fullWidth label="שם התפקיד"
            value={nameDialog || ''} onChange={e => setNameDialog(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNameDialog(null)}>ביטול</Button>
          <Button
            variant="contained" onClick={createFromUser}
            disabled={creating || !String(nameDialog || '').trim()}
          >
            {creating ? 'מקים…' : 'הקם תפקיד'}
          </Button>
        </DialogActions>
      </Dialog>
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
  // Named permission sets built from a person's own tabs. They sit in the same
  // "הרשאות לפי תפקיד" panel as the eight built-ins, because to whoever is
  // using this screen that is what they are.
  const [customRoles, setCustomRoles] = useState([]);
  const [customRolesDirty, setCustomRolesDirty] = useState({});   // roleId -> true
  const [deleteRole, setDeleteRole] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [usersRes, branchesRes, roleTabsRes, customRes] = await Promise.all([
        api.get('/admin/users'),
        api.get('/branches'),
        api.get('/admin/role-tabs'),
        api.get('/admin/custom-roles'),
      ]);
      setUsers(usersRes.data.users || []);
      setUnlinked(usersRes.data.unlinked_employees || []);
      setBranches(branchesRes.data.branches || []);
      setRoleTabs(roleTabsRes.data.role_tabs || {});
      setCustomRoles(customRes.data.roles || []);
      setCustomRolesDirty({});
      setRoleTabsDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת משתמשים');
    } finally {
      setLoading(false);
    }
  }

  // The role layer to measure this person against — her custom role when she
  // holds one, and only then the role-wide override for her role.
  const roleLayerOf = (user) => customRoleOf(user, customRoles);

  function getCellValue(user, tabId) {
    const userEdits = edits[user._id];
    if (userEdits && tabId in userEdits) return userEdits[tabId];
    return effectiveMap(user, roleTabs, roleLayerOf(user))[tabId];
  }

  function isCellOverride(user, tabId) {
    const value = getCellValue(user, tabId);
    const def = roleHasTab(user.role, tabId, roleTabs, roleLayerOf(user));
    return value !== def;
  }

  function isUserDirty(user) {
    const userEdits = edits[user._id];
    if (!userEdits) return false;
    const eff = effectiveMap(user, roleTabs, roleLayerOf(user));
    return Object.entries(userEdits).some(([k, v]) => eff[k] !== v);
  }

  function toggle(userId, tabId) {
    setEdits(prev => {
      const userEdits = { ...(prev[userId] || {}) };
      const user = users.find(u => u._id === userId);
      const current = (tabId in userEdits)
        ? userEdits[tabId]
        : effectiveMap(user, roleTabs, customRoleOf(user, customRoles))[tabId];
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
    const layer = roleLayerOf(user);
    const eff = effectiveMap(user, roleTabs, layer);
    const userEdits = edits[user._id] || {};
    const merged = { ...eff, ...userEdits };
    const { add, remove } = computeOverrides(user, merged, roleTabs, layer);
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

  /**
   * The same click, on a custom role's row.
   *
   * A custom role's lists are a difference from its BASE role's defaults, not
   * from the role-wide override — the override is the thing it replaces — so
   * the toggle is written against isDefaultAllowed({ role: base_role }).
   */
  function toggleCustomRoleTab(roleId, tabId) {
    setCustomRoles(prev => prev.map(r => {
      if (String(r._id) !== String(roleId)) return r;
      const tab = ALL_TABS.find(t => t.id === tabId);
      const isDefault = isDefaultAllowed({ role: r.base_role }, tab);
      const currentlyOn = customRoleHasTab(r, tabId);
      const add = (r.tab_add || []).filter(t => t !== tabId);
      const remove = (r.tab_remove || []).filter(t => t !== tabId);
      const want = !currentlyOn;
      if (want !== isDefault) (want ? add : remove).push(tabId);
      return { ...r, tab_add: add, tab_remove: remove };
    }));
    setCustomRolesDirty(prev => ({ ...prev, [roleId]: true }));
  }

  // One button saves the panel — the eight built-in rows and the custom-role
  // rows below them. Two save buttons on one panel is a panel half saved.
  async function saveRoleTabs() {
    setSavingRoleTabs(true);
    try {
      if (roleTabsDirty) await api.put('/admin/role-tabs', { role_tabs: roleTabs });
      const dirtyIds = Object.keys(customRolesDirty).filter(id => customRolesDirty[id]);
      for (const id of dirtyIds) {
        const r = customRoles.find(x => String(x._id) === String(id));
        if (!r) continue;
        await api.patch(`/admin/custom-roles/${id}`, {
          tab_add: r.tab_add || [], tab_remove: r.tab_remove || [],
        });
      }
      setRoleTabsDirty(false);
      setCustomRolesDirty({});
      toast.success('הרשאות התפקידים נשמרו — חלות על כל בעלי התפקיד. שינויים נכנסים לתוקף אחרי התחברות מחדש.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    } finally {
      setSavingRoleTabs(false);
    }
  }

  async function confirmDeleteRole() {
    const role = deleteRole;
    if (!role) return;
    try {
      const { data } = await api.delete(`/admin/custom-roles/${role._id}`);
      setDeleteRole(null);
      toast.success(`התפקיד "${role.name}" נמחק. ${data.reverted || 0} משתמשים חזרו לתפקיד הבסיס.`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  }

  const roleTabsPanelDirty = roleTabsDirty
    || Object.values(customRolesDirty).some(Boolean);

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
            disabled={!roleTabsPanelDirty || savingRoleTabs} onClick={saveRoleTabs}
          >
            {savingRoleTabs ? 'שומר…' : 'שמור הרשאות תפקיד'}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          לחיצה על טאב מוסיפה/מסירה אותו לכל בעלי התפקיד במכה אחת. מלא = יש גישה, מתאר = אין.
          שינוי פר-משתמש (בטבלה למטה) גובר על הגדרת התפקיד.
          שינוי הרשאות נכנס לתוקף אחרי שהמשתמש/ת מתנתק/ת ומתחבר/ת מחדש.
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

          {customRoles.length > 0 && <Divider sx={{ my: 1 }}>תפקידים מותאמים</Divider>}
          {customRoles.map(cr => (
            <Stack key={cr._id} direction="row" spacing={1} alignItems="flex-start" useFlexGap flexWrap="wrap">
              <Stack sx={{ minWidth: 110 }} spacing={0.2}>
                <Chip
                  size="small"
                  label={cr.name}
                  color="secondary"
                  sx={{ fontWeight: 700, maxWidth: 160 }}
                />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.62rem' }}>
                  על בסיס {ROLE_LABELS[cr.base_role] || cr.base_role}
                  {cr.user_count ? ` · ${cr.user_count} משתמשים` : ' · אין משתמשים'}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ flex: 1 }}>
                {ALL_TABS.map(t => {
                  const on = customRoleHasTab(cr, t.id);
                  const overridden = (cr.tab_add || []).includes(t.id) || (cr.tab_remove || []).includes(t.id);
                  return (
                    <Chip
                      key={t.id} size="small" clickable
                      label={t.label}
                      onClick={() => toggleCustomRoleTab(cr._id, t.id)}
                      color={on ? 'secondary' : 'default'}
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
              <Tooltip title="מחיקת התפקיד">
                <IconButton size="small" color="error" onClick={() => setDeleteRole(cr)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
        {customRoles.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            אין עדיין תפקידים מותאמים. אפשר להקים אחד מהרשאות של עובד/ת קיים/ת —
            לחיצה על שם התפקיד בטבלה למטה, ואז "הקם תפקיד מההרשאות של משתמש/ת זה".
          </Typography>
        )}
      </Paper>

      {/* Deleting a role never deletes people: its holders keep the base role
          they already carry, which is what `role` in the database has been all
          along. */}
      <Dialog open={Boolean(deleteRole)} onClose={() => setDeleteRole(null)} maxWidth="xs" fullWidth dir="rtl">
        <DialogTitle>מחיקת התפקיד "{deleteRole?.name}"</DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            המשתמשים יחזרו לתפקיד הבסיס
            {deleteRole ? ` (${ROLE_LABELS[deleteRole.base_role] || deleteRole.base_role})` : ''}
            {deleteRole?.user_count ? ` — ${deleteRole.user_count} משתמשים` : ''}.
            ההרשאות שהתפקיד הוסיף להם ייעלמו בהתחברות הבאה.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteRole(null)}>ביטול</Button>
          <Button color="error" variant="contained" onClick={confirmDeleteRole}>מחק תפקיד</Button>
        </DialogActions>
      </Dialog>

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
        שינוי הרשאות נכנס לתוקף אחרי שהמשתמש/ת מתנתק/ת ומתחבר/ת מחדש.
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
                        <Tooltip title={customRoleOf(user, customRoles)
                          ? `תפקיד מותאם על בסיס ${ROLE_LABELS[user.role] || user.role} — לחץ לעריכת תפקיד וסניפים מנוהלים`
                          : 'לחץ לעריכת תפקיד וסניפים מנוהלים'}>
                          <Chip
                            size="small"
                            label={roleLabelOf(user, customRoles)}
                            onClick={() => setRoleDialog({ open: true, user })}
                            icon={<AdminPanelSettingsIcon sx={{ fontSize: 14 }} />}
                            color={customRoleOf(user, customRoles) ? 'secondary'
                              : user.role === 'branch_manager' ? 'primary'
                                : user.role === 'system_admin' ? 'error' : 'default'}
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
        customRoles={customRoles}
        onClose={() => setRoleDialog({ open: false, user: null })}
        onSaved={(fresh) => setUsers(prev => prev.map(u => u._id === fresh._id ? { ...u, ...fresh } : u))}
        onRoleCreated={(role, fresh) => {
          setCustomRoles(prev => [...prev.filter(r => String(r._id) !== String(role._id)), role]
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he')));
          setUsers(prev => prev.map(u => u._id === fresh._id ? { ...u, ...fresh } : u));
          // Her per-user overrides ARE the role now — drop any half-finished
          // edit of them, or the next save would write them straight back.
          setEdits(prev => { const n = { ...prev }; delete n[fresh._id]; return n; });
        }}
      />
    </Box>
  );
}
