import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box, Typography, Button, Stack, Card, CardContent, Dialog, DialogTitle,
  DialogContent, DialogActions, List, ListItem, ListItemText, IconButton,
  Tooltip, Alert, Divider, TextField,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import RestoreIcon from '@mui/icons-material/Restore';
import { toast } from 'react-toastify';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import LoadingSpinner from '../shared/LoadingSpinner';

export default function ContactListPDF() {
  const { isManager } = useAuth();
  const [loading, setLoading] = useState(true);
  const [htmlContent, setHtmlContent] = useState('');
  const [blobUrl, setBlobUrl] = useState('');
  const iframeRef = useRef(null);
  // עריכת הרשימה — הסרה זמנית של ילד שירד מרשימת קליקטאק/תמ"ת.
  const [editOpen, setEditOpen] = useState(false);
  const [kids, setKids] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [search, setSearch] = useState('');

  const loadSheet = useCallback(() => {
    setLoading(true);
    api.get('/contacts/pdf', { responseType: 'blob' })
      .then((res) => {
        const contentType = res.headers['content-type'] || '';

        if (contentType.includes('text/html')) {
          // Server returned HTML - render in iframe
          res.data.text().then((html) => setHtmlContent(html));
        } else {
          // Server returned PDF blob
          const url = URL.createObjectURL(res.data);
          setBlobUrl(url);
        }
      })
      .catch(() => toast.error('שגיאה בטעינת דף קשר'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSheet();
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [loadSheet]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadEditLists = useCallback(async () => {
    try {
      const [act, hid] = await Promise.all([
        api.get('/children'),
        api.get('/children/hidden'),
      ]);
      setKids(act.data.children || act.data || []);
      setHidden(hid.data.children || []);
    } catch {
      toast.error('שגיאה בטעינת רשימת הילדים');
    }
  }, []);

  const openEdit = () => { setEditOpen(true); loadEditLists(); };

  const hideChild = async (c) => {
    try {
      await api.post(`/children/${c._id || c.id}/hide`, { note: 'ירד/ה מרשימת קליקטאק/תמ"ת' });
      toast.success(`${c.child_name} הוסר/ה זמנית — יחזור/תחזור אוטומטית אם יופיע/תופיע בקובץ הבא`);
      loadEditLists();
      loadSheet();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const unhideChild = async (c) => {
    try {
      await api.post(`/children/${c.id}/unhide`);
      toast.success(`${c.child_name} הוחזר/ה לרשימות`);
      loadEditLists();
      loadSheet();
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה');
    }
  };

  const handlePrint = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.print();
    } else {
      window.print();
    }
  };

  const handleDownload = () => {
    if (blobUrl) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'contact-list.pdf';
      a.click();
      return;
    }
    // For HTML content, trigger server-side PDF download
    api.get('/contacts/pdf?format=pdf', { responseType: 'blob' })
      .then((res) => {
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'contact-list.pdf';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => toast.error('שגיאה בהורדת הקובץ'));
  };

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>
          דף קשר
        </Typography>
        <Stack direction="row" spacing={1}>
          {isManager && (
            <Button
              variant="outlined"
              color="warning"
              startIcon={<EditIcon />}
              onClick={openEdit}
              size="small"
            >
              עריכת הרשימה
            </Button>
          )}
          <Button
            variant="outlined"
            startIcon={<PrintIcon />}
            onClick={handlePrint}
            size="small"
          >
            הדפסה
          </Button>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
            size="small"
          >
            הורדה
          </Button>
        </Stack>
      </Stack>

      <Card sx={{ overflow: 'hidden' }}>
        <CardContent sx={{ p: 0 }}>
          {blobUrl ? (
            <iframe
              ref={iframeRef}
              src={blobUrl}
              title="דף קשר"
              style={{
                width: '100%',
                height: 'calc(100vh - 220px)',
                border: 'none',
              }}
            />
          ) : htmlContent ? (
            <iframe
              ref={iframeRef}
              srcDoc={htmlContent}
              title="דף קשר"
              style={{
                width: '100%',
                height: 'calc(100vh - 220px)',
                border: 'none',
                direction: 'rtl',
              }}
            />
          ) : (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary">
                אין נתונים להצגה
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* ---- עריכת הרשימה: הסרה זמנית ---- */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} dir="rtl" maxWidth="sm" fullWidth>
        <DialogTitle>עריכת דף הקשר — הסרה זמנית</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            ילד/ה שירד/ה מרשימת קליקטאק או התמ"ת — אפשר להסיר כאן זמנית. ההסרה
            מורידה מדף הקשר ומהרשימות, וברגע שיועלה קובץ חדש שבו הילד/ה מופיע/ה —
            הוא/היא יחזרו אוטומטית.
          </Alert>

          {hidden.length > 0 && (
            <>
              <Typography sx={{ fontWeight: 800, mb: 0.5 }}>מוסרים זמנית ({hidden.length})</Typography>
              <List dense sx={{ bgcolor: '#fff7ed', borderRadius: 2, mb: 2 }}>
                {hidden.map(c => (
                  <ListItem key={c.id} secondaryAction={
                    <Tooltip title="החזרה לרשימות">
                      <IconButton edge="end" color="success" onClick={() => unhideChild(c)}>
                        <RestoreIcon />
                      </IconButton>
                    </Tooltip>
                  }>
                    <ListItemText
                      primary={c.child_name}
                      secondary={`${c.classroom_name || 'ללא כיתה'} · הוסר/ה ${c.hidden_at ? new Date(c.hidden_at).toLocaleDateString('he-IL') : ''}${c.hidden_by_name ? ` ע"י ${c.hidden_by_name}` : ''}`}
                    />
                  </ListItem>
                ))}
              </List>
              <Divider sx={{ mb: 2 }} />
            </>
          )}

          <TextField
            size="small" fullWidth placeholder="חיפוש ילד/ה" value={search}
            onChange={e => setSearch(e.target.value)} sx={{ mb: 1 }}
          />
          <List dense sx={{ maxHeight: 360, overflowY: 'auto' }}>
            {kids
              .filter(c => !search.trim() || (c.child_name || '').includes(search.trim()))
              .map(c => (
                <ListItem key={c._id || c.id} secondaryAction={
                  <Tooltip title="הסרה זמנית מדף הקשר ומהרשימות">
                    <IconButton edge="end" color="warning" onClick={() => hideChild(c)}>
                      <VisibilityOffIcon />
                    </IconButton>
                  </Tooltip>
                }>
                  <ListItemText
                    primary={c.child_name}
                    secondary={c.classroom_name || 'ללא כיתה'}
                  />
                </ListItem>
              ))}
            {kids.length === 0 && (
              <Typography color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
                אין ילדים להצגה
              </Typography>
            )}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>סגירה</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
