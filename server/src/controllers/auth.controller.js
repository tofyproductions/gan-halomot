const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { User, Setting } = require('../models');
const env = require('../config/env');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

/**
 * Tab overrides applied to EVERY user of a role (edited once in the admin
 * permissions screen — "add X to all branch managers"). Precedence when the
 * client resolves access: per-user override > role override > role default.
 */
async function roleTabOverrides(role) {
  try {
    const doc = await Setting.findOne({ key: 'role_tab_overrides' }).lean();
    const map = doc?.value || {};
    const entry = map[role] || {};
    return {
      add: Array.isArray(entry.add) ? entry.add : [],
      remove: Array.isArray(entry.remove) ? entry.remove : [],
    };
  } catch { return { add: [], remove: [] }; }
}

const RP_NAME = 'גן החלומות';
const RP_ID = env.NODE_ENV === 'production' ? 'gan-halomot.onrender.com' : 'localhost';
const ORIGIN = env.NODE_ENV === 'production'
  ? 'https://gan-halomot.onrender.com'
  : 'http://localhost:5173';

function makeToken(user, rememberMe, roleTabs = { add: [], remove: [] }) {
  // Resolve managed_branch_ids: explicit value first, single-branch managers
  // fall back to [branch_id] so they don't need separate configuration.
  let managed = (user.managed_branch_ids || []).map(b => b?._id || b).filter(Boolean);
  if (managed.length === 0 && user.role === 'branch_manager' && user.branch_id) {
    managed = [user.branch_id?._id || user.branch_id];
  }
  const payload = {
    id: user._id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    branch_id: user.branch_id?._id || user.branch_id,
    branch_name: user.branch_id?.name || null,
    managed_branch_ids: managed.map(x => String(x)),
    position: user.position,
    tab_overrides_add: user.tab_overrides_add || [],
    tab_overrides_remove: user.tab_overrides_remove || [],
    role_tab_add: roleTabs.add || [],
    role_tab_remove: roleTabs.remove || [],
    password_set: !!user.password_set,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: rememberMe ? '30d' : '24h' });
  return { token, user: payload };
}

