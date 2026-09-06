import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
  Button, ListItemButton, ListItemIcon, ListItemText, CircularProgress,
  IconButton, Tooltip,
} from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { toast } from 'react-toastify';

/**
 * "Delete my account" — files the request, does not act on it.
 *
 * A click here never deletes anything by itself. It creates a row in
 * DataDeletionRequest that sits pending until someone at the gan's office
 * reviews it and completes it deliberately (server/src/services/dataDeletion
 * .service.js). See landing/app-data-deletion.html for what that ends up
 * meaning field by field — this button is one way to start that, the public
 * page describes the rest (including for someone who already left and has
 * no account to click a button from).
 */
export default function DeleteAccountRequest({ client, endpoint = '/data-deletion/me', variant = 'listItem' }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      await client.post(endpoint);
      toast.success('הבקשה נשלחה. המשרד יטפל בה בהקדם.');
      setOpen(false);
    } catch {
      toast.error('שליחת הבקשה נכשלה. נסו שוב, או פנו למשרד ישירות.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {variant === 'icon' ? (
        <Tooltip title="מחיקת חשבון">
          <IconButton
            onClick={() => setOpen(true)} aria-label="מחיקת חשבון" size="small"
            sx={{ color: 'inherit', bgcolor: 'rgba(255,255,255,0.16)' }}
          >
            <DeleteForeverIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : (
        <ListItemButton onClick={() => setOpen(true)} sx={{ minHeight: 48 }}>
          <ListItemIcon sx={{ minWidth: 40 }}><DeleteForeverIcon color="error" /></ListItemIcon>
          <ListItemText primary="מחיקת חשבון" slotProps={{ primary: { color: 'error' } }} />
        </ListItemButton>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} dir="rtl">
        <DialogTitle>מחיקת חשבון</DialogTitle>
        <DialogContent>
          <DialogContentText>
            תישלח בקשה למחיקת החשבון והפרטים האישיים שלכם. המשרד יבדוק ויבצע
            אותה — זה לא קורה מיידית, ואפשר לפנות ישירות למשרד אם דחוף.
            פרטים על מה בדיוק נמחק ומה נשמר: /app/data-deletion.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={loading}>ביטול</Button>
          <Button onClick={submit} color="error" variant="contained" disabled={loading}>
            {loading ? <CircularProgress size={20} color="inherit" /> : 'שליחת בקשה'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
