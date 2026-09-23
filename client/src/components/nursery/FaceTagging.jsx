import {
  useState, useEffect, useCallback, useRef,
} from 'react';
import {
  Box, Card, CardContent, Typography, Stack, Button, Alert, CircularProgress,
  LinearProgress, TextField, MenuItem, Chip, Snackbar,
} from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import BlockIcon from '@mui/icons-material/Block';
import api, { apiError } from '../../api/client';

/**
 * "מי זה?" — מסך אחד, פרצוף אחד, הקשה אחת.
 *
 * זה המסך שכל הפיצ'ר חי או מת עליו. לשלוח תמונה לקבוצת הווטסאפ עולה לגננת
 * אפס: מצלמת, משתפת, נגמר. אם לזהות פרצוף כאן לוקח לה יותר משתי שניות היא
 * תחזור לווטסאפ, והגלריה תישאר ריקה גם אם הזיהוי מושלם.
 *
 * לכן אין כאן שדה חיפוש ואין רשימה של 220 ילדים. המערכת כבר יודעת מאיזו כיתה
 * התמונה ומי נכח באותו בוקר, ולכן על המסך יושבים בערך תריסר שמות והפעולה היא
 * הקשה אחת.
 *
 * ושלושה דברים נוספים קיימים רק בשביל השתי שניות האלה:
 * - המסך עובר לפרצוף הבא **מיד**, לפני שהשרת ענה. אם משהו נכשל זה חוזר
 *   כהודעה, אבל האצבע לא מחכה לרשת.
 * - התמונות הבאות נטענות מראש, כך שאף פרצוף לא מופיע כריבוע ריק.
 * - העבודה מצטמצמת תוך כדי: כל שם יוצר טביעת ייחוס, והשרת חוזר על התמונות
 *   שכבר צולמו — אז ילד שתויג פעם אחת לא יחזור לתור הזה.
 */

const PREFETCH = 4;

