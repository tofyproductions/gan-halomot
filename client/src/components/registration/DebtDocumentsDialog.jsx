import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography,
  Box, IconButton, Tooltip, Alert, CircularProgress, Switch, FormControlLabel,
  LinearProgress, Divider,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DescriptionIcon from '@mui/icons-material/Description';
import { toast } from 'react-toastify';
import api from '../../api/client';

/**
 * The papers behind one family's debt.
 *
 * Opened from the חייבים table and from the child's card on the reconciliation
 * screen — the same (branch, year, ת"ז) record in both, so a document attached
 * in one place is there in the other.
 *
 * What it is for, in practice, is the signed repayment agreement. That shapes
 * every choice here: files are not editable once uploaded, sharing with the
 * family is a switch somebody has to throw, and deleting warns in full
 * sentences rather than asking "are you sure?".
 */

const fmtSize = (n) => {
  const mb = (Number(n) || 0) / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round((Number(n) || 0) / 1024))}KB`;
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

export default function DebtDocumentsDialog({ open, onClose, row, canEdit = false }) {
  const [docs, setDocs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fileInput = useRef(null);

  const params = row && {
    branch_id: row.branch_id,
    academic_year: row.academic_year,
  };
  const base = row && `/tmt/decisions/${row.id_number}/documents`;

  const load = useCallback(async () => {
    if (!row) return;
    setError('');
    try {
      const res = await api.get(base, { params });
      setDocs(res.data.documents || []);
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו לטעון את המסמכים');
      setDocs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id_number, row?.branch_id, row?.academic_year]);

  useEffect(() => { if (open) { setDocs(null); load(); } }, [open, load]);

  const upload = async (files) => {
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        form.append('branch_id', row.branch_id);
        form.append('academic_year', row.academic_year);
        const res = await api.post(base, form);
        setDocs(res.data.documents || []);
      }
      toast.success('הקובץ נשמר');
    } catch (err) {
      setError(err.response?.data?.error || 'ההעלאה נכשלה');
    } finally {
      setUploading(false);
    }
  };

  const openFile = async (doc) => {
    setBusy(true);
    try {
      const res = await api.get(`${base}/${doc.id}/file`, { params });
      // A signed link, valid for half an hour. Opened rather than downloaded —
      // most of these are a photograph of a signed page and the office wants
      // to look at it, not collect it.
      window.open(res.data.url, '_blank', 'noopener');
    } catch (err) {
      setError(err.response?.data?.error || 'לא הצלחנו לפתוח את הקובץ');
    } finally {
      setBusy(false);
    }
  };

  const toggleShare = async (doc, value) => {
    setBusy(true);
    try {
      const res = await api.patch(`${base}/${doc.id}`, {
        ...params, visible_to_parent: value,
      });
      setDocs(res.data.documents || []);
    } catch (err) {
      setError(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc) => {
    setBusy(true);
    try {
      const res = await api.delete(`${base}/${doc.id}`, { params });
      setDocs(res.data.documents || []);
      setConfirmDelete(null);
      toast.info(`המסמך נמחק. עותק נשלח במייל למנהלי המערכת ויישמר עוד ${res.data.grace_days} ימים.`);
    } catch (err) {
      setError(err.response?.data?.error || 'המחיקה נכשלה');
    } finally {
      setBusy(false);
    }
  };

  if (!row) return null;

  return (
    <>
      <Dialog open={open} onClose={busy || uploading ? undefined : onClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          מסמכים — {row.child_name}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {row.branch_name} · ת״ז {row.id_number}
          </Typography>
        </DialogTitle>

        <DialogContent>
          {uploading && <LinearProgress sx={{ mb: 2 }} />}
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

          {docs === null && (
            <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress size={24} /></Box>
          )}

          {docs?.length === 0 && (
            <Alert severity="info">
              אין עדיין מסמכים. כאן שומרים הסכם החזר חוב חתום, או כל מסמך אחר
              שקשור לחוב של המשפחה.
            </Alert>
          )}

          <Stack spacing={1} sx={{ mt: docs?.length ? 0 : 2 }}>
            {(docs || []).map(doc => (
              <Box
                key={doc.id}
                sx={{
                  p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider',
                  bgcolor: 'background.default',
                }}
              >
                <Stack direction="row" alignItems="center" spacing={1}>
                  <DescriptionIcon fontSize="small" color="action" />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>{doc.file_name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {fmtSize(doc.bytes)} · הועלה {fmtDate(doc.uploaded_at)}
                      {doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ''}
                    </Typography>
                  </Box>
                  <Tooltip title="פתיחה">
                    <span>
                      <IconButton size="small" disabled={busy} onClick={() => openFile(doc)}>
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  {canEdit && (
                    <Tooltip title="מחיקה">
                      <span>
                        <IconButton size="small" color="error" disabled={busy}
                          onClick={() => setConfirmDelete(doc)}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>

                {/* Off by default and turned on one file at a time. Everything
                    else attached here is the office's own. */}
                <FormControlLabel
                  sx={{ mt: 0.5 }}
                  control={(
                    <Switch
                      size="small"
                      checked={Boolean(doc.visible_to_parent)}
                      disabled={!canEdit || busy}
                      onChange={(e) => toggleShare(doc, e.target.checked)}
                    />
                  )}
                  label={(
                    <Typography variant="caption">
                      {doc.visible_to_parent
                        ? 'מוצג להורה בפורטל'
                        : 'לא מוצג להורה'}
                    </Typography>
                  )}
                />
              </Box>
            ))}
          </Stack>

          {canEdit && (
            <>
              <Divider sx={{ my: 2 }} />
              <input
                ref={fileInput} type="file" hidden multiple
                accept="image/*,application/pdf"
                onChange={(e) => {
                  const files = [...(e.target.files || [])];
                  e.target.value = '';
                  if (files.length) upload(files);
                }}
              />
              <Button
                variant="outlined" startIcon={<UploadFileIcon />}
                disabled={uploading || busy}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? 'מעלה…' : 'הוספת מסמך'}
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                תמונה או PDF, עד 25MB לקובץ. אפשר להעלות כמה קבצים.
              </Typography>
            </>
          )}
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose} disabled={busy || uploading}>סגירה</Button>
        </DialogActions>
      </Dialog>

      {/* Full sentences, not "are you sure?". What is being deleted is usually
          the only evidence a family agreed to repay anything. */}
      <Dialog open={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>מחיקת מסמך</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            <b>{confirmDelete?.file_name}</b> יימחק מהמסך הזה מיד.
          </Alert>
          <Typography variant="body2">
            עותק של הקובץ יישלח במייל לכל מנהלי המערכת, והקובץ עצמו יישמר במערכת
            עוד שבוע לפני שיימחק לצמיתות. אם זו טעות — אפשר יהיה לשחזר אותו מהמייל.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)} disabled={busy}>ביטול</Button>
          <Button color="error" variant="contained" disabled={busy}
            onClick={() => remove(confirmDelete)}>
            {busy ? 'מוחק…' : 'מחיקה'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
