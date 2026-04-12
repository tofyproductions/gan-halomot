import { useState, useEffect, useRef } from 'react';
import { Box, Typography, Button, Stack, Card, CardContent } from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import DownloadIcon from '@mui/icons-material/Download';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';

export default function ContactListPDF() {
  const [loading, setLoading] = useState(true);
  const [htmlContent, setHtmlContent] = useState('');
  const [blobUrl, setBlobUrl] = useState('');
  const iframeRef = useRef(null);

  useEffect(() => {
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

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    </Box>
  );
}
