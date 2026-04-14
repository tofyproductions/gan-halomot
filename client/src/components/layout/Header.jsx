import { AppBar, Toolbar, Typography, Button, Box, Stack, MenuItem, Select, IconButton, Tooltip } from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import SettingsIcon from '@mui/icons-material/Settings';
import { useBranch } from '../../hooks/useBranch';

const NAV_ITEMS = [
  { label: 'לוח בקרה', path: '/', icon: '🏠' },
  { label: 'רישום חדש', path: '/new-registration', icon: '+' },
  { label: 'מעקב גבייה', path: '/collections', icon: '💰' },
  { label: 'ארכיון', path: '/archive', icon: '📜' },
  { label: 'דף קשר', path: '/contacts', icon: '📇' },
  { label: 'הזמנות', path: '/orders', icon: '🛒' },
];

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { branches, selectedBranch, changeBranch } = useBranch();

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
          {branches.length > 0 && (
            <Select
              value={selectedBranch}
              onChange={(e) => {
                changeBranch(e.target.value);
                // Reload current page data
                window.location.reload();
              }}
              size="small"
              variant="outlined"
              sx={{
                minWidth: 160,
                fontWeight: 700,
                fontSize: '0.85rem',
                bgcolor: '#f8fafc',
                borderRadius: 2,
                '& .MuiSelect-select': { py: 0.5 },
              }}
            >
              {branches.map((b) => (
                <MenuItem key={b._id || b.id} value={b._id || b.id}>
                  {b.name}
                </MenuItem>
              ))}
            </Select>
          )}

          <Tooltip title="ניהול סניפים">
            <IconButton size="small" onClick={() => navigate('/branches')} sx={{ color: 'text.secondary' }}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Stack direction="row" spacing={1}>
          {NAV_ITEMS.map(item => (
            <Button
              key={item.path}
              size="small"
              onClick={() => navigate(item.path)}
              sx={{
                color: location.pathname === item.path ? 'primary.main' : 'text.secondary',
                fontWeight: location.pathname === item.path ? 800 : 600,
                borderBottom: location.pathname === item.path ? '2px solid' : 'none',
                borderColor: 'primary.main',
                borderRadius: 0,
                px: 1.5,
                fontSize: '0.85rem',
              }}
            >
              {item.icon} {item.label}
            </Button>
          ))}
        </Stack>
      </Toolbar>
    </AppBar>
  );
}
