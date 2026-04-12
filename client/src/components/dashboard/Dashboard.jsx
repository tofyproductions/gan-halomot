import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, Card, CardContent } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../api/client';

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
        <Typography variant="h6" sx={{ color: '#f59e0b' }}>טוען נתונים... ⏳</Typography>
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
  const totalKids = Object.values(classrooms).reduce((sum, kids) => sum + (Array.isArray(kids) ? kids.length : 0), 0);
  const signedCount = pendingLeads.filter(l => l.agreementSigned).length;
  const pendingCount = pendingLeads.length - signedCount;

  return (
    <Box dir="rtl" sx={{ p: 2 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>לוח בקרה</Typography>
        <Button variant="contained" onClick={() => navigate('/new-registration')}>➕ רישום חדש</Button>
      </Box>

      {/* KPI Cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2, mb: 4 }}>
        <Card>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">סה״כ ילדים</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#f59e0b' }}>{totalKids}</Typography>
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
            <Typography variant="body2" color="text.secondary">סה״כ רישומים</Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: '#3b82f6' }}>{pendingLeads.length}</Typography>
          </CardContent>
        </Card>
      </Box>

      {/* Classrooms */}
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>כיתות</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 2, mb: 4 }}>
        {Object.entries(classrooms).map(([name, kids]) => (
          <Card key={name} sx={{ borderTop: '5px solid #f59e0b' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, pb: 1, borderBottom: '1px solid #f1f5f9' }}>
                <Typography sx={{ fontWeight: 700 }}>{name}</Typography>
                <Typography sx={{ fontWeight: 800, color: '#f59e0b' }}>{Array.isArray(kids) ? kids.length : 0}</Typography>
              </Box>
              {Array.isArray(kids) && kids.map((k, i) => (
                <Box key={i} sx={{ p: 1, mb: 0.5, bgcolor: '#f8fafc', borderRadius: 2, fontSize: '0.9rem' }}>
                  {k.child_name || k.childName || k.name || '—'}
                </Box>
              ))}
            </CardContent>
          </Card>
        ))}
        {Object.keys(classrooms).length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6, gridColumn: '1 / -1' }}>
            <Typography color="text.secondary">אין ילדים רשומים עדיין. התחל ברישום חדש.</Typography>
          </Box>
        )}
      </Box>

      {/* Pending Leads Table */}
      {pendingLeads.length > 0 && (
        <>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>רישומים</Typography>
          {pendingLeads.map((lead, i) => (
            <Card key={i} sx={{ mb: 1, p: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>{lead.childName || lead.child_name}</Typography>
                  <Typography variant="body2" color="text.secondary">{lead.parentName || lead.parent_name}</Typography>
                </Box>
                <Typography variant="body2" sx={{
                  px: 1.5, py: 0.5, borderRadius: 2, fontWeight: 700,
                  bgcolor: lead.agreementSigned ? '#dcfce7' : '#fee2e2',
                  color: lead.agreementSigned ? '#166534' : '#991b1b',
                }}>
                  {lead.agreementSigned ? '✅ הושלם' : '⏳ בתהליך'}
                </Typography>
              </Box>
            </Card>
          ))}
        </>
      )}
    </Box>
  );
}
