import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Box, Stack, Button } from '@mui/material';
import ParentPortal from '../src/components/parent-portal/ParentPortal';
import { PARENT_TOKEN_KEY } from './mockParentClient';

// The portal bounces to /parents/login without one.
localStorage.setItem(PARENT_TOKEN_KEY, 'preview');

/**
 * One phone at a time, not two side by side: the colour preference lives in
 * localStorage, which both copies would share and overwrite for each other.
 */
function App() {
  const [mode, setMode] = useState('light');
  const pick = (m) => {
    if (m === 'auto') localStorage.removeItem('gan_parent_theme');
    else localStorage.setItem('gan_parent_theme', m);
    setMode(m);
  };
  return (
    <Box sx={{ p: 2, fontFamily: 'system-ui', bgcolor: '#EFEDEA', minHeight: '100vh' }}>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        {['light', 'dark', 'auto'].map(m => (
          <Button key={m} variant={mode === m ? 'contained' : 'outlined'} onClick={() => pick(m)}>
            {m}
          </Button>
        ))}
      </Stack>
      <Box sx={{ width: 400, height: 880, overflow: 'hidden', borderRadius: '30px',
                 border: '10px solid #1a1a1a', boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
        <Box sx={{ width: '100%', height: '100%', overflowY: 'auto' }}>
          <MemoryRouter key={mode} initialEntries={['/parents']}>
            <ParentPortal />
          </MemoryRouter>
        </Box>
      </Box>
    </Box>
  );
}
createRoot(document.getElementById('root')).render(<App />);
