import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline, Box, Stack, Button } from '@mui/material';
import { createParentTheme } from '../src/theme/parentTheme';
import ParentHome from '../src/components/parent-portal/ParentHome';
import Payments from '../src/components/parent-portal/Payments';
import PAY from './mockParentClient';

const PHOTOS = [1, 2, 3, 4].map(i => ({
  id: String(i),
  thumb_url: `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${['#E9A860','#8FBF9E','#B9A7D6','#F3C86A'][i-1]}"/><stop offset="1" stop-color="${['#C4682C','#4A7C59','#6C63B5','#DC8B3A'][i-1]}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><circle cx="70" cy="70" r="26" fill="rgba(255,255,255,.5)"/></svg>`
  )}`,
}));

function Screen({ mode, nursery, view }) {
  const theme = createParentTheme(mode);
  return (
    <ThemeProvider theme={theme}>
      <Box sx={{ bgcolor: 'background.default', color: 'text.primary', p: 2, width: 380, borderRadius: 3, border: 1, borderColor: 'divider' }}>
        <Box sx={{ fontSize: 12, opacity: .6, mb: 1 }}>{mode} · {view} · {nursery ? 'תינוקייה' : 'גן'}</Box>
        {view === 'home'
          ? <ParentHome childId="c1" childName="יהלי" isNursery={nursery} photos={PHOTOS} payments={PAY_DATA} onOpen={() => {}} />
          : <Payments childId="c1" />}
      </Box>
    </ThemeProvider>
  );
}

// the same payload the mock client serves
const PAY_DATA = await PAY.get('/payments').then(r => r.data);

function App() {
  const [nursery, setNursery] = useState(true);
  const [view, setView] = useState('home');
  return (
    <Box sx={{ p: 2, fontFamily: 'system-ui' }}>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button variant="outlined" onClick={() => setNursery(v => !v)}>
          {nursery ? 'תינוקייה' : 'גן'}
        </Button>
        <Button variant="outlined" onClick={() => setView(v => (v === 'home' ? 'payments' : 'home'))}>
          {view === 'home' ? 'מסך בית' : 'תשלומים'}
        </Button>
      </Stack>
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <Screen mode="light" nursery={nursery} view={view} />
        <Screen mode="dark" nursery={nursery} view={view} />
      </Stack>
    </Box>
  );
}
createRoot(document.getElementById('root')).render(<App />);