// Locate the login user by name + national id (the credentials pair).
async function findLoginUser(full_name, id_number) {
  const cleanedId = String(id_number || '').replace(/\D/g, '').trim();
  const cleanedName = String(full_name || '').trim();
  if (!cleanedId || !cleanedName) return null;
  return User.findOne({
    full_name: { $regex: new RegExp(`^${cleanedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    id_number: cleanedId,
    is_active: true,
  }).populate('branch_id', 'name');
}

// Step 1 of login: verify name + national id. If the user has chosen a login
// password, we STOP here and tell the client to ask for it (no token issued).
// If they haven't, we log them in as before but flag password_prompt so the
// client nags them to set one.
async function login(req, res, next) {
  try {
    const { full_name, id_number, rememberMe } = req.body;
    if (!full_name || !id_number) {
      return res.status(400).json({ error: 'שם ותעודת זהות נדרשים' });
    }
    const user = await findLoginUser(full_name, id_number);
    if (!user) {
      return res.status(401).json({ error: 'שם או תעודת זהות שגויים' });
    }

    if (user.password_set) {
      // Require the password (or biometric) before issuing any token. Return the
      // user id + webauthn flag so the password screen can offer fingerprint as
      // a replacement for typing the password.
      return res.json({
        needs_password: true,
        full_name: user.full_name,
        user_id: String(user._id),
        hasWebauthn: (user.webauthn_credentials || []).length > 0,
      });
    }

    const result = makeToken(user, rememberMe, await roleTabOverrides(user.role));
    result.hasWebauthn = (user.webauthn_credentials || []).length > 0;
    result.password_prompt = true; // no password chosen yet → nag on the client
    res.json(result);
  } catch (error) {
    next(error);
  }
}

// Step 2 of login (only when password_set): name + id + password.
async function loginWithPassword(req, res, next) {
  try {
    const { full_name, id_number, password, rememberMe } = req.body;
    if (!full_name || !id_number || !password) {
      return res.status(400).json({ error: 'שם, תעודת זהות וסיסמה נדרשים' });
    }
    const user = await findLoginUser(full_name, id_number);
    if (!user || !user.password_set) {
      return res.status(401).json({ error: 'פרטי התחברות שגויים' });
    }
    const ok = await bcrypt.compare(String(password), user.password_hash || '');
    if (!ok) {
      return res.status(401).json({ error: 'סיסמה שגויה' });
    }
    const result = makeToken(user, rememberMe, await roleTabOverrides(user.role));
    result.hasWebauthn = (user.webauthn_credentials || []).length > 0;
    res.json(result);
  } catch (error) {
    next(error);
  }
}

// Authenticated user sets/changes their own login password.
async function setPassword(req, res, next) {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'סיסמה חייבת להיות לפחות 4 תווים' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    user.password_hash = await bcrypt.hash(String(password), 10);
    user.password_set = true;
    await user.save();
    res.json({ ok: true, password_set: true });
  } catch (error) {
    next(error);
  }
}

async function logout(req, res, next) {
  try {
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.user.id)
      .select('-password_hash')
      .populate('branch_id', 'name');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const roleTabs = await roleTabOverrides(user.role);
    res.json({
      user: {
        ...user.toObject(),
        id: user._id,
        branch_name: user.branch_id?.name || null,
        hasWebauthn: (user.webauthn_credentials || []).length > 0,
        role_tab_add: roleTabs.add,
        role_tab_remove: roleTabs.remove,
      },
    });
  } catch (error) {
    next(error);
  }
}

// --- WebAuthn Registration (requires logged-in user) ---

async function webauthnRegisterOptions(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existingCreds = (user.webauthn_credentials || []).map(c => ({
      id: c.credential_id,
      type: 'public-key',
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.full_name,
      userID: new TextEncoder().encode(String(user._id)),
      attestationType: 'none',
      excludeCredentials: existingCreds,
      authenticatorSelection: {
        // 'platform' = the device's BUILT-IN biometric (Touch ID / Windows Hello /
        // Android fingerprint). Without it the browser also offers roaming/cross-
        // device passkeys and shows the "Passkeys & Security Keys" QR dialog
        // instead of the fingerprint prompt.
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    user.webauthn_challenge = options.challenge;
    await user.save();

    res.json(options);
  } catch (error) {
    next(error);
  }
}

async function webauthnRegisterVerify(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: user.webauthn_challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'אימות נכשל' });
    }

    const { credential } = verification.registrationInfo;

    user.webauthn_credentials.push({
      credential_id: Buffer.from(credential.id).toString('base64url'),
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      device_name: req.body.deviceName || 'מכשיר',
    });
    user.webauthn_challenge = null;
    await user.save();

    res.json({ verified: true });
  } catch (error) {
    next(error);
  }
}

// --- WebAuthn Authentication (public, no auth required) ---

async function webauthnAuthOptions(req, res, next) {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'משתמש לא נמצא' });
    }

    // transports:['internal'] tells the browser the credential lives on THIS
    // device's built-in authenticator, so it prompts Touch ID / fingerprint
    // directly instead of offering the cross-device "Passkeys & Security Keys"
    // QR (hybrid) flow — even for an iCloud-synced platform passkey, which on
    // macOS otherwise advertises the hybrid transport.
    const creds = (user.webauthn_credentials || []).map(c => ({
      id: c.credential_id,
      type: 'public-key',
      transports: ['internal'],
    }));

    if (creds.length === 0) {
      return res.status(400).json({ error: 'לא הוגדרה כניסה ביומטרית' });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: creds,
      userVerification: 'preferred',
    });

    user.webauthn_challenge = options.challenge;
    await user.save();

    res.json(options);
  } catch (error) {
    next(error);
  }
}

async function webauthnAuthVerify(req, res, next) {
  try {
    const { userId, credential } = req.body;
    const user = await User.findById(userId).populate('branch_id', 'name');
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'משתמש לא נמצא' });
    }

    const credIdFromClient = credential.id;
    const stored = user.webauthn_credentials.find(c => c.credential_id === credIdFromClient);
    if (!stored) {
      return res.status(400).json({ error: 'מפתח לא מוכר' });
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: user.webauthn_challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: stored.credential_id,
        publicKey: Buffer.from(stored.public_key, 'base64url'),
        counter: stored.counter,
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'אימות ביומטרי נכשל' });
    }

    // Update counter
    stored.counter = verification.authenticationInfo.newCounter;
    user.webauthn_challenge = null;
    await user.save();

    const result = makeToken(user, true, await roleTabOverrides(user.role)); // biometric = always remember
    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  login, loginWithPassword, setPassword, logout, me,
  webauthnRegisterOptions, webauthnRegisterVerify,
  webauthnAuthOptions, webauthnAuthVerify,
};
