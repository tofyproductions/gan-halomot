import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, TextField, Button, MenuItem,
  FormControlLabel, Checkbox, Stack, Divider, Alert, IconButton,
  Tooltip, InputAdornment,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import SaveIcon from '@mui/icons-material/Save';
import { toast } from 'react-toastify';
import api from '../../api/client';
import LoadingSpinner from '../shared/LoadingSpinner';
import { isValidIsraeliID, formatCurrency } from '../../utils/hebrewYear';

const CLASSROOMS = ['תינוקייה א', 'תינוקייה ב', 'צעירים', 'בוגרים'];

const DEFAULT_FORM = {
  childName: '',
  childBirthDate: '',
  parentName: '',
  parentId: '',
  parentPhone: '',
  classroom: '',
  monthlyFee: 3200,
  siblingDiscount: false,
  regFee: 500,
  startDate: '',
  endDate: '',
  startTime: '07:30',
  endTime: '16:00',
  friTime: '12:30',
  manualImport: false,
};

export default function RegistrationWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = !!id;

  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { link, token }
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (isEdit) {
      setLoading(true);
      api.get(`/registrations/${id}`)
        .then((res) => {
          const d = res.data;
          setForm({
            childName: d.childName || '',
            childBirthDate: d.childBirthDate ? d.childBirthDate.slice(0, 10) : '',
            parentName: d.parentName || '',
            parentId: d.parentId || '',
            parentPhone: d.parentPhone || '',
            classroom: d.classroom || '',
            monthlyFee: d.monthlyFee ?? 3200,
            siblingDiscount: d.siblingDiscount || false,
            regFee: d.regFee ?? 500,
            startDate: d.startDate ? d.startDate.slice(0, 10) : '',
            endDate: d.endDate ? d.endDate.slice(0, 10) : '',
            startTime: d.startTime || '07:30',
            endTime: d.endTime || '16:00',
            friTime: d.friTime || '12:30',
            manualImport: d.manualImport || false,
          });
        })
        .catch(() => toast.error('שגיאה בטעינת הרישום'))
        .finally(() => setLoading(false));
    }
  }, [id, isEdit]);

  const effectiveFee = form.siblingDiscount
    ? Math.round(form.monthlyFee * 0.9)
    : form.monthlyFee;

  const handleChange = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((prev) => ({ ...prev, [field]: val }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const errs = {};
    if (!form.childName.trim()) errs.childName = 'שדה חובה';
    if (!form.parentName.trim()) errs.parentName = 'שדה חובה';
    if (!form.parentPhone.trim()) errs.parentPhone = 'שדה חובה';
    if (form.parentId && !isValidIsraeliID(form.parentId)) errs.parentId = 'תעודת זהות לא תקינה';
    if (!form.classroom) errs.classroom = 'יש לבחור כיתה';
    if (!form.startDate) errs.startDate = 'שדה חובה';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const payload = { ...form, monthlyFee: effectiveFee };
      let res;
      if (isEdit) {
        res = await api.put(`/registrations/${id}`, payload);
        toast.success('הרישום עודכן בהצלחה');
      } else {
        res = await api.post('/registrations', payload);
        toast.success('הרישום נוצר בהצלחה');
      }
      const data = res.data;
      if (data.token) {
        const link = `${window.location.origin}/register/${data.token}`;
        setResult({ link, token: data.token, id: data._id || data.id });
      } else {
        navigate('/');
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'שגיאה בשמירת הרישום');
    } finally {
      setSaving(false);
    }
  };

  const copyLink = () => {
    if (result?.link) {
      navigator.clipboard.writeText(result.link);
      toast.success('הקישור הועתק');
    }
  };

  const sendWhatsApp = () => {
    if (!result?.link) return;
    const phone = form.parentPhone.replace(/^0/, '972');
    const text = encodeURIComponent(
      `שלום ${form.parentName},\nקישור לרישום ${form.childName} לגן החלומות:\n${result.link}`
    );
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
  };

  if (loading) return <LoadingSpinner />;

  return (
    <Box dir="rtl" sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 800, mb: 3 }}>
        {isEdit ? 'עריכת רישום' : 'רישום חדש'}
      </Typography>

      {result && (
        <Alert
          severity="success"
          sx={{ mb: 3, borderRadius: 3 }}
          action={
            <Stack direction="row" spacing={1}>
              <Tooltip title="העתק קישור">
                <IconButton size="small" onClick={copyLink}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="שלח בוואטסאפ">
                <IconButton size="small" onClick={sendWhatsApp} sx={{ color: '#25d366' }}>
                  <WhatsAppIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            הרישום נוצר! קישור להורה:
          </Typography>
          <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
            {result.link}
          </Typography>
        </Alert>
      )}

      <Card>
        <CardContent>
          <Box component="form" onSubmit={handleSubmit}>
            {/* Child Details */}
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2, color: 'primary.dark' }}>
              פרטי הילד/ה
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם הילד/ה"
                value={form.childName}
                onChange={handleChange('childName')}
                error={!!errors.childName}
                helperText={errors.childName}
                fullWidth
                required
              />
              <TextField
                label="תאריך לידה"
                type="date"
                value={form.childBirthDate}
                onChange={handleChange('childBirthDate')}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label="כיתה"
                select
                value={form.classroom}
                onChange={handleChange('classroom')}
                error={!!errors.classroom}
                helperText={errors.classroom}
                fullWidth
                required
              >
                {CLASSROOMS.map((c) => (
                  <MenuItem key={c} value={c}>{c}</MenuItem>
                ))}
              </TextField>
            </Stack>

            <Divider sx={{ my: 3 }} />

            {/* Parent Details */}
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2, color: 'primary.dark' }}>
              פרטי ההורה
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם ההורה"
                value={form.parentName}
                onChange={handleChange('parentName')}
                error={!!errors.parentName}
                helperText={errors.parentName}
                fullWidth
                required
              />
              <TextField
                label="תעודת זהות"
                value={form.parentId}
                onChange={handleChange('parentId')}
                error={!!errors.parentId}
                helperText={errors.parentId}
                fullWidth
                inputProps={{ maxLength: 9, dir: 'ltr' }}
              />
              <TextField
                label="טלפון"
                value={form.parentPhone}
                onChange={handleChange('parentPhone')}
                error={!!errors.parentPhone}
                helperText={errors.parentPhone}
                fullWidth
                required
                inputProps={{ dir: 'ltr' }}
                placeholder="050-1234567"
              />
            </Stack>

            <Divider sx={{ my: 3 }} />

            {/* Fees */}
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2, color: 'primary.dark' }}>
              תשלומים
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שכר לימוד חודשי"
                type="number"
                value={form.monthlyFee}
                onChange={handleChange('monthlyFee')}
                fullWidth
                InputProps={{
                  startAdornment: <InputAdornment position="start">₪</InputAdornment>,
                }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={form.siblingDiscount}
                    onChange={handleChange('siblingDiscount')}
                  />
                }
                label="הנחת אח/ות (10%-)"
              />
              {form.siblingDiscount && (
                <Alert severity="info" sx={{ borderRadius: 2 }}>
                  שכ״ל לאחר הנחה: {formatCurrency(effectiveFee)}
                </Alert>
              )}
              <TextField
                label="דמי רישום"
                type="number"
                value={form.regFee}
                onChange={handleChange('regFee')}
                fullWidth
                InputProps={{
                  startAdornment: <InputAdornment position="start">₪</InputAdornment>,
                }}
              />
            </Stack>

            <Divider sx={{ my: 3 }} />

            {/* Schedule */}
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2, color: 'primary.dark' }}>
              תקופה ושעות
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="תאריך התחלה"
                  type="date"
                  value={form.startDate}
                  onChange={handleChange('startDate')}
                  error={!!errors.startDate}
                  helperText={errors.startDate}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  required
                />
                <TextField
                  label="תאריך סיום"
                  type="date"
                  value={form.endDate}
                  onChange={handleChange('endDate')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="שעת כניסה"
                  type="time"
                  value={form.startTime}
                  onChange={handleChange('startTime')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="שעת יציאה"
                  type="time"
                  value={form.endTime}
                  onChange={handleChange('endTime')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="יציאה שישי"
                  type="time"
                  value={form.friTime}
                  onChange={handleChange('friTime')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
              </Stack>
            </Stack>

            <Divider sx={{ my: 3 }} />

            <FormControlLabel
              control={
                <Checkbox
                  checked={form.manualImport}
                  onChange={handleChange('manualImport')}
                />
              }
              label="ייבוא ידני (ללא חתימת הורה)"
              sx={{ mb: 3 }}
            />

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={saving}
              startIcon={<SaveIcon />}
            >
              {saving ? 'שומר...' : isEdit ? 'עדכן רישום' : 'צור רישום'}
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
