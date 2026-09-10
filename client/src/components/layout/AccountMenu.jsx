import { useCallback } from 'react';
import { Dialog, DialogTitle, DialogContent, Button, Stack, Divider, Typography } from '@mui/material';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import DeleteAccountRequest from '../shared/DeleteAccountRequest';

/**
 * The two things the old Header kept in the foot of its drawer that were never
 * navigation: enrolling a fingerprint, and asking for the account to be
 * deleted. Both belong to the person rather than to any screen, so they live
 * behind the gear at the foot of the rail.
 *
 * DELIBERATELY NOT /account. That route is MyAccount.jsx — the gan's
 * commercial screen, what they pay and why — and App.jsx gates it to
 * system_admin. Putting fingerprint enrolment behind it would have taken it
 * from every branch manager, teacher and assistant, which is exactly the group
 * that signs in on a phone in a room and wants it. The billing screen is
 * offered here as a link instead, and only to the person who has it.
 */
export default function AccountMenu({ open, onClose }) {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();

  const handleSetupBiometric = useCallback(async () => {
    try {
      const optionsRes = await api.post('/auth/webauthn/register/options');
      const credential = await startRegistration({ optionsJSON: optionsRes.data });
      await api.post('/auth/webauthn/register/verify', { credential });
      localStorage.setItem('gan_biometric_user_id', user.id);
      toast.success('כניסה ביומטרית הוגדרה בהצלחה!');
    } catch (err) {
      // The browser's own "not now" is not an error worth a red toast.
      if (err.name === 'NotAllowedError') return;
      toast.error(err.response?.data?.error || 'שגיאה בהגדרת ביומטרי');
    }
  }, [user]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 0.5 }}>
        {user?.full_name || user?.email}
        <Typography variant="caption" component="div" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          חשבון והגדרות
        </Typography>
      </DialogTitle>

      <DialogContent>
        <Stack spacing={1} sx={{ pt: 1, pb: 1 }}>
          <Button
            startIcon={<FingerprintIcon />}
            onClick={handleSetupBiometric}
            fullWidth
            variant="outlined"
            sx={{ justifyContent: 'flex-start' }}
          >
            הפעלת כניסה בטביעת אצבע
          </Button>

          {/* Offering a door that answers with a permission error is worse
              than not offering it. */}
          {isAdmin && (
            <Button
              startIcon={<ReceiptLongIcon />}
              onClick={() => { onClose(); navigate('/account'); }}
              fullWidth
              variant="outlined"
              sx={{ justifyContent: 'flex-start' }}
            >
              המנוי והחיוב של הגן
            </Button>
          )}

          <Divider sx={{ pt: 1 }} />
          <DeleteAccountRequest />
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
