import { useCallback, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Button, Box, Stack, MenuItem, Menu, Select, IconButton, Tooltip,
  Chip, Divider, Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText,
  ListSubheader, useMediaQuery, useTheme,
} from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
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
import HandymanIcon from '@mui/icons-material/Handyman';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import CelebrationIcon from '@mui/icons-material/Celebration';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api/client';
import DeleteAccountRequest from '../shared/DeleteAccountRequest';
import { TAB_GROUPS, hasTabAccess } from '../../config/tabs';
import { ganMarkerByName } from '../../utils/branchColors';

const ICON_BY_TAB = {
  dashboard: DashboardIcon,
  registrations: PersonAddIcon,
  collections: ReceiptLongIcon,
  pricing: PriceChangeIcon,
  archive: ArchiveIcon,
  employees: PeopleIcon,
  attendance: FingerprintIcon,
  salary_table: PaymentsIcon,
  payslip_audit: ReceiptLongIcon,
  holidays: EventIcon,
  parent_supply_list: Inventory2Icon,
  employee_requests: AssignmentIcon,
  orders: ShoppingCartIcon,
  stock: Inventory2Icon,
  suppliers: LocalShippingIcon,
  gantt: CalendarMonthIcon,
  classes: EventIcon,
  events: CelebrationIcon,
  leads: PersonAddIcon,
  recruitment: PersonSearchIcon,
  maintenance: HandymanIcon,
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
  const [navMenu, setNavMenu] = useState(null); // { anchorEl, group } — open category dropdown
  const { branches, selectedBranch, changeBranch } = useBranch();
  const { user, logout, isAdmin, canSeeAllBranches } = useAuth();
  // Selected gan marker colour — drives the branch switcher's own colour so
  // the switcher always shows the current gan's colour (synced with payroll).
  const selectedBranchObj = branches.find(b => (b._id || b.id) === selectedBranch);
  const selectedMarker = selectedBranchObj ? ganMarkerByName(selectedBranchObj.name) : null;

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

          {branches.length > 0 && (canSeeAllBranches || branches.length > 1) && (
            <Select
              value={selectedBranch}
              onChange={(e) => { changeBranch(e.target.value); window.location.reload(); }}
              size="small"
              variant="outlined"
              sx={{
                minWidth: { xs: 100, md: 140 }, fontWeight: 800, fontSize: '0.8rem',
                bgcolor: selectedMarker?.strip || '#f8fafc',
                color: selectedMarker?.stripText || 'text.primary',
                borderRadius: 2,
                display: { xs: 'none', md: 'flex' },
                '& .MuiSelect-select': { py: 0.5, px: 1.5 },
                '& .MuiSvgIcon-root': { color: selectedMarker?.stripText || 'text.primary' },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: selectedMarker?.accent || '#e2e8f0' },
              }}
            >
              {branches.map((b) => {
                const mk = ganMarkerByName(b.name);
                return (
                  <MenuItem key={b._id || b.id} value={b._id || b.id} sx={{ fontWeight: 700 }}>
                    <Box component="span" sx={{ width: 11, height: 11, borderRadius: '3px', bgcolor: mk?.strip || 'grey.400', mr: 1, ml: 0.5, display: 'inline-block', flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                    {b.name}
                  </MenuItem>
                );
              })}
              {canSeeAllBranches && branches.length > 1 && [
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

        {/* Center/Left: Nav category dropdowns (desktop only). One button per
            group keeps the bar compact; the group opens a menu of its tabs. */}
        <Stack direction="row" alignItems="center" spacing={0.3} sx={{ display: { xs: 'none', md: 'flex' } }}>
          {TAB_GROUPS.map((group) => {
            const visibleItems = group.items.filter(item => hasTabAccess(user, item.id));
            if (visibleItems.length === 0) return null;
            const groupActive = visibleItems.some(it => location.pathname === it.path);
            const open = navMenu?.group === group.label;
            return (
              <Box key={group.label}>
                <Button
                  size="small"
                  onClick={(e) => setNavMenu({ anchorEl: e.currentTarget, group: group.label })}
                  endIcon={<KeyboardArrowDownIcon sx={{ fontSize: '1.1rem !important' }} />}
                  sx={{
                    color: groupActive ? 'primary.dark' : 'text.secondary',
                    bgcolor: groupActive ? 'warning.light' : 'transparent',
                    fontWeight: groupActive ? 800 : 600,
                    borderRadius: 2, px: 1.3, py: 0.5, mx: 0.1,
                    fontSize: '0.82rem', minWidth: 'auto',
                    '&:hover': { bgcolor: groupActive ? 'warning.light' : '#f1f5f9' },
                    '& .MuiButton-endIcon': { ml: 0.3, mr: -0.3 },
                  }}
                >
                  {group.label}
                </Button>
                <Menu
                  anchorEl={navMenu?.anchorEl}
                  open={!!open}
                  onClose={() => setNavMenu(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  MenuListProps={{ dense: true }}
                >
                  {visibleItems.map(item => {
                    const Icon = ICON_BY_TAB[item.id] || DashboardIcon;
                    const isActive = location.pathname === item.path;
                    return (
                      <MenuItem key={item.path} selected={isActive}
                        onClick={() => { navigate(item.path); setNavMenu(null); }}
                        sx={{ gap: 1.2, fontSize: '0.85rem', fontWeight: isActive ? 700 : 500, minHeight: 40, minWidth: 170 }}
                      >
                        <Icon sx={{ fontSize: '1.15rem', color: isActive ? 'primary.main' : 'text.secondary' }} />
                        {item.label}
                      </MenuItem>
                    );
                  })}
                </Menu>
              </Box>
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
              {isAdmin && (
                <Tooltip title="המנוי שלי">
                  <IconButton size="small" onClick={() => navigate('/account')} sx={{ color: '#1E9E6A' }}>
                    <ReceiptLongIcon sx={{ fontSize: '1rem' }} />
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

          {branches.length > 0 && (canSeeAllBranches || branches.length > 1) && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>סניף</Typography>
              <Select
                value={selectedBranch}
                onChange={(e) => { changeBranch(e.target.value); window.location.reload(); }}
                size="small" fullWidth
                sx={{
                  mt: 0.5, fontWeight: 800,
                  bgcolor: selectedMarker?.strip || '#fff',
                  color: selectedMarker?.stripText || 'text.primary',
                  '& .MuiSvgIcon-root': { color: selectedMarker?.stripText || 'text.primary' },
                }}
              >
                {branches.map((b) => {
                  const mk = ganMarkerByName(b.name);
                  return (
                    <MenuItem key={b._id || b.id} value={b._id || b.id} sx={{ fontWeight: 700 }}>
                      <Box component="span" sx={{ width: 11, height: 11, borderRadius: '3px', bgcolor: mk?.strip || 'grey.400', mr: 1, ml: 0.5, display: 'inline-block', flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
                      {b.name}
                    </MenuItem>
                  );
                })}
                {canSeeAllBranches && branches.length > 1 && [
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
              <ListItemButton onClick={() => goto('/account')} sx={{ minHeight: 48 }}>
                <ListItemIcon sx={{ minWidth: 40, color: '#1E9E6A' }}><ReceiptLongIcon /></ListItemIcon>
                <ListItemText primary="המנוי שלי" />
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
          <ListItem disablePadding>
            <DeleteAccountRequest client={api} />
          </ListItem>
        </List>
      </Drawer>
    </AppBar>
  );
}
