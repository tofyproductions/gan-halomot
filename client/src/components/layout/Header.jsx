import { useCallback } from 'react';
import { AppBar, Toolbar, Typography, Button, Box, Stack, MenuItem, Select, IconButton, Tooltip, Chip, Divider } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
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
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api/client';

const EMPLOYEE_ROLES = ['teacher', 'assistant', 'class_leader', 'cook'];

const NAV_GROUPS = [
  {
    label: 'ניהול',
    items: [
      { label: 'לוח בקרה', path: '/', icon: DashboardIcon, roles: null },
      { label: 'רישום', path: '/registrations', icon: PersonAddIcon, roles: ['system_admin', 'branch_manager'] },
      { label: 'גבייה', path: '/collections', icon: ReceiptLongIcon, roles: ['system_admin', 'accountant'] },
      { label: 'ארכיון', path: '/archive', icon: ArchiveIcon, roles: ['system_admin', 'branch_manager'] },
    ],
  },
  {
    label: 'כוח אדם',
    items: [
      { label: 'עובדים', path: '/employees', icon: PeopleIcon, roles: ['system_admin', 'branch_manager'] },
      { label: 'החתמות', path: '/attendance', icon: FingerprintIcon, roles: ['system_admin', 'branch_manager'] },
      { label: 'שכר', path: '/salary-table', icon: PaymentsIcon, roles: ['system_admin', 'accountant'] },
      { label: 'חופשות', path: '/holidays', icon: EventIcon, roles: ['system_admin', 'branch_manager'] },
      { label: 'בקשות', path: '/employee-requests', icon: AssignmentIcon, roles: ['system_admin', 'branch_manager'] },
    ],
  },
  {
    label: 'תפעול',
    items: [
      { label: 'הזמנות', path: '/orders', icon: ShoppingCartIcon, roles: ['system_admin', 'branch_manager', 'class_leader'] },
      { label: 'ספקים', path: '/suppliers', icon: LocalShippingIcon, roles: ['system_admin', 'accountant'] },
      { label: 'גאנט', path: '/gantt', icon: CalendarMonthIcon, roles: ['system_admin', 'branch_manager', 'class_leader'] },
      { label: 'דף קשר', path: '/contacts', icon: ContactsIcon, roles: null },
    ],
  },
  {
    label: 'האזור שלי',
    items: [
      { label: 'צפי השכר שלי', path: '/my-salary', icon: AccountBalanceIcon, roles: EMPLOYEE_ROLES },
      { label: 'התלושים שלי', path: '/my-payslips', icon: DescriptionIcon, roles: EMPLOYEE_ROLES },
      { label: 'המסמכים שלי', path: '/my-documents', icon: DescriptionIcon, roles: EMPLOYEE_ROLES },
      { label: 'ההחתמות שלי', path: '/my-attendance', icon: AccessTimeIcon, roles: EMPLOYEE_ROLES },
      { label: 'עדכונים', path: '/my-updates', icon: NotificationsIcon, roles: EMPLOYEE_ROLES },
    ],
  },
];

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { branches, selectedBranch, changeBranch } = useBranch();
  const { user, logout, isAdmin } = useAuth();

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
        minHeight: { xs: 52, sm: 56 },
        px: { xs: 1, sm: 2 },
      }}>
        {/* Right: Logo + Branch */}
        <Stack direction="row" alignItems="center" spacing={1.5}>
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
                minWidth: 140, fontWeight: 700, fontSize: '0.8rem',
                bgcolor: '#f8fafc', borderRadius: 2,
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
              <IconButton size="small" onClick={() => navigate('/branches')} sx={{ color: 'text.secondary' }}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>

        {/* Center/Left: Nav Groups */}
        <Stack direction="row" alignItems="center" spacing={0}>
          {NAV_GROUPS.map((group, gi) => {
            const visibleItems = group.items.filter(item =>
              !item.roles || item.roles.includes(user?.role)
            );
            if (visibleItems.length === 0) return null;
            return (
              <Stack key={group.label} direction="row" alignItems="center" spacing={0}>
                {gi > 0 && (
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5, borderColor: '#e2e8f0' }} />
                )}
                {visibleItems.map(item => {
                  const Icon = item.icon;
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
      </Toolbar>
    </AppBar>
  );
}
