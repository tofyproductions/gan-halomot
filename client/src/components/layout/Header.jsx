import { useCallback, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Button, Box, Stack, MenuItem, Select, IconButton, Tooltip,
  Chip, Divider, Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText,
  ListSubheader, useMediaQuery, useTheme,
} from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ArchiveIcon from '@mui/icons-material/Archive';
import ContactsIcon from '@mui/icons-material/Contacts';
import PeopleIcon from '@mui/icons-material/People';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import PaymentsIcon from '@mui/icons-material/Payments';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import EventIcon from '@mui/icons-material/Event';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import DescriptionIcon from '@mui/icons-material/Description';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import NotificationsIcon from '@mui/icons-material/Notifications';
import AssignmentIcon from '@mui/icons-material/Assignment';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api/client';
import { TAB_GROUPS, hasTabAccess } from '../../config/tabs';

const ICON_BY_TAB = {
  dashboard: DashboardIcon,
  registrations: PersonAddIcon,
  collections: ReceiptLongIcon,
  archive: ArchiveIcon,
  employees: PeopleIcon,
  attendance: FingerprintIcon,
  salary_table: PaymentsIcon,
  holidays: EventIcon,
  employee_requests: AssignmentIcon,
  orders: ShoppingCartIcon,
  stock: Inventory2Icon,
  suppliers: LocalShippingIcon,
  gantt: CalendarMonthIcon,
  contacts: ContactsIcon,
  my_salary: AccountBalanceIcon,
  my_payslips: DescriptionIcon,
  my_documents: DescriptionIcon,
  my_attendance: AccessTimeIcon,
  my_updates: NotificationsIcon,
};

