import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Grid, Card, CardContent, Stack, Button, Chip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'react-toastify';
import api from '../../api/client';
import ClassroomCard from './ClassroomCard';
import LoadingSpinner from '../shared/LoadingSpinner';
import { formatCurrency } from '../../utils/hebrewYear';

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get('/dashboard/stats')
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) console.error('Dashboard load error:', err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <LoadingSpinner />;

  const stats = data?.stats || {};
  const classrooms = data?.classrooms || {};

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>
          לוח בקרה
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate('/new-registration')}
        >
          רישום חדש
        </Button>
      </Stack>

      {/* KPI Summary Cards */}
      <Grid container spacing={2} sx={{ mb: 4 }}>
        <Grid item xs={6} md={3}>
          <Card>
            <CardContent sx={{ textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">סה״כ ילדים</Typography>
              <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.dark' }}>
                {stats.totalKids ?? 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card>
            <CardContent sx={{ textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">חוזים חתומים</Typography>
              <Typography variant="h4" sx={{ fontWeight: 800, color: 'success.main' }}>
                {stats.signed ?? 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card>
            <CardContent sx={{ textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">ממתינים לחתימה</Typography>
              <Typography variant="h4" sx={{ fontWeight: 800, color: 'warning.main' }}>
                {stats.pending ?? 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card>
            <CardContent sx={{ textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">גבייה חודשית</Typography>
              <Typography variant="h4" sx={{ fontWeight: 800 }}>
                {formatCurrency(stats.monthlyRevenue ?? 0)}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Classroom Cards */}
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
        כיתות
      </Typography>
      <Grid container spacing={2}>
        {Object.entries(classrooms).map(([name, kids]) => (
          <Grid item xs={12} sm={6} md={3} key={name}>
            <ClassroomCard name={name} kids={kids} />
          </Grid>
        ))}
        {Object.keys(classrooms).length === 0 && (
          <Grid item xs={12}>
            <Box sx={{ textAlign: 'center', py: 6 }}>
              <Typography color="text.secondary">
                אין ילדים רשומים עדיין. התחל ברישום חדש.
              </Typography>
            </Box>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
