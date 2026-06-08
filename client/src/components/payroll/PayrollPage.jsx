import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Tabs, Tab, Paper, Typography, Badge } from '@mui/material';
import TableChartIcon from '@mui/icons-material/TableChart';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import RequestPageIcon from '@mui/icons-material/RequestPage';
import SettingsIcon from '@mui/icons-material/Settings';
import LegendToggleIcon from '@mui/icons-material/LegendToggle';
import EventNoteIcon from '@mui/icons-material/EventNote';
import RuleFolderIcon from '@mui/icons-material/RuleFolder';
import PayrollMonthTable from './PayrollMonthTable';
import PayslipAudit from './PayslipAudit';
import SalaryTable from './SalaryTable';
import SalaryRequests from '../employees/SalaryRequests';
import PayrollSettings from './PayrollSettings';
import CommitmentsManager from './CommitmentsManager';
import PayrollChangeRequests from './PayrollChangeRequests';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';

/**
 * Parent "שכר" page — internal tabs combine the monthly payroll table,
 * the existing salary summary, the payslip-audit tool, raise requests,
 * and the settings panel (presets + amuta-branch mapping).
 */

const TABS = [
  { id: 'monthly',     label: 'טבלה חודשית', icon: <TableChartIcon fontSize="small" />, component: PayrollMonthTable, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'commitments', label: 'התחייבויות',  icon: <EventNoteIcon fontSize="small" />, component: CommitmentsManager, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'summary',     label: 'סיכום קליל',  icon: <LegendToggleIcon fontSize="small" />, component: SalaryTable, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'change-requests', label: 'בקשות שינוי', icon: <RuleFolderIcon fontSize="small" />, component: PayrollChangeRequests, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'audit',       label: 'ביקורת תלושים', icon: <FactCheckIcon fontSize="small" />, component: PayslipAudit, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'raises',      label: 'בקשות העלאה', icon: <RequestPageIcon fontSize="small" />, component: SalaryRequests, roles: ['system_admin', 'branch_manager'] },
  { id: 'settings',    label: 'הגדרות',      icon: <SettingsIcon fontSize="small" />, component: PayrollSettings, roles: ['system_admin'] },
];

export default function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const { isAdmin, isAccountant } = useAuth();
  const initial = params.get('tab') || 'monthly';
  const [tab, setTab] = useState(initial);
  const [pendingCount, setPendingCount] = useState(0);

  // Poll the pending change-request count so reviewers see a badge.
  useEffect(() => {
    if (!(isAdmin || isAccountant)) return;
    let alive = true;
    const load = () => api.get('/payroll-month/change-requests', { params: { status: 'pending' } })
      .then(res => { if (alive) setPendingCount(res.data.pending_count || 0); })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isAdmin, isAccountant, tab]);

  const ActiveComponent = useMemo(() => TABS.find(t => t.id === tab)?.component || PayrollMonthTable, [tab]);

  const handleChange = (_, newTab) => {
    setTab(newTab);
    const next = new URLSearchParams(params);
    next.set('tab', newTab);
    setParams(next, { replace: true });
  };

  return (
    <Box dir="rtl">
      <Paper dir="rtl" sx={{ borderRadius: 3, mb: 2, overflow: 'hidden' }} elevation={0} variant="outlined">
        <Box sx={{ px: 2, pt: 1.5, pb: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>שכר</Typography>
        </Box>
        <Tabs
          value={tab}
          onChange={handleChange}
          variant="scrollable"
          scrollButtons="auto"
          dir="rtl"
          sx={{
            borderBottom: 1, borderColor: 'divider',
          }}
        >
          {TABS.map(t => (
            <Tab
              key={t.id}
              value={t.id}
              label={
                t.id === 'change-requests' && pendingCount > 0 ? (
                  <Badge badgeContent={pendingCount} color="error" sx={{ '& .MuiBadge-badge': { right: -14, top: 2 } }}>
                    {t.label}
                  </Badge>
                ) : t.label
              }
              icon={t.icon}
              iconPosition="start"
              sx={{ minHeight: 48, fontWeight: 600 }}
            />
          ))}
        </Tabs>
      </Paper>

      <ActiveComponent />
    </Box>
  );
}
