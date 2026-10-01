import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Box, Tabs, Tab, TextField, MenuItem, Stack, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import api, { apiError } from '../../api/client';
import PageHeader from '../ui/PageHeader';
import { useAuth } from '../../hooks/useAuth';
import { hasTabAccess } from '../../config/tabs';
import { isViewerRole } from '../../hooks/roleFlags';
import { GENERAL, NO_BRANCH } from './expenseFormat';
import PairTab from './PairTab';
import ReceiptsTab from './ReceiptsTab';
import ClosedTab from './ClosedTab';
import SearchTab from './SearchTab';
import ToolsTab from './ToolsTab';
import DocumentDialog from './DocumentDialog';

const VIEWS = ['pair', 'receipts', 'closed', 'search', 'tools'];

function TabLabel({ text, count, color }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <span>{text}</span>
      {count > 0 && <Chip size="small" label={count} color={color || 'default'} sx={{ height: 20, fontSize: '0.75rem' }} />}
    </Stack>
  );
}

/**
 * הוצאות — supplier documents paired with the bank/card charges that paid
 * them (spec §10). Five tabs; counts from one `/counts` call, refreshed after
 * every action. Writes need `expenses_write`; admin_viewer reads everything.
 */
export default function ExpensesPage() {
  const { user } = useAuth();
  const canWrite = hasTabAccess(user, 'expenses_write');
  // Filing to iCount / reporting paid: its own grant; the server refuses admin_viewer outright, so no buttons for it.
  const canFile = hasTabAccess(user, 'icount_upload') && !isViewerRole(user);
  const [params, setParams] = useSearchParams();
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'pair';

  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState([]);
  const [counts, setCounts] = useState(null);
  const [tick, setTick] = useState(0);
  const [docOpen, setDocOpen] = useState(false);
  const countSeq = useRef(0);

  // Counts are badges, not content: a failure is a toast, never an empty tab.
  const loadCounts = useCallback(async () => {
    const my = ++countSeq.current;
    try {
      const { data } = await api.get('/expenses/counts');
      if (my === countSeq.current) setCounts(data);
    } catch (err) {
      if (my === countSeq.current) { setCounts(null); toast.error(apiError(err, 'לא הצלחנו לטעון את המונים')); }
    }
  }, []);

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => {
    let alive = true;
    api.get('/branches')
      .then(res => { if (alive) setBranches(res.data.branches || []); })
      .catch(err => { if (alive) toast.error(apiError(err, 'לא הצלחנו לטעון את רשימת הסניפים')); });
    return () => { alive = false; };
  }, []);

  const setView = (v) => setParams(p => { const n = new URLSearchParams(p); n.set('view', v); return n; }, { replace: true });

  // After a new document the visible tab reloads (remount) and the badges refresh.
  const afterDocument = () => { setTick(t => t + 1); loadCounts(); };

  const tabProps = { branch, branches, canWrite, onChanged: loadCounts };
  const c = counts || {};

  return (
    <Box dir="rtl" sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: 'auto' }}>
      <PageHeader
        title="הוצאות"
        meta={[
          'מסמכי ספקים מול החיובים בבנק ובכרטיסים',
          c.review ? { label: `${c.review} מסמכים לבדיקת קריאה`, strong: true } : null,
        ]}
        primary={canWrite ? { label: 'מסמך', icon: <AddIcon />, onClick: () => setDocOpen(true) } : null}
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 2 }}>
        <Tabs value={view} onChange={(_e, v) => setView(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
          sx={{ minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
          <Tab value="pair" label={<TabLabel text="🎯 לשייך" count={c.pair} color="info" />} />
          <Tab value="receipts" label={<TabLabel text="🧾 קבלות" count={c.receipts} color={c.overdue ? 'error' : 'default'} />} />
          <Tab value="closed" label={<TabLabel text="✅ סגור" count={(c.closed || 0) + (c.unpaid_marked || 0)} />} />
          <Tab value="search" label="🔎 חיפוש" />
          <Tab value="tools" label="⚙️ כלים" />
        </Tabs>
        {view !== 'tools' && view !== 'receipts' && (
          <TextField select size="small" label="סניף" value={branch} onChange={e => setBranch(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value="">כל הסניפים</MenuItem>
            <MenuItem value={GENERAL}>כללי</MenuItem>
            <MenuItem value={NO_BRANCH}>בלי סניף (לתיוג)</MenuItem>
            {branches.map(b => <MenuItem key={b._id} value={b._id}>{b.name}</MenuItem>)}
          </TextField>
        )}
      </Stack>

      <Box key={`${view}:${tick}`}>
        {view === 'pair' && <PairTab {...tabProps} />}
        {view === 'receipts' && <ReceiptsTab {...tabProps} />}
        {view === 'closed' && <ClosedTab {...tabProps} canFile={canFile} />}
        {view === 'search' && <SearchTab branch={branch} onJump={setView} />}
        {view === 'tools' && <ToolsTab canWrite={canWrite} onChanged={loadCounts} />}
      </Box>

      {canWrite && <DocumentDialog open={docOpen} onClose={() => setDocOpen(false)} onSaved={afterDocument} branches={branches} />}
    </Box>
  );
}
