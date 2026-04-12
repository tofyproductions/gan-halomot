import { Card, CardContent, Typography, Box, Stack, Chip } from '@mui/material';

const CLASS_COLORS = {
  'תינוקייה א': '#2563eb',
  'תינוקייה ב': '#7c3aed',
  'צעירים': '#db2777',
  'בוגרים': '#059669',
};

export default function ClassroomCard({ name, kids }) {
  const color = CLASS_COLORS[name] || '#64748b';

  return (
    <Card sx={{ borderTop: `5px solid ${color}`, transition: '0.2s', '&:hover': { transform: 'translateY(-3px)' } }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1.5, pb: 1, borderBottom: '2px solid #f1f5f9' }}>
          <Typography sx={{ fontWeight: 700, fontSize: '1.1rem' }}>{name}</Typography>
          <Chip label={kids.length} size="small" sx={{ bgcolor: color, color: 'white', fontWeight: 800 }} />
        </Box>
        <Stack spacing={0.5}>
          {kids.map((k, i) => (
            <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', p: 1, bgcolor: '#f8fafc', borderRadius: 2, fontSize: '0.9rem' }}>
              <span>{k.childName || k.name}</span>
              {k.medicalAlerts && <span>⚠️</span>}
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