// Nav structure now lives in client/src/config/tabs.js (TAB_GROUPS).
// Icons are kept here in ICON_BY_TAB so the config file stays free of MUI imports.

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { branches, selectedBranch, changeBranch } = useBranch();
  const { user, logout, isAdmin } = useAuth();

  const goto = (path) => {
    setDrawerOpen(false);
    navigate(path);
  };

  const handleSetupBiometric = useCallback(async () => {
    try {
      const optionsRes = await api.post('/auth/webauthn/register/options');
      const credential = await startRegistration({ optionsJSON: optionsRes.data });
      await api.post('/auth/webauthn/register/verify', { credential });
      localStorage.setItem('gan_biometric_user_id', user.id);
      toast.success('כניסה ביומטרית הוגדרה בהצלחה!');
    } catch (err) {
      if (err.name === 'NotAllowedError') return;
      toast.error(err.response?.data?.error || 'שגיאה בהגדרת ביומטרי');
    }
  }, [user]);

  return (
    <AppBar position="sticky" sx={{
      background: 'rgba(255,255,255,0.97)',
      backdropFilter: 'blur(16px)',
      borderBottom: '1px solid',
      borderColor: 'divider',
      boxShadow: '0 1px 8px rgba(0,0,0,0.04)',
    }}>
      <Toolbar sx={{
        justifyContent: 'space-between',
        minHeight: { xs: 56, sm: 60 },
        px: { xs: 1, sm: 2 },
        gap: 1,
      }}>
        {/* Mobile hamburger (xs/sm only) */}
        {isMobile && (
          <IconButton
            onClick={() => setDrawerOpen(true)}
            sx={{ color: 'text.primary', mr: -0.5 }}
            aria-label="תפריט"
          >
            <MenuIcon />
          </IconButton>
        )}

        {/* Right: Logo + Branch */}
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ flex: { xs: 1, md: 'unset' }, justifyContent: { xs: 'center', md: 'flex-start' } }}>
          <Box sx={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5 }} onClick={() => navigate('/')}>
            <Box sx={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 900, fontSize: '0.85rem',
            }}>
              ג
            </Box>
            <Typography variant="h6" sx={{
              fontWeight: 800, color: 'text.primary', fontFamily: 'Varela Round',
              fontSize: '1rem', display: { xs: 'none', md: 'block' },
            }}>
              גן החלומות
            </Typography>
          </Box>

          {branches.length > 0 && (isAdmin ? true : branches.length > 1) && (
            <Select
              value={selectedBranch}
              onChange={(e) => { changeBranch(e.target.value); window.location.reload(); }}
              size="small"
              variant="outlined"
              sx={{
                minWidth: { xs: 100, md: 140 }, fontWeight: 700, fontSize: '0.8rem',
                bgcolor: '#f8fafc', borderRadius: 2,
                display: { xs: 'none', md: 'flex' },
                '& .MuiSelect-select': { py: 0.5, px: 1.5 },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: '#e2e8f0' },
              }}
            >
              {branches.map((b) => (
                <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
              ))}
              {isAdmin && branches.length > 1 && [
                <MenuItem key="__all-divider" disabled sx={{ opacity: 0.4, fontSize: '0.7rem', minHeight: 'unset', py: 0.3 }}>
                  ──────────
                </MenuItem>,
                <MenuItem key="__all" value="all" sx={{ fontWeight: 800, color: 'primary.main' }}>
                  כל הסניפים
                </MenuItem>,
              ]}
            </Select>
          )}

          {isAdmin && (
            <Tooltip title="ניהול סניפים">
              <IconButton size="small" onClick={() => navigate('/branches')} sx={{ color: 'text.secondary', display: { xs: 'none', md: 'inline-flex' } }}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>

        {/* Center/Left: Nav Groups (desktop only) */}
        <Stack direction="row" alignItems="center" spacing={0} sx={{ display: { xs: 'none', md: 'flex' } }}>
          {TAB_GROUPS.map((group, gi) => {
            const visibleItems = group.items.filter(item => hasTabAccess(user, item.id));
            if (visibleItems.length === 0) return null;
            return (
              <Stack key={group.label} direction="row" alignItems="center" spacing={0}>
                {gi > 0 && (
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5, borderColor: '#e2e8f0' }} />
                )}
                {visibleItems.map(item => {
                  const Icon = ICON_BY_TAB[item.id] || DashboardIcon;
                  const isActive = location.pathname === item.path;
                  return (
                    <Tooltip key={item.path} title={item.label}>
                      <Button
                        size="small"
                        onClick={() => navigate(item.path)}
                        startIcon={<Icon sx={{ fontSize: '1rem !important' }} />}
                        sx={{
                          color: isActive ? 'primary.dark' : 'text.secondary',
                          bgcolor: isActive ? 'warning.light' : 'transparent',
                          fontWeight: isActive ? 800 : 600,
                          borderRadius: 2,
                          px: 1.2, py: 0.5,
                          mx: 0.2,
                          fontSize: '0.78rem',
                          minWidth: 'auto',
                          '&:hover': { bgcolor: isActive ? 'warning.light' : '#f1f5f9' },
                          '& .MuiButton-startIcon': { ml: 0.5, mr: 0 },
                        }}
                      >
                        {item.label}
                      </Button>
                    </Tooltip>
                  );
                })}
              </Stack>
            );
          })}

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, borderColor: '#e2e8f0' }} />

          {user && (
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ ml: 0.5 }}>
              <Chip
                label={user.full_name || user.email}
                size="small"
                sx={{
                  fontWeight: 700, fontSize: '0.78rem',
                  bgcolor: '#f1f5f9', color: 'text.primary',
                  border: '1px solid #e2e8f0',
                }}
              />
              {isAdmin && (
                <Tooltip title="ניהול הרשאות">
                  <IconButton size="small" onClick={() => navigate('/admin/permissions')} sx={{ color: '#0ea5e9' }}>
                    <AdminPanelSettingsIcon sx={{ fontSize: '1rem' }} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="הגדר כניסה ביומטרית">
                <IconButton size="small" onClick={handleSetupBiometric} sx={{ color: '#7c3aed' }}>
                  <FingerprintIcon sx={{ fontSize: '1rem' }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="התנתק">
                <IconButton size="small" onClick={logout} sx={{ color: 'text.secondary' }}>
                  <LogoutIcon sx={{ fontSize: '1rem' }} />
                </IconButton>
              </Tooltip>
            </Stack>
          )}
        </Stack>

        {/* Mobile: quick logout icon on the left edge */}
        {isMobile && user && (
          <IconButton onClick={logout} sx={{ color: 'text.secondary', ml: -0.5 }} aria-label="התנתק">
            <LogoutIcon />
          </IconButton>
        )}
      </Toolbar>

      {/* Mobile drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{ sx: { width: { xs: '85vw', sm: 340 }, maxWidth: 360 } }}
      >
        <Box sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            <Box sx={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 900,
            }}>ג</Box>
            <Typography variant="h6" sx={{ fontWeight: 800, fontFamily: 'Varela Round', flex: 1 }}>
              גן החלומות
            </Typography>
            <IconButton onClick={() => setDrawerOpen(false)}><CloseIcon /></IconButton>
          </Stack>

          {user && (
            <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <Typography sx={{ fontWeight: 700 }}>{user.full_name || user.email}</Typography>
              {user.branch_name && (
                <Typography variant="caption" color="text.secondary">{user.branch_name}</Typography>
              )}
            </Box>
          )}

          {branches.length > 0 && (isAdmin || branches.length > 1) && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>סניף</Typography>
              <Select
                value={selectedBranch}
                onChange={(e) => { changeBranch(e.target.value); window.location.reload(); }}
                size="small" fullWidth
                sx={{ mt: 0.5, bgcolor: '#fff' }}
              >
                {branches.map((b) => (
                  <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
                ))}
                {isAdmin && branches.length > 1 && [
                  <MenuItem key="__div" disabled sx={{ opacity: 0.4, fontSize: '0.7rem', minHeight: 'unset' }}>──────────</MenuItem>,
                  <MenuItem key="__all" value="all" sx={{ fontWeight: 800, color: 'primary.main' }}>כל הסניפים</MenuItem>,
                ]}
              </Select>
            </Box>
          )}
        </Box>

        <Divider />

        <List sx={{ pt: 0 }}>
          {TAB_GROUPS.map((group) => {
            const visibleItems = group.items.filter(item => hasTabAccess(user, item.id));
            if (visibleItems.length === 0) return null;
            return (
              <Box key={group.label}>
                <ListSubheader sx={{ bgcolor: 'transparent', fontWeight: 800, color: 'text.secondary', lineHeight: '32px' }}>
                  {group.label}
                </ListSubheader>
                {visibleItems.map(item => {
                  const Icon = ICON_BY_TAB[item.id] || DashboardIcon;
                  const isActive = location.pathname === item.path;
                  return (
                    <ListItem key={item.path} disablePadding>
                      <ListItemButton
                        onClick={() => goto(item.path)}
                        sx={{
                          minHeight: 48,
                          bgcolor: isActive ? 'warning.light' : 'transparent',
                          fontWeight: isActive ? 800 : 600,
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 40, color: isActive ? 'primary.dark' : 'text.secondary' }}>
                          <Icon />
                        </ListItemIcon>
                        <ListItemText
                          primary={item.label}
                          primaryTypographyProps={{ fontWeight: isActive ? 800 : 600, fontSize: '0.95rem' }}
                        />
                      </ListItemButton>
                    </ListItem>
                  );
                })}
              </Box>
            );
          })}
        </List>

        <Divider sx={{ mt: 1 }} />

        <List>
          {isAdmin && (
            <ListItem disablePadding>
              <ListItemButton onClick={() => goto('/admin/permissions')} sx={{ minHeight: 48 }}>
                <ListItemIcon sx={{ minWidth: 40, color: '#0ea5e9' }}><AdminPanelSettingsIcon /></ListItemIcon>
                <ListItemText primary="ניהול הרשאות" />
              </ListItemButton>
            </ListItem>
          )}
          {isAdmin && (
            <ListItem disablePadding>
              <ListItemButton onClick={() => goto('/branches')} sx={{ minHeight: 48 }}>
                <ListItemIcon sx={{ minWidth: 40 }}><SettingsIcon /></ListItemIcon>
                <ListItemText primary="ניהול סניפים" />
              </ListItemButton>
            </ListItem>
          )}
          <ListItem disablePadding>
            <ListItemButton onClick={() => { setDrawerOpen(false); handleSetupBiometric(); }} sx={{ minHeight: 48 }}>
              <ListItemIcon sx={{ minWidth: 40, color: '#7c3aed' }}><FingerprintIcon /></ListItemIcon>
              <ListItemText primary="הגדר כניסה ביומטרית" />
            </ListItemButton>
          </ListItem>
          <ListItem disablePadding>
            <ListItemButton onClick={() => { setDrawerOpen(false); logout(); }} sx={{ minHeight: 48 }}>
              <ListItemIcon sx={{ minWidth: 40 }}><LogoutIcon /></ListItemIcon>
              <ListItemText primary="התנתק" />
            </ListItemButton>
          </ListItem>
        </List>
      </Drawer>
    </AppBar>
  );
}
