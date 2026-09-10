import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack, Typography,
  Table, TableHead, TableBody, TableRow, TableCell, TextField, InputAdornment,
  CircularProgress, Alert, Chip, IconButton, Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import SaveIcon from '@mui/icons-material/Save';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import { toast } from 'react-toastify';
import api from '../../api/client';
import DebtDocumentsDialog from './DebtDocumentsDialog';

/**
 * חייבים משנה שעברה — כל סניף, טבלה אחת.
 *
 * לפני המסך הזה, לראות מי חייב כסף פרושׂ על שלושה מעונות נפרדים בקליקטאק —
 * לפתוח כל מעון בנפרד, לחפש את עמודת המאזן, ולזכור מי כבר טופל. הטבלה כאן
 * קוראת בדיוק את אותו מאזן שכבר נקלט למערכת (מייצוא החוזים של קליקטאק), משתי
 * השנים שיש להן קובץ — הנוכחית והקודמת — לכל הסניפים שהמשתמש רואה, במקום
 * אחד.
 *
 * ההערה בכל שורה היא אותה הערה שבכרטיס הילד במסך ההצלבה (ReconcileDecision,
 * אותו מפתח סניף+שנה+ת"ז) — מה שנכתב כאן נראה גם שם, וההפך. אותו דבר לגבי
 * המסמכים: הסכם החזר חוב חתום שמצורף כאן מופיע גם בכרטיס הילד שם.
 *
 * `canEdit` הוא הרשאת ההערות; `canFile` היא הרשאת הקבצים, והיא צרה יותר —
 * לצרף מסמך משפטי לחוב של משפחה זו לא אותה פעולה כמו לרשום שהתקשרנו אליה.
 */

const fmtMoney = (n) => `${Number(n || 0).toLocaleString('he-IL')} ₪`;

/** שורה אחת — תא ההערה מנהל את הטיוטה שלו ושומר בנפרד, כדי שהקלדה בשורה
 * אחת לא תאבד אם משהו אחר ברשימה מתרענן. */
