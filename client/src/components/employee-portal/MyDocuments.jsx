import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Card, CardContent, Chip, IconButton, Tooltip, Grid,
  Alert, AlertTitle, Divider, List, ListItem, ListItemText,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AssignmentIndIcon from '@mui/icons-material/AssignmentInd';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { BusyButton, FilePickButton, UploadingBar } from '../shared/UploadControls';

const DOC_TYPES = {
  employment_contract: { label: 'חוזה העסקה', color: 'primary' },
  form_161: { label: 'טופס 161', color: 'warning' },
  final_settlement: { label: 'גמר חשבון', color: 'error' },
  other: { label: 'מסמך אחר', color: 'default' },
};

function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('he-IL'); } catch { return ''; } };

/**
 * טופס 101 — the one document the employee has to hand IN rather than receive.
 *
 * It sits at the top of the page and says so out loud when this year's is
 * missing. Until now nobody was asked: the form was expected to arrive by mail
 * or on paper, and when it didn't, the first sign was a payslip with tax
 * deducted at the maximum rate. Once filed it stays visible here for every
 * year on record — the employee's own copy, always reachable.
 */
function Form101Card() {
  const [state, setState] = useState({ forms: [], has_current: false, tax_year: null });
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/payroll/my-form-101')
      .then(res => setState(res.data))
      .catch(() => setState({ forms: [], has_current: false, tax_year: null }))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const upload = () => {
    if (!file?.data) return toast.error('בחר/י קובץ');
    setSaving(true);
    api.post('/payroll/my-form-101', {
      file_data: file.data,
      file_name: file.name,
      file_mimetype: file.mimetype,
    })
      .then((res) => {
        toast.success(`טופס 101 לשנת ${res.data.tax_year} נקלט`);
        setFile(null);
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'שגיאה בהעלאה'))
      .finally(() => setSaving(false));
  };

  // The file route sits behind the bearer token, so an <a href> would 401 —
  // same reason the payslip download goes through the authed fetch helper.
  const view = async (f) => {
    try {
      const res = await api.get(`/payroll/my-form-101/${f.id}/file`);
      const { data, name, mimetype } = res.data;
      const url = URL.createObjectURL(base64ToBlob(data, mimetype || 'application/pdf'));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'אין קובץ');
    }
  };

  const year = state.tax_year;

  return (
    <Card sx={{ borderRadius: 3, mb: 3 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <AssignmentIndIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 800 }}>טופס 101</Typography>
          {state.has_current && (
            <Chip size="small" color="success" icon={<CheckCircleIcon />} label={`הוגש לשנת ${year}`} />
          )}
        </Stack>

        {loading ? (
          <Typography color="text.secondary">טוען...</Typography>
        ) : (
          <Stack spacing={2}>
            {!state.has_current && (
              <Alert severity="warning">
                <AlertTitle sx={{ fontWeight: 700 }}>נדרש טופס 101 לשנת {year}</AlertTitle>
                טופס 101 ממולא מחדש בכל שנת מס. בלעדיו לא ניתן להביא בחשבון נקודות זיכוי,
                והמס מנוכה בשיעור המרבי. מלא/י את הטופס, חתום/מי, וצרף/י אותו כאן (PDF או צילום).
              </Alert>
            )}

            {!state.has_current && (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <FilePickButton
                  hasFile={!!file}
                  onPick={setFile}
                  onError={msg => toast.error(msg)}
                  disabled={saving}
                  accept="application/pdf,image/*"
                  maxSizeMB={8}
                  label="בחר/י את הטופס"
                />
                {file && <Chip label={file.name} size="small" onDelete={() => setFile(null)} />}
                <BusyButton
                  variant="contained"
                  onClick={upload}
                  loading={saving}
                  loadingText="מעלה…"
                  disabled={!file}
                >
                  הגש/י טופס
                </BusyButton>
              </Stack>
            )}
            <UploadingBar show={saving} />

            {state.forms.length > 0 ? (
              <>
                <Divider />
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>הטפסים שהוגשו</Typography>
                <List dense disablePadding>
                  {state.forms.map(f => (
                    <ListItem
                      key={f.id}
                      disableGutters
                      secondaryAction={(
                        <Tooltip title="צפייה">
                          <IconButton edge="end" color="primary" onClick={() => view(f)}>
                            <VisibilityIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                    >
                      <ListItemText
                        primary={`שנת מס ${f.tax_year}`}
                        secondary={`הוגש ${fmtDate(f.created_at)}${f.self_uploaded ? ' · על ידך' : ''}`}
                        primaryTypographyProps={{ fontWeight: 700 }}
                      />
                    </ListItem>
                  ))}
                </List>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                עדיין לא הוגש טופס 101.
              </Typography>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export default function MyDocuments() {
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

      <Form101Card />

      <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>מסמכים מההנהלה</Typography>
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
                        {fmtDate(doc.created_at)}
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
