import { AppBar, Toolbar, Typography, Button, Box, Stack, MenuItem, Select, IconButton, Tooltip, Chip } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import { useBranch } from '../../hooks/useBranch';
import { useAuth } from '../../hooks/useAuth';

const ALL_NAV = [
  { label: 'לוח בקרה', path: '/', icon: '🏠', roles: null },
  { label: 'רישום חדש', path: '/new-registration', icon: '+', roles: ['system_admin', 'branch_manager'] },
  { label: 'מעקב גבייה', path: '/collections', icon: '💰', roles: ['system_admin', 'branch_manager'] },
  { label: 'ארכיון', path: '/archive', icon: '📜', roles: ['system_admin', 'branch_manager'] },
  { label: 'דף קשר', path: '/contacts', icon: '📇', roles: null },
  { label: 'גאנט', path: '/gantt', icon: '📋', roles: ['system_admin', 'branch_manager', 'employee'] },
  { label: 'חופשות', path: '/holidays', icon: '📅', roles: ['system_admin', 'branch_manager'] },
  { label: 'הזמנות', path: '/orders', icon: '🛒', roles: null },
  { label: 'ספקים', path: '/suppliers', icon: '📦', roles: ['system_admin'] },
  { label: 'עובדים', path: '/employees', icon: '👥', roles: ['system_admin', 'branch_manager'] },
];

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { branches, selectedBranch, changeBranch } = useBranch();
  const { user, logout, isAdmin } = useAuth();

  const navItems = ALL_NAV.filter(item =>
    !item.roles || item.roles.includes(user?.role)
  );

  return (
    <AppBar position="sticky" sx={{
      background: 'rgba(255,255,255,0.95)',
      backdropFilter: 'blur(20px)',
      borderBottom: '3px solid',
      borderImage: 'linear-gradient(90deg, #60a5fa, #a78bfa, #f472b6, #fb923c, #fbbf24, #34d399) 1',
      boxShadow: '0 4px 20px rgba(0,0,0,0.05)',
    }}>
      <Toolbar sx={{ justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'text.primary', fontFamily: 'Varela Round' }}>
              גן החלומות
            </Typography>
          </Box>

          {/* Branch Selector */}
          {branches.length > 0 && (isAdmin ? true : branches.length > 1) && (
            <Select
              value={selectedBranch}
              onChange={(e) => { changeBranch(e.target.value); window.location.reload(); }}
              size="small"
              variant="outlined"
              sx={{
                minWidth: 150, fontWeight: 700, fontSize: '0.85rem',
                bgcolor: '#f8fafc', borderRadius: 2,
                '& .MuiSelect-select': { py: 0.5 },
              }}
            >
              {branches.map((b) => (
                <MenuItem key={b._id || b.id} value={b._id || b.id}>{b.name}</MenuItem>
              ))}
            </Select>
          )}

          {isAdmin && (
            <Tooltip title="ניהול סניפים">
              <IconButton size="small" onClick={() => navigate('/branches')} sx={{ color: 'text.secondary' }}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        <Stack direction="row" spacing={0.5} alignItems="center">
          {navItems.map(item => (
            <Button
              key={item.path}
              size="small"
              onClick={() => navigate(item.path)}
              sx={{
                color: location.pathname === item.path ? 'primary.main' : 'text.secondary',
                fontWeight: location.pathname === item.path ? 800 : 600,
                borderBottom: location.pathname === item.path ? '2px solid' : 'none',
                borderColor: 'primary.main',
                borderRadius: 0, px: 1, fontSize: '0.8rem',
              }}
            >
              {item.icon} {item.label}
            </Button>
          ))}

          {user && (
            <>
              <Chip
                label={user.full_name || user.email}
                size="small"
                variant="outlined"
                sx={{ mx: 1, fontWeight: 600 }}
              />
              <Tooltip title="התנתק">
                <IconButton size="small" onClick={logout} sx={{ color: 'text.secondary' }}>
                  <LogoutIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
        </Stack>
      </Toolbar>
    </AppBar>
  );
}
