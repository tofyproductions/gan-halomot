import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Box, Tabs, Tab } from '@mui/material';
import api, { apiError } from '../../api/client';
import PageHeader from '../ui/PageHeader';
import { useAuth } from '../../hooks/useAuth';
import { hasTabAccess } from '../../config/tabs';
import KaplanTab from './KaplanTab';
import ClickTacTab from './ClickTacTab';
import EmunahTab from './EmunahTab';
import IncomeToolsTab from './IncomeToolsTab';

const VIEWS = ['kaplan', 'clicktac', 'emunah', 'tools'];

/**
 * הכנסות — finance part 3 (docs/superpowers/specs/2026-10-01-income-design.md):
 * Kaplan parents' bank transfers ↔ families, the ClickTac monthly debt report,
 * and Emunah's settlement. Read-only beside the collections table — nothing
 * here writes it. Writes need `income_write`; admin_viewer reads everything.
 */
export default function IncomePage() {
  const { user } = useAuth();
  const canWrite = hasTabAccess(user, 'income_write');
  const [params, setParams] = useSearchParams();
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'kaplan';
  const [branches, setBranches] = useState([]);

  useEffect(() => {
    let alive = true;
    api.get('/branches')
      .then(res => { if (alive) setBranches(res.data.branches || []); })
      .catch(err => { if (alive) toast.error(apiError(err, 'לא הצלחנו לטעון את רשימת הסניפים')); });
    return () => { alive = false; };
  }, []);

  const setView = (v) => setParams(p => { const n = new URLSearchParams(p); n.set('view', v); return n; }, { replace: true });

  return (
    <Box dir="rtl" sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: 'auto' }}>
      <PageHeader
        title="הכנסות"
        meta={['העברות הורים בקפלן מול הבנק · דוח קליקטאק · התחשבנות עם אמונה', canWrite ? null : 'צפייה בלבד']}
      />
      <Tabs value={view} onChange={(_e, v) => setView(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
        sx={{ mb: 2, minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
        <Tab value="kaplan" label="🏦 קפלן" />
        <Tab value="clicktac" label="📋 קליקטאק" />
        <Tab value="emunah" label="🤝 אמונה" />
        <Tab value="tools" label="⚙️ כללים" />
      </Tabs>
      <Box key={view}>
        {view === 'kaplan' && <KaplanTab canWrite={canWrite} />}
        {view === 'clicktac' && <ClickTacTab branches={branches} canWrite={canWrite} />}
        {view === 'emunah' && <EmunahTab canWrite={canWrite} />}
        {view === 'tools' && <IncomeToolsTab canWrite={canWrite} />}
      </Box>
    </Box>
  );
}