function NoteCell({ row, canEdit, onSave }) {
  const [draft, setDraft] = useState(row.note || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(row.note || ''); }, [row.note]);
  const dirty = draft !== (row.note || '');

  if (!canEdit) {
    return <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', minWidth: 220 }}>{row.note || '—'}</Typography>;
  }
  return (
    <Stack direction="row" spacing={0.5} alignItems="flex-start" sx={{ minWidth: 260 }}>
      <TextField size="small" multiline minRows={1} maxRows={4} fullWidth
        placeholder="סטטוס יצירת קשר…"
        value={draft} onChange={e => setDraft(e.target.value)} />
      <Tooltip title="שמירה">
        <span>
          <IconButton size="small" disabled={!dirty || saving}
            onClick={async () => {
              setSaving(true);
              try { await onSave(row, draft); } finally { setSaving(false); }
            }}>
            {saving ? <CircularProgress size={16} /> : <SaveIcon fontSize="small" color={dirty ? 'primary' : 'disabled'} />}
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

export default function DebtorsDialog({ open, onClose, canEdit = false, canFile = false }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState('all'); // 'all' | a specific academic_year string
  // The row whose papers are open. A signed repayment agreement lives on the
  // same (branch, year, ת"ז) record as the note beside it.
  const [docsRow, setDocsRow] = useState(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError('');
    api.get('/tmt/debtors')
      .then(res => setData(res.data))
      .catch(err => { setData(null); setError(err.response?.data?.error || 'שגיאה בטעינת רשימת החייבים'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (open) fetchData(); }, [open, fetchData]);

  const rows = data?.rows || [];
  const visible = useMemo(() => rows.filter((r) => {
    if (yearFilter !== 'all' && r.academic_year !== yearFilter) return false;
    const q = search.trim();
    if (!q) return true;
    return r.child_name.includes(q) || r.id_number.includes(q)
      || r.parent1?.name?.includes(q) || r.parent2?.name?.includes(q);
  }), [rows, yearFilter, search]);

  const saveNote = async (row, note) => {
    try {
      await api.put(`/tmt/decisions/${row.id_number}`, {
        branch_id: row.branch_id, academic_year: row.academic_year, note,
      });
      setData(d => ({ ...d, rows: d.rows.map(r => (r === row ? { ...r, note } : r)) }));
      toast.success('ההערה נשמרה');
    } catch (err) {
      toast.error(err.response?.data?.error || 'שגיאה בשמירת ההערה');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        חייבים — כל הסניפים
        {!!data?.total_debt && (
          <Chip size="small" color="error" sx={{ mr: 1.5 }}
            label={`סה"כ ${fmtMoney(data.total_debt)} · ${rows.length} משפחות`} />
        )}
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}

        {data && !loading && (
          <>
            {!!data.missing_uploads?.length && (
              <Alert severity="info" sx={{ mb: 2 }}>
                לא הועלה עדיין קובץ חוזים ל: {data.missing_uploads.map(m => `${m.branch_name} (${m.year_label})`).join(' · ')}
                — החייבים שם לא מופיעים כאן.
              </Alert>
            )}

            <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
              <TextField size="small" placeholder="חיפוש שם ילד/ה, הורה או ת״ז" value={search}
                onChange={e => setSearch(e.target.value)}
                InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                sx={{ minWidth: 260 }} />
              {(data.years || []).map(y => (
                <Chip key={y.year} size="small"
                  label={`${y.label} (${data.by_year?.[y.year]?.count || 0})`}
                  color={yearFilter === y.year ? 'primary' : 'default'}
                  variant={yearFilter === y.year ? 'filled' : 'outlined'}
                  onClick={() => setYearFilter(f => (f === y.year ? 'all' : y.year))} />
              ))}
            </Stack>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>מעון</TableCell>
                  <TableCell>שנה</TableCell>
                  <TableCell>שם הילד/ה</TableCell>
                  <TableCell>ת״ז</TableCell>
                  <TableCell>כיתה</TableCell>
                  <TableCell>חוב</TableCell>
                  <TableCell>הורה 1</TableCell>
                  <TableCell>הורה 2</TableCell>
                  <TableCell>רשום/ת השנה</TableCell>
                  <TableCell>מסמכים</TableCell>
                  <TableCell>הערה</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(r => (
                  <TableRow key={`${r.branch_id}-${r.academic_year}-${r.id_number}`} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch_name}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {data.years.find(y => y.year === r.academic_year)?.label || r.academic_year}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.child_name}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.id_number}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.class_name || '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Typography variant="body2" color="error.main" fontWeight={700}>
                        {fmtMoney(-r.balance)}
                      </Typography>
                      {typeof r.family_balance === 'number' && r.family_balance !== r.balance && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          משפחתי: {fmtMoney(-r.family_balance)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {r.parent1?.name || '—'}{r.parent1?.phone ? ` · ${r.parent1.phone}` : ''}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {r.parent2?.name || '—'}{r.parent2?.phone ? ` · ${r.parent2.phone}` : ''}
                    </TableCell>
                    <TableCell>
                      {r.active_this_year == null ? (
                        <Typography variant="caption" color="text.disabled">—</Typography>
                      ) : (
                        <Chip size="small" color={r.active_this_year ? 'success' : 'default'}
                          label={r.active_this_year ? 'כן' : 'לא'} />
                      )}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Button
                        size="small"
                        startIcon={<AttachFileIcon fontSize="small" />}
                        variant={r.documents_count ? 'outlined' : 'text'}
                        onClick={() => setDocsRow(r)}
                      >
                        {r.documents_count || 'הוספה'}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <NoteCell row={r} canEdit={canEdit} onSave={saveNote} />
                    </TableCell>
                  </TableRow>
                ))}
                {!visible.length && (
                  <TableRow><TableCell colSpan={11} align="center" sx={{ py: 3 }}>
                    <Typography color="text.secondary">אין חייבים להצגה</Typography>
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>סגירה</Button>
      </DialogActions>

      <DebtDocumentsDialog
        open={Boolean(docsRow)}
        row={docsRow}
        canEdit={canFile}
        onClose={() => { setDocsRow(null); fetchData(); }}
      />
    </Dialog>
  );
}
