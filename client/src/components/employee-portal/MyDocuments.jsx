import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Chip, IconButton, Tooltip, Grid,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useAuth } from '../../hooks/useAuth';
import api from '../../api/client';

const DOC_TYPES = {
  employment_contract: { label: 'חוזה העסקה', color: 'primary' },
  form_161: { label: 'טופס 161', color: 'warning' },
  final_settlement: { label: 'גמר חשבון', color: 'error' },
  other: { label: 'מסמך אחר', color: 'default' },
};

export default function MyDocuments() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/contracts?employee_id=me')
      .then(res => setDocuments(res.data.contracts || []))
      .catch(() => setDocuments([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Box dir="rtl" sx={{ p: 3, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <DescriptionIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>המסמכים שלי</Typography>
      </Stack>

      {loading ? (
        <Typography color="text.secondary">טוען...</Typography>
      ) : documents.length > 0 ? (
        <Grid container spacing={2}>
          {documents.map((doc) => {
            const typeInfo = DOC_TYPES[doc.doc_type] || DOC_TYPES.other;
            return (
              <Grid item xs={12} sm={6} md={4} key={doc._id}>
                <Card sx={{ borderRadius: 3 }}>
                  <CardContent>
                    <Stack spacing={1}>
                      <Chip label={typeInfo.label} size="small" color={typeInfo.color} />
                      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                        {doc.file_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(doc.created_at).toLocaleDateString('he-IL')}
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        {doc.file_url && (
                          <>
                            <Tooltip title="צפה">
                              <IconButton size="small" href={doc.file_url} target="_blank">
                                <VisibilityIcon />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="הורד">
                              <IconButton size="small" href={doc.file_url} download>
                                <DownloadIcon />
                              </IconButton>
                            </Tooltip>
                          </>
                        )}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      ) : (
        <Typography color="text.secondary">
          אין מסמכים זמינים כרגע. מסמכים כגון חוזה העסקה, טופס 161 וגמר חשבון יופיעו כאן.
        </Typography>
      )}
    </Box>
  );
}
