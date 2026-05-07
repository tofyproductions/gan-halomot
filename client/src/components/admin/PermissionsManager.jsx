import { useState, useEffect, useMemo } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, IconButton, Tooltip, Alert,
  Table, TableHead, TableBody, TableRow, TableCell, Checkbox,
  TextField, MenuItem, Button, CircularProgress, Divider,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import { TAB_GROUPS, ALL_TABS, isDefaultAllowed } from '../../config/tabs';
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
// On save we diff against role default to compute add/remove arrays.
function computeOverrides(user, allowedMap) {
  const add = [];
  const remove = [];
  for (const tab of ALL_TABS) {
    const allowed = !!allowedMap[tab.id];
    const def = isDefaultAllowed(user, tab);
    if (allowed && !def) add.push(tab.id);
    if (!allowed && def) remove.push(tab.id);
  }
  return { add, remove };
}

function effectiveMap(user) {
  const m = {};
  for (const tab of ALL_TABS) {
    const def = isDefaultAllowed(user, tab);
    let allowed = def;
    if ((user.tab_overrides_add || []).includes(tab.id)) allowed = true;
    if ((user.tab_overrides_remove || []).includes(tab.id)) allowed = false;
    m[tab.id] = allowed;
  }
  return m;
}

export default function PermissionsManager() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [edits, setEdits] = useState({}); // userId -> { tabId -> bool }
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get('/admin/users');
      setUsers(res.data.users || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בטעינת משתמשים');
    } finally {
      setLoading(false);
    }
  }

  function getCellValue(user, tabId) {
    const userEdits = edits[user._id];
    if (userEdits && tabId in userEdits) return userEdits[tabId];
    return effectiveMap(user)[tabId];
  }

  function isCellOverride(user, tabId) {
    const value = getCellValue(user, tabId);
    const def = isDefaultAllowed(user, ALL_TABS.find(t => t.id === tabId));
    return value !== def;
  }

  function isUserDirty(user) {
    const userEdits = edits[user._id];
    if (!userEdits) return false;
    const eff = effectiveMap(user);
    return Object.entries(userEdits).some(([k, v]) => eff[k] !== v);
  }

  function toggle(userId, tabId) {
    setEdits(prev => {
      const userEdits = { ...(prev[userId] || {}) };
      const user = users.find(u => u._id === userId);
      const current = (tabId in userEdits) ? userEdits[tabId] : effectiveMap(user)[tabId];
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

  async function saveUser(user) {
    const eff = effectiveMap(user);
    const userEdits = edits[user._id] || {};
    const merged = { ...eff, ...userEdits };
    const { add, remove } = computeOverrides(user, merged);
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

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  return (
    <Box sx={{ p: { xs: 1, md: 3 } }}>
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
              <TableCell sx={{ fontWeight: 800, bgcolor: '#f8fafc', position: 'sticky', right: 0, zIndex: 2, minWidth: 220 }}>
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
                  <TableCell sx={{ position: 'sticky', right: 0, zIndex: 1, bgcolor: dirty ? '#fef3c7' : '#fff' }}>
                    <Stack spacing={0.3}>
                      <Box sx={{ fontWeight: 700, fontSize: '0.85rem' }}>{user.full_name || user.email}</Box>
                      <Stack direction="row" spacing={0.5}>
                        <Chip size="small" label={ROLE_LABELS[user.role] || user.role} sx={{ fontSize: '0.65rem', height: 18 }} />
                        {user.branch_id?.name && (
                          <Chip size="small" variant="outlined" label={user.branch_id.name} sx={{ fontSize: '0.65rem', height: 18 }} />
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
        סה"כ {filteredUsers.length} משתמשים. ניתן לסנן לפי שם, אימייל ותפקיד.
      </Typography>
    </Box>
  );
}
