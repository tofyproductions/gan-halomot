import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, Stack,
  Stepper, Step, StepLabel, Alert, Divider, CircularProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DownloadIcon from '@mui/icons-material/Download';
import SignatureCanvas from 'react-signature-canvas';
import { toast } from 'react-toastify';
import axios from 'axios';
import { isValidIsraeliID } from '../../utils/hebrewYear';

const STEPS = ['ברוכים הבאים', 'חוזה וחתימה', 'כרטיס רישום', 'סיום'];

// Use a plain axios instance (no JWT interceptor needed for public routes)
const publicApi = axios.create({ baseURL: '/api/public', timeout: 30000 });

export default function ParentOnboarding() {
  const { token } = useParams();
  const sigRef = useRef(null);

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [regData, setRegData] = useState(null);
  const [error, setError] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');

  // Registration card form
  const [card, setCard] = useState({
    childFullName: '',
    childBirthDate: '',
    childIdNumber: '',
    parent1Name: '',
    parent1Id: '',
    parent1Phone: '',
    parent1Email: '',
    parent2Name: '',
    parent2Id: '',
    parent2Phone: '',
    parent2Email: '',
    address: '',
    medicalInfo: '',
    allergies: '',
    emergencyContact: '',
    emergencyPhone: '',
    notes: '',
  });
  const [files, setFiles] = useState({ parentIdFile: null, paymentProof: null });
  const [cardErrors, setCardErrors] = useState({});

  // Load registration data
  useEffect(() => {
    publicApi.get(`/register/${token}`)
      .then((res) => {
        setRegData(res.data);
        // Pre-fill card from registration
        const d = res.data;
        setCard((prev) => ({
          ...prev,
          childFullName: d.childName || '',
          childBirthDate: d.childBirthDate ? d.childBirthDate.slice(0, 10) : '',
          parent1Name: d.parentName || '',
          parent1Id: d.parentId || '',
          parent1Phone: d.parentPhone || '',
        }));
      })
      .catch((err) => {
        setError(err.response?.data?.message || 'קישור לא תקין או שפג תוקפו');
      })
      .finally(() => setLoading(false));
  }, [token]);

  const handleCardChange = (field) => (e) => {
    setCard((prev) => ({ ...prev, [field]: e.target.value }));
    setCardErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleFileChange = (field) => (e) => {
    if (e.target.files?.[0]) {
      setFiles((prev) => ({ ...prev, [field]: e.target.files[0] }));
    }
  };

  // Step 2: Sign contract
  const handleSign = async () => {
    if (!sigRef.current || sigRef.current.isEmpty()) {
      toast.error('יש לחתום לפני המשך');
      return;
    }
    setSubmitting(true);
    try {
      const signatureData = sigRef.current.toDataURL('image/png');
      await publicApi.post(`/register/${token}/sign`, { signature: signatureData });
      toast.success('החוזה נחתם בהצלחה');
      setStep(2);
    } catch (err) {
      toast.error(err.response?.data?.message || 'שגיאה בחתימה');
    } finally {
      setSubmitting(false);
    }
  };

  // Step 3: Upload card + files
  const validateCard = () => {
    const errs = {};
    if (!card.childFullName.trim()) errs.childFullName = 'שדה חובה';
    if (!card.parent1Name.trim()) errs.parent1Name = 'שדה חובה';
    if (!card.parent1Phone.trim()) errs.parent1Phone = 'שדה חובה';
    if (card.parent1Id && !isValidIsraeliID(card.parent1Id)) errs.parent1Id = 'ת.ז. לא תקינה';
    if (card.parent2Id && !isValidIsraeliID(card.parent2Id)) errs.parent2Id = 'ת.ז. לא תקינה';
    setCardErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleUploadCard = async () => {
    if (!validateCard()) return;
    setSubmitting(true);
    try {
      const formData = new FormData();
      // Append card fields
      Object.entries(card).forEach(([key, val]) => {
        formData.append(key, val);
      });
      // Append files
      if (files.parentIdFile) formData.append('parentIdFile', files.parentIdFile);
      if (files.paymentProof) formData.append('paymentProof', files.paymentProof);

      const res = await publicApi.post(`/register/${token}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data.pdfUrl) setPdfUrl(res.data.pdfUrl);
      toast.success('הפרטים נשלחו בהצלחה');
      setStep(3);
    } catch (err) {
      toast.error(err.response?.data?.message || 'שגיאה בשליחת הטופס');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box dir="rtl" sx={{ maxWidth: 500, mx: 'auto', mt: 8, px: 2 }}>
        <Alert severity="error" sx={{ borderRadius: 3 }}>{error}</Alert>
      </Box>
    );
  }

  return (
    <Box dir="rtl" sx={{ maxWidth: 700, mx: 'auto', py: 4, px: 2 }}>
      {/* Header */}
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, fontFamily: 'Varela Round' }}>
          גן החלומות
        </Typography>
      </Box>

      <Stepper activeStep={step} alternativeLabel sx={{ mb: 4 }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Step 0: Welcome */}
      {step === 0 && (
        <Card sx={{ textAlign: 'center', py: 4 }}>
          <CardContent>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>
              שלום {regData?.parentName}!
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
              ברוכים הבאים לתהליך הרישום של
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 800, color: 'primary.dark', mb: 3 }}>
              {regData?.childName}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
              כיתה: {regData?.classroom}
            </Typography>
            <Button variant="contained" size="large" onClick={() => setStep(1)}>
              בואו נתחיל
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 1: Contract + Signature */}
      {step === 1 && (
        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
              חוזה התקשרות
            </Typography>

            {regData?.contractHtml ? (
              <Box
                sx={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 2,
                  p: 2,
                  maxHeight: 400,
                  overflow: 'auto',
                  mb: 3,
                  bgcolor: '#fafafa',
                  fontSize: '0.9rem',
                  lineHeight: 1.8,
                }}
                dangerouslySetInnerHTML={{ __html: regData.contractHtml }}
              />
            ) : (
              <Alert severity="info" sx={{ mb: 3, borderRadius: 2 }}>
                החוזה יוצג כאן. אנא קרא/י בעיון לפני החתימה.
              </Alert>
            )}

            <Divider sx={{ my: 3 }} />

            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
              חתימה דיגיטלית
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              אנא חתום/י בתוך המסגרת
            </Typography>

            <Box
              sx={{
                border: '2px dashed #cbd5e1',
                borderRadius: 3,
                mb: 2,
                overflow: 'hidden',
                bgcolor: 'white',
              }}
            >
              <SignatureCanvas
                ref={sigRef}
                penColor="#1e293b"
                canvasProps={{
                  width: 640,
                  height: 200,
                  style: { width: '100%', height: 200 },
                }}
              />
            </Box>

            <Stack direction="row" spacing={2}>
              <Button
                variant="outlined"
                onClick={() => sigRef.current?.clear()}
                disabled={submitting}
              >
                נקה חתימה
              </Button>
              <Button
                variant="contained"
                onClick={handleSign}
                disabled={submitting}
                sx={{ flex: 1 }}
              >
                {submitting ? 'שולח...' : 'חתום והמשך'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Registration Card */}
      {step === 2 && (
        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 3 }}>
              כרטיס רישום - פרטים מלאים
            </Typography>

            {/* Child */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              פרטי הילד/ה
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם מלא"
                value={card.childFullName}
                onChange={handleCardChange('childFullName')}
                error={!!cardErrors.childFullName}
                helperText={cardErrors.childFullName}
                fullWidth
                required
              />
              <TextField
                label="תאריך לידה"
                type="date"
                value={card.childBirthDate}
                onChange={handleCardChange('childBirthDate')}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label="מספר זהות ילד/ה"
                value={card.childIdNumber}
                onChange={handleCardChange('childIdNumber')}
                fullWidth
                inputProps={{ maxLength: 9, dir: 'ltr' }}
              />
            </Stack>

            <Divider sx={{ my: 2 }} />

            {/* Parent 1 */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              הורה 1
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם מלא"
                value={card.parent1Name}
                onChange={handleCardChange('parent1Name')}
                error={!!cardErrors.parent1Name}
                helperText={cardErrors.parent1Name}
                fullWidth
                required
              />
              <TextField
                label="תעודת זהות"
                value={card.parent1Id}
                onChange={handleCardChange('parent1Id')}
                error={!!cardErrors.parent1Id}
                helperText={cardErrors.parent1Id}
                fullWidth
                inputProps={{ maxLength: 9, dir: 'ltr' }}
              />
              <Stack direction="row" spacing={2}>
                <TextField
                  label="טלפון"
                  value={card.parent1Phone}
                  onChange={handleCardChange('parent1Phone')}
                  error={!!cardErrors.parent1Phone}
                  helperText={cardErrors.parent1Phone}
                  fullWidth
                  required
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="דוא״ל"
                  type="email"
                  value={card.parent1Email}
                  onChange={handleCardChange('parent1Email')}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
              </Stack>
            </Stack>

            <Divider sx={{ my: 2 }} />

            {/* Parent 2 */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              הורה 2
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם מלא"
                value={card.parent2Name}
                onChange={handleCardChange('parent2Name')}
                fullWidth
              />
              <TextField
                label="תעודת זהות"
                value={card.parent2Id}
                onChange={handleCardChange('parent2Id')}
                error={!!cardErrors.parent2Id}
                helperText={cardErrors.parent2Id}
                fullWidth
                inputProps={{ maxLength: 9, dir: 'ltr' }}
              />
              <Stack direction="row" spacing={2}>
                <TextField
                  label="טלפון"
                  value={card.parent2Phone}
                  onChange={handleCardChange('parent2Phone')}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="דוא״ל"
                  type="email"
                  value={card.parent2Email}
                  onChange={handleCardChange('parent2Email')}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
              </Stack>
            </Stack>

            <Divider sx={{ my: 2 }} />

            {/* Address & Medical */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              כתובת ורפואי
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="כתובת מגורים"
                value={card.address}
                onChange={handleCardChange('address')}
                fullWidth
              />
              <TextField
                label="מידע רפואי"
                value={card.medicalInfo}
                onChange={handleCardChange('medicalInfo')}
                fullWidth
                multiline
                rows={2}
                placeholder="מחלות, תרופות קבועות וכו׳"
              />
              <TextField
                label="אלרגיות"
                value={card.allergies}
                onChange={handleCardChange('allergies')}
                fullWidth
                placeholder="אלרגיות למזון, תרופות וכו׳"
              />
            </Stack>

            <Divider sx={{ my: 2 }} />

            {/* Emergency Contact */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              איש קשר לחירום
            </Typography>
            <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם"
                value={card.emergencyContact}
                onChange={handleCardChange('emergencyContact')}
                fullWidth
              />
              <TextField
                label="טלפון"
                value={card.emergencyPhone}
                onChange={handleCardChange('emergencyPhone')}
                fullWidth
                inputProps={{ dir: 'ltr' }}
              />
            </Stack>

            <TextField
              label="הערות נוספות"
              value={card.notes}
              onChange={handleCardChange('notes')}
              fullWidth
              multiline
              rows={2}
              sx={{ mb: 3 }}
            />

            <Divider sx={{ my: 2 }} />

            {/* File Uploads */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.dark', mb: 1 }}>
              העלאת מסמכים
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5 }}>צילום תעודת זהות הורה</Typography>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={handleFileChange('parentIdFile')}
                />
              </Box>
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5 }}>אישור תשלום / שיק</Typography>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={handleFileChange('paymentProof')}
                />
              </Box>
            </Stack>

            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={handleUploadCard}
              disabled={submitting}
            >
              {submitting ? 'שולח...' : 'שלח והמשך'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Success */}
      {step === 3 && (
        <Card sx={{ textAlign: 'center', py: 5 }}>
          <CardContent>
            <CheckCircleIcon sx={{ fontSize: 80, color: 'success.main', mb: 2 }} />
            <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>
              הרישום הושלם בהצלחה!
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              תודה רבה, {card.parent1Name}. נשמח לקבל את {card.childFullName} בגן החלומות.
            </Typography>
            {pdfUrl && (
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                href={pdfUrl}
                target="_blank"
                rel="noopener"
              >
                הורדת חוזה חתום (PDF)
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
