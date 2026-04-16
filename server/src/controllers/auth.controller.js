const jwt = require('jsonwebtoken');
const { User } = require('../models');
const env = require('../config/env');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'גן החלומות';
const RP_ID = env.NODE_ENV === 'production' ? 'gan-halomot.onrender.com' : 'localhost';
const ORIGIN = env.NODE_ENV === 'production'
  ? 'https://gan-halomot.onrender.com'
  : 'http://localhost:5173';

function makeToken(user, rememberMe) {
  const payload = {
    id: user._id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    branch_id: user.branch_id?._id || user.branch_id,
    branch_name: user.branch_id?.name || null,
    position: user.position,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: rememberMe ? '30d' : '24h' });
  return { token, user: payload };
}

async function login(req, res, next) {
  try {
    const { full_name, id_number, rememberMe } = req.body;
    if (!full_name || !id_number) {
      return res.status(400).json({ error: 'שם ותעודת זהות נדרשים' });
    }

    const cleanedId = id_number.replace(/\D/g, '').trim();
    const cleanedName = full_name.trim();

    const user = await User.findOne({
      full_name: { $regex: new RegExp(`^${cleanedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      id_number: cleanedId,
      is_active: true,
    }).populate('branch_id', 'name');

    if (!user) {
      return res.status(401).json({ error: 'שם או תעודת זהות שגויים' });
    }

    const result = makeToken(user, rememberMe);
    result.hasWebauthn = (user.webauthn_credentials || []).length > 0;
    res.json(result);
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
    res.json({
      user: {
        ...user.toObject(),
        id: user._id,
        branch_name: user.branch_id?.name || null,
        hasWebauthn: (user.webauthn_credentials || []).length > 0,
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

    const creds = (user.webauthn_credentials || []).map(c => ({
      id: c.credential_id,
      type: 'public-key',
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

    const result = makeToken(user, true); // biometric = always remember
    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  login, logout, me,
  webauthnRegisterOptions, webauthnRegisterVerify,
  webauthnAuthOptions, webauthnAuthVerify,
};
