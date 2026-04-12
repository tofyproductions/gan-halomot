import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from '@mui/material';

export default function ConfirmDialog({ open, onClose, onConfirm, title, message }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dir="rtl"
      PaperProps={{ sx: { borderRadius: 4, minWidth: 360 } }}
    >
      <DialogTitle sx={{ fontWeight: 700 }}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{message}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button onClick={onClose} color="inherit" variant="outlined">
          ביטול
        </Button>
        <Button onClick={onConfirm} variant="contained" color="error" autoFocus>
          אישור
        </Button>
      </DialogActions>
    </Dialog>
  );
}