export default function FaceTagging({ onWaitingChange }) {
  const [classrooms, setClassrooms] = useState([]);
  const [classroomId, setClassroomId] = useState('');
  const [queue, setQueue] = useState([]);
  const [progress, setProgress] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [done, setDone] = useState(0);

  // כתובות blob לתמונות שכבר נטענו. blob ולא src ישיר כי הנתיב דורש טוקן,
  // ותג img רגיל לא נושא אותו.
  const crops = useRef(new Map());
  const [cropUrl, setCropUrl] = useState('');
  // מטמון לרשימות השמות: אותה כיתה באותו יום נשאלת שוב ושוב.
  const candidateCache = useRef(new Map());

  const current = queue[0];

  useEffect(() => () => {
    crops.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    api.get('/photos/classrooms')
      .then(({ data }) => setClassrooms(data.classrooms || []))
      .catch((e) => setError(apiError(e)));
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/face-tagging/queue', {
        params: { classroom_id: classroomId || undefined, limit: 12 },
      });
      setQueue(data.faces || []);
      setProgress(data.progress);
      if (onWaitingChange) onWaitingChange(data.progress ? data.progress.waiting : 0);
      setError('');
    } catch (e) {
      setError(apiError(e));
    } finally {
      setLoading(false);
    }
  }, [classroomId, onWaitingChange]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  /** מוריד חיתוך פרצוף ושומר אותו במטמון. */
  const fetchCrop = useCallback(async (face) => {
    const key = `${face.photo_id}:${face.face_index}`;
    if (crops.current.has(key)) return crops.current.get(key);
    const { data } = await api.get(face.crop_url, { responseType: 'blob' });
    const url = URL.createObjectURL(data);
    crops.current.set(key, url);
    return url;
  }, []);

  // התמונה הנוכחית, ומיד אחריה הבאות — כדי שההקשה הבאה לא תמתין לרשת.
  useEffect(() => {
    if (!current) { setCropUrl(''); return; }
    let alive = true;
    fetchCrop(current).then((url) => { if (alive) setCropUrl(url); }).catch(() => {});
    queue.slice(1, 1 + PREFETCH).forEach((f) => { fetchCrop(f).catch(() => {}); });
    return () => { alive = false; };
  }, [current, queue, fetchCrop]);

  // מי יכול להיות בתמונה הזו — לפי הכיתה והיום של התמונה עצמה, לא לפי הבורר
  // שלמעלה: התור יכול לערבב כיתות כשלא נבחרה אחת.
  useEffect(() => {
    if (!current) { setCandidates([]); return; }
    const key = `${current.classroom_id}:${current.date}`;
    if (candidateCache.current.has(key)) {
      setCandidates(candidateCache.current.get(key));
      return;
    }
    api.get('/face-tagging/candidates', {
      params: { classroom_id: current.classroom_id, date: current.date },
    }).then(({ data }) => {
      candidateCache.current.set(key, data.children || []);
      setCandidates(data.children || []);
    }).catch((e) => setError(apiError(e)));
  }, [current]);

  /**
   * ההקשה. עוברים לפרצוף הבא מיד ושולחים לשרת ברקע — הרשת לא אמורה לעמוד בין
   * הגננת לבין הפרצוף הבא. כשלון חוזר כהודעה ולא כמסך תקוע.
   */
  const decide = useCallback((body, label) => {
    if (!current) return;
    const face = current;
    setQueue((q) => q.slice(1));
    setDone((n) => n + 1);
    setProgress((pr) => (pr ? { ...pr, waiting: Math.max(0, pr.waiting - 1) } : pr));
    if (onWaitingChange) onWaitingChange(Math.max(0, (progress ? progress.waiting : 1) - 1));

    api.post(`/face-tagging/${face.photo_id}/${face.face_index}`, body)
      .then(({ data }) => {
        if (data.taught === false) setToast('סומן, אך מאוחר מדי כדי ללמד מזה');
        else if (data.at_ceiling) setToast(`${label} — יש מספיק תמונות, לא צריך עוד`);
      })
      .catch((e) => setToast(`לא נשמר: ${apiError(e)}`));
  }, [current, progress, onWaitingChange]);

  // כשנגמר התור — לבדוק אם השרת סיים לשייך עוד בינתיים.
  useEffect(() => {
    if (!loading && !queue.length && done > 0) {
      const t = setTimeout(loadQueue, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [queue.length, loading, done, loadQueue]);

  const waiting = progress ? progress.waiting : 0;
  const named = progress ? progress.named : 0;
  const total = progress ? progress.faces : 0;

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto' }}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="כיתה"
          value={classroomId}
          onChange={(e) => setClassroomId(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">כל הכיתות שלי</MenuItem>
          {classrooms.map((c) => (
            <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
          ))}
        </TextField>
        {progress && (
          <Typography variant="body2" color="text.secondary">
            {`זוהו ${named} מתוך ${total} · ממתינים ${waiting}`}
          </Typography>
        )}
      </Stack>

      {total > 0 && (
        <LinearProgress
          variant="determinate"
          value={Math.round((100 * named) / total)}
          sx={{ mb: 2, height: 8, borderRadius: 4 }}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && (
        <Stack alignItems="center" sx={{ py: 8 }}><CircularProgress /></Stack>
      )}

      {!loading && !current && (
        <Card>
          <CardContent>
            <Stack spacing={1} alignItems="center" sx={{ py: 5 }}>
              <Typography variant="h6">אין פרצופים שממתינים</Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                כל מה שהמערכת לא הצליחה לזהות כבר קיבל שם.
                {done > 0 && ` תייגת ${done} בפעם הזו.`}
              </Typography>
              <Button onClick={loadQueue} sx={{ mt: 1 }}>בדיקה מחדש</Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {!loading && current && (
        <Card>
          <CardContent>
            <Stack spacing={2} alignItems="center">
              <Typography variant="h6">מי זה?</Typography>

              <Box
                sx={{
                  width: 260,
                  height: 260,
                  borderRadius: 3,
                  overflow: 'hidden',
                  bgcolor: 'grey.200',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {cropUrl
                  ? <Box component="img" src={cropUrl} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <CircularProgress size={28} />}
              </Box>

              <Typography variant="caption" color="text.secondary">
                {current.date}
              </Typography>

              {/* הכפתורים הם הילדים שנכחו באותו בוקר. ילד שעדיין אין לו
                  תמונות ייחוס מסומן — הוא זה שהתיוג שלו באמת מקדם. */}
              <Stack
                direction="row"
                flexWrap="wrap"
                justifyContent="center"
                sx={{ gap: 1, pt: 1 }}
              >
                {candidates.map((c) => (
                  <Button
                    key={c.id}
                    variant={c.references ? 'outlined' : 'contained'}
                    size="large"
                    onClick={() => decide({ child_id: c.id }, c.name)}
                    sx={{ minWidth: 132, minHeight: 52, borderRadius: 2 }}
                  >
                    {c.name}
                    {!c.references && (
                      <Chip label="חדש" size="small" sx={{ ml: 1, height: 18 }} />
                    )}
                  </Button>
                ))}
              </Stack>

              {!candidates.length && (
                <Alert severity="info" sx={{ width: '100%' }}>
                  אין רשימת נוכחות ליום הזה ולכיתה הזו, ולכן אין את מי להציע.
                </Alert>
              )}

              <Stack direction="row" spacing={1} sx={{ pt: 1 }}>
                <Button
                  startIcon={<BlockIcon />}
                  color="inherit"
                  onClick={() => decide({ not_a_child: true }, '')}
                >
                  זה לא ילד
                </Button>
                <Button
                  startIcon={<HelpOutlineIcon />}
                  color="inherit"
                  onClick={() => setQueue((q) => [...q.slice(1), q[0]])}
                >
                  לא בטוחה — אחר כך
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
      />
    </Box>
  );
}
