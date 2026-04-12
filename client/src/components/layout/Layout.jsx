import { Outlet } from 'react-router-dom';
import { Box } from '@mui/material';
import Header from './Header';

export default function Layout() {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Header />
      <Box sx={{ maxWidth: 1200, mx: 'auto', px: 2, py: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
