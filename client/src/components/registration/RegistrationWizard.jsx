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

const DEFAULT_FORM = {
  child_name: '',
  child_birth_date: '',
  parent_name: '',
  parent_id_number: '',
  parent_phone: '',
  classroom_id: '',
  monthly_fee: 3200,
  sibling_discount: false,
  registration_fee: 500,
  start_date: '',
  end_date: '',
  start_time: '07:30',
  end_time: '16:00',
  fri_time: '12:30',
  manual_import: false,
};

export default function RegistrationWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = !!id;

  const [form, setForm] = useState(DEFAULT_FORM);
  const [classrooms, setClassrooms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState({});

  // Load classrooms
  useEffect(() => {
    api.get('/classrooms')
      .then((res) => setClassrooms(res.data.classrooms || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isEdit) {
      setLoading(true);
      api.get(`/registrations/${id}`)
        .then((res) => {
          const d = res.data.registration || res.data;
          const config = d.configuration || {};
          setForm({
            child_name: d.child_name || '',
            child_birth_date: d.child_birth_date ? new Date(d.child_birth_date).toISOString().slice(0, 10) : '',
            parent_name: d.parent_name || '',
            parent_id_number: d.parent_id_number || '',
            parent_phone: d.parent_phone || '',
            classroom_id: d.classroom_id || '',
            monthly_fee: d.monthly_fee ?? 3200,
            sibling_discount: config.sibling_discount || false,
            registration_fee: d.registration_fee ?? 500,
            start_date: d.start_date ? new Date(d.start_date).toISOString().slice(0, 10) : '',
            end_date: d.end_date ? new Date(d.end_date).toISOString().slice(0, 10) : '',
            start_time: config.start_time || '07:30',
            end_time: config.end_time || '16:00',
            fri_time: config.fri_time || '12:30',
            manual_import: config.manual_import || false,
          });
        })
        .catch(() => toast.error('שגיאה בטעינת הרישום'))
        .finally(() => setLoading(false));
    }
  }, [id, isEdit]);

  const effectiveFee = form.sibling_discount
    ? Math.round(form.monthly_fee * 0.9)
    : form.monthly_fee;

  const isGarbled = (n) => /[�?]{2,}/.test(String(n || ''));
  const cleanClassrooms = classrooms.filter(c => !isGarbled(c.name));
  const CATEGORIES = ['תינוקייה', 'צעירים', 'בוגרים'];
  const otherCats = cleanClassrooms.filter(c => !CATEGORIES.includes(c.category));
  const orderedClassrooms = [
    ...CATEGORIES.flatMap(cat => cleanClassrooms.filter(c => c.category === cat)),
    ...otherCats,
  ];

  const selectedClassroom = cleanClassrooms.find(c => String(c._id || c.id) === String(form.classroom_id));
  const capacity = selectedClassroom?.capacity || 0;
  const childCount = selectedClassroom?.child_count || 0;
  const isFull = capacity > 0 && childCount >= capacity;
  const sameCategoryCount = selectedClassroom?.category
    ? cleanClassrooms.filter(c => c.category === selectedClassroom.category).length
    : 0;

  const handleChange = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((prev) => ({ ...prev, [field]: val }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const errs = {};
    if (!form.child_name.trim()) errs.child_name = 'שדה חובה';
    if (!form.parent_name.trim()) errs.parent_name = 'שדה חובה';
    if (!form.parent_phone.trim()) errs.parent_phone = 'שדה חובה';
    if (form.parent_id_number && !isValidIsraeliID(form.parent_id_number)) errs.parent_id_number = 'תעודת זהות לא תקינה';
    if (!form.classroom_id) errs.classroom_id = 'יש לבחור כיתה';
    if (!form.start_date) errs.start_date = 'שדה חובה';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const payload = {
        child_name: form.child_name,
        child_birth_date: form.child_birth_date || null,
        parent_name: form.parent_name,
        parent_id_number: form.parent_id_number || null,
        parent_phone: form.parent_phone,
        classroom_id: form.classroom_id || null,
        monthly_fee: effectiveFee,
        registration_fee: form.registration_fee,
        start_date: form.start_date,
        end_date: form.end_date || form.start_date,
        configuration: {
          sibling_discount: form.sibling_discount,
          start_time: form.start_time,
          end_time: form.end_time,
          fri_time: form.fri_time,
          manual_import: form.manual_import,
        },
      };

      let res;
      if (isEdit) {
        res = await api.put(`/registrations/${id}`, payload);
        toast.success('הרישום עודכן בהצלחה');
      } else {
        res = await api.post('/registrations', payload);
        toast.success('הרישום נוצר בהצלחה');
      }

      const data = res.data.registration || res.data;
      if (data.access_token) {
        const link = `${window.location.origin}/register/${data.access_token}`;
        setResult({ link, token: data.access_token, id: data._id || data.id });
      } else {
        navigate('/');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירת הרישום');
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
    const phone = form.parent_phone.replace(/^0/, '972');
    const text = encodeURIComponent(
      `שלום ${form.parent_name}, שמחים שהצטרפתם לגן החלומות!\nלהשלמת הרישום אנא היכנסו לקישור וחתמו על החוזה:\n${result.link}`
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
                value={form.child_name}
                onChange={handleChange('child_name')}
                error={!!errors.child_name}
                helperText={errors.child_name}
                fullWidth
                required
              />
              <TextField
                label="תאריך לידה"
                type="date"
                value={form.child_birth_date}
                onChange={handleChange('child_birth_date')}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label="כיתה"
                select
                value={form.classroom_id}
                onChange={handleChange('classroom_id')}
                error={!!errors.classroom_id}
                helperText={errors.classroom_id || (selectedClassroom?.category ? `קבוצה: ${selectedClassroom.category}` : '')}
                fullWidth
                required
              >
                {orderedClassrooms.map((c) => {
                  const cap = c.capacity || 0;
                  const cnt = c.child_count || 0;
                  const full = cap > 0 && cnt >= cap;
                  const label = `${c.name}${c.category ? ` · ${c.category}` : ''}${cap ? ` (${cnt}/${cap})` : ''}${full ? ' — מלאה' : ''}`;
                  return (
                    <MenuItem key={c._id || c.id} value={c._id || c.id}>{label}</MenuItem>
                  );
                })}
              </TextField>
              {isFull && (
                <Alert severity="warning" sx={{ borderRadius: 2 }}>
                  כיתה זו מלאה ({childCount}/{capacity}).
                  {sameCategoryCount > 1
                    ? ' ניתן לבחור כיתה אחרת מאותה קבוצה, או להמשיך בשיקול דעת.'
                    : ' אין כיתה נוספת באותה קבוצה — שיבוץ בשיקול דעת המנהל/ת.'}
                </Alert>
              )}
            </Stack>

            <Divider sx={{ my: 3 }} />

            {/* Parent Details */}
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2, color: 'primary.dark' }}>
              פרטי ההורה
            </Typography>
            <Stack spacing={2} sx={{ mb: 3 }}>
              <TextField
                label="שם ההורה"
                value={form.parent_name}
                onChange={handleChange('parent_name')}
                error={!!errors.parent_name}
                helperText={errors.parent_name}
                fullWidth
                required
              />
              <TextField
                label="תעודת זהות"
                value={form.parent_id_number}
                onChange={handleChange('parent_id_number')}
                error={!!errors.parent_id_number}
                helperText={errors.parent_id_number}
                fullWidth
                inputProps={{ maxLength: 9, dir: 'ltr' }}
              />
              <TextField
                label="טלפון"
                value={form.parent_phone}
                onChange={handleChange('parent_phone')}
                error={!!errors.parent_phone}
                helperText={errors.parent_phone}
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
                value={form.monthly_fee}
                onChange={handleChange('monthly_fee')}
                fullWidth
                InputProps={{
                  startAdornment: <InputAdornment position="start">₪</InputAdornment>,
                }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={form.sibling_discount}
                    onChange={handleChange('sibling_discount')}
                  />
                }
                label="הנחת אח/ות (10%-)"
              />
              {form.sibling_discount && (
                <Alert severity="info" sx={{ borderRadius: 2 }}>
                  שכ״ל לאחר הנחה: {formatCurrency(effectiveFee)}
                </Alert>
              )}
              <TextField
                label="דמי רישום"
                type="number"
                value={form.registration_fee}
                onChange={handleChange('registration_fee')}
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
                  value={form.start_date}
                  onChange={handleChange('start_date')}
                  error={!!errors.start_date}
                  helperText={errors.start_date}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  required
                />
                <TextField
                  label="תאריך סיום"
                  type="date"
                  value={form.end_date}
                  onChange={handleChange('end_date')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label="שעת כניסה"
                  type="time"
                  value={form.start_time}
                  onChange={handleChange('start_time')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="שעת יציאה"
                  type="time"
                  value={form.end_time}
                  onChange={handleChange('end_time')}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label="יציאה שישי"
                  type="time"
                  value={form.fri_time}
                  onChange={handleChange('fri_time')}
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
                  checked={form.manual_import}
                  onChange={handleChange('manual_import')}
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
