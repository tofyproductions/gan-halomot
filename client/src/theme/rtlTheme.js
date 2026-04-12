import { createTheme } from '@mui/material/styles';
import createCache from '@emotion/cache';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';

export const cacheRtl = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin],
});

const theme = createTheme({
  direction: 'rtl',
  typography: {
    fontFamily: '"Assistant", "Varela Round", "Heebo", sans-serif',
    h1: { fontFamily: '"Varela Round", sans-serif', fontWeight: 900 },
    h2: { fontFamily: '"Varela Round", sans-serif', fontWeight: 800 },
    h3: { fontWeight: 700 },
    button: { fontWeight: 700 },
  },
  palette: {
    primary: { main: '#f59e0b', light: '#fbbf24', dark: '#d97706', contrastText: '#1e293b' },
    secondary: { main: '#0ea5e9', light: '#38bdf8', dark: '#0284c7' },
    success: { main: '#10b981' },
    error: { main: '#ef4444' },
    background: { default: '#f1f5f9', paper: '#ffffff' },
    text: { primary: '#1e293b', secondary: '#64748b' },
  },
  shape: { borderRadius: 16 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 50, textTransform: 'none', fontWeight: 700, padding: '10px 24px' },
        containedPrimary: {
          background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
          boxShadow: '0 4px 6px -1px rgba(245,158,11,0.3)',
          '&:hover': { background: 'linear-gradient(135deg, #f59e0b, #d97706)', transform: 'translateY(-2px)' },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { borderRadius: 24, boxShadow: '0 10px 30px -5px rgba(0,0,0,0.05)' },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: { '& .MuiOutlinedInput-root': { borderRadius: 16 } },
      },
    },
  },
});

export default theme;
