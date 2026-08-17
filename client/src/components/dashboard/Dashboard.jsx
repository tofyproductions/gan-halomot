import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, Card, CardContent, Tabs, Tab, Chip, Stack, Alert, AlertTitle } from '@mui/material';
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
  const { selectedBranch, selectedBranchName } = useBranch();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [yearTab, setYearTab] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
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

  // Read-only pre-check: what would a sync import, and how many signatures
  // would be recovered — without writing anything.
  const handleCheck = async () => {
    setChecking(true);
    try {
      const { data: d } = await api.post('/sync/check');
      const summary = [
        `שורות בגיליון: ${d.sheet_rows}`,
        `חתימות בגיליון: ${d.signatures_in_sheet}`,
        `רישומים חסרים לייבוא: ${d.missing_imports.count}`,
        `חתימות שיושלמו: ${d.signatures_to_attach.count}`,
        `מסמכים שיושלמו: ${d.documents_to_attach?.count ?? 0}`,
      ];
      const detail = [];
      if (d.missing_imports.count) {
        detail.push('', `— חסרים לייבוא (${d.missing_imports.count}) —`);
        d.missing_imports.list.forEach(x => detail.push(`• ${x.child_name}${x.signed ? ' (חתום)' : ''}`));
      }
      if (d.signatures_to_attach.count) {
        detail.push('', `— חתימות שיושלמו (${d.signatures_to_attach.count}) —`);
        d.signatures_to_attach.list.forEach(x => detail.push(`• ${x.child_name}`));
      }
      toast.info(summary.join(' · '));
      window.alert([...summary, ...detail].join('\n'));
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בבדיקה');
    } finally {
      setChecking(false);
    }
  };

  /**
   * The branch has to be ON the request.
   *
   * The board named the selected branch in its subtitle and then asked for
   * every branch's numbers — the server filters by `?branch=`, and nobody was
   * sending it. So משה דיין's screen listed a קפלן child among its pending
   * registrations, and its classroom counts and forecast were the whole
   * network's. Refetching on branch change is the other half: switching the
   * branch in the header used to leave the board showing the old data.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/dashboard/stats', {
      params: selectedBranch ? { branch: selectedBranch } : {},
    })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedBranch]);

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
  // The ministry's licence for the whole מעון, typed in on the placement board.
  // Kept next to the rooms' own total rather than merged with it: the rooms are
  // often laid out for more places than the licence allows, and the number that
  // binds is the smaller one.
  const licensedCapacity = data?.licensedCapacity ?? null;
  const bindingCapacity = data?.bindingCapacity || 0;
  // Children who belong to this year and are in no room of it — either no room
  // at all, or one left over from a year that has ended. Counted apart because
  // the board's job is to say so: a cohort sitting in last year's rooms looked
  // exactly like a cohort that had been placed.
  const unplaced = data?.unplaced || 0;
  const academicYear = data?.academicYear || '';
  const nextAcademicYear = data?.nextAcademicYear || '';

  const totalKids = Object.values(classrooms).reduce((sum, kids) => sum + (Array.isArray(kids) ? kids.length : 0), 0);
  // Declared here and not with the other capacity figures above: it reads
  // totalKids, and a const read before its own declaration throws at render.
  const freePlaces = bindingCapacity > 0 ? Math.max(0, bindingCapacity - totalKids) : null;
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
            variant="outlined" size="small"
            onClick={handleCheck} disabled={checking || syncing}
            sx={{ borderColor: '#6366f1', color: '#6366f1' }}
          >
            {checking ? 'בודק...' : 'בדיקת סנכרון'}
          </Button>
          <Button
            variant="outlined" size="small" startIcon={<SyncIcon />}
            onClick={handleSync} disabled={syncing || checking}
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
            <Typography variant="body2" color="text.secondary">תפוסה מאושרת</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#3b82f6' }}>
              {bindingCapacity || '—'}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              {licensedCapacity != null
                ? `רישיון ${licensedCapacity} · כיתות ${totalCapacity}`
                : 'לפי סכום מקומות בכיתות'}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">מקומות פנויים</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: freePlaces === 0 ? '#ef4444' : '#10b981' }}>
              {freePlaces == null ? '—' : freePlaces}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              {bindingCapacity > 0 ? `${totalKids} מתוך ${bindingCapacity} משובצים` : 'לא הוזנה תפוסה'}
            </Typography>
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
      {unplaced > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>{unplaced} ילדים ללא שיבוץ לשנת {academicYear}</AlertTitle>
          הם רשומים לשנה הזו אבל לא יושבים באף כיתה שלה — או שאין להם כיתה כלל, או
          שהכיתה שלהם שייכת לשנה קודמת. עד שישובצו הם לא ייספרו בתפוסת הכיתות ולא
          יופיעו במסכי הכיתות והנוכחות.
        </Alert>
      )}
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
                  <Typography variant="body2" color="text.secondary">
                    {lead.parent_name}
                    {/* The branch the registration is FILED under. Spelled out
                        because a row filed against the wrong gan looks exactly
                        like a correct one until you can see which gan it says. */}
                    {lead.branch_name ? ` · ${lead.branch_name}` : ' · ללא סניף'}
                    {lead.academic_year ? ` · ${lead.academic_year}` : ''}
                  </Typography>
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
