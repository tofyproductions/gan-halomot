import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, Card, CardContent, Tabs, Tab, Chip, Stack } from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import { toast } from 'react-toastify';
import api from '../../api/client';
import OccupancyChart from './OccupancyChart';
import { useBranch } from '../../hooks/useBranch';
import { getClassroomColor } from '../../utils/classroomColors';
import ChildDetailDialog from '../shared/ChildDetailDialog';
import StockShortageTile from './StockShortageTile';

export default function Dashboard() {
  const navigate = useNavigate();
  const { selectedBranchName } = useBranch();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [yearTab, setYearTab] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [selectedChild, setSelectedChild] = useState(null);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.post('/sync');
      toast.success(res.data.summary);
      window.location.reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בסנכרון');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.get('/dashboard/stats')
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <Typography variant="h6" sx={{ color: '#f59e0b' }}>טוען נתונים...</Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <Typography color="error">שגיאה: {error}</Typography>
        <Button onClick={() => window.location.reload()} sx={{ mt: 2 }}>נסה שוב</Button>
      </Box>
    );
  }

  const classrooms = data?.classrooms || {};
  const pendingLeads = data?.pendingLeads || [];
  const forecast = data?.forecast || [];
  const forecastNextYear = data?.forecastNextYear || [];
  const totalCapacity = data?.totalCapacity || 0;
  const academicYear = data?.academicYear || '';
  const nextAcademicYear = data?.nextAcademicYear || '';

  const totalKids = Object.values(classrooms).reduce((sum, kids) => sum + (Array.isArray(kids) ? kids.length : 0), 0);
  const signedCount = pendingLeads.filter(l => l.agreement_signed).length;
  const pendingCount = pendingLeads.length - signedCount;

  const activeForecast = yearTab === 0 ? forecast : forecastNextYear;
  const activeYear = yearTab === 0 ? academicYear : nextAcademicYear;

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>לוח בקרה</Typography>
          {selectedBranchName && (
            <Typography variant="body2" color="text.secondary">{selectedBranchName}</Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined" size="small" startIcon={<SyncIcon />}
            onClick={handleSync} disabled={syncing}
            sx={{ borderColor: '#10b981', color: '#10b981' }}
          >
            {syncing ? 'מסנכרן...' : 'סנכרון'}
          </Button>
          <Button variant="contained" onClick={() => navigate('/new-registration')}>+ רישום חדש</Button>
        </Stack>
      </Box>

      {/* KPI Cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2, mb: 4 }}>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">סה״כ ילדים פעילים</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#f59e0b' }}>{totalKids}</Typography>
            <Typography variant="caption" color="text.secondary">{academicYear}</Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">חוזים חתומים</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#10b981' }}>{signedCount}</Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">ממתינים לחתימה</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#f97316' }}>{pendingCount}</Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">תפוסה מקסימלית</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#3b82f6' }}>{totalCapacity || '—'}</Typography>
          </CardContent>
        </Card>
        <StockShortageTile />
      </Box>

      {/* Occupancy Chart */}
      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>צפי רישום שנתי</Typography>
            <Tabs value={yearTab} onChange={(_, v) => setYearTab(v)} sx={{ minHeight: 36 }}>
              <Tab
                label={academicYear}
                sx={{ minHeight: 36, py: 0.5, fontSize: '0.85rem', fontWeight: 700 }}
              />
              <Tab
                label={nextAcademicYear}
                sx={{ minHeight: 36, py: 0.5, fontSize: '0.85rem', fontWeight: 700 }}
              />
            </Tabs>
          </Box>
          <OccupancyChart
            forecast={activeForecast}
            totalCapacity={totalCapacity}
          />
        </CardContent>
      </Card>

      {/* Classrooms */}
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
        כיתות - {academicYear}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 2, mb: 4 }}>
        {Object.entries(classrooms).map(([name, kids]) => {
          const capacity = data?.classroomCapacity?.find(c => c.name === name)?.capacity || 0;
          const count = Array.isArray(kids) ? kids.length : 0;
          const cc = getClassroomColor(name);
          return (
            <Card key={name} sx={{ borderTop: `5px solid ${cc.primary}` }}>
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, pb: 1, borderBottom: `1px solid ${cc.border}` }}>
                  <Typography sx={{ fontWeight: 700, color: cc.primary }}>{name}</Typography>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography sx={{ fontWeight: 800, color: cc.primary }}>{count}</Typography>
                    {capacity > 0 && (
                      <Typography variant="caption" color="text.secondary">/ {capacity}</Typography>
                    )}
                  </Box>
                </Box>
                {Array.isArray(kids) && kids.map((k, i) => (
                  <Box
                    key={i}
                    onClick={() => k._id && setSelectedChild(k._id)}
                    sx={{
                      p: 1, mb: 0.5, bgcolor: cc.bg, borderRadius: 2, fontSize: '0.9rem',
                      cursor: k._id ? 'pointer' : 'default',
                      borderRight: `3px solid ${cc.border}`,
                      '&:hover': k._id ? { bgcolor: cc.border, transform: 'translateX(-2px)' } : {},
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {k.child_name || '—'}
                  </Box>
                ))}
              </CardContent>
            </Card>
          );
        })}
        {Object.keys(classrooms).length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6, gridColumn: '1 / -1' }}>
            <Typography color="text.secondary">אין ילדים רשומים עדיין. התחל ברישום חדש.</Typography>
          </Box>
        )}
      </Box>

      {/* Pending Leads */}
      {pendingLeads.length > 0 && (
        <>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>רישומים ממתינים</Typography>
          {pendingLeads.map((lead, i) => (
            <Card key={i} sx={{ mb: 1, p: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>{lead.child_name}</Typography>
                  <Typography variant="body2" color="text.secondary">{lead.parent_name}</Typography>
                </Box>
                <Chip
                  label={lead.agreement_signed ? 'חתום' : 'ממתין'}
                  color={lead.agreement_signed ? 'success' : 'warning'}
                  size="small"
                  variant="outlined"
                />
              </Box>
            </Card>
          ))}
        </>
      )}
      <ChildDetailDialog
        open={!!selectedChild}
        childId={selectedChild}
        onClose={() => setSelectedChild(null)}
        onChanged={() => {}}
      />
    </Box>
  );
}
