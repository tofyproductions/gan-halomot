import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Tabs, Tab, Paper, Typography } from '@mui/material';
import TableChartIcon from '@mui/icons-material/TableChart';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import RequestPageIcon from '@mui/icons-material/RequestPage';
import SettingsIcon from '@mui/icons-material/Settings';
import LegendToggleIcon from '@mui/icons-material/LegendToggle';
import EventNoteIcon from '@mui/icons-material/EventNote';
import PayrollMonthTable from './PayrollMonthTable';
import PayslipAudit from './PayslipAudit';
import SalaryTable from './SalaryTable';
import SalaryRequests from '../employees/SalaryRequests';
import PayrollSettings from './PayrollSettings';
import CommitmentsManager from './CommitmentsManager';

/**
 * Parent "שכר" page — internal tabs combine the monthly payroll table,
 * the existing salary summary, the payslip-audit tool, raise requests,
 * and the settings panel (presets + amuta-branch mapping).
 */

const TABS = [
  { id: 'monthly',     label: 'טבלה חודשית', icon: <TableChartIcon fontSize="small" />, component: PayrollMonthTable, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'commitments', label: 'התחייבויות',  icon: <EventNoteIcon fontSize="small" />, component: CommitmentsManager, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'summary',     label: 'סיכום קליל',  icon: <LegendToggleIcon fontSize="small" />, component: SalaryTable, roles: ['system_admin', 'accountant', 'branch_manager'] },
  { id: 'audit',       label: 'ביקורת תלושים', icon: <FactCheckIcon fontSize="small" />, component: PayslipAudit, roles: ['system_admin', 'branch_manager'] },
  { id: 'raises',      label: 'בקשות העלאה', icon: <RequestPageIcon fontSize="small" />, component: SalaryRequests, roles: ['system_admin', 'branch_manager'] },
  { id: 'settings',    label: 'הגדרות',      icon: <SettingsIcon fontSize="small" />, component: PayrollSettings, roles: ['system_admin'] },
];

export default function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('tab') || 'monthly';
  const [tab, setTab] = useState(initial);

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
              label={t.label}
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
